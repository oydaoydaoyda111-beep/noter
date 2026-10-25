package app.noter.ui.editor

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.ParagraphStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextGeometricTransform
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

// Colors from the web editor (src/styles/editor.css).
private val Marker = Color(0xFF55626D)
private val Heading = Color(0xFFE0E7ED)
private val Italic = Color(0xFFC6D1DA)
private val InlineCode = Color(0xFFB6CCD9)
private val InlineCodeBackground = Color(0x1AB4CBD7)
private val BlockCode = Color(0xFFB4C8D6)
private val BlockCodeBackground = Color(0xFF151B20)
private val LinkColor = Color(0xFFB1CFDC)
private val Quote = Color(0xFF9CAEBD)
private val ListMarker = Color(0xFF7F9BAD)

private val FENCE = Regex("^\\s{0,3}(`{3,}|~{3,})(.*)$")
private val HEADING = Regex("^(\\s{0,3}#{1,6}\\s+)(.*)$")
private val RULE = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
private val QUOTE = Regex("^(\\s*>\\s?)(.*)$")
private val LIST = Regex("^(\\s*)([-+*]|\\d+[.)])(\\s+)")
private val ESCAPE = Regex("\\\\[\\\\`*_{}\\[\\]()#+.!<>-]")
private val CODE_SPAN = Regex("(`+)(.+?)\\1")
private val BOLD = Regex("(\\*\\*|__)(?=\\S)(.+?)(?<=\\S)\\1")
private val ITALIC_STAR = Regex("(?<![*\\\\])\\*(?![*\\s])(.+?)(?<![\\s*\\\\])\\*(?!\\*)")
private val ITALIC_UNDERSCORE = Regex("(?<![\\w_\\\\])_(?![_\\s])(.+?)(?<![\\s_])_(?![\\w_])")
private val LINK = Regex("\\[([^\\]\\n]+)\\]\\(([^)\\s]*)\\)")
private val IMAGE = Regex("^(\\s*)!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)\\s*$")
private val TOGGLE = Regex("^(\\s*)>(\\s?)(\\[!toggle\\])([+-])(\\s*)(.*)$", RegexOption.IGNORE_CASE)
private val TABLE_ROW = Regex("^\\s*\\|")
private val TABLE_DELIMITER = Regex("^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)*\\|?\\s*$")

private val markerStyle = SpanStyle(color = Marker)
// Markers stay in the text so offsets map one to one; they are drawn transparent and almost zero width instead.
private val hiddenStyle = SpanStyle(color = Color.Transparent, fontSize = 0.01.em, letterSpacing = 0.sp)
private val headingSizes = listOf(1.45f, 1.25f, 1.1f)

/** Collects styles and same-length character substitutions (bullets, quote bars, rules) for the displayed text. */
private class Styler(text: String) {
    val chars = text.toCharArray()
    val spans = ArrayList<AnnotatedString.Range<SpanStyle>>()
    val paragraphs = ArrayList<AnnotatedString.Range<ParagraphStyle>>()
    fun add(style: SpanStyle, start: Int, end: Int) { if (end > start) spans += AnnotatedString.Range(style, start, end) }
    fun paragraph(style: ParagraphStyle, start: Int, end: Int) { if (end > start) paragraphs += AnnotatedString.Range(style, start, end) }
    fun build() = AnnotatedString(String(chars), spans, paragraphs)
}

/**
 * Space reserved for blocks the editor draws over the text: images (by link; null shows the file-name chip)
 * and table rows. The Markdown stays in the field, hidden, so editing and offsets are unchanged.
 */
class BlockLayout(val imageHeights: Map<String, TextUnit?>, val tableRowHeight: TextUnit)

sealed interface PreviewBlock { val start: Int; val end: Int }
class ImagePreviewBlock(override val start: Int, override val end: Int, val link: String, val alt: String) : PreviewBlock
/** [rows] holds each row's line start and cells (the delimiter row excluded); [source] is the block's Markdown. */
class TablePreviewBlock(override val start: Int, override val end: Int, val rows: List<Pair<Int, List<String>>>, val align: List<String>, val source: String) : PreviewBlock

/** Cells of a pipe-table row; `\|` is a literal pipe. */
fun tableCells(line: String): List<String> {
    var text = line.trim().removePrefix("|")
    if (text.endsWith("|") && !text.endsWith("\\|")) text = text.dropLast(1)
    val cells = ArrayList<String>()
    val current = StringBuilder()
    var index = 0
    while (index < text.length) {
        when {
            text[index] == '\\' && text.getOrNull(index + 1) == '|' -> { current.append('|'); index++ }
            text[index] == '|' -> { cells += current.toString().trim(); current.clear() }
            else -> current.append(text[index])
        }
        index++
    }
    cells += current.toString().trim()
    return cells
}

