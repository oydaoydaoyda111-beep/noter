package app.noter.ui

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.FormatBold
import androidx.compose.material.icons.filled.FormatItalic
import androidx.compose.material.icons.filled.FormatListNumbered
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.HorizontalRule
import androidx.compose.material.icons.filled.KeyboardHide
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Title
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
import androidx.compose.ui.text.TextStyle
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
fun EditorPane(note: Note, loadGeneration: Int, settings: Settings, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    // Reset only on note switch or reload from disk; resetting on every model change would move the cursor during fast typing.
    val state = remember(note.id, loadGeneration) { EditorState(TextFieldValue(note.markdown)) }
    val transformation = remember { MarkdownTransformation() }
    val focusManager = LocalFocusManager.current
    var focused by remember { mutableStateOf(false) }
    var linkDialog by remember { mutableStateOf(false) }
    var dismissedSlash by remember(note.id) { mutableStateOf<String?>(null) }
    val compact = settings.density == "compact"

    fun apply(next: TextFieldValue, step: Boolean = true) {
        val changed = next.text != state.value.text
        state.update(next, step)
        if (changed) onChange(next.text)
    }

    val slash = slashQuery(state.value)?.takeIf { focused && state.value.text != dismissedSlash }
    val matches = slash?.let(::slashMatches).orEmpty()

    Column(modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val viewport = maxHeight
            Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
                BasicTextField(
                    value = state.value,
                    onValueChange = { apply(handleTyping(state.value, it), step = false) },
                    modifier = Modifier.widthIn(max = settings.documentWidth.dp).fillMaxWidth().heightIn(min = viewport)
                        .padding(horizontal = 20.dp, vertical = if (compact) 10.dp else 20.dp)
                        .onFocusChanged { focused = it.isFocused },
                    textStyle = TextStyle(
                        color = NoterColors.editorText,
                        fontSize = settings.fontSize.sp,
                        lineHeight = if (compact) 1.45.em else 1.65.em,
                        fontFamily = fontFamily(settings.fontStyle),
                    ),
                    cursorBrush = SolidColor(NoterColors.caret),
                    visualTransformation = transformation,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        autoCorrectEnabled = settings.spellcheck,
                        keyboardType = KeyboardType.Text,
                    ),
                )
            }
        }
        if (focused && slash != null) {
            SlashMenu(matches, onPick = { apply(applySlash(state.value, it)) }, onDismiss = { dismissedSlash = state.value.text })
        }
        if (focused) {
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
            Text(
                "$words words · ${text.length} characters",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(vertical = 6.dp),
            )
        }
    }

    if (linkDialog) {
        val selected = state.value.text.substring(state.value.selection.min, state.value.selection.max)
        LinkDialog(selected, onDismiss = { linkDialog = false }) { label, url ->
            apply(insertLink(state.value, label, url))
            linkDialog = false
        }
    }
}

@Composable
private fun SlashMenu(matches: List<BlockStyle>, onPick: (BlockStyle) -> Unit, onDismiss: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("INSERT A BLOCK", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss) { Text("Close") }
            }
            if (matches.isEmpty()) {
                Text("No matching blocks. Try “heading” or “code”.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            }
            LazyColumn(Modifier.heightIn(max = 260.dp)) {
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
                    ToolButton(Icons.Default.Code, "Inline code") { onInline("`") }
                    ToolButton(Icons.Default.Link, "Add link", onClick = onLink)
                    ToolButton(Icons.AutoMirrored.Filled.FormatListBulleted, "Bullet list") { onBlock(BlockStyle.Bullets) }
                    ToolButton(Icons.Default.FormatListNumbered, "Numbered list") { onBlock(BlockStyle.Numbers) }
                    ToolButton(Icons.Default.FormatQuote, "Quote") { onBlock(BlockStyle.Quote) }
                    ToolButton(Icons.Default.DataObject, "Code block") { onBlock(BlockStyle.Code) }
                    ToolButton(Icons.Default.HorizontalRule, "Divider") { onBlock(BlockStyle.Divider) }
                    ToolButton(Icons.AutoMirrored.Filled.FormatIndentDecrease, "Outdent") { onIndent(true) }
                    ToolButton(Icons.AutoMirrored.Filled.FormatIndentIncrease, "Indent") { onIndent(false) }
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
