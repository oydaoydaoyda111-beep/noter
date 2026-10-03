package app.noter.model

import java.util.UUID

object WorkspaceOps {
    fun newId(): String = UUID.randomUUID().toString()

    private fun cleanName(name: String): String = name.trim().ifEmpty { "Untitled" }

    private fun attach(workspace: Workspace, node: Node, parentId: String?): Workspace {
        val nodes = workspace.nodes + (node.id to node)
        if (parentId == null) return workspace.copy(nodes = nodes, rootIds = workspace.rootIds + node.id)
        val parent = workspace.nodes[parentId] as? Folder ?: return workspace.copy(nodes = nodes, rootIds = workspace.rootIds + node.id)
        return workspace.copy(
            nodes = nodes + (parent.id to parent.copy(children = parent.children + node.id)),
            collapsedFolders = workspace.collapsedFolders - parent.id,
        )
    }

    fun addNote(workspace: Workspace, name: String, parentId: String?): Pair<Workspace, String> {
        val now = System.currentTimeMillis()
        val id = newId()
        val parent = parentId?.takeIf { workspace.nodes[it] is Folder }
        val updated = attach(workspace, Note(id, cleanName(name), parent, now, now, ""), parent)
        return open(updated, id) to id
    }

    fun addFolder(workspace: Workspace, name: String, parentId: String?): Workspace {
        val now = System.currentTimeMillis()
        val parent = parentId?.takeIf { workspace.nodes[it] is Folder }
        return attach(workspace, Folder(newId(), cleanName(name), parent, now, now, emptyList()), parent)
    }

    fun rename(workspace: Workspace, id: String, name: String): Workspace {
        val node = workspace.nodes[id] ?: return workspace
        val now = System.currentTimeMillis()
        val renamed = when (node) {
            is Note -> node.copy(name = cleanName(name), updatedAt = now)
            is Folder -> node.copy(name = cleanName(name), updatedAt = now)
        }
        return workspace.copy(nodes = workspace.nodes + (id to renamed))
    }

    fun edit(workspace: Workspace, id: String, markdown: String): Workspace {
        val note = workspace.nodes[id] as? Note ?: return workspace
        if (note.markdown == markdown) return workspace
        return workspace.copy(nodes = workspace.nodes + (id to note.copy(markdown = markdown, updatedAt = System.currentTimeMillis())))
    }

    fun delete(workspace: Workspace, id: String): Workspace {
        val node = workspace.nodes[id] ?: return workspace
        val removed = HashSet<String>()
        fun collect(target: String) {
            if (!removed.add(target)) return
            (workspace.nodes[target] as? Folder)?.children?.forEach(::collect)
        }
        collect(id)
        val nodes = (workspace.nodes - removed).toMutableMap()
        val parent = node.parentId?.let { nodes[it] as? Folder }
        if (parent != null) nodes[parent.id] = parent.copy(children = parent.children - id)
        val openTabs = workspace.openTabs.filter { it !in removed }
        val active = workspace.activeNoteId?.takeIf { it in openTabs } ?: openTabs.firstOrNull()
        return workspace.copy(
            nodes = nodes,
            rootIds = workspace.rootIds - id,
            openTabs = openTabs,
            activeNoteId = active,
            collapsedFolders = workspace.collapsedFolders.filter { it !in removed },
        )
    }

    fun open(workspace: Workspace, id: String): Workspace {
        if (workspace.nodes[id] !is Note) return workspace
        val tabs = if (id in workspace.openTabs) workspace.openTabs else workspace.openTabs + id
        return workspace.copy(openTabs = tabs, activeNoteId = id)
    }

    fun select(workspace: Workspace, id: String): Workspace =
        if (id in workspace.openTabs) workspace.copy(activeNoteId = id) else workspace

    fun close(workspace: Workspace, id: String): Workspace {
        val index = workspace.openTabs.indexOf(id)
        if (index < 0) return workspace
        val tabs = workspace.openTabs - id
        val active = if (workspace.activeNoteId == id) tabs.getOrNull(index) ?: tabs.lastOrNull() else workspace.activeNoteId
        return workspace.copy(openTabs = tabs, activeNoteId = active)
    }

    fun toggleFolder(workspace: Workspace, id: String): Workspace {
        if (workspace.nodes[id] !is Folder) return workspace
        val collapsed = if (id in workspace.collapsedFolders) workspace.collapsedFolders - id else workspace.collapsedFolders + id
        return workspace.copy(collapsedFolders = collapsed)
    }

    fun updateSettings(workspace: Workspace, change: (Settings) -> Settings): Workspace =
        workspace.copy(settings = change(workspace.settings))
}
