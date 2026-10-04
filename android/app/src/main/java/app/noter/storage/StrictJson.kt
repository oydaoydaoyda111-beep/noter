package app.noter.storage

import android.util.JsonReader
import android.util.JsonToken
import java.io.IOException
import java.io.StringReader
import org.json.JSONObject

private val JSON_NUMBER = Regex("^-?(0|[1-9]\\d*)(\\.\\d+)?([eE][+-]?\\d+)?$")

/** JSONObject is lenient; shared files use the same standard JSON grammar as JSON.parse. */
internal fun strictJsonObject(text: String): JSONObject {
    try {
        JsonReader(StringReader(text)).use { reader ->
            reader.isLenient = false
            if (reader.peek() != JsonToken.BEGIN_OBJECT) throw IOException("Expected a JSON object.")
            var depth = 0
            do {
                when (reader.peek()) {
                    JsonToken.BEGIN_OBJECT -> { reader.beginObject(); depth++ }
                    JsonToken.END_OBJECT -> { reader.endObject(); depth-- }
                    JsonToken.BEGIN_ARRAY -> { reader.beginArray(); depth++ }
                    JsonToken.END_ARRAY -> { reader.endArray(); depth-- }
                    JsonToken.NAME -> reader.nextName()
                    JsonToken.STRING -> reader.nextString()
                    JsonToken.NUMBER -> if (!JSON_NUMBER.matches(reader.nextString())) throw IOException("Invalid JSON number.")
                    JsonToken.BOOLEAN -> reader.nextBoolean()
                    JsonToken.NULL -> reader.nextNull()
                    else -> throw IOException("Invalid JSON value.")
                }
            } while (depth > 0)
            if (reader.peek() != JsonToken.END_DOCUMENT) throw IOException("Unexpected content after JSON.")
        }
        return JSONObject(text)
    } catch (problem: Exception) {
        throw IOException("Stored file contains invalid JSON. Your files have been kept.", problem)
    }
}
