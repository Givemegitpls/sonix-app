package com.compas.remote.discovery

import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import android.util.Log
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicLong

/**
 * A small mDNS client for `_sonixlink._tcp`.
 *
 * Android's NsdManager resolves the service by following the SRV target and its
 * A record. The player derives that target from the device name, which here is
 * "TempoTec V3", so the record is `TempoTec V3.local` — a name with a space in
 * it. NsdManager will not resolve it, and no event is delivered even though the
 * service is being announced. This reads the same packets itself and uses the
 * packet's source address as the player's host, so the malformed A record does
 * not matter.
 */
internal class MdnsDiscovery(private val sendEvent: (String, Map<String, Any?>) -> Unit) {
    private val generation = AtomicLong()
    private var worker: Thread? = null

    fun start(scanId: Double) {
        stop()
        val current = generation.incrementAndGet()
        val thread = Thread({ run(current, scanId) }, "compas-mdns").apply { isDaemon = true }
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

    private fun run(current: Long, scanId: Double) {
        val iface = wifiInterface() ?: return
        val socket = try {
            MulticastSocket(null as java.net.SocketAddress?).apply {
                reuseAddress = true
                bind(InetSocketAddress(5353))
                timeToLive = 255
                joinGroup(InetSocketAddress(InetAddress.getByName(GROUP), 5353), iface)
                soTimeout = 500
            }
        } catch (e: Exception) {
            // The system responder owns the port on some builds; NSD and the
            // subnet scan still run.
            Log.i("CompasDiscovery", "mdns: cannot listen on 5353: ${e.message}")
            return
        }
        Log.i("CompasDiscovery", "mdns: listening on ${iface.name}")

        val query = queryPacket()
        val seen = HashSet<String>()
        var no = 0L
        var lastQuery = 0L
        try {
            while (generation.get() == current && !Thread.currentThread().isInterrupted) {
                val now = System.currentTimeMillis()
                if (no < 10 && now - lastQuery >= 1500) {
                    lastQuery = now
                    no++
                    runCatching { socket.send(DatagramPacket(query, query.size, InetAddress.getByName(GROUP), 5353)) }
                }
                val buffer = ByteArray(9000)
                val packet = DatagramPacket(buffer, buffer.size)
                try {
                    socket.receive(packet)
                } catch (_: java.net.SocketTimeoutException) {
                    continue
                }
                if (generation.get() != current) break
                parse(packet.data, packet.length, packet.address, scanId, seen)
            }
        } catch (_: Exception) {
            // Discovery is best effort.
        } finally {
            runCatching { socket.leaveGroup(InetSocketAddress(InetAddress.getByName(GROUP), 5353), iface) }
            runCatching { socket.close() }
            synchronized(this) { if (generation.get() == current) worker = null }
        }
    }

    private fun wifiInterface(): NetworkInterface? {
        return try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return null
            java.util.Collections.list(interfaces).firstOrNull { iface ->
                iface.isUp && !iface.isLoopback &&
                    java.util.Collections.list(iface.inetAddresses).any { it is Inet4Address && !it.isLinkLocalAddress }
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun queryPacket(): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun u16(value: Int) {
            out.write((value ushr 8) and 0xff)
            out.write(value and 0xff)
        }
        u16(0) // id
        u16(0) // flags: query
        u16(1) // questions
        u16(0); u16(0); u16(0)
        writeName(out, SERVICE)
        u16(12) // PTR
        u16(1)  // IN
        return out.toByteArray()
    }

    private fun parse(data: ByteArray, length: Int, source: InetAddress, scanId: Double, seen: MutableSet<String>) {
        if (length < 12) return
        val qd = readU16(data, 4)
        val an = readU16(data, 6)
        val ns = readU16(data, 8)
        val ar = readU16(data, 10)
        var at = 12
        repeat(qd) {
            val name = readName(data, length, at) ?: return
            at = name.second + 4
        }
        val records = ArrayList<Record>()
        repeat(an + ns + ar) {
            val name = readName(data, length, at) ?: return
            at = name.second
            if (at + 10 > length) return
            val type = readU16(data, at)
            val klass = readU16(data, at + 2)
            val rdLength = readU16(data, at + 8)
            at += 10
            if (at + rdLength > length) return
            if (klass and 0x7fff == 1) {
                records.add(Record(name.first, type, at, rdLength))
            }
            at += rdLength
        }

        val names = HashMap<String, String>()
        val ports = HashMap<String, Int>()
        val addresses = HashMap<String, InetAddress>()
        for (record in records) {
            when (record.type) {
                12 -> { // PTR
                    val target = readName(data, length, record.offset)?.first
                    if (target != null) names[record.name] = target
                }
                33 -> { // SRV
                    if (record.offset + 6 <= length) {
                        ports[record.name] = readU16(data, record.offset + 4)
                        val target = readName(data, length, record.offset + 6)?.first
                        if (target != null) names["srv:${record.name}"] = target
                    }
                }
                1 -> { // A
                    if (record.dataLength == 4) {
                        addresses[record.name] = InetAddress.getByAddress(data.copyOfRange(record.offset, record.offset + 4))
                    }
                }
                28 -> { // AAAA
                    if (record.dataLength == 16) {
                        addresses[record.name] = InetAddress.getByAddress(data.copyOfRange(record.offset, record.offset + 16))
                    }
                }
            }
        }

        for (record in records) {
            if (record.type != 12 || !record.name.equals(SERVICE, ignoreCase = true)) continue
            val instance = names[record.name] ?: continue
            if (!instance.endsWith(".$SERVICE", ignoreCase = true)) continue
            val port = ports[instance] ?: continue
            val srvTarget = names["srv:$instance"]
            val host = (srvTarget?.let { addresses[it] }) ?: source
            val id = "${host.hostAddress}:$port"
            if (!seen.add(id)) continue
            val name = instance.dropLast(SERVICE.length + 1)
            Log.i("CompasDiscovery", "mdns: player at $id ($name)")
            sendEvent("onDeviceFound", mapOf(
                "scanId" to scanId,
                "id" to "mdns:$id",
                "name" to name,
                "host" to host.hostAddress,
                "port" to port,
                "address" to "${host.hostAddress}:$port",
                "apiVersion" to "1",
            ))
        }
    }

    private data class Record(val name: String, val type: Int, val offset: Int, val dataLength: Int)

    private fun readU16(data: ByteArray, at: Int): Int {
        if (at + 1 >= data.size) return 0
        return ((data[at].toInt() and 0xff) shl 8) or (data[at + 1].toInt() and 0xff)
    }

    /** Returns the name and the offset just past it. */
    private fun readName(data: ByteArray, length: Int, start: Int): Pair<String, Int>? {
        val out = StringBuilder()
        var at = start
        var after = -1
        var hops = 0
        while (at in 0 until length) {
            val len = data[at].toInt() and 0xff
            if (len == 0) {
                if (after < 0) after = at + 1
                return out.toString() to after
            }
            if (len and 0xc0 == 0xc0) {
                if (at + 1 >= length) return null
                val pointer = ((len and 0x3f) shl 8) or (data[at + 1].toInt() and 0xff)
                if (after < 0) after = at + 2
                if (hops++ > 16 || pointer >= length) return null
                at = pointer
                continue
            }
            at++
            if (at + len > length) return null
            if (out.isNotEmpty()) out.append('.')
            out.append(String(data, at, len, StandardCharsets.UTF_8))
            at += len
        }
        return null
    }

    private fun writeName(out: java.io.ByteArrayOutputStream, name: String) {
        for (label in name.split('.')) {
            if (label.isEmpty()) continue
            out.write(label.length)
            out.write(label.toByteArray(StandardCharsets.US_ASCII))
        }
        out.write(0)
    }

    private companion object {
        const val GROUP = "224.0.0.251"
        const val SERVICE = "_sonixlink._tcp.local"
    }
}
