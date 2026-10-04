package app.noter.storage

import app.noter.model.Folder
import app.noter.model.Node
import app.noter.model.Note
import app.noter.model.Workspace
import app.noter.model.WorkspaceOps
import app.noter.model.normalizeSettings
import app.noter.model.toJson
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.TreeMap
import java.util.UUID

class VaultException(message: String) : Exception(message)

/** Files changed outside Noter; the caller must reload before saving. */
class SyncConflictException(message: String) : Exception(message)

private const val MAX_NOTE = 10_000_000L
private const val MAX_TOTAL = 100_000_000L
private const val MANIFEST = ".noter/workspace.json"

/**
 * Markdown files plus `.noter/workspace.json`, in the same layout as the desktop vault so both clients can share a synced folder.
 * Revisions verify note contents; routine polling uses metadata hints between bounded full audits.
 */
class Vault(private val saf: Saf) {
    class Loaded(val workspace: Workspace, val revision: String)
    data class PreservedEdits(val snapshot: String, val folder: String?, val notes: Int)

    private class Manifest(val workspace: JSONObject, val paths: Map<String, String>, val bytes: ByteArray)
    private class Snapshot(val disk: TreeMap<String, Entry>, val contents: TreeMap<String, String?>, val manifest: Manifest)

    private var pollingMetadata: String? = null
    private var pollingRevision: String? = null
    private var lastFullCheck = 0L

    private fun visiblePath(path: String) {
        saf.validatePath(path)
        if (path.split('/').any { it.startsWith('.') || it == "node_modules" }) {
            throw VaultException("Workspace note paths must be visible portable files. Your files have been kept.")
        }
    }

    private fun readManifest(): Manifest {
        val entry = saf.resolve(MANIFEST) ?: return Manifest(JSONObject(), emptyMap(), ByteArray(0))
        if (entry.isDir) throw VaultException("Workspace metadata is a folder. Your files have been kept.")
        val bytes = saf.read(entry.doc)
        try {
            val root = strictJsonObject(decode(bytes))
            val workspace = root.getJSONObject("workspace")
            if ((workspace.opt("version") as? Number)?.toDouble() != 1.0) {
                throw VaultException("This workspace version is not supported. Your files have been kept.")
            }
            val nodes = workspace.getJSONObject("nodes")
            val paths = root.getJSONObject("paths")
            if (nodes.length() != paths.length()) throw JSONException("Mismatched paths")
            val used = HashSet<String>()
            val mapping = LinkedHashMap<String, String>()
            for (id in paths.keys()) {
                val path = paths.opt(id) as? String ?: throw JSONException("Invalid path type")
                visiblePath(path)
                val node = nodes.getJSONObject(id)
                val type = node.opt("type") as? String ?: throw JSONException("Invalid node type")
                if (id.isEmpty() || node.opt("id") != id || type !in setOf("note", "folder") || !used.add(path.lowercase()) ||
                    (type == "note" && !path.lowercase().endsWith(".md"))) throw JSONException("Invalid paths")
                mapping[id] = path
            }
            return Manifest(workspace, mapping, bytes)
        } catch (_: JSONException) {
            throw VaultException("Workspace metadata could not be read. Your files have been kept.")
        }
    }

    private fun scan(): TreeMap<String, Entry> {
        val result = TreeMap<String, Entry>()
        val used = HashSet<String>()
        var total = 0L
        fun walk(doc: String, prefix: String) {
            for (entry in saf.list(doc)) {
                if (entry.name.startsWith(".") || entry.name == "node_modules") continue
                val key = prefix + entry.name
                if (entry.isDir || entry.name.lowercase().endsWith(".md")) {
                    visiblePath(key)
                    if (!used.add(key.lowercase())) throw VaultException("Two workspace files differ only by letter case. Rename one so every device can read this folder.")
                }
                if (entry.isDir) {
                    result[key] = entry
                    walk(entry.doc, "$key/")
                } else if (entry.name.lowercase().endsWith(".md")) {
                    if (entry.size > MAX_NOTE) throw VaultException("A note is larger than 10 MB. Move it outside the workspace to open this folder.")
                    total += entry.size
                    if (total > MAX_TOTAL) throw VaultException("Choose a workspace with less than 100 MB of Markdown content.")
                    result[key] = entry
                }
                if (result.size > 10_000) throw VaultException("Choose a workspace with fewer than 10,000 notes and folders.")
            }
        }
        walk(saf.rootDoc, "")
        return result
    }

