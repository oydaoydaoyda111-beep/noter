package app.noter.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import app.noter.ui.editor.joinBlocks
import app.noter.ui.editor.splitBlocks
import app.noter.ui.editor.styleMarkdown
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Decodes an image, halving its size until the longest side fits [maxSide] px so large photos do not exhaust memory. */
fun decodeImage(bytes: ByteArray, maxSide: Int = 2048): ImageBitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IllegalStateException("This file is not a supported image.")
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxSide) sample *= 2
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        ?: throw IllegalStateException("This file is not a supported image.")
    return bitmap.asImageBitmap()
}

@Composable
fun ImagePreview(link: String, load: suspend (String) -> ByteArray, onClose: () -> Unit, onEdit: () -> Unit) {
    var image by remember(link) { mutableStateOf<ImageBitmap?>(null) }
    var error by remember(link) { mutableStateOf<String?>(null) }
    LaunchedEffect(link) {
        try {
            val bytes = load(link)
            image = withContext(Dispatchers.Default) { decodeImage(bytes) }
        } catch (problem: Exception) {
            error = problem.message ?: "Could not open this image."
        }
    }
    val name = android.net.Uri.decode(link.substringAfterLast('/'))
    FullScreenDialog(onDismissRequest = onClose) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, contentDescription = "Close image") }
                    Text(name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    TextButton(onClick = onEdit) { Text("Edit line") }
                }
                Box(Modifier.weight(1f).fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    val loaded = image
                    when {
                        loaded != null -> Image(loaded, contentDescription = name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                        error != null -> Text(error.orEmpty(), color = MaterialTheme.colorScheme.error)
                        else -> CircularProgressIndicator()
                    }
                }
            }
        }
    }
}

/** Edits a table as a grid of cells; Done returns the rows (header first) and column alignment. */
@Composable
fun TableEditorDialog(rows: List<List<String>>, align: List<String>, onDismiss: () -> Unit, onEditText: () -> Unit, onDone: (List<List<String>>, List<String>) -> Unit) {
    val columns = rows.maxOf { it.size }.coerceAtLeast(1)
    val cells = remember(rows) { rows.map { row -> List(columns) { row.getOrElse(it) { "" } }.toMutableStateList() }.toMutableStateList() }
    val alignment = remember(align) { List(columns) { align.getOrElse(it) { "" } }.toMutableStateList() }
    var discard by remember { mutableStateOf(false) }
    fun changed() = cells.map { it.toList() } != rows.map { row -> List(columns) { row.getOrElse(it) { "" } } } || alignment.toList() != List(columns) { align.getOrElse(it) { "" } }
    fun close() { if (changed()) discard = true else onDismiss() }
    FullScreenDialog(onDismissRequest = { close() }) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { close() }) { Icon(Icons.Default.Close, contentDescription = "Close table") }
                    Text("Table", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    TextButton(onClick = onEditText) { Text("Edit as text") }
                    TextButton(onClick = { onDone(cells.map { it.toList() }, alignment.toList()) }) { Text("Done") }
                }
                Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { cells += List(cells.first().size) { "" }.toMutableStateList() }) { Text("Add row") }
                    OutlinedButton(onClick = { cells.forEach { it += "" }; alignment += "" }) { Text("Add column") }
                }
                Column(
                    Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    cells.forEachIndexed { rowIndex, row ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            row.forEachIndexed { column, value ->
                                OutlinedTextField(
                                    value = value, onValueChange = { row[column] = it.replace('\n', ' ') }, singleLine = true,
                                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (rowIndex == 0) FontWeight.SemiBold else FontWeight.Normal),
                                    placeholder = if (rowIndex == 0) { { Text("Column ${column + 1}") } } else null,
                                    modifier = Modifier.width(160.dp).semantics { contentDescription = "Row ${rowIndex + 1}, column ${column + 1}" },
                                )
                            }
                            if (rowIndex > 0) IconButton(onClick = { cells.removeAt(rowIndex) }) { Icon(Icons.Default.Delete, contentDescription = "Delete row ${rowIndex + 1}") }
                            else Spacer(Modifier.size(48.dp))
                        }
                    }
                    if (cells.first().size > 1) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        repeat(cells.first().size) { column ->
                            Box(Modifier.width(160.dp), contentAlignment = Alignment.Center) {
                                TextButton(onClick = { cells.forEach { it.removeAt(column) }; alignment.removeAt(column) }) { Text("Delete column") }
                            }
                        }
                    }
                }
            }
        }
    }
    if (discard) {
        MessageDialog("Discard table changes?", "The note keeps its current table.", "Discard", "Keep editing",
            onConfirm = { discard = false; onDismiss() }, onDismiss = { discard = false })
    }
}

