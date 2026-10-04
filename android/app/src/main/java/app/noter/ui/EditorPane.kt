package app.noter.ui

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.FormatIndentDecrease
import androidx.compose.material.icons.automirrored.filled.FormatIndentIncrease
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.automirrored.filled.Redo
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.FormatBold
import androidx.compose.material.icons.filled.FormatItalic
import androidx.compose.material.icons.filled.FormatListNumbered
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.HorizontalRule
import androidx.compose.material.icons.filled.KeyboardHide
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Title
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.PopupProperties
import app.noter.model.Note
import app.noter.model.Settings
import app.noter.model.DatabaseBlock
import app.noter.model.databaseBlocks
import app.noter.model.replaceDatabase
import app.noter.ui.database.DatabaseDialog
import app.noter.ui.editor.styleMarkdown
import app.noter.ui.editor.BlockStyle
import app.noter.ui.editor.MarkdownTransformation
import app.noter.ui.editor.applySlash
import app.noter.ui.editor.handleTyping
import app.noter.ui.editor.indentLines
import app.noter.ui.editor.insertLink
import app.noter.ui.editor.setBlockStyle
import app.noter.ui.editor.slashMatches
import app.noter.ui.editor.slashQuery
import app.noter.ui.editor.toggleInline

private fun fontFamily(style: String): FontFamily = when (style) {
    "serif" -> FontFamily.Serif
    "mono" -> FontFamily.Monospace
    else -> FontFamily.SansSerif
}

/** Editor text with undo/redo; typing is grouped into steps separated by short pauses. */
private class EditorState(initial: TextFieldValue) {
    var value by mutableStateOf(initial); private set
    private val undoStack = ArrayDeque<TextFieldValue>()
    private val redoStack = ArrayDeque<TextFieldValue>()
    private var lastStep = 0L
    var version by mutableIntStateOf(0); private set
    val canUndo get() = version >= 0 && undoStack.isNotEmpty()
    val canRedo get() = version >= 0 && redoStack.isNotEmpty()

    fun update(next: TextFieldValue, step: Boolean) {
        if (next.text != value.text) {
            val now = SystemClock.uptimeMillis()
            if (step || undoStack.isEmpty() || now - lastStep > 800) {
                undoStack.addLast(value)
                if (undoStack.size > 200) undoStack.removeFirst()
                lastStep = now
            }
            redoStack.clear()
            version++
        }
        value = next
    }

    fun undo(): Boolean {
        val previous = undoStack.removeLastOrNull() ?: return false
        redoStack.addLast(value)
        value = previous
        lastStep = 0
        version++
        return true
    }

