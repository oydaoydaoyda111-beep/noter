package app.noter.state

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.noter.model.Folder
import app.noter.model.Note
import app.noter.model.Settings
import app.noter.model.Workspace
import app.noter.model.WorkspaceOps
import app.noter.model.NoteDatabase
import app.noter.model.databaseMarkdown
import app.noter.storage.Saf
import app.noter.storage.SyncConflictException
import app.noter.storage.Vault
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

enum class Screen { Loading, NeedFolder, Ready, Failed }

class WorkspaceViewModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("noter", 0)
    private val lock = Mutex()
    private var vault: Vault? = null
    private var revision = ""
    private var version = 0
    private var savedVersion = 0
    private var savedWorkspace = Workspace()
    private var saveJob: Job? = null
    private var pollJob: Job? = null

    var screen by mutableStateOf(Screen.Loading); private set
    var workspace by mutableStateOf(Workspace()); private set
    var failure by mutableStateOf<String?>(null); private set
    var loadGeneration by mutableStateOf(0); private set
    var folderName by mutableStateOf(""); private set
    var treeUri by mutableStateOf<Uri?>(null); private set
    var section by mutableStateOf("notes"); private set
    var recovering by mutableStateOf(false); private set
    var recoveryNotice by mutableStateOf<String?>(null); private set

    /** Set when disk changed under unsaved edits; the user chooses between reloading and keeping the edits. */
    var conflict by mutableStateOf<String?>(null); private set

    private val dirty get() = version != savedVersion

    init {
        val saved = preferences.getString(TREE_KEY, null)
        if (saved == null) screen = Screen.NeedFolder else openFolder(Uri.parse(saved))
    }

    /** Pause folder scans in the background; check incoming files as soon as the app returns. */
    fun setForeground(active: Boolean) {
        if (active && pollJob?.isActive == true) return
        pollJob?.cancel()
        pollJob = if (active) viewModelScope.launch {
            checkExternalChanges(force = true)
            while (true) {
                delay(POLL_MS)
                checkExternalChanges()
            }
        } else null
    }

    fun chooseFolder(uri: Uri) {
        val resolver = getApplication<Application>().contentResolver
        resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        viewModelScope.launch {
            flush()
            if (dirty) {
                failure = "Keep your unsaved edits before switching folders. Review synced changes or finish saving first."
                return@launch
            }
            openFolder(uri)
        }
    }

    private fun openFolder(uri: Uri, showLoading: Boolean = true, keepEdits: Boolean = false) {
        if (recovering) return
        if (keepEdits) recovering = true
        if (showLoading) screen = Screen.Loading
        viewModelScope.launch {
            lock.withLock {
                var preserved: Vault.PreservedEdits? = null
                try {
                    val snapshot = workspace
                    val snapshotVersion = version
                    val base = savedWorkspace
                    val opened = withContext(Dispatchers.IO) {
                        if (keepEdits) preserved = (vault ?: throw IllegalStateException("Open your workspace first.")).preserveEdits(snapshot, base)
                        val application = getApplication<Application>()
                        val vault = Vault(Saf(application.contentResolver, uri, application.filesDir))
                        vault to vault.load()
                    }
                    if (version != snapshotVersion) {
                        failure = "More edits arrived during reload. They are still here; review synced changes again when you finish editing."
                        screen = Screen.Ready
                        return@withLock
                    }
                    // Tabs and folder state belong to this device: keep the current ones on reload, restore saved ones on open.
                    val next = applyView(opened.second.workspace, if (showLoading) savedView(uri) else snapshot)
                    val active = snapshot.nodes[snapshot.activeNoteId] as? Note
                    val unchangedNote = !showLoading && !keepEdits && active != null && next.activeNoteId == active.id &&
                        (next.nodes[active.id] as? Note)?.markdown == active.markdown
                    vault = opened.first
                    revision = opened.second.revision
                    workspace = next
                    savedWorkspace = next
                    // Incoming changes to other notes must not reset the open note's cursor or undo history.
                    if (!unchangedNote) loadGeneration++
                    folderName = Uri.decode(uri.lastPathSegment.orEmpty()).substringAfterLast(':').substringAfterLast('/')
                    version = 0
                    savedVersion = 0
                    conflict = null
                    if (showLoading) {
                        recoveryNotice = null
                        val startup = workspace.settings.startupSection
                        section = if (startup == "last") preferences.getString(SECTION_KEY, "notes") ?: "notes" else startup
                    }
                    treeUri = uri
                    preferences.edit().putString(TREE_KEY, uri.toString()).apply()
                    screen = Screen.Ready
                } catch (problem: Exception) {
                    failure = problem.message ?: "Could not open the workspace folder."
                    if (showLoading) screen = Screen.Failed
                } finally {
                    preserved?.let { recoveryNotice = "Your edits were saved ${it.folder?.let { folder -> "in $folder and " }.orEmpty()}in ${it.snapshot}." }
                    if (keepEdits) recovering = false
                }
            }
        }
    }

    fun reload() {
        if (recovering) return
        if (dirty && screen == Screen.Ready) {
            conflict = "Keep your unsaved edits before loading synced files."
            return
        }
        val saved = preferences.getString(TREE_KEY, null) ?: return
        openFolder(Uri.parse(saved), showLoading = false)
    }

    fun keepEditsAndReload() {
        val uri = treeUri ?: return
        openFolder(uri, showLoading = false, keepEdits = true)
    }

    fun dismissRecoveryNotice() { recoveryNotice = null }

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
                if (!dirty || conflict != null || recovering) return@withLock
                val snapshot = workspace
                val snapshotVersion = version
                try {
                    // The base lets the vault merge notes another device changed meanwhile instead of rejecting the save.
                    val base = savedWorkspace
                    revision = withContext(Dispatchers.IO) { target.save(snapshot, revision, base) }
                    savedVersion = snapshotVersion
                    savedWorkspace = snapshot
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

    private suspend fun checkExternalChanges(force: Boolean = false) {
        val target = vault ?: return
        if (screen != Screen.Ready || dirty || conflict != null || recovering || lock.isLocked) return
        val changed = try {
            withContext(Dispatchers.IO) { target.revision(force) != revision }
        } catch (problem: CancellationException) {
            throw problem
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
    fun createDatabase(name: String, parentId: String?) = change {
        val (workspace, id) = WorkspaceOps.addNote(it, name, parentId)
        WorkspaceOps.edit(workspace, id, databaseMarkdown(NoteDatabase.create(name)))
    }
    fun createFolder(name: String, parentId: String?) = change { WorkspaceOps.addFolder(it, name, parentId) }
    fun rename(id: String, name: String) = change { WorkspaceOps.rename(it, id, name) }
    fun delete(id: String) = change { WorkspaceOps.delete(it, id) }
    fun openNote(id: String) = view { WorkspaceOps.open(it, id) }
    fun selectTab(id: String) = view { WorkspaceOps.select(it, id) }
    fun closeTab(id: String) = view { WorkspaceOps.close(it, id) }
    fun toggleFolder(id: String) = view { WorkspaceOps.toggleFolder(it, id) }

    /** Tab and folder changes stay on this device; publishing them made every tap a change for the other devices. */
    private fun view(transform: (Workspace) -> Workspace) {
        val next = transform(workspace)
        if (next === workspace) return
        workspace = next
        val uri = treeUri ?: return
        val state = JSONObject()
            .put("openTabs", JSONArray(next.openTabs))
            .put("activeNoteId", next.activeNoteId ?: JSONObject.NULL)
            .put("collapsedFolders", JSONArray(next.collapsedFolders))
        preferences.edit().putString(VIEW_KEY + uri, state.toString()).apply()
    }

    private fun savedView(uri: Uri): Workspace? = try {
        val state = JSONObject(preferences.getString(VIEW_KEY + uri, null) ?: return null)
        fun strings(key: String) = state.optJSONArray(key)?.let { list -> List(list.length()) { list.optString(it) } }.orEmpty()
        Workspace(openTabs = strings("openTabs"), activeNoteId = state.opt("activeNoteId") as? String, collapsedFolders = strings("collapsedFolders"))
    } catch (_: JSONException) {
        null
    }

    /** [view]'s tabs, active note and collapsed folders, limited to notes and folders that still exist. */
    private fun applyView(workspace: Workspace, view: Workspace?): Workspace {
        if (view == null) return workspace
        val tabs = view.openTabs.distinct().filter { workspace.nodes[it] is Note }
        return workspace.copy(
            openTabs = tabs,
            activeNoteId = view.activeNoteId?.takeIf { it in tabs } ?: tabs.firstOrNull(),
            collapsedFolders = view.collapsedFolders.filter { workspace.nodes[it] is Folder },
        )
    }
    fun updateSettings(transform: (Settings) -> Settings) = change { WorkspaceOps.updateSettings(it, transform) }

    private companion object {
        const val TREE_KEY = "workspaceTree"
        const val SECTION_KEY = "section"
        const val VIEW_KEY = "view:"
        const val POLL_MS = 5000L
    }
}