    private fun metadataRevision(disk: Map<String, Entry>, metadata: ByteArray): String {
        val hash = MessageDigest.getInstance("SHA-256")
        for ((path, entry) in disk) {
            hash.update(path.toByteArray())
            hash.update(byteArrayOf(0, if (entry.isDir) 1 else 0))
            hash.update("${entry.size}:${entry.modified}".toByteArray())
            hash.update(0)
        }
        hash.update(metadata)
        return hash.digest().joinToString("") { "%02x".format(it) }
    }

    private fun revisionOf(contents: Map<String, String?>, metadata: ByteArray): String {
        val hash = MessageDigest.getInstance("SHA-256")
        fun length(size: Int) = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(size.toLong()).array()
        for ((path, content) in contents) {
            val name = path.toByteArray()
            hash.update(length(name.size))
            hash.update(name)
            hash.update(if (content == null) 0.toByte() else 1.toByte())
            if (content != null) {
                val bytes = content.toByteArray()
                hash.update(length(bytes.size))
                hash.update(bytes)
            }
        }
        hash.update(metadata)
        return hash.digest().joinToString("") { "%02x".format(it) }
    }

    private fun snapshot(disk: TreeMap<String, Entry> = scan(), manifest: Manifest = readManifest()): Snapshot {
        val contents = TreeMap<String, String?>()
        var total = 0L
        for ((path, entry) in disk) {
            if (entry.isDir) contents[path] = null else {
                val bytes = saf.read(entry.doc, MAX_NOTE)
                total += bytes.size
                if (total > MAX_TOTAL) throw VaultException("Choose a workspace with less than 100 MB of Markdown content.")
                contents[path] = decode(bytes)
            }
        }
        return Snapshot(disk, contents, manifest)
    }

    private fun remember(snapshot: Snapshot, revision: String) {
        pollingMetadata = metadataRevision(snapshot.disk, snapshot.manifest.bytes)
        pollingRevision = revision
        lastFullCheck = System.nanoTime()
    }

    fun revision(force: Boolean = false): String {
        val disk = scan()
        val manifest = readManifest()
        val hint = metadataRevision(disk, manifest.bytes)
        if (!force && hint == pollingMetadata && System.nanoTime() - lastFullCheck < 60_000_000_000L) {
            pollingRevision?.let { return it }
        }
        val current = snapshot(disk, manifest)
        val value = revisionOf(current.contents, manifest.bytes)
        remember(current, value)
        return value
    }

    private fun decode(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) {
        throw VaultException("A Markdown file could not be read as UTF-8. Your files have been kept.")
    }

    private fun ordered(previous: JSONArray?, current: List<String>): List<String> {
        val wanted = current.toHashSet()
        val result = LinkedHashSet<String>()
        if (previous != null) for (index in 0 until previous.length()) previous.optString(index).takeIf { it in wanted }?.let(result::add)
        result.addAll(current)
        return result.toList()
    }

    private fun JSONObject?.time(key: String): Long? = this?.optLong(key, 0L)?.takeIf { it > 0 }

    private fun sameJson(actual: Any?, expected: Any?): Boolean = when (expected) {
        is JSONObject -> actual is JSONObject && actual.length() == expected.length() &&
            expected.keys().asSequence().all { sameJson(actual.opt(it), expected.opt(it)) }
        is JSONArray -> actual is JSONArray && actual.length() == expected.length() &&
            (0 until expected.length()).all { sameJson(actual.opt(it), expected.opt(it)) }
        is Number -> actual is Number && actual.toString().toBigDecimal().compareTo(expected.toString().toBigDecimal()) == 0
        else -> actual == expected
    }

