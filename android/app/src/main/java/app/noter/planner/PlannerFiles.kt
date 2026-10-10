package app.noter.planner

import app.noter.storage.Entry
import app.noter.storage.Saf
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

private const val LOGS = ".noter/planner"
private const val MAX_LOGS = 100_000_000L

private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** Planner logs in the workspace: one append-only `log-<device>.jsonl` per installation. */
class PlannerFiles(private val saf: Saf) {
    private var observedLogs: Map<String, String>? = null
    private var metadataHint: String? = null
    private var contentRevision: String? = null
    private var lastAudit = 0L

    private fun logEntries(): List<Entry> = saf.resolve(LOGS)?.takeIf { it.isDir }?.let { saf.list(it.doc) }
        ?.filter { !it.isDir && !it.name.startsWith(".") && it.name.endsWith(".jsonl") }?.sortedBy { it.name } ?: emptyList()

    private fun decode(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) {
        throw PlannerException("A Planner log could not be read as UTF-8. Your files have been kept.")
    }

    /** Metadata is a hint; contents are rehashed when it changes, on demand and at least once a minute. */
    fun revision(force: Boolean = false): String {
        val entries = logEntries()
        val hash = MessageDigest.getInstance("SHA-256")
        for (entry in entries) hash.update("${entry.name}\u0000${entry.size}\u0000${entry.modified}\n".toByteArray())
        val hint = hash.digest().joinToString("") { "%02x".format(it) }
        val now = android.os.SystemClock.elapsedRealtime()
        if (force || metadataHint != hint || contentRevision == null || now - lastAudit >= 60_000) {
            val contents = MessageDigest.getInstance("SHA-256")
            var remaining = MAX_LOGS
            for (entry in entries) {
                val bytes = saf.read(entry.doc, remaining)
                remaining -= bytes.size
                contents.update("${entry.name}\u0000${sha256(bytes)}\n".toByteArray())
            }
            metadataHint = hint
            contentRevision = contents.digest().joinToString("") { "%02x".format(it) }
            lastAudit = now
        }
        return checkNotNull(contentRevision)
    }

    fun read(): List<LogFile> {
        var total = 0L
        val hashes = HashMap<String, String>()
        val logs = logEntries().map { entry ->
            val bytes = saf.read(entry.doc, MAX_LOGS - total)
            total += bytes.size
            hashes[entry.name] = sha256(bytes)
            LogFile(entry.name, decode(bytes))
        }
        observedLogs = hashes
        return logs
    }

    /** Appends one batch line to this device's log, refusing if the log changed since it was read. */
    fun append(device: String, line: String): String {
        val loaded = observedLogs ?: throw PlannerException("Load Planner before saving changes.")
        val ownName = "log-$device.jsonl"
        val ownEntry = saf.resolve("$LOGS/$ownName")
        if (ownEntry?.isDir == true) throw PlannerException("A folder blocks the Planner log. Your files have been kept.")
        val oldLog = ownEntry?.let { saf.read(it.doc, MAX_LOGS) }
        if (oldLog?.let(::sha256) != loaded[ownName]) {
            throw PlannerException("This device's Planner log changed while editing. Incoming files have been kept. Reload Planner before saving again.")
        }
        saf.append("$LOGS/$ownName", line.toByteArray(), expected = oldLog, mustBeAbsent = oldLog == null)
        val batch = (if (line.startsWith('\n')) line.substring(1) else line).toByteArray()
        val complete = if (line.startsWith('\n') && oldLog?.lastOrNull() != '\n'.code.toByte()) oldLog?.indexOfLast { it == '\n'.code.toByte() }?.plus(1) ?: 0 else oldLog?.size ?: 0
        val expected = MessageDigest.getInstance("SHA-256").apply {
            if (oldLog != null) update(oldLog, 0, complete)
            update(batch)
        }.digest().joinToString("") { "%02x".format(it) }
        val current = saf.resolve("$LOGS/$ownName")?.let { sha256(saf.read(it.doc, MAX_LOGS)) }
        if (current != expected) throw PlannerException("Planner changed before the save was acknowledged. Reload Planner so completed changes are preserved.")
        observedLogs = loaded + (ownName to expected)
        return revision(force = true)
    }
}
