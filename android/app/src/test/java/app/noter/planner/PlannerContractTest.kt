package app.noter.planner

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.LocalDate

/** Runs on the JVM (no device): the shared fixture must replay exactly as on the desktop. */
class PlannerContractTest {
    private val fixtures = File("../../tests/fixtures/file-storage/planner")
    private val parse = { text: String -> JSONObject(text) }
    private fun days(start: String, rule: Repeat, limit: String) = seriesDays(start, rule, LocalDate.parse(limit).toEpochDay()).map { LocalDate.ofEpochDay(it).toString() }
    private fun rows(list: List<Occurrence>) = list.map { listOf(it.date, it.task.id, it.on, it.done) }
    private fun expectedRows(array: JSONArray) = List(array.length()) { index -> array.getJSONArray(index).let { listOf(it.getString(0), it.getString(1), it.getString(2), it.getBoolean(3)) } }
    private fun line(dev: String, ts: Long, seq: Long, vararg ops: JSONObject) = JSONObject().put("v", 1).put("ts", ts).put("dev", dev).put("seq", seq).put("ops", JSONArray(ops.toList())).toString() + "\n"

    @Test
    fun sharedFixtureMatchesTheDesktopContract() {
        val expected = JSONObject(File(fixtures, "expected-planner.json").readText())
        val files = listOf("log-desktop-a.jsonl", "log-mobile-b.jsonl").map { LogFile(it, File(fixtures, it).readText()) }
        val parsed = parsePlannerLogs(files, expected.getString("device"), parse)
        assertEquals(expected.getLong("clock"), parsed.clock)
        assertEquals(expected.getLong("seq"), parsed.seq)
        assertEquals(expected.getBoolean("ownNeedsNewline"), parsed.ownNeedsNewline)
        val planner = replayPlanner(parsed.batches)
        val tasks = expected.getJSONArray("tasks")
        assertEquals(tasks.length(), planner.tasks.size)
        for (index in 0 until tasks.length()) {
            val want = tasks.getJSONObject(index)
            val task = planner.tasks.getValue(want.getString("id"))
            assertEquals(want.getString("title"), task.title)
            assertEquals(want.opt("date").takeIf { it != JSONObject.NULL }, task.date)
            assertEquals(want.opt("repeat").takeIf { it != JSONObject.NULL }?.let(::repeatFromJson), task.repeat)
            assertEquals(want.getBoolean("done"), task.done)
            assertEquals(want.getLong("created"), task.created)
        }
        val range = expected.getJSONArray("range")
        assertEquals(expectedRows(expected.getJSONArray("occurrences")), rows(occurrencesBetween(planner, range.getString(0), range.getString(1))))
        assertEquals(expectedRows(expected.getJSONArray("overdue")), rows(overdue(planner, expected.getString("today"))))
        val loose = expected.getJSONArray("unscheduled")
        assertEquals(List(loose.length()) { loose.getString(it) }, unscheduled(planner).map { it.id })
    }

    @Test
    fun repeatRulesFollowCalendarBoundaries() {
        assertEquals(listOf("2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"), days("2026-01-31", Repeat("month", 1), "2026-05-31"))
        assertEquals(listOf("2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"), days("2024-02-29", Repeat("year", 1), "2028-12-31"))
        assertEquals(listOf("2026-10-13", "2026-11-10", "2026-12-08", "2027-01-12"), days("2026-10-13", Repeat("month", 1, monthly = "weekday"), "2027-01-31"))
        assertEquals(listOf("2026-10-30", "2026-12-25", "2027-02-26"), days("2026-10-30", Repeat("month", 2, monthly = "weekday"), "2027-03-31"))
        assertEquals(listOf("2026-10-14", "2026-10-16", "2026-10-26", "2026-10-28", "2026-10-30"), days("2026-10-14", Repeat("week", 2, listOf(1, 3, 5)), "2026-11-01"))
        assertEquals(listOf("2026-10-11", "2026-10-18", "2026-10-25"), days("2026-10-11", Repeat("week", 1), "2026-10-31"))
        assertEquals(listOf("2026-10-01", "2026-10-04", "2026-10-07"), days("2026-10-01", Repeat("day", 3, count = 3), "2030-01-01"))
        assertEquals(emptyList<String>(), days("2026-10-05", Repeat("day", 1, until = "2026-10-01"), "2030-01-01"))
        assertEquals("Every weekday", describeRepeat(Repeat("week", 1, listOf(1, 2, 3, 4, 5)), "2026-10-12"))
        assertEquals("Every month on the last Friday", describeRepeat(Repeat("month", 1, monthly = "weekday"), "2026-10-30"))
        assertEquals("Every 2 weeks on Mon, Thu, until 2026-12-31", describeRepeat(Repeat("week", 2, listOf(1, 4), until = "2026-12-31"), "2026-10-05"))
    }

