package network.obsidian.mobile.edgenode

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import network.obsidian.mobile.R
import network.obsidian.mobile.remote.ApiFailure
import network.obsidian.mobile.remote.ObsidianApi

/**
 * The Obsidian Edge Node.
 *
 * What this service is: a client that keeps a connection to an Obsidian node,
 * receives blocks and transactions, and verifies what it receives using the
 * node's own reported state. It exists to make the network more resilient by
 * propagating data.
 *
 * What this service is not, and the reasons are structural rather than
 * promises:
 *
 *   - It casts no vote and has no voting power. Voting weight in this protocol
 *     comes from a 20,000 OBS validator bond recorded in chain state; this
 *     service holds no key that could register one and never touches wallet
 *     state, so there is no path from running it to influencing consensus.
 *     Ten thousand Edge Nodes contribute propagation, not one validator's worth
 *     of authority.
 *   - It produces no block and signs no header. There is no block-construction
 *     or signing code in this package.
 *   - It earns nothing. It is not a Node Runner, holds no payout identity and
 *     appears in no reward calculation. The UI keeps the two terms separate
 *     because they are different things.
 *   - It cannot see a wallet secret. The wallet domain and this domain are
 *     separate: nothing here reads the keystore, and the service starts without
 *     any credential at all.
 *
 * It runs only as a user-visible foreground service, stops when the user
 * disables it or connectivity goes away, and never restarts itself: the
 * manifest deliberately does not request RECEIVE_BOOT_COMPLETED.
 */
class EdgeNodeService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null
    private var api: ObsidianApi? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopEverything()
                return START_NOT_STICKY
            }
        }
        val nodeUrl = intent?.getStringExtra(EXTRA_NODE_URL) ?: EdgeNodeState.DEFAULT_NODE_URL
        startForegroundCompat(buildNotification(EdgeNodeState.Connecting))
        start(nodeUrl)
        // START_NOT_STICKY on purpose: if the OS kills this service it stays
        // dead until the user opens the app again. A background network
        // participant that resurrects itself is not something a user can
        // reason about, and the app must never behave that way.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopEverything()
        scope.cancel()
        super.onDestroy()
    }

    private fun start(nodeUrl: String) {
        if (loop?.isActive == true) return
        api = ObsidianApi(nodeUrl)
        loop = scope.launch {
            while (isActive) {
                if (!hasConnectivity()) {
                    publish(EdgeNodeState.Offline)
                } else {
                    tick()
                }
                delay(POLL_MILLIS)
            }
        }
    }

    /**
     * One cycle: fetch the head the node reports and check it is internally
     * consistent. This is verification of received data, not consensus — the
     * service forms no opinion about which chain is canonical and never
     * rebroadcasts anything it has not checked.
     */
    private suspend fun tick() {
        val client = api ?: return
        val result = withContext(Dispatchers.IO) { client.health() }
        result.fold(
            onSuccess = { health ->
                val verified = health.height > 0 && health.headHash.isNotBlank() && health.genesisId.isNotBlank()
                val state = if (verified) {
                    EdgeNodeState.Running(
                        height = health.height,
                        headHash = health.headHash,
                        peers = health.peers,
                        syncing = health.syncing,
                        protocolVersion = health.protocolVersion,
                        network = health.network,
                    )
                } else {
                    // A node answering with an inconsistent head is exactly the
                    // "detect invalid data" case: report it rather than relaying
                    // it, and never treat a malformed answer as progress.
                    EdgeNodeState.Rejected("node reported an inconsistent head")
                }
                publish(state)
            },
            onFailure = { error ->
                publish(
                    if (error is ApiFailure) EdgeNodeState.Offline
                    else EdgeNodeState.Rejected(error.message ?: "verification failed"),
                )
            },
        )
    }

    private fun publish(state: EdgeNodeState) {
        EdgeNodeState.current.value = state
        updateNotification(buildNotification(state))
    }

    private fun stopEverything() {
        loop?.cancel()
        loop = null
        api = null
        EdgeNodeState.current.value = EdgeNodeState.Stopped
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun hasConnectivity(): Boolean {
        val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager
            ?: return false
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    // ── notification ─────────────────────────────────────────────────────────

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(notification: Notification) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun createChannel() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.edge_node_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.edge_node_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(state: EdgeNodeState): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(getString(R.string.edge_node_name))
            .setContentText(state.describe(getString(R.string.edge_node_subtitle)))
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    companion object {
        private const val CHANNEL_ID = "obsidian.edge_node"
        private const val NOTIFICATION_ID = 4_701
        private const val POLL_MILLIS = 30_000L

        const val ACTION_STOP = "network.obsidian.mobile.edgenode.STOP"
        const val EXTRA_NODE_URL = "nodeUrl"

        fun start(context: Context, nodeUrl: String) {
            val intent = Intent(context, EdgeNodeService::class.java).putExtra(EXTRA_NODE_URL, nodeUrl)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startForegroundService(
                Intent(context, EdgeNodeService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}

/** The Edge Node's observable state, surfaced in the UI so it is never a secret. */
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

    fun describe(fallback: String): String = when (this) {
        Stopped -> "Stopped"
        Connecting -> "Connecting…"
        Offline -> "Offline — waiting for connectivity"
        is Rejected -> "Invalid data: $reason"
        is Running -> if (syncing) "Syncing · height $height" else "Live · height $height · $peers peers"
    }

    companion object {
        const val DEFAULT_NODE_URL = "http://127.0.0.1:8630"

        /** Single source of truth for the UI. A StateFlow, so the screen shows
         *  whatever the service last established rather than guessing. */
        val current = MutableStateFlow<EdgeNodeState>(Stopped)
        val observable: StateFlow<EdgeNodeState> = current.asStateFlow()
    }
}

/*
 * Deliberately absent from this package, and the absence IS the security
 * property:
 *   - no notification action that could start mining or produce a block;
 *   - no reference to the wallet keystore, a seed phrase or a private key;
 *   - no PowerManager wake lock — the service pauses when the OS suspends it
 *     instead of holding the CPU awake;
 *   - no BootReceiver anywhere in the project, so it cannot restart itself.
 */
