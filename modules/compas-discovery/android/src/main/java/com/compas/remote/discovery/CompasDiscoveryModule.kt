package com.compas.remote.discovery

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CompasDiscoveryModule : Module() {
    private val context: Context
        get() = appContext.reactContext ?: throw IllegalStateException("React context is unavailable")

    private val nsd = NsdDiscovery({ context }) { event, payload -> sendEvent(event, payload) }
    private val udp = UdpDiscovery { event, payload -> sendEvent(event, payload) }
    private val mdns = MdnsDiscovery { event, payload -> sendEvent(event, payload) }
    private val subnet = SubnetDiscovery { event, payload -> sendEvent(event, payload) }
    private var multicastLock: WifiManager.MulticastLock? = null

    // Guarded by discoveryLifecycleLock: JS asked for discovery, and it is paused while backgrounded.
    private var requestedScanId: Double? = null
    private var pausedForBackground = false
    private val discoveryLifecycleLock = Any()

    override fun definition() = ModuleDefinition {
        Name("CompasDiscovery")

        Events("onDeviceFound", "onDeviceLost", "onDiscoveryStarted", "onDiscoveryStopped", "onDiscoveryError")

        AsyncFunction("startDiscovery") { scanId: Double, promise: Promise ->
            synchronized(discoveryLifecycleLock) {
                if (requestedScanId != scanId) nsd.stop()
                requestedScanId = scanId
                pausedForBackground = false
                startScan(scanId)
            }
            promise.resolve(true)
        }

        AsyncFunction("stopDiscovery") { promise: Promise ->
            try {
                stopInternal()
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("STOP_FAILED", e.message, e)
            }
        }

        // Don't hold the multicast lock or keep mDNS running while the app is in the background.
        OnActivityEntersBackground {
            pauseForBackground()
        }

        OnActivityEntersForeground {
            resumeFromBackground()
        }

        OnDestroy {
            stopInternal()
        }
    }

    private fun stopInternal() {
        synchronized(discoveryLifecycleLock) {
            requestedScanId = null
            pausedForBackground = false
            udp.stop()
            nsd.stop()
            mdns.stop()
            subnet.stop()
            releaseMulticastLock()
        }
    }

    private fun pauseForBackground() {
        synchronized(discoveryLifecycleLock) {
            if (requestedScanId != null && !pausedForBackground) {
                pausedForBackground = true
                udp.stop()
                nsd.stop()
                mdns.stop()
                subnet.stop()
                releaseMulticastLock()
            }
        }
    }

    private fun resumeFromBackground() {
        synchronized(discoveryLifecycleLock) {
            if (pausedForBackground) {
                pausedForBackground = false
                requestedScanId?.let { startScan(it) }
            }
        }
    }

    private fun startScan(scanId: Double) {
        Log.i("CompasDiscovery", "scan $scanId start")
        acquireMulticastLock()
        udp.restart(scanId)
        mdns.start(scanId)
        subnet.start(scanId)
        try {
            nsd.start(scanId)
        } catch (_: Exception) {
            sendEvent("onDiscoveryError", mapOf("errorCode" to -1, "phase" to "start"))
        }
    }

    /** Broadcast beacons are dropped without this on several Wi-Fi drivers. */
    private fun acquireMulticastLock() {
        if (multicastLock != null) return
        try {
            val wifi = context.applicationContext.getSystemService(WifiManager::class.java) ?: return
            multicastLock = wifi.createMulticastLock("compas-discovery").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
            multicastLock = null
        }
    }

    private fun releaseMulticastLock() {
        multicastLock?.let { lock -> if (lock.isHeld) runCatching { lock.release() } }
        multicastLock = null
    }
}
