package app.noter

import android.app.Instrumentation
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import app.noter.model.Note
import app.noter.model.NoteDatabase
import app.noter.model.Settings
import app.noter.model.databaseBlocks
import app.noter.model.databaseMarkdown
import app.noter.ui.EditorPane
import app.noter.ui.NoterTheme
import java.io.File

/** Exercises actual Compose controls and a synced reload using only a synthetic note buffer. */
internal fun Instrumentation.checkDatabaseUi() {
    val original = checkNotNull(NoteDatabase.read(context.assets.open("database.json").bufferedReader().use { it.readText() }))
    val activity = startActivitySync(Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
    var note by mutableStateOf(Note("database-ui", "Database guide", null, 1, 1, "Keep this introduction.\n\n${databaseMarkdown(original)}\nKeep this ending."))
    var generation by mutableIntStateOf(0)
    val accessibility = uiAutomation.serviceInfo
    val previousFlags = accessibility.flags
    accessibility.flags = previousFlags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
    uiAutomation.serviceInfo = accessibility
    try {
        runOnMainSync {
            activity.setContent {
                NoterTheme("blue") {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        EditorPane(note, generation, Settings(), onChange = { note = note.copy(markdown = it) }, modifier = Modifier.systemBarsPadding())
                    }
                }
            }
        }
        fun find(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
            fun walk(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
                if (predicate(node)) return node
                for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it)?.let { result -> return result } }
                return null
            }
            return uiAutomation.rootInActiveWindow?.let(::walk)
        }
        fun awaitNode(label: String, predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
            val deadline = SystemClock.uptimeMillis() + 8000
            while (SystemClock.uptimeMillis() < deadline) {
                find(predicate)?.let { return it }
                SystemClock.sleep(100)
            }
            val visible = ArrayList<String>()
            fun describe(node: AccessibilityNodeInfo) {
                visible += "${node.className}: ${node.contentDescription} | ${node.text} (editable=${node.isEditable})"
                for (i in 0 until node.childCount) node.getChild(i)?.let(::describe)
            }
            uiAutomation.rootInActiveWindow?.let(::describe)
            error("Database UI element '$label' did not appear: ${visible.take(40)}")
        }
        fun labelMatches(node: AccessibilityNodeInfo, label: String, exact: Boolean = false): Boolean = node.contentDescription?.toString() == label ||
            (if (exact) node.text?.toString() == label else node.text?.toString()?.lineSequence()?.any { it == label } == true)
        fun click(label: String, exact: Boolean = false) {
            uiAutomation.waitForIdle(100, 2000)
            val node = awaitNode(label) { labelMatches(it, label, exact) && generateSequence(it) { parent -> parent.parent }.any { parent -> parent.isClickable && parent.isEnabled } }
            check(generateSequence(node) { it.parent }.first { it.isClickable }.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        }
        fun text(label: String) = awaitNode(label) { it.text?.toString()?.contains(label) == true || it.contentDescription?.toString() == label }
        fun descendantLabel(node: AccessibilityNodeInfo, label: String): Boolean {
            if (labelMatches(node, label)) return true
            return (0 until node.childCount).any { node.getChild(it)?.let { child -> descendantLabel(child, label) } == true }
        }
        fun setText(label: String, value: String) {
            val node = awaitNode(label) { it.isEditable && descendantLabel(it, label) }
            check(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) }))
            awaitNode(value) { it.isEditable && it.text?.toString() == value }
        }
        fun database(): NoteDatabase {
            var value: NoteDatabase? = null
            runOnMainSync { value = databaseBlocks(note.markdown).single().database }
            return checkNotNull(value)
        }
        fun screenshot(name: String) {
            uiAutomation.waitForIdle(100, 2000)
            val addButton = awaitNode("Visible New record button") { labelMatches(it, "New record", true) && it.isVisibleToUser }
            val bounds = Rect().also { addButton.getBoundsInScreen(it) }
            check(bounds.height() > 0 && bounds.bottom <= targetContext.resources.displayMetrics.heightPixels) { "New record button was outside the visible screen: $bounds" }
            uiAutomation.takeScreenshot()?.let { bitmap ->
                File(targetContext.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
        }
        text("Keep this introduction.")
        click("Open database Shared tasks")
        text("4 of 4 records")
        screenshot("database-table-preview.png")
        click("New record", exact = true)
        text("Close New record")
        val nameField = awaitNode("Name") { it.isEditable && descendantLabel(it, "Name") }
        val nameBounds = Rect().also { nameField.getBoundsInScreen(it) }
        val tapTime = SystemClock.uptimeMillis()
        for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
            val touch = MotionEvent.obtain(tapTime, SystemClock.uptimeMillis(), action, nameBounds.exactCenterX(), nameBounds.exactCenterY(), 0)
            check(uiAutomation.injectInputEvent(touch, true)); touch.recycle()
        }
        val keyboardDeadline = SystemClock.uptimeMillis() + 8000
        var keyboardBounds: Rect? = null
        while (keyboardBounds == null && SystemClock.uptimeMillis() < keyboardDeadline) {
            uiAutomation.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }?.let { keyboardBounds = Rect().also(it::getBoundsInScreen) }
            SystemClock.sleep(100)
        }
        check(keyboardBounds != null) { "The record keyboard did not open" }
        uiAutomation.waitForIdle(100, 2000)
        val saveButton = awaitNode("Save record") { labelMatches(it, "Save record", true) }
        val saveBounds = Rect().also { saveButton.getBoundsInScreen(it) }
        check(saveBounds.height() > 0 && saveBounds.bottom <= checkNotNull(keyboardBounds).top) { "Save record was hidden by the keyboard: $saveBounds; keyboard=$keyboardBounds" }
        setText("Name", "Mobile task")
        setText("Score", "invalid")
        click("Save record")
        text("Score: enter a valid number.")
        check(database().rows.size == 4)
        setText("Score", "9.75")
        click("Complete")
        click("Status")
        click("Ready", exact = true)
        text("Close New record")
        click("Save record")
        text("5 of 5 records")
        check(database().rows.last().cells.getDouble("score") == 9.75 && database().rows.last().cells.getBoolean("done"))
        click("Edit Mobile task")
        text("Close Edit record")
        setText("Name", "Mobile task edited")
        click("Save record")
        text("Mobile task edited")
        click("Actions for Mobile task edited")
        click("Duplicate record")
        text("6 of 6 records")
        click("Actions for Mobile task edited")
        click("Delete record")
        click("Delete", exact = true)
        text("5 of 5 records")
        click("Close Shared tasks")
        click("Undo")
        check(database().rows.size == 6)
        click("Redo")
        check(database().rows.size == 5)
        text("5 records ·")
        click("Open database Shared tasks")
        text("5 of 5 records")
        click("Board", exact = true)
        text("Ready · 3")
        screenshot("database-board-preview.png")
        click("All tasks", exact = true)
        click("Completed", exact = true)
        text("1 of 5 records")
        click("Table", exact = true)
        text("Gamma")
        click("Completed", exact = true)
        click("Schedule", exact = true)
        text("October 2026")
        screenshot("database-calendar-preview.png")
        click("2026-10-04, 2 records")
        val calendar = awaitNode("Database calendar") { it.contentDescription?.toString() == "Database calendar" && it.isScrollable }
        check(calendar.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD))
        text("Alpha")
        click("New record", exact = true)
        text("Close New record")
        text("2026-10-04")
        click("Close New record")
        click("Table", exact = true)
        setText("Search database records", "alpha")
        text("1 of 5 records")
        SystemClock.sleep(350)
        check(database().filter == "alpha")
        click("Clear record search")
        text("5 of 5 records")
        click("Database filters and sorting")
        click("Filter property")
        click("Status", exact = true)
        click("Filter value")
        text("Close sheet")
        click("Done", exact = true)
        click("Close database filters")
        check(database().condition?.optString("columnId") == "status" && database().condition?.optString("value") == "Done") { "Unexpected property filter: ${database().condition}; query=${database().filter}" }
        text("1 of 5 records")
        click("Database filters and sorting")
        click("Clear property filter")
        text("5 of 5 records")
        click("Database actions")
        click("Properties")
        click("Add property", exact = true)
        text("Property name")
        // This dialog has one editable field; its native label is exposed separately.
        val propertyName = awaitNode("Property name") { it.isEditable }
        check(propertyName.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "Owner") }))
        click("Save property")
        text("Owner · text")
        click("Close database properties")
        check(database().columns.last().name == "Owner")
        click("Edit Alpha")
        text("Close Edit record")
        setText("Name", "Unsaved mobile draft")
        // A clean workspace may receive a sync update while a record form is open.
        runOnMainSync {
            val incoming = databaseBlocks(note.markdown).single().database.withRow("alpha", mapOf("name" to "Incoming synced task"))
            note = note.copy(markdown = "Synced introduction.\n\n${databaseMarkdown(incoming)}\nKeep this ending.")
            generation++
        }
        click("Save record")
        text("This database changed outside this view.")
        text("Unsaved mobile draft")
        check(database().rows.first().cells.getString("name") == "Incoming synced task")
        click("Close Edit record")
        click("Close Shared tasks")
        text("Synced introduction.")
        click("Open database Shared tasks")
        click("Edit Incoming synced task")
        text("Close Edit record")
        click("Close Edit record")
        click("Close Shared tasks")
        click("Edit Markdown")
        text("noter-database")
        click("Show databases")
        text("Synced introduction.")
        runOnMainSync { check(note.markdown.endsWith("Keep this ending.")) }
    } finally {
        accessibility.flags = previousFlags
        uiAutomation.serviceInfo = accessibility
        runOnMainSync { activity.finish() }
    }
}
