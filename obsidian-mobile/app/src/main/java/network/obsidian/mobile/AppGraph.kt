package network.obsidian.mobile

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.navigation.NavHostController
import network.obsidian.mobile.identity.ProfileStore
import network.obsidian.mobile.remote.ObsidianRepository
import network.obsidian.mobile.ui.screens.AccountRecoveryScreen
import network.obsidian.mobile.ui.screens.AccountScreen
import network.obsidian.mobile.ui.screens.CreateWalletScreen
import network.obsidian.mobile.ui.screens.EdgeNodeScreen
import network.obsidian.mobile.ui.screens.ExplorerScreen
import network.obsidian.mobile.ui.screens.LandingScreen
import network.obsidian.mobile.ui.screens.MenuScreen
import network.obsidian.mobile.ui.screens.MiningActiveScreen
import network.obsidian.mobile.ui.screens.MiningScreen
import network.obsidian.mobile.ui.screens.OnsScreen
import network.obsidian.mobile.ui.screens.RecoverWalletScreen
import network.obsidian.mobile.ui.screens.SettingsScreen
import network.obsidian.mobile.ui.screens.SplashScreen
import network.obsidian.mobile.ui.screens.SignInScreen
import network.obsidian.mobile.ui.screens.SignUpScreen
import network.obsidian.mobile.ui.screens.TwoFactorScreen
import network.obsidian.mobile.ui.screens.WalletScreen

/**
 * The navigation graph, as data.
 *
 * Every route the app declares is registered by looping over this list, so a
 * route cannot exist in [Routes] and quietly render nothing: if it is not here it
 * is not registered, and [AppGraphTest] fails the build. That is the regression
 * this exists to catch — fifteen routes once had names and no screens.
 *
 * Each entry carries the real composable rather than a placeholder, which is what
 * lets the test assert content instead of merely counting strings.
 */
data class RouteEntry(
    val route: String,
    /** Human name, so a failure message says which screen is missing. */
    val screen: String,
    val content: @Composable (nav: NavHostController, repository: ObsidianRepository, store: ProfileStore) -> Unit,
)

object AppGraph {

    val entries: List<RouteEntry> = listOf(
        RouteEntry(Routes.SPLASH, "Splash") { nav, _, _ ->
            SplashScreen(
                onFinished = {
                    // replace, not navigate: back from the Landing must exit the
                    // app, not return to a splash the user has already left.
                    nav.navigate(Routes.LANDING) {
                        popUpTo(Routes.SPLASH) { inclusive = true }
                    }
                },
            )
        },
        RouteEntry(Routes.LANDING, "Landing") { nav, _, _ -> LandingScreen(navController = nav) },
        RouteEntry(Routes.MENU, "Menu") { nav, repo, _ ->
            MenuScreen(repository = repo, onNavigate = { nav.navigate(it) }, onBack = { nav.popBackStack() })
        },
        RouteEntry(Routes.SIGN_UP, "Sign Up") { nav, _, store ->
            SignUpScreen(
                store = store,
                onDone = { nav.navigate(Routes.ACCOUNT) },
                onBack = { nav.popBackStack() },
                onSignIn = { nav.navigate(Routes.SIGN_IN) },
            )
        },
        RouteEntry(Routes.SIGN_IN, "Sign In") { nav, _, store ->
            SignInScreen(
                store = store,
                onUnlock = { nav.navigate(Routes.ACCOUNT) },
                onBack = { nav.popBackStack() },
                onSignUp = { nav.navigate(Routes.SIGN_UP) },
            )
        },
        RouteEntry(Routes.TWO_FACTOR, "Device Lock") { nav, _, store ->
            TwoFactorScreen(store = store, onBack = { nav.popBackStack() })
        },
        RouteEntry(Routes.ACCOUNT_RECOVERY, "Account Recovery") { nav, _, store ->
            AccountRecoveryScreen(
                store = store,
                onBack = { nav.popBackStack() },
                onRecoverWallet = { nav.navigate(Routes.RECOVER_WALLET) },
            )
        },
        RouteEntry(Routes.CREATE_WALLET, "Create Wallet") { nav, _, store ->
            CreateWalletScreen(store = store, onDone = { nav.navigate(Routes.WALLET) }, onBack = { nav.popBackStack() })
        },
        RouteEntry(Routes.RECOVER_WALLET, "Recover Wallet") { nav, _, store ->
            RecoverWalletScreen(store = store, onDone = { nav.navigate(Routes.WALLET) }, onBack = { nav.popBackStack() })
        },
        RouteEntry(Routes.ACCOUNT, "Account") { nav, repo, store ->
            AccountScreen(
                store = store,
                repository = repo,
                onBack = { nav.popBackStack() },
                onWallet = { nav.navigate(Routes.WALLET) },
                onSecurity = { nav.navigate(Routes.TWO_FACTOR) },
                onEdgeNode = { nav.navigate(Routes.EDGE_NODE) },
                onSignIn = { nav.navigate(Routes.SIGN_IN) },
            )
        },
        RouteEntry(Routes.MINING, "Mining") { nav, repo, store ->
            MiningScreen(store = store, repository = repo, onBack = { nav.popBackStack() }, onActive = { nav.navigate(Routes.MINING_ACTIVE) })
        },
        RouteEntry(Routes.MINING_ACTIVE, "Mining Status") { nav, repo, _ ->
            MiningActiveScreen(repository = repo, onBack = { nav.popBackStack() })
        },
        RouteEntry(Routes.WALLET, "Wallet") { nav, repo, store ->
            WalletScreen(
                store = store,
                repository = repo,
                onBack = { nav.popBackStack() },
                onCreateWallet = { nav.navigate(Routes.CREATE_WALLET) },
            )
        },
        RouteEntry(Routes.EXPLORER, "Explorer") { nav, repo, _ ->
            ExplorerScreen(repository = repo, onBack = { nav.popBackStack() })
        },
        RouteEntry(Routes.ONS, "Obsidian Name Service") { nav, repo, _ ->
            OnsScreen(repository = repo, onBack = { nav.popBackStack() })
        },
        RouteEntry(Routes.EDGE_NODE, "Edge Node") { nav, repo, _ ->
            // Collected, not read: StateFlow.value inside composition does not
            // subscribe, so the screen would keep showing the node it opened with
            // even after the user pointed the app at another one.
            val nodeUrl by repo.nodeUrl.collectAsState()
            EdgeNodeScreen(nodeUrl = nodeUrl, onBack = { nav.popBackStack() })
        },
        RouteEntry(Routes.SETTINGS, "Settings") { nav, repo, _ ->
            SettingsScreen(repository = repo, onBack = { nav.popBackStack() })
        },
    )

    /** Every declared route, so the graph can be checked against [Routes] itself. */
    fun routeFor(route: String): RouteEntry? = entries.firstOrNull { it.route == route }
}
