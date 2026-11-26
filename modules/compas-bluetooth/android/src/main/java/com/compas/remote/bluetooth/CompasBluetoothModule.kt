package com.compas.remote.bluetooth

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

val SONIXLINK_BT_UUID: UUID = UUID.fromString("8d6e3a52-4c1f-4b7e-9a2d-5f0c7e1b3a90")

// The protocol fixes the RFCOMM channel; the reference client falls back to it when the
// phone's cached SDP list has no SonixLink record to resolve the UUID against.
internal const val SONIXLINK_BT_CHANNEL = 22

class CompasBluetoothModule : Module() {
    private val context: Context
        get() = appContext.reactContext ?: throw IllegalStateException("React context is unavailable")

    private val bluetoothAdapter: BluetoothAdapter?
        get() = adapterFor(context)

    private fun adapterFor(context: Context): BluetoothAdapter? =
        context.getSystemService(BluetoothManager::class.java)?.adapter ?: BluetoothAdapter.getDefaultAdapter()

    @Volatile private var destroyed = false
    private val pairing = BluetoothPairing({ context }, { bluetoothAdapter }, { destroyed }, ::rejectRfcommRequests)
    private val rfcomm = BluetoothRfcomm({ bluetoothAdapter }, pairing) { destroyed }
    private val discovery = BluetoothDiscovery(
        { context }, { bluetoothAdapter }, ::adapterFor, { destroyed }, pairing::clearPendingPairing,
    ) { event, payload -> sendEvent(event, payload) }

    private fun rejectRfcommRequests(id: String, code: String, message: String) {
        rfcomm.rejectRfcommRequestsForDevice(id, code, message)
    }

    override fun definition() = ModuleDefinition {
        Name("CompasBluetooth")

        Events("onDeviceFound", "onBondStateChanged", "onDiscoveryFinished")

        AsyncFunction("getBondedDevices") { promise: Promise ->
            getBondedDevices(promise)
        }

        AsyncFunction("startDiscovery") { scanId: Double, knownId: String?, knownName: String?, promise: Promise ->
            discovery.requestDiscovery(scanId, knownId, knownName, promise)
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("stopDiscovery") { promise: Promise ->
            try {
                if (!destroyed) discovery.stopDiscoveryRequest()
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("STOP_DISCOVERY_FAILED", e.message, e)
            }
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("pairDevice") { deviceId: String, promise: Promise ->
            pairing.pairDevice(deviceId, promise)
        }

        AsyncFunction("preemptArtwork") { index: Double?, promise: Promise ->
            rfcomm.preemptArtwork(index, promise)
        }

        AsyncFunction("resetPairingBlock") { deviceId: String, promise: Promise ->
            pairing.resetPairingBlock(deviceId, promise)
        }

        AsyncFunction("executeRfcommRequest") { deviceId: String, method: String, target: String, headers: Map<String, String>?, isArtwork: Boolean, artworkIndex: Double?, bodyBase64: String?, promise: Promise ->
            rfcomm.execute(deviceId, method, target, headers, isArtwork, artworkIndex, bodyBase64, promise)
        }

        OnDestroy {
            pairing.destroy { destroyed = true }
            discovery.destroyOnMain()
            rfcomm.destroy()
        }
    }

    private fun getBondedDevices(promise: Promise) {
        try {
            val adapter = bluetoothAdapter
            if (adapter == null) {
                promise.resolve(emptyList<Map<String, Any>>())
                return
            }
            val bonded = adapter.bondedDevices.orEmpty()
                .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name.orEmpty() })
                .map { device ->
                    mapOf(
                        "id" to device.address,
                        "name" to (device.name ?: device.address),
                        "paired" to true,
                        "bonding" to false
                    )
                }
            promise.resolve(bonded)
        } catch (e: Exception) {
            promise.reject("BLUETOOTH_ERROR", e.message, e)
        }
    }
}
