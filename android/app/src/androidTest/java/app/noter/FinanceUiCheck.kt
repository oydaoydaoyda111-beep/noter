package app.noter

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.noter.finance.Account
import app.noter.finance.Finance
import app.noter.model.Settings
import app.noter.ui.NoterTheme
import app.noter.ui.finance.AccountManager
import app.noter.ui.finance.CategoryManager
import app.noter.ui.finance.EditRequest
import app.noter.ui.finance.TransactionEditor
import java.io.File

/** Uses synthetic data and real screen taps to catch buttons covered by system navigation or IME. */
internal fun Instrumentation.checkFinanceUi() {
    val activity = startActivitySync(Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
    var finance by mutableStateOf(Finance(
        accounts = listOf(Account("Wallet", ""), Account("Savings", "")),
        transactions = emptyList(), categories = listOf("Salary"), sourceName = "UI check", template = byteArrayOf(),
    ))
    var request by mutableStateOf<EditRequest?>(null)
    var manager by mutableStateOf<String?>(null)
    var commits = 0
    var failSave = false
    val accessibility = uiAutomation.serviceInfo
    val previousFlags = accessibility.flags
    accessibility.flags = previousFlags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
    uiAutomation.serviceInfo = accessibility
    try {
        runOnMainSync {
            activity.setContent {
                NoterTheme("blue") {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        request?.let { current -> TransactionEditor(finance, current, Settings(financeCurrency = ""), commit = {
                            if (failSave) false else { finance = it; commits++; true }
                        }, onClose = { request = null }) }
                        when (manager) {
                            "accounts" -> AccountManager(finance, { it.toString() }, "", {}, { finance = it; true }, { manager = null })
                            "categories" -> CategoryManager(finance, { finance = it; true }, { manager = null })
                        }
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
            uiAutomation.takeScreenshot()?.let { bitmap ->
                File(targetContext.getExternalFilesDir(null), "finance-ui-failure.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            error("Finance UI element '$label' did not appear: ${visible.take(50)}")
        }
        fun labeled(label: String) = awaitNode(label) { it.text?.toString()?.lineSequence()?.any { line -> line == label } == true || it.contentDescription?.toString() == label }
        fun hasLabel(node: AccessibilityNodeInfo, label: String): Boolean = node.contentDescription?.toString() == label ||
            (0 until node.childCount).any { node.getChild(it)?.let { child -> hasLabel(child, label) } == true }
        fun bounds(node: AccessibilityNodeInfo) = Rect().also(node::getBoundsInScreen)
        fun tap(node: AccessibilityNodeInfo) {
            val rect = bounds(node)
            check(rect.width() > 0 && rect.height() > 0) { "Cannot tap empty bounds: $rect" }
            val down = SystemClock.uptimeMillis()
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, rect.exactCenterX(), rect.exactCenterY(), 0)
                check(uiAutomation.injectInputEvent(event, true)); event.recycle()
            }
        }
        fun keyboardBounds(): Rect? = uiAutomation.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }?.let(::boundsOfWindow)
        fun awaitKeyboard(visible: Boolean) {
            val deadline = SystemClock.uptimeMillis() + 8000
            while (SystemClock.uptimeMillis() < deadline) {
                if ((keyboardBounds() != null) == visible) {
                    uiAutomation.waitForIdle(200, 2000)
                    return
                }
                SystemClock.sleep(100)
            }
            error("Finance keyboard visibility did not become $visible")
        }
        fun hideKeyboard() {
            if (keyboardBounds() == null) return
            val now = SystemClock.uptimeMillis()
            for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
                check(uiAutomation.injectInputEvent(KeyEvent(now, now, action, KeyEvent.KEYCODE_BACK, 0), true))
            }
            awaitKeyboard(false)
        }
        fun assertSafeButton(label: String, aboveKeyboard: Boolean = false): AccessibilityNodeInfo {
            uiAutomation.waitForIdle(200, 2000)
            val node = labeled(label)
            val button = generateSequence(node) { it.parent }.first { it.isClickable }
            val rect = bounds(button)
            var safe = Rect()
            runOnMainSync {
                val host = activity.window.decorView
                val origin = IntArray(2).also(host::getLocationOnScreen)
                val bars = checkNotNull(ViewCompat.getRootWindowInsets(host)).getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                safe = Rect(origin[0] + bars.left, origin[1] + bars.top, origin[0] + host.width - bars.right, origin[1] + host.height - bars.bottom)
            }
            if (aboveKeyboard) safe.bottom = minOf(safe.bottom, checkNotNull(keyboardBounds()).top)
            check(button.isVisibleToUser && button.isEnabled && safe.contains(rect) && rect.height() >= (48 * targetContext.resources.displayMetrics.density).toInt()) {
                "$label overlaps system navigation or keyboard: button=$rect; safe=$safe"
            }
            return button
        }
        fun setAmount(value: String) {
            val amount = awaitNode("Amount") { it.isEditable && hasLabel(it, "Amount") }
            tap(amount)
            awaitKeyboard(true)
            check(amount.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
            }))
        }
        fun awaitClosed(expectedCommits: Int) {
            val deadline = SystemClock.uptimeMillis() + 8000
            while (SystemClock.uptimeMillis() < deadline) {
                var closed = false
                runOnMainSync { closed = request == null && commits == expectedCommits }
                if (closed) return
                SystemClock.sleep(100)
            }
            error("Tapping Save transaction did not commit and close the editor")
        }
        fun screenshot(name: String) {
            uiAutomation.takeScreenshot()?.let { bitmap ->
                File(targetContext.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
        }

        for ((index, kind) in listOf("income", "expense", "transfer").withIndex()) {
            runOnMainSync { request = EditRequest(kind) }
            setAmount("12.34")
            assertSafeButton("Save transaction", aboveKeyboard = true)
            if (index == 0) screenshot("finance-income-keyboard.png")
            hideKeyboard()
            assertSafeButton("Save transaction")
            if (index == 0) screenshot("finance-income-navigation.png")
            if (kind != "expense") setAmount("12.34")
            tap(assertSafeButton("Save transaction", aboveKeyboard = kind != "expense"))
            awaitClosed(index + 1)
        }
        runOnMainSync { request = EditRequest("income", finance.transactions.first { it.cents > 0 && it.transferId == null }); failSave = true }
        setAmount("23.45")
        tap(assertSafeButton("Save transaction", aboveKeyboard = true))
        labeled("Could not save. Keep this screen open and try again.")
        hideKeyboard()
        assertSafeButton("Save transaction")
        awaitNode("Retained amount") { it.isEditable && it.text?.toString() == "23.45" }
        runOnMainSync { failSave = false }
        tap(assertSafeButton("Save transaction"))
        awaitClosed(4)

        for ((screen, search, add) in listOf(Triple("accounts", "Find an account", "Add account"), Triple("categories", "Find a category or subcategory", "Add category"))) {
            runOnMainSync { manager = screen }
            labeled(search)
            hideKeyboard()
            assertSafeButton(add)
            tap(awaitNode(search) { it.isEditable && hasLabel(it, search) })
            awaitKeyboard(true)
            assertSafeButton(add, aboveKeyboard = true)
            hideKeyboard()
            tap(labeled(if (screen == "accounts") "Close Accounts" else "Close Categories"))
        }
    } finally {
        accessibility.flags = previousFlags
        uiAutomation.serviceInfo = accessibility
        runOnMainSync { activity.finish() }
    }
}

private fun boundsOfWindow(window: AccessibilityWindowInfo) = Rect().also(window::getBoundsInScreen)
