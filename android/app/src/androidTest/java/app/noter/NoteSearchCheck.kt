package app.noter

import app.noter.model.Folder
import app.noter.model.Note
import app.noter.model.SearchScope
import app.noter.model.Workspace
import app.noter.model.WorkspaceOps
import app.noter.model.searchNotes
import kotlinx.coroutines.runBlocking

internal fun checkNoteSearch() = runBlocking {
    val folder = Folder("projects", "Projects", null, 1, 1, listOf("archive"))
    val nested = Folder("archive", "Archive", folder.id, 1, 1, listOf("body", "name"))
    val body = Note("body", "Alpha", nested.id, 1, 1, "A long introduction. ".repeat(20) + "Emulator\ncheck\twith notes.")
    val name = Note("name", "Emulator guide", nested.id, 1, 1, "Setup instructions.")
    val root = Note("root", "Other", null, 1, 1, "Literal .* [brackets] and İ / 😀.")
    val workspace = Workspace(nodes = listOf(folder, nested, body, name, root).associateBy { it.id },
        rootIds = listOf(folder.id, root.id), openTabs = listOf(root.id), activeNoteId = root.id)
    suspend fun ids(query: String, scope: SearchScope = SearchScope.All) = searchNotes(workspace.nodes, query, scope).map { it.note.id }
    check(ids("  EMULATOR  ") == listOf(name.id, body.id)) { "Name matches must come first, ignoring case and outer whitespace" }
    check(ids("emulator", SearchScope.Names) == listOf(name.id))
    check(ids("emulator", SearchScope.Contents) == listOf(body.id))
    check(ids("projects / archive", SearchScope.Folders) == listOf(body.id, name.id))
    check(ids("ARCHIVE") == listOf(body.id, name.id))
    check(ids("archive", SearchScope.Contents).isEmpty())
    check(ids("  ").isEmpty() && ids("missing").isEmpty())
    check(ids(".*") == listOf(root.id) && ids("[brackets]") == listOf(root.id)) { "Search text must be literal" }
    check(ids("😀") == listOf(root.id))
    val result = searchNotes(workspace.nodes, "emulator", SearchScope.Contents).single()
    check(result.path == "Projects / Archive")
    check(result.preview.startsWith("…") && result.preview.contains("Emulator check with notes.")) { "Preview must show the content match and normalize whitespace" }
    check(result.preview.length <= 162)
    check(searchNotes(workspace.nodes, "Other").single().path.isEmpty())
    val edited = WorkspaceOps.edit(workspace, root.id, "unsaved needle")
    check(searchNotes(edited.nodes, "unsaved needle").single().note.id == root.id)
    check(searchNotes(WorkspaceOps.delete(workspace, nested.id).nodes, "emulator").isEmpty())
    val opened = WorkspaceOps.open(workspace, result.note.id)
    check(opened.activeNoteId == body.id && opened.openTabs == listOf(root.id, body.id) && opened.nodes == workspace.nodes)
    val loop = folder.copy(parentId = nested.id)
    check(searchNotes(workspace.nodes + (folder.id to loop), "projects", SearchScope.Folders).size == 2) { "Malformed folder cycles must terminate" }
}
