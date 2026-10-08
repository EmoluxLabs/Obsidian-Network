package network.obsidian.mobile.remote

/**
 * Obsidian address validation, implementing the protocol's own encoding.
 *
 * From `obsidian-core/src/crypto/keys.ts`: an address is
 * `bech32("obs", RIPEMD160(SHA256(compressed pubkey)))` — BIP-173 bech32 with the
 * constant 1 and a 20-byte payload. This is validation only. It decodes and
 * checksums; it derives no key and signs nothing, so it is not a second wallet
 * implementation.
 *
 * Getting this right matters more than it looks: an address the app accepts but
 * the node rejects would fail at send time, after the user believed they were
 * done.
 */
object Addresses {

    /** The protocol's address HRP. */
    const val HRP = "obs"

    /** BIP-173 charset, in order. */
    private const val CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

    private const val BECH32_CONST = 1

    /** Payload length in bytes: RIPEMD160 output. */
    private const val PAYLOAD_BYTES = 20

    /**
     * Returns null when [address] is a checksum-valid `obs1…` address, or a
     * human-readable reason it is not — the reason is shown to the user verbatim,
     * so it names the actual defect rather than a generic "invalid".
     */
    fun validate(address: String?): String? {
        val value = address?.trim().orEmpty()
        if (value.isEmpty()) return "Enter an address"
        if (value.length != value.lowercase().length) return "Addresses are lowercase"
        val separator = value.lastIndexOf('1')
        if (separator < 1) return "Missing the '1' separator"
        val hrp = value.substring(0, separator)
        if (hrp != HRP) return "Expected an address starting '${HRP}1'"
        val dataPart = value.substring(separator + 1)
        if (dataPart.length < 6) return "Address is too short"
        val values = IntArray(dataPart.length)
        for (i in dataPart.indices) {
            val index = CHARSET.indexOf(dataPart[i])
            if (index < 0) return "Contains '${dataPart[i]}', which is not a valid address character"
            values[i] = index
        }
        if (polymod(hrpExpand(hrp) + values) != BECH32_CONST) return "Checksum does not match"
        val payload = convertBits(values.copyOfRange(0, values.size - 6), 5, 8, false)
            ?: return "Data section is malformed"
        if (payload.size != PAYLOAD_BYTES) return "Expected a $PAYLOAD_BYTES-byte payload, got ${payload.size}"
        return null
    }

    fun isValid(address: String?): Boolean = validate(address) == null

    /** Shorten for display, keeping both ends so two addresses stay tellable apart. */
    fun shorten(address: String?, head: Int = 12, tail: Int = 10): String {
        val value = address.orEmpty()
        if (value.isBlank()) return "—"
        if (value.length <= head + tail + 1) return value
        return value.take(head) + "…" + value.takeLast(tail)
    }

    // ── BIP-173 primitives ───────────────────────────────────────────────────

    private fun hrpExpand(hrp: String): IntArray {
        val out = IntArray(hrp.length * 2 + 1)
        for (i in hrp.indices) {
            out[i] = hrp[i].code shr 5
            out[hrp.length + 1 + i] = hrp[i].code and 31
        }
        out[hrp.length] = 0
        return out
    }

    private fun polymod(values: IntArray): Int {
        val generator = intArrayOf(0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)
        var checksum = 1
        for (value in values) {
            val top = checksum shr 25
            checksum = ((checksum and 0x1ffffff) shl 5) xor value
            for (i in 0 until 5) {
                if (((top shr i) and 1) == 1) checksum = checksum xor generator[i]
            }
        }
        return checksum
    }

    /** Regroup between bit widths, as BIP-173 specifies. Null when the input is
     *  not a whole number of output groups and [pad] is false. */
    private fun convertBits(data: IntArray, from: Int, to: Int, pad: Boolean): IntArray? {
        var accumulator = 0
        var bits = 0
        val maxV = (1 shl to) - 1
        val out = ArrayList<Int>(data.size * from / to + 1)
        for (value in data) {
            if (value < 0 || (value shr from) != 0) return null
            accumulator = (accumulator shl from) or value
            bits += from
            while (bits >= to) {
                bits -= to
                out.add((accumulator shr bits) and maxV)
            }
        }
        if (pad) {
            if (bits > 0) out.add((accumulator shl (to - bits)) and maxV)
        } else if (bits >= from || ((accumulator shl (to - bits)) and maxV) != 0) {
            return null
        }
        return out.toIntArray()
    }
}
