package app.noter.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Surface
import app.noter.ui.finance.FinanceManager
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.noter.model.Folder
import app.noter.model.Note
import app.noter.state.FinanceViewModel
import app.noter.state.Screen
import app.noter.ui.finance.FinanceScreen
import androidx.lifecycle.viewmodel.compose.viewModel
import app.noter.state.WorkspaceViewModel
import kotlinx.coroutines.launch

private sealed interface Dialog {
    data class NewNote(val parentId: String?) : Dialog
    data class NewFolder(val parentId: String?) : Dialog
    data class Rename(val id: String) : Dialog
    data class Delete(val id: String) : Dialog
}

@Composable
fun NoterApp(vm: WorkspaceViewModel) {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) vm.chooseFolder(uri)
    }
    NoterTheme(vm.workspace.settings.accentColor) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            when (vm.screen) {
                Screen.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                Screen.NeedFolder -> Message(
                    "Welcome to Noter",
                    "Choose an empty folder or an existing Markdown folder. Notes are stored there as .md files, and shared data in .noter, so you can synchronize it with Syncthing.",
                ) { Button(onClick = { picker.launch(null) }) { Text("Choose workspace folder") } }
                Screen.Failed -> Message("Could not open the workspace", vm.failure.orEmpty()) {
                    RetryActions(onRetry = vm::reload, onChoose = { picker.launch(null) })
                }
                Screen.Ready -> WorkspaceScreen(vm) { picker.launch(null) }
            }
        }
        val failure = vm.failure
        if (failure != null && vm.screen == Screen.Ready) {
            MessageDialog("Noter", failure, "OK", null, onConfirm = vm::dismissFailure, onDismiss = vm::dismissFailure)
        }
    }
}

@Composable
private fun RetryActions(onRetry: () -> Unit, onChoose: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = onRetry) { Text("Try again") }
        Button(onClick = onChoose) { Text("Choose another folder") }
    }
}

