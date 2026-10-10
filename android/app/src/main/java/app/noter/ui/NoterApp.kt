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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SyncProblem
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.noter.model.Folder
import app.noter.model.Note
import app.noter.state.FinanceViewModel
import app.noter.state.PlannerViewModel
import app.noter.ui.planner.PlannerScreen
import androidx.compose.material.icons.filled.CalendarMonth
import app.noter.state.Screen
import app.noter.ui.finance.FinanceScreen
import app.noter.state.WorkspaceViewModel
import kotlinx.coroutines.launch

private sealed interface Dialog {
    data class NewNote(val parentId: String?) : Dialog
    data class NewDatabase(val parentId: String?) : Dialog
    data class NewFolder(val parentId: String?) : Dialog
    data class Rename(val id: String) : Dialog
    data class Delete(val id: String) : Dialog
}

@Composable
fun NoterApp(vm: WorkspaceViewModel, financeVm: FinanceViewModel, plannerVm: PlannerViewModel) {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) vm.chooseFolder(uri)
    }
    NoterTheme(vm.workspace.settings.accentColor) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            when (vm.screen) {
                Screen.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                Screen.NeedFolder -> Message(
                    "Your space to think",
                    "Notes, finances and plans, in one quiet workspace. Choose a folder to get started. Your Markdown files stay yours and sync with Syncthing.",
                ) { Button(onClick = { picker.launch(null) }, modifier = Modifier.fillMaxWidth()) { Text("Choose workspace folder") } }
                Screen.Failed -> Message("Could not open the workspace", vm.failure.orEmpty()) {
                    RetryActions(onRetry = vm::reload, onChoose = { picker.launch(null) })
                }
                Screen.Ready -> WorkspaceScreen(vm, financeVm, plannerVm) { picker.launch(null) }
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
        Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.primaryContainer) {
            Icon(Icons.AutoMirrored.Filled.Notes, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(22.dp).size(36.dp))
        }
        Text(title, style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
        Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Column(Modifier.widthIn(max = 360.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) { actions() }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun WorkspaceScreen(vm: WorkspaceViewModel, financeVm: FinanceViewModel, plannerVm: PlannerViewModel, onChangeFolder: () -> Unit) {
    val workspace = vm.workspace
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var settingsOpen by remember { mutableStateOf(false) }
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<Dialog?>(null) }
    var conflictDismissed by remember { mutableStateOf(false) }
    LaunchedEffect(vm.conflict) { if (vm.conflict == null) conflictDismissed = false }
    LaunchedEffect(vm.treeUri) { vm.treeUri?.let { financeVm.bind(it); plannerVm.bind(it) } }
    val showingFinance = vm.section == "finance"
    val showingPlanner = vm.section == "planner"
    var plannerMenu by remember { mutableStateOf(false) }
    var financeManager by remember { mutableStateOf<FinanceManager?>(null) }
    var financeMenu by remember { mutableStateOf(false) }
    val imeVisible = WindowInsets.isImeVisible

    if (settingsOpen) {
        BackHandler { settingsOpen = false }
        SettingsScreen(
            settings = workspace.settings, folderName = vm.folderName, onChange = vm::updateSettings,
            accounts = financeVm.finance?.accounts?.filter { it.archived != true }?.map { it.name }.orEmpty(),
            onChangeFolder = onChangeFolder, onReload = { settingsOpen = false; vm.reload(); financeVm.reload(); plannerVm.reload() }, onClose = { settingsOpen = false },
        )
        return
    }

    BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }
    ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = drawer.isOpen || (!imeVisible && !showingFinance && !showingPlanner),
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
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
                    title = {
                        Column {
                            Text(if (showingFinance) "Finance" else if (showingPlanner) "Planner" else "Notes", style = MaterialTheme.typography.titleLarge)
                            Text(vm.folderName.ifEmpty { "Noter" }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
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
                        } else if (showingPlanner) {
                            Box {
                                IconButton(onClick = { plannerMenu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Planner actions") }
                                DropdownMenu(expanded = plannerMenu, onDismissRequest = { plannerMenu = false }) {
                                    DropdownMenuItem(text = { Text("Reload synced files") }, onClick = { plannerMenu = false; plannerVm.reload() })
                                }
                            }
                        } else {
                            IconButton(onClick = { searchOpen = true }) { Icon(Icons.Default.Search, contentDescription = "Search notes") }
                            IconButton(onClick = { dialog = Dialog.NewDatabase(null) }) { Icon(Icons.Default.TableChart, contentDescription = "New database") }
                            FilledTonalIconButton(onClick = { dialog = Dialog.NewNote(null) }) { Icon(Icons.Default.Add, contentDescription = "New note") }
                        }
                        IconButton(onClick = { settingsOpen = true }) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
                    },
                )
            },
            bottomBar = {
                // Hidden while typing so the formatting toolbar sits directly above the keyboard.
                if (!imeVisible) Column {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    NavigationBar(
                        modifier = Modifier.navigationBarsPadding().height(72.dp),
                        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                        tonalElevation = 0.dp,
                        windowInsets = WindowInsets(0, 0, 0, 0),
                    ) {
                        NavigationBarItem(
                            selected = !showingFinance && !showingPlanner, onClick = { vm.showSection("notes") },
                            icon = { Icon(Icons.AutoMirrored.Filled.Notes, contentDescription = null) }, label = { Text("Notes") },
                        )
                        NavigationBarItem(
                            selected = showingFinance, onClick = { vm.showSection("finance") },
                            icon = { Icon(Icons.Default.AccountBalanceWallet, contentDescription = null) }, label = { Text("Finance") },
                        )
                        NavigationBarItem(
                            selected = showingPlanner, onClick = { vm.showSection("planner") },
                            icon = { Icon(Icons.Default.CalendarMonth, contentDescription = null) }, label = { Text("Planner") },
                        )
                    }
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
            } else if (showingPlanner) {
                PlannerScreen(plannerVm, modifier = Modifier.padding(padding).consumeWindowInsets(padding).imePadding())
            } else Column(Modifier.padding(padding).consumeWindowInsets(padding).fillMaxSize().imePadding()) {
                vm.recoveryNotice?.let { message ->
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                            Text(message, style = MaterialTheme.typography.bodySmall)
                            TextButton(onClick = vm::dismissRecoveryNotice) { Text("Dismiss") }
                        }
                    }
                }
                if (vm.conflict != null) {
                    Surface(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.error.copy(alpha = 0.1f),
                    ) {
                        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Icon(Icons.Default.SyncProblem, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
                                Text("Sync needs attention", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall)
                            }
                            Text("Files changed outside Noter. Saving is paused to protect your edits.", modifier = Modifier.padding(top = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            TextButton(onClick = { conflictDismissed = false }, enabled = !vm.recovering) { Text(if (vm.recovering) "Keeping edits…" else "Review changes") }
                        }
                    }
                }
                if (workspace.openTabs.size > 1) {
                    NoteTabs(workspace.openTabs.mapNotNull { id -> workspace.nodes[id]?.let { id to it.name } }, workspace.activeNoteId, vm::selectTab, vm::closeTab)
                }
                if (active == null) {
                    Column(
                        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                            Icon(Icons.AutoMirrored.Filled.Notes, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(20.dp).size(32.dp))
                        }
                        Text("Make room for an idea", style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
                        Text("Create a note, or open one from your workspace.", color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                        Button(onClick = { dialog = Dialog.NewNote(null) }) { Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.padding(end = 8.dp).size(18.dp)); Text("New note") }
                        TextButton(onClick = { scope.launch { drawer.open() } }) { Text("Browse notes") }
                    }
                } else {
                    EditorPane(active, vm.loadGeneration, workspace.settings, onChange = { vm.edit(active.id, it) })
                }
            }
        }
    }

    if (searchOpen) {
        SearchDialog(workspace, onOpen = { id ->
            vm.openNote(id); vm.showSection("notes"); searchOpen = false
        }, onClose = { searchOpen = false })
    }

    when (val current = dialog) {
        is Dialog.NewNote -> NameDialog("New note", "", "Create", { vm.createNote(it, current.parentId); vm.showSection("notes"); dialog = null; scope.launch { drawer.close() } }, { dialog = null })
        is Dialog.NewDatabase -> NameDialog("New database", "", "Create", { vm.createDatabase(it, current.parentId); vm.showSection("notes"); dialog = null }, { dialog = null })
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

    if (vm.conflict != null && !conflictDismissed && !vm.recovering) {
        MessageDialog(
            "Keep both versions", "Keep your changed notes as Markdown copies in a Recovered edits folder, and back up your full workspace before loading synced files.",
            "Keep edits and reload", "Keep editing", { conflictDismissed = true; vm.keepEditsAndReload() }, { conflictDismissed = true },
        )
    }
}

@Composable
private fun NoteTabs(tabs: List<Pair<String, String>>, active: String?, onSelect: (String) -> Unit, onClose: (String) -> Unit) {
    val listState = rememberLazyListState()
    LaunchedEffect(active) {
        val index = tabs.indexOfFirst { it.first == active }
        if (index >= 0) listState.scrollToItem(index)
    }
    LazyRow(state = listState, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(tabs, key = { it.first }) { (id, name) ->
            val isSelected = id == active
            Surface(
                onClick = { onSelect(id) },
                modifier = Modifier.semantics { selected = isSelected; role = Role.Tab },
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, if (isSelected) MaterialTheme.colorScheme.primary.copy(alpha = 0.3f) else MaterialTheme.colorScheme.outlineVariant),
                color = if (isSelected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
            ) {
                Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge,
                        color = if (isSelected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.widthIn(max = 160.dp),
                    )
                    IconButton(onClick = { onClose(id) }) {
                        Icon(Icons.Default.Close, contentDescription = "Close $name", modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}
