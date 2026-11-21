package com.compas.remote.discovery

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.SocketException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicLong

// SonixLink announces itself rather than answering: a UDP datagram to port
// 7801 every two seconds, `SONIXLINK1 <ip> <port> <name>`
// (send_beacon() in sonixlink.c). Nothing is sent in return; this listens.
private const val BEACON_PORT = 7801
private const val DEFAULT_PORT = 7800
private const val BEACON_WINDOW_MS = 5_000L
private const val PREFIX = "SONIXLINK1 "

internal class UdpDiscovery(private val sendEvent: (String, Map<String, Any?>) -> Unit) {
    private val udpGeneration = AtomicLong(0)
    private val udpLifecycleLock = Any()
    @Volatile private var udpSocket: DatagramSocket? = null
    @Volatile private var udpWorker: Thread? = null

    fun restart(scanId: Double) {
        stop()
        synchronized(udpLifecycleLock) {
            val generation = udpGeneration.incrementAndGet()
            val worker = Thread({ runBeaconListener(generation, scanId) }, "compas-udp-discovery").apply {
                isDaemon = true
            }
            udpWorker = worker
            worker.start()
        }
    }

    private fun runBeaconListener(generation: Long, scanId: Double) {
        val socket = openSocket(generation) ?: return
        val deadline = android.os.SystemClock.elapsedRealtime() + BEACON_WINDOW_MS
        val seen = HashSet<String>()
        val buffer = ByteArray(1024)
        try {
            while (udpGeneration.get() == generation && !Thread.currentThread().isInterrupted) {
                val left = deadline - android.os.SystemClock.elapsedRealtime()
                if (left <= 0) break
                socket.soTimeout = minOf(500L, left).toInt().coerceAtLeast(1)
                val packet = DatagramPacket(buffer, buffer.size)
                try {
                    socket.receive(packet)
                } catch (_: SocketTimeoutException) {
                    continue
                } catch (_: SocketException) {
                    break
                }

                val source = packet.address as? Inet4Address ?: continue
                if (!isUsableLanIpv4(source)) continue
                val text = String(packet.data, 0, packet.length, StandardCharsets.UTF_8).trim()
                if (!text.startsWith(PREFIX)) continue
                // "<ip> <port> <name...>": the name may contain spaces.
                val rest = text.substring(PREFIX.length)
                val firstSpace = rest.indexOf(' ')
                if (firstSpace <= 0) continue
                val host = rest.substring(0, firstSpace)
                val afterHost = rest.substring(firstSpace + 1)
                val secondSpace = afterHost.indexOf(' ')
                val port = (if (secondSpace < 0) afterHost else afterHost.substring(0, secondSpace))
                    .toIntOrNull() ?: DEFAULT_PORT
                val name = if (secondSpace < 0) "Sonix player" else afterHost.substring(secondSpace + 1).trim()
                    .ifEmpty { "Sonix player" }
                if (!host.matches(Regex("^\\d{1,3}(\\.\\d{1,3}){3}$"))) continue
                if (!seen.add(host)) continue
                if (udpGeneration.get() != generation || Thread.currentThread().isInterrupted) break

                sendEvent("onDeviceFound", mapOf(
                    "scanId" to scanId,
                    "id" to "udp:$host",
                    "name" to name,
                    "host" to host,
                    "port" to port,
                    "address" to "$host:$port",
                    "apiVersion" to "1",
                ))
            }
        } catch (_: Exception) {
            // Discovery is best effort; DNS-SD remains active alongside it.
        } finally {
            socket.close()
            clearUdpWorker(generation, socket)
        }
    }

    private fun openSocket(generation: Long): DatagramSocket? {
        val socket = try {
            DatagramSocket(null).apply {
                reuseAddress = true
                broadcast = true
                bind(java.net.InetSocketAddress(BEACON_PORT))
                soTimeout = 500
            }
        } catch (_: Exception) {
            clearUdpWorker(generation, null)
            return null
        }
        synchronized(udpLifecycleLock) {
            if (udpGeneration.get() != generation) {
                socket.close()
                return null
            }
            udpSocket = socket
        }
        return socket
    }

    private fun isUsableLanIpv4(address: Inet4Address): Boolean {
        if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isMulticastAddress) return false
        val bytes = address.address.map { it.toInt() and 0xff }
        return bytes[0] == 10 ||
            (bytes[0] == 172 && bytes[1] in 16..31) ||
            (bytes[0] == 192 && bytes[1] == 168) ||
            (bytes[0] == 169 && bytes[1] == 254)
    }

    private fun clearUdpWorker(generation: Long, socket: DatagramSocket?) {
        synchronized(udpLifecycleLock) {
            if (udpGeneration.get() == generation && (socket == null || udpSocket === socket)) {
                udpSocket = null
                udpWorker = null
            }
        }
    }

    fun stop() {
        synchronized(udpLifecycleLock) {
            udpGeneration.incrementAndGet()
            udpSocket?.close()
            udpSocket = null
            udpWorker?.interrupt()
            udpWorker = null
        }
    }
}
