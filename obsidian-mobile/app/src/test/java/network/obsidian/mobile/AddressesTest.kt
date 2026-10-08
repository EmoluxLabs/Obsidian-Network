package network.obsidian.mobile

import network.obsidian.mobile.remote.Addresses
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Address validation against real bech32 vectors.
 *
 * The two valid addresses below were encoded independently with a reference
 * BIP-173 implementation over 20-byte payloads, so they are genuine obs1
 * addresses rather than strings that happen to satisfy this code. A validator
 * tested only against its own output would prove nothing.
 */
class AddressesTest {

    @Test
    fun `accepts a checksum-valid obs1 address`() {
        assertNull(Addresses.validate("obs1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn3jmwze"))
        assertNull(Addresses.validate("obs14w46h2at4w46h2at4w46h2at4w46h2atw2spza"))
    }

    @Test
    fun `rejects a corrupted checksum`() {
        // The last data character before the checksum is changed, so the payload
        // is intact but the checksum no longer covers it.
        val valid = "obs1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn3jmwze"
        val tampered = valid.dropLast(7) + "q" + valid.takeLast(6)
        assertEquals("Checksum does not match", Addresses.validate(tampered))
    }

    @Test
    fun `rejects the wrong human-readable part`() {
        assertEquals(
            "Expected an address starting 'obs1'",
            Addresses.validate("btc1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnu3wq4n"),
        )
    }

    @Test
    fun `rejects uppercase, because bech32 is case-sensitive here`() {
        assertEquals(
            "Addresses are lowercase",
            Addresses.validate("OBS1QQQSYQCYQ5RQWZQFPG9SCRGWPUGPZYSN3JMWZE"),
        )
    }

    @Test
    fun `rejects an empty address with an actionable message`() {
        assertEquals("Enter an address", Addresses.validate(""))
        assertEquals("Enter an address", Addresses.validate(null))
        assertEquals("Enter an address", Addresses.validate("   "))
    }

    @Test
    fun `rejects a payload of the wrong length`() {
        // 19 bytes would decode to a payload that is not a RIPEMD160 digest.
        val tooShort = "obs1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn3jmw"
        assertTrue(Addresses.validate(tooShort)!!.contains("payload"))
    }

    @Test
    fun `shortening keeps both ends so two addresses stay distinguishable`() {
        val a = "obs1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn3jmwze"
        val b = "obs14w46h2at4w46h2at4w46h2at4w46h2atw2spza"
        val shortA = Addresses.shorten(a)
        val shortB = Addresses.shorten(b)
        assertFalse(shortA == shortB)
        assertTrue(shortA.startsWith("obs1"))
        assertTrue(shortA.endsWith(a.takeLast(10)))
    }

    @Test
    fun `isValid agrees with validate`() {
        assertTrue(Addresses.isValid("obs1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn3jmwze"))
        assertFalse(Addresses.isValid("obs1notavalidaddress"))
    }
}
