package network.obsidian.mobile.edgenode

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import network.obsidian.mobile.R
import network.obsidian.mobile.remote.ObsidianApi

/**
 * The Obsidian Edge Node's Android shell.
 *
 * Everything that could be wrong about an Edge Node — its state transitions, its
 * authority, what it does offline — lives in [EdgeNodeController], which has no
 * Android dependencies and is covered by tests. This class owns only what a
 * Service must own: the foreground notification, the process lifecycle, and the
 * connectivity check that Android itself answers.
 *
 * The security properties are structural, and the reason they hold is worth
 * stating rather than promising: this class holds no credential of any kind, so
 * there is nothing for it to leak into consensus. It never touches the wallet
 * keystore. It posts no bond. The manifest requests no boot receiver, so it
 * cannot start itself after the user stops it.
 */
class EdgeNodeService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null
    private var controller: EdgeNodeController? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }
        val nodeUrl = intent?.getStringExtra(EXTRA_NODE_URL) ?: EdgeNodeState.DEFAULT_NODE_URL
        startForegroundCompat(buildNotification(EdgeNodeState.Connecting))
        start(nodeUrl)
        // START_NOT_STICKY on purpose: if the OS kills this service it stays dead
        // until the user opens the app again. A background network participant
        // that resurrects itself is not something a user can reason about.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopEverything()
        scope.cancel()
        super.onDestroy()
    }

    private fun start(nodeUrl: String) {
        if (loop?.isActive == true) return
        val link = AndroidEdgeNodeLink(this, nodeUrl)
        val node = EdgeNodeController(link)
        controller = node
        loop = scope.launch {
            node.enable()
            while (isActive) {
                // Mirror the controller into the notification, so the status the
                // user sees in the shade is the status the node actually reached.
                launch {
                    node.state.collect { updateNotification(buildNotification(it)) }
                }
                delay(POLL_MILLIS)
                node.cycle()
            }
        }
    }

    private fun stopEverything() {
        controller?.disable()
        controller = null
        loop?.cancel()
        loop = null
        EdgeNodeState.current.value = EdgeNodeState.Stopped
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
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
            .setSmallIcon(R.drawable.ic_stat_obsidian)
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
            context.startForegroundService(
                Intent(context, EdgeNodeService::class.java).putExtra(EXTRA_NODE_URL, nodeUrl),
            )
        }

        fun stop(context: Context) {
            context.startForegroundService(
                Intent(context, EdgeNodeService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}

/**
 * The real [EdgeNodeLink]: connectivity from Android, heads from a node's own
 * `/health` answer.
 *
 * Reading `/health` is what makes this an Edge Node rather than a full node — it
 * verifies the head a node reports and relays nothing it has not checked, using
 * a phone's worth of bandwidth instead of a server's.
 */
internal class AndroidEdgeNodeLink(
    private val context: Context,
    nodeUrl: String,
) : EdgeNodeLink {

    private val api = ObsidianApi(nodeUrl)

    override suspend fun hasConnectivity(): Boolean = withContext(Dispatchers.IO) {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return@withContext false
        val network = manager.activeNetwork ?: return@withContext false
        val capabilities = manager.getNetworkCapabilities(network) ?: return@withContext false
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    override suspend fun fetchHead(): Result<HeadReport> =
        api.health().mapCatching { health ->
            HeadReport(
                height = health.height,
                headHash = health.headHash,
                genesisId = health.genesisId,
                peers = health.peers,
                syncing = health.syncing,
                protocolVersion = health.protocolVersion,
                network = health.network,
            )
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
