package app.noter

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import androidx.lifecycle.ViewModelProvider
import app.noter.finance.Finance
import app.noter.finance.FinanceException
import app.noter.finance.LogFile
import app.noter.finance.MAX_SAFE
import app.noter.finance.batchLine
import app.noter.finance.diffFinance
import app.noter.finance.money
import app.noter.finance.parseLegacyFinance
import app.noter.finance.parseLogs
import app.noter.finance.replayFinance
import app.noter.finance.safeInteger
import app.noter.finance.validateFinance
import app.noter.finance.validateTransaction
import app.noter.model.normalizeSettings
import app.noter.model.toJson
import app.noter.model.Note
import app.noter.model.WorkspaceOps
import app.noter.storage.SyncConflictException
import app.noter.storage.Vault
import app.noter.state.FinanceViewModel
import app.noter.state.WorkspaceViewModel
import kotlinx.coroutines.Job
import org.json.JSONArray
import org.json.JSONObject

/** Runs against real Android JSON/document APIs without a separate test framework. */
class StorageContractCheck : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        try {
            checkFinanceFormat()
            checkSettingsFormat()
            checkVaultFormat()
            checkSafeReplacement(targetContext)
            checkNoteSearch()
            checkNoteSearchUi()
            checkDatabaseFormat()
            checkDatabaseUi()
            checkForegroundPolling()
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "Shared file storage, note search, Android databases and foreground polling checks passed.\n") })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply {
                putString("stream", error.stackTraceToString())
                putString("error", error.message ?: error.javaClass.name)
            })
        }
    }

    private fun checkForegroundPolling() {
        val activity = startActivitySync(Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            runOnMainSync {
                val workspace = ViewModelProvider(activity as MainActivity)[WorkspaceViewModel::class.java]
                val finance = ViewModelProvider(activity)[FinanceViewModel::class.java]
                fun pollJob(model: Any): Job? = model.javaClass.getDeclaredField("pollJob").apply { isAccessible = true }.get(model) as Job?
                val notesJob = pollJob(workspace) ?: error("Notes polling did not start")
                val financeJob = pollJob(finance) ?: error("Finance polling did not start")
                check(notesJob.isActive && financeJob.isActive)
                workspace.setForeground(true)
                finance.setForeground(true)
                check(pollJob(workspace) === notesJob && pollJob(finance) === financeJob) { "Duplicate foreground loops" }
                callActivityOnStop(activity)
                check(notesJob.isCancelled && financeJob.isCancelled) { "Folder checks continued in the background" }
                check(pollJob(workspace) == null && pollJob(finance) == null)
                callActivityOnStart(activity)
                check(pollJob(workspace)?.isActive == true && pollJob(finance)?.isActive == true) { "Sync checks did not resume" }
            }
        } finally {
            runOnMainSync { activity.finish() }
        }
    }

    private fun fixture(name: String): String = context.assets.open(name).bufferedReader().use { it.readText() }

    private fun rejects(action: () -> Unit) {
        try {
            action()
        } catch (_: FinanceException) {
            return
        }
        error("Invalid shared Finance data was accepted")
    }

    private fun checkFinanceFormat() {
        val logs = listOf("log-desktop-a.jsonl", "log-mobile-b.jsonl").map { LogFile(it, fixture(it)) }
        val expected = JSONObject(fixture("expected-finance.json"))
        val expectedFinance = parseLegacyFinance(expected.getJSONObject("data").toString(), ByteArray(0))
        val parsed = parseLogs(logs.reversed(), "desktop-a")
        check(parsed.clock == 1002L && parsed.seq == 2L && !parsed.ownNeedsNewline)
        val state = checkNotNull(replayFinance(parsed.batches))
        sameFinance(state.finance, expectedFinance)
        check(state.templateSha256 == expected.getString("templateSha256"))
        validateFinance(state.finance)
        check(state.finance.budgets?.single() == app.noter.finance.Budget("2026-10", "Food", 5000))
        check(state.finance.copy(template = byteArrayOf(1)).budgets == state.finance.budgets)
        val renamedBudgets = app.noter.finance.renameCategory(state.finance, "Food", "Dining")
        check(renamedBudgets.budgets?.single()?.category == "Dining")
        val mergedBudgets = app.noter.finance.mergeCategories(renamedBudgets.copy(budgets = renamedBudgets.budgets.orEmpty() + app.noter.finance.Budget("2026-10", "Meals", 3000)), "Dining", "Meals")
        check(mergedBudgets.budgets?.single()?.cents == 8000L)
        check(app.noter.finance.deleteCategory(mergedBudgets, "Meals").budgets?.isEmpty() == true)
        for (budget in listOf(app.noter.finance.Budget("2026-13", "Food", 10), app.noter.finance.Budget("2026-10", "Food", MAX_SAFE + 1), app.noter.finance.Budget("2026-10", "Transfer to other account", 10))) rejects { validateFinance(state.finance.copy(budgets = listOf(budget))) }
        rejects { validateFinance(state.finance.copy(budgets = state.finance.budgets.orEmpty() + state.finance.budgets.orEmpty())) }
        val emitted = diffFinance(null, state.finance, state.templateSha256)
        val replayed = checkNotNull(replayFinance(listOf(app.noter.finance.Batch(1003, "mobile-b", 2, emitted))))
        sameFinance(replayed.finance, expectedFinance)

        val partial = logs.map { if (it.name == "log-desktop-a.jsonl") LogFile(it.name, it.text + "{\"v\":") else it }
        val interrupted = parseLogs(partial, "desktop-a")
        check(interrupted.ownNeedsNewline && interrupted.seq == parsed.seq)
        sameFinance(checkNotNull(replayFinance(interrupted.batches)).finance, expectedFinance)
        rejects { parseLogs(listOf(LogFile("log-device.jsonl", "invalid completed line\n")), "device") }
        for (key in listOf("ts", "seq")) {
            val batch = JSONObject().put("v", 1).put("ts", 1000).put("dev", "device").put("seq", 1).put("ops", JSONArray())
            batch.put(key, MAX_SAFE + 1)
            rejects { parseLogs(listOf(LogFile("log-device.jsonl", "$batch\n")), "device") }
        }
        check(safeInteger(MAX_SAFE) == MAX_SAFE && safeInteger(-MAX_SAFE) == -MAX_SAFE)
        for (invalid in listOf(MAX_SAFE + 1, -MAX_SAFE - 1, Long.MIN_VALUE, 0.5, Double.POSITIVE_INFINITY)) {
            check(safeInteger(invalid) == null)
        }
        check(money("-90071992547409.91") == -MAX_SAFE)
        rejects { money("-92233720368547758.08") }
        rejects { batchLine("device", MAX_SAFE, 1, emptyList()) }
        rejects { batchLine("device", 0, MAX_SAFE + 1, emptyList()) }
        val emittedLine = batchLine("device", parsed.clock, parsed.seq + 1, emitted).first
        sameFinance(checkNotNull(replayFinance(parseLogs(listOf(LogFile("log-device.jsonl", emittedLine)), "device").batches)).finance, expectedFinance)
        for (cents in listOf(MAX_SAFE + 1, -MAX_SAFE - 1, Long.MIN_VALUE)) {
            val row = expectedFinance.transactions.first().copy(cents = cents)
            rejects { validateTransaction(expectedFinance, row) }
            rejects { validateFinance(expectedFinance.copy(transactions = listOf(row))) }
        }
    }

    private fun sameFinance(actual: Finance, expected: Finance) {
        check(actual.accounts == expected.accounts && actual.transactions == expected.transactions)
        check(actual.categories == expected.categories && actual.categoryDefinitions == expected.categoryDefinitions && actual.budgets == expected.budgets)
        check(actual.defaults == expected.defaults && actual.sourceName == expected.sourceName)
    }

    private fun checkSettingsFormat() {
        val manifest = JSONObject(fixture("workspace.json"))
        val saved = manifest.getJSONObject("workspace").getJSONObject("settings")
        val settings = normalizeSettings(saved)
        check(sameJson(settings.toJson(), saved)) { "Shared desktop settings changed on Android" }
        check(normalizeSettings(JSONObject().put("documentWidth", 720.5).put("financePageSize", 25.5)).let {
            it.documentWidth == 790 && it.financePageSize == 50
        })
    }

    private fun checkVaultFormat() = withTestSaf(targetContext) { saf ->
        val manifest = JSONObject(fixture("workspace.json"))
        val paths = manifest.getJSONObject("paths")
        for (id in paths.keys()) {
            val path = paths.getString(id)
            if (path.endsWith(".md")) saf.writeAtomic(path, fixture(path).toByteArray()) else saf.ensureDir(path)
        }
        saf.writeAtomic(".noter/workspace.json", fixture("workspace.json").toByteArray())
        val vault = Vault(saf)
        val loaded = vault.load()
        val saved = JSONObject(String(saf.read(checkNotNull(saf.resolve(".noter/workspace.json")).doc), Charsets.UTF_8))
        check(sameJson(saved, manifest)) { "Shared manifest changed on Android" }
        check((loaded.workspace.nodes["overview"] as Note).markdown == fixture("Personal/Overview.md"))
        check(loaded.workspace.rootIds == listOf("personal", "inbox"))
        val changed = WorkspaceOps.edit(loaded.workspace, "overview", fixture("Personal/Overview.md") + "\nEdited on Android.\n")
        val revision = vault.save(changed, loaded.revision)
        check(Vault(saf).load().workspace == changed) { "Note, IDs, order, or settings changed after saving and reopening" }
        saf.writeAtomic("Inbox.md", (fixture("Inbox.md") + "\nIncoming desktop edit.\n").toByteArray())
        val conflict = runCatching { vault.save(changed, revision) }.exceptionOrNull()
        check(conflict is SyncConflictException) { "Incoming synced changes were overwritten" }
        val incoming = saf.read(saf.resolve("Inbox.md")!!.doc)
        val manifestBefore = saf.read(saf.resolve(".noter/workspace.json")!!.doc)
        val local = WorkspaceOps.updateSettings(
            WorkspaceOps.delete(WorkspaceOps.edit(changed, "overview", fixture("Personal/Overview.md") + "\nLocal conflict edits 📝\n"), "inbox"),
        ) { it.copy(fontSize = 23.0) }
        val preserved = vault.preserveEdits(local, changed)
        check(preserved.notes == 1 && preserved.folder != null)
        check(String(saf.read(saf.resolve("${preserved.folder}/Personal/Overview.md")!!.doc)) == (local.nodes["overview"] as Note).markdown)
        val backup = JSONObject(String(saf.read(saf.resolve(preserved.snapshot)!!.doc)))
        check(backup.getInt("version") == 1 && !backup.getJSONObject("nodes").has("inbox"))
        check(backup.getJSONObject("settings").getDouble("fontSize") == 23.0)
        check(backup.getJSONObject("nodes").getJSONObject("overview").getString("markdown") == (local.nodes["overview"] as Note).markdown)
        check(saf.read(saf.resolve("Inbox.md")!!.doc).contentEquals(incoming)) { "Recovery overwrote an incoming note" }
        check(saf.read(saf.resolve(".noter/workspace.json")!!.doc).contentEquals(manifestBefore)) { "Recovery overwrote the incoming manifest" }
        val reopened = Vault(saf).load().workspace
        check((reopened.nodes["inbox"] as Note).markdown == String(incoming))
        check(reopened.nodes.values.filterIsInstance<Note>().any { it.markdown == (local.nodes["overview"] as Note).markdown })
        val metadataOnly = WorkspaceOps.updateSettings(changed) { it.copy(fontSize = 24.0) }
        val metadataBackup = vault.preserveEdits(metadataOnly, changed)
        check(metadataBackup.folder == null && metadataBackup.notes == 0)
        check(JSONObject(String(saf.read(saf.resolve(metadataBackup.snapshot)!!.doc))).getJSONObject("settings").getDouble("fontSize") == 24.0)
    }
}

internal fun sameJson(actual: Any?, expected: Any?): Boolean = when (expected) {
    is JSONObject -> actual is JSONObject && actual.length() == expected.length() &&
        expected.keys().asSequence().all { sameJson(actual.opt(it), expected.opt(it)) }
    is JSONArray -> actual is JSONArray && actual.length() == expected.length() &&
        (0 until expected.length()).all { sameJson(actual.opt(it), expected.opt(it)) }
    is Number -> actual is Number && actual.toDouble() == expected.toDouble()
    else -> actual == expected
}
