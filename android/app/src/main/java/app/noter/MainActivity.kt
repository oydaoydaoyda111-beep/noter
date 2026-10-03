package app.noter

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import app.noter.state.WorkspaceViewModel
import app.noter.ui.NoterApp

class MainActivity : ComponentActivity() {
    private val viewModel: WorkspaceViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { NoterApp(viewModel) }
    }

    override fun onStop() {
        viewModel.flushNow()
        super.onStop()
    }
}