    private fun metadataBytes(workspace: Workspace, paths: Map<String, String>, previous: Manifest? = null): ByteArray {
        val nodes = JSONObject()
        for (node in workspace.nodes.values) {
            val json = JSONObject()
                .put("id", node.id)
                .put("name", node.name)
                .put("parentId", node.parentId ?: JSONObject.NULL)
                .put("createdAt", node.createdAt)
                .put("updatedAt", node.updatedAt)
            when (node) {
                is Note -> json.put("type", "note")
                is Folder -> json.put("type", "folder").put("children", JSONArray(node.children))
            }
            nodes.put(node.id, json)
        }
        val metadata = JSONObject()
            .put("version", 1)
            .put("nodes", nodes)
            .put("rootIds", JSONArray(workspace.rootIds))
            .put("settings", workspace.settings.toJson())
            .put("openTabs", JSONArray(workspace.openTabs))
            .put("activeNoteId", workspace.activeNoteId ?: JSONObject.NULL)
            .put("collapsedFolders", JSONArray(workspace.collapsedFolders))
        val result = JSONObject().put("workspace", metadata).put("paths", JSONObject(paths))
        if (previous != null && previous.bytes.isNotEmpty() && sameJson(result, JSONObject(decode(previous.bytes)))) {
            return previous.bytes
        }
        return result.toString(2).toByteArray()
    }

    fun load(): Loaded {
        val initial = snapshot()
        val disk = initial.disk
        val previous = initial.manifest
        val before = revisionOf(initial.contents, previous.bytes)
        for ((id, path) in previous.paths) {
            val entry = disk[path]
            val folder = previous.workspace.getJSONObject("nodes").getJSONObject(id).getString("type") == "folder"
            if (entry == null || entry.isDir != folder) {
                throw SyncConflictException("Workspace files are still arriving or a referenced path changed. Wait for synchronization to finish and reload. Your metadata and files have been kept.")
            }
        }
        val reverse = previous.paths.entries.associate { it.value to it.key }
        val ids = HashSet<String>()
        val pathToId = LinkedHashMap<String, String>()
        for (path in disk.keys) {
            var id = reverse[path] ?: WorkspaceOps.newId()
            if (!ids.add(id)) {
                id = WorkspaceOps.newId()
                ids.add(id)
            }
            pathToId[path] = id
        }
        val now = System.currentTimeMillis()
        val originals = previous.workspace.optJSONObject("nodes") ?: JSONObject()
        val childIds = HashMap<String, MutableList<String>>()
        for ((path, id) in pathToId) childIds.getOrPut(path.substringBeforeLast('/', "")) { mutableListOf() }.add(id)
        val nodes = LinkedHashMap<String, Node>()
        for ((path, entry) in disk) {
            val id = pathToId.getValue(path)
            val original = originals.optJSONObject(id)
            val created = original.time("createdAt") ?: now
            val updated = original.time("updatedAt") ?: now
            val parent = path.substringBeforeLast('/', "").takeIf { it.isNotEmpty() }?.let { pathToId[it] }
            val name = path.substringAfterLast('/')
            nodes[id] = if (entry.isDir) {
                Folder(id, name, parent, created, updated, ordered(original?.optJSONArray("children"), childIds[path].orEmpty()))
            } else {
                val markdown = checkNotNull(initial.contents[path])
                Note(id, name.dropLast(3), parent, created, updated, markdown)
            }
        }
        val roots = ordered(previous.workspace.optJSONArray("rootIds"), childIds[""].orEmpty())
        val firstNote = nodes.values.firstOrNull { it is Note }?.id
        val savedTabs = previous.workspace.optJSONArray("openTabs")
        val tabs = (if (savedTabs != null) List(savedTabs.length()) { savedTabs.optString(it) } else listOfNotNull(firstNote))
            .distinct().filter { nodes[it] is Note }
        val savedActive = previous.workspace.optString("activeNoteId", "")
        val savedCollapsed = previous.workspace.optJSONArray("collapsedFolders")
        val workspace = Workspace(
            nodes = nodes,
            rootIds = roots,
            openTabs = tabs,
            activeNoteId = savedActive.takeIf { it in tabs } ?: tabs.firstOrNull(),
            collapsedFolders = (if (savedCollapsed != null) List(savedCollapsed.length()) { savedCollapsed.optString(it) } else emptyList())
                .filter { nodes[it] is Folder },
            settings = normalizeSettings(previous.workspace.optJSONObject("settings")),
        )
        val stable = pathToId.entries.associate { it.value to it.key }
        val bytes = metadataBytes(workspace, stable, previous)
        val changed = "Files changed while opening the folder. Wait for synchronization and reload."
        if (revision(true) != before) throw SyncConflictException(changed)
        saf.writeAtomic(MANIFEST, bytes, previous.bytes.takeIf { it.isNotEmpty() }, previous.bytes.isEmpty())
        val expected = revisionOf(initial.contents, bytes)
        val verified = snapshot()
        val actual = revisionOf(verified.contents, verified.manifest.bytes)
        if (actual != expected) throw SyncConflictException(changed)
        remember(verified, actual)
        return Loaded(workspace, actual)
    }

