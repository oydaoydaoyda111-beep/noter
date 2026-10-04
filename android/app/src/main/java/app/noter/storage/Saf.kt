package app.noter.storage

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID

class Entry(val name: String, val doc: String, val isDir: Boolean, val size: Long, val modified: Long)

/** Thin Storage Access Framework wrapper over a user-chosen document tree. Paths are `/`-separated and relative to the tree root. */
class Saf(private val resolver: ContentResolver, private val tree: Uri, privateFiles: File) {
    val rootDoc: String = DocumentsContract.getTreeDocumentId(tree)
    private val recoveryDirectory = File(File(privateFiles, "saf-recovery"), hash(tree.toString().toByteArray()))
    private var recovered = false
    private val failedAppends = HashSet<String>()

    companion object {
        // ponytail: serialize SAF recovery and replacements; use per-tree locks if contention matters.
        private val replacementLock = Any()
        private fun hash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
    }

    private fun uri(doc: String): Uri = DocumentsContract.buildDocumentUriUsingTree(tree, doc)

    fun list(doc: String): List<Entry> = synchronized(replacementLock) {
        recoverPending()
        listRaw(doc)
    }

    private fun listRaw(doc: String): List<Entry> {
        val columns = arrayOf(
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED,
        )
        val result = ArrayList<Entry>()
        val cursor = resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, doc), columns, null, null, null)
            ?: throw IOException("Could not read workspace folder.")
        cursor.use {
            while (it.moveToNext()) {
                val name = it.getString(1) ?: continue
                result += Entry(
                    name, it.getString(0), it.getString(2) == Document.MIME_TYPE_DIR,
                    if (it.isNull(3)) 0 else it.getLong(3), if (it.isNull(4)) 0 else it.getLong(4),
                )
            }
        }
        return result
    }

    /** Recovery belongs to this installation, never to another Syncthing peer. */
    private fun recoverPending() {
        if (recovered) return
        for (record in recoveryDirectory.listFiles().orEmpty().filter { it.extension == "json" }) recover(record)
        recovered = true
    }

    private fun recover(record: File) {
        val journal = try { JSONObject(record.readText()) } catch (problem: Exception) {
            throw IOException("Could not read the private file recovery record. Workspace files have been kept.", problem)
        }
        val parent = journal.getString("parent")
        val name = journal.getString("name")
        val backupName = journal.getString("backup")
        val temporaryName = journal.getString("temporary")
        if (journal.getString("tree") != tree.toString() || name.isEmpty() || name in setOf(".", "..") ||
            name.any { it == '/' || it == '\\' || it.isISOControl() } ||
            !Regex("\\.noter-write-[0-9a-f-]{36}\\.old").matches(backupName) ||
            temporaryName != backupName.removeSuffix(".old") + ".new") {
            throw IOException("Invalid private file recovery record. Workspace files have been kept.")
        }
        val entries = listRaw(parent)
        if (entries.none { it.name == name }) {
            val backup = entries.firstOrNull { it.name == backupName && !it.isDir }
                ?: throw IOException("The interrupted save's recovery copy is missing. Pending files have been kept.")
            if (hash(read(backup.doc)) != journal.getString("oldHash")) {
                throw IOException("A recovery copy changed. Both versions have been kept.")
            }
            DocumentsContract.renameDocument(resolver, uri(backup.doc), name)
                ?: throw IOException("Could not restore \"$name\". Its recovery copy has been kept beside it.")
        }
        // Retire the journal even when a synced target already exists: later deletion must not resurrect it.
        if (!record.delete()) throw IOException("Could not retire the private file recovery record.")
    }

    private fun journal(parent: String, name: String, temporary: Uri, stem: String, oldHash: String): File {
        if (!recoveryDirectory.mkdirs() && !recoveryDirectory.isDirectory) throw IOException("Could not prepare file recovery.")
        val record = File(recoveryDirectory, "${stem.removePrefix(".noter-write-")}.json")
        val pending = File(recoveryDirectory, ".${record.name}.tmp")
        val bytes = JSONObject().put("tree", tree.toString()).put("parent", parent).put("name", name)
            .put("temporary", "$stem.new").put("temporaryDoc", DocumentsContract.getDocumentId(temporary))
            .put("backup", "$stem.old").put("oldHash", oldHash).toString().toByteArray()
        FileOutputStream(pending).use { it.write(bytes); it.fd.sync() }
        Files.move(pending.toPath(), record.toPath(), StandardCopyOption.ATOMIC_MOVE)
        return record
    }

    private fun child(doc: String, name: String): Entry? = list(doc).firstOrNull { it.name == name }

    fun resolve(path: String): Entry? {
        var doc = rootDoc
        var current: Entry? = null
        for (segment in path.split('/')) {
            current = child(doc, segment) ?: return null
            doc = current.doc
        }
        return current
    }

    fun ensureDir(path: String): String {
        var doc = rootDoc
        for (segment in path.split('/')) {
            val existing = child(doc, segment)
            doc = when {
                existing == null -> DocumentsContract.createDocument(resolver, uri(doc), Document.MIME_TYPE_DIR, segment)
                    ?.let { DocumentsContract.getDocumentId(it) } ?: throw IOException("Could not create folder.")
                existing.isDir -> existing.doc
                else -> throw IOException("A file blocks the folder \"$segment\".")
            }
        }
        return doc
    }

    fun read(doc: String): ByteArray =
        resolver.openInputStream(uri(doc))?.use { it.readBytes() } ?: throw IOException("Could not read file.")

    fun delete(doc: String) {
        if (!DocumentsContract.deleteDocument(resolver, uri(doc))) throw IOException("Could not delete file.")
    }

    /** Appends to a file, creating it and its folders when missing. */
    fun append(path: String, bytes: ByteArray): Unit = synchronized(replacementLock) {
        val slash = path.lastIndexOf('/')
        val parent = if (slash < 0) rootDoc else ensureDir(path.substring(0, slash))
        val name = path.substring(slash + 1)
        val existing = child(parent, name)
        if (existing?.isDir == true) throw IOException("A folder blocks the file \"$name\".")
        // A leading newline is the Finance parser's incomplete-tail signal, not a valid new batch.
        val leadingNewline = bytes.firstOrNull() == '\n'.code.toByte()
        if (leadingNewline || path in failedAppends) {
            val batch = if (leadingNewline) bytes.copyOfRange(1, bytes.size) else bytes
            if (existing != null) {
                if (existing.size > 100_000_000) throw IOException("Finance logs are larger than 100 MB.")
                val previous = read(existing.doc)
                if (previous.size > 100_000_000) throw IOException("Finance logs are larger than 100 MB.")
                if (previous.isNotEmpty() && previous.last() != '\n'.code.toByte()) {
                    writeAtomic(".noter/trash/finance-interrupted-${UUID.randomUUID()}.jsonl", previous)
                    val complete = previous.indexOfLast { it == '\n'.code.toByte() } + 1
                    if (complete.toLong() + batch.size > 100_000_000) throw IOException("Finance logs are larger than 100 MB.")
                    writeAtomic(path, previous.copyOf(complete) + batch, previous)
                    failedAppends.remove(path)
                    return@synchronized
                }
            }
            failedAppends.remove(path)
            append(path, batch)
            return@synchronized
        }
        if ((existing?.size ?: 0L) + bytes.size > 100_000_000) throw IOException("Finance logs are larger than 100 MB.")
        val target = existing?.let { uri(it.doc) }
            ?: DocumentsContract.createDocument(resolver, uri(parent), "application/octet-stream", name)
            ?: throw IOException("Could not create \"$name\".")
        try {
            (resolver.openOutputStream(target, "wa") ?: throw IOException("Could not write \"$name\".")).use { it.write(bytes) }
            failedAppends.remove(path)
        } catch (problem: Exception) {
            failedAppends.add(path)
            throw problem
        }
    }

    /** SAF has no atomic replace. Keep the old document until a completed sibling can take its name. */
    fun writeAtomic(path: String, bytes: ByteArray, expected: ByteArray? = null): Unit = synchronized(replacementLock) {
        val slash = path.lastIndexOf('/')
        val parent = if (slash < 0) rootDoc else ensureDir(path.substring(0, slash))
        val name = path.substring(slash + 1)
        val existing = child(parent, name)
        val oldBytes = existing?.let {
            if (it.isDir) throw IOException("A folder blocks the file \"$name\".")
            read(it.doc)
        }
        if (expected != null && (oldBytes == null || !oldBytes.contentEquals(expected))) {
            throw IOException("The file changed while preparing the save. Both versions have been kept.")
        }
        if (existing != null) {
            if (oldBytes!!.contentEquals(bytes)) return@synchronized
        }
        val stem = ".noter-write-${UUID.randomUUID()}"
        val temporary = DocumentsContract.createDocument(resolver, uri(parent), "application/octet-stream", "$stem.new")
            ?: throw IOException("Could not prepare file.")
        try {
            (resolver.openOutputStream(temporary, "wt") ?: throw IOException("Could not write file.")).use { it.write(bytes) }
            if (!read(DocumentsContract.getDocumentId(temporary)).contentEquals(bytes)) throw IOException("The saved file could not be verified.")
        } catch (problem: Exception) {
            runCatching { DocumentsContract.deleteDocument(resolver, temporary) }
            throw problem
        }
        var record: File? = null
        var backup: Uri? = null
        try {
            val current = listRaw(parent).firstOrNull { it.name == name }
            if (current?.doc != existing?.doc || (current != null && !read(current.doc).contentEquals(oldBytes))) {
                throw IOException("The file changed while preparing the save. Your new content has been kept beside it.")
            }
            if (existing != null) {
                record = journal(parent, name, temporary, stem, hash(oldBytes!!))
                backup = DocumentsContract.renameDocument(resolver, uri(existing.doc), "$stem.old")
                    ?: throw IOException("Could not preserve the existing file.")
            }
            if (listRaw(parent).any { it.name == name }) throw IOException("A synced file now uses that name. Both versions have been kept.")
            val installed = DocumentsContract.renameDocument(resolver, temporary, name)
                ?: throw IOException("Could not replace \"$name\". Your new content has been kept in a hidden .noter-write-*.new file beside it.")
            if (listRaw(parent).none { it.name == name && it.doc == DocumentsContract.getDocumentId(installed) }) {
                throw IOException("The document provider changed the saved filename. Both versions have been kept.")
            }
            record?.let { if (!it.delete()) throw IOException("Could not retire the private file recovery record.") }
            backup?.let { runCatching { DocumentsContract.deleteDocument(resolver, it) } }
        } catch (problem: Exception) {
            recovered = false
            record?.let { runCatching { recover(it) } }
            throw problem
        }
    }
}
