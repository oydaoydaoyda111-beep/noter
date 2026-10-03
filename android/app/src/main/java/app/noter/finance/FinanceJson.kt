package app.noter.finance

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

internal fun invalid(): Nothing =
    throw FinanceException("Finance files contain invalid data. Keep the files and restore a valid backup before editing.")

private fun JSONObject.string(key: String): String = opt(key) as? String ?: invalid()

private fun JSONObject.integer(key: String): Long = when (val value = opt(key)) {
    is Int -> value.toLong()
    is Long -> value
    is Double -> if (value % 1.0 == 0.0) value.toLong() else invalid()
    else -> invalid()
}

private fun Any?.objects(): List<JSONObject> = (this as? JSONArray ?: invalid()).let { array -> List(array.length()) { array.optJSONObject(it) ?: invalid() } }
internal fun Any?.strings(): List<String> = (this as? JSONArray ?: invalid()).let { array -> List(array.length()) { array.opt(it) as? String ?: invalid() } }

internal fun transactionFromJson(item: JSONObject): Transaction = Transaction(
    id = item.string("id"),
    date = item.string("date"),
    cents = item.integer("cents"),
    account = item.string("account"),
    category = item.string("category"),
    subcategory = item.string("subcategory"),
    payee = item.string("payee"),
    note = item.string("note"),
    transferId = when (val value = item.opt("transferId")) {
        null -> null
        is String -> value.ifEmpty { null }
        else -> invalid()
    },
)

internal fun Transaction.toJson(): JSONObject = JSONObject()
    .put("id", id).put("date", date).put("cents", cents).put("account", account)
    .put("category", category).put("subcategory", subcategory).put("payee", payee).put("note", note)
    .also { json -> transferId?.let { json.put("transferId", it) } }

internal fun accountsFromJson(value: Any?): List<Account> = value.objects().map { item ->
    Account(item.string("name"), item.string("note"), when (val archived = item.opt("archived")) {
        null -> null
        is Boolean -> archived
        else -> invalid()
    })
}

internal fun accountsToJson(accounts: List<Account>): JSONArray = JSONArray(accounts.map { account ->
    JSONObject().put("name", account.name).put("note", account.note).also { json -> account.archived?.let { json.put("archived", it) } }
})

internal fun definitionsFromJson(value: Any?): List<FinanceCategory> =
    value.objects().map { FinanceCategory(it.string("name"), it.opt("subcategories").strings()) }

internal fun definitionsToJson(list: List<FinanceCategory>): JSONArray =
    JSONArray(list.map { JSONObject().put("name", it.name).put("subcategories", JSONArray(it.subcategories)) })

internal fun defaultsFromJson(value: Any?): Defaults =
    (value as? JSONObject ?: invalid()).let { Defaults(it.opt("account") as? String ?: invalid(), it.opt("category") as? String ?: invalid()) }

internal fun defaultsToJson(defaults: Defaults): JSONObject = JSONObject().put("account", defaults.account).put("category", defaults.category)

/** The same checks as the desktop app's validateFinanceFile; never silently drops financial entries. */
fun validateFinance(finance: Finance): Finance {
    if (finance.accounts.isEmpty()) invalid()
    val names = HashSet<String>()
    for (account in finance.accounts) if (account.name.isEmpty() || !names.add(account.name)) invalid()
    val ids = HashSet<String>()
    for (row in finance.transactions) {
        if (row.id.isEmpty() || !ids.add(row.id) || row.account !in names || !validDate(row.date) || row.cents == 0L) invalid()
    }
    for (pair in finance.transactions.filter { it.transferId != null }.groupBy { it.transferId }.values) {
        if (pair.size != 2 || pair[0].cents != -pair[1].cents || pair[0].account == pair[1].account || pair[0].date != pair[1].date) invalid()
    }
    return finance
}

/** Reads the former single-file `.noter/finance.json`, used only for the one-time migration to logs. */
fun parseLegacyFinance(text: String, template: ByteArray): Finance {
    val data = try { JSONObject(text) } catch (_: JSONException) { invalid() }
    if (data.opt("version") != 1) invalid()
    val finance = Finance(
        accounts = accountsFromJson(data.opt("accounts")),
        transactions = data.opt("transactions").objects().map(::transactionFromJson),
        categories = data.opt("categories").strings(),
        sourceName = data.opt("sourceName") as? String ?: invalid(),
        template = template,
        defaults = if (data.isNull("defaults")) null else defaultsFromJson(data.opt("defaults")),
        categoryDefinitions = if (data.has("categoryDefinitions")) definitionsFromJson(data.opt("categoryDefinitions")) else null,
    )
    return validateFinance(finance)
}
