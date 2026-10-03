package app.noter.finance

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

// Finance is stored as one append-only log per device in .noter/finance/log-<device>.jsonl.
// Each device appends only to its own file, so Syncthing never produces conflicting copies.
// Every line is one batch of changes; replaying all batches ordered by (ts, dev, seq) gives
// the current data, with the latest change winning for each transaction or setting.
// The desktop client implements the same format in src/finance/log.ts; keep both in step.

private val META_KEYS = listOf("accounts", "categories", "categoryDefinitions", "defaults", "sourceName", "templateSha256")

class LogFile(val name: String, val text: String)

class Batch(val ts: Long, val dev: String, val seq: Long, val ops: List<JSONObject>)

class ParsedLogs(val batches: List<Batch>, val clock: Long, val seq: Long, val ownNeedsNewline: Boolean)

/** Replayed Finance data; [finance] carries an empty template until the caller attaches the workbook. */
class FinanceState(val finance: Finance, val templateSha256: String)

private fun logInvalid(): Nothing =
    throw FinanceException("Finance log contains invalid data. Keep the files and restore a valid backup before editing.")

private fun JSONObject.long(key: String): Long = when (val value = opt(key)) {
    is Int -> value.toLong()
    is Long -> value
    else -> logInvalid()
}

private fun parseBatch(line: String): Batch {
    val json = try { JSONObject(line) } catch (_: JSONException) { logInvalid() }
    if (json.opt("v") != 1) logInvalid()
    val dev = json.opt("dev") as? String ?: logInvalid()
    val opsJson = json.optJSONArray("ops") ?: logInvalid()
    if (dev.isEmpty()) logInvalid()
    val ops = List(opsJson.length()) { index ->
        val op = opsJson.optJSONObject(index) ?: logInvalid()
        when (op.opt("k")) {
            "reset" -> {}
            "tx" -> {
                val id = op.opt("id") as? String ?: logInvalid()
                val tx = op.opt("tx")
                if (id.isEmpty() || !(tx == JSONObject.NULL || (tx is JSONObject && tx.opt("id") == id))) logInvalid()
            }
            "meta" -> if (op.opt("key") !in META_KEYS) logInvalid()
            else -> logInvalid()
        }
        op
    }
    return Batch(json.long("ts"), dev, json.long("seq"), ops)
}

/** Parses every log file. A final line without a newline is an interrupted write and is ignored. */
fun parseLogs(files: List<LogFile>, device: String): ParsedLogs {
    val seen = LinkedHashMap<String, Batch>()
    var clock = 0L
    var seq = 0L
    var ownNeedsNewline = false
    for (file in files) {
        val lines = file.text.split('\n')
        if (lines.last().isNotBlank() && file.name == "log-$device.jsonl") ownNeedsNewline = true
        for (line in lines.dropLast(1)) {
            if (line.isBlank()) continue
            val batch = parseBatch(line)
            seen["${batch.dev}\u0000${batch.seq}"] = batch
            clock = maxOf(clock, batch.ts)
            if (batch.dev == device) seq = maxOf(seq, batch.seq)
        }
    }
    return ParsedLogs(seen.values.toList(), clock, seq, ownNeedsNewline)
}

/** Replays batches into Finance data; returns null when Finance was never started. */
fun replayFinance(batches: List<Batch>): FinanceState? {
    val ordered = batches.sortedWith(compareBy<Batch> { it.ts }.thenBy { it.dev }.thenBy { it.seq })
    val rows = LinkedHashMap<String, JSONObject>()
    val meta = HashMap<String, Any?>()
    for (batch in ordered) for (op in batch.ops) {
        when (op.opt("k")) {
            "reset" -> { rows.clear(); meta.clear() }
            "tx" -> {
                val id = op.getString("id")
                val tx = op.opt("tx")
                if (tx is JSONObject) rows[id] = tx else rows.remove(id)
            }
            "meta" -> meta[op.getString("key")] = op.opt("value")
        }
    }
    fun present(key: String) = meta[key]?.takeIf { it != JSONObject.NULL }
    val accounts = present("accounts")?.let(::accountsFromJson)?.toMutableList() ?: mutableListOf()
    val transactions = rows.values.map(::transactionFromJson)
    if (accounts.isEmpty() && transactions.isEmpty()) return null
    // Concurrent edits on different devices can leave references that no longer line up.
    // Repair them without losing amounts: restore missing accounts and unlink broken transfers.
    val names = accounts.map { it.name }.toMutableSet()
    for (row in transactions) if (names.add(row.account)) accounts += Account(row.account, "")
    val groups = transactions.filter { it.transferId != null }.groupBy { it.transferId }
    val repaired = transactions.map { row ->
        val pair = row.transferId?.let { groups[it] }
        if (pair == null || (pair.size == 2 && pair[0].cents == -pair[1].cents && pair[0].account != pair[1].account && pair[0].date == pair[1].date)) row
        else row.copy(transferId = null)
    }
    val finance = Finance(
        accounts = accounts,
        transactions = repaired,
        categories = present("categories")?.strings() ?: emptyList(),
        sourceName = present("sourceName") as? String ?: "",
        template = ByteArray(0),
        defaults = present("defaults")?.let(::defaultsFromJson),
        categoryDefinitions = present("categoryDefinitions")?.let(::definitionsFromJson),
    )
    return FinanceState(finance, present("templateSha256") as? String ?: "")
}

private fun metaValue(finance: Finance, key: String, templateSha256: String): Any? = when (key) {
    "accounts" -> finance.accounts
    "categories" -> finance.categories
    "categoryDefinitions" -> finance.categoryDefinitions
    "defaults" -> finance.defaults
    "sourceName" -> finance.sourceName
    else -> templateSha256
}

@Suppress("UNCHECKED_CAST")
private fun metaJson(value: Any?, key: String): Any = when (key) {
    "accounts" -> accountsToJson(value as List<Account>)
    "categories" -> JSONArray(value as List<String>)
    "categoryDefinitions" -> (value as List<FinanceCategory>?)?.let(::definitionsToJson) ?: JSONObject.NULL
    "defaults" -> (value as Defaults?)?.let(::defaultsToJson) ?: JSONObject.NULL
    else -> value as String
}

/** Operations that turn [base] into [next]. Without a base, the batch replaces all Finance data. */
fun diffFinance(base: FinanceState?, next: Finance, templateSha256: String): List<JSONObject> {
    val ops = ArrayList<JSONObject>()
    if (base == null) ops += JSONObject().put("k", "reset")
    for (key in META_KEYS) {
        val value = metaValue(next, key, templateSha256)
        if (base == null || metaValue(base.finance, key, base.templateSha256) != value) {
            ops += JSONObject().put("k", "meta").put("key", key).put("value", metaJson(value, key))
        }
    }
    val previous = base?.finance?.transactions?.associateBy { it.id } ?: emptyMap()
    val current = HashSet<String>()
    for (row in next.transactions) {
        current += row.id
        if (previous[row.id] != row) ops += JSONObject().put("k", "tx").put("id", row.id).put("tx", row.toJson())
    }
    for (id in previous.keys) if (id !in current) ops += JSONObject().put("k", "tx").put("id", id).put("tx", JSONObject.NULL)
    return ops
}

fun batchLine(device: String, clock: Long, seq: Long, ops: List<JSONObject>): Pair<String, Long> {
    val ts = maxOf(System.currentTimeMillis(), clock + 1)
    val line = JSONObject().put("v", 1).put("ts", ts).put("dev", device).put("seq", seq).put("ops", JSONArray(ops)).toString()
    return "$line\n" to ts
}
