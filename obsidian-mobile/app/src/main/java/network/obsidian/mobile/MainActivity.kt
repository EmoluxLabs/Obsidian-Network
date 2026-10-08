package network.obsidian.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import network.obsidian.mobile.identity.ProfileStore
import network.obsidian.mobile.ui.screens.R_SPLASH
import network.obsidian.mobile.ui.theme.ObsidianTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as ObsidianApp
        val store = ProfileStore(this)
        setContent {
            ObsidianTheme {
                Surface(
                    modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    val nav = rememberNavController()
                    NavHost(navController = nav, startDestination = R_SPLASH) {
                        // Registered from the graph, not listed here: a route absent
                        // from AppGraph is absent from the app, and a test says so.
                        AppGraph.entries.forEach { entry ->
                            composable(entry.route) { entry.content(nav, app.repository, store) }
                        }
                    }
                }
            }
        }
    }
}
