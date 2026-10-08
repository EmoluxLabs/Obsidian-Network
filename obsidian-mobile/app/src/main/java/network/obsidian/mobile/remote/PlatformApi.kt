package network.obsidian.mobile.remote

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * The Obsidian Web platform's API — the same `obsidian-interface` server the web
 * app uses, reached over one base URL.
 *
 * This exists because the app previously spoke only to a bare node, which meant it
 * could read chain data but could not do anything an account does. The platform is
 * the other half: it holds accounts, issues invitations, runs MFA, and proxies the
 * node's RPC at `/api/rpc`. Pointing the app here gives it one API surface instead
 * of two, and it is the platform's own contract — no endpoint was added, renamed or
 * reshaped for this app, so the web client keeps working unchanged.
 *
 * Sessions are the platform's own `obsidian_session` cookie. It is held in memory
 * for the life of the process and is never written to disk, never logged, and never
 * sent anywhere but this base URL.
 */
@Serializable
data class AuthConfig(
    val network: String? = null,
    val inviteOnly: Boolean = true,
    val authMethod: String = "",
    val emailDomains: List<String> = emptyList(),
    val passwordMinLength: Int = 12,
    val mfaRequiredForMining: Boolean = true,
    val recoveryCodeCount: Int = 10,
    val maxInvitesPerAccount: Int = 0,
    val accountsExist: Boolean = false,
    val genesisInvite: GenesisInviteStatus? = null,
)

@Serializable
data class GenesisInviteStatus(
    val configured: Boolean = false,
    val redeemed: Boolean = false,
)

/** The platform's public view of an account. It never carries a secret. */
@Serializable
data class PlatformAccount(
    val accountId: String = "",
    val email: String = "",
    val displayName: String? = null,
    val walletAddress: String? = null,
    val mfaEnabled: Boolean = false,
    val invitesIssued: Int = 0,
)

@Serializable
private data class MeEnvelope(val account: PlatformAccount? = null)

@Serializable
data class Invite(val code: String = "", val createdAt: Long = 0)

