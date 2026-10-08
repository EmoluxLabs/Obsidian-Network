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
import network.obsidian.mobile.ui.theme.ObsidianTheme

/** The app's screen routes. One place, so navigation cannot drift per screen. */
object Routes {
    const val SPLASH = "splash"
    const val LANDING = "landing"
    const val MENU = "menu"
    const val SIGN_UP = "sign-up"
    const val SIGN_IN = "sign-in"
    const val TWO_FACTOR = "two-factor"
    const val ACCOUNT_RECOVERY = "account-recovery"
    const val CREATE_WALLET = "create-wallet"
    const val RECOVER_WALLET = "recover-wallet"
    const val ACCOUNT = "account"
    const val MINING = "mining"
    const val MINING_ACTIVE = "mining-active"
    const val WALLET = "wallet"
    const val EXPLORER = "explorer"
    const val ONS = "ons"
    const val EDGE_NODE = "edge-node"
    const val SETTINGS = "settings"
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as ObsidianApp
        val store = ProfileStore(this)
        setContent {
            ObsidianTheme {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    val nav = rememberNavController()
                    NavHost(navController = nav, startDestination = Routes.SPLASH) {
                        // Registered from the graph, not listed here: a route that
                        // is missing from AppGraph is missing from the app, and a
                        // test says so.
                        AppGraph.entries.forEach { entry ->
                            composable(entry.route) {
                                entry.content(nav, app.repository, store)
                            }
                        }
                    }
                }
            }
        }
    }
}
