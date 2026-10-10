package app.noter.planner

import org.json.JSONArray
import org.json.JSONObject
import java.time.DateTimeException
import java.time.LocalDate
import java.time.YearMonth

// Planner is stored as one append-only log per device in .noter/planner/log-<device>.jsonl,
// like Finance. Each line is a batch; replaying every batch ordered by (ts, dev, seq) gives the
// current tasks. Changes are recorded per field and per occurrence, so completing a task on the
// phone and renaming another (or the same) task on the desktop at the same time both survive.
// The desktop client implements the same format in src/planner/model.ts; keep both in step.

class PlannerException(message: String) : Exception(message)

const val MAX_TITLE = 500
private const val MAX_SAFE = 9_007_199_254_740_991L
private val FREQUENCIES = listOf("day", "week", "month", "year")
private val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")

data class Repeat(
    val every: String,
    val interval: Int,
    /** ISO weekdays (Monday = 1) for weekly rules; null means the start date's weekday. */
    val weekdays: List<Int>? = null,
    /** "weekday" repeats monthly on the start date's weekday position; null means its day number. */
    val monthly: String? = null,
    val until: String? = null,
    val count: Int? = null,
)

data class Task(val id: String, val title: String, val date: String?, val repeat: Repeat?, val done: Boolean, val created: Long) {
    /** The repeat rule actually in effect: a rule needs a start date. */
    val activeRepeat: Repeat? get() = if (date != null) repeat else null
}

/** How one occurrence of a repeating task differs from its rule, keyed by the date the rule produces. */
data class OccurrenceChange(val done: Boolean = false, val skip: Boolean = false, val move: String? = null) {
    val isEmpty: Boolean get() = !done && !skip && move == null
}

class Planner(val tasks: Map<String, Task>, val exceptions: Map<String, Map<String, OccurrenceChange>>) {
    companion object { val EMPTY = Planner(emptyMap(), emptyMap()) }
}

class LogFile(val name: String, val text: String)

/** A parsed operation. Task field values are typed: String, String?/null date, Repeat?, Boolean, Long. */
sealed class PlannerOp {
    data class SetFields(val id: String, val fields: Map<String, Any?>) : PlannerOp()
    data class Delete(val id: String) : PlannerOp()
    data class Occurrence(val id: String, val on: String, val value: OccurrenceChange?) : PlannerOp()
}

class PlannerBatch(val ts: Long, val dev: String, val seq: Long, val ops: List<PlannerOp>, val raw: JSONArray)

class ParsedPlannerLogs(val batches: List<PlannerBatch>, val clock: Long, val seq: Long, val ownNeedsNewline: Boolean)

private fun invalid(): Nothing = throw PlannerException("Planner log contains invalid data. Keep the files and restore a valid backup before editing.")

fun validDate(value: Any?): Boolean {
    if (value !is String || !DATE.matches(value)) return false
    return try { LocalDate.parse(value).let { it.year >= 1000 && it.toString() == value } } catch (_: DateTimeException) { false }
}

fun validTitle(value: Any?): Boolean = value is String && value.isNotBlank() && value.length <= MAX_TITLE

private fun safeInteger(value: Any?): Long? {
    val number = (value as? Number)?.toDouble() ?: return null
    return number.takeIf { it.isFinite() && it % 1.0 == 0.0 && it >= -MAX_SAFE && it <= MAX_SAFE }?.toLong()
}

private fun integerIn(value: Any?, min: Long, max: Long): Long? = safeInteger(value)?.takeIf { it in min..max }

private fun validId(value: Any?): String? = (value as? String)?.takeIf { it.isNotEmpty() && it.length <= 200 }

/** Validates a repeat rule and returns it in canonical form, or null when it is malformed. */
fun repeatFromJson(value: Any?): Repeat? {
    if (value !is JSONObject) return null
    val every = value.opt("every") as? String ?: return null
    if (every !in FREQUENCIES) return null
    val interval = integerIn(value.opt("interval"), 1, 999)?.toInt() ?: return null
    var weekdays: List<Int>? = null
    if (every == "week" && value.has("weekdays")) {
        val array = value.opt("weekdays") as? JSONArray ?: return null
        if (array.length() == 0) return null
        weekdays = List(array.length()) { integerIn(array.opt(it), 1, 7)?.toInt() ?: return null }.distinct().sorted()
    }
    var monthly: String? = null
    if (every == "month" && value.has("monthly")) {
        when (value.opt("monthly")) { "day" -> {}; "weekday" -> monthly = "weekday"; else -> return null }
    }
    var until: String? = null
    if (value.has("until")) { until = value.opt("until") as? String; if (!validDate(until)) return null }
    var count: Int? = null
    if (value.has("count")) count = integerIn(value.opt("count"), 1, 10000)?.toInt() ?: return null
    return Repeat(every, interval, weekdays, monthly, until, count)
}

