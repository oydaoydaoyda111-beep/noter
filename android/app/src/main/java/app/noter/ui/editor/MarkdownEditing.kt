package app.noter.ui.editor

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue

enum class BlockStyle(val label: String, val hint: String, val badge: String, val keywords: String) {
    Text("Text", "A simple paragraph", "T", "paragraph plain text"),
    H1("Heading 1", "A large section heading", "H1", "h1 title heading"),
    H2("Heading 2", "A medium section heading", "H2", "h2 subtitle heading"),
    H3("Heading 3", "A small section heading", "H3", "h3 heading"),
    Bullets("Bullet list", "Keep a few ideas together", "•", "ul unordered bullets list"),
    Numbers("Numbered list", "Steps in a natural order", "1.", "ol ordered numbered list"),
    Task("Task list", "Track things to do", "☐", "todo task checkbox check list"),
    Quote("Quote", "Give a thought some emphasis", "❝", "blockquote quote"),
    Toggle("Toggle", "Hide details under a title", "▸", "toggle collapse fold details callout"),
    Table("Table", "Rows and columns of text", "▦", "table grid columns rows"),
    Image("Image", "Insert a picture from your gallery", "▣", "image picture photo attachment"),
    Code("Code block", "Code with syntax highlighting", "<>", "pre code snippet"),
    Divider("Divider", "A little space between ideas", "—", "hr divider horizontal rule separator"),
}

private val PREFIX = Regex("^(\\s*)(#{1,6}\\s+|[-+*]\\s+|\\d+[.)]\\s+|>\\s?)?")
private val LIST_ITEM = Regex("^(\\s*)([-+*]|(\\d+)([.)]))(\\s+)(.*)$")
private val QUOTE_LINE = Regex("^(\\s*>\\s?)(.*)$")
private val FENCE_LINE = Regex("^\\s{0,3}(`{3,}|~{3,}).*$")
private val HEADING_PREFIX = Regex("^\\s{0,3}#{1,6}\\s+")
private val TASK_LINE = Regex("^(\\s*)([-+*])(\\s+)\\[([ xX])\\](\\s+|$)")
private val TASK_SHORTCUT = Regex("^(\\s*)[-+*](?:\\[([ xX]?)\\]?| \\[([ xX]?)\\]) $")
private val TOGGLE_PREFIX = Regex("^\\s*>\\s?\\[!toggle\\][+-]\\s*", RegexOption.IGNORE_CASE)
private val IMAGE_LINE = Regex("^\\s*!\\[[^\\]\\n]*\\]\\(([^)\\s]+)\\)\\s*$")
private val TABLE_LINE = Regex("^\\s*\\|")
private val RULE_LINE = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
private val SLASH = Regex("^/([^\\n/]{0,30})$")

private fun lineStart(text: String, index: Int) = text.lastIndexOf('\n', (index - 1).coerceAtLeast(-1)).let { if (index == 0) 0 else it + 1 }
private fun lineEnd(text: String, index: Int) = text.indexOf('\n', index).let { if (it < 0) text.length else it }

private fun styleOf(line: String): BlockStyle {
    if (TASK_LINE.find(line) != null) return BlockStyle.Task
    val prefix = PREFIX.find(line)?.groupValues?.get(2).orEmpty().trim()
    return when {
        prefix.startsWith("#") -> when (prefix.length) { 1 -> BlockStyle.H1; 2 -> BlockStyle.H2; else -> BlockStyle.H3 }
        prefix == "-" || prefix == "+" || prefix == "*" -> BlockStyle.Bullets
        prefix.firstOrNull()?.isDigit() == true -> BlockStyle.Numbers
        prefix == ">" -> BlockStyle.Quote
        else -> BlockStyle.Text
    }
}

private fun insideFence(text: String, index: Int): Boolean {
    var open = false
    var start = 0
    while (start < index) {
        val end = lineEnd(text, start)
        if (end >= index) break
        if (FENCE_LINE.matches(text.substring(start, end))) open = !open
        start = end + 1
    }
    return open
}

private fun replace(value: TextFieldValue, start: Int, end: Int, insert: String, selection: TextRange) =
    TextFieldValue(value.text.substring(0, start) + insert + value.text.substring(end), selection)

