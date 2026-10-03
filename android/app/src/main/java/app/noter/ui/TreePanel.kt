package app.noter.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.noter.model.Folder
import app.noter.model.Node
import app.noter.model.Workspace

private fun visibleRows(workspace: Workspace): List<Pair<Node, Int>> {
    val rows = ArrayList<Pair<Node, Int>>()
    fun walk(ids: List<String>, depth: Int) {
        for (id in ids) {
            val node = workspace.nodes[id] ?: continue
            rows += node to depth
            if (node is Folder && node.id !in workspace.collapsedFolders) walk(node.children, depth + 1)
        }
    }
    walk(workspace.rootIds, 0)
    return rows
}

@Composable
fun TreePanel(
    workspace: Workspace,
    onOpenNote: (String) -> Unit,
    onToggleFolder: (String) -> Unit,
    onNewNote: (parentId: String?) -> Unit,
    onNewFolder: (parentId: String?) -> Unit,
    onRename: (String) -> Unit,
    onDelete: (String) -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Notes", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        TextButton(onClick = { onNewFolder(null) }) { Text("New folder") }
        IconButton(onClick = { onNewNote(null) }) { Icon(Icons.Default.Add, contentDescription = "New note") }
    }
    LazyColumn {
        items(visibleRows(workspace), key = { it.first.id }) { (node, depth) ->
            var menu by remember { mutableStateOf(false) }
            val active = node.id == workspace.activeNoteId
            Row(
                Modifier.fillMaxWidth()
                    .clickable { if (node is Folder) onToggleFolder(node.id) else onOpenNote(node.id) }
                    .padding(start = (16 + depth * 16).dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                val marker = when {
                    node !is Folder -> ""
                    node.id in workspace.collapsedFolders -> "▸"
                    else -> "▾"
                }
                Text(marker, modifier = Modifier.size(16.dp))
                Text(
                    node.name,
                    modifier = Modifier.weight(1f).padding(vertical = 12.dp),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                )
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Actions for ${node.name}") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        if (node is Folder) {
                            DropdownMenuItem(text = { Text("New note here") }, onClick = { menu = false; onNewNote(node.id) })
                            DropdownMenuItem(text = { Text("New folder here") }, onClick = { menu = false; onNewFolder(node.id) })
                        }
                        DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; onRename(node.id) })
                        DropdownMenuItem(text = { Text("Delete") }, onClick = { menu = false; onDelete(node.id) })
                    }
                }
            }
        }
    }
}
