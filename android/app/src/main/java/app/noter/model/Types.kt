package app.noter.model

sealed interface Node {
    val id: String
    val name: String
    val parentId: String?
    val createdAt: Long
    val updatedAt: Long
}

data class Note(
    override val id: String,
    override val name: String,
    override val parentId: String?,
    override val createdAt: Long,
    override val updatedAt: Long,
    val markdown: String,
) : Node

data class Folder(
    override val id: String,
    override val name: String,
    override val parentId: String?,
    override val createdAt: Long,
    override val updatedAt: Long,
    val children: List<String>,
) : Node

data class Settings(
    val fontSize: Double = 18.0,
    val fontStyle: String = "sans",
    val documentWidth: Int = 790,
    val density: String = "comfortable",
    val motion: String = "full",
    val autosaveDelay: Double = 650.0,
    val accentColor: String = "blue",
    val startupSection: String = "last",
    val spellcheck: Boolean = true,
    val showNoteStats: Boolean = true,
    val financeCurrency: String = "",
    val financeDateFormat: String = "iso",
    val financeTableDensity: String = "compact",
    val financePageSize: Int = 50,
    val financeDefaultAccount: String = "",
    val financeRememberEntries: Boolean = true,
    val financeShowAccountNotes: Boolean = true,
)

data class Workspace(
    val nodes: Map<String, Node> = emptyMap(),
    val rootIds: List<String> = emptyList(),
    val openTabs: List<String> = emptyList(),
    val activeNoteId: String? = null,
    val collapsedFolders: List<String> = emptyList(),
    val settings: Settings = Settings(),
)
