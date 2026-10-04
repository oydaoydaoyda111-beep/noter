package app.noter.model

import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

enum class SearchScope(val label: String) {
    All("All"), Names("Names"), Contents("Contents"), Folders("Folders")
}

data class NoteSearchResult(val note: Note, val path: String, val preview: String, val nameMatch: Boolean)

private val searchWhitespace = Regex("\\s+")

/** Searches the current in-memory notes, including unsaved edits; never writes an index to the vault. */
suspend fun searchNotes(nodes: Map<String, Node>, query: String, scope: SearchScope = SearchScope.All): List<NoteSearchResult> {
    val needle = query.trim()
    if (needle.isEmpty()) return emptyList()
    val results = ArrayList<NoteSearchResult>()
    for (note in nodes.values.filterIsInstance<Note>()) {
        coroutineContext.ensureActive()
        val parents = ArrayList<String>()
        val visited = hashSetOf(note.id)
        var parentId = note.parentId
        while (parentId != null && visited.add(parentId)) {
            val parent = nodes[parentId] as? Folder ?: break
            parents += parent.name
            parentId = parent.parentId
        }
        val path = parents.asReversed().joinToString(" / ")
        val nameMatch = note.name.contains(needle, ignoreCase = true)
        val contentIndex = if (scope == SearchScope.All || scope == SearchScope.Contents) note.markdown.indexOf(needle, ignoreCase = true) else -1
        val matches = when (scope) {
            SearchScope.All -> nameMatch || contentIndex >= 0 || path.contains(needle, ignoreCase = true)
            SearchScope.Names -> nameMatch
            SearchScope.Contents -> contentIndex >= 0
            SearchScope.Folders -> path.contains(needle, ignoreCase = true)
        }
        if (!matches) continue
        val start = (contentIndex - 40).coerceAtLeast(0)
        val end = (start + 160).coerceAtMost(note.markdown.length)
        val preview = (if (start > 0) "…" else "") +
            note.markdown.substring(start, end).replace(searchWhitespace, " ").trim() +
            (if (end < note.markdown.length) "…" else "")
        results += NoteSearchResult(note, path, preview, nameMatch)
    }
    return results.sortedWith(compareByDescending<NoteSearchResult> { it.nameMatch }
        .thenBy(String.CASE_INSENSITIVE_ORDER) { it.note.name }.thenBy { it.note.id })
}