fun repeatToJson(rule: Repeat): JSONObject = JSONObject().apply {
    put("every", rule.every); put("interval", rule.interval)
    rule.weekdays?.let { put("weekdays", JSONArray(it)) }
    rule.monthly?.let { put("monthly", it) }
    rule.until?.let { put("until", it) }
    rule.count?.let { put("count", it) }
}

/** Known task fields are validated; unknown ones are ignored so newer clients can add fields. */
private fun fieldsFromJson(value: Any?): Map<String, Any?> {
    if (value !is JSONObject) invalid()
    val fields = LinkedHashMap<String, Any?>()
    if (value.has("title")) { val title = value.opt("title"); if (!validTitle(title)) invalid(); fields["title"] = title }
    if (value.has("date")) { val date = value.opt("date"); if (date != JSONObject.NULL && !validDate(date)) invalid(); fields["date"] = date.takeIf { it != JSONObject.NULL } }
    if (value.has("repeat")) { val repeat = value.opt("repeat"); fields["repeat"] = if (repeat == JSONObject.NULL) null else repeatFromJson(repeat) ?: invalid() }
    if (value.has("done")) fields["done"] = value.opt("done") as? Boolean ?: invalid()
    if (value.has("created")) fields["created"] = integerIn(value.opt("created"), 0, MAX_SAFE) ?: invalid()
    return fields
}

private fun changeFromJson(value: Any?): OccurrenceChange? {
    if (value == JSONObject.NULL) return null
    if (value !is JSONObject) invalid()
    var change = OccurrenceChange()
    if (value.has("done")) { if (value.opt("done") != true) invalid(); change = change.copy(done = true) }
    if (value.has("skip")) { if (value.opt("skip") != true) invalid(); change = change.copy(skip = true) }
    if (value.has("move")) { val move = value.opt("move"); if (!validDate(move)) invalid(); change = change.copy(move = move as String) }
    return change.takeUnless { it.isEmpty }
}

fun changeToJson(change: OccurrenceChange?): Any = if (change == null || change.isEmpty) JSONObject.NULL else JSONObject().apply {
    if (change.done) put("done", true)
    if (change.skip) put("skip", true)
    change.move?.let { put("move", it) }
}

/** Unknown operation kinds are skipped for forward compatibility; known ones must be valid. */
private fun opsFromJson(array: JSONArray): List<PlannerOp> {
    val ops = ArrayList<PlannerOp>()
    for (index in 0 until array.length()) {
        val op = array.opt(index) as? JSONObject ?: invalid()
        val kind = op.opt("k") as? String ?: invalid()
        when (kind) {
            "task" -> ops += PlannerOp.SetFields(validId(op.opt("id")) ?: invalid(), fieldsFromJson(op.opt("set")))
            "del" -> ops += PlannerOp.Delete(validId(op.opt("id")) ?: invalid())
            "occ" -> {
                val id = validId(op.opt("id")) ?: invalid()
                val on = op.opt("on")
                if (!validDate(on) || !op.has("value")) invalid()
                ops += PlannerOp.Occurrence(id, on as String, changeFromJson(op.opt("value")))
            }
        }
    }
    return ops
}

private fun sameJson(left: Any?, right: Any?): Boolean = when {
    left is Number && right is Number -> left.toDouble() == right.toDouble()
    left is JSONArray && right is JSONArray -> left.length() == right.length() && (0 until left.length()).all { sameJson(left.opt(it), right.opt(it)) }
    left is JSONObject && right is JSONObject -> left.length() == right.length() && left.keys().asSequence().all { right.has(it) && sameJson(left.opt(it), right.opt(it)) }
    else -> left == right
}

