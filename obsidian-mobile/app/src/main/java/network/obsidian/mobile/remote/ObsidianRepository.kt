package network.obsidian.mobile.remote

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the app knows about its connection to the network right now. */
sealed interface ChainLink {
    /** No successful contact yet, or contact was lost. */
    data object Offline : ChainLink

    /** Contacted a node; carrying the values the node actually reported. */
    data class Online(
        val health: HealthResponse,
        val status: StatusResponse,
        val supply: SupplyResponse?,
        val fetchedAtEpochMillis: Long,
    ) : ChainLink

    /** Contact failed after at least one success: stale data may still be shown,
     *  but never presented as current. */
    data class Degraded(val last: Online, val reason: String) : ChainLink
}

/**
 * The single place the app talks to the chain.
 *
 * One poller, one interval, one source of truth for every screen. Requirement 32
 * is why this exists: screens do not poll on their own, so opening Explorer and
 * Wallet together is still one request cycle, not three.
 */
class ObsidianRepository(
    private val scope: CoroutineScope,
    private val apiFactory: (String) -> ObsidianApi = { ObsidianApi(it) },
    private val platformFactory: (String) -> PlatformApi = { PlatformApi(it) },
) {
    private val _nodeUrl = MutableStateFlow(DEFAULT_NODE_URL)
    val nodeUrl: StateFlow<String> = _nodeUrl.asStateFlow()

    /**
     * The Obsidian Web platform, which is the app's one API surface.
     *
     * Accounts, invitations, MFA, recovery and wallet linking live here, and so does
     * the node's RPC behind `/api/rpc`. The node URL below is kept because the
     * platform's own REST views (`/health`, `/status`, `/supply`) are read straight
     * from the node it points at; both are settable so a self-hosted deployment can
     * be reached without rebuilding.
     */
    private val _platformUrl = MutableStateFlow(DEFAULT_PLATFORM_URL)
    val platformUrl: StateFlow<String> = _platformUrl.asStateFlow()

    private var platformClient: PlatformApi = platformFactory(_platformUrl.value)

    /** The platform client for the configured origin. One origin, one cookie jar. */
    val platform: PlatformApi get() = platformClient

    private val _link = MutableStateFlow<ChainLink>(ChainLink.Offline)
    val link: StateFlow<ChainLink> = _link.asStateFlow()

    private var pollJob: Job? = null

    val api: ObsidianApi get() = apiFactory(_nodeUrl.value)

    /** Points the app at a different platform origin. Rebuilds the client so the
     *  old session cookie is not carried across origins. */
    fun setPlatformUrl(url: String) {
        val trimmed = url.trim().ifEmpty { DEFAULT_PLATFORM_URL }
        if (trimmed == _platformUrl.value) return
        _platformUrl.value = trimmed
        platformClient = platformFactory(trimmed)
    }

    fun setNodeUrl(url: String) {
        val trimmed = url.trim().ifEmpty { DEFAULT_NODE_URL }
        if (trimmed == _nodeUrl.value) return
        _nodeUrl.value = trimmed
        _link.value = ChainLink.Offline
        startPolling()
    }

    /** Begin the refresh cycle. Idempotent: calling it twice does not double-poll. */
    fun startPolling(intervalMillis: Long = DEFAULT_POLL_MILLIS) {
        if (pollJob?.isActive == true) return
        pollJob = scope.launch {
            while (isActive) {
                refresh()
                delay(intervalMillis)
            }
        }
    }

    fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    /** One fetch cycle. Public so a pull-to-refresh or a Retry button can call it. */
    suspend fun refresh() {
        val result = withContext(Dispatchers.IO) {
            val client = api
            val health = client.health()
            if (health.isFailure) {
                Result.failure<ChainLink.Online>(health.exceptionOrNull() ?: ApiFailure("unreachable"))
            } else {
                val status = client.status()
                if (status.isFailure) {
                    Result.failure<ChainLink.Online>(status.exceptionOrNull() ?: ApiFailure("no status"))
                } else {
                    // /supply is allowed to fail without making the node look
                    // offline: height and head are still true without it, and the
                    // screens that need supply say so individually.
                    val supply = client.supply().getOrNull()
                    Result.success(
                        ChainLink.Online(
                            health = health.getOrThrow(),
                            status = status.getOrThrow(),
                            supply = supply,
                            fetchedAtEpochMillis = System.currentTimeMillis(),
                        ),
                    )
                }
            }
        }

        result.fold(
            onSuccess = { _link.value = it },
            onFailure = { error ->
                val current = _link.value
                _link.value = when (current) {
                    is ChainLink.Online -> ChainLink.Degraded(current, error.message ?: "unreachable")
                    is ChainLink.Degraded -> current
                    ChainLink.Offline -> ChainLink.Offline
                }
            },
        )
    }

    companion object {
        /** A node on the device's own network by default; changeable in Settings. */
        const val DEFAULT_NODE_URL = "http://127.0.0.1:8630"

        /** The Obsidian Web platform. Overridden in settings for a self-hosted
         *  deployment; there is no public hosted origin to default to, so this is
         *  the local interface server. */
        const val DEFAULT_PLATFORM_URL = "http://127.0.0.1:8787"

        /** 20s. Long enough to be kind to a phone battery, short enough that the
         *  height on screen is not a lie for long. */
        const val DEFAULT_POLL_MILLIS = 20_000L
    }
}
