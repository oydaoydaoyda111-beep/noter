package app.noter

import android.app.Instrumentation
import app.noter.model.DatabaseException
import app.noter.model.NoteDatabase
import app.noter.model.databaseBlocks
import app.noter.model.databaseMarkdown
import app.noter.model.replaceDatabase
import app.noter.model.Note
import app.noter.model.WorkspaceOps
import app.noter.storage.Vault
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal fun Instrumentation.checkDatabaseFormat() {
    val source = context.assets.open("database.json").bufferedReader().use { it.readText() }
    val original = checkNotNull(NoteDatabase.read(source))
    fun rejects(action: () -> Unit) {
        check(runCatching(action).exceptionOrNull() is DatabaseException) { "An unsafe database mutation was accepted" }
    }
    check(original.visibleRows().map { it.id } == listOf("beta", "alpha", "delta", "gamma"))
    check(original.visibleColumns().map { it.id } == listOf("name", "status", "due", "score"))
    check(original.withCondition("score", "3").visibleRows().single().id == "alpha")
    check(original.withCondition("done", "true").visibleRows().map { it.id } == listOf("beta", "gamma"))
    check(original.visibleRows("ÅNGSTRÖM").single().id == "delta")
    val board = original.withView("board")
    check(board.layout == "kanban" && board.visibleRows().single().id == "gamma")
    check(board.withSetting("filter", "Gamma").withView("table").filter.isEmpty())
    check(board.withView("calendar").visibleRows().size == 4)
    val focused = original.withSetting("filter", "alpha").withCondition("status", "Ready").withColumnVisible("score", false)
        .withSavedView(null, " Mobile focus ")
    val focusId = focused.viewId
    check(focusId !in original.views.map { it.id } && focused.views.last().name == "Mobile focus")
    check(focused.filter == "alpha" && focused.layout == "table" && focused.visibleRows().single().id == "alpha")
    check(focused.visibleColumns().map { it.id } == listOf("name", "status", "due"))
    val focusJson = JSONObject(focused.encode()).getJSONArray("views").getJSONObject(3)
    check(focusJson.getString("futureLabel") == "preserve" && focusJson.getJSONObject("columnWidths").getInt("name") == 280)
    val renamed = focused.withSavedView(focusId, "Renamed focus")
    check(renamed.viewId == focusId && renamed.views.last().id == focusId && renamed.views.last().name == "Renamed focus")
    check(original.withSavedView(null, "all TASKS").views.last().name == "all TASKS 2")
    check(original.withSavedView("table", "All tasks").views.first().name == "All tasks")
    val longName = "x".repeat(80)
    val longViews = original.withSavedView(null, longName).withSavedView(null, longName)
    check(longViews.views.last().name == "x".repeat(78) + " 2")
    check(renamed.withView("board").withCondition("status", "Blocked").withView(focusId).visibleRows().single().id == "alpha")
    check(renamed.withColumnVisible("score", true).visibleColumns().map { it.id } == listOf("name", "status", "due", "score"))
    check(renamed.removeView("board").viewId == focusId)
    val removed = renamed.removeView(focusId)
    check(removed.viewId == "table" && removed.filter == "alpha" && removed.rows.map { it.id } == original.rows.map { it.id })
    check(original.views.size == 3 && original.filter.isEmpty() && original.visibleColumns().size == 4)
    val oneView = original.removeView("board").removeView("calendar")
    rejects { oneView.removeView("table") }
    rejects { original.withSavedView(null, " ") }
    rejects { original.withSavedView("removed", "Lost view") }
    rejects { original.withView("removed") }
    rejects { original.removeView("removed") }
    rejects { original.withColumnVisible("removed", false) }
    var oneColumn = original
    for (column in original.visibleColumns().drop(1)) oneColumn = oneColumn.withColumnVisible(column.id, false)
    rejects { oneColumn.withColumnVisible("name", false) }
    check(oneColumn.withColumnVisible("status", true).visibleColumns().map { it.id } == listOf("name", "status"))
    check(checkNotNull(NoteDatabase.read(renamed.encode())).viewId == focusId)
    File(targetContext.getExternalFilesDir(null), "database-views-roundtrip.json").writeText(renamed.encode())
    check(original.withSetting("sort", JSONObject().put("columnId", "score").put("direction", "asc")).visibleRows().map { it.id } == listOf("delta", "alpha", "beta", "gamma"))
    val natural = original.withRow("alpha", mapOf("name" to "Task 10")).withRow("beta", mapOf("name" to "Task 2"))
        .withSetting("sort", JSONObject().put("columnId", "name").put("direction", "asc"))
    check(natural.visibleRows("task").map { it.id } == listOf("beta", "alpha"))

    var edited = original.withRow("alpha", mapOf("name" to "Alpha mobile", "score" to "42.5", "done" to "true", "due" to "2028-02-29"))
    check(original.rowTitle(original.rows.first()) == "Alpha")
    val encoded = JSONObject(edited.encode())
    val first = encoded.getJSONArray("rows").getJSONObject(0)
    check(first.getJSONObject("cells").getDouble("score") == 42.5 && first.getJSONObject("cells").getBoolean("done"))
    check(first.getString("id") == "alpha" && first.getString("futureLabel") == "preserve")
    check(first.getJSONObject("cells").getJSONObject("unknown").getBoolean("preserve"))
    check(encoded.getJSONObject("futureMetadata").getBoolean("preserve"))
    check(encoded.getJSONArray("columns").getJSONObject(1).getJSONObject("optionColors").getString("Done") == "green")
    check(encoded.getJSONArray("views").getJSONObject(0).getJSONObject("columnWidths").getInt("name") == 280)
    for (invalid in listOf("NaN", "Infinity", "abc")) rejects { edited.withRow("alpha", mapOf("score" to invalid)) }
    for (invalid in listOf("2026-02-29", "2026-13-01", "0000-01-01", "2026-1-1")) rejects { edited.withRow("alpha", mapOf("due" to invalid)) }
    rejects { edited.withRow("deleted", mapOf("name" to "Lost draft")) }
    edited = edited.duplicateRow("alpha")
    check(edited.rows.size == 5 && edited.rows.last().id !in original.rows.map { it.id })
    check(edited.rowTitle(edited.rows.last()) == "Alpha mobile")
    edited = edited.removeRow(edited.rows.last().id).withRow(null, mapOf("name" to "Created on Android", "score" to "", "due" to "", "done" to "false"))
    check(edited.rows.last().cells.isNull("score"))
    edited = edited.withColumn(null, "Owner", "text", emptyList())
    val owner = edited.columns.last()
    edited = edited.withRow("alpha", mapOf(owner.id to "Mobile"))
    edited = edited.withColumn(owner.id, "Assignee", "text", emptyList())
    check(edited.columns.last().id == owner.id && edited.cell(edited.rows.first(), edited.columns.last()) == "Mobile")
    val converted = edited.withColumn(owner.id, "Assignee", "number", emptyList())
    check(converted.rows.first().cells.isNull(owner.id))
    edited = edited.withCondition(owner.id, "Mobile").removeColumn(owner.id)
    check(edited.condition == null && !edited.rows.first().cells.has(owner.id))
    val reloaded = checkNotNull(NoteDatabase.read(edited.encode()))
    check(reloaded.rows.map { it.id } == edited.rows.map { it.id } && reloaded.columns.map { it.id } == original.columns.map { it.id })
    File(targetContext.getExternalFilesDir(null), "database-roundtrip.json").writeText(reloaded.encode())

    val fresh = NoteDatabase.create("New database")
    check(fresh.views.size == 3 && fresh.columns.size == 3 && fresh.rows.isEmpty())
    val lastProperty = fresh.removeColumn(fresh.columns[2].id).removeColumn(fresh.columns[1].id)
    rejects { lastProperty.removeColumn(lastProperty.columns.single().id) }
    val legacy = JSONObject(source).apply { remove("views"); remove("activeViewId"); put("view", "kanban") }
    check(checkNotNull(NoteDatabase.read(legacy.toString())).layout == "kanban")
    for (invalid in listOf(
        JSONObject(source).put("version", 2), JSONObject(source).put("version", "1"),
        JSONObject(source).put("columns", JSONArray()),
        JSONObject(source).apply { getJSONArray("columns").getJSONObject(1).put("options", JSONArray(listOf("Done", "Done"))) },
        JSONObject(source).apply { getJSONArray("rows").getJSONObject(0).getJSONObject("cells").put("name", JSONObject()) },
        JSONObject(source).apply { getJSONArray("rows").getJSONObject(1).put("id", "alpha") }
    )) check(NoteDatabase.read(invalid.toString()) == null)

    val markdown = "Before\n\n${databaseMarkdown(original)}\nAfter\n"
    val block = databaseBlocks(markdown).single()
    val replacement = replaceDatabase("New introduction\n$markdown", block, edited)
    check(replacement.startsWith("New introduction\nBefore\n\n```noter-database\n") && replacement.endsWith("```\n\nAfter\n"))
    check(databaseBlocks(replacement).single().database.rows.size == 5)
    rejects { replaceDatabase(markdown.replace("Alpha", "Synced edit"), block, edited) }
    rejects { replaceDatabase("Database removed", block, edited) }
    val crlf = markdown.replace("\n", "\r\n")
    check(!replaceDatabase(crlf, databaseBlocks(crlf).single(), edited).replace("\r\n", "").contains('\n'))
    val tilde = "~~~noter-database\n$source\n~~~\n"
    check(databaseBlocks(tilde).size == 1 && replaceDatabase(tilde, databaseBlocks(tilde).single(), edited).startsWith("~~~noter-database\n"))
    check(databaseBlocks("````markdown\n$markdown\n````\n").isEmpty())
    check(databaseBlocks("```noter-database\n{\"rows\":[]}\n```\n").isEmpty())
    check(databaseBlocks(markdown + markdown).size == 2)
    val second = databaseBlocks(markdown + markdown)[1]
    check(databaseBlocks(replaceDatabase(markdown + markdown, second, edited)).map { it.database.rows.size } == listOf(4, 5))

    withTestSaf(targetContext) { saf ->
        val vault = Vault(saf)
        val initial = vault.load()
        val (withDatabase, databaseId) = WorkspaceOps.addNote(initial.workspace, "Shared tasks", null)
        val (withPlainNote, plainId) = WorkspaceOps.addNote(withDatabase, "Plain note", null)
        val expectedMarkdown = "Before\n\n${databaseMarkdown(edited)}\nAfter\n"
        val saved = WorkspaceOps.edit(WorkspaceOps.edit(withPlainNote, databaseId, expectedMarkdown), plainId, "Keep this note 📝\n")
        vault.save(saved, initial.revision)
        val reopened = Vault(saf).load()
        check(reopened.workspace == saved) { "Database files, note IDs, tabs or other notes changed after reopen" }
        val loadedMarkdown = (reopened.workspace.nodes[databaseId] as Note).markdown
        val loadedBlock = databaseBlocks(loadedMarkdown).single()
        check(loadedBlock.database.cell(loadedBlock.database.rows.first(), loadedBlock.database.columns.first()) == "Alpha mobile")
        val changedDatabase = loadedBlock.database.withRow("alpha", mapOf("name" to "Reopened on Android"))
            .withColumnVisible("score", false).withSavedView(null, "Mobile tasks")
        val changedMarkdown = replaceDatabase(loadedMarkdown, loadedBlock, changedDatabase)
        val changedWorkspace = WorkspaceOps.edit(reopened.workspace, databaseId, changedMarkdown)
        vault.save(changedWorkspace, reopened.revision)
        val changedReload = Vault(saf).load()
        check(changedReload.workspace == changedWorkspace) { "Reopened database edits did not persist" }
        val reopenedDatabase = databaseBlocks((changedReload.workspace.nodes[databaseId] as Note).markdown).single().database
        check(reopenedDatabase.viewId == changedDatabase.viewId && reopenedDatabase.views.last().name == "Mobile tasks")
        check(reopenedDatabase.visibleColumns().none { it.id == "score" })
    }
}
