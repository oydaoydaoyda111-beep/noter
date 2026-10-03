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
    Quote("Quote", "Give a thought some emphasis", "❝", "blockquote quote"),
    Code("Code block", "Code with syntax highlighting", "<>", "pre code snippet"),
    Divider("Divider", "A little space between ideas", "—", "hr divider horizontal rule separator"),
}

private val PREFIX = Regex("^(\\s*)(#{1,6}\\s+|[-+*]\\s+|\\d+[.)]\\s+|>\\s?)?")
private val LIST_ITEM = Regex("^(\\s*)([-+*]|(\\d+)([.)]))(\\s+)(.*)$")
private val QUOTE_LINE = Regex("^(\\s*>\\s?)(.*)$")
private val FENCE_LINE = Regex("^\\s{0,3}(`{3,}|~{3,}).*$")
private val SLASH = Regex("^/([^\\n/]{0,30})$")

private fun lineStart(text: String, index: Int) = text.lastIndexOf('\n', (index - 1).coerceAtLeast(-1)).let { if (index == 0) 0 else it + 1 }
private fun lineEnd(text: String, index: Int) = text.indexOf('\n', index).let { if (it < 0) text.length else it }

private fun styleOf(line: String): BlockStyle {
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
    val text = value.text
    val start = lineStart(text, value.selection.min)
    val end = lineEnd(text, value.selection.max)
    val lines = text.substring(start, end).split('\n')
    val target = if (style != BlockStyle.Text && lines.all { styleOf(it) == style }) BlockStyle.Text else style
    var number = 0
    var cursorShift = 0
    val updated = lines.mapIndexed { index, line ->
        val match = PREFIX.find(line)!!
        val indent = if (target == BlockStyle.Bullets || target == BlockStyle.Numbers) match.groupValues[1] else ""
        val content = line.substring(match.range.last + 1)
        val prefix = when (target) {
            BlockStyle.H1 -> "# "
            BlockStyle.H2 -> "## "
            BlockStyle.H3 -> "### "
            BlockStyle.Bullets -> "- "
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

/** Continues lists and quotes when Enter is pressed; Enter on an empty item ends the list. */
fun handleTyping(old: TextFieldValue, new: TextFieldValue): TextFieldValue {
    val cursor = old.selection.start
    if (!old.selection.collapsed || new.text.length != old.text.length + 1 || new.selection != TextRange(cursor + 1)) return new
    if (new.text[cursor] != '\n' || new.text.substring(0, cursor) != old.text.substring(0, cursor)) return new
    val text = old.text
    val start = lineStart(text, cursor)
    val line = text.substring(start, lineEnd(text, cursor))
    if (insideFence(text, start)) {
        val indent = line.takeWhile { it == ' ' || it == '\t' }
        if (indent.isEmpty() || cursor - start < indent.length) return new
        return TextFieldValue(new.text.substring(0, cursor + 1) + indent + new.text.substring(cursor + 1), TextRange(cursor + 1 + indent.length))
    }
    val list = LIST_ITEM.matchEntire(line)
    val quote = if (list == null) QUOTE_LINE.matchEntire(line) else null
    val prefixLength = list?.let { it.groupValues[1].length + it.groupValues[2].length + it.groupValues[5].length } ?: quote?.groupValues?.get(1)?.length ?: return new
    if (cursor - start < prefixLength) return new
    val content = list?.groupValues?.get(6) ?: quote!!.groupValues[2]
    if (content.isBlank()) {
        return TextFieldValue(text.substring(0, start) + text.substring(start + line.length), TextRange(start))
    }
    val continuation = if (list != null) {
        val number = list.groupValues[3].toLongOrNull()
        list.groupValues[1] + (if (number != null) "${number + 1}${list.groupValues[4]}" else list.groupValues[2]) + " "
    } else quote!!.groupValues[1]
    return TextFieldValue(new.text.substring(0, cursor + 1) + continuation + new.text.substring(cursor + 1), TextRange(cursor + 1 + continuation.length))
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
