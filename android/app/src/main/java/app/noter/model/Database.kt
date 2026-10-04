package app.noter.model

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.YearMonth
import java.text.Collator
import java.util.Locale
import java.util.UUID

val databaseTypes = listOf("text", "number", "select", "date", "checkbox")
val databaseLayouts = listOf("table", "kanban", "calendar")
data class DatabaseColumn(val id: String, val name: String, val type: String, val options: List<String>)
data class DatabaseRow(val id: String, val cells: JSONObject)
data class DatabaseView(val id: String, val name: String)
class DatabaseException(message: String) : Exception(message)

private fun JSONArray.objects() = List(length()) { getJSONObject(it) }
private fun JSONArray.strings() = List(length()) { getString(it) }
private fun newDatabaseId() = UUID.randomUUID().toString()

/** Keep the original object so mobile edits retain desktop view settings and unknown fields. */
class NoteDatabase private constructor(private val json: JSONObject) {
    val title: String get() = json.getString("title")
    val columns get() = json.getJSONArray("columns").objects().map {
        DatabaseColumn(it.getString("id"), it.getString("name"), it.getString("type"), it.optJSONArray("options")?.strings().orEmpty())
    }
    val rows get() = json.getJSONArray("rows").objects().map { DatabaseRow(it.getString("id"), it.getJSONObject("cells")) }
    val views get() = json.getJSONArray("views").objects().map { DatabaseView(it.getString("id"), it.getString("name")) }
    private fun active(root: JSONObject = json): JSONObject {
        val views = root.getJSONArray("views").objects()
        return views.find { it.getString("id") == root.optString("activeViewId") }
            ?: views.find { it.getString("layout") == root.optString("view") } ?: views.first()
    }
    private fun state(key: String): Any? = active().let { if (it.has(key)) it.opt(key) else json.opt(key) }
    val viewId get() = active().getString("id")
    val layout get() = active().getString("layout")
    val filter get() = state("filter") as? String ?: ""
    val sort get() = state("sort") as? JSONObject
    val condition get() = state("condition") as? JSONObject
    val month get() = (state("calendarMonth") as? String)?.let { runCatching { YearMonth.parse(it) }.getOrNull() }
        ?.takeIf { it.year in 1..9999 } ?: YearMonth.now()
    fun viewColumn(key: String, type: String): DatabaseColumn? = columns.find { it.id == state(key) && it.type == type }
        ?: columns.firstOrNull { it.type == type }
    fun visibleColumns(): List<DatabaseColumn> {
        val hidden = active().optJSONArray("hiddenColumnIds")?.strings().orEmpty().toSet()
        return columns.filter { it.id !in hidden }.ifEmpty { columns.take(1) }
    }
    fun cell(row: DatabaseRow, column: DatabaseColumn): String = cellString(runCatching { inputCell(cellString(row.cells.opt(column.id)), column) }.getOrElse { inputCell("", column) })
    fun rowTitle(row: DatabaseRow): String = cell(row, columns.firstOrNull { it.type == "text" } ?: columns.first()).trim().ifEmpty { "Untitled record" }
    fun visibleRows(query: String = filter): List<DatabaseRow> {
        val needle = query.trim().lowercase(Locale.ROOT)
        val columns = columns
        val condition = condition?.takeIf { value -> value.opt("value") is String && columns.any { it.id == value.optString("columnId") } }
        val matching = rows.filter { row ->
            (needle.isEmpty() || columns.any { cell(row, it).lowercase(Locale.ROOT).contains(needle) }) &&
                (condition == null || cell(row, columns.first { it.id == condition.getString("columnId") }) == condition.optString("value"))
        }
        val sort = sort ?: return matching
        val column = columns.find { it.id == sort.optString("columnId") } ?: return matching
        val collator = Collator.getInstance().apply { strength = Collator.PRIMARY }
        return matching.sortedWith { left, right ->
            val a = cell(left, column); val b = cell(right, column)
            if (a.isEmpty() != b.isEmpty()) if (a.isEmpty()) 1 else -1
            else {
                val order = when (column.type) {
                    "number" -> (a.toDoubleOrNull() ?: 0.0).compareTo(b.toDoubleOrNull() ?: 0.0)
                    "checkbox" -> a.toBoolean().compareTo(b.toBoolean())
                    else -> compareText(a, b, collator)
                }
                if (sort.optString("direction") == "desc") -order else order
            }
        }
    }
    fun encode(): String = json.toString(2)
    private fun change(edit: (JSONObject) -> Unit): NoteDatabase = read(JSONObject(json.toString()).apply(edit).toString())
        ?: throw DatabaseException("The database change could not be applied. Your original data is kept.")
    fun withSetting(key: String, value: Any?): NoteDatabase = change { root ->
        active(root).put(if (key == "view") "layout" else key, value ?: JSONObject.NULL)
        root.put(key, value ?: JSONObject.NULL)
    }
    fun withView(id: String): NoteDatabase = change { root ->
        val view = root.getJSONArray("views").objects().find { it.getString("id") == id } ?: return@change
        root.put("activeViewId", id).put("view", view.getString("layout"))
        for (key in listOf("filter", "sort", "calendarColumnId", "boardColumnId", "calendarMonth")) root.put(key, view.opt(key) ?: JSONObject.NULL)
    }
    fun withCondition(columnId: String?, value: String = ""): NoteDatabase = change { root ->
        active(root).put("condition", columnId?.let { JSONObject().put("columnId", it).put("value", value) } ?: JSONObject.NULL)
    }
    fun withTitle(title: String) = change { it.put("title", title.trim().ifEmpty { "Untitled database" }) }
    fun withRow(id: String?, values: Map<String, String>): NoteDatabase = change { root ->
        val rows = root.getJSONArray("rows")
        val row = if (id == null) JSONObject().put("id", newDatabaseId()).put("cells", JSONObject()).also { rows.put(it) }
            else rows.objects().find { it.getString("id") == id } ?: throw DatabaseException("This record no longer exists. Close and reopen the database.")
        val cells = row.getJSONObject("cells")
        for (column in columns) if (values.containsKey(column.id)) cells.put(column.id, inputCell(values.getValue(column.id), column))
    }
    fun duplicateRow(id: String): NoteDatabase = change { root ->
        val rows = root.getJSONArray("rows")
        rows.objects().find { it.getString("id") == id }?.let { rows.put(JSONObject(it.toString()).put("id", newDatabaseId())) }
    }
    fun removeRow(id: String): NoteDatabase = change { root ->
        root.put("rows", JSONArray(root.getJSONArray("rows").objects().filter { it.getString("id") != id }))
    }
    fun withColumn(id: String?, name: String, type: String, options: List<String>): NoteDatabase = change { root ->
        if (name.isBlank() || type !in databaseTypes) throw DatabaseException("Enter a property name and choose a type.")
        val columns = root.getJSONArray("columns")
        val existing = columns.objects().find { it.getString("id") == id }
        if (id != null && existing == null) throw DatabaseException("This property no longer exists. Close and reopen the database.")
        val oldType = existing?.getString("type")
        val column = existing ?: JSONObject().put("id", newDatabaseId()).also { columns.put(it) }
        column.put("name", name.trim()).put("type", type).put("options", JSONArray(if (type == "select") options.distinct() else emptyList<String>()))
        val descriptor = DatabaseColumn(column.getString("id"), name, type, options)
        if (existing == null || oldType != type) for (row in root.getJSONArray("rows").objects()) {
            val cells = row.getJSONObject("cells")
            val converted = runCatching { inputCell(cellString(cells.opt(descriptor.id)), descriptor) }.getOrElse { inputCell("", descriptor) }
            cells.put(descriptor.id, converted)
        }
        for (view in root.getJSONArray("views").objects()) {
            val condition = view.optJSONObject("condition")
            if (condition?.optString("columnId") == descriptor.id && oldType != type) view.put("condition", JSONObject.NULL)
        }
    }
    fun removeColumn(id: String): NoteDatabase = change { root ->
        if (columns.size <= 1) throw DatabaseException("Keep at least one property.")
        root.put("columns", JSONArray(root.getJSONArray("columns").objects().filter { it.getString("id") != id }))
        for (row in root.getJSONArray("rows").objects()) row.getJSONObject("cells").remove(id)
        for (view in root.getJSONArray("views").objects()) {
            view.optJSONArray("hiddenColumnIds")?.let { view.put("hiddenColumnIds", JSONArray(it.strings().filter { key -> key != id })) }
            view.optJSONObject("columnWidths")?.remove(id)
            if (view.optJSONObject("condition")?.optString("columnId") == id) view.put("condition", JSONObject.NULL)
            if (view.optJSONObject("sort")?.optString("columnId") == id) view.put("sort", JSONObject.NULL)
        }
        if (root.optJSONObject("sort")?.optString("columnId") == id) root.put("sort", JSONObject.NULL)
    }
    companion object {
        fun read(source: String): NoteDatabase? = runCatching {
            val root = JSONObject(source)
            require(root.get("version") is Number && root.getDouble("version") == 1.0 && root.get("title") is String)
            val columns = root.getJSONArray("columns").objects()
            require(columns.isNotEmpty())
            val ids = HashSet<String>()
            for (column in columns) {
                require(column.get("id") is String && column.getString("id").isNotEmpty() && ids.add(column.getString("id")))
                require(column.get("name") is String && column.get("type") is String && column.getString("type") in databaseTypes)
                column.optJSONArray("options")?.let { options ->
                    require((0 until options.length()).all { options.get(it) is String } && options.strings().distinct().size == options.length())
                }
            }
            ids.clear()
            for (row in root.getJSONArray("rows").objects()) {
                require(row.get("id") is String && row.getString("id").isNotEmpty() && ids.add(row.getString("id")))
                val cells = row.getJSONObject("cells")
                require(columns.all { cells.opt(it.getString("id")) !is JSONObject && cells.opt(it.getString("id")) !is JSONArray })
            }
            var views = root.optJSONArray("views")
            if (views == null || views.length() == 0) {
                views = JSONArray()
                for (layout in databaseLayouts) views.put(JSONObject().put("id", newDatabaseId()).put("name", layout.replaceFirstChar { it.uppercase() }).put("layout", layout)
                    .put("filter", root.optString("filter")).put("sort", root.opt("sort") ?: JSONObject.NULL)
                    .put("calendarColumnId", root.opt("calendarColumnId") ?: JSONObject.NULL).put("boardColumnId", root.opt("boardColumnId") ?: JSONObject.NULL)
                    .put("calendarMonth", root.optString("calendarMonth", YearMonth.now().toString())).put("hiddenColumnIds", JSONArray()).put("columnWidths", JSONObject()).put("condition", JSONObject.NULL))
                root.put("views", views)
            }
            ids.clear()
            for (view in views.objects()) {
                require(view.get("id") is String && view.getString("id").isNotEmpty() && ids.add(view.getString("id")) && view.get("name") is String && view.getString("layout") in databaseLayouts)
                view.optJSONArray("hiddenColumnIds")?.let { hidden -> require((0 until hidden.length()).all { hidden.get(it) is String }) }
            }
            NoteDatabase(root)
        }.getOrNull()
        fun create(title: String): NoteDatabase {
            val name = newDatabaseId(); val status = newDatabaseId(); val due = newDatabaseId()
            val columns = JSONArray().put(JSONObject().put("id", name).put("name", "Name").put("type", "text").put("options", JSONArray()))
                .put(JSONObject().put("id", status).put("name", "Status").put("type", "select").put("options", JSONArray(listOf("Not started", "In progress", "Done"))))
                .put(JSONObject().put("id", due).put("name", "Due").put("type", "date").put("options", JSONArray()))
            return checkNotNull(read(JSONObject().put("version", 1).put("title", title).put("columns", columns).put("rows", JSONArray())
                .put("view", "table").put("filter", "").put("sort", JSONObject.NULL).put("boardColumnId", status).put("calendarColumnId", due)
                .put("calendarMonth", YearMonth.now().toString()).toString()))
        }
    }
}

