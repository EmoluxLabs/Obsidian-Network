package network.obsidian.mobile

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import network.obsidian.mobile.identity.ProfileStore
import network.obsidian.mobile.remote.ObsidianRepository
import network.obsidian.mobile.ui.screens.ApiScreen
import network.obsidian.mobile.ui.screens.ExplorerScreen
import network.obsidian.mobile.ui.screens.HomeScreen
import network.obsidian.mobile.ui.screens.LandingScreen
import network.obsidian.mobile.ui.screens.MenuScreen
import network.obsidian.mobile.ui.screens.MineScreen
import network.obsidian.mobile.ui.screens.NodeScreen
import network.obsidian.mobile.ui.screens.OnsScreen
import network.obsidian.mobile.ui.screens.R_API
import network.obsidian.mobile.ui.screens.R_EXPLORER
import network.obsidian.mobile.ui.screens.R_HOME
import network.obsidian.mobile.ui.screens.R_LANDING
import network.obsidian.mobile.ui.screens.R_MENU
import network.obsidian.mobile.ui.screens.R_MINE
import network.obsidian.mobile.ui.screens.R_NODE
import network.obsidian.mobile.ui.screens.R_ONS
import network.obsidian.mobile.ui.screens.R_SETTINGS
import network.obsidian.mobile.ui.screens.R_SIGNIN
import network.obsidian.mobile.ui.screens.R_SIGNUP
import network.obsidian.mobile.ui.screens.R_SPLASH
import network.obsidian.mobile.ui.screens.R_WALLET
import network.obsidian.mobile.ui.screens.SettingsScreen
import network.obsidian.mobile.ui.screens.SignInScreen
import network.obsidian.mobile.ui.screens.SignUpScreen
import network.obsidian.mobile.ui.screens.SplashScreen
import network.obsidian.mobile.ui.screens.WalletScreen

/**
 * The navigation graph, as data.
 *
 * Route names are the blueprint's own `V` keys — splash, landing, signup, signin,
 * home, mine, wallet, explorer, ons, node, api, menu — plus settings, which the
 * app needs and the blueprint reaches from its menu. Registration loops over this
 * list, so a route missing here is genuinely missing from the app, and
 * [AppGraphTest] fails the build.
 */
data class RouteEntry(
    val route: String,
    val screen: String,
    val content: @Composable (nav: NavHostController, repository: ObsidianRepository, store: ProfileStore) -> Unit,
)

object AppGraph {

    val entries: List<RouteEntry> = listOf(
        RouteEntry(R_SPLASH, "Splash") { nav, _, _ ->
            SplashScreen(
                onFinished = {
                    // replace, not push: back from the landing exits the app rather
                    // than returning to a splash the user has already left.
                    nav.navigate(R_LANDING) { popUpTo(R_SPLASH) { inclusive = true } }
                },
            )
        },
        RouteEntry(R_LANDING, "Landing") { nav, repo, _ ->
            LandingScreen(repository = repo, onNavigate = { nav.navigate(it) })
        },
        RouteEntry(R_SIGNUP, "Sign Up") { nav, _, store ->
            SignUpScreen(store = store, onSignIn = { nav.navigate(R_SIGNIN) }, onDone = { nav.navigate(R_HOME) })
        },
        RouteEntry(R_SIGNIN, "Sign In") { nav, _, store ->
            SignInScreen(store = store, onUnlock = { nav.navigate(R_HOME) }, onSignUp = { nav.navigate(R_SIGNUP) })
        },
        RouteEntry(R_HOME, "Home") { nav, repo, store ->
            HomeScreen(store = store, repository = repo, onNavigate = { nav.navigate(it) })
        },
        RouteEntry(R_MINE, "Mine") { nav, repo, store ->
            MineScreen(store = store, repository = repo, onNavigate = { nav.navigate(it) })
        },
        RouteEntry(R_WALLET, "Wallet") { nav, repo, store ->
            WalletScreen(store = store, repository = repo, onNavigate = { nav.navigate(it) })
        },
        RouteEntry(R_EXPLORER, "Explorer") { nav, repo, _ ->
            ExplorerScreen(repository = repo, onNavigate = { nav.navigate(it) })
        },
        RouteEntry(R_ONS, "ONS") { nav, repo, _ ->
            OnsScreen(repository = repo, onNavigate = { nav.navigate(it) })
        },
        RouteEntry(R_NODE, "Node") { nav, repo, _ ->
            NodeScreen(repository = repo, onNavigate = { nav.navigate(it) })
        },
        RouteEntry(R_API, "API") { nav, repo, _ ->
            ApiScreen(repository = repo, onNavigate = { nav.navigate(it) })
        },
        RouteEntry(R_MENU, "Menu") { nav, repo, store ->
            MenuScreen(store = store, repository = repo, onNavigate = { nav.navigate(it) })
        },
        RouteEntry(R_SETTINGS, "Settings") { nav, repo, _ ->
            SettingsScreen(repository = repo, onNavigate = { nav.navigate(it) })
        },
    )
}