/** Reorders a note's blocks by dragging their handles or with Move up/Move down; Done returns the rebuilt Markdown. */
@Composable
fun ReorderBlocksDialog(markdown: String, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    val original = remember(markdown) { splitBlocks(markdown) }
    val blocks = remember(markdown) { original.withIndex().toList().toMutableStateList() }
    var dragging by remember { mutableStateOf<Int?>(null) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    val listState = rememberLazyListState()

    fun move(from: Int, to: Int) {
        if (to !in blocks.indices || from == to) return
        blocks.add(to, blocks.removeAt(from))
    }

    FullScreenDialog(onDismissRequest = onDismiss) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "Cancel reordering") }
                    Text("Reorder blocks", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    TextButton(onClick = {
                        if (blocks.map { it.index } == original.indices.toList()) onDismiss()
                        else onDone(joinBlocks(blocks.map { it.value }, markdown.endsWith("\n")))
                    }) { Text("Done") }
                }
                Text(
                    "Drag a handle to move a block, or use the arrows.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 8.dp),
                )
                if (blocks.isEmpty()) Text("This note has no blocks yet.", modifier = Modifier.padding(16.dp))
                LazyColumn(state = listState, contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    itemsIndexed(blocks, key = { _, block -> block.index }) { position, block ->
                        val active = dragging == block.index
                        Row(
                            Modifier.fillMaxWidth()
                                .zIndex(if (active) 1f else 0f)
                                .graphicsLayer { translationY = if (active) dragOffset else 0f }
                                .background(
                                    if (active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
                                    RoundedCornerShape(12.dp),
                                ),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Default.DragHandle, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(8.dp).size(28.dp).pointerInput(block.index) {
                                    detectDragGestures(
                                        onDragStart = { dragging = block.index; dragOffset = 0f },
                                        onDragEnd = { dragging = null; dragOffset = 0f },
                                        onDragCancel = { dragging = null; dragOffset = 0f },
                                    ) { change, amount ->
                                        change.consume()
                                        dragOffset += amount.y
                                        // Swap with a neighbour once the dragged block crosses half of it.
                                        val index = blocks.indexOfFirst { it.index == block.index }
                                        val items = listState.layoutInfo.visibleItemsInfo
                                        val next = items.firstOrNull { it.index == index + 1 }
                                        val previous = items.firstOrNull { it.index == index - 1 }
                                        if (dragOffset > 0 && next != null && dragOffset > next.size / 2f) {
                                            move(index, index + 1); dragOffset -= next.size
                                        } else if (dragOffset < 0 && previous != null && -dragOffset > previous.size / 2f) {
                                            move(index, index - 1); dragOffset += previous.size
                                        }
                                    }
                                },
                            )
                            Text(
                                styleMarkdown(block.value), maxLines = 4, overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.weight(1f).padding(vertical = 10.dp),
                            )
                            Column {
                                IconButton(onClick = { move(position, position - 1) }, enabled = position > 0, modifier = Modifier.size(40.dp).semantics { contentDescription = "Move up" }) {
                                    Icon(Icons.Default.KeyboardArrowUp, contentDescription = null)
                                }
                                IconButton(onClick = { move(position, position + 1) }, enabled = position < blocks.lastIndex, modifier = Modifier.size(40.dp).semantics { contentDescription = "Move down" }) {
                                    Icon(Icons.Default.KeyboardArrowDown, contentDescription = null)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