/** A GFM pipe table with a header row; pipes in cells are escaped and line breaks become spaces. */
fun tableMarkdown(rows: List<List<String>>, align: List<String>): String {
    val width = rows.maxOf { it.size }.coerceAtLeast(1)
    fun cell(text: String) = text.replace('\n', ' ').trim().replace(Regex("(?<!\\\\)\\|"), "\\\\|")
    fun line(row: List<String>) = "| " + (0 until width).joinToString(" | ") { cell(row.getOrElse(it) { "" }) } + " |"
    val delimiter = "| " + (0 until width).joinToString(" | ") {
        when (align.getOrNull(it)) { "left" -> ":---"; "center" -> ":---:"; "right" -> "---:"; else -> "---" }
    } + " |"
    return (listOf(line(rows.first()), delimiter) + rows.drop(1).map(::line)).joinToString("\n")
}

private fun lineEndAt(text: String, start: Int) = text.indexOf('\n', start).let { if (it < 0) text.length else it }

/** End of the table whose header row starts at [start], or null when no delimiter row follows it. */
private fun tableEnd(text: String, start: Int): Int? {
    val end = lineEndAt(text, start)
    if (end >= text.length) return null
    val delimiter = text.substring(end + 1, lineEndAt(text, end + 1))
    if (!TABLE_ROW.containsMatchIn(delimiter) || !TABLE_DELIMITER.matches(delimiter)) return null
    var last = lineEndAt(text, end + 1)
    while (last < text.length && TABLE_ROW.containsMatchIn(text.substring(last + 1, lineEndAt(text, last + 1)))) last = lineEndAt(text, last + 1)
    return last
}

private fun outside(start: Int, end: Int, active: IntRange?) = active == null || end < active.first || start > active.last

/** Images and tables outside [active] that the editor renders over their hidden Markdown. */
fun previewBlocks(text: String, active: IntRange?): List<PreviewBlock> {
    val result = ArrayList<PreviewBlock>()
    var fence: String? = null
    var start = 0
    while (start <= text.length) {
        val end = lineEndAt(text, start)
        val line = text.substring(start, end)
        val fenceMatch = FENCE.matchEntire(line)
        if (fence != null) {
            if (fenceMatch != null && fenceMatch.groupValues[1].startsWith(fence) && fenceMatch.groupValues[2].isBlank()) fence = null
        } else if (fenceMatch != null) {
            fence = fenceMatch.groupValues[1]
        } else if (TABLE_ROW.containsMatchIn(line)) {
            val last = tableEnd(text, start)
            if (last != null) {
                if (outside(start, last, active)) {
                    val lines = text.substring(start, last).split('\n')
                    var lineStart = start
                    val rows = ArrayList<Pair<Int, List<String>>>()
                    lines.forEachIndexed { index, row -> if (index != 1) rows += lineStart to tableCells(row); lineStart += row.length + 1 }
                    val align = tableCells(lines[1]).map { cell ->
                        when { cell.startsWith(':') && cell.endsWith(':') -> "center"; cell.endsWith(':') -> "right"; cell.startsWith(':') -> "left"; else -> "" }
                    }
                    result += TablePreviewBlock(start, last, rows, align, text.substring(start, last))
                }
                start = last + 1
                continue
            }
        } else IMAGE.matchEntire(line)?.let { match ->
            if (outside(start, end, active)) result += ImagePreviewBlock(start, end, match.groupValues[3], match.groupValues[2])
        }
        start = end + 1
    }
    return result
}

/**
 * Styles Markdown as a live preview. Block markers are always rendered (bullets, quote bars, hidden heading marks);
 * inline markers stay visible only inside [active], the lines being edited.
 */
fun styleMarkdown(text: String, active: IntRange? = null, layout: BlockLayout? = null): AnnotatedString = Styler(text).apply {
    var fence: String? = null
    var table = false
    var tableDrawn = false
    var start = 0
    while (start <= text.length) {
        val end = text.indexOf('\n', start).let { if (it < 0) text.length else it }
        val line = text.substring(start, end)
        val fenceMatch = FENCE.matchEntire(line)
        val preview = active == null || start > active.last || end < active.first
        // A table starts at a `|` row followed by a delimiter row and continues while rows start with `|`.
        var header = false
        if (fence != null || fenceMatch != null || !TABLE_ROW.containsMatchIn(line)) table = false
        else if (!table) {
            val next = if (end < text.length) text.substring(end + 1, text.indexOf('\n', end + 1).let { if (it < 0) text.length else it }) else ""
            header = next.contains('|') && TABLE_DELIMITER.matches(next)
            table = header
            tableDrawn = header && layout != null && tableEnd(text, start)?.let { outside(start, it, active) } == true
        }
        when {
            fence != null -> {
                add(SpanStyle(fontFamily = FontFamily.Monospace, color = BlockCode, background = BlockCodeBackground), start, end)
                if (fenceMatch != null && fenceMatch.groupValues[1].startsWith(fence) && fenceMatch.groupValues[2].isBlank()) {
                    add(markerStyle, start, end)
                    fence = null
                }
            }
            fenceMatch != null -> {
                fence = fenceMatch.groupValues[1]
                add(SpanStyle(fontFamily = FontFamily.Monospace, color = Marker, background = BlockCodeBackground), start, end)
            }
            // A drawn table keeps one line per row, sized to the grid row; the delimiter row collapses.
            table && tableDrawn -> {
                add(hiddenStyle, start, end)
                paragraph(ParagraphStyle(lineHeight = if (TABLE_DELIMITER.matches(line)) 1.sp else layout!!.tableRowHeight), start, end)
            }
            table -> styleTableRow(this, line, start, header, preview)
            else -> styleLine(this, line, start, preview, layout)
        }
        start = end + 1
    }
}.build()