private val textParts = Regex("[0-9]+|[^0-9]+")
private fun compareText(left: String, right: String, collator: Collator): Int {
    val a = textParts.findAll(left).map { it.value }.toList()
    val b = textParts.findAll(right).map { it.value }.toList()
    for (index in 0 until minOf(a.size, b.size)) {
        val x = a[index]; val y = b[index]
        val order = if (x.first() in '0'..'9' && y.first() in '0'..'9') {
            val n = x.trimStart('0'); val m = y.trimStart('0')
            n.length.compareTo(m.length).takeIf { it != 0 } ?: n.compareTo(m)
        } else collator.compare(x, y)
        if (order != 0) return order
    }
    return a.size.compareTo(b.size)
}

private fun cellString(value: Any?): String = when (value) {
    null, JSONObject.NULL -> ""
    is Number -> JSONObject.numberToString(value)
    else -> value.toString()
}
private fun inputCell(text: String, column: DatabaseColumn): Any = when (column.type) {
    "number" -> if (text.isBlank()) JSONObject.NULL else text.toDoubleOrNull()?.takeIf { it.isFinite() } ?: throw DatabaseException("${column.name}: enter a valid number.")
    "checkbox" -> Regex("^(true|yes|done|1)$", RegexOption.IGNORE_CASE).matches(text.trim())
    "date" -> if (text.isBlank()) "" else runCatching { LocalDate.parse(text).takeIf { it.year in 1..9999 && it.toString() == text }?.toString() }.getOrNull()
        ?: throw DatabaseException("${column.name}: choose a valid date.")
    else -> text
}

