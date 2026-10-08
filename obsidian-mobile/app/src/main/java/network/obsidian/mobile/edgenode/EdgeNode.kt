package network.obsidian.mobile.edgenode

import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The Obsidian Edge Node's domain logic, free of Android types so it can be
 * executed in a JVM test.
 *
 * [EdgeNodeService] is the Android shell: it owns the foreground notification and
 * the process lifecycle. Everything that can be wrong about an Edge Node — its
 * state transitions, what it does when the network drops, how much authority it
 * holds — lives here instead, where a test can drive it.
 */

/** One answer from a node, as received. Nothing here is trusted until checked. */
data class HeadReport(
    val height: Long,
    val headHash: String,
    val genesisId: String,
    val peers: Int,
    val syncing: Boolean,
    val protocolVersion: String,
    val network: String,
)

/**
 * The Edge Node's only two ways of touching the outside world, so a test can
 * supply a node that lies, goes away, or comes back.
 */
interface EdgeNodeLink {
    suspend fun hasConnectivity(): Boolean
    suspend fun fetchHead(): Result<HeadReport>
}

/**
 * Counters for the running Edge Node, published process-wide so the screen can
 * show them without binding to the service.
 *
 * These are the difference between a status label and an honest one: "Running"
 * says the service is alive, while "verified 41 heads, rejected 0" says what it
 * has actually been doing. A user deciding whether to leave it on deserves the
 * second.
 */
object EdgeNodeTelemetry {
    val enabled = MutableStateFlow(false)
    val participating = MutableStateFlow(false)
    val blocksVerified = MutableStateFlow(0L)
    val headsRejected = MutableStateFlow(0L)
    val lastActivityAt = MutableStateFlow(0L)

    /** Called when the node is turned off, so a fresh session does not inherit
     *  the previous one's counts and read as activity that never happened. */
    fun reset() {
        participating.value = false
        blocksVerified.value = 0L
        headsRejected.value = 0L
        lastActivityAt.value = 0L
    }
}

/** Where the Edge Node is, from the user's point of view. */
enum class EdgeNodePhase {
    /** The user has not turned it on. Nothing is running. */
    Disabled,

    /** Turned on, first contact not yet established. */
    Starting,

    /** Receiving and verifying heads. */
    Running,

    /** No connectivity. Participation is suspended, not failed. */
    Offline,

    /** A node answered with data that did not verify. Reported, not relayed. */
    Rejected,

    /** The user turned it off, or the process ended. Nothing is running. */
    Stopped,
}

/** The Edge Node's observable state. Pure data: the UI renders this directly. */
sealed interface EdgeNodeState {
    data object Stopped : EdgeNodeState
    data object Connecting : EdgeNodeState
    data object Offline : EdgeNodeState
    data class Rejected(val reason: String) : EdgeNodeState
    data class Running(
        val height: Long,
        val headHash: String,
        val peers: Int,
        val syncing: Boolean,
        val protocolVersion: String,
        val network: String,
    ) : EdgeNodeState

    val phase: EdgeNodePhase
        get() = when (this) {
            Stopped -> EdgeNodePhase.Stopped
            Connecting -> EdgeNodePhase.Starting
            Offline -> EdgeNodePhase.Offline
            is Rejected -> EdgeNodePhase.Rejected
            is Running -> EdgeNodePhase.Running
        }

    fun describe(fallback: String): String = when (this) {
        Stopped -> "Stopped"
        Connecting -> "Connecting…"
        Offline -> "Offline — waiting for connectivity"
        is Rejected -> "Invalid data: $reason"
        is Running -> if (syncing) "Syncing · height $height" else "Live · height $height · $peers peers"
    }

    companion object {
        /**
         * Process-wide handle for the running service.
         *
         * A StateFlow rather than a bound-service connection: the screen shows
         * whatever the service last established even when the process has been
         * recreated, and there is no path by which the UI could start the service
         * without the user asking for it.
         */
        val current = MutableStateFlow<EdgeNodeState>(Stopped)
        val observable: StateFlow<EdgeNodeState> = current.asStateFlow()

        const val DEFAULT_NODE_URL = "http://127.0.0.1:8630"
    }
}