private fun styleTableRow(styler: Styler, line: String, offset: Int, header: Boolean, preview: Boolean) {
    styler.add(SpanStyle(fontFamily = FontFamily.Monospace), offset, offset + line.length)
    if (TABLE_DELIMITER.matches(line)) {
        styler.add(markerStyle, offset, offset + line.length)
        return
    }
    if (header) styler.add(SpanStyle(color = Heading, fontWeight = FontWeight.SemiBold), offset, offset + line.length)
    styleInline(styler, line, offset, 0, preview)
    for (index in line.indices) if (line[index] == '|' && line.getOrNull(index - 1) != '\\') styler.add(markerStyle, offset + index, offset + index + 1)
}

private fun styleLine(styler: Styler, line: String, offset: Int, preview: Boolean, layout: BlockLayout? = null) {
    IMAGE.matchEntire(line)?.let { match ->
        val height = if (preview) layout?.imageHeights?.get(match.groupValues[3]) else null
        if (height != null) {
            // The picture is drawn over this line; its height is reserved here.
            styler.add(hiddenStyle, offset, offset + line.length)
            styler.paragraph(ParagraphStyle(lineHeight = height), offset, offset + line.length)
            return
        }
        val bang = match.groupValues[1].length
        val close = line.lastIndexOf(')')
        val path = match.groups[3]!!.range
        if (!preview) {
            styler.add(markerStyle, offset + bang, offset + close + 1)
            styler.add(SpanStyle(color = LinkColor), offset + path.first, offset + path.last + 1)
            return
        }
        // Off the edited line an image shows as a chip with its file name; tapping it opens a preview.
        val nameStart = path.first + match.groupValues[3].lastIndexOf('/') + 1
        styler.chars[offset + bang] = '▣'
        styler.chars[offset + bang + 1] = ' '
        styler.add(hiddenStyle, offset + bang + 2, offset + nameStart)
        styler.add(hiddenStyle, offset + close, offset + close + 1)
        styler.add(SpanStyle(color = LinkColor, background = InlineCodeBackground), offset + bang, offset + close)
        return
    }
    TOGGLE.matchEntire(line)?.let { match ->
        val arrow = offset + match.groupValues[1].length
        styler.chars[arrow] = if (match.groupValues[4] == "-") '▸' else '▾'
        styler.add(SpanStyle(color = ListMarker), arrow, arrow + 1)
        val markerStart = arrow + 1 + match.groupValues[2].length
        val titleStart = markerStart + match.groupValues[3].length + 1 + match.groupValues[5].length
        styler.add(hiddenStyle, markerStart, titleStart)
        styler.add(SpanStyle(color = Heading, fontWeight = FontWeight.SemiBold), titleStart, offset + line.length)
        styleInline(styler, line, offset, titleStart - offset, preview)
        return
    }
    HEADING.matchEntire(line)?.let { match ->
        val level = match.groupValues[1].count { it == '#' }
        val markerEnd = offset + match.groupValues[1].length
        styler.add(SpanStyle(color = Heading, fontWeight = FontWeight.SemiBold, fontSize = headingSizes.getOrElse(level - 1) { 1f }.em), offset, offset + line.length)
        styler.add(hiddenStyle, offset, markerEnd)
        styleInline(styler, line, offset, markerEnd - offset, preview)
        return
    }
    if (RULE.matches(line)) {
        val first = line.indexOfFirst { !it.isWhitespace() }
        for (index in first until line.length) styler.chars[offset + index] = '─'
        styler.add(SpanStyle(color = Marker, letterSpacing = 0.sp, textGeometricTransform = TextGeometricTransform(scaleX = 24f / (line.length - first))), offset + first, offset + line.length)
        return
    }
    var contentStart = 0
    QUOTE.matchEntire(line)?.let { match ->
        styler.chars[offset + match.groupValues[1].indexOf('>')] = '▎'
        styler.add(SpanStyle(color = ListMarker), offset, offset + match.groupValues[1].length)
        styler.add(SpanStyle(color = Quote, fontStyle = FontStyle.Italic), offset + match.groupValues[1].length, offset + line.length)
        contentStart = match.groupValues[1].length
    }
    LIST.find(line, contentStart)?.takeIf { it.range.first == contentStart || line.substring(contentStart, it.range.first).isBlank() }?.let { match ->
        val markerStart = offset + match.range.first + match.groupValues[1].length
        val marker = match.groupValues[2]
        val box = match.range.last + 1
        val mark = line.getOrNull(box + 1)
        val task = !marker[0].isDigit() && line.getOrNull(box) == '[' && line.getOrNull(box + 2) == ']' &&
            (mark == ' ' || mark == 'x' || mark == 'X') && line.getOrNull(box + 3)?.isWhitespace() != false
        if (task) {
            // `- [ ]` draws as a single checkbox: the bullet and brackets are hidden, `[` becomes the box.
            val checked = mark != ' '
            styler.add(hiddenStyle, markerStart, offset + box)
            styler.chars[offset + box] = if (checked) '☑' else '☐'
            styler.add(SpanStyle(color = if (checked) LinkColor else ListMarker, fontSize = 1.15.em), offset + box, offset + box + 1)
            styler.add(hiddenStyle, offset + box + 1, offset + box + 3)
            if (checked) styler.add(SpanStyle(color = Marker, textDecoration = TextDecoration.LineThrough), offset + box + 3, offset + line.length)
            contentStart = box + 3
        } else {
            if (!marker[0].isDigit()) styler.chars[markerStart] = if (match.groupValues[1].length >= 2) '◦' else '•'
            styler.add(SpanStyle(color = ListMarker, fontWeight = FontWeight.SemiBold), markerStart, markerStart + marker.length)
            contentStart = box
        }
    }
    styleInline(styler, line, offset, contentStart, preview)
}

