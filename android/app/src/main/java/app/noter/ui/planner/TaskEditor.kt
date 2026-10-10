package app.noter.ui.planner

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Event
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.noter.planner.MAX_TITLE
import app.noter.planner.PlannerException
import app.noter.planner.Repeat
import app.noter.planner.WEEKDAY_NAMES
import app.noter.planner.changedFields
import app.noter.planner.createTask
import app.noter.planner.deleteFollowing
import app.noter.planner.deleteOp
import app.noter.planner.describeRepeat
import app.noter.planner.isoWeekday
import app.noter.planner.positionLabel
import app.noter.planner.skipOccurrence
import app.noter.planner.validDate
import app.noter.state.PlannerViewModel
import app.noter.ui.FullScreenDialog
import app.noter.ui.NoterColors
import app.noter.ui.finance.DateDialog
import app.noter.ui.finance.FieldGroup
import app.noter.ui.finance.PickerRow
import app.noter.ui.finance.SectionLabel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID

private val FREQUENCY_LABELS = listOf("" to "Never", "day" to "Daily", "week" to "Weekly", "month" to "Monthly", "year" to "Yearly")
private val UNITS = mapOf("day" to "day", "week" to "week", "month" to "month", "year" to "year")

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TaskEditor(vm: PlannerViewModel, request: TaskRequest, onClose: () -> Unit) {
    val item = request.item
    val task = item?.task
    val rule = task?.repeat
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf(task?.title ?: "") }
    var date by remember { mutableStateOf(if (task != null) task.date.orEmpty() else request.date.orEmpty()) }
    var frequency by remember { mutableStateOf(rule?.every ?: "") }
    var interval by remember { mutableStateOf((rule?.interval ?: 1).toString()) }
    var weekdays by remember { mutableStateOf(rule?.weekdays?.toSet() ?: emptySet()) }
    var monthly by remember { mutableStateOf(rule?.monthly ?: "day") }
    var ends by remember { mutableStateOf(if (rule?.until != null) "until" else if (rule?.count != null) "count" else "never") }
    var until by remember { mutableStateOf(rule?.until.orEmpty()) }
    var count by remember { mutableStateOf((rule?.count ?: 10).toString()) }
    var error by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var dateOpen by remember { mutableStateOf(false) }
    var untilOpen by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (task == null) focus.requestFocus() }
    val scheduled = validDate(date)
    val start = if (scheduled) LocalDate.parse(date) else null

    fun currentRepeat(): Repeat? {
        if (frequency.isEmpty() || start == null) return null
        val every = interval.toIntOrNull()?.takeIf { it in 1..999 } ?: throw PlannerException("Repeat every 1 to 999 ${UNITS[frequency]}s.")
        val days = if (frequency == "week") (weekdays.ifEmpty { setOf(isoWeekday(start)) }).sorted() else null
        val last = if (ends == "until") until.takeIf(::validDate) ?: throw PlannerException("Choose the last date for this repeat.") else null
        if (last != null && last < date) throw PlannerException("The last date must be on or after the task date.")
        val times = if (ends == "count") count.toIntOrNull()?.takeIf { it in 1..10000 } ?: throw PlannerException("Repeat between 1 and 10,000 times.") else null
        return Repeat(frequency, every, days, if (frequency == "month" && monthly == "weekday") "weekday" else null, last, times)
    }
    val summary = runCatching { currentRepeat()?.let { describeRepeat(it, date) } }.fold({ it.orEmpty() }, { it.message.orEmpty() })

    fun submit() {
        if (saving) return
        try {
            val repeat = currentRepeat()
            val op: JSONObject? = if (task == null) createTask(UUID.randomUUID().toString(), title, date.ifEmpty { null }, repeat, System.currentTimeMillis())
            else changedFields(task, title, date.ifEmpty { null }, repeat)
            if (op == null) { onClose(); return }
            saving = true
            scope.launch {
                if (vm.commit(listOf(op))) onClose() else { error = "Could not save. Your changes are still here."; saving = false }
            }
        } catch (problem: PlannerException) {
            error = problem.message.orEmpty()
        }
    }

    FullScreenDialog(onDismissRequest = { if (!saving) onClose() }) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onClose, enabled = !saving) { Icon(Icons.Default.Close, contentDescription = "Close task editor") }
                    Text(if (task == null) "New task" else "Edit task", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (item != null) TextButton(onClick = { deleting = true }, enabled = !saving) { Text("Delete", color = NoterColors.danger) }
                }
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    OutlinedTextField(
                        value = title, onValueChange = { title = it.take(MAX_TITLE); error = "" }, label = { Text("Task") }, enabled = !saving,
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    )
                    Column {
                        FieldGroup {
                            PickerRow(Icons.Default.CalendarToday, "Date", if (scheduled) longDate(date) else "", placeholder = "Unscheduled", enabled = !saving) { dateOpen = true }
                        }
                        Text(
                            if (scheduled) "Clear the date to move the task to Unscheduled." else "Without a date the task waits in Unscheduled.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp, top = 6.dp),
                        )
                    }
                    if (scheduled && start != null) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SectionLabel("Repeat")
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            for ((value, label) in FREQUENCY_LABELS) FilterChip(selected = frequency == value, onClick = { frequency = value; error = "" }, enabled = !saving, label = { Text(label) })
                        }
                        if (frequency.isNotEmpty()) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("Every")
                                OutlinedTextField(
                                    value = interval, onValueChange = { interval = it.filter(Char::isDigit).take(3) }, singleLine = true, enabled = !saving,
                                    modifier = Modifier.width(88.dp).semantics { contentDescription = "Repeat interval" },
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                )
                                Text(UNITS.getValue(frequency) + if (interval == "1") "" else "s")
                            }
                            if (frequency == "week") {
                                val fallback = isoWeekday(start)
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    WEEKDAY_NAMES.forEachIndexed { index, name ->
                                        val day = index + 1
                                        val on = if (weekdays.isEmpty()) day == fallback else day in weekdays
                                        FilterChip(
                                            selected = on, enabled = !saving, label = { Text(name.take(2)) },
                                            modifier = Modifier.semantics { contentDescription = name },
                                            onClick = {
                                                // The start date's weekday is selected by default; tapping other days adds to it.
                                                val current = weekdays.ifEmpty { setOf(fallback) }
                                                weekdays = if (day !in current) current + day else if (current.size > 1) current - day else current
                                            },
                                        )
                                    }
                                }
                            }
                            if (frequency == "month") FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                FilterChip(selected = monthly == "day", onClick = { monthly = "day" }, enabled = !saving, label = { Text("On day ${start.dayOfMonth}") })
                                FilterChip(selected = monthly == "weekday", onClick = { monthly = "weekday" }, enabled = !saving, label = { Text("On the ${positionLabel(start)}") })
                            }
                            SectionLabel("Ends", Modifier.padding(start = 4.dp, top = 8.dp))
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                for ((value, label) in listOf("never" to "Never", "until" to "On a date", "count" to "After a number of times")) {
                                    FilterChip(selected = ends == value, onClick = { ends = value; error = "" }, enabled = !saving, label = { Text(label) })
                                }
                            }
                            if (ends == "until") FieldGroup { PickerRow(Icons.Default.Event, "Last date", if (validDate(until)) longDate(until) else "", enabled = !saving) { untilOpen = true } }
                            if (ends == "count") OutlinedTextField(
                                value = count, onValueChange = { count = it.filter(Char::isDigit).take(5) }, singleLine = true, enabled = !saving, label = { Text("Times") },
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(140.dp),
                            )
                            if (summary.isNotEmpty()) Text(summary, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                        }
                        if (item?.repeating == true) Text(
                            "Changes apply to every occurrence. This one is on ${longDate(item.on)}.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Box(Modifier.height(8.dp))
                }
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    Button(onClick = ::submit, enabled = !saving && title.isNotBlank(), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                        Text(if (saving) "Saving…" else if (task == null) "Add task" else "Save task", fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }

    if (dateOpen) DateDialog(date, allowClear = true, onChange = { date = it; error = "" }) { dateOpen = false }
    if (untilOpen) DateDialog(until.ifEmpty { date }, allowClear = false, onChange = { until = it; error = "" }) { untilOpen = false }
    if (deleting && item != null) {
        fun remove(op: JSONObject) {
            deleting = false; saving = true
            scope.launch { if (vm.commit(listOf(op))) onClose() else { error = "Could not delete. Reload Planner and try again."; saving = false } }
        }
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("Delete “${item.task.title}”?") },
            text = {
                if (item.repeating) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("This is a repeating task. Choose what to delete, starting from ${longDate(item.on)}.")
                    OutlinedButton(onClick = { remove(skipOccurrence(item)) }, modifier = Modifier.fillMaxWidth()) { Text("Only this occurrence") }
                    OutlinedButton(onClick = { remove(deleteFollowing(item)) }, modifier = Modifier.fillMaxWidth()) { Text("This and following") }
                    OutlinedButton(onClick = { remove(deleteOp(item.task.id)) }, modifier = Modifier.fillMaxWidth()) { Text("All occurrences", color = NoterColors.danger) }
                } else Text("This task is removed on every device that syncs this folder.")
            },
            confirmButton = { if (!item.repeating) TextButton(onClick = { remove(deleteOp(item.task.id)) }) { Text("Delete", color = NoterColors.danger) } },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } },
        )
    }
}
