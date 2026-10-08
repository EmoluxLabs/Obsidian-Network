package network.obsidian.mobile.identity

import android.content.Context
import android.content.SharedPreferences
import network.obsidian.mobile.remote.Addresses

/**
 * The one identity this app keeps, and what it deliberately is not.
 *
 * A watch profile is a label and a chain address. It holds no private key, no
 * seed phrase and no signing credential of any kind, and it is not encrypted
 * because there is nothing in it worth stealing: the address is public chain
 * state, readable by anyone who asks a node.
 *
 * Signing stays where it already exists. Obsidian's key handling and transaction
 * signing live in the existing wallet tooling, and this app does not reimplement
 * them — a second, independent signing path on a phone would be a security
 * regression, not a feature. What this app can genuinely do without a key is
 * everything that does not need one: read chain state, watch a balance, encode
 * and simulate a transaction, and relay one that was already signed.
 */
data class WatchProfile(
    val label: String,
    val address: String,
    /** A local device PIN. Protects this device only — it is not a second
     *  factor issued by a server, and the UI says so rather than implying one. */
    val pinHash: String?,
    val createdAtEpochMillis: Long,
)

/**
 * Stores watch profiles in the app's private preferences.
 *
 * Private to the app by Android's own sandbox, which is the right protection for
 * non-secret data. Storing it in the Keystore would imply it is secret.
 */
class ProfileStore(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun all(): List<WatchProfile> =
        prefs.all.keys
            .filter { it.startsWith(PREFIX) }
            .mapNotNull { key ->
                val parts = prefs.getString(key, null)?.split(UNIT_SEPARATOR) ?: return@mapNotNull null
                if (parts.size < 4) return@mapNotNull null
                WatchProfile(
                    label = parts[0],
                    address = parts[1],
                    pinHash = parts[2].takeIf { it.isNotBlank() },
                    createdAtEpochMillis = parts[3].toLongOrNull() ?: 0L,
                )
            }
            .sortedByDescending { it.createdAtEpochMillis }

    fun find(address: String): WatchProfile? =
        all().firstOrNull { it.address.equals(address.trim(), ignoreCase = true) }

    fun active(): WatchProfile? {
        val address = prefs.getString(KEY_ACTIVE, null) ?: return null
        return find(address)
    }

    fun setActive(address: String) {
        prefs.edit().putString(KEY_ACTIVE, address.trim()).apply()
    }

    fun save(profile: WatchProfile): SaveResult {
        val address = profile.address.trim()
        val error = Addresses.validate(address)
        if (error != null) return SaveResult.Rejected(error)
        if (profile.label.isBlank()) return SaveResult.Rejected("Enter a label for this address")
        if (find(address) != null) return SaveResult.Rejected("This address is already saved on this device")
        prefs.edit()
            .putString(
                PREFIX + address.lowercase(),
                listOf(
                    profile.label.trim(),
                    address,
                    profile.pinHash.orEmpty(),
                    profile.createdAtEpochMillis.toString(),
                ).joinToString(UNIT_SEPARATOR),
            )
            .putString(KEY_ACTIVE, address)
            .apply()
        return SaveResult.Saved(profile.copy(label = profile.label.trim(), address = address))
    }

    /**
     * Sets or clears the local device PIN. Returns the reason it was refused, or
     * null when it succeeded.
     */
    fun setPin(address: String, pin: String?): String? {
        val existing = find(address) ?: return "That address is not saved on this device"
        if (pin != null && pin.length < PIN_LENGTH) return "Use at least $PIN_LENGTH digits"
        prefs.edit()
            .putString(
                PREFIX + address.lowercase(),
                listOf(
                    existing.label,
                    existing.address,
                    pin?.let { hash(it) }.orEmpty(),
                    existing.createdAtEpochMillis.toString(),
                ).joinToString(UNIT_SEPARATOR),
            )
            .apply()
        return null
    }

    /**
     * Checks the local PIN.
     *
     * This is a device lock, not authentication against a server: Obsidian has no
     * account server, so there is no second factor for it to issue. The UI states
     * that plainly instead of dressing a local check up as one.
     */
    fun checkPin(address: String, pin: String): Boolean {
        val stored = find(address)?.pinHash ?: return false
        return stored == hash(pin)
    }

    fun remove(address: String) {
        prefs.edit()
            .remove(PREFIX + address.lowercase())
            .apply()
        if (prefs.getString(KEY_ACTIVE, null).equals(address, ignoreCase = true)) {
            prefs.edit().remove(KEY_ACTIVE).apply()
        }
    }

    /**
     * A salted digest of the PIN, so the digits themselves are never written to
     * disk. Not a substitute for a real KDF — this guards a device lock over
     * non-secret data, and it is documented as such rather than oversold.
     */
    private fun hash(pin: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(("obsidian.mobile.device.pin.$pin").toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }

    sealed interface SaveResult {
        data class Saved(val profile: WatchProfile) : SaveResult
        data class Rejected(val reason: String) : SaveResult
    }

    companion object {
        private const val FILE = "obsidian.profiles"
        private const val PREFIX = "profile."
        private const val KEY_ACTIVE = "active"
        private const val UNIT_SEPARATOR = "\u001F"
        const val PIN_LENGTH = 6
    }
}
