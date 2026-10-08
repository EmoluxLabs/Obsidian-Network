package network.obsidian.mobile

import network.obsidian.mobile.remote.SupplyResponse
import network.obsidian.mobile.ui.ChainValues
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Derived display values.
 *
 * The inputs here are fixtures, chosen to be easy to check by hand; what is under
 * test is the arithmetic and the formatting, not any claim about the network's
 * actual supply. The protocol constant that does appear for real — the 20,000 OBS
 * validator bond — is asserted in [EdgeNodeSecurityTest].
 */
class ChainValuesTest {

    private val supply = SupplyResponse(
        totalSupplyObs = "1250000.5",
        totalSupplySeals = "125000050000000",
        maxSupplyObs = "21000000",
        maximumRespected = true,
        invariantOk = true,
        genesisIssuedObs = "1000000",
        minedSupplyObs = "250000.5",
        validatorBonds = "40000",
        poolBalanceObs = "12500.25",
    )

    @Test
    fun `amounts are grouped in thousands and keep real precision`() {
        assertEquals("1,250,000.50", ChainValues.obs("1250000.5"))
        assertEquals("1,284,906", ChainValues.obs("1284906", decimals = 0))
        assertEquals("0.00", ChainValues.obs("0"))
    }

    @Test
    fun `precision is truncated, never rounded up into coins that do not exist`() {
        // 0.999 truncated at 2dp is 0.99. Rounding up would display value the
        // chain has not issued.
        assertEquals("0.99", ChainValues.obs("0.999"))
        assertEquals("1,234,567.89", ChainValues.obs("1234567.899"))
    }

    @Test
    fun `a missing or malformed amount reads as unknown, never as zero`() {
        assertEquals("—", ChainValues.obs(null))
        assertEquals("—", ChainValues.obs(""))
        assertEquals("—", ChainValues.obs("not-a-number"))
        assertEquals("—", ChainValues.count(null))
    }

    @Test
    fun `counts are grouped for block heights and transaction totals`() {
        assertEquals("1,284,906", ChainValues.count(1_284_906L))
        assertEquals("0", ChainValues.count(0L))
        assertEquals("999", ChainValues.count(999L))
        assertEquals("1,000", ChainValues.count(1_000L))
    }

    @Test
    fun `maximum and minted come straight from the chain's own fields`() {
        assertEquals("21,000,000", ChainValues.maximumSupply(supply))
        assertEquals("1,250,000.50", ChainValues.mintedSupply(supply))
        assertEquals("250,000.50", ChainValues.minedSupply(supply))
        assertEquals("40,000.00", ChainValues.bonded(supply))
        assertEquals("12,500.25", ChainValues.poolBalance(supply))
    }

    @Test
    fun `remaining to mint is maximum minus total minted`() {
        // 21,000,000 - 1,250,000.5 = 19,749,999.5, shown without fractional dust.
        assertEquals("19,749,999", ChainValues.remainingToMint(supply))
    }

    @Test
    fun `remaining to mint is clamped at zero when the maximum is reached`() {
        val exhausted = supply.copy(totalSupplyObs = "21000000")
        assertEquals("0", ChainValues.remainingToMint(exhausted))
        // And a chain that reports more than its maximum — a state the invariant
        // would reject — still cannot display a negative "remaining".
        val overspent = supply.copy(totalSupplyObs = "21000001")
        assertEquals("0", ChainValues.remainingToMint(overspent))
    }

    @Test
    fun `every supply value degrades to unknown when the endpoint failed`() {
        assertEquals("—", ChainValues.maximumSupply(null))
        assertEquals("—", ChainValues.mintedSupply(null))
        assertEquals("—", ChainValues.minedSupply(null))
        assertEquals("—", ChainValues.bonded(null))
        assertEquals("—", ChainValues.poolBalance(null))
        assertEquals("—", ChainValues.remainingToMint(null))
    }

    @Test
    fun `remaining is unknown when only one of the two inputs arrived`() {
        // A node that answers /status but not /supply must not let a half-known
        // figure be presented as a derived truth.
        assertEquals("—", ChainValues.remainingToMint(supply.copy(maxSupplyObs = "")))
        assertEquals("—", ChainValues.remainingToMint(supply.copy(totalSupplyObs = "")))
    }

    @Test
    fun `zero is a real value and is displayed as one`() {
        val zeroed = supply.copy(
            totalSupplyObs = "0",
            minedSupplyObs = "0",
            validatorBonds = "0",
            poolBalanceObs = "0",
        )
        assertEquals("0.00", ChainValues.mintedSupply(zeroed))
        assertEquals("0.00", ChainValues.minedSupply(zeroed))
        assertEquals("21,000,000", ChainValues.remainingToMint(zeroed))
    }

    @Test
    fun `shortening keeps both ends so distinct hashes stay distinct`() {
        val a = "74e7dee44e8b579ac3048a716a480311bcd858b1740a1b6f99f1cda6b33dace3"
        val b = "74e7dee44e8b579ac3048a716a480311bcd858b1740a1b6f99f1cda6b33dace4"
        val shortA = ChainValues.shorten(a)
        assertEquals(shortA, ChainValues.shorten(a))
        org.junit.Assert.assertNotEquals(shortA, ChainValues.shorten(b))
        assertEquals("—", ChainValues.shorten(null))
        assertEquals("short", ChainValues.shorten("short"))
    }
}
