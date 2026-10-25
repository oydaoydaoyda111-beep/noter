package app.noter.ui.finance

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.noter.finance.Finance
import app.noter.finance.PlannedExpense
import app.noter.finance.money
import app.noter.finance.plannedTotals
import app.noter.state.FinanceViewModel
import app.noter.ui.FullScreenDialog
import app.noter.ui.MessageDialog
import app.noter.ui.NoterColors
import kotlinx.coroutines.launch
import java.math.BigDecimal
import java.util.UUID

private fun plainAmount(cents: Long) = BigDecimal(cents).movePointLeft(2).toPlainString()

/** One-time expenses planned against the active-account balance; mirrors desktop's planned expenses dialog. */
@Composable
fun PlannedExpensesDialog(finance: Finance, format: (Long) -> String, vm: FinanceViewModel, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var expenses by remember { mutableStateOf<List<PlannedExpense>>(emptyList()) }
    var revision by remember { mutableStateOf<String?>(null) }
    var ready by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var needsReload by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<PlannedExpense?>(null) }
    var name by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    // A stable ID per draft prevents a duplicate entry when a save was written but not acknowledged.
    var draftId by remember { mutableStateOf(UUID.randomUUID().toString()) }
    var confirmDiscard by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<PlannedExpense?>(null) }

    fun resetDraft() { editing = null; name = ""; amount = ""; draftId = UUID.randomUUID().toString() }

    suspend fun load() {
        busy = true; status = "Loading…"
        try {
            val loaded = vm.loadPlans()
            expenses = loaded.expenses; revision = loaded.revision; ready = true; needsReload = false; status = ""
        } catch (problem: Exception) {
            ready = false; status = problem.message ?: "Could not load planned expenses."
        } finally {
            busy = false
        }
    }

    suspend fun save(next: List<PlannedExpense>): Boolean {
        if (busy || !ready || needsReload) return false
        busy = true; status = "Saving…"
        return try {
            revision = vm.savePlans(next, revision); expenses = next; status = ""; true
        } catch (problem: Exception) {
            needsReload = true
            status = "${problem.message ?: "Could not save planned expenses."} Your draft is kept. Reload plans before trying again."
            false
        } finally {
            busy = false
        }
    }

    fun submit() = scope.launch {
        if (busy) return@launch
        try {
            if (needsReload) throw IllegalStateException("Reload plans before saving. Your draft is kept.")
            if (name.isBlank()) throw IllegalStateException("Enter an expense name.")
            val cents = money(amount)
            if (cents <= 0) throw IllegalStateException("Enter an amount greater than zero.")
            val current = editing
            if (current != null && expenses.none { it == current }) {
                throw IllegalStateException("This expense changed or was deleted. Your draft is kept; cancel it and edit the latest entry.")
            }
            val item = PlannedExpense(current?.id ?: draftId, name.trim(), cents)
            val acknowledged = if (current == null) expenses.firstOrNull { it.id == draftId } else null
            if (acknowledged != null) {
                if (acknowledged != item) throw IllegalStateException("This draft was already saved with different details. Cancel the draft and edit the saved expense.")
                resetDraft(); return@launch
            }
            val next = if (current != null) expenses.map { if (it.id == item.id) item else it } else expenses + item
            if (save(next)) resetDraft()
        } catch (problem: Exception) {
            status = problem.message ?: "Could not save planned expense."
        }
    }

    fun dismiss() {
        if (busy) return
        val changed = editing?.let { name != it.name || amount != plainAmount(it.cents) } ?: (name.isNotEmpty() || amount.isNotEmpty())
        if (changed) confirmDiscard = true else onClose()
    }

    LaunchedEffect(Unit) { load() }

    FullScreenDialog(onDismissRequest = { dismiss() }) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { dismiss() }, enabled = !busy) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Close planned expenses") }
                    Text("Planned expenses", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    IconButton(onClick = { scope.launch { load() } }, enabled = !busy) { Icon(Icons.Default.Refresh, contentDescription = "Reload plans") }
                }
                LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    item {
                        Text(
                            "Plan one-time expenses against your total balance across active accounts. Delete a plan when you no longer need it.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (ready) item {
                        Column(
                            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(16.dp)).padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            val totals = runCatching { plannedTotals(finance, expenses) }
                            totals.onSuccess { result ->
                                for ((label, cents) in listOf("Active-account balance" to result.balance, "Planned expenses" to result.planned, "Remaining" to result.remaining)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                                        Text(format(cents), fontWeight = FontWeight.SemiBold, color = if (cents < 0) NoterColors.danger else MaterialTheme.colorScheme.onSurface)
                                    }
                                }
                            }.onFailure { Text(it.message ?: "Could not total planned expenses.", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                    if (status.isNotEmpty()) item { Text(status, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    if (ready && expenses.isEmpty()) item { Text("No planned expenses yet.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    if (ready) items(expenses, key = { it.id }) { expense ->
                        Row(
                            Modifier.fillMaxWidth().background(
                                if (editing?.id == expense.id) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHighest,
                                RoundedCornerShape(12.dp),
                            ).padding(start = 14.dp, top = 4.dp, bottom = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(expense.name, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text(format(expense.cents), fontWeight = FontWeight.SemiBold)
                            IconButton(onClick = {
                                if (name.isNotEmpty() || amount.isNotEmpty() || editing != null) status = "Save or cancel the current draft first."
                                else { editing = expense; name = expense.name; amount = plainAmount(expense.cents) }
                            }, enabled = !busy && !needsReload) { Icon(Icons.Default.Edit, contentDescription = "Edit planned expense ${expense.name}") }
                            IconButton(onClick = { deleting = expense }, enabled = !busy && !needsReload) {
                                Icon(Icons.Default.Delete, contentDescription = "Delete planned expense ${expense.name}")
                            }
                        }
                    }
                }
                if (ready) {
                    HorizontalDivider()
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(if (editing != null) "Edit plan" else "New plan", style = MaterialTheme.typography.labelLarge)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(
                                value = name, onValueChange = { name = it.take(120) }, label = { Text("Expense name") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                                shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1.6f),
                            )
                            OutlinedTextField(
                                value = amount, onValueChange = { amount = it.take(24) }, label = { Text("Amount") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f),
                            )
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                            if (editing != null || name.isNotEmpty() || amount.isNotEmpty()) {
                                TextButton(onClick = { resetDraft(); status = "" }, enabled = !busy) { Text("Cancel") }
                            }
                            Button(onClick = { submit() }, enabled = !busy, shape = RoundedCornerShape(12.dp)) { Text(if (editing != null) "Save" else "Add") }
                        }
                    }
                }
            }
        }
    }

    deleting?.let { expense ->
        MessageDialog(
            "Delete this planned expense?", "\"${expense.name}\" will be removed. Transactions and balances are not affected.", "Delete", "Cancel",
            onConfirm = { deleting = null; scope.launch { save(expenses.filter { it.id != expense.id }) } },
            onDismiss = { deleting = null },
        )
    }
    if (confirmDiscard) {
        MessageDialog(
            "Discard this expense draft?", "Saved planned expenses will be kept.", "Discard draft", "Keep editing",
            onConfirm = { confirmDiscard = false; onClose() },
            onDismiss = { confirmDiscard = false },
        )
    }
}
