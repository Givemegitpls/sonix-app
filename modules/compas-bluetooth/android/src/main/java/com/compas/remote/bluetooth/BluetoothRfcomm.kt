package com.compas.remote.bluetooth

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import expo.modules.kotlin.Promise
import java.io.BufferedInputStream
import java.io.IOException
import java.io.OutputStream
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

internal class BluetoothRfcomm(
    private val bluetoothAdapter: () -> BluetoothAdapter?,
    private val pairing: BluetoothPairing,
    private val isDestroyed: () -> Boolean,
) {
    /** Reuse one worker: creating an executor for every request leaked a native thread per call. */
    private val rfcommRequestExecutor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "compas-rfcomm-request").apply { isDaemon = true }
    }

    private class ArtworkExchange(val deviceId: String, val index: Long?) {
        @Volatile var preempted = false
        @Volatile var socket: BluetoothSocket? = null
    }

    /**
     * One RFCOMM link kept open between requests. SonixLink serves the same
     * HTTP on it as on the network and keeps it for 30 s idle, so a status poll
     * does not reconnect every second.
     */
    private class Link(
        val deviceId: String,
        val socket: BluetoothSocket,
        val input: BufferedInputStream,
        val output: OutputStream,
        var lastUsed: Long,
    )

    // Only the single executor thread uses these, apart from destroy(), which
    // comes from the module's teardown; the lock is what keeps those two apart.
    private val linkLock = Any()
    private val links = HashMap<String, Link>()
    private val LINK_IDLE_MS = 20_000L

    private val artworkLock = Any()
    private val activeArtworkExchanges = LinkedHashSet<ArtworkExchange>()

    /** Settles its promise once, so OnDestroy and a still-running worker can't both settle it. */
    private class PendingRfcommRequest(val deviceId: String, private val promise: Promise) {
        private val settled = AtomicBoolean(false)
        @Volatile var socket: BluetoothSocket? = null
        val isSettled: Boolean get() = settled.get()

        fun resolve(value: Any?) {
            if (settled.compareAndSet(false, true)) promise.resolve(value)
        }

        fun reject(code: String, message: String?, cause: Throwable?) {
            if (settled.compareAndSet(false, true)) promise.reject(code, message, cause)
        }
    }

    // shutdownNow() drops queued tasks; OnDestroy rejects these so JS awaits don't hang on reload.
    private val pendingRfcommRequests = ConcurrentHashMap.newKeySet<PendingRfcommRequest>()

    fun preemptArtwork(index: Double?, promise: Promise) {
        val idx = index?.toLong()
        var count = 0
        val deviceIds = HashSet<String>()
        synchronized(artworkLock) {
            for (exchange in activeArtworkExchanges) {
                if (idx == null || exchange.index == idx) {
                    exchange.preempted = true
                    // Only a request that actually owns the shared link may take
                    // it down; a queued one must not abort the command ahead of it.
                    exchange.socket?.let { s ->
                        deviceIds.add(exchange.deviceId)
                        runCatching { s.close() }
                    }
                    count++
                }
            }
        }
        // The link a preempted artwork read was using is now closed; drop it so
        // the next request opens a fresh one instead of writing into a corpse.
        deviceIds.forEach { closeLink(it) }
        promise.resolve(count)
    }

    fun execute(
        deviceId: String, method: String, target: String, headers: Map<String, String>?,
        isArtwork: Boolean, artworkIndex: Double?, bodyBase64: String?, promise: Promise,
    ) {
        // Expo's AsyncFunction supports eight arguments; the per-request timeout
        // rides in a header the player never sees instead of being a ninth.
        val timeoutHeader = "X-Compas-Timeout"
        val timeoutMs = headers?.entries
            ?.firstOrNull { it.key.equals(timeoutHeader, ignoreCase = true) }
            ?.value?.toDoubleOrNull()
        val wireHeaders = headers?.filterKeys { !it.equals(timeoutHeader, ignoreCase = true) }
        val normalizedId = normalizeDeviceId(deviceId)
        val pending = PendingRfcommRequest(normalizedId, promise)
        pairing.noteRfcommDevice(normalizedId)
        pendingRfcommRequests.add(pending)
        // Checked after registering so a concurrent OnDestroy either sees this request or we see the flag.
        if (isDestroyed()) {
            pendingRfcommRequests.remove(pending)
            pending.reject("MODULE_DESTROYED", "Bluetooth module was destroyed", null)
            return
        }
        try {
            pairing.ensureReceiverRegistered()
        } catch (e: Exception) {
            pendingRfcommRequests.remove(pending)
            pending.reject("BLUETOOTH_ERROR", e.message, e)
            return
        }
        val idx = artworkIndex?.toLong()
        val exchange = if (isArtwork) {
            ArtworkExchange(normalizedId, idx).also { ex ->
                synchronized(artworkLock) { activeArtworkExchanges.add(ex) }
            }
        } else null

        val request = RfcommHttpRequest(method, target, wireHeaders, bodyBase64)
        val timeout = timeoutMs?.toLong()
        val task = Runnable { runRequest(pending, deviceId, normalizedId, exchange, request, timeout) }
        try {
            rfcommRequestExecutor.execute(task)
        } catch (e: RejectedExecutionException) {
            pendingRfcommRequests.remove(pending)
            exchange?.let { ex -> synchronized(artworkLock) { activeArtworkExchanges.remove(ex) } }
            pending.reject("MODULE_DESTROYED", "Bluetooth module was destroyed", e)
        }
    }

    private fun runRequest(
        pending: PendingRfcommRequest, deviceId: String, normalizedId: String,
        exchange: ArtworkExchange?, request: RfcommHttpRequest, timeoutMs: Long?,
    ) {
        var attempt = 0
        try {
            while (true) {
                try {
                    sendOnce(pending, deviceId, normalizedId, exchange, request, timeoutMs)
                    return
                } catch (e: Exception) {
                    closeLink(normalizedId)
                    // A GET may be replayed once: the usual cause is a link the
                    // player closed while it sat idle. A command must not be
                    // sent twice, so only reads retry.
                    if (attempt == 0 && !pending.isSettled && exchange?.preempted != true &&
                        request.method.equals("GET", ignoreCase = true)) {
                        attempt++
                        continue
                    }
                    rejectFailedRequest(pending, exchange, e)
                    return
                }
            }
        } finally {
            pendingRfcommRequests.remove(pending)
            pending.socket = null
            if (exchange != null) {
                synchronized(artworkLock) {
                    activeArtworkExchanges.remove(exchange)
                    exchange.socket = null
                }
            }
        }
    }

    private fun sendOnce(
        pending: PendingRfcommRequest, deviceId: String, normalizedId: String,
        exchange: ArtworkExchange?, request: RfcommHttpRequest, timeoutMs: Long?,
    ) {
        if (pending.isSettled) return
        val adapter = bluetoothAdapter() ?: throw IOException("Bluetooth adapter not available")
        if (!adapter.isEnabled) throw IOException("Bluetooth adapter is disabled")
        runCatching { adapter.cancelDiscovery() }
        if (exchange != null && exchange.preempted) {
            throw IOException("Artwork request preempted by foreground command")
        }
        if (isDestroyed()) throw IOException("Bluetooth module was destroyed")
        val device = adapter.getRemoteDevice(deviceId)
        val link = linkFor(device, adapter, normalizedId, pending, exchange)
        pending.socket = link.socket
        if (exchange != null) {
            synchronized(artworkLock) {
                if (exchange.preempted) {
                    closeLink(normalizedId)
                    throw IOException("Artwork request preempted by foreground command")
                }
                exchange.socket = link.socket
            }
        }
        exchangeHttp(link.socket, link.input, request, exchange != null, timeoutMs, pending::resolve)
        link.lastUsed = System.currentTimeMillis()
    }

    private fun linkFor(
        device: BluetoothDevice, adapter: BluetoothAdapter, normalizedId: String,
        pending: PendingRfcommRequest, exchange: ArtworkExchange?,
    ): Link {
        val now = System.currentTimeMillis()
        synchronized(linkLock) {
            val existing = links[normalizedId]
            if (existing != null && now - existing.lastUsed < LINK_IDLE_MS) return existing
        }
        closeLink(normalizedId)
        if (pending.isSettled) throw IOException("Bluetooth request was cancelled")
        // Pairing's lock is held only while the socket object is made: the
        // connect itself waits on another thread that takes the same lock.
        val candidate = synchronized(pairing.lock) {
            if (pending.isSettled) throw IOException("Bluetooth request was cancelled")
            if (isDestroyed()) throw IOException("Bluetooth module was destroyed")
            pairing.requireBondedLocked(adapter, device, normalizedId)
            device.createRfcommSocketToServiceRecord(SONIXLINK_BT_UUID).also { pending.socket = it }
        }
        if (exchange != null) {
            synchronized(artworkLock) { exchange.socket = candidate }
        }
        val connected = try {
            connectSocket(candidate, adapter, device, normalizedId, pending)
        } catch (e: Exception) {
            runCatching { candidate.close() }
            throw e
        }
        val link = Link(normalizedId, connected, BufferedInputStream(connected.inputStream), connected.outputStream, now)
        synchronized(linkLock) { links[normalizedId] = link }
        return link
    }

    private fun closeLink(deviceId: String) {
        val link = synchronized(linkLock) { links.remove(deviceId) }
        link?.let { runCatching { it.socket.close() } }
    }

    private fun rejectFailedRequest(pending: PendingRfcommRequest, exchange: ArtworkExchange?, error: Exception) {
        if (isDestroyed()) {
            pending.reject("MODULE_DESTROYED", "Bluetooth module was destroyed", error)
        } else if (error is PairingRequiredException) {
            pending.reject("BLUETOOTH_PAIRING_REQUIRED", PAIRING_REQUIRED_MESSAGE, error)
        } else if (pending.isSettled) {
            // The pairing receiver or an explicit reset already settled this request.
        } else if (exchange != null && exchange.preempted) {
            pending.reject("ARTWORK_PREEMPTED", "Artwork request was preempted", error)
        } else {
            pending.reject("RFCOMM_ERROR", error.message, error)
        }
    }

    private fun connectSocket(
        candidate: BluetoothSocket, adapter: BluetoothAdapter, device: BluetoothDevice,
        normalizedId: String, pending: PendingRfcommRequest,
    ): BluetoothSocket {
        val connectExecutor = Executors.newSingleThreadExecutor { connectTask ->
            Thread(connectTask, "compas-rfcomm-connect").apply { isDaemon = true }
        }
        try {
            val connecting = connectExecutor.submit {
                synchronized(pairing.lock) {
                    if (pending.isSettled) throw IOException("Bluetooth request was cancelled")
                    pairing.requireBondedLocked(adapter, device, normalizedId)
                }
                candidate.connect()
            }
            try {
                connecting.get(15_000, TimeUnit.MILLISECONDS)
            } catch (timeout: TimeoutException) {
                connecting.cancel(true)
                throw SocketTimeoutException("Timed out connecting to Compás over Bluetooth").apply {
                    initCause(timeout)
                }
            }
            return candidate
        } catch (e: Exception) {
            runCatching { candidate.close() }
            throw ((e as? ExecutionException)?.cause ?: e)
        } finally {
            connectExecutor.shutdownNow()
        }
    }

    fun destroy() {
        synchronized(artworkLock) {
            activeArtworkExchanges.forEach { exchange ->
                exchange.preempted = true
                exchange.socket?.let { socket -> runCatching { socket.close() } }
            }
            activeArtworkExchanges.clear()
        }
        synchronized(linkLock) {
            links.values.forEach { link -> runCatching { link.socket.close() } }
            links.clear()
        }
        rfcommRequestExecutor.shutdownNow()
        pendingRfcommRequests.forEach { pending ->
            pending.socket?.let { socket -> runCatching { socket.close() } }
            pending.reject("MODULE_DESTROYED", "Bluetooth module was destroyed", null)
        }
        pendingRfcommRequests.clear()
    }

    fun rejectRfcommRequestsForDevice(
        deviceId: String,
        code: String,
        message: String
    ) {
        closeLink(normalizeDeviceId(deviceId))
        pendingRfcommRequests.filter { it.deviceId == normalizeDeviceId(deviceId) }.forEach { pending ->
            pending.reject(code, message, null)
            pending.socket?.let { runCatching { it.close() } }
        }
    }
}