class PlatformApi(
    val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(MemoryCookieJar())
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build(),
) {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    // ── discovery ────────────────────────────────────────────────────────────

    /**
     * `GET /api/auth/config`. The form rules are the server's, not the app's: the
     * app reads the minimum password length, the allowed email domains and whether
     * invitations are required rather than hardcoding a guess that could drift.
     */
    suspend fun authConfig(): Result<AuthConfig> = get("/api/auth/config")

    /** `GET /api/health` — the platform's own liveness, not the node's. */
    suspend fun health(): Result<JsonElement> = getRaw("/api/health")

    /** `GET /api/nodes` — the node set the platform is configured to reach. */
    suspend fun nodes(): Result<JsonElement> = getRaw("/api/nodes")

    // ── accounts ─────────────────────────────────────────────────────────────

    /**
     * `POST /api/auth/register`.
     *
     * The platform is invite-only and checks the invitation before it looks
     * anything up about the address, so a wrong code cannot be used to probe which
     * Gmail addresses hold accounts. The app therefore sends the code and lets the
     * server decide, rather than pre-validating against a list of its own — the
     * reference HTML's hardcoded VALID array was exactly that mistake.
     *
     * The password is sent to this endpoint and nowhere else, over HTTPS, and is
     * never stored on the device.
     */
    suspend fun register(
        email: String,
        password: String,
        inviteCode: String?,
        displayName: String?,
    ): Result<PlatformAccount> =
        postAccount(
            "/api/auth/register",
            buildJsonObject {
                put("email", email)
                put("password", password)
                if (inviteCode != null) put("inviteCode", inviteCode)
                if (displayName != null) put("displayName", displayName)
            },
        )

    /** `POST /api/auth/login`. */
    suspend fun login(email: String, password: String): Result<PlatformAccount> =
        postAccount(
            "/api/auth/login",
            buildJsonObject {
                put("email", email)
                put("password", password)
            },
        )

    /** `GET /api/auth/me` — the live session, or a failure when there is none. */
    suspend fun me(): Result<PlatformAccount> = runCatching {
        val envelope = json.decodeFromString<MeEnvelope>(execute(getRequest("/api/auth/me")))
        envelope.account ?: throw ApiFailure("The platform returned no account for this session")
    }

    /** `POST /api/auth/mfa/setup` — begins enrolling a second factor. */
    suspend fun mfaSetup(): Result<JsonElement> = postRaw("/api/auth/mfa/setup", buildJsonObject { })

    /** `POST /api/auth/mfa/confirm` — completes enrolment with a code from the
     *  authenticator. Until this succeeds the account has no second factor, and the
     *  app never says otherwise. */
    suspend fun mfaConfirm(code: String): Result<JsonElement> =
        postRaw("/api/auth/mfa/confirm", buildJsonObject { put("code", code) })

    /** `POST /api/auth/recover` — spends one recovery code to set a new password. */
    suspend fun recover(email: String, recoveryCode: String, newPassword: String): Result<JsonElement> =
        postRaw(
            "/api/auth/recover",
            buildJsonObject {
                put("email", email)
                put("recoveryCode", recoveryCode)
                put("newPassword", newPassword)
            },
        )

    /** `GET /api/auth/invites` — the codes this account has issued. */
    suspend fun invites(): Result<JsonElement> = getRaw("/api/auth/invites")

    /** `POST /api/auth/invites` — issues one, up to the server's own limit. */
    suspend fun issueInvite(): Result<JsonElement> = postRaw("/api/auth/invites", buildJsonObject { })

    /** `POST /api/auth/logout` — destroys the server-side session, not just the
     *  cookie. */
    suspend fun logout(): Result<JsonElement> = postRaw("/api/auth/logout", buildJsonObject { })

    /**
     * `POST /api/wallet/link` — attaches a watch address to the account.
     *
     * Only an address goes over the wire. The server validates the bech32 form with
     * its own pattern and rejects anything else; the app does not soften that check.
     */
    suspend fun linkWallet(address: String): Result<JsonElement> =
        postRaw("/api/wallet/link", buildJsonObject { put("address", address) })

    // ── chain data through the platform ──────────────────────────────────────

    /**
     * `POST /api/rpc` — the platform's proxy to the node's JSON-RPC gateway.
     *
     * This is the single call the app needs for chain state: getstatus, getblocks,
     * getblock, gettransaction, getbalance, getnames, getminingstatus, getfinality,
     * getparams, getpeers and getnodes all arrive through it. Using the proxy rather
     * than a second node URL means one origin, one cookie and one place a failure
     * can come from.
     */
    suspend fun rpc(method: String, params: Map<String, JsonElement> = emptyMap()): Result<JsonElement> =
        runCatching {
            val payload = buildJsonObject {
                put("jsonrpc", "2.0")
                put("id", 1)
                put("method", method)
                put("params", json.encodeToJsonElement(params))
            }
            json.parseToJsonElement(execute(postRequest("/api/rpc", payload.toString())))
        }

    // ── internals ────────────────────────────────────────────────────────────

    private suspend inline fun <reified T> get(path: String): Result<T> = runCatching {
        json.decodeFromString<T>(execute(getRequest(path)))
    }

    private suspend fun getRaw(path: String): Result<JsonElement> = runCatching {
        json.parseToJsonElement(execute(getRequest(path)))
    }

    private suspend fun postRaw(path: String, body: JsonElement): Result<JsonElement> = runCatching {
        json.parseToJsonElement(execute(postRequest(path, body.toString())))
    }

    /**
     * The auth endpoints answer with the account inline on success. On failure they
     * answer with `{error, code}` and a 4xx, and that message is the server's own
     * wording — it is surfaced verbatim rather than replaced with the app's guess,
     * because the server distinguishes cases the app cannot see (an invitation that
     * is spent, an address that is already taken).
     */
    private suspend fun postAccount(path: String, body: JsonElement): Result<PlatformAccount> = runCatching {
        val text = execute(postRequest(path, body.toString()))
        val element = json.parseToJsonElement(text)
        val account = (element as? kotlinx.serialization.json.JsonObject)?.get("account")
        if (account != null) {
            json.decodeFromJsonElement(PlatformAccount.serializer(), account)
        } else {
            // Some admit paths return the account at the top level.
            json.decodeFromJsonElement(PlatformAccount.serializer(), element)
        }
    }

    private fun getRequest(path: String): Request = Request.Builder()
        .url(baseUrl.trimEnd('/') + path)
        .header("Accept", "application/json")
        .get()
        .build()

    private fun postRequest(path: String, payload: String): Request = Request.Builder()
        .url(baseUrl.trimEnd('/') + path)
        .header("Accept", "application/json")
        .post(payload.toRequestBody(jsonMediaType))
        .build()

    private fun execute(request: Request): String {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw ApiFailure(serverMessage(text) ?: "HTTP ${response.code} from ${request.url.encodedPath}")
            }
            return text
        }
    }

    /** Lifts `{error, code}` out of a failure body so the user sees the reason. */
    private fun serverMessage(text: String): String? = runCatching {
        val obj = json.parseToJsonElement(text) as? kotlinx.serialization.json.JsonObject ?: return null
        val error = (obj["error"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        val code = (obj["code"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        when {
            error != null && code != null -> "$error ($code)"
            error != null -> error
            else -> null
        }
    }.getOrNull()

    companion object {
        /** The platform's session cookie name, as the server defines it. */
        const val SESSION_COOKIE = "obsidian_session"
    }
}

/**
 * Keeps the session cookie for the life of the process.
 *
 * In memory only: a persisted cookie would be a credential at rest on the device,
 * which is a strictly worse place for it than the server that issued it. Restarting
 * the app means signing in again, which is the intended behaviour.
 */
private class MemoryCookieJar : CookieJar {
    private val store = mutableMapOf<String, MutableList<Cookie>>()

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        store.getOrPut(url.host) { mutableListOf() }.apply {
            cookies.forEach { cookie ->
                removeAll { it.name == cookie.name }
                add(cookie)
            }
        }
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> =
        store[url.host].orEmpty().filter { it.expiresAt > System.currentTimeMillis() }
}
