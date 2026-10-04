package app.noter

import android.content.ContentResolver
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsProvider
import app.noter.storage.Saf
import app.noter.storage.Vault
import app.noter.model.Note
import app.noter.model.WorkspaceOps
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID

/** Real SAF operations against a private test provider; never opens a user's document tree. */
fun withTestSaf(context: Context, test: (Saf) -> Unit) {
    testTree(context) { tree -> test(tree.saf()) }
}

fun checkSafeReplacement(context: Context) {
    testTree(context) { tree ->
        val saf = tree.saf()
        saf.writeAtomic("Original.md", "before".toByteArray())
        val vault = Vault(saf)
        val base = vault.load().workspace
        val id = base.nodes.values.filterIsInstance<Note>().single().id
        val local = WorkspaceOps.edit(base, id, "local edits")
        saf.writeAtomic("Original.md", "incoming".toByteArray())
        val manifest = saf.read(saf.resolve(".noter/workspace.json")!!.doc)
        tree.provider.promotionName = "workspace.json"
        tree.provider.promotionFailure = { throw FileNotFoundException("Injected recovery backup failure") }
        check(runCatching { vault.preserveEdits(local, base) }.isFailure)
        check(tree.text(saf, "Original.md") == "incoming")
        check(saf.read(saf.resolve(".noter/workspace.json")!!.doc).contentEquals(manifest))
        check(saf.list(saf.rootDoc).none { it.name.startsWith("Recovered edits") })
    }
    testTree(context) { tree ->
        val saf = tree.saf()
        saf.writeAtomic("Test.md", "before".toByteArray())
        saf.writeAtomic("Test.md", "after".toByteArray())
        check(tree.text(saf, "Test.md") == "after")
        check(saf.list(saf.rootDoc).none { it.name.startsWith(".noter-write-") })

        tree.provider.promotionFailure = { throw FileNotFoundException("Injected rename failure") }
        check(runCatching { saf.writeAtomic("Test.md", "pending".toByteArray()) }.isFailure)
        check(tree.text(saf, "Test.md") == "after")
        check(saf.list(saf.rootDoc).any { it.name.endsWith(".new") && String(saf.read(it.doc)) == "pending" })
    }
    testTree(context) { tree ->
        val saf = tree.saf()
        saf.writeAtomic("Test.md", "old".toByteArray())
        tree.provider.promotionFailure = { throw AssertionError("Injected process interruption") }
        check(runCatching { saf.writeAtomic("Test.md", "new".toByteArray()) }.exceptionOrNull() is AssertionError)
        val reopened = tree.saf()
        check(tree.text(reopened, "Test.md") == "old")
        check(reopened.list(reopened.rootDoc).any { it.name.endsWith(".new") && String(reopened.read(it.doc)) == "new" })
        reopened.delete(reopened.resolve("Test.md")!!.doc)
        check(tree.saf().resolve("Test.md") == null) // An intentional later deletion stays deleted.
    }
    testTree(context) { tree ->
        val saf = tree.saf()
        saf.writeAtomic("Test.md", "old".toByteArray())
        tree.provider.promotionFailure = {
            tree.provider.put("Test.md", "incoming".toByteArray())
            throw FileNotFoundException("Injected concurrent synchronization")
        }
        check(runCatching { saf.writeAtomic("Test.md", "new".toByteArray()) }.isFailure)
        check(tree.text(tree.saf(), "Test.md") == "incoming")
        check(saf.list(saf.rootDoc).any { it.name.endsWith(".old") && String(saf.read(it.doc)) == "old" })
        check(saf.list(saf.rootDoc).any { it.name.endsWith(".new") && String(saf.read(it.doc)) == "new" })
    }
    testTree(context) { tree ->
        val saf = tree.saf()
        val log = ".noter/finance/log-test.jsonl"
        val interrupted = "{\"first\":1}\n{\"partial\":"
        saf.writeAtomic(log, interrupted.toByteArray())
        saf.append(log, "\n{\"second\":2}\n".toByteArray())
        check(tree.text(saf, log) == "{\"first\":1}\n{\"second\":2}\n")
        val trash = saf.resolve(".noter/trash")!!
        check(saf.list(trash.doc).single().let { String(saf.read(it.doc)) == interrupted })
        saf.append(log, "\n{\"third\":3}\n".toByteArray())
        check(tree.text(saf, log) == "{\"first\":1}\n{\"second\":2}\n{\"third\":3}\n")
        tree.provider.failNextAppend = true
        check(runCatching { saf.append(log, "{\"fourth\":4}\n".toByteArray()) }.isFailure)
        saf.append(log, "{\"fourth\":4}\n".toByteArray())
        check(tree.text(saf, log) == "{\"first\":1}\n{\"second\":2}\n{\"third\":3}\n{\"fourth\":4}\n")
    }
}

