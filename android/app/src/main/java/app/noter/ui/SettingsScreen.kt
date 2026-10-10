package app.noter.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.noter.model.Settings
import kotlin.math.roundToInt

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(18.dp), content = content)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun <T> Choice(label: String, options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.titleSmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { (value, text) ->
                FilterChip(
                    selected = value == selected,
                    onClick = { onSelect(value) },
                    label = { Text(text) },
                    leadingIcon = if (value == selected) ({ Icon(Icons.Default.Check, null, Modifier.size(16.dp)) }) else null,
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }
    }
}

@Composable
private fun Toggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = checked, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null)
    }
}

@Composable
private fun DefaultAccount(accounts: List<String>, selected: String, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Default account", style = MaterialTheme.typography.titleSmall)
        Box {
            OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = MaterialTheme.shapes.small) {
                Text(selected.ifEmpty { "None" }, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                Icon(Icons.Default.KeyboardArrowDown, null, modifier = Modifier.size(20.dp))
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                (listOf("") + accounts).forEach { account ->
                    DropdownMenuItem(
                        text = { Text(account.ifEmpty { "None" }) },
                        trailingIcon = if (account == selected) ({ Icon(Icons.Default.Check, null, tint = MaterialTheme.colorScheme.primary) }) else null,
                        onClick = { expanded = false; onSelect(account) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    settings: Settings,
    folderName: String,
    accounts: List<String>,
    onChange: ((Settings) -> Settings) -> Unit,
    onChangeFolder: () -> Unit,
    onReload: () -> Unit,
    onClose: () -> Unit,
) {
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text("Settings", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = onClose, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Close settings")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).consumeWindowInsets(padding).fillMaxSize()
                .verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Section("Appearance") {
                Column {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("Editor font size", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                        Text("${settings.fontSize.toBigDecimal().stripTrailingZeros().toPlainString()} sp", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    }
                    Slider(
                        value = settings.fontSize.toFloat(),
                        onValueChange = { v -> onChange { it.copy(fontSize = v.roundToInt().toDouble()) } },
                        valueRange = 14f..24f,
                        steps = 9,
                        modifier = Modifier.semantics { contentDescription = "Editor font size" },
                    )
                }
                Choice("Font family", listOf("sans" to "Sans", "serif" to "Serif", "mono" to "Mono"), settings.fontStyle) { v -> onChange { it.copy(fontStyle = v) } }
                Choice("Document width", listOf(720 to "Narrow", 790 to "Default", 850 to "Wide"), settings.documentWidth) { v -> onChange { it.copy(documentWidth = v) } }
                Choice("Density", listOf("comfortable" to "Comfortable", "compact" to "Compact"), settings.density) { v -> onChange { it.copy(density = v) } }
                Choice("Motion", listOf("full" to "Full", "subtle" to "Subtle", "none" to "None"), settings.motion) { v -> onChange { it.copy(motion = v) } }
                Choice("Accent", listOf("blue" to "Blue", "green" to "Green", "purple" to "Purple"), settings.accentColor) { v -> onChange { it.copy(accentColor = v) } }
            }

            Section("Notes") {
                Column {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("Autosave delay", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                        Text("${settings.autosaveDelay.toBigDecimal().stripTrailingZeros().toPlainString()} ms", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    }
                    Slider(
                        value = settings.autosaveDelay.toFloat(),
                        onValueChange = { v -> onChange { it.copy(autosaveDelay = (v / 50).roundToInt() * 50.0) } },
                        valueRange = 200f..2000f,
                        modifier = Modifier.semantics { contentDescription = "Autosave delay" },
                    )
                }
                Choice("Open on startup", listOf("last" to "Last used", "notes" to "Notes", "finance" to "Finance", "planner" to "Planner"), settings.startupSection) { v -> onChange { it.copy(startupSection = v) } }
                Toggle("Spellcheck and autocorrect", settings.spellcheck) { v -> onChange { it.copy(spellcheck = v) } }
                Toggle("Show word and character count", settings.showNoteStats) { v -> onChange { it.copy(showNoteStats = v) } }
            }

            Section("Finance") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Choice("Currency label", listOf("" to "None", "AZN" to "AZN", "USD" to "USD", "EUR" to "EUR", "GBP" to "GBP", "TRY" to "TRY"), settings.financeCurrency) { v -> onChange { it.copy(financeCurrency = v) } }
                    Text("Currency labels do not convert amounts.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Choice("Date format", listOf("iso" to "2026-10-04", "dmy" to "04/10/2026", "mdy" to "10/04/2026"), settings.financeDateFormat) { v -> onChange { it.copy(financeDateFormat = v) } }
                Choice("Row density", listOf("compact" to "Compact", "comfortable" to "Comfortable"), settings.financeTableDensity) { v -> onChange { it.copy(financeTableDensity = v) } }
                Choice("Rows per page", listOf(25, 50, 100, 200).map { it to it.toString() }, settings.financePageSize) { v -> onChange { it.copy(financePageSize = v) } }
                DefaultAccount(accounts, settings.financeDefaultAccount) { v -> onChange { it.copy(financeDefaultAccount = v) } }
                Toggle("Remember last account and category", settings.financeRememberEntries) { v -> onChange { it.copy(financeRememberEntries = v) } }
                Toggle("Show account notes", settings.financeShowAccountNotes) { v -> onChange { it.copy(financeShowAccountNotes = v) } }
            }

            Section("Workspace") {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(Icons.Default.FolderOpen, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("Workspace folder", style = MaterialTheme.typography.titleSmall)
                        Text(folderName.ifEmpty { "No folder selected" }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onChangeFolder, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = MaterialTheme.shapes.small) {
                        Icon(Icons.Default.FolderOpen, null, Modifier.size(18.dp))
                        Text("Change folder", Modifier.padding(start = 8.dp))
                    }
                    OutlinedButton(onClick = onReload, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = MaterialTheme.shapes.small) {
                        Icon(Icons.Default.Refresh, null, Modifier.size(18.dp))
                        Text("Reload synced files", Modifier.padding(start = 8.dp))
                    }
                }
                Text(
                    "Sync the whole folder, including .noter, with Syncthing.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
