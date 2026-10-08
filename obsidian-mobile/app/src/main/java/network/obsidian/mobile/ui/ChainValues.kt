package network.obsidian.mobile.ui

import java.math.BigDecimal
import java.math.RoundingMode
import network.obsidian.mobile.remote.SupplyResponse

/**
 * Derived display values.
 *
 * The rule for every function here: it only ever combines numbers the chain
 * reported, using the protocol's own definitions. It never supplies a constant
 * that looks like chain state, and it never labels a value with a term the
 * protocol does not use.
 *
 * Notably there is no `circulating` value. The Obsidian protocol does not define
 * a circulating supply — it defines total minted, maximum, mined, genesis-issued,
 * bonded and pooled. Presenting `total - bonded - pooled` under the word
 * "circulating" would be inventing an economic definition, so the app shows the
 * protocol's own categories instead (requirement 7 and 29).
 */
object ChainValues {

    private fun decimal(raw: String?): BigDecimal? =
        raw?.takeIf { it.isNotBlank() }?.let { runCatching { BigDecimal(it) }.getOrNull() }

    /** Format an OBS amount with thousands separators, keeping real precision. */
    fun obs(raw: String?, decimals: Int = 2): String {
        val value = decimal(raw) ?: return "—"
        val scaled = value.setScale(decimals, RoundingMode.DOWN)
        val parts = scaled.toPlainString().split('.')
        val whole = parts[0].reversed().chunked(3).joinToString(",").reversed()
        return if (parts.size > 1) "$whole.${parts[1]}" else whole
    }

    /** A large count, comma separated: block heights, transaction counts. */
    fun count(value: Long?): String = value?.toString()?.reversed()?.chunked(3)?.joinToString(",")?.reversed() ?: "—"

    /** Maximum supply, as the chain states it. */
    fun maximumSupply(supply: SupplyResponse?): String = supply?.maxSupplyObs?.let { obs(it, 0) } ?: "—"

    /** Total minted to date: genesis allocation plus everything mined. */
    fun mintedSupply(supply: SupplyResponse?): String = supply?.totalSupplyObs?.let { obs(it, 2) } ?: "—"

    /**
     * What has not been issued yet: maximum minus total minted.
     *
     * Derived, not assumed, and clamped at zero so a display rounding artefact
     * can never show a negative "remaining". If the chain reports that the
     * maximum has been reached, this reads 0 — and `maximumRespected` is shown
     * separately so the two cannot silently disagree.
     */
    fun remainingToMint(supply: SupplyResponse?): String {
        val max = decimal(supply?.maxSupplyObs) ?: return "—"
        val minted = decimal(supply?.totalSupplyObs) ?: return "—"
        val remaining = (max - minted).max(BigDecimal.ZERO)
        return obs(remaining.toPlainString(), 0)
    }

    /** Issued by mining alone, which is what "mined" means in this protocol. */
    fun minedSupply(supply: SupplyResponse?): String = supply?.minedSupplyObs?.let { obs(it, 2) } ?: "—"

    /** Locked as validator bonds — bonded, not spent, and still the owner's. */
    fun bonded(supply: SupplyResponse?): String = supply?.validatorBonds?.let { obs(it, 2) } ?: "—"

    /** Sitting in the Node Runner reward pool, awaiting distribution. */
    fun poolBalance(supply: SupplyResponse?): String = supply?.poolBalanceObs?.let { obs(it, 2) } ?: "—"

    /** Shorten a hash or address for a list row, keeping both ends. */
    fun shorten(value: String?, head: Int = 10, tail: Int = 8): String {
        if (value.isNullOrBlank()) return "—"
        if (value.length <= head + tail + 1) return value
        return value.take(head) + "…" + value.takeLast(tail)
    }
}