/** Applies a heading, list, or quote prefix to every selected line; applying the current style again turns it back into text. */
fun setBlockStyle(value: TextFieldValue, style: BlockStyle): TextFieldValue {
    if (style == BlockStyle.Code) return insertCodeBlock(value)
    if (style == BlockStyle.Divider) return insertDivider(value)
    if (style == BlockStyle.Table) return insertBlock(value, "|  |  |\n| --- | --- |\n|  |  |", 2)
    if (style == BlockStyle.Toggle) return insertBlock(value, "> [!toggle]+ \n> ", 13)
    if (style == BlockStyle.Image) return value
    val text = value.text
    val start = lineStart(text, value.selection.min)
    val end = lineEnd(text, value.selection.max)
    val lines = text.substring(start, end).split('\n')
    val target = if (style != BlockStyle.Text && lines.all { styleOf(it) == style }) BlockStyle.Text else style
    var number = 0
    var cursorShift = 0
    val updated = lines.mapIndexed { index, line ->
        val match = PREFIX.find(line)!!
        val indent = if (target == BlockStyle.Bullets || target == BlockStyle.Numbers || target == BlockStyle.Task) match.groupValues[1] else ""
        val content = TASK_LINE.find(line)?.let { line.substring(it.value.length) } ?: line.substring(match.range.last + 1)
        val prefix = when (target) {
            BlockStyle.H1 -> "# "
            BlockStyle.H2 -> "## "
            BlockStyle.H3 -> "### "
            BlockStyle.Bullets -> "- "
            BlockStyle.Task -> "- [ ] "
            BlockStyle.Numbers -> "${++number}. "
            BlockStyle.Quote -> "> "
            else -> ""
        }
        val next = indent + prefix + content
        if (index == 0) cursorShift = next.length - line.length
        next
    }.joinToString("\n")
    val selection = if (value.selection.collapsed && lines.size == 1) {
        TextRange((value.selection.start + cursorShift).coerceIn(start, start + updated.length))
    } else TextRange(start, start + updated.length)
    return replace(value, start, end, updated, selection)
}

/** Puts [block] on the caret's line when it is blank, otherwise after it as a new paragraph; the caret goes [caret] characters into the block. */
private fun insertBlock(value: TextFieldValue, block: String, caret: Int): TextFieldValue {
    val text = value.text
    val start = lineStart(text, value.selection.min)
    val end = lineEnd(text, value.selection.max)
    if (text.substring(start, end).isBlank()) return replace(value, start, end, block, TextRange(start + caret))
    return replace(value, end, end, "\n\n$block", TextRange(end + 2 + caret))
}

/** Inserts an image line for [link]; the caret moves to the line after it. */
fun insertImage(value: TextFieldValue, link: String): TextFieldValue {
    val inserted = insertBlock(value, "![](${link.replace(" ", "%20")})\n", 0)
    val lineEnd = lineEnd(inserted.text, inserted.selection.start)
    return inserted.copy(selection = TextRange((lineEnd + 1).coerceAtMost(inserted.text.length)))
}

/** The link and closing-parenthesis offset of the image line containing [offset], or null when it is not one. */
fun imageAt(text: String, offset: Int): Pair<String, Int>? {
    val start = lineStart(text, offset.coerceIn(0, text.length))
    val line = text.substring(start, lineEnd(text, start))
    val match = IMAGE_LINE.matchEntire(line) ?: return null
    if (insideFence(text, start)) return null
    return match.groupValues[1] to start + line.lastIndexOf(')')
}

/** Splits a note into movable blocks: code fences, quotes/toggles, tables, list items with their nested lines, headings, rules, images, and paragraphs. */
fun splitBlocks(text: String): List<String> {
    val lines = text.split('\n')
    val blocks = ArrayList<String>()
    var index = 0
    fun starts(line: String) = line.isBlank() || FENCE_LINE.matches(line) || QUOTE_LINE.matches(line) || TABLE_LINE.containsMatchIn(line) ||
        LIST_ITEM.matches(line) || HEADING_PREFIX.containsMatchIn(line) || RULE_LINE.matches(line) || IMAGE_LINE.matches(line)
    while (index < lines.size) {
        val line = lines[index]
        if (line.isBlank()) { index++; continue }
        val from = index++
        when {
            FENCE_LINE.matches(line) -> {
                val fence = line.trimStart().takeWhile { it == line.trimStart()[0] }
                while (index < lines.size && !(lines[index].trimStart().startsWith(fence) && lines[index].trim().all { it == fence[0] })) index++
                if (index < lines.size) index++
            }
            QUOTE_LINE.matches(line) -> while (index < lines.size && QUOTE_LINE.matches(lines[index])) index++
            TABLE_LINE.containsMatchIn(line) -> while (index < lines.size && TABLE_LINE.containsMatchIn(lines[index])) index++
            LIST_ITEM.matches(line) -> {
                val indent = line.takeWhile { it == ' ' || it == '\t' }.length
                while (index < lines.size && lines[index].isNotBlank() && lines[index].takeWhile { it == ' ' || it == '\t' }.length > indent) index++
            }
            HEADING_PREFIX.containsMatchIn(line) || RULE_LINE.matches(line) || IMAGE_LINE.matches(line) -> Unit
            else -> while (index < lines.size && !starts(lines[index])) index++
        }
        blocks += lines.subList(from, index).joinToString("\n")
    }
    return blocks
}

