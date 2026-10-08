package network.obsidian.mobile.remote

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Wire models for the Obsidian node HTTP API.
 *
 * Every field here mirrors a field the node actually returns — see
 * obsidian-core/src/rpc/server.ts (`health`, `status`, `supply`). Nothing is
 * invented to make a screen look complete: where the design shows a value the
 * API does not expose, the screen says so instead of displaying a number.
 *
 * Decoding is lenient on purpose (`ignoreUnknownKeys`, nullable with defaults)
 * so a node adding a field never breaks an installed app. The reverse is not
 * true and is not attempted: the app never sends a field the node does not
 * define.
 */

@Serializable
data class HealthResponse(
    val status: String = "",
    val coreVersion: String = "",
    val protocolVersion: String = "",
    val minCoreVersion: String = "",
    val network: String = "",
    val networkId: String = "",
    val chainId: Int = 0,
    val genesisId: String = "",
    val paramsHash: String = "",
    val height: Long = 0,
    val headHash: String = "",
    val peers: Int = 0,
    val syncing: Boolean = false,
    val supplyOk: Boolean? = null,
    val supplyProblem: String? = null,
)

@Serializable
data class MempoolSummary(val transactions: Int = 0, val bytes: Long = 0)

@Serializable
data class GenesisSummary(
    val allocationClaimed: Boolean = false,
    val recipient: String = "",
    val treasuryWallet: String = "",
    val allocationObs: String = "",
    val claimedAtHeight: Long? = null,
)

@Serializable
data class StatusMetrics(
    val accounts: Long = 0,
    val transactions: Long = 0,
    val miningClaims: Long = 0,
    val names: Long = 0,
    val treasuryRevenue: String = "",
)

@Serializable
data class PoolSummary(
    val balance: String = "",
    val lifetimeInflow: String = "",
    val lifetimeDistributed: String = "",
    val settledClaims: Long = 0,
)

@Serializable
data class StatusResponse(
    val height: Long = 0,
    val headHash: String = "",
    val genesisHash: String = "",
    val genesisId: String = "",
    val networkId: String = "",
    val chainId: Int = 0,
    val protocolVersion: String = "",
    val paramsHash: String = "",
    val totalBlocks: Long = 0,
    val diskBytes: Long = 0,
    val mempool: MempoolSummary = MempoolSummary(),
    val peers: Int = 0,
    val syncing: Boolean = false,
    val supply: String = "",
    val activeMiners: Int = 0,
    val genesisAllocationClaimed: Boolean = false,
    val validators: Int = 0,
    val supplyObs: String = "",
    val maxSupplyObs: String = "",
    val supplyPercentUsed: Double = 0.0,
    val genesis: GenesisSummary = GenesisSummary(),
    val metrics: StatusMetrics = StatusMetrics(),
    val pool: PoolSummary = PoolSummary(),
)

/**
 * GET /supply. The protocol's own supply vocabulary: total minted, the maximum,
 * what mining has issued, what genesis issued, what is locked in validator
 * bonds and what sits in the reward pool. "Circulating" is NOT a field — the
 * protocol does not define it, so the app must not present a number under that
 * label as though the chain had produced one.
 */
@Serializable
data class SupplyResponse(
    val totalSupplyObs: String = "",
    val totalSupplySeals: String = "",
    val maxSupplyObs: String = "",
    val maximumRespected: Boolean = false,
    val invariantOk: Boolean = false,
    val invariantProblem: String? = null,
    val genesisIssuedObs: String = "",
    val minedSupplyObs: String = "",
    val validatorBonds: String = "",
    val poolBalanceObs: String = "",
    val issuanceSources: List<String> = emptyList(),
)

@Serializable
data class PeerSummary(
    val nodeId: String = "",
    val address: String = "",
    val height: Long = 0,
    val inbound: Boolean = false,
    val connected: Boolean = false,
)

@Serializable
data class BalanceResponse(
    val address: String = "",
    val balanceObs: String = "",
    val nonce: Long = 0,
    val bondedObs: String? = null,
)

/**
 * The result of a JSON-RPC call. The node returns either `result` or `error`;
 * both are modelled so a failure is a value the UI can render, never a silent
 * success.
 */
@Serializable
data class RpcResponse(
    val ok: Boolean? = null,
    val result: kotlinx.serialization.json.JsonElement? = null,
    val error: String? = null,
    val code: String? = null,
)

@Serializable
data class RpcRequest(
    val method: String,
    val params: Map<String, kotlinx.serialization.json.JsonElement> = emptyMap(),
    val id: String = "1",
)
