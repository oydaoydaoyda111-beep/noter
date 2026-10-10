package app.noter.ui.planner

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.noter.planner.Occurrence
import app.noter.planner.Planner
import app.noter.planner.asOccurrence
import app.noter.planner.createTask
import app.noter.planner.describeRepeat
import app.noter.planner.isoWeekday
import app.noter.planner.moveOccurrence
import app.noter.planner.occurrencesBetween
import app.noter.planner.overdue
import app.noter.planner.setDone
import app.noter.planner.unschedule
import app.noter.planner.unscheduled
import app.noter.state.PlannerViewModel
import app.noter.ui.NoterColors
import app.noter.ui.finance.DateDialog
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale
import java.util.UUID

private enum class PlannerTab { Day, Overdue, Unscheduled }

/** What the editor opens: an existing occurrence or a new task with an optional date. */
internal class TaskRequest(val item: Occurrence?, val date: String?)

private val longFormat: DateTimeFormatter = DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL)
private val shortFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())
internal fun longDate(date: String): String = runCatching { LocalDate.parse(date).format(longFormat) }.getOrDefault(date)
internal fun shortDate(date: String): String = runCatching { LocalDate.parse(date).format(shortFormat) }.getOrDefault(date)

@Composable
fun PlannerScreen(vm: PlannerViewModel, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var today by remember { mutableStateOf(LocalDate.now().toString()) }
    var selected by rememberSaveable { mutableStateOf(today) }
    var month by rememberSaveable { mutableStateOf(today.substring(0, 7)) }
    var tab by rememberSaveable { mutableStateOf(PlannerTab.Day) }
    var editor by remember { mutableStateOf<TaskRequest?>(null) }
    var picking by remember { mutableStateOf<Occurrence?>(null) }
    SideEffect { vm.dialogOpen = editor != null || picking != null }
    // Midnight changes what counts as today and overdue.
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(60_000)
            val now = LocalDate.now().toString()
            if (now != today) { if (selected == today) selected = now; today = now }
        }
    }
    fun commit(ops: List<JSONObject>) { scope.launch { vm.commit(ops) } }

    Box(modifier.fillMaxSize()) {
        when {
            !vm.loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            vm.loadError -> Column(
                Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(vm.status, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                Button(onClick = vm::reload) { Text("Reload Planner") }
            }
            else -> {
                val planner = vm.planner
                val late = remember(planner, today) { overdue(planner, today) }
                val loose = remember(planner) { unscheduled(planner) }
                val shown = YearMonth.parse(month)
                val grid = remember(month) { monthDays(shown) }
                val monthItems = remember(planner, month) { occurrencesBetween(planner, grid.first().toString(), grid.last().toString()).groupBy { it.date } }
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                    item {
                        MonthHeader(shown, onMonth = { month = it.toString() }, onToday = { selected = today; month = today.substring(0, 7); tab = PlannerTab.Day })
                    }
                    item {
                        MonthGrid(shown, grid, monthItems, today, selected, onSelect = { selected = it; tab = PlannerTab.Day; if (it.substring(0, 7) != month) month = it.substring(0, 7) }, onSwipe = { month = shown.plusMonths(it.toLong()).toString() })
                    }
                    item {
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                            val tabs = listOf(PlannerTab.Day to dayTabLabel(selected, today), PlannerTab.Overdue to "Overdue · ${late.size}", PlannerTab.Unscheduled to "Unscheduled · ${loose.count { !it.done }}")
                            tabs.forEachIndexed { index, (value, label) ->
                                SegmentedButton(
                                    selected = tab == value, onClick = { tab = value }, shape = SegmentedButtonDefaults.itemShape(index, tabs.size),
                                    icon = {}, label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium) },
                                )
                            }
                        }
                    }
                    when (tab) {
                        PlannerTab.Day -> {
                            val list = occurrencesBetween(planner, selected, selected)
                            item { ListHeading(longDate(selected)) }
                            if (list.isEmpty()) item { Hint("Nothing planned. Tap + to add a task for this day.") }
                            items(list, key = { "${it.task.id}/${it.on}" }) { item ->
                                TaskRow(item, today, showDate = false, busy = vm.busy, planner = planner, onCommit = ::commit, onOpen = { editor = TaskRequest(item, null) }, onPick = { picking = item })
                            }
                        }
                        PlannerTab.Overdue -> {
                            item {
                                Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    ListHeading("Overdue", Modifier.weight(1f).padding(0.dp))
                                    if (late.size > 1) TextButton(onClick = { commit(late.map { moveOccurrence(planner, it, today) }) }, enabled = !vm.busy) { Text("Move all to today") }
                                }
                            }
                            if (late.isEmpty()) item { Hint("Nothing overdue. Tasks left open after their day appear here.") }
                            items(late.takeLast(OVERDUE_LIMIT).reversed(), key = { "${it.task.id}/${it.on}" }) { item ->
                                TaskRow(item, today, showDate = true, busy = vm.busy, planner = planner, onCommit = ::commit, onOpen = { editor = TaskRequest(item, null) }, onPick = { picking = item })
                            }
                            if (late.size > OVERDUE_LIMIT) item { Hint("${late.size - OVERDUE_LIMIT} older overdue tasks are not shown. Complete or move recent ones first.") }
                        }
                        PlannerTab.Unscheduled -> {
                            item { QuickAdd(enabled = !vm.busy) { title -> commit(listOf(createTask(UUID.randomUUID().toString(), title, null, null, System.currentTimeMillis()))) } }
                            if (loose.isEmpty()) item { Hint("Tasks without a date wait here. Use “Schedule” to put one on the calendar.") }
                            items(loose, key = { it.id }) { task ->
                                val item = task.asOccurrence()
                                TaskRow(item, today, showDate = false, busy = vm.busy, planner = planner, onCommit = ::commit, onOpen = { editor = TaskRequest(item, null) }, onPick = { picking = item })
                            }
                        }
                    }
                    if (vm.status.isNotEmpty()) item {
                        Text(vm.status, style = MaterialTheme.typography.bodySmall, color = if (vm.statusIsError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
                    }
                }
                FloatingActionButton(
                    onClick = { editor = TaskRequest(null, if (tab == PlannerTab.Unscheduled) null else selected) },
                    modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
                    containerColor = MaterialTheme.colorScheme.primary, contentColor = NoterColors.onAccent,
                ) { Icon(Icons.Default.Add, contentDescription = "New task") }
            }
        }
    }

    editor?.let { request ->
        TaskEditor(vm, request, onClose = { editor = null })
    }
    picking?.let { item ->
        DateDialog(item.date.ifEmpty { selected }, allowClear = !item.repeating && item.task.date != null, onChange = { value ->
            val ops = when {
                value.isEmpty() -> listOf(unschedule(item.task))
                value == item.date -> emptyList()
                else -> listOf(moveOccurrence(vm.planner, item, value))
            }
            if (ops.isNotEmpty()) commit(ops)
        }) { picking = null }
    }
}

