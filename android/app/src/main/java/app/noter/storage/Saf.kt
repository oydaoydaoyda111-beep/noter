package app.noter.storage

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.IOException
import java.util.UUID

class Entry(val name: String, val doc: String, val isDir: Boolean, val size: Long, val modified: Long)

/** Thin Storage Access Framework wrapper over a user-chosen document tree. Paths are `/`-separated and relative to the tree root. */
class Saf(private val resolver: ContentResolver, private val tree: Uri) {
    val rootDoc: String = DocumentsContract.getTreeDocumentId(tree)

    private fun uri(doc: String): Uri = DocumentsContract.buildDocumentUriUsingTree(tree, doc)

    fun list(doc: String): List<Entry> {
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
    fun append(path: String, bytes: ByteArray) {
        val slash = path.lastIndexOf('/')
        val parent = if (slash < 0) rootDoc else ensureDir(path.substring(0, slash))
        val name = path.substring(slash + 1)
        val existing = child(parent, name)
        if (existing?.isDir == true) throw IOException("A folder blocks the file \"$name\".")
        val target = existing?.let { uri(it.doc) }
            ?: DocumentsContract.createDocument(resolver, uri(parent), "application/octet-stream", name)
            ?: throw IOException("Could not create \"$name\".")
        (resolver.openOutputStream(target, "wa") ?: throw IOException("Could not write \"$name\".")).use { it.write(bytes) }
    }

    /** Writes through a hidden temporary sibling, so a failed write never truncates the existing file. */
    fun writeAtomic(path: String, bytes: ByteArray) {
        val slash = path.lastIndexOf('/')
        val parent = if (slash < 0) rootDoc else ensureDir(path.substring(0, slash))
        val name = path.substring(slash + 1)
        val existing = child(parent, name)
        if (existing != null) {
            if (existing.isDir) throw IOException("A folder blocks the file \"$name\".")
            if (read(existing.doc).contentEquals(bytes)) return
        }
        val temporary = DocumentsContract.createDocument(resolver, uri(parent), "application/octet-stream", ".noter-${UUID.randomUUID()}.tmp")
            ?: throw IOException("Could not prepare file.")
        try {
            (resolver.openOutputStream(temporary, "wt") ?: throw IOException("Could not write file.")).use { it.write(bytes) }
        } catch (problem: Exception) {
            runCatching { DocumentsContract.deleteDocument(resolver, temporary) }
            throw problem
        }
        if (existing != null) delete(existing.doc)
        DocumentsContract.renameDocument(resolver, temporary, name)
            ?: throw IOException("Could not replace \"$name\". The new content is kept in a hidden .noter-*.tmp file beside it.")
    }
}