    @Test
    fun occurrenceEditsStayIndependent() {
        val create = createTask("t", " Water ", "2026-10-01", Repeat("day", 1), 5)
        val ops = mutableListOf(create)
        fun planner() = replayPlanner(parsePlannerLogs(listOf(LogFile("log-a.jsonl", ops.mapIndexed { index, op -> line("a", index + 1L, index + 1L, op) }.joinToString(""))), "a", parse).batches)
        fun list() = occurrencesBetween(planner(), "2026-10-01", "2026-10-05")
        assertEquals("Water", planner().tasks.getValue("t").title)
        ops += setDone(planner(), list()[1], true)
        ops += moveOccurrence(planner(), list()[1], "2026-10-04")
        assertEquals(OccurrenceChange(done = true, move = "2026-10-04"), planner().exceptions.getValue("t").getValue("2026-10-02"))
        ops += moveOccurrence(planner(), list().first { it.on == "2026-10-02" }, "2026-10-02")
        assertEquals(OccurrenceChange(done = true), planner().exceptions.getValue("t").getValue("2026-10-02"))
        ops += setDone(planner(), list().first { it.on == "2026-10-02" }, false)
        assertFalse(planner().exceptions.getValue("t").containsKey("2026-10-02"))
        ops += skipOccurrence(list()[0])
        ops += deleteFollowing(list().first { it.on == "2026-10-04" })
        assertEquals("2026-10-03", planner().tasks.getValue("t").repeat!!.until)
        assertEquals(listOf("2026-10-02", "2026-10-03"), list().map { it.on })
        assertEquals("del", deleteFollowing(Occurrence(planner().tasks.getValue("t"), "2026-10-01", "2026-10-01", false, true)).getString("k"))
        assertEquals(null, changedFields(planner().tasks.getValue("t"), "Water", "2026-10-01", planner().tasks.getValue("t").repeat))
        assertThrows(PlannerException::class.java) { createTask("x", "a".repeat(501), null, null, 1) }
    }

    @Test
    fun concurrentEditsMergeAndInvalidLogsAreRefused() {
        val create = JSONObject("""{"k":"task","id":"t","set":{"title":"Old","date":"2026-10-01","repeat":null,"done":false,"created":1}}""")
        val logs = listOf(
            LogFile("log-phone.jsonl", line("phone", 1, 1, create) + line("phone", 30, 2, JSONObject("""{"k":"task","id":"t","set":{"done":true}}"""))),
            LogFile("log-desk.jsonl", line("desk", 20, 1, JSONObject("""{"k":"task","id":"t","set":{"title":"Renamed"}}"""))),
        )
        val merged = replayPlanner(parsePlannerLogs(logs, "desk", parse).batches).tasks.getValue("t")
        assertEquals("Renamed", merged.title)
        assertTrue(merged.done)
        val deleted = logs + LogFile("log-tablet.jsonl", line("tablet", 5, 1, JSONObject("""{"k":"del","id":"t"}""")))
        assertFalse(replayPlanner(parsePlannerLogs(deleted, "desk", parse).batches).tasks.containsKey("t"))
        for (op in listOf("""{"k":"task","id":"t","set":{"title":""}}""", """{"k":"task","id":"t","set":{"date":"2026-02-30"}}""",
            """{"k":"task","id":"t","set":{"repeat":{"every":"day","interval":1000}}}""", """{"k":"task","id":"","set":{}}""",
            """{"k":"occ","id":"t","on":"2026-10-01","value":{"done":false}}""", """{"k":"occ","id":"t","on":"2026-10-01"}""", """{"k":"task","id":"t","set":{"created":-1}}""")) {
            assertThrows(op, PlannerException::class.java) { parsePlannerLogs(listOf(LogFile("log-x.jsonl", line("x", 1, 1, JSONObject(op)))), "x", parse) }
        }
        assertThrows(PlannerException::class.java) { parsePlannerLogs(listOf(LogFile("log-x.jsonl", line("x", 1, 1)), LogFile("log-y.jsonl", line("x", 5, 1, create))), "x", parse) }
    }
}
