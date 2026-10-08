package network.obsidian.mobile

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import network.obsidian.mobile.remote.ChainLink
import network.obsidian.mobile.remote.HealthResponse
import network.obsidian.mobile.remote.ObsidianApi
import network.obsidian.mobile.remote.ObsidianRepository
import network.obsidian.mobile.remote.StatusResponse
import network.obsidian.mobile.remote.SupplyResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The repository's state transitions, driven against a fake node.
 *
 * Every screen renders from [ChainLink], so these transitions are the difference
 * between an app that shows an error and one that shows a stale height as though
 * it were current. Each test asserts the state it reached, not that a call ran.
 */
class RepositoryStateTest {

    private class FakeApi(
        var health: Result<HealthResponse>,
        var status: Result<StatusResponse> = Result.success(StatusResponse(height = 100)),
        var supply: Result<SupplyResponse> = Result.success(SupplyResponse(totalSupplyObs = "1")),
    ) : ObsidianApi("http://test.local") {
        override suspend fun health() = health
        override suspend fun status() = status
        override suspend fun supply() = supply
    }

    private val okHealth = Result.success(
        HealthResponse(status = "ok", height = 1_284_906, headHash = "abc", network = "mainnet", peers = 4),
    )

    private fun repository(scope: CoroutineScope, api: ObsidianApi) =
        ObsidianRepository(scope = scope, apiFactory = { api })

    @Test
    fun `the initial state is offline, never a guess`() = runTest {
        val repo = repository(this, FakeApi(okHealth))
        assertEquals(ChainLink.Offline, repo.link.value)
    }

    @Test
    fun `a successful fetch becomes online carrying the node's own values`() = runTest {
        val repo = repository(this, FakeApi(okHealth, Result.success(StatusResponse(height = 1_284_906))))
        repo.refresh()

        val link = repo.link.value as ChainLink.Online
        assertEquals(1_284_906L, link.health.height)
        assertEquals(1_284_906L, link.status.height)
        assertEquals("mainnet", link.health.network)
        assertTrue(link.fetchedAtEpochMillis > 0)
    }

    @Test
    fun `a failed supply endpoint does not make the node look offline`() = runTest {
        val api = FakeApi(okHealth, supply = Result.failure(RuntimeException("no supply")))
        val repo = repository(this, api)
        repo.refresh()

        val link = repo.link.value as ChainLink.Online
        assertNull("height is still true without supply", link.supply)
        assertEquals(1_284_906L, link.health.height)
    }

    @Test
    fun `losing the node after a success degrades and keeps the last values`() = runTest {
        val api = FakeApi(okHealth)
        val repo = repository(this, api)
        repo.refresh()
        assertTrue(repo.link.value is ChainLink.Online)

        api.health = Result.failure(java.io.IOException("connection refused"))
        repo.refresh()

        val degraded = repo.link.value as ChainLink.Degraded
        assertEquals(1_284_906L, degraded.last.health.height)
        assertTrue(degraded.reason.contains("connection refused"))
    }

    @Test
    fun `a node that never answered stays offline rather than degraded`() = runTest {
        val api = FakeApi(Result.failure(java.io.IOException("unreachable")))
        val repo = repository(this, api)
        repo.refresh()
        repo.refresh()

        assertEquals(ChainLink.Offline, repo.link.value)
    }

    @Test
    fun `repeated failure keeps one degraded state instead of stacking`() = runTest {
        val api = FakeApi(okHealth)
        val repo = repository(this, api)
        repo.refresh()

        api.health = Result.failure(java.io.IOException("timeout"))
        repeat(5) { repo.refresh() }

        val degraded = repo.link.value as ChainLink.Degraded
        assertEquals("timeout", degraded.reason)
    }

    @Test
    fun `recovery replaces a degraded state with fresh values`() = runTest {
        val api = FakeApi(okHealth)
        val repo = repository(this, api)
        repo.refresh()
        api.health = Result.failure(java.io.IOException("timeout"))
        repo.refresh()
        assertTrue(repo.link.value is ChainLink.Degraded)

        api.health = Result.success(okHealth.getOrThrow().copy(height = 1_284_999))
        repo.refresh()

        val link = repo.link.value as ChainLink.Online
        assertEquals(1_284_999L, link.health.height)
    }

    @Test
    fun `changing the node drops back to offline so stale data is not reused`() = runTest {
        val api = FakeApi(okHealth)
        val repo = repository(this, api)
        repo.refresh()
        assertTrue(repo.link.value is ChainLink.Online)

        repo.setNodeUrl("http://another-node.local:8630")

        assertEquals(ChainLink.Offline, repo.link.value)
        assertEquals("http://another-node.local:8630", repo.nodeUrl.value)
    }

    @Test
    fun `an empty node url falls back to the default instead of breaking the client`() = runTest {
        val repo = repository(this, FakeApi(okHealth))
        repo.setNodeUrl("   ")
        assertEquals(ObsidianRepository.DEFAULT_NODE_URL, repo.nodeUrl.value)
    }

    @Test
    fun `setting the same url twice does not reset a working connection`() = runTest {
        val api = FakeApi(okHealth)
        val repo = repository(this, api)
        repo.refresh()

        repo.setNodeUrl(repo.nodeUrl.value)

        assertTrue("a no-op change must not discard live data", repo.link.value is ChainLink.Online)
    }

    @Test
    fun `the poll interval is long enough to be kind to a battery`() {
        // A regression guard on the one number that decides how hard the app
        // works the radio.
        assertTrue(ObsidianRepository.DEFAULT_POLL_MILLIS >= 10_000L)
    }
}
