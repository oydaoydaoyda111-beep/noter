package app.noter.model

import org.json.JSONObject

fun normalizeSettings(input: JSONObject?): Settings {
    val defaults = Settings()
    fun text(key: String, options: List<String>, fallback: String): String =
        (input?.opt(key) as? String)?.takeIf { it in options } ?: fallback
    fun number(key: String, options: List<Int>, fallback: Int): Int =
        (input?.opt(key) as? Number)?.toDouble()?.takeIf { it in options.map(Int::toDouble) }?.toInt() ?: fallback
    fun flag(key: String, fallback: Boolean): Boolean = input?.opt(key) as? Boolean ?: fallback
    fun clamped(key: String, min: Int, max: Int, fallback: Double): Double =
        (input?.opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() && it > 0 }
            ?.coerceIn(min.toDouble(), max.toDouble()) ?: fallback
    return Settings(
        fontSize = clamped("fontSize", 14, 24, defaults.fontSize),
        fontStyle = text("fontStyle", listOf("sans", "serif", "mono"), defaults.fontStyle),
        documentWidth = number("documentWidth", listOf(720, 790, 850), defaults.documentWidth),
        density = text("density", listOf("comfortable", "compact"), defaults.density),
        motion = text("motion", listOf("full", "subtle", "none"), defaults.motion),
        autosaveDelay = clamped("autosaveDelay", 200, 2000, defaults.autosaveDelay),
        accentColor = text("accentColor", listOf("blue", "green", "purple"), defaults.accentColor),
        startupSection = text("startupSection", listOf("last", "notes", "finance", "planner"), defaults.startupSection),
        spellcheck = flag("spellcheck", defaults.spellcheck),
        showNoteStats = flag("showNoteStats", defaults.showNoteStats),
        financeCurrency = text("financeCurrency", listOf("", "AZN", "USD", "EUR", "GBP", "TRY"), defaults.financeCurrency),
        financeDateFormat = text("financeDateFormat", listOf("iso", "dmy", "mdy"), defaults.financeDateFormat),
        financeTableDensity = text("financeTableDensity", listOf("compact", "comfortable"), defaults.financeTableDensity),
        financePageSize = number("financePageSize", listOf(25, 50, 100, 200), defaults.financePageSize),
        financeDefaultAccount = (input?.opt("financeDefaultAccount") as? String)?.takeIf { it.length <= 120 }
            ?: defaults.financeDefaultAccount,
        financeRememberEntries = flag("financeRememberEntries", defaults.financeRememberEntries),
        financeShowAccountNotes = flag("financeShowAccountNotes", defaults.financeShowAccountNotes),
    )
}

fun Settings.toJson(): JSONObject = JSONObject()
    .put("fontSize", fontSize)
    .put("fontStyle", fontStyle)
    .put("documentWidth", documentWidth)
    .put("density", density)
    .put("motion", motion)
    .put("autosaveDelay", autosaveDelay)
    .put("accentColor", accentColor)
    .put("startupSection", startupSection)
    .put("spellcheck", spellcheck)
    .put("showNoteStats", showNoteStats)
    .put("financeCurrency", financeCurrency)
    .put("financeDateFormat", financeDateFormat)
    .put("financeTableDensity", financeTableDensity)
    .put("financePageSize", financePageSize)
    .put("financeDefaultAccount", financeDefaultAccount)
    .put("financeRememberEntries", financeRememberEntries)
    .put("financeShowAccountNotes", financeShowAccountNotes)