private const val OVERDUE_LIMIT = 60

private fun dayTabLabel(selected: String, today: String): String = when (selected) {
    today -> "Today"
    LocalDate.parse(today).plusDays(1).toString() -> "Tomorrow"
    else -> shortDate(selected)
}

/** Six Monday-first weeks covering [month]. */
private fun monthDays(month: YearMonth): List<LocalDate> {
    val first = month.atDay(1)
    val start = first.minusDays((isoWeekday(first) - 1).toLong())
    return List(42) { start.plusDays(it.toLong()) }
}

@Composable
private fun MonthHeader(month: YearMonth, onMonth: (YearMonth) -> Unit, onToday: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            "${month.month.getDisplayName(TextStyle.FULL_STANDALONE, Locale.getDefault())} ${month.year}",
            style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() },
        )
        TextButton(onClick = onToday) { Text("Today") }
        IconButton(onClick = { onMonth(month.minusMonths(1)) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Previous month") }
        IconButton(onClick = { onMonth(month.plusMonths(1)) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Next month") }
    }
}

@Composable
private fun MonthGrid(month: YearMonth, days: List<LocalDate>, items: Map<String, List<Occurrence>>, today: String, selected: String, onSelect: (String) -> Unit, onSwipe: (Int) -> Unit) {
    var drag by remember { mutableStateOf(0f) }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp).pointerInput(month) {
            detectHorizontalDragGestures(
                onDragStart = { drag = 0f },
                onDragEnd = { if (drag > 120) onSwipe(-1) else if (drag < -120) onSwipe(1) },
            ) { _, amount -> drag += amount }
        },
    ) {
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            for (name in listOf("M", "T", "W", "T", "F", "S", "S")) {
                Text(name, Modifier.weight(1f), textAlign = TextAlign.Center, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        for (week in 0 until 6) Row(Modifier.fillMaxWidth()) {
            for (date in days.subList(week * 7, week * 7 + 7)) {
                val iso = date.toString()
                DayCell(date, items[iso].orEmpty(), inMonth = date.monthValue == month.monthValue, isToday = iso == today, isPast = iso < today, isSelected = iso == selected, modifier = Modifier.weight(1f)) { onSelect(iso) }
            }
        }
    }
}

@Composable
private fun DayCell(date: LocalDate, items: List<Occurrence>, inMonth: Boolean, isToday: Boolean, isPast: Boolean, isSelected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val open = items.count { !it.done }
    val description = "${longDate(date.toString())}${if (isToday) ", today" else ""}, " +
        if (items.isEmpty()) "no tasks" else "${items.size} ${if (items.size == 1) "task" else "tasks"}${if (open != items.size) ", $open open" else ""}"
    Column(
        modifier.aspectRatio(0.92f).padding(2.dp).clip(RoundedCornerShape(12.dp))
            .background(if (isSelected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = description; selected = isSelected; role = Role.Button },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier.size(30.dp).then(if (isToday) Modifier.background(MaterialTheme.colorScheme.primary, CircleShape) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                date.dayOfMonth.toString(), style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (isToday || isSelected) FontWeight.SemiBold else FontWeight.Normal,
                color = when {
                    isToday -> NoterColors.onAccent
                    !inMonth -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f)
                    else -> MaterialTheme.colorScheme.onSurface
                },
            )
        }
        Row(Modifier.height(10.dp).padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            // Up to three dots: open tasks first; overdue ones in the danger color.
            for (item in items.sortedBy { it.done }.take(3)) {
                val color = when {
                    item.done -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                    isPast -> NoterColors.danger
                    else -> MaterialTheme.colorScheme.primary
                }
                Box(Modifier.size(5.dp).background(color, CircleShape))
            }
        }
    }
}

@Composable
private fun ListHeading(text: String, modifier: Modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 4.dp)) {
    Text(text, style = MaterialTheme.typography.titleSmall, modifier = modifier.semantics { heading() })
}

