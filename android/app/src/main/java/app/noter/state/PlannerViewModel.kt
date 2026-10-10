package app.noter.state

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.noter.planner.Planner
import app.noter.planner.PlannerBatch
import app.noter.planner.LogFile
import app.noter.planner.PlannerFiles
import app.noter.planner.batchLine
import app.noter.planner.parsePlannerLogs
import app.noter.planner.replayPlanner
import app.noter.storage.Saf
import app.noter.storage.strictJsonObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

class PlannerViewModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("noter", 0)

    // The installation ID Finance already uses; it names this device's Planner log too.
    private val device: String = preferences.getString("financeDevice", null)
        ?: UUID.randomUUID().toString().replace("-", "").also { preferences.edit().putString("financeDevice", it).apply() }
    private val lock = Mutex()
    private var files: PlannerFiles? = null
    private var boundUri: Uri? = null
    private var revision = ""
    private var clock = 0L
    private var seq = 0L
    private var needsNewline = false
    private var batches = ArrayList<PlannerBatch>()
    private var pollJob: Job? = null

    var planner by mutableStateOf(Planner.EMPTY); private set
    var loaded by mutableStateOf(false); private set
    var loadError by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var status by mutableStateOf(""); private set
    var statusIsError by mutableStateOf(false); private set

    /** Set by the UI while a Planner dialog is open, so polling never replaces data under an edit. */
    var dialogOpen = false

    fun setForeground(active: Boolean) {
        if (active && pollJob?.isActive == true) return
        pollJob?.cancel()
        pollJob = if (active) viewModelScope.launch {
            checkExternalChanges(force = true)
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
        files = PlannerFiles(Saf(application.contentResolver, uri, application.filesDir))
        loaded = false
        reload()
    }

    private fun load(target: PlannerFiles): Planner {
        val before = target.revision(force = true)
        val parsed = parsePlannerLogs(target.read(), device, ::strictJsonObject)
        if (target.revision(force = true) != before) throw IllegalStateException("Planner changed while loading. Wait for synchronization and reload.")
        revision = before
        clock = parsed.clock
        seq = parsed.seq
        needsNewline = parsed.ownNeedsNewline
        batches = ArrayList(parsed.batches)
        return replayPlanner(batches)
    }

    fun reload() {
        val target = files ?: return
        viewModelScope.launch {
            lock.withLock {
                try {
                    planner = withContext(Dispatchers.IO) { load(target) }
                    loadError = false
                    if (statusIsError) message("")
                } catch (problem: CancellationException) {
                    throw problem
                } catch (problem: Exception) {
                    loadError = true
                    message("${problem.message ?: problem.toString()} Reload to try again.", true)
                } finally {
                    loaded = true
                }
            }
        }
    }

    private suspend fun checkExternalChanges(force: Boolean = false) {
        val target = files ?: return
        if (busy || dialogOpen || lock.isLocked || !loaded) return
        val changed = try {
            withContext(Dispatchers.IO) { target.revision(force) != revision }
        } catch (problem: CancellationException) {
            throw problem
        } catch (_: Exception) {
            loadError
        }
        if (changed && !busy && !dialogOpen) reload()
    }

    /** Appends one batch of operations to this device's log. */
    suspend fun commit(ops: List<JSONObject>): Boolean {
        val target = files ?: return false
        if (busy || loadError || ops.isEmpty()) return false
        busy = true
        message("Saving…")
        return withContext(NonCancellable) {
            lock.withLock {
                try {
                    val next = withContext(Dispatchers.IO) {
                        val (line, ts) = batchLine(device, clock, seq + 1, ops)
                        // Only a reload acknowledges other devices' batches, so the revision is left for polling to compare.
                        target.append(device, (if (needsNewline) "\n" else "") + line)
                        clock = ts
                        seq++
                        needsNewline = false
                        batches.add(parsePlannerLogs(listOf(LogFile("log-$device.jsonl", line)), device, ::strictJsonObject).batches.single())
                        replayPlanner(batches)
                    }
                    planner = next
                    message("Saved in your workspace folder")
                    true
                } catch (problem: Exception) {
                    // The provider may have committed the batch before reporting failure; reload its actual sequence.
                    loadError = true
                    message("${problem.message ?: "Could not save Planner."} Reload Planner before saving again.", true)
                    false
                } finally {
                    busy = false
                }
            }
        }
    }
}
