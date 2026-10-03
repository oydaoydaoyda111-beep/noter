package app.noter.ui.finance

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.noter.finance.Finance
import app.noter.finance.addCategory
import app.noter.finance.archiveAccount
import app.noter.finance.balances
import app.noter.finance.categoryCatalog
import app.noter.finance.deleteCategory
import app.noter.finance.isTransferCategory
import app.noter.finance.mergeCategories
import app.noter.finance.renameCategory
import app.noter.finance.updateAccount
import app.noter.ui.MessageDialog
import app.noter.ui.NoterColors
import kotlinx.coroutines.launch

/** Applies an operation and saves it; reports validation or save failures through [status]. */
private class Applier(val finance: () -> Finance, val commit: suspend (Finance) -> Boolean) {
    var status by mutableStateOf("")
    var isError by mutableStateOf(false)
    var saving by mutableStateOf(false)

    suspend fun apply(operation: (Finance) -> Finance): Boolean {
        if (saving) return false
        return try {
            val next = operation(finance())
            saving = true
            if (!commit(next)) throw IllegalStateException("Could not save. Your previous data is unchanged.")
            status = ""; isError = false; true
        } catch (problem: Exception) {
            status = problem.message ?: "Could not update."; isError = true; false
        } finally {
            saving = false
        }
    }
}

/** A full-screen manager with a back arrow, a search field, a list, and an add button. */
@Composable
private fun ManagerFrame(
    title: String,
    description: String,
    search: String,
    onSearch: (String) -> Unit,
    searchHint: String,
    addLabel: String,
    applier: Applier,
    onAdd: () -> Unit,
    onClose: () -> Unit,
    content: LazyListScope.() -> Unit,
) {
    Dialog(onDismissRequest = { if (!applier.saving) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.fillMaxSize().systemBarsPadding()) {
                Column(Modifier.fillMaxSize()) {
                    Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = onClose, enabled = !applier.saving) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                        Text(title, style = MaterialTheme.typography.titleLarge)
                    }
                    LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 96.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        item {
                            Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            OutlinedTextField(
                                value = search, onValueChange = onSearch, singleLine = true,
                                placeholder = { Text(searchHint) },
                                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                                trailingIcon = if (search.isNotEmpty()) {
                                    { IconButton(onClick = { onSearch("") }) { Icon(Icons.Default.Close, contentDescription = "Clear search") } }
                                } else null,
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp),
                            )
                            if (applier.status.isNotEmpty()) {
                                Text(applier.status, color = if (applier.isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        content()
                    }
                }
                ExtendedFloatingActionButton(
                    onClick = { if (!applier.saving) onAdd() },
                    icon = { Icon(Icons.Default.Add, contentDescription = null) },
                    text = { Text(addLabel) },
                    modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
                )
            }
        }
    }
}

/** Row menu with the given actions; each action is (label, enabled, color, run). */
@Composable
private fun RowMenu(actions: List<MenuAction>, enabled: Boolean) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, enabled = enabled) { Icon(Icons.Default.MoreVert, contentDescription = "Actions") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            actions.forEach { action ->
                DropdownMenuItem(
                    text = { Text(action.label, color = if (action.danger) MaterialTheme.colorScheme.error else Color.Unspecified) },
                    enabled = action.enabled,
                    onClick = { open = false; action.run() },
                )
            }
        }
    }
}

private class MenuAction(val label: String, val enabled: Boolean = true, val danger: Boolean = false, val run: () -> Unit)