private fun styleInline(styler: Styler, line: String, offset: Int, from: Int, preview: Boolean) {
    val marker = if (preview) hiddenStyle else markerStyle
    val protected = ArrayList<IntRange>()
    fun free(range: IntRange) = range.first >= from && protected.none { it.first <= range.last && range.first <= it.last }
    for (match in ESCAPE.findAll(line)) if (free(match.range)) {
        styler.add(marker, offset + match.range.first, offset + match.range.first + 1)
        protected += match.range
    }
    for (match in CODE_SPAN.findAll(line)) if (free(match.range)) {
        val tick = match.groupValues[1].length
        styler.add(SpanStyle(fontFamily = FontFamily.Monospace, color = InlineCode, background = InlineCodeBackground), offset + match.range.first, offset + match.range.last + 1)
        styler.add(marker, offset + match.range.first, offset + match.range.first + tick)
        styler.add(marker, offset + match.range.last + 1 - tick, offset + match.range.last + 1)
        protected += match.range
    }
    for (match in LINK.findAll(line)) if (free(match.range)) {
        val labelEnd = match.range.first + 1 + match.groupValues[1].length
        styler.add(SpanStyle(color = LinkColor, textDecoration = TextDecoration.Underline), offset + match.range.first + 1, offset + labelEnd)
        styler.add(marker, offset + match.range.first, offset + match.range.first + 1)
        styler.add(marker, offset + labelEnd, offset + match.range.last + 1)
    }
    for (match in BOLD.findAll(line)) if (free(match.range)) {
        styler.add(SpanStyle(fontWeight = FontWeight.SemiBold, color = Heading), offset + match.range.first, offset + match.range.last + 1)
        styler.add(marker, offset + match.range.first, offset + match.range.first + 2)
        styler.add(marker, offset + match.range.last - 1, offset + match.range.last + 1)
    }
    for (regex in listOf(ITALIC_STAR, ITALIC_UNDERSCORE)) for (match in regex.findAll(line)) if (free(match.range)) {
        styler.add(SpanStyle(fontStyle = FontStyle.Italic, color = Italic), offset + match.range.first, offset + match.range.last + 1)
        styler.add(marker, offset + match.range.first, offset + match.range.first + 1)
        styler.add(marker, offset + match.range.last, offset + match.range.last + 1)
    }
}

/** Live Markdown styling for the note editor; caches the last result because it runs on every frame that changes text. */
class MarkdownTransformation(private val active: IntRange? = null, private val layout: BlockLayout? = null) : VisualTransformation {
    private var lastText: String? = null
    private var last: TransformedText? = null

    override fun filter(text: AnnotatedString): TransformedText {
        last?.takeIf { lastText == text.text }?.let { return it }
        return TransformedText(styleMarkdown(text.text, active, layout), OffsetMapping.Identity).also {
            lastText = text.text
            last = it
        }
    }
}
