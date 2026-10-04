package app.noter.ui.finance

import androidx.compose.foundation.background
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SubdirectoryArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.noter.finance.FinanceCategory

data class CategorySelection(val category: String, val subcategory: String)

private data class Choice(val title: String, val detail: String, val category: String, val subcategory: String, val create: Boolean = false)

/** Category and subcategory rows; each opens a searchable sheet that can also create a new entry. */
@Composable
fun CategoryRows(catalog: List<FinanceCategory>, selection: CategorySelection, locked: Boolean, onChange: (CategorySelection) -> Unit) {
    var mode by remember { mutableStateOf<String?>(null) }
    // New entries live only in this editor until the transaction is saved, as on desktop.
    var local by remember { mutableStateOf(catalog) }
    PickerRow(Icons.Default.Category, "Category", selection.category, placeholder = "Uncategorized", enabled = !locked) { mode = "category" }
    GroupDivider()
    PickerRow(
        Icons.Default.SubdirectoryArrowRight, "Subcategory", selection.subcategory,
        placeholder = if (selection.category.isEmpty()) "Category first" else "None",
        enabled = !locked && selection.category.isNotEmpty(),
    ) { mode = "subcategory" }
    val current = mode ?: return
    CategorySheet(current, local, selection, onClose = { mode = null }) { choice ->
        if (choice.create) {
            val existing = local.firstOrNull { it.name == choice.category }
            local = if (existing == null) local + FinanceCategory(choice.category, listOfNotNull(choice.subcategory.ifEmpty { null }))
            else local.map { if (it.name == choice.category && choice.subcategory.isNotEmpty() && choice.subcategory !in it.subcategories) it.copy(subcategories = it.subcategories + choice.subcategory) else it }
        }
        val keepSub = current == "category" && choice.subcategory.isEmpty() && choice.category == selection.category
        onChange(CategorySelection(choice.category, if (keepSub) selection.subcategory else choice.subcategory))
        mode = null
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CategorySheet(mode: String, catalog: List<FinanceCategory>, selection: CategorySelection, onClose: () -> Unit, onChoose: (Choice) -> Unit) {
    var query by remember { mutableStateOf("") }
    val needle = query.trim().lowercase()
    val parent = catalog.firstOrNull { it.name == selection.category }
    val choices = buildList {
        if (needle.isEmpty()) add(Choice(if (mode == "category") "Uncategorized" else "No subcategory", "Clear selection", if (mode == "category") "" else selection.category, ""))
        if (mode == "category") {
            for (category in catalog) {
                val parentMatches = category.name.lowercase().contains(needle)
                val children = category.subcategories.filter { parentMatches || it.lowercase().contains(needle) }
                if (parentMatches || children.isNotEmpty()) add(Choice(category.name, "${category.subcategories.size} ${if (category.subcategories.size == 1) "subcategory" else "subcategories"}", category.name, ""))
                // Browse categories first; searching reveals matching subcategories for one-tap selection.
                if (needle.isNotEmpty()) children.forEach { add(Choice(it, category.name, category.name, it)) }
            }
        } else {
            parent?.subcategories?.filter { it.lowercase().contains(needle) }?.forEach { add(Choice(it, selection.category, selection.category, it)) }
        }
        val name = query.trim()
        val exists = if (mode == "category") catalog.any { it.name.lowercase() == needle } else parent?.subcategories?.any { it.lowercase() == needle } == true
        if (name.isNotEmpty() && !exists) {
            add(Choice("Create “$name”", if (mode == "category") "New category" else "New subcategory in ${selection.category}",
                if (mode == "category") name else selection.category, if (mode == "subcategory") name else "", create = true))
        }
    }
    ModalBottomSheet(onDismissRequest = onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.heightIn(max = 620.dp).navigationBarsPadding().imePadding()) {
            Text(if (mode == "category") "Category" else "Subcategory", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 20.dp))
            if (mode == "subcategory") Text(selection.category, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
            OutlinedTextField(
                value = query, onValueChange = { query = it.take(120) }, singleLine = true,
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                placeholder = { Text(if (mode == "category") "Search or create a category" else "Search or create a subcategory") },
                trailingIcon = if (query.isNotEmpty()) {
                    { IconButton(onClick = { query = "" }) { Icon(Icons.Default.Close, contentDescription = "Clear search") } }
                } else null,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            )
            if (choices.isEmpty()) Text("No subcategories yet. Type a name to create one.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(20.dp))
            LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 420.dp)) {
                items(choices) { choice ->
                    val selected = !choice.create && choice.category == selection.category &&
                        choice.subcategory == (if (mode == "category" && choice.subcategory.isEmpty()) "" else selection.subcategory)
                    Row(
                        Modifier.fillMaxWidth().background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                            .selectable(selected = selected, role = Role.RadioButton, onClick = { onChoose(choice) })
                            .heightIn(min = 60.dp).padding(horizontal = 20.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (choice.create) Icon(Icons.Default.Add, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(end = 12.dp))
                        Column(Modifier.weight(1f).padding(start = if (choice.subcategory.isNotEmpty() && mode == "category" && !choice.create) 16.dp else 0.dp, end = 8.dp)) {
                            Text(
                                choice.title,
                                color = if (choice.create) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                                maxLines = 2, overflow = TextOverflow.Ellipsis,
                            )
                            Text(choice.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (selected) Icon(Icons.Default.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.primary)
                    }
                }
            }
        }
    }
}