@Composable
private fun Message(title: String, body: String, actions: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(body, textAlign = TextAlign.Center)
        actions()
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun WorkspaceScreen(vm: WorkspaceViewModel, onChangeFolder: () -> Unit) {
    val workspace = vm.workspace
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var settingsOpen by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<Dialog?>(null) }
    var conflictDismissed by remember { mutableStateOf(false) }
    LaunchedEffect(vm.conflict) { if (vm.conflict == null) conflictDismissed = false }
    val financeVm: FinanceViewModel = viewModel()
    LaunchedEffect(vm.treeUri) { vm.treeUri?.let(financeVm::bind) }
    val showingFinance = vm.section == "finance"
    var financeManager by remember { mutableStateOf<FinanceManager?>(null) }
    var financeMenu by remember { mutableStateOf(false) }
    val imeVisible = WindowInsets.isImeVisible

    if (settingsOpen) {
        BackHandler { settingsOpen = false }
        SettingsScreen(
            settings = workspace.settings, folderName = vm.folderName, onChange = vm::updateSettings,
            accounts = financeVm.finance?.accounts?.filter { it.archived != true }?.map { it.name }.orEmpty(),
            onChangeFolder = onChangeFolder, onReload = { settingsOpen = false; vm.reload(); financeVm.reload() }, onClose = { settingsOpen = false },
        )
        return
    }

    BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }
    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet {
                TreePanel(
                    workspace = workspace,
                    onOpenNote = { vm.openNote(it); vm.showSection("notes"); scope.launch { drawer.close() } },
                    onToggleFolder = vm::toggleFolder,
                    onNewNote = { dialog = Dialog.NewNote(it) },
                    onNewFolder = { dialog = Dialog.NewFolder(it) },
                    onRename = { dialog = Dialog.Rename(it) },
                    onDelete = { dialog = Dialog.Delete(it) },
                )
            }
        },
    ) {
        val active = workspace.activeNoteId?.let { workspace.nodes[it] as? Note }
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(if (showingFinance) "Finance" else active?.name ?: "Noter", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = { IconButton(onClick = { scope.launch { drawer.open() } }) { Icon(Icons.Default.Menu, contentDescription = "Open notes") } },
                    actions = {
                        if (showingFinance) {
                            Box {
                                IconButton(onClick = { financeMenu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Finance actions") }
                                DropdownMenu(expanded = financeMenu, onDismissRequest = { financeMenu = false }) {
                                    DropdownMenuItem(text = { Text("Manage accounts") }, onClick = { financeMenu = false; financeManager = FinanceManager.Accounts })
                                    DropdownMenuItem(text = { Text("Manage categories") }, onClick = { financeMenu = false; financeManager = FinanceManager.Categories })
                                    DropdownMenuItem(text = { Text("Reload synced files") }, onClick = { financeMenu = false; financeVm.reload() })
                                }
                            }
                        } else {
                            IconButton(onClick = { dialog = Dialog.NewNote(null) }) { Icon(Icons.Default.Add, contentDescription = "New note") }
                        }
                        IconButton(onClick = { settingsOpen = true }) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
                    },
                )
            },
            bottomBar = {
                // Hidden while typing so the formatting toolbar sits directly above the keyboard.
                if (!imeVisible) NavigationBar {
                    NavigationBarItem(
                        selected = !showingFinance, onClick = { vm.showSection("notes") },
                        icon = { Icon(Icons.AutoMirrored.Filled.Notes, contentDescription = null) }, label = { Text("Notes") },
                    )
                    NavigationBarItem(
                        selected = showingFinance, onClick = { vm.showSection("finance") },
                        icon = { Icon(Icons.Default.AccountBalanceWallet, contentDescription = null) }, label = { Text("Finance") },
                    )
                }
            },
        ) { padding ->
            if (showingFinance) {
                FinanceScreen(
                    financeVm, workspace.settings,
                    setDefaultAccount = { name -> vm.updateSettings { it.copy(financeDefaultAccount = name) } },
                    manager = financeManager,
                    onManager = { financeManager = it },
                    modifier = Modifier.padding(padding).consumeWindowInsets(padding).imePadding(),
                )
            } else Column(Modifier.padding(padding).consumeWindowInsets(padding).fillMaxSize().imePadding()) {
                if (vm.conflict != null) {
                    Text(
                        "Files changed outside Noter. Edits are not being saved until you reload.",
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (workspace.openTabs.size > 1) {
                    NoteTabs(workspace.openTabs.mapNotNull { id -> workspace.nodes[id]?.let { id to it.name } }, workspace.activeNoteId, vm::selectTab, vm::closeTab)
                }
                if (active == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Open a note from the menu or create a new one.", modifier = Modifier.padding(32.dp), textAlign = TextAlign.Center)
                    }
                } else {
                    EditorPane(active, vm.loadGeneration, workspace.settings, onChange = { vm.edit(active.id, it) })
                }
            }
        }
    }

    when (val current = dialog) {
        is Dialog.NewNote -> NameDialog("New note", "", "Create", { vm.createNote(it, current.parentId); dialog = null; scope.launch { drawer.close() } }, { dialog = null })
        is Dialog.NewFolder -> NameDialog("New folder", "", "Create", { vm.createFolder(it, current.parentId); dialog = null }, { dialog = null })
        is Dialog.Rename -> NameDialog("Rename", workspace.nodes[current.id]?.name.orEmpty(), "Rename", { vm.rename(current.id, it); dialog = null }, { dialog = null })
        is Dialog.Delete -> {
            val node = workspace.nodes[current.id]
            val extra = if (node is Folder) " and everything inside it" else ""
            MessageDialog(
                "Delete \"${node?.name.orEmpty()}\"?", "This removes it$extra from the workspace. Previous note versions are kept in .noter/trash.",
                "Delete", "Cancel", { vm.delete(current.id); dialog = null }, { dialog = null },
            )
        }
        null -> {}
    }

    if (vm.conflict != null && !conflictDismissed) {
        MessageDialog(
            "Files changed outside Noter", "Synced changes arrived while you had unsaved edits. Reloading discards your unsaved edits; keep editing to copy them elsewhere first.",
            "Reload", "Keep editing", { conflictDismissed = false; vm.discardEditsAndReload() }, { conflictDismissed = true },
        )
    }
}

@Composable
private fun NoteTabs(tabs: List<Pair<String, String>>, active: String?, onSelect: (String) -> Unit, onClose: (String) -> Unit) {
    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(tabs, key = { it.first }) { (id, name) ->
            val selected = id == active
            Surface(
                onClick = { onSelect(id) },
                shape = RoundedCornerShape(10.dp),
                color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
            ) {
                Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge,
                        color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.widthIn(max = 160.dp),
                    )
                    IconButton(onClick = { onClose(id) }, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Default.Close, contentDescription = "Close $name", modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}