/** Joins blocks back into Markdown: adjacent list items stay one list, everything else is separated by a blank line. */
fun joinBlocks(blocks: List<String>, trailingNewline: Boolean): String {
    val builder = StringBuilder()
    blocks.forEachIndexed { index, block ->
        if (index > 0) builder.append(if (LIST_ITEM.matches(blocks[index - 1].substringBefore('\n')) && LIST_ITEM.matches(block.substringBefore('\n'))) "\n" else "\n\n")
        builder.append(block)
    }
    if (trailingNewline && builder.isNotEmpty()) builder.append('\n')
    return builder.toString()
}

/** Wraps the selection in an inline marker such as `**`, or removes it when already wrapped. */
fun toggleInline(value: TextFieldValue, marker: String): TextFieldValue {
    val text = value.text
    val s = value.selection.min
    val e = value.selection.max
    val m = marker.length
    val wrappedOutside = s >= m && e + m <= text.length && text.substring(s - m, s) == marker && text.substring(e, e + m) == marker
    if (wrappedOutside) {
        return TextFieldValue(text.substring(0, s - m) + text.substring(s, e) + text.substring(e + m), TextRange(s - m, e - m))
    }
    val selected = text.substring(s, e)
    if (selected.length >= 2 * m && selected.startsWith(marker) && selected.endsWith(marker)) {
        return replace(value, s, e, selected.substring(m, selected.length - m), TextRange(s, e - 2 * m))
    }
    return replace(value, s, e, marker + selected + marker, if (s == e) TextRange(s + m) else TextRange(s + m, e + m))
}

fun insertLink(value: TextFieldValue, label: String, url: String): TextFieldValue {
    val link = "[${label.ifBlank { url }.replace("]", "\\]")}](${url.replace("(", "%28").replace(")", "%29")})"
    return replace(value, value.selection.min, value.selection.max, link, TextRange(value.selection.min + link.length))
}

fun insertCodeBlock(value: TextFieldValue): TextFieldValue {
    val text = value.text
    val start = lineStart(text, value.selection.min)
    val end = lineEnd(text, value.selection.max)
    val body = text.substring(start, end)
    val trailing = if (end == text.length) "\n" else ""
    val block = "```\n$body\n```$trailing"
    return replace(value, start, end, block, TextRange(start + 4 + body.length))
}

fun insertDivider(value: TextFieldValue): TextFieldValue {
    val text = value.text
    val start = lineStart(text, value.selection.min)
    val end = lineEnd(text, value.selection.max)
    val trailing = if (end == text.length) "\n" else ""
    return if (text.substring(start, end).isBlank()) {
        replace(value, start, end, "---\n$trailing", TextRange(start + 4))
    } else {
        replace(value, end, end, "\n\n---\n$trailing", TextRange(end + 6))
    }
}

/** Indents or outdents the selected lines by two spaces, which nests list items. */
fun indentLines(value: TextFieldValue, outdent: Boolean): TextFieldValue {
    val text = value.text
    val start = lineStart(text, value.selection.min)
    val end = lineEnd(text, value.selection.max)
    val lines = text.substring(start, end).split('\n')
    var firstShift = 0
    val updated = lines.mapIndexed { index, line ->
        val next = if (outdent) line.removePrefix(if (line.startsWith("  ")) "  " else if (line.startsWith(" ")) " " else "") else "  $line"
        if (index == 0) firstShift = next.length - line.length
        next
    }.joinToString("\n")
    val selection = if (value.selection.collapsed) TextRange((value.selection.start + firstShift).coerceAtLeast(start))
    else TextRange(start, start + updated.length)
    return replace(value, start, end, updated, selection)
}

