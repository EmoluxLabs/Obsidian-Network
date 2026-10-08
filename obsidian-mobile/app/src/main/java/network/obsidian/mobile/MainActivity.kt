package network.obsidian.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import network.obsidian.mobile.ui.screens.EdgeNodeScreen
import network.obsidian.mobile.ui.screens.LandingScreen
import network.obsidian.mobile.ui.theme.ObsidianTheme

/** The app's screen routes. One place, so navigation cannot drift per screen. */
object Routes {
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
        setContent {
            ObsidianTheme {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    val nav = rememberNavController()
                    val repository = (application as ObsidianApp).repository
                    val nodeUrl by repository.nodeUrl.collectAsState()
                    NavHost(navController = nav, startDestination = Routes.LANDING) {
                        composable(Routes.LANDING) { LandingScreen(navController = nav) }
                        composable(Routes.EDGE_NODE) {
                            EdgeNodeScreen(nodeUrl = nodeUrl, onBack = { nav.popBackStack() })
                        }
                    }
                }
            }
        }
    }
}
