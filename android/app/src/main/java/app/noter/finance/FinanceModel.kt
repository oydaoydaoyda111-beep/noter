package app.noter.finance

import java.math.BigDecimal
import java.text.NumberFormat
import java.time.LocalDate
import java.time.format.DateTimeParseException
import java.util.UUID
import kotlin.math.abs

const val TRANSFER_CATEGORY = "Transfer to other account"
private const val MAX_SAFE = 9_007_199_254_740_991L

class FinanceException(message: String) : Exception(message)

data class Account(val name: String, val note: String, val archived: Boolean? = null)

data class Transaction(
    val id: String,
    val date: String,
    val cents: Long,
    val account: String,
    val category: String,
    val subcategory: String,
    val payee: String,
    val note: String,
    val transferId: String? = null,
)

data class Defaults(val account: String, val category: String)

data class FinanceCategory(val name: String, val subcategories: List<String>)

class Finance(
    val accounts: List<Account>,
    val transactions: List<Transaction>,
    val categories: List<String>,
    val sourceName: String,
    val template: ByteArray,
    val defaults: Defaults? = null,
    val categoryDefinitions: List<FinanceCategory>? = null,
) {
    fun copy(
        accounts: List<Account> = this.accounts,
        transactions: List<Transaction> = this.transactions,
        categories: List<String> = this.categories,
        defaults: Defaults? = this.defaults,
        categoryDefinitions: List<FinanceCategory>? = this.categoryDefinitions,
    ) = Finance(accounts, transactions, categories, sourceName, template, defaults, categoryDefinitions)
}

fun newId(): String = UUID.randomUUID().toString()

fun today(): String = LocalDate.now().toString()

private val MONEY = Regex("^-?\\d+(?:\\.\\d{1,2})?$")

fun money(value: String): Long {
    val text = value.trim()
    if (!MONEY.matches(text)) throw FinanceException("Enter an amount with at most two decimal places.")
    val cents = try {
        BigDecimal(text).movePointRight(2).longValueExact()
    } catch (_: ArithmeticException) {
        throw FinanceException("Amount is too large.")
    }
    if (abs(cents) > MAX_SAFE) throw FinanceException("Amount is too large.")
    return cents
}

fun balances(finance: Finance): Map<String, Long> {
    val result = LinkedHashMap<String, Long>()
    finance.accounts.forEach { result[it.name] = 0L }
    for (row in finance.transactions) result[row.account] = (result[row.account] ?: 0L) + row.cents
    return result
}

fun validDate(date: String): Boolean = Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(date) &&
    try { LocalDate.parse(date).toString() == date } catch (_: DateTimeParseException) { false }

fun validateTransaction(finance: Finance, row: Transaction) {
    if (!validDate(row.date)) throw FinanceException("Choose a valid date.")
    if (row.cents == 0L || abs(row.cents) > MAX_SAFE) throw FinanceException("Amount must be greater than zero.")
    if (finance.accounts.none { it.name == row.account }) throw FinanceException("Choose an account.")
}

fun saveTransaction(finance: Finance, row: Transaction, destination: String?): Finance {
    validateTransaction(finance, row)
    val group = finance.transactions.firstOrNull { it.id == row.id }?.transferId
    val remaining = finance.transactions.filter { if (group != null) it.transferId != group else it.id != row.id }.toMutableList()
    val next = row.copy(transferId = null)
    if (!destination.isNullOrEmpty()) {
        if (destination == row.account || finance.accounts.none { it.name == destination }) {
            throw FinanceException("Choose a different destination account.")
        }
        val outgoing = next.copy(transferId = group ?: newId(), cents = -abs(row.cents), category = TRANSFER_CATEGORY)
        remaining += outgoing
        remaining += outgoing.copy(id = newId(), account = destination, cents = -outgoing.cents)
    } else {
        remaining += next
    }
    return finance.copy(transactions = remaining)
}

fun removeTransaction(finance: Finance, id: String): Finance {
    val row = finance.transactions.firstOrNull { it.id == id }
    val transfer = row?.transferId
    return finance.copy(transactions = finance.transactions.filter { if (transfer != null) it.transferId != transfer else it.id != id })
}

