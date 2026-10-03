package app.noter.state

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.noter.model.Settings
import app.noter.model.Workspace
import app.noter.model.WorkspaceOps
import app.noter.storage.Saf
import app.noter.storage.SyncConflictException
import app.noter.storage.Vault
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

enum class Screen { Loading, NeedFolder, Ready, Failed }

class WorkspaceViewModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("noter", 0)
    private val lock = Mutex()
    private var vault: Vault? = null
    private var revision = ""
    private var version = 0
    private var savedVersion = 0
    private var saveJob: Job? = null

    var screen by mutableStateOf(Screen.Loading); private set
    var workspace by mutableStateOf(Workspace()); private set
    var failure by mutableStateOf<String?>(null); private set
    var loadGeneration by mutableStateOf(0); private set
    var folderName by mutableStateOf(""); private set
    var treeUri by mutableStateOf<Uri?>(null); private set
    var section by mutableStateOf("notes"); private set

    /** Set when disk changed under unsaved edits; the user chooses between reloading and keeping the edits. */
    var conflict by mutableStateOf<String?>(null); private set

    private val dirty get() = version != savedVersion

    init {
        val saved = preferences.getString(TREE_KEY, null)
        if (saved == null) screen = Screen.NeedFolder else openFolder(Uri.parse(saved))
        viewModelScope.launch {
            while (true) {
                delay(POLL_MS)
                checkExternalChanges()
            }
        }
    }

    fun chooseFolder(uri: Uri) {
        val resolver = getApplication<Application>().contentResolver
        resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        preferences.edit().putString(TREE_KEY, uri.toString()).apply()
        viewModelScope.launch {
            flush()
            openFolder(uri)
        }
    }

    private fun openFolder(uri: Uri, showLoading: Boolean = true) {
        if (showLoading) screen = Screen.Loading
        viewModelScope.launch {
            lock.withLock {
                try {
                    val opened = withContext(Dispatchers.IO) {
                        val vault = Vault(Saf(getApplication<Application>().contentResolver, uri))
                        vault to vault.load()
                    }
                    vault = opened.first
                    revision = opened.second.revision
                    workspace = opened.second.workspace
                    loadGeneration++
                    folderName = Uri.decode(uri.lastPathSegment.orEmpty()).substringAfterLast(':').substringAfterLast('/')
                    version = 0
                    savedVersion = 0
                    conflict = null
                    if (showLoading) {
                        val startup = workspace.settings.startupSection
                        section = if (startup == "last") preferences.getString(SECTION_KEY, "notes") ?: "notes" else startup
                    }
                    treeUri = uri
                    screen = Screen.Ready
                } catch (problem: Exception) {
                    failure = problem.message ?: "Could not open the workspace folder."
                    screen = Screen.Failed
                }
            }
        }
    }

    fun reload() {
        val saved = preferences.getString(TREE_KEY, null) ?: return
        openFolder(Uri.parse(saved), showLoading = false)
    }

    fun discardEditsAndReload() {
        conflict = null
        reload()
    }

    private fun change(transform: (Workspace) -> Workspace) {
        val next = transform(workspace)
        if (next === workspace) return
        workspace = next
        version++
        saveJob?.cancel()
        saveJob = viewModelScope.launch {
            delay(workspace.settings.autosaveDelay.toLong())
            flush()
        }
    }

    suspend fun flush() {
        saveJob?.cancel()
        withContext(NonCancellable) {
            lock.withLock {
                val target = vault ?: return@withLock
                if (!dirty || conflict != null) return@withLock
                val snapshot = workspace
                val snapshotVersion = version
                try {
                    revision = withContext(Dispatchers.IO) { target.save(snapshot, revision) }
                    savedVersion = snapshotVersion
                } catch (problem: SyncConflictException) {
                    conflict = problem.message
                } catch (problem: Exception) {
                    failure = problem.message ?: "Could not save."
                }
            }
        }
    }

    fun flushNow() {
        viewModelScope.launch { flush() }
    }

    private suspend fun checkExternalChanges() {
        val target = vault ?: return
        if (screen != Screen.Ready || dirty || conflict != null || lock.isLocked) return
        val changed = try {
            withContext(Dispatchers.IO) { target.revision() != revision }
        } catch (_: Exception) {
            false
        }
        if (changed && !dirty && !lock.isLocked) reload()
    }

    fun showSection(name: String) {
        section = name
        preferences.edit().putString(SECTION_KEY, name).apply()
    }

    fun dismissFailure() { failure = null; if (screen == Screen.Failed) screen = Screen.NeedFolder }

    fun edit(id: String, markdown: String) = change { WorkspaceOps.edit(it, id, markdown) }
    fun createNote(name: String, parentId: String?) = change { WorkspaceOps.addNote(it, name, parentId).first }
    fun createFolder(name: String, parentId: String?) = change { WorkspaceOps.addFolder(it, name, parentId) }
    fun rename(id: String, name: String) = change { WorkspaceOps.rename(it, id, name) }
    fun delete(id: String) = change { WorkspaceOps.delete(it, id) }
    fun openNote(id: String) = change { WorkspaceOps.open(it, id) }
    fun selectTab(id: String) = change { WorkspaceOps.select(it, id) }
    fun closeTab(id: String) = change { WorkspaceOps.close(it, id) }
    fun toggleFolder(id: String) = change { WorkspaceOps.toggleFolder(it, id) }
    fun updateSettings(transform: (Settings) -> Settings) = change { WorkspaceOps.updateSettings(it, transform) }

    private companion object {
        const val TREE_KEY = "workspaceTree"
        const val SECTION_KEY = "section"
        const val POLL_MS = 5000L
    }
}