    fun redo(): Boolean {
        val next = redoStack.removeLastOrNull() ?: return false
        undoStack.addLast(value)
        value = next
        version++
        return true
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
fun EditorPane(note: Note, loadGeneration: Int, settings: Settings, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    // Reset only on note switch or reload from disk; resetting on every model change would move the cursor during fast typing.
    val state = remember(note.id, loadGeneration) { EditorState(TextFieldValue(note.markdown)) }
    val transformation = remember { MarkdownTransformation() }
    val focusManager = LocalFocusManager.current
    var focused by remember { mutableStateOf(false) }
    var linkDialog by remember { mutableStateOf(false) }
    var dismissedSlash by remember(note.id) { mutableStateOf<String?>(null) }
    var sourceMode by remember(note.id) { mutableStateOf(false) }
    // Keep an open record draft when synced files reload; replacement checks the latest text.
    var openedDatabase by remember(note.id) { mutableStateOf<DatabaseBlock?>(null) }
    val databases = remember(state.value.text) { databaseBlocks(state.value.text) }
    val compact = settings.density == "compact"
    val imeVisible = WindowInsets.isImeVisible
    val scrollState = remember(note.id, loadGeneration) { ScrollState(0) }

    fun apply(next: TextFieldValue, step: Boolean = true) {
        val changed = next.text != state.value.text
        state.update(next, step)
        if (changed) onChange(next.text)
    }

    val slash = slashQuery(state.value)?.takeIf { focused && state.value.text != dismissedSlash }
    val matches = slash?.let(::slashMatches).orEmpty()

    BoxWithConstraints(modifier.fillMaxSize()) {
        val slashHeight = (maxHeight * 0.35f).coerceIn(48.dp, 220.dp)
        Column(Modifier.fillMaxSize()) {
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                val viewport = maxHeight
                Box(Modifier.fillMaxSize().verticalScroll(scrollState), contentAlignment = Alignment.TopCenter) {
                    Column(Modifier.widthIn(max = settings.documentWidth.dp).fillMaxWidth().padding(horizontal = 24.dp)) {
                        if (!imeVisible) {
                            Text(
                                note.name,
                                style = MaterialTheme.typography.headlineMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.padding(top = if (compact) 20.dp else 32.dp, bottom = 20.dp),
                            )
                        }
                        if (databases.isNotEmpty()) {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                TextButton(onClick = { focusManager.clearFocus(); sourceMode = !sourceMode }, modifier = Modifier.weight(1f)) {
                                    Text(if (sourceMode) "Show databases" else "Edit Markdown")
                                }
                                ToolButton(Icons.AutoMirrored.Filled.Undo, "Undo", state.canUndo) { if (state.undo()) onChange(state.value.text) }
                                ToolButton(Icons.AutoMirrored.Filled.Redo, "Redo", state.canRedo) { if (state.redo()) onChange(state.value.text) }
                            }
                        }
                        if (databases.isNotEmpty() && !sourceMode) {
                            DatabasePreview(state.value.text, databases, settings) { block ->
                                focusManager.clearFocus()
                                openedDatabase = databaseBlocks(state.value.text).firstOrNull { it.index == block.index }
                            }
                        } else {
                            BasicTextField(
                                value = state.value,
                                onValueChange = { apply(handleTyping(state.value, it), step = false) },
                                modifier = Modifier.fillMaxWidth().heightIn(min = (viewport - if (imeVisible) 0.dp else 100.dp).coerceAtLeast(80.dp))
                                    .padding(top = if (imeVisible) 12.dp else 0.dp, bottom = 24.dp)
                                    .semantics { contentDescription = "Note content" }
                                    .onFocusChanged { focused = it.isFocused },
                                textStyle = TextStyle(
                                    color = NoterColors.editorText,
                                    fontSize = settings.fontSize.toFloat().sp,
                                    lineHeight = if (compact) 1.45.em else 1.65.em,
                                    fontFamily = fontFamily(settings.fontStyle),
                                ),
                                cursorBrush = SolidColor(NoterColors.caret),
                                visualTransformation = transformation,
                                decorationBox = { innerTextField ->
                                    Box {
                                        if (state.value.text.isEmpty()) {
                                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                                Text("Start writing…", style = TextStyle(fontSize = settings.fontSize.toFloat().sp, fontFamily = fontFamily(settings.fontStyle)), color = MaterialTheme.colorScheme.onSurfaceVariant)
                                                Text("Type / for headings, lists, and more", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                            }
                                        }
                                        innerTextField()
                                    }
                                },
                                keyboardOptions = KeyboardOptions(
                                    capitalization = KeyboardCapitalization.Sentences,
                                    autoCorrectEnabled = settings.spellcheck,
                                    keyboardType = KeyboardType.Text,
                                ),
                            )
                        }
                    }
                }
            }
            if (focused && (sourceMode || databases.isEmpty()) && slash != null) {
                SlashMenu(matches, maxHeight = slashHeight, onPick = { apply(applySlash(state.value, it)) }, onDismiss = { dismissedSlash = state.value.text })
            } else if (focused && (sourceMode || databases.isEmpty())) {
                FormatToolbar(
                    canUndo = state.canUndo,
                    canRedo = state.canRedo,
                    onUndo = { if (state.undo()) onChange(state.value.text) },
                    onRedo = { if (state.redo()) onChange(state.value.text) },
                    onBlock = { apply(setBlockStyle(state.value, it)) },
                    onInline = { apply(toggleInline(state.value, it)) },
                    onLink = { linkDialog = true },
                    onIndent = { apply(indentLines(state.value, outdent = it)) },
                    onHideKeyboard = { focusManager.clearFocus() },
                )
            } else if (settings.showNoteStats) {
                val text = state.value.text
                val words = remember(text) { text.split(Regex("\\s+")).count { it.isNotEmpty() } }
                Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 10.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("$words words", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("${text.length} characters", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }

    if (linkDialog) {
        val selected = state.value.text.substring(state.value.selection.min, state.value.selection.max)
        LinkDialog(selected, onDismiss = { linkDialog = false }) { label, url ->
            apply(insertLink(state.value, label, url))
            linkDialog = false
        }
    }
    openedDatabase?.let { original ->
        DatabaseDialog(original.database, onChange = { database ->
            val markdown = replaceDatabase(state.value.text, original, database)
            val selection = state.value.selection
            apply(state.value.copy(text = markdown, selection = TextRange(selection.start.coerceAtMost(markdown.length), selection.end.coerceAtMost(markdown.length)), composition = null))
            openedDatabase = databaseBlocks(markdown).first { it.index == original.index }
        }, onClose = { openedDatabase = null })
    }
}

@Composable
private fun DatabasePreview(markdown: String, blocks: List<DatabaseBlock>, settings: Settings, onOpen: (DatabaseBlock) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        val textStyle = TextStyle(color = NoterColors.editorText, fontSize = settings.fontSize.toFloat().sp, lineHeight = 1.65.em, fontFamily = fontFamily(settings.fontStyle))
        var end = 0
        blocks.forEach { block ->
            val before = markdown.substring(end, block.fenceStart).trim()
            if (before.isNotEmpty()) Text(styleMarkdown(before), style = textStyle)
            Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(Icons.Default.TableChart, null, tint = MaterialTheme.colorScheme.primary)
                        Column {
                            Text(block.database.title.ifBlank { "Untitled database" }, style = MaterialTheme.typography.titleLarge)
                            Text("${block.database.rows.size} records · ${block.database.columns.size} properties", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    block.database.visibleRows().take(3).forEach { Text(block.database.rowTitle(it), style = MaterialTheme.typography.bodyMedium) }
                    OutlinedButton(onClick = { onOpen(block) }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Open database ${block.database.title}" }) { Text("Open database") }
                }
            }
            end = block.fenceEnd
        }
        val after = markdown.substring(end).trim()
        if (after.isNotEmpty()) Text(styleMarkdown(after), style = textStyle)
    }
}

@Composable
private fun SlashMenu(matches: List<BlockStyle>, maxHeight: androidx.compose.ui.unit.Dp, onPick: (BlockStyle) -> Unit, onDismiss: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp),
        modifier = Modifier.fillMaxWidth().heightIn(max = maxHeight),
    ) {
        if (maxHeight < 112.dp) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                LazyRow(Modifier.weight(1f)) {
                    if (matches.isEmpty()) item { Text("No matching blocks", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp)) }
                    items(matches) { style ->
                        TextButton(onClick = { onPick(style) }, modifier = Modifier.heightIn(min = 48.dp)) { Text(style.label) }
                    }
                }
                IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "Close block menu") }
            }
        } else {
            Column {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("INSERT A BLOCK", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    TextButton(onClick = onDismiss) { Text("Close") }
                }
                if (matches.isEmpty()) {
                    Text("No matching blocks. Try “heading” or “code”.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                }
                LazyColumn(Modifier.weight(1f, fill = false)) {
                    items(matches) { style ->
                        Row(
                            Modifier.fillMaxWidth().clickable { onPick(style) }.padding(horizontal = 16.dp, vertical = 9.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            Box(
                                Modifier.size(34.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(8.dp)),
                                contentAlignment = Alignment.Center,
                            ) { Text(style.badge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold, fontSize = 13.sp) }
                            Column {
                                Text(style.label, style = MaterialTheme.typography.bodyLarge)
                                Text(style.hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ToolButton(icon: ImageVector, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled) { Icon(icon, contentDescription = label) }
}

@Composable
private fun FormatToolbar(
    canUndo: Boolean,
    canRedo: Boolean,
    onUndo: () -> Unit,
    onRedo: () -> Unit,
    onBlock: (BlockStyle) -> Unit,
    onInline: (String) -> Unit,
    onLink: () -> Unit,
    onIndent: (outdent: Boolean) -> Unit,
    onHideKeyboard: () -> Unit,
) {
    var headings by remember { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                    ToolButton(Icons.AutoMirrored.Filled.Undo, "Undo", canUndo, onUndo)
                    ToolButton(Icons.AutoMirrored.Filled.Redo, "Redo", canRedo, onRedo)
                    Box {
                        ToolButton(Icons.Default.Title, "Text style") { headings = true }
                        DropdownMenu(expanded = headings, onDismissRequest = { headings = false }, properties = PopupProperties(focusable = false)) {
                            listOf(BlockStyle.Text, BlockStyle.H1, BlockStyle.H2, BlockStyle.H3).forEach { style ->
                                DropdownMenuItem(
                                    text = { Text(style.label) },
                                    leadingIcon = { Text(style.badge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold) },
                                    onClick = { headings = false; onBlock(style) },
                                )
                            }
                        }
                    }
                    ToolButton(Icons.Default.FormatBold, "Bold") { onInline("**") }
                    ToolButton(Icons.Default.FormatItalic, "Italic") { onInline("*") }
                    ToolButton(Icons.AutoMirrored.Filled.FormatListBulleted, "Bullet list") { onBlock(BlockStyle.Bullets) }
                }
                Box {
                    ToolButton(Icons.Default.MoreHoriz, "More formatting") { more = true }
                    DropdownMenu(expanded = more, onDismissRequest = { more = false }, properties = PopupProperties(focusable = false)) {
                        DropdownMenuItem(text = { Text("Add link") }, leadingIcon = { Icon(Icons.Default.Link, contentDescription = null) }, onClick = { more = false; onLink() })
                        DropdownMenuItem(text = { Text("Inline code") }, leadingIcon = { Icon(Icons.Default.Code, contentDescription = null) }, onClick = { more = false; onInline("`") })
                        listOf(BlockStyle.Numbers to Icons.Default.FormatListNumbered, BlockStyle.Quote to Icons.Default.FormatQuote, BlockStyle.Code to Icons.Default.DataObject, BlockStyle.Divider to Icons.Default.HorizontalRule).forEach { (style, icon) ->
                            DropdownMenuItem(text = { Text(style.label) }, leadingIcon = { Icon(icon, contentDescription = null) }, onClick = { more = false; onBlock(style) })
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        DropdownMenuItem(text = { Text("Indent") }, leadingIcon = { Icon(Icons.AutoMirrored.Filled.FormatIndentIncrease, contentDescription = null) }, onClick = { more = false; onIndent(false) })
                        DropdownMenuItem(text = { Text("Outdent") }, leadingIcon = { Icon(Icons.AutoMirrored.Filled.FormatIndentDecrease, contentDescription = null) }, onClick = { more = false; onIndent(true) })
                    }
                }
                Box(Modifier.width(1.dp).heightIn(min = 24.dp).background(MaterialTheme.colorScheme.outlineVariant))
                ToolButton(Icons.Default.KeyboardHide, "Hide keyboard", onClick = onHideKeyboard)
            }
        }
    }
}

private fun safeUrl(value: String): String? {
    val trimmed = value.trim()
    if (trimmed.isEmpty()) return null
    val withScheme = if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(trimmed)) trimmed else "https://$trimmed"
    val uri = runCatching { java.net.URI(withScheme) }.getOrNull() ?: return null
    return withScheme.takeIf { uri.scheme?.lowercase() in setOf("http", "https", "mailto") }
}

@Composable
private fun LinkDialog(selected: String, onDismiss: () -> Unit, onInsert: (String, String) -> Unit) {
    var label by remember { mutableStateOf(selected) }
    var url by remember { mutableStateOf("") }
    val valid = safeUrl(url)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add link") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = label, onValueChange = { label = it }, label = { Text("Text") }, singleLine = true)
                OutlinedTextField(
                    value = url, onValueChange = { url = it }, label = { Text("Link") }, singleLine = true,
                    placeholder = { Text("https://") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    isError = url.isNotBlank() && valid == null,
                    supportingText = if (url.isNotBlank() && valid == null) {
                        { Text("Use an http, https, or mailto link.") }
                    } else null,
                )
            }
        },
        confirmButton = { TextButton(onClick = { valid?.let { onInsert(label.trim(), it) } }, enabled = valid != null) { Text("Insert") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
