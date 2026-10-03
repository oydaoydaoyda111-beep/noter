package app.noter.ui.editor

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.em

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

private val markerStyle = SpanStyle(color = Marker)
private val headingSizes = listOf(1.45f, 1.25f, 1.1f)

/** Styles Markdown in place. The text itself is unchanged, so cursor offsets map one to one. */
fun styleMarkdown(text: String): AnnotatedString = AnnotatedString.Builder(text).apply {
    var fence: String? = null
    var start = 0
    while (start <= text.length) {
        val end = text.indexOf('\n', start).let { if (it < 0) text.length else it }
        val line = text.substring(start, end)
        val fenceMatch = FENCE.matchEntire(line)
        when {
            fence != null -> {
                addStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = BlockCode, background = BlockCodeBackground), start, end)
                if (fenceMatch != null && fenceMatch.groupValues[1].startsWith(fence) && fenceMatch.groupValues[2].isBlank()) {
                    addStyle(markerStyle, start, end)
                    fence = null
                }
            }
            fenceMatch != null -> {
                fence = fenceMatch.groupValues[1]
                addStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = Marker, background = BlockCodeBackground), start, end)
            }
            else -> styleLine(this, line, start)
        }
        start = end + 1
    }
}.toAnnotatedString()

private fun styleLine(builder: AnnotatedString.Builder, line: String, offset: Int) {
    HEADING.matchEntire(line)?.let { match ->
        val level = match.groupValues[1].count { it == '#' }
        val markerEnd = offset + match.groupValues[1].length
        builder.addStyle(SpanStyle(color = Heading, fontWeight = FontWeight.SemiBold, fontSize = headingSizes.getOrElse(level - 1) { 1f }.em), offset, offset + line.length)
        builder.addStyle(markerStyle, offset, markerEnd)
        styleInline(builder, line, offset, markerEnd - offset)
        return
    }
    if (RULE.matches(line)) {
        builder.addStyle(SpanStyle(color = Marker, letterSpacing = 0.3.em), offset, offset + line.length)
        return
    }
    var contentStart = 0
    QUOTE.matchEntire(line)?.let { match ->
        builder.addStyle(markerStyle, offset, offset + match.groupValues[1].length)
        builder.addStyle(SpanStyle(color = Quote), offset + match.groupValues[1].length, offset + line.length)
        contentStart = match.groupValues[1].length
    }
    LIST.find(line, contentStart)?.takeIf { it.range.first == contentStart || line.substring(contentStart, it.range.first).isBlank() }?.let { match ->
        val markerStart = offset + match.range.first + match.groupValues[1].length
        builder.addStyle(SpanStyle(color = ListMarker, fontWeight = FontWeight.SemiBold), markerStart, markerStart + match.groupValues[2].length)
        contentStart = match.range.last + 1
    }
    styleInline(builder, line, offset, contentStart)
}

private fun styleInline(builder: AnnotatedString.Builder, line: String, offset: Int, from: Int) {
    val protected = ArrayList<IntRange>()
    fun free(range: IntRange) = range.first >= from && protected.none { it.first <= range.last && range.first <= it.last }
    for (match in ESCAPE.findAll(line)) if (free(match.range)) {
        builder.addStyle(markerStyle, offset + match.range.first, offset + match.range.first + 1)
        protected += match.range
    }
    for (match in CODE_SPAN.findAll(line)) if (free(match.range)) {
        val tick = match.groupValues[1].length
        builder.addStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = InlineCode, background = InlineCodeBackground), offset + match.range.first, offset + match.range.last + 1)
        builder.addStyle(markerStyle, offset + match.range.first, offset + match.range.first + tick)
        builder.addStyle(markerStyle, offset + match.range.last + 1 - tick, offset + match.range.last + 1)
        protected += match.range
    }
    for (match in LINK.findAll(line)) if (free(match.range)) {
        val labelEnd = match.range.first + 1 + match.groupValues[1].length
        builder.addStyle(SpanStyle(color = LinkColor, textDecoration = TextDecoration.Underline), offset + match.range.first + 1, offset + labelEnd)
        builder.addStyle(markerStyle, offset + match.range.first, offset + match.range.first + 1)
        builder.addStyle(markerStyle, offset + labelEnd, offset + match.range.last + 1)
    }
    for (match in BOLD.findAll(line)) if (free(match.range)) {
        builder.addStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = Heading), offset + match.range.first, offset + match.range.last + 1)
        builder.addStyle(markerStyle, offset + match.range.first, offset + match.range.first + 2)
        builder.addStyle(markerStyle, offset + match.range.last - 1, offset + match.range.last + 1)
    }
    for (regex in listOf(ITALIC_STAR, ITALIC_UNDERSCORE)) for (match in regex.findAll(line)) if (free(match.range)) {
        builder.addStyle(SpanStyle(fontStyle = FontStyle.Italic, color = Italic), offset + match.range.first, offset + match.range.last + 1)
        builder.addStyle(markerStyle, offset + match.range.first, offset + match.range.first + 1)
        builder.addStyle(markerStyle, offset + match.range.last, offset + match.range.last + 1)
    }
}

/** Live Markdown styling for the note editor; caches the last result because it runs on every frame that changes text. */
class MarkdownTransformation : VisualTransformation {
    private var lastText: String? = null
    private var last: TransformedText? = null

    override fun filter(text: AnnotatedString): TransformedText {
        last?.takeIf { lastText == text.text }?.let { return it }
        return TransformedText(styleMarkdown(text.text), OffsetMapping.Identity).also {
            lastText = text.text
            last = it
        }
    }
}
