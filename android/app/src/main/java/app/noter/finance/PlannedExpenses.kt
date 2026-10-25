package app.noter.finance

import app.noter.storage.Saf
import org.json.JSONException
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.UUID

private const val PLANS = ".noter/planned-expenses.json"
private const val MAX_PLANS = 1_000_000L

data class PlannedExpense(val id: String, val name: String, val cents: Long)

class LoadedPlans(val expenses: List<PlannedExpense>, val revision: String?)

/** Validates the shared v1 contract in docs/FILE_STORAGE.md: unique nonempty IDs, nonblank names, positive JS-safe cents. */
fun validatePlans(expenses: List<PlannedExpense>): List<PlannedExpense> {
    val ids = HashSet<String>()
    for (item in expenses) {
        if (item.id.isEmpty() || !ids.add(item.id) || item.name.isBlank() || item.cents !in 1..MAX_SAFE) {
            throw FinanceException("Planned expenses contain an invalid or duplicate entry.")
        }
    }
    return expenses
}

fun parsePlans(text: String): List<PlannedExpense> = try {
    val data = JSONObject(text)
    if (data.opt("version") != 1) throw FinanceException("Planned expenses file is invalid. Keep the file and restore a valid copy.")
    val list = data.getJSONArray("expenses")
    validatePlans((0 until list.length()).map { index ->
        val item = list.getJSONObject(index)
        val cents = item.opt("cents")
        PlannedExpense(item.optString("id"), item.opt("name") as? String ?: "", if (cents is Int || cents is Long) (cents as Number).toLong() else 0L)
    })
} catch (_: JSONException) {
    throw FinanceException("Planned expenses file is invalid. Keep the file and restore a valid copy.")
}

/** Same layout as desktop's `JSON.stringify(plans, null, 2)`, so unchanged lists keep identical bytes. */
fun serializePlans(expenses: List<PlannedExpense>): String {
    if (expenses.isEmpty()) return "{\n  \"version\": 1,\n  \"expenses\": []\n}\n"
    val items = expenses.joinToString(",\n") {
        "    {\n      \"id\": ${JSONObject.quote(it.id)},\n      \"name\": ${JSONObject.quote(it.name)},\n      \"cents\": ${it.cents}\n    }"
    }
    return "{\n  \"version\": 1,\n  \"expenses\": [\n$items\n  ]\n}\n"
}

class PlannedTotals(val balance: Long, val planned: Long, val remaining: Long)

/** Totals across active accounts, including opening balances and transfers, minus every plan. */
fun plannedTotals(finance: Finance, expenses: List<PlannedExpense>): PlannedTotals {
    val active = finance.accounts.filter { it.archived != true }.map { it.name }.toSet()
    fun exact(value: Long) = value.takeIf { it in -MAX_SAFE..MAX_SAFE } ?: throw FinanceException("Planned expense totals exceed the supported amount range.")
    return try {
        var balance = 0L
        var planned = 0L
        for (row in finance.transactions) if (row.account in active) balance = Math.addExact(balance, row.cents)
        for (item in expenses) planned = Math.addExact(planned, item.cents)
        PlannedTotals(exact(balance), exact(planned), exact(Math.subtractExact(balance, planned)))
    } catch (_: ArithmeticException) {
        throw FinanceException("Planned expense totals exceed the supported amount range.")
    }
}

/** The shared `.noter/planned-expenses.json` snapshot with SHA-256 revision checks, like the desktop vault. */
class PlannedFiles(private val saf: Saf) {
    private fun bytes(): ByteArray? {
        val noter = saf.resolve(".noter")?.takeIf { it.isDir }?.let { saf.list(it.doc) } ?: return null
        if (noter.any { it.name.startsWith("planned-expenses.sync-conflict-") }) {
            throw FinanceException("Planned expenses have Syncthing conflict copies. Resolve these copies before editing; all files have been kept.")
        }
        val entry = noter.firstOrNull { it.name == "planned-expenses.json" } ?: return null
        if (entry.isDir) throw FinanceException("A folder blocks the planned expenses file. Your files have been kept.")
        return saf.read(entry.doc, MAX_PLANS)
    }

    fun load(): LoadedPlans {
        val bytes = bytes() ?: return LoadedPlans(emptyList(), null)
        val text = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
            throw FinanceException("Planned expenses must be UTF-8.")
        }
        return LoadedPlans(parsePlans(text), sha256(bytes))
    }

    /** Replaces the file only if it still matches [expected]; the previous contents go to `.noter/trash`. Returns the new revision. */
    fun save(expenses: List<PlannedExpense>, expected: String?): String {
        val text = serializePlans(validatePlans(expenses)).toByteArray()
        if (text.size > MAX_PLANS) throw FinanceException("Planned expenses file exceeds the 1 MB limit.")
        val changed = "Planned expenses changed outside Noter. Reload plans before saving; your draft is still here."
        val previous = bytes()
        if (previous?.let(::sha256) != expected) throw FinanceException(changed)
        val saved = sha256(text)
        if (previous?.contentEquals(text) == true) return saved
        if (previous != null) {
            val backup = ".noter/trash/planned-expenses-${System.currentTimeMillis()}-${UUID.randomUUID()}.json"
            saf.writeAtomic(backup, previous, mustBeAbsent = true)
            if (saf.resolve(backup)?.let { saf.read(it.doc, MAX_PLANS) }?.contentEquals(previous) != true) {
                throw FinanceException("Could not verify planned expenses backup.")
            }
        }
        saf.writeAtomic(PLANS, text, expected = previous, mustBeAbsent = previous == null)
        if (bytes()?.let(::sha256) != saved) throw FinanceException("Planned expenses changed while saving. Reload plans before editing again.")
        return saved
    }
}