/** Length of the heading, list, or quote marker that starts [line], or null when the line is plain text. */
private fun blockPrefix(line: String): Int? {
    HEADING_PREFIX.find(line)?.let { return it.value.length }
    TOGGLE_PREFIX.find(line)?.let { return it.value.length }
    LIST_ITEM.matchEntire(line)?.let { return it.groupValues[1].length + it.groupValues[2].length + it.groupValues[5].length }
    return QUOTE_LINE.matchEntire(line)?.groupValues?.get(1)?.length
}

// Heading marks are drawn hidden, so a caret among them would look like it is before the title yet break the heading when typing.
private fun keepCaretOutOfHeadingMarks(old: TextFieldValue, new: TextFieldValue): TextFieldValue {
    if (!new.selection.collapsed) return new
    val text = new.text
    val cursor = new.selection.start
    val start = lineStart(text, cursor)
    val line = text.substring(start, lineEnd(text, cursor))
    val prefixEnd = start + ((HEADING_PREFIX.find(line) ?: TASK_LINE.find(line) ?: TOGGLE_PREFIX.find(line))?.value?.length ?: return new)
    if (cursor >= prefixEnd || insideFence(text, start)) return new
    val movingLeft = old.selection.collapsed && old.selection.start == prefixEnd && start > 0
    return new.copy(selection = TextRange(if (movingLeft) start - 1 else prefixEnd))
}

/** Backspace at the start of a heading, list item, or quote turns it back into text, or outdents a nested item. */
private fun removeBlockPrefix(old: TextFieldValue, new: TextFieldValue): TextFieldValue? {
    val cursor = old.selection.start
    if (!old.selection.collapsed || cursor == 0 || new.selection != TextRange(cursor - 1) || new.text != old.text.removeRange(cursor - 1, cursor)) return null
    val text = old.text
    val start = lineStart(text, cursor)
    val line = text.substring(start, lineEnd(text, cursor))
    TASK_LINE.find(line)?.let { task ->
        // A task keeps its bullet and loses only the checkbox, as on desktop.
        if (cursor != start + task.value.length || insideFence(text, start)) return null
        val box = start + task.groupValues[1].length + task.groupValues[2].length + task.groupValues[3].length
        return TextFieldValue(text.removeRange(box, cursor), TextRange(box))
    }
    val prefix = blockPrefix(line) ?: return null
    if (cursor != start + prefix || insideFence(text, start)) return null
    val indent = LIST_ITEM.matchEntire(line)?.groupValues?.get(1).orEmpty()
    if (indent.isNotEmpty()) {
        val removed = if (indent.startsWith("  ")) 2 else 1
        return TextFieldValue(text.removeRange(start, start + removed), TextRange(cursor - removed))
    }
    return TextFieldValue(text.removeRange(start, start + prefix), TextRange(start))
}

/**
 * Markdown typing rules: keeps the caret out of hidden heading marks, removes block formatting on Backspace,
 * closes a new code fence, keeps a heading intact on Enter at its start, and continues lists and quotes
 * (Enter on an empty item ends the list).
 */