// Accounts

fun updateAccount(finance: Finance, previous: String?, rawName: String, note: String): Finance {
    val name = rawName.trim()
    if (name.isEmpty() || name.length > 120) throw FinanceException("Enter an account name between 1 and 120 characters.")
    if (note.length > 2000) throw FinanceException("Keep account notes under 2,000 characters.")
    if (previous != null && finance.accounts.none { it.name == previous }) throw FinanceException("Account no longer exists.")
    if (finance.accounts.any { it.name != previous && it.name.trim().lowercase() == name.lowercase() }) throw FinanceException("That account already exists.")
    val accounts = if (previous == null) finance.accounts + Account(name, note)
    else finance.accounts.map { if (it.name == previous) it.copy(name = name, note = note) else it }
    return finance.copy(
        accounts = accounts,
        transactions = finance.transactions.map { if (previous != null && it.account == previous) it.copy(account = name) else it },
        defaults = finance.defaults?.let { if (previous != null && it.account == previous) it.copy(account = name) else it },
    )
}

fun archiveAccount(finance: Finance, name: String, archived: Boolean): Finance {
    val account = finance.accounts.firstOrNull { it.name == name } ?: throw FinanceException("Account no longer exists.")
    if (archived && account.archived != true && finance.accounts.count { it.archived != true } <= 1) {
        throw FinanceException("Keep at least one active account.")
    }
    return finance.copy(
        accounts = finance.accounts.map { if (it.name == name) it.copy(archived = archived) else it },
        defaults = finance.defaults?.let { if (archived && it.account == name) it.copy(account = "") else it },
    )
}

// Categories

private fun key(name: String) = name.trim().lowercase()
fun isTransferCategory(name: String) = key(name) == key(TRANSFER_CATEGORY)

private fun validName(name: String): String {
    val result = name.trim()
    if (result.isEmpty() || result.length > 120) throw FinanceException("Enter a name between 1 and 120 characters.")
    return result
}

fun categoryCatalog(finance: Finance): List<FinanceCategory> {
    val result = LinkedHashMap<String, LinkedHashSet<String>>()
    fun add(name: String, subcategory: String = "") {
        if (name.isEmpty()) return
        val set = result.getOrPut(name) { LinkedHashSet() }
        if (subcategory.isNotEmpty()) set.add(subcategory)
    }
    finance.categories.forEach { add(it) }
    finance.categoryDefinitions?.forEach { category ->
        add(category.name)
        category.subcategories.forEach { add(category.name, it) }
    }
    finance.transactions.forEach { add(it.category, it.subcategory) }
    add(TRANSFER_CATEGORY)
    return result.map { (name, subs) -> FinanceCategory(name, subs.sorted()) }.sortedBy { it.name }
}

private fun withCatalog(finance: Finance, catalog: List<FinanceCategory>): Finance =
    finance.copy(categoryDefinitions = catalog, categories = catalog.map { it.name })

fun registerCategory(finance: Finance, name: String, subcategory: String = ""): Finance {
    if (name.isEmpty()) return finance
    val catalog = categoryCatalog(finance).toMutableList()
    val index = catalog.indexOfFirst { it.name == name }
    if (index < 0) catalog += FinanceCategory(name, listOfNotNull(subcategory.ifEmpty { null }))
    else if (subcategory.isNotEmpty() && subcategory !in catalog[index].subcategories) {
        catalog[index] = catalog[index].copy(subcategories = catalog[index].subcategories + subcategory)
    }
    return withCatalog(finance, catalog)
}

fun addCategory(finance: Finance, rawName: String, parent: String? = null): Finance {
    val name = validName(rawName)
    val catalog = categoryCatalog(finance).toMutableList()
    if (parent != null) {
        val index = catalog.indexOfFirst { it.name == parent }
        if (index < 0 || isTransferCategory(parent)) throw FinanceException("Choose an editable category.")
        if (catalog[index].subcategories.any { key(it) == key(name) }) throw FinanceException("That subcategory already exists.")
        catalog[index] = catalog[index].copy(subcategories = catalog[index].subcategories + name)
    } else {
        if (catalog.any { key(it.name) == key(name) }) throw FinanceException("That category already exists.")
        catalog += FinanceCategory(name, emptyList())
    }
    return withCatalog(finance, catalog)
}