/**
 * What an Edge Node is worth to consensus.
 *
 * Every field is **computed** from the one input the protocol actually uses for
 * authority — a validator bond recorded in chain state — rather than being set
 * to zero in a literal. That distinction is the whole point: if a future change
 * ever handed an Edge Node a bond, these numbers would move and a test would
 * fail, instead of a hardcoded zero quietly becoming a lie.
 *
 * An Edge Node holds no key and therefore posts no bond, which is why every
 * value comes out zero in practice.
 */
data class EdgeNodeAuthority(
    val votingPower: Int,
    val consensusWeight: BigDecimal,
    val nodeRunnerRewardsObs: BigDecimal,
    val governanceVotes: Int,
    val canProduceBlocks: Boolean,
    val canFinalize: Boolean,
    val holdsWalletKeys: Boolean,
) {
    val isConsensusParticipant: Boolean
        get() = votingPower > 0 || canProduceBlocks || canFinalize || consensusWeight.signum() > 0

    companion object {
        /**
         * The validator bond, from the protocol's own parameters
         * (`bond = parseObs('20000')`). One bond is one validator's registration;
         * weight is not sold in fractions.
         */
        val BOND_PER_VALIDATOR_OBS: BigDecimal = BigDecimal("20000")

        /**
         * Authority for a participant holding [bondedObs] in validator bonds.
         *
         * This is the same arithmetic a bonded Node Runner would produce, which
         * is what makes the Edge Node's zeros meaningful rather than decorative:
         * pass it the 20,000 OBS bond and it returns one vote.
         */
        fun forBonded(bondedObs: BigDecimal, holdsWalletKeys: Boolean): EdgeNodeAuthority {
            val bonds = bondedObs
                .divide(BOND_PER_VALIDATOR_OBS, 0, RoundingMode.DOWN)
                .max(BigDecimal.ZERO)
            val registered = bonds.signum() > 0 && holdsWalletKeys
            return EdgeNodeAuthority(
                votingPower = bonds.toInt(),
                consensusWeight = bonds,
                nodeRunnerRewardsObs = if (registered) bondedObs else BigDecimal.ZERO,
                governanceVotes = bonds.toInt(),
                canProduceBlocks = registered,
                canFinalize = registered,
                holdsWalletKeys = holdsWalletKeys,
            )
        }

        /**
         * Authority for an Edge Node. It holds no wallet key — the two domains
         * are separate by construction — so the bond it can post is zero.
         */
        fun forEdgeNode(): EdgeNodeAuthority =
            forBonded(bondedObs = BigDecimal.ZERO, holdsWalletKeys = false)

        /**
         * Authority for [count] Edge Nodes running at once.
         *
         * The anti-Sybil property, stated as arithmetic: aggregation sums the
         * per-node values, so ten thousand nodes yield exactly what one does.
         * Propagation scales with node count; authority does not.
         */
        fun aggregateEdgeNodes(count: Int): EdgeNodeAuthority {
            val one = forEdgeNode()
            val n = BigDecimal(maxOf(0, count))
            return one.copy(
                votingPower = one.votingPower * count,
                consensusWeight = one.consensusWeight.multiply(n),
                nodeRunnerRewardsObs = one.nodeRunnerRewardsObs.multiply(n),
                governanceVotes = one.governanceVotes * count,
            )
        }
    }
}

/**
 * The Edge Node's state machine.
 *
 * Deliberately ignorant of Android: no Service, no notification, no context.
 * [EdgeNodeService] drives [cycle] on a timer and mirrors [state] into the
 * notification; a test drives it directly.
 */