/** Parses every log file. A final line without a newline is an interrupted write and is ignored. */
fun parsePlannerLogs(files: List<LogFile>, device: String, parse: (String) -> JSONObject): ParsedPlannerLogs {
    val seen = LinkedHashMap<String, PlannerBatch>()
    var clock = 0L
    var seq = 0L
    var ownNeedsNewline = false
    for (file in files) {
        val lines = file.text.split('\n')
        if (lines.last().isNotBlank() && file.name == "log-$device.jsonl") ownNeedsNewline = true
        for (line in lines.dropLast(1)) {
            if (line.isBlank()) continue
            val json = try { parse(line) } catch (_: Exception) { invalid() }
            if (safeInteger(json.opt("v")) != 1L) invalid()
            val ts = safeInteger(json.opt("ts")) ?: invalid()
            val dev = validId(json.opt("dev")) ?: invalid()
            val batchSeq = safeInteger(json.opt("seq")) ?: invalid()
            val raw = json.opt("ops") as? JSONArray ?: invalid()
            val batch = PlannerBatch(ts, dev, batchSeq, opsFromJson(raw), raw)
            val identity = "$dev\u0000$batchSeq"
            val previous = seen[identity]
            if (previous != null && (previous.ts != ts || !sameJson(previous.raw, raw))) {
                throw PlannerException("Planner logs contain conflicting batches from the same device. Both versions have been kept. Resolve the conflicting log copies before editing.")
            }
            if (previous == null) seen[identity] = batch
            clock = maxOf(clock, ts)
            if (dev == device) seq = maxOf(seq, batchSeq)
        }
    }
    return ParsedPlannerLogs(seen.values.toList(), clock, seq, ownNeedsNewline)
}

/** Replays batches. Per field, the latest change wins; a deletion is final for that task. */
fun replayPlanner(batches: List<PlannerBatch>): Planner {
    val ordered = batches.sortedWith(compareBy<PlannerBatch> { it.ts }.thenBy { it.dev }.thenBy { it.seq })
    val fields = LinkedHashMap<String, MutableMap<String, Any?>>()
    val deleted = HashSet<String>()
    val exceptions = LinkedHashMap<String, MutableMap<String, OccurrenceChange>>()
    for (batch in ordered) for (op in batch.ops) {
        val id = when (op) { is PlannerOp.SetFields -> op.id; is PlannerOp.Delete -> op.id; is PlannerOp.Occurrence -> op.id }
        if (id in deleted) continue
        when (op) {
            is PlannerOp.Delete -> { deleted += id; fields.remove(id); exceptions.remove(id) }
            is PlannerOp.SetFields -> fields.getOrPut(id) { LinkedHashMap() }.putAll(op.fields)
            is PlannerOp.Occurrence -> {
                val map = exceptions.getOrPut(id) { LinkedHashMap() }
                if (op.value != null) map[op.on] = op.value else map.remove(op.on)
            }
        }
    }
    val tasks = LinkedHashMap<String, Task>()
    for ((id, value) in fields) {
        // A task created on one device can lose its creating batch only through damage; skip untitled fragments.
        val title = value["title"] as? String ?: continue
        tasks[id] = Task(id, title, value["date"] as String?, value["repeat"] as Repeat?, value["done"] as? Boolean ?: false, value["created"] as? Long ?: 0L)
    }
    return Planner(tasks, exceptions.filterKeys { it in tasks })
}

fun batchLine(device: String, clock: Long, seq: Long, ops: List<JSONObject>): Pair<String, Long> {
    val ts = maxOf(System.currentTimeMillis(), clock + 1)
    if (ts !in -MAX_SAFE..MAX_SAFE || seq !in -MAX_SAFE..MAX_SAFE) throw PlannerException("Planner log timestamp or sequence is outside the supported range.")
    val line = JSONObject().put("v", 1).put("ts", ts).put("dev", device).put("seq", seq).put("ops", JSONArray(ops)).toString()
    return "$line\n" to ts
}

// ---- Recurrence ---------------------------------------------------------------------------

fun isoWeekday(date: LocalDate): Int = date.dayOfWeek.value

/** Position used by "monthly on the Nth weekday": 1–4, or -1 for the last one when the start falls on day 29 or later. */
fun weekdayPosition(date: LocalDate): Int = if (date.dayOfMonth > 28) -1 else (date.dayOfMonth + 6) / 7

private fun nthWeekday(month: YearMonth, isoDay: Int, nth: Int): LocalDate {
    if (nth > 0) {
        val first = month.atDay(1)
        return first.plusDays(((isoDay - isoWeekday(first) + 7) % 7 + (nth - 1) * 7).toLong())
    }
    val last = month.atEndOfMonth()
    return last.minusDays(((isoWeekday(last) - isoDay + 7) % 7).toLong())
}

/**
 * Epoch days the rule produces from its start date through [limit], in order, before exceptions.
 * Counted rules count these generated dates, including skipped or moved occurrences.
 */