@Composable
private fun Hint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
}

@Composable
private fun QuickAdd(enabled: Boolean, onAdd: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    fun submit() { if (text.isNotBlank()) { onAdd(text); text = "" } }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = text, onValueChange = { text = it.take(app.noter.planner.MAX_TITLE) }, singleLine = true, enabled = enabled,
            placeholder = { Text("Add a task…") }, modifier = Modifier.weight(1f),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { submit() }),
        )
        IconButton(onClick = ::submit, enabled = enabled && text.isNotBlank()) { Icon(Icons.Default.Add, contentDescription = "Add unscheduled task") }
    }
}

@Composable
private fun TaskRow(item: Occurrence, today: String, showDate: Boolean, busy: Boolean, planner: Planner, onCommit: (List<JSONObject>) -> Unit, onOpen: () -> Unit, onPick: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val late = !item.done && item.date.isNotEmpty() && item.date < today
    Surface(
        onClick = onOpen, enabled = !busy,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
        shape = RoundedCornerShape(14.dp),
        color = if (late) NoterColors.danger.copy(alpha = 0.08f) else MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Row(Modifier.heightIn(min = 56.dp).padding(start = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(
                checked = item.done, enabled = !busy,
                onCheckedChange = { onCommit(listOf(setDone(planner, item, it))) },
                modifier = Modifier.semantics { contentDescription = "${if (item.done) "Reopen" else "Complete"} ${item.task.title}" },
            )
            Column(Modifier.weight(1f).padding(vertical = 8.dp).alpha(if (item.done) 0.6f else 1f)) {
                Text(
                    item.task.title, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    textDecoration = if (item.done) TextDecoration.LineThrough else null,
                    color = if (late) NoterColors.danger else MaterialTheme.colorScheme.onSurface,
                )
                val details = buildList {
                    if (showDate && item.date.isNotEmpty()) add(shortDate(item.date))
                    item.task.activeRepeat?.let { add(describeRepeat(it, item.task.date!!)) }
                    if (item.repeating && item.date != item.on) add("moved from ${shortDate(item.on)}")
                }
                if (details.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                    if (item.repeating) Icon(Icons.Default.Repeat, contentDescription = null, modifier = Modifier.size(14.dp).padding(end = 4.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(details.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Box {
                IconButton(onClick = { menu = true }, enabled = !busy) { Icon(Icons.Default.MoreVert, contentDescription = "Actions for ${item.task.title}") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    val tomorrow = LocalDate.parse(today).plusDays(1).toString()
                    if (item.date != today) DropdownMenuItem(text = { Text(if (item.date.isEmpty()) "Schedule for today" else "Move to today") }, onClick = { menu = false; onCommit(listOf(schedule(planner, item, today))) })
                    if (item.date != tomorrow) DropdownMenuItem(text = { Text(if (item.date.isEmpty()) "Schedule for tomorrow" else "Move to tomorrow") }, onClick = { menu = false; onCommit(listOf(schedule(planner, item, tomorrow))) })
                    DropdownMenuItem(text = { Text(if (item.date.isEmpty()) "Schedule…" else "Pick a date…") }, onClick = { menu = false; onPick() })
                    if (!item.repeating && item.date.isNotEmpty()) DropdownMenuItem(text = { Text("Move to Unscheduled") }, onClick = { menu = false; onCommit(listOf(unschedule(item.task))) })
                    DropdownMenuItem(text = { Text("Edit…") }, onClick = { menu = false; onOpen() })
                }
            }
        }
    }
}

/** Unscheduled and single tasks get the date; for a series only this occurrence moves. */
private fun schedule(planner: Planner, item: Occurrence, date: String): JSONObject = moveOccurrence(planner, item, date)
