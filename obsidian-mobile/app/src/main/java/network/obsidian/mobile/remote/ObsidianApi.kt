package network.obsidian.mobile.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The transport to an Obsidian node.
 *
 * Deliberately thin and honest about failure: every call returns a [Result], and
 * a network error is never translated into a default value that a screen could
 * mistake for chain state. Requirement 28 — no fake success — starts here.
 */
open class ObsidianApi(
    private val baseUrl: String,
    private val client: OkHttpClient = defaultClient(),
) {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    open suspend fun health(): Result<HealthResponse> = get("/health")
    open suspend fun status(): Result<StatusResponse> = get("/status")
    open suspend fun supply(): Result<SupplyResponse> = get("/supply")
    suspend fun params(): Result<JsonElement> = getRaw("/params")
    suspend fun network(): Result<JsonElement> = getRaw("/network")
    suspend fun peers(): Result<JsonElement> = getRaw("/peers")
    suspend fun nodes(): Result<JsonElement> = getRaw("/nodes")
    suspend fun validators(): Result<JsonElement> = getRaw("/validators")
    suspend fun finality(): Result<JsonElement> = getRaw("/finality")
    suspend fun mempool(): Result<JsonElement> = getRaw("/mempool")
    suspend fun miningSchedule(): Result<JsonElement> = getRaw("/mining/schedule")
    suspend fun revenue(): Result<JsonElement> = getRaw("/revenue")
    suspend fun genesis(): Result<JsonElement> = getRaw("/genesis")
    suspend fun version(): Result<JsonElement> = getRaw("/version")

    /**
     * POST /wallet/balance. The node holds no keys; it reports the balance of an
     * address it is given. The app never sends a private key to a node — the
     * only secret that leaves this device is a signature.
     */
    suspend fun balance(address: String): Result<BalanceResponse> =
        post("/wallet/balance", buildJsonObject { put("address", address) })

    /** POST /tx/gas — the node tells the wallet what a transaction will cost. */
    suspend fun gasQuote(body: JsonElement): Result<JsonElement> = postRaw("/tx/gas", body)

    /** POST /tx/simulate — validate before signing, never after. */
    suspend fun simulate(body: JsonElement): Result<JsonElement> = postRaw("/tx/simulate", body)

    /**
     * POST /tx/submit. Submitting is not confirming: the response carries the
     * node's acceptance of the transaction into its mempool, and the UI must
     * keep showing "pending" until the chain reports the transaction in a block.
     */
    suspend fun submit(body: JsonElement): Result<JsonElement> = postRaw("/tx/submit", body)

    /** POST /tx/encode — build the canonical bytes the wallet will sign. */
    suspend fun encode(body: JsonElement): Result<JsonElement> = postRaw("/tx/encode", body)

    /** POST /rpc — the JSON-RPC method gateway (getBlock, getTransaction, …). */
    suspend fun rpc(method: String, params: Map<String, JsonElement> = emptyMap()): Result<JsonElement> =
        runCatching {
            val payload = json.encodeToString(RpcRequest.serializer(), RpcRequest(method = method, params = params))
            val parsed = json.parseToJsonElement(execute(postRequest("/rpc", payload)))
            // A JSON-RPC error object is a legitimate answer, not a transport
            // failure: turn it into a failure value here so a screen shows the
            // node's own message instead of mistaking the envelope for data.
            describeRpcError(parsed)?.let { throw ApiFailure(it) }
            parsed
        }

    // ── internals ────────────────────────────────────────────────────────────

    private suspend inline fun <reified T> get(path: String): Result<T> = runCatching {
        val text = execute(getRequest(path))
        json.decodeFromString<T>(text)
    }

    private suspend fun getRaw(path: String): Result<JsonElement> = runCatching {
        json.parseToJsonElement(execute(getRequest(path)))
    }

    private suspend inline fun <reified T> post(path: String, body: JsonElement): Result<T> = runCatching {
        val text = execute(postRequest(path, body.toString()))
        json.decodeFromString<T>(text)
    }

    private suspend fun postRaw(path: String, body: JsonElement): Result<JsonElement> = runCatching {
        json.parseToJsonElement(execute(postRequest(path, body.toString())))
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

    /** Blocking OkHttp call. Called only from coroutines on the IO dispatcher. */
    private fun execute(request: Request): String {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw ApiFailure("HTTP ${response.code} from ${request.url.encodedPath}")
            }
            return text
        }
    }

    private fun describeRpcError(element: JsonElement): String? {
        val obj = element as? kotlinx.serialization.json.JsonObject ?: return null
        val err = obj["error"] as? JsonPrimitive ?: return null
        return err.content
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            // A phone on a bad connection must fail visibly, not hang forever.
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }
}

/** A transport or protocol failure, carried as a value rather than thrown away. */
class ApiFailure(message: String, cause: Throwable? = null) : IOException(message, cause)