fun seriesDays(start: String, rule: Repeat, limit: Long): List<Long> {
    val result = ArrayList<Long>()
    val startDate = LocalDate.parse(start)
    val first = startDate.toEpochDay()
    val end = minOf(limit, rule.until?.let { LocalDate.parse(it).toEpochDay() } ?: Long.MAX_VALUE)
    val max = rule.count ?: Int.MAX_VALUE
    fun push(day: Long) { if (day in first..end && result.size < max) result += day }
    if (end < first) return result
    when (rule.every) {
        "day" -> { var current = first; while (current <= end && result.size < max) { push(current); current += rule.interval } }
        "week" -> {
            val days = rule.weekdays ?: listOf(isoWeekday(startDate))
            var week = first - (isoWeekday(startDate) - 1)
            while (week <= end && result.size < max) { for (day in days) push(week + day - 1); week += 7L * rule.interval }
        }
        "month" -> {
            val position = weekdayPosition(startDate)
            val isoDay = isoWeekday(startDate)
            var month = YearMonth.from(startDate)
            while (result.size < max) {
                if (month.atDay(1).toEpochDay() > end) break
                val date = if (rule.monthly == "weekday") nthWeekday(month, isoDay, position) else month.atDay(minOf(startDate.dayOfMonth, month.lengthOfMonth()))
                push(date.toEpochDay())
                month = month.plusMonths(rule.interval.toLong())
            }
        }
        else -> {
            var year = startDate.year
            while (result.size < max) {
                if (LocalDate.of(year, 1, 1).toEpochDay() > end) break
                val month = YearMonth.of(year, startDate.monthValue)
                push(month.atDay(minOf(startDate.dayOfMonth, month.lengthOfMonth())).toEpochDay())
                year += rule.interval
            }
        }
    }
    return result
}

data class Occurrence(
    val task: Task,
    /** The date the task or rule assigns; identifies the occurrence. */
    val on: String,
    /** Where the occurrence is shown, after any move. */
    val date: String,
    val done: Boolean,
    val repeating: Boolean,
)

private val MAX_DAY = LocalDate.of(9999, 12, 31).toEpochDay()

val occurrenceOrder: Comparator<Occurrence> = compareBy<Occurrence> { it.date }.thenBy { it.done }.thenBy { it.task.created }.thenBy { it.task.id }.thenBy { it.on }

/** Occurrences displayed from [from] through [to] (inclusive), sorted by date, open first, then creation. */
fun occurrencesBetween(planner: Planner, from: String, to: String): List<Occurrence> {
    val start = LocalDate.parse(from).toEpochDay()
    val end = LocalDate.parse(to).toEpochDay()
    val result = ArrayList<Occurrence>()
    for (task in planner.tasks.values) {
        val date = task.date ?: continue
        val rule = task.activeRepeat
        if (rule == null) {
            if (date in from..to) result += Occurrence(task, date, date, task.done, false)
            continue
        }
        val exceptions = planner.exceptions[task.id].orEmpty()
        // Occurrences after the range can be moved into it; generate far enough to recognise them.
        var limit = end
        for ((on, change) in exceptions) if (change.move != null && change.move in from..to) limit = maxOf(limit, LocalDate.parse(on).toEpochDay())
        for (day in seriesDays(date, rule, minOf(limit, MAX_DAY))) {
            val on = LocalDate.ofEpochDay(day).toString()
            val change = exceptions[on]
            if (change?.skip == true) continue
            val shown = change?.move ?: on
            val shownDay = if (change?.move != null) LocalDate.parse(change.move).toEpochDay() else day
            if (shownDay in start..end) result += Occurrence(task, on, shown, change?.done == true, true)
        }
    }
    return result.sortedWith(occurrenceOrder)
}

/** Open occurrences shown before [today], oldest first. */
fun overdue(planner: Planner, today: String): List<Occurrence> =
    occurrencesBetween(planner, "1000-01-01", LocalDate.parse(today).minusDays(1).toString()).filter { !it.done }

/** Tasks without a date, open first, oldest first. */
fun unscheduled(planner: Planner): List<Task> =
    planner.tasks.values.filter { it.date == null }.sortedWith(compareBy<Task> { it.done }.thenBy { it.created }.thenBy { it.id })

/** A single task is an occurrence of itself; unscheduled tasks have no date. */
fun Task.asOccurrence(): Occurrence = Occurrence(this, date.orEmpty(), date.orEmpty(), done, false)

// ---- Edits --------------------------------------------------------------------------------

private fun setOp(id: String, fields: JSONObject) = JSONObject().put("k", "task").put("id", id).put("set", fields)
private fun occOp(id: String, on: String, change: OccurrenceChange?) = JSONObject().put("k", "occ").put("id", id).put("on", on).put("value", changeToJson(change))
fun deleteOp(id: String): JSONObject = JSONObject().put("k", "del").put("id", id)

