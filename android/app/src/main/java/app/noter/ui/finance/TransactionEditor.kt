package app.noter.ui.finance

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.SuggestionChip
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.noter.finance.Defaults
import app.noter.finance.Finance
import app.noter.finance.TRANSFER_CATEGORY
import app.noter.finance.Transaction
import app.noter.finance.categoryCatalog
import app.noter.finance.formatDate
import app.noter.finance.money
import app.noter.finance.newId
import app.noter.finance.registerCategory
import app.noter.finance.saveTransaction
import app.noter.finance.today
import app.noter.model.Settings
import app.noter.ui.NoterColors
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.abs

/** What the editor was opened for: a new entry of [kind], or an [existing] row to edit or repeat. */
data class EditRequest(val kind: String, val existing: Transaction? = null, val duplicate: Boolean = false)

@Composable
private fun TextRow(icon: ImageVector, placeholder: String, value: String, onChange: (String) -> Unit, singleLine: Boolean = true) {
    Row(Modifier.fillMaxWidth().heightIn(min = 54.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        Box(Modifier.weight(1f).padding(start = 16.dp, top = 14.dp, bottom = 14.dp)) {
            if (value.isEmpty()) Text(placeholder, color = MaterialTheme.colorScheme.onSurfaceVariant)
            BasicTextField(
                value = value, onValueChange = { onChange(it.take(2000)) }, singleLine = singleLine,
                textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 16.sp),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransactionEditor(
    source: Finance,
    request: EditRequest,
    settings: Settings,
    commit: suspend (Finance) -> Boolean,
    onClose: () -> Unit,
) {
    val linked = request.existing?.transferId?.let { id -> source.transactions.firstOrNull { it.transferId == id && it.cents < 0 } }
    val original = linked ?: request.existing
    val destination = original?.transferId?.let { id -> source.transactions.firstOrNull { it.transferId == id && it.cents > 0 }?.account } ?: ""
    val editing = original != null && !request.duplicate
    val lockedTransfer = original?.transferId != null
    val available = source.accounts.filter { it.archived != true || it.name == original?.account || it.name == destination }.map { it.name }
    val preferred = settings.financeDefaultAccount.takeIf { name -> source.accounts.any { it.archived != true && it.name == name } } ?: ""
    fun pick(value: String) = if (value in available) value else available.firstOrNull() ?: ""
    val rememberedCategory = if (settings.financeRememberEntries) source.defaults?.category.orEmpty() else ""

    var kind by remember { mutableStateOf(if (lockedTransfer) "transfer" else request.kind) }
    var date by remember { mutableStateOf(if (request.duplicate) today() else original?.date ?: today()) }
    var amount by remember { mutableStateOf(original?.let { String.format(Locale.ROOT, "%d.%02d", abs(it.cents) / 100, abs(it.cents) % 100) } ?: "") }
    var account by remember {
        mutableStateOf(pick(original?.account ?: preferred.ifEmpty { if (settings.financeRememberEntries) source.defaults?.account.orEmpty() else "" }))
    }
    var to by remember { mutableStateOf(destination.ifEmpty { available.firstOrNull { it != account } ?: "" }) }
    var selection by remember {
        mutableStateOf(CategorySelection(if (kind == "transfer") TRANSFER_CATEGORY else original?.category ?: rememberedCategory, original?.subcategory.orEmpty()))
    }
    var payee by remember { mutableStateOf(original?.payee.orEmpty()) }
    var note by remember { mutableStateOf(original?.note.orEmpty()) }
    var error by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf<String?>(null) }
    var dateOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val payees = remember(source) { source.transactions.map { it.payee }.filter { it.isNotEmpty() }.distinct() }
    val catalog = remember(source) { categoryCatalog(source) }
    val amountFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { amountFocus.requestFocus() }

    fun changeKind(next: String) {
        if (next == kind) return
        if (next == "transfer") selection = CategorySelection(TRANSFER_CATEGORY, "")
        else if (kind == "transfer") selection = CategorySelection(rememberedCategory, "")
        if (next == "transfer" && to == account) to = available.firstOrNull { it != account } ?: ""
        kind = next
    }

    fun submit() {
        try {
            val cents = money(amount)
            if (cents <= 0) throw IllegalArgumentException("Enter a positive amount.")
            if (kind == "transfer" && available.size < 2) throw IllegalArgumentException("Add or restore a second account to record a transfer.")
            if (selection.category.isEmpty() && selection.subcategory.isNotEmpty()) throw IllegalArgumentException("Choose a category before adding a subcategory.")
            val row = Transaction(
                id = if (editing) original!!.id else newId(), date = date, cents = if (kind == "income") cents else -cents,
                account = account, category = selection.category, subcategory = selection.subcategory, payee = payee.trim(), note = note.trim(),
            )
            val saved = registerCategory(saveTransaction(source, row, if (kind == "transfer") to else null), row.category, row.subcategory)
            val next = saved.copy(defaults = if (settings.financeRememberEntries) {
                Defaults(row.account, if (kind == "transfer") source.defaults?.category.orEmpty() else row.category)
            } else null)
            saving = true
            error = ""
            scope.launch {
                if (commit(next)) onClose() else error = "Could not save. Keep this screen open and try again."
                saving = false
            }
        } catch (problem: Exception) {
            error = problem.message ?: "Could not save transaction."
        }
    }

    val accent = when (kind) {
        "income" -> NoterColors.positive
        "expense" -> NoterColors.danger
        else -> MaterialTheme.colorScheme.primary
    }

    Dialog(onDismissRequest = { if (!saving) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onClose, enabled = !saving) { Icon(Icons.Default.Close, contentDescription = "Close") }
                    Text(
                        if (editing) "Edit ${kind}" else if (request.duplicate) "Repeat ${kind}" else "New ${kind}",
                        style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = ::submit, enabled = !saving) { Text("Save", fontWeight = FontWeight.SemiBold) }
                }
                Column(
                    Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    if (!lockedTransfer) {
                        val kinds = if (editing) listOf("expense", "income") else listOf("expense", "income", "transfer")
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            kinds.forEachIndexed { index, value ->
                                SegmentedButton(
                                    selected = kind == value, onClick = { changeKind(value) },
                                    shape = SegmentedButtonDefaults.itemShape(index, kinds.size),
                                    label = { Text(value.replaceFirstChar { it.uppercase() }) },
                                )
                            }
                        }
                    }
                    Column(
                        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(14.dp)).padding(vertical = 18.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            when (kind) { "income" -> "Amount received"; "transfer" -> "Amount to move"; else -> "Amount spent" } +
                                if (settings.financeCurrency.isNotEmpty()) " · ${settings.financeCurrency}" else "",
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Box(Modifier.padding(top = 6.dp), contentAlignment = Alignment.Center) {
                            if (amount.isEmpty()) Text("0.00", fontSize = 40.sp, color = MaterialTheme.colorScheme.outline, fontWeight = FontWeight.Medium)
                            BasicTextField(
                                value = amount, onValueChange = { amount = it.replace(',', '.').filter { c -> c.isDigit() || c == '.' }.take(18) },
                                singleLine = true,
                                textStyle = TextStyle(color = accent, fontSize = 40.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center),
                                cursorBrush = SolidColor(accent),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                modifier = Modifier.fillMaxWidth().focusRequester(amountFocus),
                            )
                        }
                    }
                    FieldGroup {
                        PickerRow(Icons.Default.CalendarToday, "Date", formatDate(date, settings.financeDateFormat)) { dateOpen = true }
                        GroupDivider()
                        PickerRow(Icons.Default.AccountBalanceWallet, if (kind == "transfer") "From" else "Account", account) { sheet = "account" }
                        if (kind == "transfer") {
                            GroupDivider()
                            PickerRow(Icons.Default.SwapHoriz, "To", to) { sheet = "to" }
                        }
                    }
                    FieldGroup {
                        CategoryRows(catalog, selection, locked = kind == "transfer") { selection = it }
                    }
                    Column {
                        FieldGroup {
                            TextRow(Icons.Default.Person, if (kind == "income") "Payer" else "Payee", payee, { payee = it })
                            GroupDivider()
                            TextRow(Icons.AutoMirrored.Filled.Notes, "Note", note, { note = it }, singleLine = false)
                        }
                        val matches = payees.filter { payee.isNotBlank() && it.contains(payee.trim(), ignoreCase = true) && it != payee }.take(8)
                        if (matches.isNotEmpty()) {
                            Row(Modifier.horizontalScroll(rememberScrollState()).padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                matches.forEach { SuggestionChip(onClick = { payee = it }, label = { Text(it) }) }
                            }
                        }
                    }
                    if (kind == "transfer") {
                        Text(
                            "Both account entries are saved together. Editing or deleting this transfer updates both entries.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    Button(onClick = ::submit, enabled = !saving, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().height(52.dp)) {
                        Text(if (saving) "Saving…" else "Save transaction", fontWeight = FontWeight.SemiBold)
                    }
                    Box(Modifier.height(8.dp))
                }
            }
        }
    }

    when (sheet) {
        "account" -> OptionSheet(if (kind == "transfer") "From account" else "Account", available.map { Triple(it, it, "") }, account, { account = it }) { sheet = null }
        "to" -> OptionSheet("To account", available.filter { it != account }.map { Triple(it, it, "") }, to, { to = it }) { sheet = null }
    }
    if (dateOpen) DateDialog(date, allowClear = false, onChange = { date = it }) { dateOpen = false }
}