    private fun filename(raw: String): String {
        val replaced = raw.map { if (it.isISOControl() || it in "/\\<>:\"|?*") '_' else it }.joinToString("")
        val trimmed = replaced.trim().trimEnd('.', ' ')
        val name = if (trimmed.isEmpty() || trimmed.startsWith(".")) "Untitled" else trimmed
        val upper = name.substringBefore('.').uppercase()
        val reserved = upper in setOf("CON", "PRN", "AUX", "NUL") ||
            (upper.length == 4 && (upper.startsWith("COM") || upper.startsWith("LPT")) && upper.last() in '0'..'9')
        return if (reserved) "_$name" else name
    }

    private fun plan(
        workspace: Workspace, ids: List<String>, parent: String,
        paths: MutableMap<String, String>, used: MutableSet<String>, previous: Manifest,
    ) {
        val previousNodes = previous.workspace.optJSONObject("nodes")
        for (id in ids) {
            val node = workspace.nodes[id] ?: throw VaultException("Invalid workspace hierarchy.")
            if (paths.containsKey(id)) throw VaultException("Invalid workspace hierarchy.")
            val stem = filename(node.name)
            val suffix = if (node is Note) ".md" else ""
            val type = if (node is Note) "note" else "folder"
            val before = previousNodes?.optJSONObject(id)
            val basename = previous.paths[id]
                ?.takeIf { before?.optString("name") == node.name && before?.optString("type") == type }
                ?.substringAfterLast('/') ?: "$stem$suffix"
            var candidate = "$parent$basename"
            var index = 2
            while (candidate.lowercase() in used) {
                candidate = "$parent$stem ($index)$suffix"
                index++
            }
            used.add(candidate.lowercase())
            paths[id] = candidate
            if (node is Folder) plan(workspace, node.children, "$candidate/", paths, used, previous)
        }
    }

    /** Writes only new destinations, leaving incoming notes and the shared manifest intact. */
    fun preserveEdits(workspace: Workspace, base: Workspace): PreservedEdits {
        fun plannedPaths(value: Workspace): Map<String, String> {
            val result = LinkedHashMap<String, String>()
            plan(value, value.rootIds, "", result, HashSet(), Manifest(JSONObject(), emptyMap(), ByteArray(0)))
            if (result.size != value.nodes.size) throw VaultException("Invalid workspace hierarchy.")
            return result
        }
        val paths = plannedPaths(workspace)
        val basePaths = plannedPaths(base)
        val changed = workspace.nodes.values.filterIsInstance<Note>().filter { note ->
            paths[note.id] != basePaths[note.id] || note.markdown != (base.nodes[note.id] as? Note)?.markdown
        }
        if (workspace.nodes.values.filterIsInstance<Note>().any { it.markdown.toByteArray().size > MAX_NOTE }) {
            throw VaultException("Keep each note below 10 MB.")
        }
        val snapshotJson = JSONObject(String(metadataBytes(workspace, paths), Charsets.UTF_8)).getJSONObject("workspace")
        for (note in workspace.nodes.values.filterIsInstance<Note>()) snapshotJson.getJSONObject("nodes").getJSONObject(note.id).put("markdown", note.markdown)
        val bytes = snapshotJson.toString(2).toByteArray()
        if (bytes.size > MAX_TOTAL) throw VaultException("The recovery backup is larger than 100 MB. Your edits are still in memory.")
        val token = "${System.currentTimeMillis()}-${UUID.randomUUID()}"
        val snapshot = ".noter/recovery/$token/workspace.json"
        fun writeVerified(path: String, content: ByteArray) {
            if (saf.resolve(path) != null) throw VaultException("A recovery destination already exists. Your edits are still in memory.")
            saf.writeAtomic(path, content, mustBeAbsent = true)
            if (!saf.read(saf.resolve(path)?.doc ?: throw VaultException("A recovery file is missing.")).contentEquals(content)) {
                throw VaultException("A recovery file could not be verified. Your edits are still in memory.")
            }
        }
        writeVerified(snapshot, bytes)
        val folder = if (changed.isEmpty()) null else "Recovered edits $token"
        if (folder != null) for (note in changed) writeVerified("$folder/${paths.getValue(note.id)}", note.markdown.toByteArray())
        return PreservedEdits(snapshot, folder, changed.size)
    }

