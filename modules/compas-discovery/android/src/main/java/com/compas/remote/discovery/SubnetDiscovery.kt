package com.compas.remote.discovery

import java.net.Inet4Address
import java.net.InetAddress
import android.util.Log
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Finds a SonixLink player without multicast.
 *
 * mDNS and the player's UDP beacon both rely on the access point forwarding
 * group traffic. Plenty of home routers drop it (or isolate wireless clients
 * from each other's broadcasts); unicast to the player's address always works,
 * which is why typing the address by hand does. This walks the local /24 and
 * tries TCP/7800, so the player appears in the list even then.
 */
internal class SubnetDiscovery(private val sendEvent: (String, Map<String, Any?>) -> Unit) {
    private val generation = AtomicLong()
    private var worker: Thread? = null

    fun start(scanId: Double) {
        stop()
        val current = generation.incrementAndGet()
        val thread = Thread({ scan(current, scanId) }, "compas-subnet-discovery").apply { isDaemon = true }
        synchronized(this) { worker = thread }
        thread.start()
    }

    fun stop() {
        generation.incrementAndGet()
        synchronized(this) {
            worker?.interrupt()
            worker = null
        }
    }

    private fun scan(current: Long, scanId: Double) {
        val hosts = hostsOnLocalNetworks()
        Log.i(TAG, "subnet scan: ${hosts.size} hosts")
        if (hosts.isEmpty()) return
        val pool = Executors.newFixedThreadPool(16) { task ->
            Thread(task, "compas-subnet-probe").apply { isDaemon = true }
        }
        val found = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        try {
            val tasks = hosts.map { host ->
                pool.submit {
                    if (generation.get() != current || Thread.currentThread().isInterrupted) return@submit
                    if (reachable(host)) {
                        if (found.add(host) && generation.get() == current) {
                            Log.i(TAG, "subnet scan: player at $host")
                            sendEvent("onDeviceFound", mapOf(
                                "scanId" to scanId,
                                "id" to "scan:$host",
                                "name" to "Sonix player",
                                "host" to host,
                                "port" to 7800,
                                "address" to "$host:7800",
                                "apiVersion" to "1",
                            ))
                        }
                    }
                }
            }
            tasks.forEach { runCatching { it.get(6, TimeUnit.SECONDS) } }
        } finally {
            Log.i(TAG, "subnet scan done: found ${found.size}")
            pool.shutdownNow()
            synchronized(this) { if (generation.get() == current) worker = null }
        }
    }

    private fun reachable(host: String): Boolean {
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, 7800), PROBE_TIMEOUT_MS)
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Every /24 we may reach: the phone's own interfaces, the default gateways
     * (a player can be routed from another subnet), and whatever is already in
     * the ARP table (hosts on the same L2 even under a wider prefix).
     */
    private fun hostsOnLocalNetworks(): List<String> {
        val hosts = LinkedHashSet<String>()
        val bases = LinkedHashSet<Int>()
        val known = LinkedHashSet<String>()
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return emptyList()
            for (iface in java.util.Collections.list(interfaces)) {
                if (!iface.isUp || iface.isLoopback) continue
                val name = iface.name.lowercase()
                // Only the LAN: cellular (ccmni) and a VPN tun are not where a
                // player answers, and scanning them wastes the whole window.
                if (!(name.startsWith("wlan") || name.startsWith("eth") ||
                        name.startsWith("wifi") || name.startsWith("ap"))) continue
                for (address in iface.interfaceAddresses) {
                    val ip = address.address as? Inet4Address ?: continue
                    if (ip.isLoopbackAddress || ip.isLinkLocalAddress) continue
                    val value = toInt(ip)
                    known.add(ip.hostAddress ?: continue)
                    bases.add(value and 0xffffff00.toInt())
                }
            }
        } catch (_: Exception) {
            // No interfaces we can enumerate: discovery is simply quiet.
        }
        for (gateway in readGateways()) {
            bases.add(toInt(gateway) and 0xffffff00.toInt())
        }
        // ARP entries are known to exist and are probed first.
        hosts.addAll(readArp())
        for (base in bases) {
            for (last in 1..254) {
                val value = base or last
                val host = "${(value ushr 24) and 0xff}.${(value ushr 16) and 0xff}.${(value ushr 8) and 0xff}.${value and 0xff}"
                if (host !in known) hosts.add(host)
            }
        }
        hosts.removeAll(known)
        return hosts.toList()
    }

    private fun toInt(ip: Inet4Address): Int {
        val b = ip.address
        return (b[0].toInt() and 0xff) shl 24 or (b[1].toInt() and 0xff) shl 16 or
            (b[2].toInt() and 0xff) shl 8 or (b[3].toInt() and 0xff)
    }

    /** The default route's gateway, parsed from /proc/net/route as little-endian hex. */
    private fun readGateways(): List<Inet4Address> {
        val gateways = ArrayList<Inet4Address>()
        try {
            java.io.File("/proc/net/route").forEachLine { line ->
                val parts = line.trim().split(Regex("\\s+"))
                if (parts.size < 3 || parts[0] == "Iface") return@forEachLine
                if (parts[1] != "00000000") return@forEachLine
                val hex = parts[2]
                if (hex.length != 8) return@forEachLine
                val bytes = ByteArray(4)
                for (i in 0..3) {
                    bytes[i] = Integer.parseInt(hex.substring((3 - i) * 2, (3 - i) * 2 + 2), 16).toByte()
                }
                if (bytes.all { it == 0.toByte() }) return@forEachLine
                gateways.add(InetAddress.getByAddress(bytes) as Inet4Address)
            }
        } catch (_: Exception) {
            // No route table access; the interface pass already ran.
        }
        return gateways
    }

    private fun readArp(): List<String> {
        val hosts = ArrayList<String>()
        try {
            java.io.File("/proc/net/arp").forEachLine { line ->
                val columns = line.trim().split(Regex("\\s+"))
                if (columns.size < 4 || columns[0] == "IP") return@forEachLine
                if (columns[0].count { it == '.' } == 3 && columns[3] != "00:00:00:00:00:00") hosts.add(columns[0])
            }
        } catch (_: Exception) {
            // ARP is optional; the subnet pass is the main one.
        }
        return hosts
    }

    private companion object {
        const val PROBE_TIMEOUT_MS = 500
        const val TAG = "CompasDiscovery"
    }
}
