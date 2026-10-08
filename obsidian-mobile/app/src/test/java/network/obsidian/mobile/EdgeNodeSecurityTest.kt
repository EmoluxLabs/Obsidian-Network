package network.obsidian.mobile

import java.math.BigDecimal
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import network.obsidian.mobile.edgenode.EdgeNodeAuthority
import network.obsidian.mobile.edgenode.EdgeNodeController
import network.obsidian.mobile.edgenode.EdgeNodeLink
import network.obsidian.mobile.edgenode.EdgeNodePhase
import network.obsidian.mobile.edgenode.EdgeNodeState
import network.obsidian.mobile.edgenode.HeadReport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Edge Node security tests A–H.
 *
 * These drive the real [EdgeNodeController] — the same state machine the service
 * runs — against a link that can lie, disappear and come back. Nothing here
 * asserts a constant: each test observes what the controller actually did.
 *
 * The authority tests are the important ones. [EdgeNodeAuthority.forBonded] is
 * the same arithmetic the protocol uses for a bonded validator, so a zero for the
 * Edge Node is a computed result. Test E proves the arithmetic is live by
 * showing that a 20,000 OBS bond does produce a vote — which is exactly why the
 * Edge Node's zero is not decorative.
 */
class EdgeNodeSecurityTest {

    /** A node the test controls: connectivity, the head it reports, and a log of
     *  every request, so a test can prove participation stopped rather than
     *  merely asserting a flag. */
    private class FakeLink(
        private val connectivity: MutableStateFlow<Boolean> = MutableStateFlow(true),
        private val head: MutableStateFlow<Result<HeadReport>> = MutableStateFlow(Result.success(validHead())),
    ) : EdgeNodeLink {
        var requests = 0
            private set

        override suspend fun hasConnectivity(): Boolean = connectivity.value

        override suspend fun fetchHead(): Result<HeadReport> {
            requests++
            return head.value
        }

        fun setConnectivity(up: Boolean) {
            connectivity.value = up
        }

        fun setHead(result: Result<HeadReport>) {
            head.value = result
        }
    }

    private fun validHead(height: Long = 1_284_906) = HeadReport(
        height = height,
        headHash = "74e7dee44e8b579ac3048a716a480311bcd858b1740a1b6f99f1cda6b33dace3",
        genesisId = "56ec455d8afac5ef4f7d636ac03ef9e39bd5788f",
        peers = 4,
        syncing = false,
        protocolVersion = "1.6.1",
        network = "mainnet",
    )

    /** A controller that publishes nowhere, so tests do not touch process state. */
    private fun controller(link: EdgeNodeLink) = EdgeNodeController(link, publish = {})

    // ── TEST A — Edge Node Enabled ───────────────────────────────────────────

    @Test
    fun `A - enabling starts the node and it participates`() = runTest {
        val link = FakeLink()
        val node = controller(link)

        assertEquals(EdgeNodePhase.Stopped, node.phase)
        assertFalse(node.participating.value)

        node.enable()

        assertEquals(EdgeNodePhase.Running, node.phase)
        assertTrue("the node must actually be exchanging data", node.participating.value)
        assertEquals(1L, node.blocksVerified.value)
        assertEquals(1, link.requests)
        val running = node.state.value as EdgeNodeState.Running
        assertEquals(1_284_906L, running.height)
        assertEquals(4, running.peers)
    }

    // ── TEST B — Voting Power ────────────────────────────────────────────────

    @Test
    fun `B - voting power stays zero while running`() = runTest {
        val node = controller(FakeLink())
        node.enable()
        repeat(25) { node.cycle() }

        val authority = node.authority()
        assertEquals("an Edge Node must never hold voting power", 0, authority.votingPower)
        assertEquals(0, authority.governanceVotes)
        assertEquals(0, BigDecimal.ZERO.compareTo(authority.consensusWeight))
        assertFalse(authority.canProduceBlocks)
        assertFalse(authority.canFinalize)
        assertFalse(authority.isConsensusParticipant)
    }

