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
    private fun noterEntries(): List<Entry> = saf.resolve(".noter")?.takeIf { it.isDir }?.let { saf.list(it.doc) } ?: emptyList()

    private fun logEntries(): List<Entry> = saf.resolve(LOGS)?.takeIf { it.isDir }?.let { saf.list(it.doc) }
        ?.filter { !it.isDir && !it.name.startsWith(".") && it.name.endsWith(".jsonl") }?.sortedBy { it.name } ?: emptyList()

    private fun decode(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) {
        throw FinanceException("A Finance log could not be read as UTF-8. Your files have been kept.")
    }

    fun revision(): String {
        val hash = MessageDigest.getInstance("SHA-256")
        for (entry in logEntries()) hash.update("${entry.name}\u0000${entry.size}\u0000${entry.modified}\n".toByteArray())
        val noter = noterEntries()
        for (path in listOf(LEGACY, TEMPLATE)) {
            val name = path.substringAfterLast('/')
            val entry = noter.firstOrNull { it.name == name && !it.isDir }
            hash.update((if (entry == null) "$path\u0000-\n" else "$path\u0000${entry.size}\u0000${entry.modified}\n").toByteArray())
        }
        return hash.digest().joinToString("") { "%02x".format(it) }
    }

    fun read(): FinanceRaw {
        var total = 0L
        val logs = logEntries().map { entry ->
            total += entry.size
            if (total > MAX_LOGS) throw FinanceException("Finance logs are larger than 100 MB.")
            LogFile(entry.name, decode(saf.read(entry.doc)))
        }
        val noter = noterEntries()
        val legacy = noter.firstOrNull { it.name == "finance.json" && !it.isDir }?.let { String(saf.read(it.doc), Charsets.UTF_8) }
        val template = noter.firstOrNull { it.name == "finance-template.xlsx" && !it.isDir }?.let { saf.read(it.doc) }
        return FinanceRaw(logs, legacy, template)
    }

    /** Appends one batch line to this device's log; a replaced workbook template is written first. */
    fun append(device: String, line: String, template: ByteArray?, retireLegacy: Boolean): String {
        if (template != null) {
            if (template.size > 10_000_000) throw FinanceException("Finance workbook is too large.")
            saf.writeAtomic(TEMPLATE, template)
        }
        saf.append("$LOGS/log-$device.jsonl", line.toByteArray())
        if (retireLegacy) {
            saf.resolve(LEGACY)?.takeIf { !it.isDir }?.let { legacy ->
                saf.writeAtomic(".noter/trash/finance-migrated-${System.currentTimeMillis()}-${UUID.randomUUID()}.json", saf.read(legacy.doc))
                saf.delete(legacy.doc)
            }
        }
        return revision()
    }
}
