package app.noter.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.DriveFileRenameOutline
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
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
    val noteCount = workspace.nodes.values.count { it !is Folder }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 16.dp, bottom = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text("Notes", style = MaterialTheme.typography.titleLarge)
                Text(
                    "$noteCount ${if (noteCount == 1) "note" else "notes"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { onNewFolder(null) }, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Default.CreateNewFolder, contentDescription = "New folder", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            FilledTonalIconButton(onClick = { onNewNote(null) }, modifier = Modifier.size(48.dp), shape = MaterialTheme.shapes.small) {
                Icon(Icons.Default.Add, contentDescription = "New note")
            }
        }
        HorizontalDivider(Modifier.padding(horizontal = 20.dp), color = MaterialTheme.colorScheme.outlineVariant)
        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (workspace.rootIds.isEmpty()) {
                item {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("A space for your notes", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "Create a note or folder using the buttons above.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            items(visibleRows(workspace), key = { it.first.id }) { (node, depth) ->
                var menu by remember { mutableStateOf(false) }
                val active = node.id == workspace.activeNoteId
                val collapsed = node.id in workspace.collapsedFolders
                Row(
                    Modifier.fillMaxWidth()
                        .clip(MaterialTheme.shapes.small)
                        .background(if (active) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                        .semantics {
                            selected = active
                            if (node is Folder) stateDescription = if (collapsed) "Collapsed" else "Expanded"
                        }
                        .clickable(role = Role.Button) { if (node is Folder) onToggleFolder(node.id) else onOpenNote(node.id) }
                        .heightIn(min = 52.dp)
                        .padding(start = (8 + depth.coerceAtMost(6) * 16).dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (node is Folder) {
                        Icon(
                            if (collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Default.KeyboardArrowDown,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Icon(
                            if (collapsed) Icons.Default.Folder else Icons.Default.FolderOpen,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    } else Spacer(Modifier.width(18.dp))
                    Text(
                        node.name,
                        modifier = Modifier.weight(1f).padding(vertical = 10.dp),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        style = if (node is Folder) MaterialTheme.typography.titleSmall else MaterialTheme.typography.bodyMedium,
                        color = if (active) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                    )
                    Box {
                        IconButton(onClick = { menu = true }, modifier = Modifier.size(48.dp)) {
                            Icon(
                                Icons.Default.MoreVert,
                                contentDescription = "Actions for ${node.name}",
                                modifier = Modifier.size(20.dp),
                                tint = if (active) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            if (node is Folder) {
                                DropdownMenuItem(text = { Text("New note here") }, leadingIcon = { Icon(Icons.Default.Add, null) }, onClick = { menu = false; onNewNote(node.id) })
                                DropdownMenuItem(text = { Text("New folder here") }, leadingIcon = { Icon(Icons.Default.CreateNewFolder, null) }, onClick = { menu = false; onNewFolder(node.id) })
                            }
                            DropdownMenuItem(text = { Text("Rename") }, leadingIcon = { Icon(Icons.Default.DriveFileRenameOutline, null) }, onClick = { menu = false; onRename(node.id) })
                            DropdownMenuItem(
                                text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                                leadingIcon = { Icon(Icons.Default.DeleteOutline, null, tint = MaterialTheme.colorScheme.error) },
                                onClick = { menu = false; onDelete(node.id) },
                            )
                        }
                    }
                }
            }
        }
    }
}