    @Test
    fun `B - the authority arithmetic is live, not a hardcoded zero`() {
        // The same computation with a real validator bond yields a real vote.
        // If this ever returned zero the Edge Node's zero would prove nothing.
        val bonded = EdgeNodeAuthority.forBonded(
            bondedObs = EdgeNodeAuthority.BOND_PER_VALIDATOR_OBS,
            holdsWalletKeys = true,
        )
        assertEquals(1, bonded.votingPower)
        assertTrue(bonded.canProduceBlocks)
        assertTrue(bonded.isConsensusParticipant)

        // Below the bond threshold, still no vote: weight is not sold in fractions.
        assertEquals(
            0,
            EdgeNodeAuthority.forBonded(BigDecimal("19999"), holdsWalletKeys = true).votingPower,
        )
    }

    // ── TEST C — Rewards ─────────────────────────────────────────────────────

    @Test
    fun `C - the Edge Node earns nothing for running`() = runTest {
        val node = controller(FakeLink())
        node.enable()
        repeat(500) { node.cycle() }

        assertEquals(501L, node.blocksVerified.value)
        assertEquals(
            "uptime must never be rewarded",
            0,
            BigDecimal.ZERO.compareTo(node.authority().nodeRunnerRewardsObs),
        )
    }

    // ── TEST D — Wallet Security ─────────────────────────────────────────────

    @Test
    fun `D - the Edge Node cannot be given a wallet secret`() {
        // Structural: the controller's constructor and fields are inspected, so a
        // future parameter or field carrying key material fails this test rather
        // than shipping. enable() takes no argument at all — there is no call site
        // at which a seed phrase could be handed over.
        val forbidden = Regex("privatekey|seedphrase|seed|mnemonic|passphrase|secret", RegexOption.IGNORE_CASE)

        val ctorParams = EdgeNodeController::class.constructors
            .flatMap { it.parameters.asSequence() }
            .map { it.name.orEmpty() }
        assertTrue(
            "a constructor parameter looks like key material: $ctorParams",
            ctorParams.none { forbidden.containsMatchIn(it) },
        )

        val fields = EdgeNodeController::class.java.declaredFields.map { it.name }
        assertTrue("a field looks like key material: $fields", fields.none { forbidden.containsMatchIn(it) })

        assertEquals("enable() must take no credential", 0, EdgeNodeController::class.members
            .first { it.name == "enable" }.parameters.count { it.name != null })
    }

    @Test
    fun `D - starting the node requires no secret`() = runTest {
        // The only way to start an Edge Node is with a node URL.
        val node = controller(FakeLink())
        node.enable()
        assertEquals(EdgeNodePhase.Running, node.phase)
    }

    // ── TEST E — Sybil Resistance ────────────────────────────────────────────

    @Test
    fun `E - ten thousand Edge Nodes hold no more authority than one`() {
        val one = EdgeNodeAuthority.aggregateEdgeNodes(1)
        val many = EdgeNodeAuthority.aggregateEdgeNodes(10_000)

        assertEquals(one.votingPower, many.votingPower)
        assertEquals(0, one.consensusWeight.compareTo(many.consensusWeight))
        assertEquals(0, one.nodeRunnerRewardsObs.compareTo(many.nodeRunnerRewardsObs))
        assertEquals(one.canProduceBlocks, many.canProduceBlocks)
        assertEquals(one.canFinalize, many.canFinalize)
        assertFalse(many.isConsensusParticipant)
    }

    @Test
    fun `E - running many nodes never produces a consensus participant`() = runTest {
        val nodes = List(1_000) { controller(FakeLink()) }
        nodes.forEach { it.enable() }

        // Every one is genuinely running and exchanging data…
        assertTrue(nodes.all { it.participating.value })
        assertEquals(1_000L, nodes.sumOf { it.blocksVerified.value })
        // …and not one of them can influence consensus.
        assertTrue(nodes.none { it.authority().isConsensusParticipant })
        assertEquals(0, nodes.sumOf { it.authority().votingPower })
    }