private fun testTree(context: Context, test: (TestTree) -> Unit) {
    check(Build.VERSION.SDK_INT >= 29) { "Storage provider checks require Android 10 or newer." }
    val directory = File(context.cacheDir, "noter-storage-check-${UUID.randomUUID()}")
    check(directory.mkdirs())
    try { test(TestTree(context, directory)) } finally {
        check(directory.canonicalPath.startsWith(context.cacheDir.canonicalPath + File.separator))
        directory.deleteRecursively()
    }
}

private class TestTree(context: Context, private val directory: File) {
    val provider = TestDocumentsProvider(File(directory, "documents").apply { mkdirs() })
    private val resolver: ContentResolver
    private val uri = DocumentsContract.buildTreeDocumentUri("app.noter.storage-check", "root")

    init {
        provider.attachInfo(context, ProviderInfo().apply {
            authority = "app.noter.storage-check"
            exported = true
            grantUriPermissions = true
            readPermission = "android.permission.MANAGE_DOCUMENTS"
            writePermission = "android.permission.MANAGE_DOCUMENTS"
        })
        resolver = ContentResolver.wrap(provider)
    }

    fun saf(): Saf = Saf(resolver, uri, File(directory, "private"))
    fun text(saf: Saf, path: String): String = String(saf.read(saf.resolve(path)!!.doc))
}

private class TestDocumentsProvider(private val directory: File) : DocumentsProvider() {
    private data class Item(val id: String, val parent: String, val name: String, val isDir: Boolean, val file: File)
    private val items = LinkedHashMap<String, Item>()
    var promotionFailure: (() -> Unit)? = null
    var promotionName = "Test.md"
    var failNextAppend = false

    init { items["root"] = Item("root", "", "root", true, directory) }

    override fun onCreate(): Boolean = true

    override fun queryRoots(projection: Array<out String>?): Cursor = MatrixCursor(arrayOf("root_id", "document_id"))

    private fun cursor(values: List<Item>, projection: Array<out String>?): Cursor {
        val columns = projection ?: arrayOf(
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED,
        )
        return MatrixCursor(columns).apply {
            for (item in values) addRow(columns.map { column ->
                when (column) {
                    Document.COLUMN_DOCUMENT_ID -> item.id
                    Document.COLUMN_DISPLAY_NAME -> item.name
                    Document.COLUMN_MIME_TYPE -> if (item.isDir) Document.MIME_TYPE_DIR else "application/octet-stream"
                    Document.COLUMN_SIZE -> if (item.isDir) 0L else item.file.length()
                    Document.COLUMN_LAST_MODIFIED -> item.file.lastModified()
                    else -> null
                }
            })
        }
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor =
        cursor(listOf(items[documentId] ?: throw FileNotFoundException()), projection)

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor =
        cursor(items.values.filter { it.parent == parentDocumentId }, projection)

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
        var current = items[documentId]
        while (current != null && current.parent.isNotEmpty()) {
            if (current.parent == parentDocumentId) return true
            current = items[current.parent]
        }
        return false
    }

    override fun openDocument(documentId: String, mode: String, signal: android.os.CancellationSignal?): ParcelFileDescriptor {
        val item = items[documentId]?.takeIf { !it.isDir } ?: throw FileNotFoundException()
        if (mode == "wa" && failNextAppend) {
            failNextAppend = false
            item.file.appendText("{\"interrupted\":")
            throw FileNotFoundException("Injected partial append")
        }
        return ParcelFileDescriptor.open(item.file, ParcelFileDescriptor.parseMode(mode))
    }

    override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
        check(items[parentDocumentId]?.isDir == true)
        if (items.values.any { it.parent == parentDocumentId && it.name == displayName }) throw FileNotFoundException("Name exists")
        val id = UUID.randomUUID().toString()
        val isDir = mimeType == Document.MIME_TYPE_DIR
        val file = File(directory, id)
        if (!isDir) check(file.createNewFile())
        items[id] = Item(id, parentDocumentId, displayName, isDir, file)
        return id
    }

    override fun renameDocument(documentId: String, displayName: String): String {
        val item = items[documentId] ?: throw FileNotFoundException()
        if (item.name.endsWith(".new") && displayName == promotionName) {
            val failure = promotionFailure
            promotionFailure = null
            failure?.invoke()
        }
        if (items.values.any { it.parent == item.parent && it.name == displayName }) throw FileNotFoundException("Name exists")
        // Local document providers can change document IDs after a rename.
        val id = UUID.randomUUID().toString()
        items.remove(documentId)
        items[id] = item.copy(id = id, name = displayName)
        return id
    }

    override fun deleteDocument(documentId: String) {
        val item = items.remove(documentId) ?: throw FileNotFoundException()
        check(!item.isDir || items.values.none { it.parent == documentId })
        if (!item.isDir) check(item.file.delete())
    }

    fun put(name: String, bytes: ByteArray) {
        val id = createDocument("root", "application/octet-stream", name)
        items.getValue(id).file.writeBytes(bytes)
    }
}
