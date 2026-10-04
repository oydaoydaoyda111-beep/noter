package app.noter

import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import app.noter.model.Note
import app.noter.model.Settings
import app.noter.model.Workspace
import app.noter.ui.EditorPane
import app.noter.ui.NoterTheme
import app.noter.ui.SearchDialog
import java.io.File

/** Uses platform accessibility APIs with a synthetic editor; no user files or test dependencies. */
internal fun Instrumentation.checkNoteSearchUi() {
    val activity = startActivitySync(Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
    var opened: String? = null
    try {
        runOnMainSync {
            activity.setContent {
                var note by remember { mutableStateOf(Note("search-ui", "Emulator guide", null, 1, 1, "Initial draft")) }
                var searching by remember { mutableStateOf(false) }
                NoterTheme("blue") {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.fillMaxSize().systemBarsPadding()) {
                            Button(onClick = { searching = true }) { Text("Search notes") }
                            EditorPane(note, 0, Settings(), onChange = { note = note.copy(markdown = it) })
                        }
                    }
                    if (searching) SearchDialog(Workspace(nodes = mapOf(note.id to note)),
                        onOpen = { opened = it; searching = false }, onClose = { searching = false })
                }
            }
        }
        fun find(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
            fun walk(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
                if (predicate(node)) return node
                for (i in 0 until node.childCount) node.getChild(i)?.let { child -> walk(child)?.let { return it } }
                return null
            }
            return uiAutomation.rootInActiveWindow?.let(::walk)
        }
        fun awaitNode(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
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
            uiAutomation.takeScreenshot()?.let { bitmap ->
                File(targetContext.getExternalFilesDir(null), "note-search-failure.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            error("Search UI accessibility element did not appear: ${visible.take(80)}")
        }
        fun click(label: String) {
            uiAutomation.waitForIdle(100, 2000)
            val node = awaitNode {
                (it.contentDescription?.toString() == label || it.text?.toString()?.lineSequence()?.any { line -> line == label } == true) &&
                    generateSequence(it) { parent -> parent.parent }.any { parent -> parent.isClickable }
            }
            val clickable = generateSequence(node) { it.parent }.first { it.isClickable }
            check(clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        }
        fun setText(description: String, text: String) {
            // OutlinedTextField exposes its label separately; wait for the dialog window before editing.
            if (description == "Search notes") awaitNode { it.contentDescription?.toString() == "Close search" }
            val field = awaitNode { it.isEditable }
            check(field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }))
            awaitNode { it.isEditable && it.text?.toString() == text }
        }
        click("Note content")
        setText("Note content", "Draft needle")
        click("Search notes")
        setText("Search notes", "needle")
        awaitNode { it.text?.toString()?.contains("Draft needle") == true }
        uiAutomation.takeScreenshot()?.let { bitmap ->
            File(targetContext.getExternalFilesDir(null), "note-search-preview.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        click("Names")
        awaitNode { it.text?.toString() == "No matching notes" }
        click("Contents")
        awaitNode { it.text?.toString()?.contains("Draft needle") == true }
        click("Clear search")
        awaitNode { it.text?.toString() == "Find something in your workspace" }
        click("Close search")
        awaitNode { it.isEditable && it.text?.toString() == "Draft needle" }
        click("Undo")
        awaitNode { it.isEditable && it.text?.toString() == "Initial draft" }
        click("Search notes")
        setText("Search notes", "emulator")
        click("Emulator guide")
        runOnMainSync { check(opened == "search-ui") { "The result did not open the matching note" } }
        awaitNode { it.isEditable && it.text?.toString() == "Initial draft" }
        click("Search notes")
        awaitNode { it.contentDescription?.toString() == "Close search" }
        uiAutomation.waitForIdle(250, 3000)
        fun back() {
            val now = SystemClock.uptimeMillis()
            uiAutomation.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK, 0), true)
            uiAutomation.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK, 0), true)
            SystemClock.sleep(300)
        }
        back()
        // With the keyboard visible, the first Back hides it and the second closes search.
        if (find { it.contentDescription?.toString() == "Close search" } != null) back()
        awaitNode { it.isEditable && it.text?.toString() == "Initial draft" }
        check(!activity.isFinishing)
    } finally {
        runOnMainSync { activity.finish() }
    }
}