    // ── TEST F — Disable ─────────────────────────────────────────────────────

    @Test
    fun `F - disabling stops participation and the state says so`() = runTest {
        val link = FakeLink()
        val node = controller(link)
        node.enable()
        assertTrue(node.participating.value)
        val requestsWhileOn = link.requests

        node.disable()

        assertEquals(EdgeNodePhase.Stopped, node.phase)
        assertFalse(node.enabled.value)
        assertFalse(node.participating.value)
        assertEquals(EdgeNodeState.Stopped, node.state.value)

        // A disabled node does nothing on a cycle — this is what proves it stopped
        // rather than merely reporting that it had.
        node.cycle()
        assertEquals(requestsWhileOn, link.requests)
        assertEquals(EdgeNodePhase.Stopped, node.phase)
    }

    // ── TEST G — Network Loss ────────────────────────────────────────────────

    @Test
    fun `G - losing connectivity goes offline without crashing`() = runTest {
        val link = FakeLink()
        val node = controller(link)
        node.enable()
        assertEquals(EdgeNodePhase.Running, node.phase)

        link.setConnectivity(up = false)
        node.cycle()

        assertEquals(EdgeNodePhase.Offline, node.phase)
        assertEquals(EdgeNodeState.Offline, node.state.value)
        assertFalse("an offline node is not participating", node.participating.value)
        assertTrue("it is still enabled, so it can resume", node.enabled.value)
        // Verification counters are not corrupted by going offline.
        assertEquals(1L, node.blocksVerified.value)
    }

    @Test
    fun `G - an unreachable node is reported offline, not as invalid data`() = runTest {
        val link = FakeLink(head = MutableStateFlow(Result.failure(java.io.IOException("connection refused"))))
        val node = controller(link)
        node.enable()

        assertEquals(EdgeNodePhase.Offline, node.phase)
        assertEquals(0L, node.headsRejected.value)
    }

    // ── TEST H — Network Recovery ────────────────────────────────────────────

    @Test
    fun `H - the node resumes by itself when connectivity returns`() = runTest {
        val link = FakeLink()
        val node = controller(link)
        node.enable()

        link.setConnectivity(up = false)
        node.cycle()
        assertEquals(EdgeNodePhase.Offline, node.phase)

        link.setConnectivity(up = true)
        node.cycle()

        assertEquals(EdgeNodePhase.Running, node.phase)
        assertTrue(node.participating.value)
        assertEquals(2L, node.blocksVerified.value)
    }

    // ── Verification of received data ────────────────────────────────────────

    @Test
    fun `a head that fails verification is rejected and never counted as progress`() = runTest {
        val link = FakeLink(head = MutableStateFlow(Result.success(validHead().copy(headHash = ""))))
        val node = controller(link)
        node.enable()

        assertEquals(EdgeNodePhase.Rejected, node.phase)
        assertEquals(0L, node.blocksVerified.value)
        assertEquals(1L, node.headsRejected.value)
        assertFalse(node.participating.value)
    }

    @Test
    fun `the verification rule catches every malformed field`() {
        val good = validHead()
        assertNull(EdgeNodeController.verify(good))
        assertTrue(EdgeNodeController.verify(good.copy(height = -1))!!.contains("height"))
        assertTrue(EdgeNodeController.verify(good.copy(headHash = " "))!!.contains("head hash"))
        assertTrue(EdgeNodeController.verify(good.copy(genesisId = ""))!!.contains("genesis"))
        assertTrue(EdgeNodeController.verify(good.copy(protocolVersion = ""))!!.contains("protocol"))
        assertTrue(EdgeNodeController.verify(good.copy(peers = -3))!!.contains("peer"))
    }
}
