package app.noter.ui.database

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.noter.model.*
import app.noter.ui.MessageDialog
import app.noter.ui.NameDialog
import app.noter.ui.finance.DateDialog
import app.noter.ui.finance.OptionSheet
import app.noter.ui.finance.PickerRow
import org.json.JSONObject
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter

private data class RecordRequest(val row: DatabaseRow? = null, val defaults: Map<String, String> = emptyMap())
private data class Choice(val title: String, val values: List<Pair<String, String>>, val selected: String, val select: (String) -> Unit)

/** Changes flow through the note editor's undo/autosave path, using the existing Markdown fence. */
@Composable
fun DatabaseDialog(data: NoteDatabase, onChange: (NoteDatabase) -> Unit, onClose: () -> Unit) {
    var record by remember { mutableStateOf<RecordRequest?>(null) }
    var properties by remember { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var choice by remember { mutableStateOf<Choice?>(null) }
    var deleteRow by remember { mutableStateOf<DatabaseRow?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var query by remember(data.viewId) { mutableStateOf(data.filter) }
    val latestData by rememberUpdatedState(data)
    val latestChange by rememberUpdatedState(onChange)
    var day by remember(data.month) { mutableStateOf<LocalDate?>(LocalDate.now().takeIf { YearMonth.from(it) == data.month } ?: data.month.atDay(1)) }
    fun update(next: NoteDatabase): String? = try { latestChange(next); problem = null; null }
        catch (error: Exception) { (error.message ?: "Could not update the database.").also { problem = it } }
    LaunchedEffect(query, data.viewId) {
        kotlinx.coroutines.delay(250)
        if (query != latestData.filter) update(latestData.withSetting("filter", query))
    }
    val rows = remember(data, query) { data.visibleRows(query) }
    DialogFrame(data.title.ifBlank { "Untitled database" }, onClose, actions = {
        IconButton(onClick = { settings = true }) { Icon(Icons.Default.FilterAlt, contentDescription = "Database filters and sorting") }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Database actions") }
            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Properties") }, onClick = { menu = false; properties = true })
                DropdownMenuItem(text = { Text("Rename database") }, onClick = { menu = false; rename = true })
            }
        }
    }) {
        OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true,
            placeholder = { Text("Search records") }, leadingIcon = { Icon(Icons.Default.Search, null) },
            trailingIcon = if (query.isNotEmpty()) ({ IconButton(onClick = { query = "" }) { Icon(Icons.Default.Close, "Clear record search") } }) else null,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).semantics { contentDescription = "Search database records" })
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { choice = Choice("Saved view", data.views.map { it.id to it.name }, data.viewId) { update(latestData.withView(it)) } }) {
                Text(data.views.first { it.id == data.viewId }.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
                Icon(Icons.Default.KeyboardArrowDown, null)
            }
            Text("${rows.size} of ${data.rows.size} records", modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(databaseLayouts) { layout -> FilterChip(data.layout == layout, onClick = { update(data.withSetting("view", layout)) }, label = { Text(if (layout == "kanban") "Board" else layout.replaceFirstChar { it.uppercase() }) }) }
        }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall) }
        val open: (DatabaseRow) -> Unit = { record = RecordRequest(it) }
        val duplicate: (DatabaseRow) -> Unit = { update(data.duplicateRow(it.id)) }
        val remove: (DatabaseRow) -> Unit = { deleteRow = it }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (data.layout) {
                "kanban" -> Board(data, rows, open, duplicate, remove, onMove = { row, column, value -> update(data.withRow(row.id, mapOf(column.id to value))) }, onAdd = { defaults -> record = RecordRequest(defaults = defaults) }, onProperties = { properties = true })
                "calendar" -> Calendar(data, rows, day, onDay = { day = it }, onMonth = { update(data.withSetting("calendarMonth", it.toString())) }, open, duplicate, remove, onProperties = { properties = true })
                else -> Table(data, rows, open, duplicate, remove)
            }
        }
        Button(onClick = {
            val column = data.viewColumn("calendarColumnId", "date")
            record = RecordRequest(defaults = if (data.layout == "calendar" && column != null) mapOf(column.id to day?.toString().orEmpty()) else emptyMap())
        }, modifier = Modifier.fillMaxWidth().padding(16.dp)) { Icon(Icons.Default.Add, null); Text("New record", modifier = Modifier.padding(start = 8.dp)) }
    }
    record?.let { request ->
        RecordDialog(data, request.row, request.defaults, onSave = { values ->
            try { update(data.withRow(request.row?.id, values)) } catch (error: Exception) { error.message ?: "Could not save record." }
        }, onClose = { record = null })
    }
    deleteRow?.let { row -> MessageDialog("Delete ${data.rowTitle(row)}?", "This removes the record. You can undo the change in the note editor.", "Delete", "Cancel",
        onConfirm = { update(data.removeRow(row.id)); deleteRow = null }, onDismiss = { deleteRow = null }) }
    if (rename) NameDialog("Rename database", data.title, "Save", { update(data.withTitle(it)); rename = false }, { rename = false })
    if (settings) ViewSettings(data, onUpdate = ::update, onClose = { settings = false })
    if (properties) PropertiesDialog(data, onUpdate = ::update, onClose = { properties = false })
    choice?.let { value -> OptionSheet(value.title, value.values.map { Triple(it.first, it.second, "") }, value.selected, { value.select(it); choice = null }, { choice = null }) }
}

