package app.noter

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import app.noter.state.FinanceViewModel
import app.noter.state.WorkspaceViewModel
import app.noter.ui.NoterApp

class MainActivity : ComponentActivity() {
    private val viewModel: WorkspaceViewModel by viewModels()
    private val financeViewModel: FinanceViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContent { NoterApp(viewModel, financeViewModel) }
    }

    override fun onStart() {
        super.onStart()
        viewModel.setForeground(true)
        financeViewModel.setForeground(true)
    }

    override fun onStop() {
        viewModel.setForeground(false)
        financeViewModel.setForeground(false)
        viewModel.flushNow()
        super.onStop()
    }
}
