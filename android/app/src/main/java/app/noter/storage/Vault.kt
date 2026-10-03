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
 * Unlike desktop, revisions hash file metadata (path, size, modified time) rather than content, to avoid reading every note over SAF.
 */
class Vault(private val saf: Saf) {
    class Loaded(val workspace: Workspace, val revision: String)

    private class Manifest(val workspace: JSONObject, val paths: Map<String, String>, val bytes: ByteArray)

    /** Markdown of every note as of the last load/save; valid because the revision check guarantees the disk matches it. */
    private var known: Map<String, String> = emptyMap()

    private fun readManifest(): Manifest {
        val entry = saf.resolve(MANIFEST)?.takeIf { !it.isDir } ?: return Manifest(JSONObject(), emptyMap(), ByteArray(0))
        val bytes = saf.read(entry.doc)
        try {
            val root = JSONObject(String(bytes, Charsets.UTF_8))
            val paths = root.optJSONObject("paths") ?: JSONObject()
            return Manifest(
                root.optJSONObject("workspace") ?: JSONObject(),
                paths.keys().asSequence().associateWith { paths.getString(it) },
                bytes,
            )
        } catch (_: JSONException) {
            throw VaultException("Workspace metadata could not be read. Your files have been kept.")
        }
    }

    private fun scan(): TreeMap<String, Entry> {
        val result = TreeMap<String, Entry>()
        var total = 0L
        fun walk(doc: String, prefix: String) {
            for (entry in saf.list(doc)) {
                if (entry.name.startsWith(".") || entry.name == "node_modules") continue
                val key = prefix + entry.name
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

    private fun revisionOf(disk: Map<String, Entry>, metadata: ByteArray): String {
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

    fun revision(): String = revisionOf(scan(), readManifest().bytes)

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

    private fun metadataBytes(workspace: Workspace, paths: Map<String, String>): ByteArray {
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
        return JSONObject().put("workspace", metadata).put("paths", JSONObject(paths)).toString(2).toByteArray()
    }

    fun load(): Loaded {
        val disk = scan()
        val previous = readManifest()
        val before = revisionOf(disk, previous.bytes)
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
        val texts = HashMap<String, String>()
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
                val markdown = decode(saf.read(entry.doc))
                texts[id] = markdown
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
        val bytes = metadataBytes(workspace, stable)
        val changed = "Files changed while opening the folder. Wait for synchronization and reload."
        if (revisionOf(scan(), previous.bytes) != before) throw SyncConflictException(changed)
        saf.writeAtomic(MANIFEST, bytes)
        val expected = revisionOf(disk, bytes)
        val actual = revisionOf(scan(), bytes)
        if (actual != expected) throw SyncConflictException(changed)
        known = texts
        return Loaded(workspace, actual)
    }

    private fun filename(raw: String): String {
        val replaced = raw.map { if (it.isISOControl() || it in "/\\<>:\"|?*") '_' else it }.joinToString("")
        val trimmed = replaced.trim().trimEnd('.', ' ')
        val name = if (trimmed.isEmpty() || trimmed.startsWith(".")) "Untitled" else trimmed
        val upper = name.substringBefore('.').uppercase()
        val reserved = upper in setOf("CON", "PRN", "AUX", "NUL") ||
            (upper.length == 4 && (upper.startsWith("COM") || upper.startsWith("LPT")) && upper.last().isDigit())
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

    fun save(workspace: Workspace, expected: String): String {
        val disk = scan()
        val previous = readManifest()
        if (revisionOf(disk, previous.bytes) != expected) {
            throw SyncConflictException("Files changed outside Noter. Reload the folder before saving; your unsaved edits are still here.")
        }
        val paths = LinkedHashMap<String, String>()
        plan(workspace, workspace.rootIds, "", paths, HashSet(), previous)
        if (paths.size != workspace.nodes.size) throw VaultException("Invalid workspace hierarchy.")
        val oldPaths = previous.paths.values.toSet()
        for ((id, path) in paths) {
            if (disk.containsKey(path) && path !in oldPaths) {
                throw SyncConflictException("A file already uses that name. Reload the folder before saving.")
            }
            val node = workspace.nodes.getValue(id)
            if (node is Note && node.markdown.toByteArray().size > MAX_NOTE) throw VaultException("Keep each note below 10 MB.")
        }
        // Keep changed/deleted files in recoverable trash before moving or replacing them.
        val trash = ".noter/trash/${System.currentTimeMillis()}-${UUID.randomUUID()}"
        val previousNodes = previous.workspace.optJSONObject("nodes")
        for ((id, old) in previous.paths) {
            if (previousNodes?.optJSONObject(id)?.optString("type") != "note") continue
            val note = workspace.nodes[id] as? Note
            if (paths[id] == old && note != null && known[id] == note.markdown) continue
            val source = saf.resolve(old)?.takeIf { !it.isDir } ?: continue
            val bytes = saf.read(source.doc)
            if (paths[id] != old || note == null || String(bytes, Charsets.UTF_8) != note.markdown) saf.writeAtomic("$trash/$old", bytes)
        }
        if (revisionOf(scan(), previous.bytes) != expected) {
            throw SyncConflictException("Files changed while preparing the save. Your edits are still in memory.")
        }
        // Write destinations first, then remove old paths that are no longer in use.
        for ((id, relative) in paths) {
            when (val node = workspace.nodes.getValue(id)) {
                is Folder -> saf.ensureDir(relative)
                is Note -> if (relative != previous.paths[id] || known[id] != node.markdown) saf.writeAtomic(relative, node.markdown.toByteArray())
            }
        }
        val wanted = paths.values.toSet()
        for (old in previous.paths.values.filter { it !in wanted }.sortedByDescending { it.length }) {
            val entry = saf.resolve(old) ?: continue
            // SAF deletes folders recursively, so only remove folders that are already empty.
            if (!entry.isDir || saf.list(entry.doc).isEmpty()) saf.delete(entry.doc)
        }
        val bytes = metadataBytes(workspace, paths)
        saf.writeAtomic(MANIFEST, bytes)
        known = workspace.nodes.values.filterIsInstance<Note>().associate { it.id to it.markdown }
        return revisionOf(scan(), bytes)
    }
}