@Composable
private fun DialogFrame(title: String, onClose: () -> Unit, actions: @Composable RowScope.() -> Unit = {}, content: @Composable ColumnScope.() -> Unit) {
    val host = LocalView.current
    val bars = WindowInsets.systemBars
    val height = with(LocalDensity.current) {
        val pixels = host.height.takeIf { it > 0 } ?: host.resources.displayMetrics.heightPixels
        (pixels - bars.getTop(this) - bars.getBottom(this)).coerceAtLeast(1).toDp()
    }
    // Compose's full-width dialog measures against display height, including space used by system bars.
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.height(height).fillMaxWidth(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Close $title") }
                    Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    actions()
                }
                content()
            }
        }
    }
}

@Composable
private fun RowMenu(data: NoteDatabase, row: DatabaseRow, onEdit: () -> Unit, onDuplicate: () -> Unit, onDelete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "Actions for ${data.rowTitle(row)}") }
        DropdownMenu(menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("Edit record") }, onClick = { menu = false; onEdit() })
            DropdownMenuItem(text = { Text("Duplicate record") }, onClick = { menu = false; onDuplicate() })
            DropdownMenuItem(text = { Text("Delete record") }, onClick = { menu = false; onDelete() })
        }
    }
}

@Composable
private fun Table(data: NoteDatabase, rows: List<DatabaseRow>, open: (DatabaseRow) -> Unit, duplicate: (DatabaseRow) -> Unit, remove: (DatabaseRow) -> Unit) {
    val columns = data.visibleColumns()
    if (rows.isEmpty()) { EmptyRecords(data.rows.isEmpty()); return }
    Box(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
        LazyColumn(Modifier.width((columns.size * 160 + 48).dp).fillMaxHeight()) {
            item {
                Row(Modifier.background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(vertical = 12.dp)) {
                    Spacer(Modifier.width(48.dp))
                    columns.forEach { Text(it.name, Modifier.width(160.dp).padding(horizontal = 12.dp), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
            items(rows, key = { it.id }) { row ->
                Surface(onClick = { open(row) }, modifier = Modifier.fillMaxWidth().semantics { role = Role.Button; contentDescription = "Edit ${data.rowTitle(row)}" }) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.heightIn(min = 56.dp)) {
                        RowMenu(data, row, { open(row) }, { duplicate(row) }, { remove(row) })
                        columns.forEach { column ->
                            Text(if (column.type == "checkbox") (if (data.cell(row, column) == "true") "✓" else "—") else data.cell(row, column).ifEmpty { "—" },
                                Modifier.width(160.dp).padding(12.dp), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
}

@Composable
private fun RecordCard(data: NoteDatabase, row: DatabaseRow, open: (DatabaseRow) -> Unit, duplicate: (DatabaseRow) -> Unit, remove: (DatabaseRow) -> Unit, extra: @Composable ColumnScope.() -> Unit = {}) {
    Surface(onClick = { open(row) }, shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth().semantics { role = Role.Button; contentDescription = "Edit ${data.rowTitle(row)}" }) {
        Column(Modifier.padding(start = 12.dp, end = 4.dp, bottom = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(data.rowTitle(row), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                RowMenu(data, row, { open(row) }, { duplicate(row) }, { remove(row) })
            }
            val primary = data.columns.firstOrNull { it.type == "text" } ?: data.columns.first()
            data.visibleColumns().filter { it.id != primary.id && data.cell(row, it).isNotEmpty() }.take(3).forEach { column ->
                Text("${column.name}: ${data.cell(row, column)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            extra()
        }
    }
}

@Composable
private fun Board(data: NoteDatabase, rows: List<DatabaseRow>, open: (DatabaseRow) -> Unit, duplicate: (DatabaseRow) -> Unit, remove: (DatabaseRow) -> Unit,
    onMove: (DatabaseRow, DatabaseColumn, String) -> Unit, onAdd: (Map<String, String>) -> Unit, onProperties: () -> Unit) {
    val column = data.viewColumn("boardColumnId", "select")
    if (column == null) { MissingProperty("select", onProperties); return }
    val groups = (column.options + data.rows.map { data.cell(it, column) } + listOf("")).distinct()
    var move by remember { mutableStateOf<DatabaseRow?>(null) }
    LazyRow(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        items(groups) { group ->
            val members = rows.filter { data.cell(it, column) == group }
            Column(Modifier.width(260.dp).fillMaxHeight()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${group.ifEmpty { "Unassigned" }} · ${members.size}", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                    IconButton(onClick = { onAdd(mapOf(column.id to group)) }) { Icon(Icons.Default.Add, "Add record to ${group.ifEmpty { "Unassigned" }}") }
                }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (members.isEmpty()) item { Text("No matching records", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    items(members, key = { it.id }) { row ->
                        RecordCard(data, row, open, duplicate, remove) { TextButton(onClick = { move = row }) { Text("Move to…") } }
                    }
                }
            }
        }
    }
    move?.let { row -> OptionSheet("Move ${data.rowTitle(row)}", groups.map { Triple(it, it.ifEmpty { "Unassigned" }, "") }, data.cell(row, column), { onMove(row, column, it); move = null }, { move = null }) }
}

@Composable
private fun Calendar(data: NoteDatabase, rows: List<DatabaseRow>, day: LocalDate?, onDay: (LocalDate?) -> Unit, onMonth: (YearMonth) -> Unit,
    open: (DatabaseRow) -> Unit, duplicate: (DatabaseRow) -> Unit, remove: (DatabaseRow) -> Unit, onProperties: () -> Unit) {
    val column = data.viewColumn("calendarColumnId", "date")
    if (column == null) { MissingProperty("date", onProperties); return }
    val month = data.month
    val dates = rows.groupBy { data.cell(it, column) }
    val start = month.atDay(1).minusDays((month.atDay(1).dayOfWeek.value - 1).toLong())
    val agenda = dates[day?.toString().orEmpty()].orEmpty()
    LazyColumn(modifier = Modifier.semantics { contentDescription = "Database calendar" }, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { onMonth(month.minusMonths(1)) }, enabled = month > YearMonth.of(1, 1)) { Icon(Icons.Default.ChevronLeft, "Previous database month") }
                Text(month.format(DateTimeFormatter.ofPattern("MMMM yyyy")), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                TextButton(onClick = { onMonth(YearMonth.now()); onDay(LocalDate.now()) }) { Text("Today") }
                IconButton(onClick = { onMonth(month.plusMonths(1)) }, enabled = month < YearMonth.of(9999, 12)) { Icon(Icons.Default.ChevronRight, "Next database month") }
            }
            Row { listOf("M", "T", "W", "T", "F", "S", "S").forEach { Text(it, Modifier.weight(1f).padding(8.dp), style = MaterialTheme.typography.labelSmall) } }
        }
        items((0..5).toList()) { week ->
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                repeat(7) { offset ->
                    val date = start.plusDays((week * 7 + offset).toLong())
                    Surface(onClick = { onDay(date) }, enabled = YearMonth.from(date) == month,
                        shape = MaterialTheme.shapes.small, color = if (day == date) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
                        modifier = Modifier.weight(1f).semantics { contentDescription = "$date, ${dates[date.toString()].orEmpty().size} records" }) {
                        Column(Modifier.padding(7.dp).heightIn(min = 40.dp)) {
                            Text(date.dayOfMonth.toString(), style = MaterialTheme.typography.labelLarge)
                            Text(dates[date.toString()]?.size?.toString().orEmpty(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        }
        item {
            TextButton(onClick = { onDay(null) }) { Text("Without a date · ${dates[""].orEmpty().size}") }
            Text(day?.format(DateTimeFormatter.ofPattern("EEEE, d MMMM")) ?: "Without a date", style = MaterialTheme.typography.titleMedium)
        }
        if (agenda.isEmpty()) item { Text("No matching records", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(agenda, key = { it.id }) { row -> RecordCard(data, row, open, duplicate, remove) }
    }
}

@Composable
private fun EmptyRecords(empty: Boolean) {
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (empty) "Your database is ready" else "No matching records", style = MaterialTheme.typography.titleMedium)
        Text(if (empty) "Add your first record below." else "Try another search or clear the filters.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun MissingProperty(type: String, onProperties: () -> Unit) {
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Add a $type property to use this view.", style = MaterialTheme.typography.bodyLarge)
        Button(onClick = onProperties) { Text("Manage properties") }
    }
}

@Composable
private fun RecordDialog(data: NoteDatabase, row: DatabaseRow?, defaults: Map<String, String>, onSave: (Map<String, String>) -> String?, onClose: () -> Unit) {
    var values by remember(row?.id) { mutableStateOf(data.columns.associate { it.id to (defaults[it.id] ?: row?.let { record -> data.cell(record, it) }.orEmpty()) }) }
    var problem by remember { mutableStateOf<String?>(null) }
    DialogFrame(if (row == null) "New record" else "Edit record", onClose) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            data.columns.forEach { column -> DatabaseField(column, values[column.id].orEmpty()) { values = values + (column.id to it) } }
        }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) }
        Button(onClick = { problem = onSave(values); if (problem == null) onClose() }, modifier = Modifier.fillMaxWidth().padding(16.dp)) { Text("Save record") }
    }
}

@Composable
private fun DatabaseField(column: DatabaseColumn, value: String, onChange: (String) -> Unit) {
    var picker by remember { mutableStateOf(false) }
    when (column.type) {
        "checkbox" -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(column.name, Modifier.weight(1f)); Checkbox(value.toBoolean(), onCheckedChange = { onChange(it.toString()) }, modifier = Modifier.semantics { contentDescription = column.name })
        }
        "select", "date" -> {
            PickerRow(if (column.type == "date") Icons.Default.CalendarMonth else Icons.AutoMirrored.Filled.List, column.name, value, "Empty", onClick = { picker = true })
            if (picker && column.type == "date") DateDialog(value, allowClear = true, onChange, onDismiss = { picker = false })
            if (picker && column.type == "select") OptionSheet(column.name, (listOf("") + column.options + listOf(value)).distinct().map { Triple(it, it.ifEmpty { "Empty" }, "") }, value,
                { onChange(it); picker = false }, { picker = false })
        }
        else -> OutlinedTextField(value, onValueChange = onChange, label = { Text(column.name) }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = column.name },
            keyboardOptions = KeyboardOptions(keyboardType = if (column.type == "number") KeyboardType.Decimal else KeyboardType.Text), singleLine = column.type == "number", minLines = 1, maxLines = 4)
    }
}

@Composable
private fun ViewSettings(data: NoteDatabase, onUpdate: (NoteDatabase) -> String?, onClose: () -> Unit) {
    var choice by remember { mutableStateOf<Choice?>(null) }
    val latestData by rememberUpdatedState(data)
    val latestUpdate by rememberUpdatedState(onUpdate)
    AlertDialog(onDismissRequest = onClose, title = { Text("Filters and sorting") }, confirmButton = { TextButton(onClick = onClose, modifier = Modifier.semantics { contentDescription = "Close database filters" }) { Text("Done") } },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            val condition = data.condition
            PickerRow(Icons.Default.FilterAlt, "Filter property", data.columns.find { it.id == condition?.optString("columnId") }?.name.orEmpty(), "All records", onClick = {
                choice = Choice("Filter property", listOf("" to "All records") + data.columns.map { it.id to it.name }, condition?.optString("columnId").orEmpty()) { id ->
                    val value = if (latestData.columns.find { it.id == id }?.type == "checkbox") "false" else ""
                    latestUpdate(latestData.withCondition(id.ifEmpty { null }, value))
                }
            })
            data.columns.find { it.id == condition?.optString("columnId") }?.let { column ->
                Text("Matches exactly", style = MaterialTheme.typography.labelSmall)
                DatabaseField(column.copy(name = "Filter value"), condition?.optString("value").orEmpty()) { onUpdate(data.withCondition(column.id, it)) }
            }
            PickerRow(Icons.AutoMirrored.Filled.Sort, "Sort property", data.columns.find { it.id == data.sort?.optString("columnId") }?.name.orEmpty(), "No sorting", onClick = {
                choice = Choice("Sort property", listOf("" to "No sorting") + data.columns.map { it.id to it.name }, data.sort?.optString("columnId").orEmpty()) { id ->
                    latestUpdate(latestData.withSetting("sort", id.takeIf { it.isNotEmpty() }?.let { JSONObject().put("columnId", it).put("direction", "asc") }))
                }
            })
            if (data.sort != null) TextButton(onClick = { onUpdate(data.withSetting("sort", JSONObject(data.sort.toString()).put("direction", if (data.sort?.optString("direction") == "desc") "asc" else "desc"))) }) {
                Text(if (data.sort?.optString("direction") == "desc") "Descending ↓" else "Ascending ↑")
            }
            if (data.layout != "table") {
                val type = if (data.layout == "kanban") "select" else "date"
                val key = if (type == "select") "boardColumnId" else "calendarColumnId"
                PickerRow(Icons.Default.ViewColumn, if (type == "select") "Group by" else "Date property", data.viewColumn(key, type)?.name.orEmpty(), "Add a $type property", onClick = {
                    choice = Choice("Choose $type property", data.columns.filter { it.type == type }.map { it.id to it.name }, data.viewColumn(key, type)?.id.orEmpty()) { latestUpdate(latestData.withSetting(key, it)) }
                })
            }
            TextButton(onClick = { onUpdate(data.withCondition(null)); onClose() }) { Text("Clear property filter") }
        } })
    choice?.let { item -> OptionSheet(item.title, item.values.map { Triple(it.first, it.second, "") }, item.selected, { item.select(it); choice = null }, { choice = null }) }
}

@Composable
private fun PropertiesDialog(data: NoteDatabase, onUpdate: (NoteDatabase) -> String?, onClose: () -> Unit) {
    var edit by remember { mutableStateOf<DatabaseColumn?>(null) }
    var adding by remember { mutableStateOf(false) }
    var remove by remember { mutableStateOf<DatabaseColumn?>(null) }
    AlertDialog(onDismissRequest = onClose, title = { Text("Database properties") }, confirmButton = { TextButton(onClick = onClose, modifier = Modifier.semantics { contentDescription = "Close database properties" }) { Text("Done") } },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            data.columns.forEach { column -> Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { edit = column }, modifier = Modifier.weight(1f)) { Text("${column.name} · ${column.type}") }
                IconButton(onClick = { remove = column }, enabled = data.columns.size > 1) { Icon(Icons.Default.DeleteOutline, "Delete ${column.name} property") }
            } }
            Button(onClick = { adding = true }) { Text("Add property") }
        } })
    if (adding || edit != null) PropertyDialog(edit, onSave = { name, type, options ->
        try { onUpdate(data.withColumn(edit?.id, name, type, options)) } catch (error: Exception) { error.message ?: "Could not save property." }
    }, onClose = { adding = false; edit = null })
    remove?.let { column -> MessageDialog("Delete ${column.name}?", "This removes the property and its values from every record. You can undo the change in the note editor.", "Delete", "Cancel",
        { onUpdate(data.removeColumn(column.id)); remove = null }, { remove = null }) }
}

@Composable
private fun PropertyDialog(column: DatabaseColumn?, onSave: (String, String, List<String>) -> String?, onClose: () -> Unit) {
    var name by remember { mutableStateOf(column?.name.orEmpty()) }
    var type by remember { mutableStateOf(column?.type ?: "text") }
    var options by remember { mutableStateOf(column?.options?.joinToString("\n").orEmpty()) }
    var picker by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    AlertDialog(onDismissRequest = onClose, title = { Text(if (column == null) "Add property" else "Edit property") },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } },
        confirmButton = { TextButton(onClick = {
            val values = options.lines().map { it.trim() }.filter { it.isNotEmpty() }
            problem = if (type == "select" && (values.isEmpty() || values.distinct().size != values.size)) "Enter unique options, one per line." else onSave(name, type, values)
            if (problem == null) onClose()
        }, enabled = name.isNotBlank()) { Text("Save property") } },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(name, onValueChange = { name = it }, label = { Text("Property name") }, singleLine = true)
            PickerRow(Icons.Default.Tune, "Property type", type, onClick = { picker = true })
            if (type == "select") OutlinedTextField(options, onValueChange = { options = it }, label = { Text("Options, one per line") }, minLines = 3, maxLines = 6)
            if (column != null && column.type != type) Text("Changing the type converts existing values. Values that cannot be converted will be cleared.", style = MaterialTheme.typography.bodySmall)
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        } })
    if (picker) OptionSheet("Property type", databaseTypes.map { Triple(it, it.replaceFirstChar { char -> char.uppercase() }, "") }, type, { type = it; picker = false }, { picker = false })
}
