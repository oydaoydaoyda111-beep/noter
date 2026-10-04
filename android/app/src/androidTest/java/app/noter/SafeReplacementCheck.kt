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
import app.noter.storage.SyncConflictException
import app.noter.model.Note
import app.noter.model.WorkspaceOps
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID

/** Real SAF operations against a private test provider; never opens a user's document tree. */
fun withTestSaf(context: Context, test: (Saf) -> Unit) {
    testTree(context) { tree -> test(tree.saf()) }
}

fun checkSafeReplacement(context: Context) {
    checkVaultSyncSafety(context)
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
    testTree(context) { tree ->
        val saf = tree.saf()
        val log = ".noter/finance/log-test.jsonl"
        val previous = "{\"first\":1}\n".toByteArray()
        saf.writeAtomic(log, previous)
        check(runCatching { saf.append(log, "{\"next\":2}\n".toByteArray(), "changed".toByteArray()) }.exceptionOrNull() is SyncConflictException)
        check(saf.read(saf.resolve(log)!!.doc).contentEquals(previous))
        tree.provider.truncateNextAppend = true
        check(runCatching { saf.append(log, "{\"next\":2}\n".toByteArray(), previous) }.isFailure)
        check(saf.list(saf.resolve(".noter/trash")!!.doc).any { saf.read(it.doc).contentEquals(previous) }) {
            "A provider that truncated append lost the previous completed log"
        }
    }
}

private fun checkVaultSyncSafety(context: Context) {
    testTree(context) { tree ->
        val saf = tree.saf()
        saf.writeAtomic("Test.md", "before".toByteArray())
        val vault = Vault(saf)
        val loaded = vault.load()
        val id = loaded.workspace.nodes.values.filterIsInstance<Note>().single().id
        tree.provider.change(saf.resolve("Test.md")!!.doc, "remote".toByteArray(), true)
        check(vault.revision(true) != loaded.revision) { "Equal-size incoming content with unchanged timestamps was not detected" }
        check(runCatching { vault.save(WorkspaceOps.edit(loaded.workspace, id, "local!"), loaded.revision) }.exceptionOrNull() is SyncConflictException)
        check(tree.text(saf, "Test.md") == "remote") { "Incoming content was overwritten" }
        check(runCatching { saf.read(saf.resolve("Test.md")!!.doc, 3) }.isFailure) { "The provider bypassed the byte limit" }
        for (path in listOf("../Test.md", "/Test.md", "a//Test.md", "a\\Test.md")) check(runCatching { saf.resolve(path) }.isFailure)
        check(runCatching { saf.writeAtomic("Test.md", "unexpected".toByteArray(), mustBeAbsent = true) }.exceptionOrNull() is SyncConflictException)
    }
    testTree(context) { tree ->
        val saf = tree.saf()
        saf.writeAtomic("Test.md", "before".toByteArray())
        Vault(saf).load()
        val compact = JSONObject(tree.text(saf, ".noter/workspace.json")).toString().toByteArray()
        saf.writeAtomic(".noter/workspace.json", compact)
        val vault = Vault(saf)
        val loaded = vault.load()
        check(saf.read(saf.resolve(".noter/workspace.json")!!.doc).contentEquals(compact)) { "Opening rewrote unchanged shared metadata" }
        vault.save(loaded.workspace, loaded.revision)
        check(saf.read(saf.resolve(".noter/workspace.json")!!.doc).contentEquals(compact)) { "A no-op save rewrote unchanged shared metadata" }
        saf.delete(saf.resolve("Test.md")!!.doc)
        check(runCatching { Vault(saf).load() }.exceptionOrNull() is SyncConflictException) { "A missing synced note silently discarded its ID" }
        check(saf.read(saf.resolve(".noter/workspace.json")!!.doc).contentEquals(compact))
        val unsupported = JSONObject(String(compact)).apply { getJSONObject("workspace").put("version", 2) }.toString().toByteArray()
        saf.writeAtomic(".noter/workspace.json", unsupported)
        check(runCatching { Vault(saf).load() }.isFailure)
        check(saf.read(saf.resolve(".noter/workspace.json")!!.doc).contentEquals(unsupported))
    }
    testTree(context) { tree ->
        val saf = tree.saf()
        saf.writeAtomic("Test.md", "before".toByteArray())
        saf.writeAtomic("Other.md", "before".toByteArray())
        val vault = Vault(saf)
        val loaded = vault.load()
        val id = loaded.workspace.nodes.values.filterIsInstance<Note>().first { it.name == "Test" }.id
        tree.provider.promotionFailure = { tree.provider.change(saf.resolve("Other.md")!!.doc, "remote".toByteArray(), true) }
        check(runCatching { vault.save(WorkspaceOps.edit(loaded.workspace, id, "edited"), loaded.revision) }.exceptionOrNull() is SyncConflictException) {
            "A change to an untouched note during saving was acknowledged"
        }
        check(tree.text(saf, "Other.md") == "remote")
        check((Vault(saf).load().workspace.nodes[id] as Note).markdown == "edited")
    }
    testTree(context) { tree ->
        val saf = tree.saf()
        saf.writeAtomic("Test.md", "before".toByteArray())
        val vault = Vault(saf)
        val loaded = vault.load()
        val id = loaded.workspace.nodes.values.filterIsInstance<Note>().single().id
        tree.provider.deleteFailure = { throw AssertionError("Injected interruption before old-source cleanup") }
        check(runCatching { vault.save(WorkspaceOps.rename(loaded.workspace, id, "Renamed"), loaded.revision) }.exceptionOrNull() is AssertionError)
        val reopened = Vault(tree.saf()).load().workspace
        check((reopened.nodes[id] as Note).name == "Renamed") { "Interrupted rename lost the stable note ID" }
        check(tree.text(saf, "Renamed.md") == "before" && tree.text(saf, "Test.md") == "before")
    }
    testTree(context) { tree ->
        val saf = tree.saf()
        val vault = Vault(saf)
        val loaded = vault.load()
        val names = listOf("COM1", "COM١", "NUL", "A/B", "Résumé 📝")
        var workspace = loaded.workspace
        for (name in names) workspace = WorkspaceOps.addNote(workspace, name, null).first
        vault.save(workspace, loaded.revision)
        check(saf.list(saf.rootDoc).map { it.name }.toSet() == setOf(".noter", "_COM1.md", "COM١.md", "_NUL.md", "A_B.md", "Résumé 📝.md")) {
            "Portable filename generation differs from desktop"
        }
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
    var truncateNextAppend = false
    var deleteFailure: (() -> Unit)? = null

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
        val actualMode = if (mode == "wa" && truncateNextAppend) { truncateNextAppend = false; "wt" } else mode
        return ParcelFileDescriptor.open(item.file, ParcelFileDescriptor.parseMode(actualMode))
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
        if (items[documentId]?.name == "Test.md") {
            val failure = deleteFailure
            deleteFailure = null
            failure?.invoke()
        }
        val item = items.remove(documentId) ?: throw FileNotFoundException()
        check(!item.isDir || items.values.none { it.parent == documentId })
        if (!item.isDir) check(item.file.delete())
    }

    fun put(name: String, bytes: ByteArray) {
        val id = createDocument("root", "application/octet-stream", name)
        items.getValue(id).file.writeBytes(bytes)
    }

    fun change(documentId: String, bytes: ByteArray, preserveModified: Boolean) {
        val file = items.getValue(documentId).file
        val modified = file.lastModified()
        file.writeBytes(bytes)
        if (preserveModified) check(file.setLastModified(modified))
    }
}