fun createTask(id: String, title: String, date: String?, repeat: Repeat?, created: Long): JSONObject {
    val trimmed = title.trim()
    if (!validTitle(trimmed)) throw PlannerException("Enter a task title up to $MAX_TITLE characters.")
    return setOp(id, JSONObject().put("title", trimmed).put("date", date ?: JSONObject.NULL)
        .put("repeat", if (date != null && repeat != null) repeatToJson(repeat) else JSONObject.NULL).put("done", false).put("created", created))
}

/** Marks one occurrence done or open. */
fun setDone(planner: Planner, item: Occurrence, done: Boolean): JSONObject {
    if (!item.repeating) return setOp(item.task.id, JSONObject().put("done", done))
    val current = planner.exceptions[item.task.id]?.get(item.on) ?: OccurrenceChange()
    return occOp(item.task.id, item.on, current.copy(done = done))
}

/** Moves one occurrence to another day; for repeating tasks only that occurrence moves. */
fun moveOccurrence(planner: Planner, item: Occurrence, date: String): JSONObject {
    if (!item.repeating) return setOp(item.task.id, JSONObject().put("date", date))
    val current = planner.exceptions[item.task.id]?.get(item.on) ?: OccurrenceChange()
    return occOp(item.task.id, item.on, current.copy(move = date.takeIf { it != item.on }))
}

fun unschedule(task: Task): JSONObject = setOp(task.id, JSONObject().put("date", JSONObject.NULL))

fun skipOccurrence(item: Occurrence): JSONObject = occOp(item.task.id, item.on, OccurrenceChange(skip = true))

/** Ends a series before this occurrence; deleting from the first occurrence deletes the task. */
fun deleteFollowing(item: Occurrence): JSONObject {
    val rule = item.task.activeRepeat
    if (rule == null || item.on <= item.task.date!!) return deleteOp(item.task.id)
    return setOp(item.task.id, JSONObject().put("repeat", repeatToJson(rule.copy(until = LocalDate.parse(item.on).minusDays(1).toString()))))
}

/** Fields that differ between a task and its edited version, or null when nothing changed. */
fun changedFields(task: Task, title: String, date: String?, repeat: Repeat?): JSONObject? {
    val trimmed = title.trim()
    if (!validTitle(trimmed)) throw PlannerException("Enter a task title up to $MAX_TITLE characters.")
    val set = JSONObject()
    if (trimmed != task.title) set.put("title", trimmed)
    if (date != task.date) set.put("date", date ?: JSONObject.NULL)
    val rule = if (date != null) repeat else null
    if (rule != task.repeat) set.put("repeat", rule?.let(::repeatToJson) ?: JSONObject.NULL)
    return if (set.length() == 0) null else setOp(task.id, set)
}

// ---- Descriptions -------------------------------------------------------------------------

private val SHORT_DAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
val WEEKDAY_NAMES = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
private val POSITIONS = listOf("", "first", "second", "third", "fourth")

fun positionLabel(date: LocalDate): String {
    val position = weekdayPosition(date)
    return "${if (position < 0) "last" else POSITIONS[position]} ${WEEKDAY_NAMES[isoWeekday(date) - 1]}"
}

/** A short human description, matching the desktop wording. */
fun describeRepeat(rule: Repeat, start: String): String {
    val date = LocalDate.parse(start)
    val unit = mapOf("day" to ("day" to "days"), "week" to ("week" to "weeks"), "month" to ("month" to "months"), "year" to ("year" to "years")).getValue(rule.every)
    var text = if (rule.interval == 1) "Every ${unit.first}" else "Every ${rule.interval} ${unit.second}"
    if (rule.every == "day" && rule.interval == 1) text = "Daily"
    if (rule.every == "week") {
        val days = rule.weekdays ?: listOf(isoWeekday(date))
        text = if (rule.interval == 1 && days == listOf(1, 2, 3, 4, 5)) "Every weekday" else "$text on ${days.joinToString(", ") { SHORT_DAYS[it - 1] }}"
    }
    if (rule.every == "month") text += if (rule.monthly == "weekday") " on the ${positionLabel(date)}" else " on day ${date.dayOfMonth}"
    if (rule.every == "year") text += " on ${start.substring(5)}"
    rule.until?.let { text += ", until $it" }
    rule.count?.let { text += ", $it ${if (it == 1) "time" else "times"}" }
    return text
}
