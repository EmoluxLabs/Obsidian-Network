package network.obsidian.mobile

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import network.obsidian.mobile.remote.ObsidianRepository

/**
 * OBSIDIAN — Obsidian Mobile.
 *
 * The blockchain itself is not in this process. This application is a client of
 * an Obsidian node, plus an optional Edge Node that verifies and relays. It
 * contains no consensus logic, mints nothing and votes on nothing.
 */
class ObsidianApp : Application() {

    /** Lives as long as the process; a SupervisorJob so one failed refresh
     *  cannot tear down the poller for every screen. */
    private val applicationScope = CoroutineScope(SupervisorJob())

    lateinit var repository: ObsidianRepository
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        repository = ObsidianRepository(applicationScope)
        repository.startPolling()
    }

    companion object {
        lateinit var instance: ObsidianApp
            private set
    }
}