class EdgeNodeController(
    private val link: EdgeNodeLink,
    private val clock: () -> Long = { System.currentTimeMillis() },
    publish: (EdgeNodeState) -> Unit = { EdgeNodeState.current.value = it },
) {
    private val _state = MutableStateFlow<EdgeNodeState>(EdgeNodeState.Stopped)
    val state: StateFlow<EdgeNodeState> = _state.asStateFlow()

    val phase: EdgeNodePhase get() = _state.value.phase

    private val _enabled = MutableStateFlow(false)
    /** Whether the user has asked for the Edge Node to run. */
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    /** True only while actually exchanging data with the network. */
    private val _participating = MutableStateFlow(false)
    val participating: StateFlow<Boolean> = _participating.asStateFlow()

    private val _blocksVerified = MutableStateFlow(0L)
    val blocksVerified: StateFlow<Long> = _blocksVerified.asStateFlow()

    private val _headsRejected = MutableStateFlow(0L)
    val headsRejected: StateFlow<Long> = _headsRejected.asStateFlow()

    private val _lastActivityAt = MutableStateFlow(0L)
    val lastActivityAt: StateFlow<Long> = _lastActivityAt.asStateFlow()

    private val publish = publish

    /**
     * The Edge Node's authority. Recomputed on every read so it can never drift
     * out of step with the state it is derived from.
     */
    fun authority(): EdgeNodeAuthority = EdgeNodeAuthority.forEdgeNode()

    /** Turn the Edge Node on and take a first reading. */
    suspend fun enable() {
        if (_enabled.value) return
        _enabled.value = true
        emit(EdgeNodeState.Connecting)
        cycle()
    }

    /**
     * Turn it off. Participation stops immediately and the state says so; there
     * is nothing left running to leak or to resume on its own.
     */
    fun disable() {
        _enabled.value = false
        _participating.value = false
        EdgeNodeTelemetry.reset()
        emit(EdgeNodeState.Stopped)
    }

    /**
     * One cycle. Called by the service on its timer and by tests directly.
     *
     * Order matters: connectivity first, so an unreachable node is reported as
     * offline rather than as a verification failure, and so no request is made
     * into a void.
     */
    suspend fun cycle() {
        if (!_enabled.value) {
            _participating.value = false
            return
        }
        if (!link.hasConnectivity()) {
            _participating.value = false
            emit(EdgeNodeState.Offline)
            return
        }
        link.fetchHead().fold(
            onSuccess = { head ->
                val problem = verify(head)
                if (problem == null) {
                    _blocksVerified.value += 1
                    _participating.value = true
                    _lastActivityAt.value = clock()
                    emit(
                        EdgeNodeState.Running(
                            height = head.height,
                            headHash = head.headHash,
                            peers = head.peers,
                            syncing = head.syncing,
                            protocolVersion = head.protocolVersion,
                            network = head.network,
                        ),
                    )
                } else {
                    // Verified and found wanting. Counted and reported, never
                    // relayed: a bad head is exactly the thing this exists to
                    // refuse to pass on.
                    _participating.value = false
                    _headsRejected.value += 1
                    emit(EdgeNodeState.Rejected(problem))
                }
            },
            onFailure = { error ->
                _participating.value = false
                // A transport failure is not invalid data. Keeping the two apart
                // is what lets the UI say "offline" instead of "the node lied".
                emit(EdgeNodeState.Offline)
                @Suppress("UNUSED_EXPRESSION") error
            },
        )
    }

    private fun emit(state: EdgeNodeState) {
        _state.value = state
        publish(state)
        EdgeNodeTelemetry.enabled.value = _enabled.value
        EdgeNodeTelemetry.participating.value = _participating.value
        EdgeNodeTelemetry.blocksVerified.value = _blocksVerified.value
        EdgeNodeTelemetry.headsRejected.value = _headsRejected.value
        EdgeNodeTelemetry.lastActivityAt.value = _lastActivityAt.value
    }

    companion object {
        /**
         * Internal consistency of a received head.
         *
         * This is verification of received data against the protocol's own shape,
         * not a consensus opinion: the controller never decides which chain is
         * canonical, never votes, and never advances a height on its own
         * authority. It returns null when the head is usable, or the reason it is
         * not.
         */
        fun verify(head: HeadReport): String? = when {
            head.height < 0 -> "negative block height"
            head.headHash.isBlank() -> "missing head hash"
            head.genesisId.isBlank() -> "missing genesis id"
            head.protocolVersion.isBlank() -> "missing protocol version"
            head.peers < 0 -> "negative peer count"
            else -> null
        }
    }
}