fun handleTyping(old: TextFieldValue, new: TextFieldValue): TextFieldValue {
    if (new.text == old.text) return keepCaretOutOfHeadingMarks(old, new)
    removeBlockPrefix(old, new)?.let { return it }
    val cursor = old.selection.start
    if (!old.selection.collapsed || new.text.length != old.text.length + 1 || new.selection != TextRange(cursor + 1)) return new
    if (new.text.substring(0, cursor) != old.text.substring(0, cursor)) return new
    if (new.text[cursor] == ' ') {
        // `-[` then space starts a task, like `- ` starts a bullet.
        val lineAt = lineStart(new.text, cursor)
        val shortcut = TASK_SHORTCUT.matchEntire(new.text.substring(lineAt, cursor + 1))
        if (shortcut == null || insideFence(new.text, lineAt)) return new
        val checked = (shortcut.groupValues[2] + shortcut.groupValues[3]).any { it == 'x' || it == 'X' }
        val task = shortcut.groupValues[1] + "- [" + (if (checked) "x" else " ") + "] "
        return TextFieldValue(new.text.substring(0, lineAt) + task + new.text.substring(cursor + 1), TextRange(lineAt + task.length))
    }
    if (new.text[cursor] != '\n') return new
    val text = old.text
    val start = lineStart(text, cursor)
    val line = text.substring(start, lineEnd(text, cursor))
    if (insideFence(text, start)) {
        val indent = line.takeWhile { it == ' ' || it == '\t' }
        if (indent.isEmpty() || cursor - start < indent.length) return new
        return TextFieldValue(new.text.substring(0, cursor + 1) + indent + new.text.substring(cursor + 1), TextRange(cursor + 1 + indent.length))
    }
    FENCE_LINE.matchEntire(line)?.let { fence ->
        val unclosed = text.split('\n').count { FENCE_LINE.matches(it) } % 2 == 1
        if (!unclosed || cursor != start + line.length) return new
        val close = "\n" + line.takeWhile { it == ' ' } + fence.groupValues[1]
        return TextFieldValue(new.text.substring(0, cursor + 1) + close + new.text.substring(cursor + 1), TextRange(cursor + 1))
    }
    HEADING_PREFIX.find(line)?.let { heading ->
        if (cursor != start + heading.value.length || line.length == heading.value.length) return new
        return TextFieldValue(text.substring(0, start) + "\n" + text.substring(start), TextRange(cursor + 1))
    }
    val list = LIST_ITEM.matchEntire(line)
    val quote = if (list == null) QUOTE_LINE.matchEntire(line) else null
    val task = TASK_LINE.find(line)
    val prefixLength = task?.value?.length ?: list?.let { it.groupValues[1].length + it.groupValues[2].length + it.groupValues[5].length } ?: quote?.groupValues?.get(1)?.length ?: return new
    if (cursor - start < prefixLength) return new
    val content = if (task != null) line.substring(prefixLength) else list?.groupValues?.get(6) ?: quote!!.groupValues[2]
    if (content.isBlank()) {
        return TextFieldValue(text.substring(0, start) + text.substring(start + line.length), TextRange(start))
    }
    val continuation = if (task != null) {
        task.groupValues[1] + task.groupValues[2] + " [ ] "
    } else if (list != null) {
        val number = list.groupValues[3].toLongOrNull()
        list.groupValues[1] + (if (number != null) "${number + 1}${list.groupValues[4]}" else list.groupValues[2]) + " "
    } else quote!!.groupValues[1]
    return TextFieldValue(new.text.substring(0, cursor + 1) + continuation + new.text.substring(cursor + 1), TextRange(cursor + 1 + continuation.length))
}

/** Offset of the `[` of the task checkbox on the line containing [offset], or null when that line is not a task. */
fun taskBoxAt(text: String, offset: Int): Int? {
    val start = lineStart(text, offset.coerceIn(0, text.length))
    val task = TASK_LINE.find(text.substring(start, lineEnd(text, start))) ?: return null
    if (insideFence(text, start)) return null
    return start + task.groupValues[1].length + task.groupValues[2].length + task.groupValues[3].length
}

/** Checks or unchecks the task whose checkbox starts at [box]; the caret stays where it was. */
fun toggleTask(value: TextFieldValue, box: Int): TextFieldValue {
    val mark = if (value.text[box + 1] == ' ') "x" else " "
    return TextFieldValue(value.text.substring(0, box + 1) + mark + value.text.substring(box + 2), value.selection)
}

/** The text typed after `/` when the cursor's line is a slash command, otherwise null. */
fun slashQuery(value: TextFieldValue): String? {
    if (!value.selection.collapsed) return null
    val text = value.text
    val cursor = value.selection.start
    val start = lineStart(text, cursor)
    val end = lineEnd(text, cursor)
    if (cursor != end || insideFence(text, start)) return null
    return SLASH.matchEntire(text.substring(start, end))?.groupValues?.get(1)?.trim()?.lowercase()
}

fun slashMatches(query: String): List<BlockStyle> =
    BlockStyle.entries.filter { "${it.label} ${it.keywords}".lowercase().contains(query) }

fun applySlash(value: TextFieldValue, style: BlockStyle): TextFieldValue {
    val text = value.text
    val start = lineStart(text, value.selection.start)
    val cleared = TextFieldValue(text.substring(0, start) + text.substring(lineEnd(text, value.selection.start)), TextRange(start))
    return setBlockStyle(cleared, style)
}