    fun save(workspace: Workspace, expected: String): String {
        val initial = snapshot()
        val disk = initial.disk
        val previous = initial.manifest
        if (revisionOf(initial.contents, previous.bytes) != expected) {
            throw SyncConflictException("Files changed outside Noter. Reload the folder before saving; your unsaved edits are still here.")
        }
        val paths = LinkedHashMap<String, String>()
        plan(workspace, workspace.rootIds, "", paths, HashSet(), previous)
        if (paths.size != workspace.nodes.size) throw VaultException("Invalid workspace hierarchy.")
        val oldPaths = previous.paths.values.toSet()
        var total = 0L
        for ((id, path) in paths) {
            if (saf.resolve(path) != null && path !in oldPaths) {
                throw SyncConflictException("A file already uses that name. Reload the folder before saving.")
            }
            val node = workspace.nodes.getValue(id)
            if (node is Note) {
                val size = node.markdown.toByteArray().size
                if (size > MAX_NOTE) throw VaultException("Keep each note below 10 MB.")
                total += size
                if (total > MAX_TOTAL) throw VaultException("Choose a workspace with less than 100 MB of Markdown content.")
            }
        }
        // Keep changed/deleted files in recoverable trash before moving or replacing them.
        val trash = ".noter/trash/${System.currentTimeMillis()}-${UUID.randomUUID()}"
        val previousNodes = previous.workspace.optJSONObject("nodes")
        for ((id, old) in previous.paths) {
            if (previousNodes?.optJSONObject(id)?.optString("type") != "note") continue
            val note = workspace.nodes[id] as? Note
            val text = initial.contents[old] ?: continue
            if (paths[id] == old && note != null && text == note.markdown) continue
            saf.writeAtomic("$trash/$old", text.toByteArray(), mustBeAbsent = true)
        }
        if (revision(true) != expected) {
            throw SyncConflictException("Files changed while preparing the save. Your edits are still in memory.")
        }
        fun checkManifest(bytes: ByteArray) {
            if (!readManifest().bytes.contentEquals(bytes)) {
                throw SyncConflictException("Workspace metadata changed while saving. Your edits are still in memory.")
            }
        }
        val intended = TreeMap(initial.contents)
        // Publish destinations and metadata before deleting any renamed/deleted originals.
        for ((id, relative) in paths) {
            checkManifest(previous.bytes)
            when (val node = workspace.nodes.getValue(id)) {
                is Folder -> {
                    saf.ensureDir(relative)
                    intended[relative] = null
                }
                is Note -> {
                    val old = initial.contents[relative]
                    if (old != node.markdown) saf.writeAtomic(relative, node.markdown.toByteArray(), old?.toByteArray(), relative !in disk)
                    intended[relative] = node.markdown
                }
            }
        }
        val bytes = metadataBytes(workspace, paths, previous)
        saf.writeAtomic(MANIFEST, bytes, previous.bytes.takeIf { it.isNotEmpty() }, previous.bytes.isEmpty())
        val wanted = paths.values.toSet()
        for (old in previous.paths.values.filter { it !in wanted }.sortedByDescending { it.length }) {
            checkManifest(bytes)
            val entry = saf.resolve(old) ?: continue
            val wasFolder = disk[old]?.isDir
            if (wasFolder != entry.isDir || (!entry.isDir && decode(saf.read(entry.doc, MAX_NOTE)) != initial.contents[old])) {
                throw SyncConflictException("An old note changed while saving. Both versions have been kept; reload before saving again.")
            }
            // SAF deletes folders recursively, so only remove folders that are already empty.
            if (!entry.isDir || saf.list(entry.doc).isEmpty()) {
                saf.delete(entry.doc)
                intended.remove(old)
            }
        }
        val expectedResult = revisionOf(intended, bytes)
        val verified = snapshot()
        if (revisionOf(verified.contents, verified.manifest.bytes) != expectedResult) {
            throw SyncConflictException("Files changed while saving. Reload the folder before saving again; your edits are still here.")
        }
        remember(verified, expectedResult)
        return expectedResult
    }
}
