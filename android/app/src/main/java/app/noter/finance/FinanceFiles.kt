package app.noter.finance

import app.noter.storage.Entry
import app.noter.storage.Saf
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.UUID

private const val LOGS = ".noter/finance"
private const val LEGACY = ".noter/finance.json"
private const val TEMPLATE = ".noter/finance-template.xlsx"
private const val MAX_LOGS = 100_000_000L

fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

class FinanceRaw(val logs: List<LogFile>, val legacy: String?, val template: ByteArray?)

/** Finance files in the workspace: per-device logs, the legacy finance.json (until migrated), and the Excel template. */
class FinanceFiles(private val saf: Saf) {
    private var observedLogs: Map<String, String>? = null
    private var observedTemplate: String? = null
    private var metadataHint: String? = null
    private var contentRevision: String? = null
    private var lastAudit = 0L
    private fun noterEntries(): List<Entry> = saf.resolve(".noter")?.takeIf { it.isDir }?.let { saf.list(it.doc) } ?: emptyList()

    private fun logEntries(): List<Entry> = saf.resolve(LOGS)?.takeIf { it.isDir }?.let { saf.list(it.doc) }
        ?.filter { !it.isDir && !it.name.startsWith(".") && it.name.endsWith(".jsonl") }?.sortedBy { it.name } ?: emptyList()

    private fun decode(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) {
        throw FinanceException("A Finance log could not be read as UTF-8. Your files have been kept.")
    }

    fun revision(force: Boolean = false): String {
        val hash = MessageDigest.getInstance("SHA-256")
        for (entry in logEntries()) hash.update("${entry.name}\u0000${entry.size}\u0000${entry.modified}\n".toByteArray())
        val noter = noterEntries()
        for (path in listOf(LEGACY, TEMPLATE)) {
            val name = path.substringAfterLast('/')
            val entry = noter.firstOrNull { it.name == name && !it.isDir }
            hash.update((if (entry == null) "$path\u0000-\n" else "$path\u0000${entry.size}\u0000${entry.modified}\n").toByteArray())
        }
        val hint = hash.digest().joinToString("") { "%02x".format(it) }
        val now = android.os.SystemClock.elapsedRealtime()
        if (force || metadataHint != hint || contentRevision == null || now - lastAudit >= 60_000) {
            val contents = MessageDigest.getInstance("SHA-256")
            var remaining = MAX_LOGS
            for (entry in logEntries()) {
                val bytes = saf.read(entry.doc, remaining)
                remaining -= bytes.size
                contents.update("${entry.name}\u0000${sha256(bytes)}\n".toByteArray())
            }
            for ((path, limit) in listOf(LEGACY to 100_000_000L, TEMPLATE to 10_000_000L)) {
                val entry = saf.resolve(path)
                if (entry?.isDir == true) throw FinanceException("A folder blocks a Finance file. Your files have been kept.")
                contents.update("$path\u0000${entry?.let { sha256(saf.read(it.doc, limit)) } ?: "-"}\n".toByteArray())
            }
            metadataHint = hint
            contentRevision = contents.digest().joinToString("") { "%02x".format(it) }
            lastAudit = now
        }
        return checkNotNull(contentRevision)
    }

    fun read(): FinanceRaw {
        var total = 0L
        val logHashes = HashMap<String, String>()
        val logs = logEntries().map { entry ->
            val bytes = saf.read(entry.doc, MAX_LOGS - total)
            total += bytes.size
            logHashes[entry.name] = sha256(bytes)
            LogFile(entry.name, decode(bytes))
        }
        val noter = noterEntries()
        val legacy = noter.firstOrNull { it.name == "finance.json" && !it.isDir }?.let { decode(saf.read(it.doc, MAX_LOGS)) }
        val template = noter.firstOrNull { it.name == "finance-template.xlsx" && !it.isDir }?.let { saf.read(it.doc, 10_000_000) }
        observedLogs = logHashes
        observedTemplate = template?.let(::sha256)
        return FinanceRaw(logs, legacy, template)
    }

    /** Appends one batch line to this device's log; a replaced workbook template is written first. */
    fun append(device: String, line: String, template: ByteArray?, retireLegacy: Boolean): String {
        val loaded = observedLogs ?: throw FinanceException("Load Finance before saving changes.")
        val ownName = "log-$device.jsonl"
        val ownEntry = saf.resolve("$LOGS/$ownName")
        val templateEntry = saf.resolve(TEMPLATE)
        if (ownEntry?.isDir == true || templateEntry?.isDir == true) throw FinanceException("A folder blocks a Finance file. Your files have been kept.")
        val oldLog = ownEntry?.let { saf.read(it.doc, MAX_LOGS) }
        val oldTemplate = templateEntry?.let { saf.read(it.doc, 10_000_000) }
        if (oldLog?.let(::sha256) != loaded[ownName] || oldTemplate?.let(::sha256) != observedTemplate) {
            throw FinanceException("This device's Finance log or workbook changed while editing. Incoming files have been kept. Reload Finance before saving again.")
        }
        if (template != null) {
            if (template.size > 10_000_000) throw FinanceException("Finance workbook is too large.")
            saf.writeAtomic(TEMPLATE, template, expected = oldTemplate, mustBeAbsent = oldTemplate == null)
        }
        saf.append("$LOGS/$ownName", line.toByteArray(), expected = oldLog, mustBeAbsent = oldLog == null)
        if (retireLegacy) {
            saf.resolve(LEGACY)?.takeIf { !it.isDir }?.let { legacy ->
                saf.writeAtomic(".noter/trash/finance-migrated-${System.currentTimeMillis()}-${UUID.randomUUID()}.json", saf.read(legacy.doc))
                saf.delete(legacy.doc)
            }
        }
        val batch = (if (line.startsWith('\n')) line.substring(1) else line).toByteArray()
        val complete = if (line.startsWith('\n') && oldLog?.lastOrNull() != '\n'.code.toByte()) oldLog?.indexOfLast { it == '\n'.code.toByte() }?.plus(1) ?: 0 else oldLog?.size ?: 0
        val expectedLog = MessageDigest.getInstance("SHA-256").apply {
            if (oldLog != null) update(oldLog, 0, complete)
            update(batch)
        }.digest().joinToString("") { "%02x".format(it) }
        val expectedTemplate = (template ?: oldTemplate)?.let(::sha256)
        val currentLog = saf.resolve("$LOGS/$ownName")?.let { sha256(saf.read(it.doc, MAX_LOGS)) }
        val currentTemplate = saf.resolve(TEMPLATE)?.let { sha256(saf.read(it.doc, 10_000_000)) }
        if (currentLog != expectedLog || currentTemplate != expectedTemplate) {
            throw FinanceException("Finance changed before the save was acknowledged. Reload Finance so completed changes are preserved.")
        }
        observedLogs = loaded + (ownName to expectedLog)
        observedTemplate = expectedTemplate
        return revision(force = true)
    }
}
