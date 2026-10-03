package app.noter.ui.finance

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.noter.finance.Finance
import app.noter.finance.Transaction
import app.noter.finance.balances
import app.noter.finance.formatAmount
import app.noter.finance.formatDate
import app.noter.finance.removeTransaction
import app.noter.model.Settings
import app.noter.state.FinanceViewModel
import app.noter.ui.MessageDialog
import app.noter.ui.NoterColors
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.util.Locale

enum class FinanceManager { Accounts, Categories }

@Composable
private fun amountColor(cents: Long): Color = if (cents < 0) NoterColors.danger else NoterColors.positive

private fun dayLabel(iso: String, format: String): String {
    val date = runCatching { LocalDate.parse(iso) }.getOrNull() ?: return iso
    val today = LocalDate.now()
    return when (date) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> "${date.dayOfWeek.getDisplayName(java.time.format.TextStyle.SHORT, Locale.getDefault())}, ${formatDate(iso, format)}"
    }
}

@Composable
fun FinanceScreen(
    vm: FinanceViewModel,
    settings: Settings,
    setDefaultAccount: (String) -> Unit,
    manager: FinanceManager?,
    onManager: (FinanceManager?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val finance = vm.finance
    var editor by remember { mutableStateOf<EditRequest?>(null) }
    var actions by remember { mutableStateOf<Transaction?>(null) }
    var deleting by remember { mutableStateOf<Transaction?>(null) }
    val scope = rememberCoroutineScope()
    SideEffect { vm.dialogOpen = editor != null || manager != null || deleting != null || actions != null }
    val format = { cents: Long -> formatAmount(cents, settings.financeCurrency) }

    Box(modifier.fillMaxSize()) {
        when {
            !vm.loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            vm.loadError -> Column(
                Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(vm.status, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                Button(onClick = vm::reload) { Text("Reload Finance") }
            }
            finance == null -> Welcome(vm)
            else -> Overview(vm, finance, settings, format, onEntry = { editor = it }, onRow = { actions = it })
        }
    }

    if (finance != null) {
        editor?.let { request -> TransactionEditor(finance, request, settings, vm::commit) { editor = null } }
        actions?.let { row ->
            RowActions(row, settings, format, onDismiss = { actions = null }) { action ->
                actions = null
                val kind = if (row.transferId != null) "transfer" else if (row.cents < 0) "expense" else "income"
                when (action) {
                    "edit" -> editor = EditRequest(kind, row)
                    "repeat" -> editor = EditRequest(kind, row, duplicate = true)
                    "delete" -> deleting = row
                }
            }
        }
        when (manager) {
            FinanceManager.Accounts -> AccountManager(finance, format, settings.financeDefaultAccount, setDefaultAccount, vm::commit) { onManager(null) }
            FinanceManager.Categories -> CategoryManager(finance, vm::commit) { onManager(null) }
            null -> {}
        }
        deleting?.let { row ->
            MessageDialog(
                if (row.transferId != null) "Delete this transfer?" else "Delete this transaction?",
                if (row.transferId != null) "Both account entries will be deleted and balances recalculated." else "The account balance will be recalculated.",
                "Delete", "Cancel",
                onConfirm = { deleting = null; scope.launch { vm.commit(removeTransaction(finance, row.id)) } },
                onDismiss = { deleting = null },
            )
        }
    }
}

@Composable
private fun Welcome(vm: FinanceViewModel) {
    var name by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 460.dp).background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(18.dp)).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(Icons.Default.AccountBalanceWallet, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp))
            Text("Start tracking your money", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Text(
                "Finance from the desktop app appears here once Syncthing has synced the .noter folder. To start fresh on this device, name your first account.",
                textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedTextField(
                value = name, onValueChange = { name = it.take(120) }, label = { Text("First account") }, singleLine = true,
                shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = { saving = true; vm.start(name) { saving = false } }, enabled = !saving && name.isNotBlank(),
                shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().height(48.dp),
            ) { Text("Start Finance") }
            if (vm.status.isNotEmpty()) Text(vm.status, color = if (vm.statusIsError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Overview(
    vm: FinanceViewModel,
    finance: Finance,
    settings: Settings,
    format: (Long) -> String,
    onEntry: (EditRequest) -> Unit,
    onRow: (Transaction) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var accountFilter by rememberSaveable { mutableStateOf("") }
    var categoryFilter by rememberSaveable { mutableStateOf("") }
    var from by rememberSaveable { mutableStateOf("") }
    var until by rememberSaveable { mutableStateOf("") }
    var shown by rememberSaveable { mutableIntStateOf(settings.financePageSize) }
    var filtersOpen by remember { mutableStateOf(false) }
    // Drop filters whose account or category no longer exists, e.g. after a rename, merge, or synced change.
    if (accountFilter.isNotEmpty() && finance.accounts.none { it.name == accountFilter }) accountFilter = ""
    if (categoryFilter.isNotEmpty() && finance.transactions.none { it.category == categoryFilter }) categoryFilter = ""
    fun refilter() { shown = settings.financePageSize }

    val totals = balances(finance)
    val needle = query.trim().lowercase()
    val rows = finance.transactions.filter { row ->
        (accountFilter.isEmpty() || row.account == accountFilter) &&
            (categoryFilter.isEmpty() || row.category == categoryFilter) &&
            (from.isEmpty() || row.date >= from) && (until.isEmpty() || row.date <= until) &&
            (needle.isEmpty() || listOf(row.date, formatDate(row.date, settings.financeDateFormat), row.account, row.category, row.subcategory, row.payee, row.note, format(row.cents))
                .any { it.lowercase().contains(needle) })
    }.sortedByDescending { it.date }
    val visible = rows.take(shown)
    val groups = visible.groupBy { it.date }
    val dayTotals = rows.groupBy { it.date }.mapValues { (_, list) -> list.sumOf { it.cents } }
    val compact = settings.financeTableDensity == "compact"
    val activeFilters = listOf(accountFilter, categoryFilter, from, until).count { it.isNotEmpty() }
    val busy = vm.busy

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 32.dp)) {
        item {
            Column(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(18.dp)).padding(vertical = 18.dp),
            ) {
                Text("Total balance", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 18.dp))
                val total = totals.values.sum()
                Text(
                    format(total), fontSize = 34.sp, fontWeight = FontWeight.Medium,
                    color = if (total < 0) NoterColors.danger else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 2.dp),
                )
                LazyRow(contentPadding = PaddingValues(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 12.dp)) {
                    items(finance.accounts, key = { it.name }) { account ->
                        val selected = accountFilter == account.name
                        val cents = totals[account.name] ?: 0
                        Surface(
                            onClick = { accountFilter = if (selected) "" else account.name; refilter() },
                            shape = RoundedCornerShape(12.dp),
                            color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHighest,
                            border = if (selected) BorderStroke(1.dp, MaterialTheme.colorScheme.primary) else null,
                        ) {
                            Column(Modifier.widthIn(min = 112.dp, max = 190.dp).padding(horizontal = 12.dp, vertical = 10.dp)) {
                                Text(
                                    account.name + if (account.archived == true) " · Archived" else "",
                                    style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(format(cents), style = MaterialTheme.typography.titleSmall, color = if (cents < 0) NoterColors.danger else MaterialTheme.colorScheme.onSurface)
                                if (settings.financeShowAccountNotes && account.note.isNotEmpty()) {
                                    Text(account.note, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
        }
        item {
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val shape = RoundedCornerShape(12.dp)
                Button(onClick = { onEntry(EditRequest("expense")) }, enabled = !busy, shape = shape, modifier = Modifier.weight(1f).height(48.dp), contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Icon(Icons.Default.Remove, contentDescription = null, modifier = Modifier.size(18.dp)); Text(" Expense")
                }
                FilledTonalButton(onClick = { onEntry(EditRequest("income")) }, enabled = !busy, shape = shape, modifier = Modifier.weight(1f).height(48.dp), contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp)); Text(" Income")
                }
                FilledTonalButton(
                    onClick = { onEntry(EditRequest("transfer")) },
                    enabled = !busy && finance.accounts.count { it.archived != true } >= 2,
                    shape = shape, modifier = Modifier.weight(1f).height(48.dp), contentPadding = PaddingValues(horizontal = 8.dp),
                ) { Icon(Icons.Default.SwapHoriz, contentDescription = null, modifier = Modifier.size(18.dp)); Text(" Transfer") }
            }
            if (vm.status.isNotEmpty() && vm.statusIsError) {
                Text(vm.status, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
            }
        }
        item {
            Row(Modifier.fillMaxWidth().padding(top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = query, onValueChange = { query = it; refilter() }, singleLine = true,
                    placeholder = { Text("Search transactions") },
                    leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                    trailingIcon = if (query.isNotEmpty()) {
                        { IconButton(onClick = { query = ""; refilter() }) { Icon(Icons.Default.Close, contentDescription = "Clear search") } }
                    } else null,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.weight(1f),
                )
                BadgedBox(badge = { if (activeFilters > 0) Badge { Text("$activeFilters") } }, modifier = Modifier.padding(start = 8.dp)) {
                    FilledTonalIconButton(onClick = { filtersOpen = true }, modifier = Modifier.size(52.dp), shape = RoundedCornerShape(12.dp)) {
                        Icon(Icons.Default.FilterList, contentDescription = "Filters")
                    }
                }
            }
            if (activeFilters > 0) {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    @Composable
                    fun chip(label: String, icon: ImageVector, clear: () -> Unit) = InputChip(
                        selected = true, onClick = { clear(); refilter() }, label = { Text(label) },
                        leadingIcon = { Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp)) },
                        trailingIcon = { Icon(Icons.Default.Close, contentDescription = "Remove filter", modifier = Modifier.size(16.dp)) },
                    )
                    if (accountFilter.isNotEmpty()) chip(accountFilter, Icons.Default.AccountBalanceWallet) { accountFilter = "" }
                    if (categoryFilter.isNotEmpty()) chip(categoryFilter, Icons.Default.Category) { categoryFilter = "" }
                    if (from.isNotEmpty()) chip("From ${formatDate(from, settings.financeDateFormat)}", Icons.Default.CalendarToday) { from = "" }
                    if (until.isNotEmpty()) chip("Until ${formatDate(until, settings.financeDateFormat)}", Icons.Default.Event) { until = "" }
                }
            }
        }
        item {
            Row(Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 4.dp), verticalAlignment = Alignment.Bottom) {
                Text("Transactions", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Text("${rows.size} · Net ${format(rows.sumOf { it.cents })}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (rows.isEmpty()) {
                Text(
                    if (finance.transactions.isEmpty()) "No transactions yet. Add your first expense or income above." else "No transactions match these filters.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp),
                )
            }
        }
        groups.forEach { (date, dayRows) ->
            item(key = "day-$date") {
                Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 6.dp, start = 4.dp, end = 4.dp)) {
                    Text(dayLabel(date, settings.financeDateFormat), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    val net = dayTotals[date] ?: 0
                    Text(format(net), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            item(key = "group-$date") {
                FieldGroup {
                    dayRows.forEachIndexed { index, row ->
                        if (index > 0) HorizontalDivider(Modifier.padding(start = 66.dp), color = MaterialTheme.colorScheme.outlineVariant)
                        TransactionRow(row, format, compact) { onRow(row) }
                    }
                }
            }
        }
        if (rows.size > visible.size) item {
            OutlinedButton(
                onClick = { shown += settings.financePageSize }, shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
            ) { Text("Show ${minOf(settings.financePageSize, rows.size - visible.size)} more") }
        }
        item {
            Text(
                "Source: ${finance.sourceName} · Saved in your workspace folder",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline,
                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
            )
        }
    }

    if (filtersOpen) {
        FilterSheet(
            finance, settings, accountFilter, categoryFilter, from, until,
            onChange = { a, c, f, u -> accountFilter = a; categoryFilter = c; from = f; until = u; refilter() },
            onDismiss = { filtersOpen = false },
        )
    }
}

@Composable
private fun TransactionRow(row: Transaction, format: (Long) -> String, compact: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = if (compact) 9.dp else 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (row.transferId != null) {
            Box(Modifier.size(38.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(19.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.SwapHoriz, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            }
        } else Monogram(row.category.ifEmpty { row.payee })
        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
            Text(row.payee.ifEmpty { row.note.ifEmpty { row.category.ifEmpty { "Transaction" } } }, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val detail = listOf(listOf(row.category, row.subcategory).filter { it.isNotEmpty() }.joinToString(" / "), row.account)
                .filter { it.isNotEmpty() }.joinToString(" · ")
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (row.payee.isNotEmpty() && row.note.isNotEmpty()) {
                Text(row.note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Text(format(row.cents), color = amountColor(row.cents), fontWeight = FontWeight.Medium)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RowActions(row: Transaction, settings: Settings, format: (Long) -> String, onDismiss: () -> Unit, onAction: (String) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 8.dp)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(format(row.cents), fontSize = 30.sp, fontWeight = FontWeight.Medium, color = amountColor(row.cents))
                Text(row.payee.ifEmpty { row.note.ifEmpty { "Transaction" } }, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
                Text(
                    listOf(dayLabel(row.date, settings.financeDateFormat), row.account, listOf(row.category, row.subcategory).filter { it.isNotEmpty() }.joinToString(" / "))
                        .filter { it.isNotEmpty() }.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                )
                if (row.payee.isNotEmpty() && row.note.isNotEmpty()) Text(row.note, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
                if (row.transferId != null) Text("Linked transfer · both entries change together", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 6.dp))
            }
            Spacer(Modifier.height(16.dp))
            @Composable
            fun action(icon: ImageVector, label: String, key: String, color: Color = MaterialTheme.colorScheme.onSurface) {
                Row(
                    Modifier.fillMaxWidth().clickable { onAction(key) }.heightIn(min = 54.dp).padding(horizontal = 24.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(icon, contentDescription = null, tint = color)
                    Text(label, color = color, modifier = Modifier.padding(start = 20.dp))
                }
            }
            action(Icons.Default.Edit, "Edit", "edit")
            action(Icons.Default.ContentCopy, "Repeat today", "repeat")
            action(Icons.Default.Delete, "Delete", "delete", MaterialTheme.colorScheme.error)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilterSheet(
    finance: Finance,
    settings: Settings,
    account: String,
    category: String,
    from: String,
    until: String,
    onChange: (String, String, String, String) -> Unit,
    onDismiss: () -> Unit,
) {
    var picker by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Filters", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { onChange("", "", "", "") }) { Text("Clear all") }
            }
            FieldGroup {
                PickerRow(Icons.Default.AccountBalanceWallet, "Account", account, placeholder = "All") { picker = "account" }
                GroupDivider()
                PickerRow(Icons.Default.Category, "Category", category, placeholder = "All") { picker = "category" }
                GroupDivider()
                PickerRow(Icons.Default.CalendarToday, "From", from.takeIf { it.isNotEmpty() }?.let { formatDate(it, settings.financeDateFormat) }.orEmpty(), placeholder = "Any date") { picker = "from" }
                GroupDivider()
                PickerRow(Icons.Default.Event, "Until", until.takeIf { it.isNotEmpty() }?.let { formatDate(it, settings.financeDateFormat) }.orEmpty(), placeholder = "Any date") { picker = "until" }
            }
            Button(onClick = onDismiss, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Done") }
        }
    }
    when (picker) {
        "account" -> OptionSheet("Account", listOf(Triple("", "All accounts", "")) + finance.accounts.map { Triple(it.name, it.name, if (it.archived == true) "Archived" else "") }, account,
            { onChange(it, category, from, until) }) { picker = null }
        "category" -> OptionSheet("Category", listOf(Triple("", "All categories", "")) + finance.transactions.map { it.category }.filter { it.isNotEmpty() }.distinct().sorted().map { Triple(it, it, "") },
            category, { onChange(account, it, from, until) }) { picker = null }
        "from" -> DateDialog(from, allowClear = true, onChange = { onChange(account, category, it, until) }) { picker = null }
        "until" -> DateDialog(until, allowClear = true, onChange = { onChange(account, category, from, it) }) { picker = null }
    }
}