@Composable
private fun TextInputDialog(title: String, description: String?, fields: List<Pair<String, String>>, submit: String, onSubmit: suspend (List<String>) -> String?, onDismiss: () -> Unit) {
    var values by remember { mutableStateOf(fields.map { it.second }) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                fields.forEachIndexed { index, (label, _) ->
                    OutlinedTextField(value = values[index], onValueChange = { v -> values = values.toMutableList().also { it[index] = v } }, label = { Text(label) }, singleLine = index == 0)
                }
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = { TextButton(onClick = { scope.launch { onSubmit(values)?.let { error = it } ?: onDismiss() } }) { Text(submit) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
fun AccountManager(
    finance: Finance,
    format: (Long) -> String,
    defaultAccount: String,
    setDefault: (String) -> Unit,
    commit: suspend (Finance) -> Boolean,
    onClose: () -> Unit,
) {
    val latest = rememberUpdatedState(finance)
    val applier = remember { Applier({ latest.value }, commit) }
    val scope = rememberCoroutineScope()
    var search by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    val totals = balances(finance)
    val needle = search.trim().lowercase()
    val visible = finance.accounts.filter { a -> listOf(a.name, a.note).any { it.lowercase().contains(needle) } }
    ManagerFrame(
        "Accounts", "Edit names and notes, choose a default, or archive accounts. Archived accounts keep their balances and history.",
        search, { search = it }, "Find an account", "Add account", applier, onAdd = { adding = true }, onClose = onClose,
    ) {
        if (visible.isEmpty()) item { Text("No accounts match.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 24.dp)) }
        items(visible, key = { it.name }) { account ->
            val count = finance.transactions.count { it.account == account.name }
            val cents = totals[account.name] ?: 0
            FieldGroup {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(account.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                color = if (account.archived == true) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                            if (defaultAccount == account.name) Icon(Icons.Default.Star, contentDescription = "Default account", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 6.dp).heightIn(max = 16.dp))
                        }
                        Text(
                            "$count ${if (count == 1) "transaction" else "transactions"}" + if (account.archived == true) " · Archived" else "",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (account.note.isNotEmpty()) Text(account.note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    Text(format(cents), style = MaterialTheme.typography.titleSmall, color = if (cents < 0) NoterColors.danger else MaterialTheme.colorScheme.onSurface)
                    RowMenu(
                        listOf(
                            MenuAction("Edit") { editing = account.name },
                            MenuAction("Set as default", enabled = account.archived != true && defaultAccount != account.name) { setDefault(account.name) },
                            MenuAction(if (account.archived == true) "Restore" else "Archive") {
                                scope.launch {
                                    val archive = account.archived != true
                                    if (applier.apply { archiveAccount(it, account.name, archive) } && archive && defaultAccount == account.name) setDefault("")
                                }
                            },
                        ),
                        enabled = !applier.saving,
                    )
                }
            }
        }
    }
    if (adding || editing != null) {
        val previous = editing
        val account = finance.accounts.firstOrNull { it.name == previous }
        TextInputDialog(
            title = if (previous != null) "Edit account" else "Add account",
            description = if (previous != null) "Renaming updates existing transactions and linked transfers. Balances stay the same."
            else "Starts at zero. Add an income entry with category Initial for an opening balance.",
            fields = listOf("Account name" to account?.name.orEmpty(), "Notes (optional)" to account?.note.orEmpty()),
            submit = "Save",
            onSubmit = { (name, note) ->
                if (applier.apply { updateAccount(it, previous, name, note.trim()) }) {
                    if (previous != null && defaultAccount == previous) setDefault(name.trim())
                    null
                } else applier.status
            },
            onDismiss = { adding = false; editing = null },
        )
    }
}

private sealed interface CategoryAction {
    data class Add(val parent: String?) : CategoryAction
    data class Rename(val name: String, val subcategory: String?) : CategoryAction
    data class Delete(val name: String, val subcategory: String?) : CategoryAction
    data class Merge(val name: String) : CategoryAction
}

@Composable
fun CategoryManager(finance: Finance, commit: suspend (Finance) -> Boolean, onClose: () -> Unit) {
    val latest = rememberUpdatedState(finance)
    val applier = remember { Applier({ latest.value }, commit) }
    val scope = rememberCoroutineScope()
    var search by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(setOf<String>()) }
    var action by remember { mutableStateOf<CategoryAction?>(null) }
    val catalog = categoryCatalog(finance)
    val needle = search.trim().lowercase()
    val visible = catalog.filter { c -> (listOf(c.name) + c.subcategories).any { it.lowercase().contains(needle) } }
    val editableCount = catalog.count { !isTransferCategory(it.name) }
    ManagerFrame(
        "Categories", "Organize your transactions. Tap a category to see and manage its subcategories.",
        search, { search = it }, "Find a category or subcategory", "Add category", applier,
        onAdd = { action = CategoryAction.Add(null) }, onClose = onClose,
    ) {
        if (visible.isEmpty()) item { Text("No categories match.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 24.dp)) }
        items(visible, key = { it.name }) { category ->
            val open = category.name in expanded || needle.isNotEmpty()
            val count = finance.transactions.count { it.category == category.name }
            val reserved = isTransferCategory(category.name)
            FieldGroup {
                Row(
                    Modifier.fillMaxWidth().clickable { expanded = if (open) expanded - category.name else expanded + category.name }
                        .padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Monogram(category.name)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(category.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            if (reserved) "Reserved for transfers · $count" else
                                "$count ${if (count == 1) "transaction" else "transactions"} · ${category.subcategories.size} ${if (category.subcategories.size == 1) "subcategory" else "subcategories"}",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Icon(if (open) Icons.Default.ExpandLess else Icons.Default.ExpandMore, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (!reserved) RowMenu(
                        listOf(
                            MenuAction("Add subcategory") { action = CategoryAction.Add(category.name) },
                            MenuAction("Rename") { action = CategoryAction.Rename(category.name, null) },
                            MenuAction("Merge into…", enabled = editableCount >= 2) { action = CategoryAction.Merge(category.name) },
                            MenuAction("Delete", danger = true) { action = CategoryAction.Delete(category.name, null) },
                        ),
                        enabled = !applier.saving,
                    ) else Box(Modifier.padding(end = 12.dp))
                }
                if (open) {
                    category.subcategories.forEach { sub ->
                        HorizontalDivider(Modifier.padding(start = 62.dp), color = MaterialTheme.colorScheme.outlineVariant)
                        Row(Modifier.fillMaxWidth().padding(start = 62.dp, end = 4.dp).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(sub, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (!reserved) RowMenu(
                                listOf(
                                    MenuAction("Rename") { action = CategoryAction.Rename(category.name, sub) },
                                    MenuAction("Delete", danger = true) { action = CategoryAction.Delete(category.name, sub) },
                                ),
                                enabled = !applier.saving,
                            )
                        }
                    }
                    if (!reserved) {
                        HorizontalDivider(Modifier.padding(start = 62.dp), color = MaterialTheme.colorScheme.outlineVariant)
                        TextButton(onClick = { action = CategoryAction.Add(category.name) }, modifier = Modifier.padding(start = 50.dp)) {
                            Icon(Icons.Default.Add, contentDescription = null); Text(" Add subcategory")
                        }
                    }
                }
            }
        }
    }
    when (val current = action) {
        is CategoryAction.Add -> TextInputDialog(
            if (current.parent != null) "Add subcategory to “${current.parent}”" else "Add category", null,
            listOf((if (current.parent != null) "Subcategory name" else "Category name") to ""), "Add",
            onSubmit = { (name) ->
                current.parent?.let { expanded = expanded + it }
                if (applier.apply { addCategory(it, name, current.parent) }) null else applier.status
            },
            onDismiss = { action = null },
        )
        is CategoryAction.Rename -> TextInputDialog(
            if (current.subcategory != null) "Rename subcategory" else "Rename category",
            "Existing transactions will use the new name. Amounts and balances stay the same.",
            listOf("Name" to (current.subcategory ?: current.name)), "Rename",
            onSubmit = { (name) ->
                expanded = expanded + (if (current.subcategory != null) current.name else name.trim())
                if (applier.apply { renameCategory(it, current.name, name, current.subcategory) }) null else applier.status
            },
            onDismiss = { action = null },
        )
        is CategoryAction.Delete -> {
            val count = finance.transactions.count { it.category == current.name && (current.subcategory == null || it.subcategory == current.subcategory) }
            val detail = if (count == 0) "This unused category will be removed."
            else "$count transactions will keep their amounts, dates, and notes. " +
                if (current.subcategory != null) "Their subcategory will be cleared." else "Their category and subcategory will be cleared. Use Merge instead to move them to another category."
            MessageDialog(
                "Delete “${current.subcategory ?: current.name}”?", detail, "Delete", "Cancel",
                onConfirm = { action = null; scope.launch { applier.apply { deleteCategory(it, current.name, current.subcategory) } } },
                onDismiss = { action = null },
            )
        }
        is CategoryAction.Merge -> {
            val targets = catalog.filter { it.name != current.name && !isTransferCategory(it.name) }.map { it.name }
            var target by remember(current) { mutableStateOf(targets.firstOrNull().orEmpty()) }
            var choosing by remember(current) { mutableStateOf(false) }
            AlertDialog(
                onDismissRequest = { action = null },
                title = { Text("Merge “${current.name}”") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Move its transactions and subcategories into another category. Amounts and balances stay the same.", style = MaterialTheme.typography.bodySmall)
                        FieldGroup { PickerRow(Icons.Default.ExpandMore, "Into", target) { choosing = true } }
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        scope.launch {
                            expanded = expanded + target
                            if (applier.apply { mergeCategories(it, current.name, target) }) action = null
                        }
                    }, enabled = target.isNotEmpty()) { Text("Merge") }
                },
                dismissButton = { TextButton(onClick = { action = null }) { Text("Cancel") } },
            )
            if (choosing) OptionSheet("Merge into", targets.map { Triple(it, it, "") }, target, { target = it }) { choosing = false }
        }
        null -> {}
    }
}
