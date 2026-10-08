package network.obsidian.mobile

import java.lang.reflect.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Navigation completeness.
 *
 * The bug this catches is the one that actually happened: sixteen routes were
 * declared in [Routes] and only one had a composable, so fifteen destinations
 * resolved to nothing. A test that merely checked the route strings existed would
 * have passed throughout.
 *
 * Registration is generated from [AppGraph], so a route absent from the graph is
 * genuinely absent from the app — and these assertions read the graph rather than
 * a hand-maintained list, so they cannot drift out of step with it.
 */
class AppGraphTest {

    /** Every route the app declares, read from the source of truth by reflection. */
    private val declaredRoutes: List<Pair<String, String>> =
        Routes::class.java.declaredFields
            .filter { Modifier.isStatic(it.modifiers) && it.type == String::class.java }
            .map { it.name to (it.get(null) as String) }

    private val registered = AppGraph.entries.map { it.route }

    @Test
    fun `the app declares exactly the routes it is specified to have`() {
        // Seventeen: the sixteen product screens plus the launch splash, which is
        // a real destination with a real composable, not a theme.
        assertEquals(
            "route list changed; update the graph and this expectation together",
            17,
            declaredRoutes.size,
        )
    }

    @Test
    fun `every declared route has a screen registered`() {
        declaredRoutes.forEach { (name, route) ->
            assertTrue(
                "Routes.$name (\"$route\") has no registered composable — it would render nothing",
                registered.contains(route),
            )
        }
    }

    @Test
    fun `no route is registered twice, which would shadow a destination`() {
        val duplicates = registered.groupingBy { it }.eachCount().filter { it.value > 1 }.keys
        assertTrue("duplicate registrations: $duplicates", duplicates.isEmpty())
    }

    @Test
    fun `every registered route is one the app actually declares`() {
        val declared = declaredRoutes.map { it.second }.toSet()
        registered.forEach { route ->
            assertTrue("graph registers undeclared route \"$route\"", declared.contains(route))
        }
    }

    @Test
    fun `every entry carries real content and a name, not a placeholder`() {
        AppGraph.entries.forEach { entry ->
            assertNotNull("${entry.route} has no content lambda", entry.content)
            assertTrue("${entry.route} has a blank screen name", entry.screen.isNotBlank())
            // A placeholder screen is how a blank route hides. Naming the real
            // screen means a failure message says which one is missing.
            assertTrue(
                "${entry.route} looks like a placeholder screen name",
                !entry.screen.lowercase().let { it.contains("todo") || it.contains("coming soon") || it.contains("placeholder") },
            )
        }
    }

    @Test
    fun `the graph covers the whole declared set, in both directions`() {
        assertEquals(declaredRoutes.map { it.second }.toSet(), registered.toSet())
    }

    @Test
    fun `the start destination is registered`() {
        assertTrue(
            "the app would open on an unregistered route",
            registered.contains(Routes.LANDING),
        )
    }
}