fun renameCategory(finance: Finance, previous: String, rawName: String, subcategory: String? = null): Finance {
    val name = validName(rawName)
    val catalog = categoryCatalog(finance).toMutableList()
    val index = catalog.indexOfFirst { it.name == previous }
    if (index < 0 || isTransferCategory(previous)) throw FinanceException("This category is reserved for transfers.")
    val category = catalog[index]
    if (subcategory != null) {
        if (subcategory !in category.subcategories) throw FinanceException("Subcategory no longer exists.")
        if (category.subcategories.any { it != subcategory && key(it) == key(name) }) throw FinanceException("That subcategory already exists.")
        catalog[index] = category.copy(subcategories = category.subcategories.map { if (it == subcategory) name else it })
    } else {
        if (catalog.any { it.name != previous && key(it.name) == key(name) }) throw FinanceException("That category already exists. Use Merge to combine them.")
        catalog[index] = category.copy(name = name)
    }
    val transactions = finance.transactions.map { row ->
        when {
            row.category != previous -> row
            subcategory == null -> row.copy(category = name)
            row.subcategory == subcategory -> row.copy(subcategory = name)
            else -> row
        }
    }
    val defaults = finance.defaults?.let { if (subcategory == null && it.category == previous) it.copy(category = name) else it }
    return withCatalog(finance, catalog).copy(transactions = transactions, defaults = defaults)
}

fun mergeCategories(finance: Finance, source: String, target: String): Finance {
    val catalog = categoryCatalog(finance)
    val from = catalog.firstOrNull { it.name == source }
    val to = catalog.firstOrNull { it.name == target }
    if (from == null || to == null || source == target || isTransferCategory(source) || isTransferCategory(target)) {
        throw FinanceException("Choose two different editable categories.")
    }
    val merged = catalog.filter { it.name != source }.map {
        if (it.name == target) it.copy(subcategories = (to.subcategories + from.subcategories).distinct()) else it
    }
    val defaults = finance.defaults?.let { if (it.category == source) it.copy(category = target) else it }
    return withCatalog(finance, merged).copy(
        transactions = finance.transactions.map { if (it.category == source) it.copy(category = target) else it },
        defaults = defaults,
    )
}

fun deleteCategory(finance: Finance, name: String, subcategory: String? = null): Finance {
    if (isTransferCategory(name)) throw FinanceException("This category is reserved for transfers.")
    val catalog = categoryCatalog(finance)
    val next = if (subcategory == null) catalog.filter { it.name != name }
    else catalog.map { if (it.name == name) it.copy(subcategories = it.subcategories - subcategory) else it }
    val transactions = finance.transactions.map { row ->
        when {
            row.category != name -> row
            subcategory == null -> row.copy(category = "", subcategory = "")
            row.subcategory == subcategory -> row.copy(subcategory = "")
            else -> row
        }
    }
    val defaults = finance.defaults?.let { if (subcategory == null && it.category == name) it.copy(category = "") else it }
    return withCatalog(finance, next).copy(transactions = transactions, defaults = defaults)
}

// Display

fun formatAmount(cents: Long, currency: String): String {
    val format = NumberFormat.getNumberInstance().apply { minimumFractionDigits = 2; maximumFractionDigits = 2 }
    val number = format.format(BigDecimal(abs(cents)).movePointLeft(2))
    val sign = if (cents < 0) "-" else ""
    return if (currency.isEmpty()) "$sign$number" else "$sign$currency $number"
}

fun formatDate(iso: String, format: String): String {
    val parts = iso.split('-')
    if (parts.size != 3) return iso
    val (year, month, day) = parts
    return when (format) {
        "dmy" -> "$day/$month/$year"
        "mdy" -> "$month/$day/$year"
        else -> iso
    }
}
