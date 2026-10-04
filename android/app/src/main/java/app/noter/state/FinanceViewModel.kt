package app.noter.state

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.noter.finance.Account
import app.noter.finance.Finance
import app.noter.finance.FinanceException
import app.noter.finance.FinanceFiles
import app.noter.finance.FinanceState
import app.noter.finance.batchLine
import app.noter.finance.diffFinance
import app.noter.finance.parseLegacyFinance
import app.noter.finance.parseLogs
import app.noter.finance.replayFinance
import app.noter.finance.sha256
import app.noter.finance.validateFinance
import app.noter.storage.Saf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.UUID

private const val SYNCING = "Finance workbook is still syncing or was changed independently. Wait for Syncthing to finish and reload."

class FinanceViewModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("noter", 0)
    private val device: String = preferences.getString("financeDevice", null)
        ?: UUID.randomUUID().toString().replace("-", "").also { preferences.edit().putString("financeDevice", it).apply() }
    private val lock = Mutex()
    private var files: FinanceFiles? = null
    private var boundUri: Uri? = null
    private var revision = ""
    private var clock = 0L
    private var seq = 0L
    private var needsNewline = false
    private var pollJob: Job? = null

    /** The data as last loaded or saved; saves append only the difference from it. */
    private var base: FinanceState? = null

    var finance by mutableStateOf<Finance?>(null); private set
    var loaded by mutableStateOf(false); private set
    var loadError by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var status by mutableStateOf(""); private set
    var statusIsError by mutableStateOf(false); private set

    /** Set by the UI while a Finance dialog is open, so polling never replaces data under an edit. */
    var dialogOpen = false

    /** Finance uses the same foreground-only sync schedule as notes. */
    fun setForeground(active: Boolean) {
        if (active && pollJob?.isActive == true) return
        pollJob?.cancel()
        pollJob = if (active) viewModelScope.launch {
            while (true) {
                checkExternalChanges()
                delay(5000)
            }
        } else null
    }

    private fun message(text: String, error: Boolean = false) {
        status = text
        statusIsError = error
    }

    fun bind(uri: Uri) {
        if (uri == boundUri) return
        boundUri = uri
        val application = getApplication<Application>()
        files = FinanceFiles(Saf(application.contentResolver, uri, application.filesDir))
        reload()
    }

    /** Appends one batch to this device's log. Must run under [lock] on the IO dispatcher. */
    private fun append(target: FinanceFiles, ops: List<org.json.JSONObject>, template: ByteArray?, retireLegacy: Boolean) {
        val (line, ts) = batchLine(device, clock, seq + 1, ops)
        revision = target.append(device, (if (needsNewline) "\n" else "") + line, template, retireLegacy)
        clock = ts
        seq++
        needsNewline = false
    }

    private fun load(target: FinanceFiles): Finance? {
        val before = target.revision()
        val raw = target.read()
        val parsed = parseLogs(raw.logs, device)
        clock = parsed.clock
        seq = parsed.seq
        needsNewline = parsed.ownNeedsNewline
        val template = raw.template ?: ByteArray(0)
        val templateSha256 = raw.template?.let(::sha256) ?: ""
        var state = replayFinance(parsed.batches)
        if (target.revision() != before) throw FinanceException("Finance changed while loading. Wait for synchronization and reload.")
        revision = before
        if (state == null && raw.legacy != null) {
            // One-time migration from the former single .noter/finance.json file.
            val expected = Regex("\"templateSha256\"\\s*:\\s*\"([0-9a-f]+)\"").find(raw.legacy)?.groupValues?.get(1)
            if (expected != null && expected != templateSha256) throw FinanceException(SYNCING)
            val legacy = parseLegacyFinance(raw.legacy, ByteArray(0))
            append(target, diffFinance(null, legacy, templateSha256), null, retireLegacy = true)
            state = FinanceState(legacy, templateSha256)
        }
        base = null
        if (state == null) return null
        if (state.templateSha256 != templateSha256) throw FinanceException(SYNCING)
        val result = validateFinance(state.finance).withTemplate(template)
        base = FinanceState(result, state.templateSha256)
        return result
    }

    fun reload() {
        val target = files ?: return
        viewModelScope.launch {
            lock.withLock {
                try {
                    finance = withContext(Dispatchers.IO) { load(target) }
                    loadError = false
                    if (statusIsError) message("")
                } catch (problem: Exception) {
                    loadError = true
                    message("${problem.message ?: problem.toString()} Reload to try again.", true)
                } finally {
                    loaded = true
                }
            }
        }
    }

    private suspend fun checkExternalChanges() {
        val target = files ?: return
        if (busy || dialogOpen || lock.isLocked || !loaded) return
        val changed = try {
            withContext(Dispatchers.IO) { target.revision() != revision }
        } catch (problem: CancellationException) {
            throw problem
        } catch (_: Exception) {
            loadError
        }
        if (changed && !busy && !dialogOpen) reload()
    }

    /** Persists [next] by appending its difference from the last loaded or saved data. */
    suspend fun commit(next: Finance): Boolean {
        val target = files ?: return false
        if (busy || loadError) return false
        busy = true
        message("Saving…")
        return withContext(NonCancellable) {
            lock.withLock {
                try {
                    val previous = base
                    withContext(Dispatchers.IO) {
                        val templateSha256 = if (previous != null && previous.finance.template === next.template) previous.templateSha256 else sha256(next.template)
                        val ops = diffFinance(previous, next, templateSha256)
                        if (ops.isNotEmpty()) append(target, ops, next.template.takeIf { templateSha256 != previous?.templateSha256 }, retireLegacy = false)
                        base = FinanceState(next, templateSha256)
                    }
                    finance = next
                    message("Saved in your workspace folder")
                    true
                } catch (problem: Exception) {
                    // The provider may have committed the batch before reporting failure; reload its actual sequence.
                    loadError = true
                    message("${problem.message ?: "Could not save Finance."} Reload Finance before saving again.", true)
                    false
                } finally {
                    busy = false
                }
            }
        }
    }

    /** Starts Finance without a workbook. Excel import/export is not available on Android yet. */
    fun start(accountName: String, onDone: (Boolean) -> Unit) {
        val name = accountName.trim()
        if (name.isEmpty() || name.length > 120) {
            message("Enter an account name between 1 and 120 characters.", true)
            onDone(false)
            return
        }
        viewModelScope.launch {
            onDone(commit(Finance(listOf(Account(name, "")), emptyList(), emptyList(), "Noter Android", ByteArray(0))))
        }
    }
}

private fun Finance.withTemplate(template: ByteArray) =
    Finance(accounts, transactions, categories, sourceName, template, defaults, categoryDefinitions)
