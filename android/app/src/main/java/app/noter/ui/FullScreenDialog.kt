package app.noter.ui

import android.content.Context
import android.os.Build
import android.view.View
import android.view.WindowManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlin.math.roundToInt

private fun windowSize(host: View): IntSize {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val manager = host.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val bounds = manager.currentWindowMetrics.bounds
        return IntSize(bounds.width(), bounds.height())
    }
    // Older Android configuration sizes already exclude system bars and do not shrink for the IME.
    val configuration = host.resources.configuration
    val density = host.resources.displayMetrics.density
    return IntSize((configuration.screenWidthDp * density).roundToInt(), (configuration.screenHeightDp * density).roundToInt())
}

/** Bound dialogs to the host's usable viewport, including landscape navigation bars and cutouts. */
@Composable
fun FullScreenDialog(onDismissRequest: () -> Unit, content: @Composable () -> Unit) {
    val host = LocalView.current
    val configuration = LocalConfiguration.current
    var viewport by remember(host) { mutableStateOf(windowSize(host)) }
    DisposableEffect(host, configuration.screenWidthDp, configuration.screenHeightDp) {
        viewport = windowSize(host)
        val listener = View.OnLayoutChangeListener { view, _, _, _, _, _, _, _, _ -> viewport = windowSize(view) }
        host.addOnLayoutChangeListener(listener)
        onDispose { host.removeOnLayoutChangeListener(listener) }
    }
    val bars = WindowInsets.systemBars.union(WindowInsets.displayCutout)
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val subtractBars = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
    val height = with(density) {
        (viewport.height - if (subtractBars) bars.getTop(this) + bars.getBottom(this) else 0).coerceAtLeast(1).toDp()
    }
    val width = with(density) {
        (viewport.width - if (subtractBars) bars.getLeft(this, direction) + bars.getRight(this, direction) else 0).coerceAtLeast(1).toDp()
    }
    // Window metrics stay stable when the host view has already resized for a keyboard.
    // Let the dialog window fit system bars; its own edge-to-edge insets can be zero on phones.
    Dialog(onDismissRequest = onDismissRequest, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.width(width).height(height)) { content() }
    }
}
