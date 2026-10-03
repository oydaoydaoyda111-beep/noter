package app.noter.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.noter.model.Settings
import kotlin.math.roundToInt

@Composable
private fun Section(title: String) {
    Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 20.dp, bottom = 4.dp))
}

@Composable
private fun <T> Choice(label: String, options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (value, text) ->
            FilterChip(selected = value == selected, onClick = { onSelect(value) }, label = { Text(text) })
        }
    }
}

@Composable
private fun Toggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
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
    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Settings") },
            navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.Default.Close, contentDescription = "Close settings") } },
        )
    }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Section("Appearance")
            Text("Font size: ${settings.fontSize}")
            Slider(
                value = settings.fontSize.toFloat(), onValueChange = { v -> onChange { it.copy(fontSize = v.roundToInt()) } },
                valueRange = 14f..24f, steps = 9,
            )
            Choice("Font", listOf("sans" to "Sans", "serif" to "Serif", "mono" to "Mono"), settings.fontStyle) { v -> onChange { it.copy(fontStyle = v) } }
            Choice("Document width", listOf(720 to "Narrow", 790 to "Default", 850 to "Wide"), settings.documentWidth) { v -> onChange { it.copy(documentWidth = v) } }
            Choice("Density", listOf("comfortable" to "Comfortable", "compact" to "Compact"), settings.density) { v -> onChange { it.copy(density = v) } }
            Choice("Motion", listOf("full" to "Full", "subtle" to "Subtle", "none" to "None"), settings.motion) { v -> onChange { it.copy(motion = v) } }
            Choice("Accent", listOf("blue" to "Blue", "green" to "Green", "purple" to "Purple"), settings.accentColor) { v -> onChange { it.copy(accentColor = v) } }

            Section("Notes")
            Text("Autosave delay: ${settings.autosaveDelay} ms")
            Slider(
                value = settings.autosaveDelay.toFloat(), onValueChange = { v -> onChange { it.copy(autosaveDelay = (v / 50).roundToInt() * 50) } },
                valueRange = 200f..2000f,
            )
            Choice("Open on startup", listOf("last" to "Last used", "notes" to "Notes", "finance" to "Finance"), settings.startupSection) { v -> onChange { it.copy(startupSection = v) } }
            Toggle("Spellcheck and autocorrect", settings.spellcheck) { v -> onChange { it.copy(spellcheck = v) } }
            Toggle("Show word and character count", settings.showNoteStats) { v -> onChange { it.copy(showNoteStats = v) } }

            Section("Finance")
            Choice("Currency label", listOf("" to "None", "AZN" to "AZN", "USD" to "USD", "EUR" to "EUR", "GBP" to "GBP", "TRY" to "TRY"), settings.financeCurrency) { v -> onChange { it.copy(financeCurrency = v) } }
            Text("Currency labels do not convert amounts.", style = MaterialTheme.typography.bodySmall)
            Choice("Date format", listOf("iso" to "2026-10-03", "dmy" to "03/10/2026", "mdy" to "10/03/2026"), settings.financeDateFormat) { v -> onChange { it.copy(financeDateFormat = v) } }
            Choice("Row density", listOf("compact" to "Compact", "comfortable" to "Comfortable"), settings.financeTableDensity) { v -> onChange { it.copy(financeTableDensity = v) } }
            Choice("Rows per page", listOf(25, 50, 100, 200).map { it to it.toString() }, settings.financePageSize) { v -> onChange { it.copy(financePageSize = v) } }
            Choice("Default account", listOf("" to "None") + accounts.map { it to it }, settings.financeDefaultAccount) { v -> onChange { it.copy(financeDefaultAccount = v) } }
            Toggle("Remember last account and category", settings.financeRememberEntries) { v -> onChange { it.copy(financeRememberEntries = v) } }
            Toggle("Show account notes", settings.financeShowAccountNotes) { v -> onChange { it.copy(financeShowAccountNotes = v) } }

            Section("Workspace")
            Text(folderName.ifEmpty { "No folder selected" })
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onChangeFolder) { Text("Change folder") }
                OutlinedButton(onClick = onReload) { Text("Reload synced files") }
            }
            Text(
                "Sync the whole folder, including .noter, with Syncthing.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 8.dp, bottom = 24.dp),
            )
        }
    }
}