data class DatabaseBlock(val index: Int, val start: Int, val end: Int, val fenceStart: Int, val fenceEnd: Int, val source: String, val database: NoteDatabase)
private val databaseFence = Regex("^ {0,3}(`{3,}|~{3,})([^\\r\\n]*)\\r?$", RegexOption.MULTILINE)

/** Recognize whole fences, ignoring database examples inside other code blocks. */
fun databaseBlocks(markdown: String): List<DatabaseBlock> {
    val blocks = ArrayList<DatabaseBlock>()
    var marker: String? = null; var language = ""; var start = 0; var fenceStart = 0; var index = -1
    for (match in databaseFence.findAll(markdown)) {
        val run = match.groupValues[1]; val info = match.groupValues[2].trim()
        if (marker == null) {
            marker = run; language = info; fenceStart = match.range.first
            start = (match.range.last + 2).coerceAtMost(markdown.length)
            if (language == "noter-database") index++
        } else if (run.first() == marker.first() && run.length >= marker.length && info.isEmpty()) {
            if (language == "noter-database") {
                val source = markdown.substring(start, match.range.first)
                NoteDatabase.read(source)?.let { blocks += DatabaseBlock(index, start, match.range.first, fenceStart, (match.range.last + 2).coerceAtMost(markdown.length), source, it) }
            }
            marker = null
        }
    }
    return blocks
}

fun databaseMarkdown(database: NoteDatabase) = "```noter-database\n${database.encode()}\n```\n"
fun replaceDatabase(markdown: String, original: DatabaseBlock, database: NoteDatabase): String {
    val current = databaseBlocks(markdown).find { it.index == original.index && it.source == original.source }
        ?: throw DatabaseException("This database changed outside this view. Close and reopen it before saving; your draft is still here.")
    val newline = if (current.source.endsWith("\r\n")) "\r\n" else "\n"
    return markdown.replaceRange(current.start, current.end, database.encode().replace("\n", newline) + newline)
}
