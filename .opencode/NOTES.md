# Sompas project hints

Fork of `Starnished66/compas-app` that speaks SonixLink instead of the Compás
player API. The firmware is **not** modified; the server already exists in
`../tempotec-v3-main-wt/sonix-player/src/system/remote/sonixlink.c`
(see `docs/SONIXLINK.md` in this repo for the endpoint map).

## Checks

- `npx tsc --noEmit` — the fastest signal; the whole port is typed.
- `npm run check:translations` — every new `t('…')` literal must also exist in
  all 14 catalogs (`src/i18n/catalogs/*.ts`). Missing keys are added with
  `Object.assign(<locale>, { … })` at the end of the file.

## Build (verified on this machine: `assembleDebug` succeeded)

- Android SDK: `~/android-sdk` (cmdline-tools, platform 37.0, build-tools 37.0.0,
  NDK 27.1.12297006, CMake 3.22.1). AGP looks for `platforms/android-37`,
  while sdkmanager installs `android-37.0`; a symlink `android-37 -> android-37.0`
  is required.
- JDK: the daemon runs on `/usr/lib/jvm/java-21-openjdk`; the Java 17
  *toolchain* is a Temurin JDK unpacked at `/home/alex/jdk17` (the system
  `java-17-openjdk` is a JRE). Pass
  `-Dorg.gradle.java.installations.paths=/home/alex/jdk17`. `java` itself
  points at 25, which AGP rejects.
- `dl.google.com` and Maven Central cut large downloads (TLS handshake or read
  timeout) on this network. `https://repo.huaweicloud.com/repository/maven/`
  mirrors both and delivered the 279 MB `react-android` AAR in ~25 s; an
  `init-fast3.gradle` init script puts it (and Google Storage / Aliyun) first.
  A local HTTP proxy listens on `127.0.0.1:2080` (mihomo mixed port).
- `npm ci` blocks Skia's postinstall (npm allowScripts); approve it or run
  `npm rebuild @shopify/react-native-skia` before a native build.
- `npx expo prebuild --platform android --no-install`, then
  `cd android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleDebug`.

## SonixLink quirks that cost time

- Commands address tracks by **path**; the UI uses numeric catalog ids. The
  downloaded `MEDIA_TABLE` index (`SonixIndex`) is the map.
- `GET /api/db` is a whole SQLite file, not pages. It is downloaded into the
  cache and opened read-only.
- Album playback value is `album + "\u001f" + album_key` (`ALBUM_VALUE_MATCH`).
- `GET /api/queue?from=n` may answer `pending:true` until the player's UI pump
  publishes that window; retry, do not treat it as an error.
- `/api/art` answers `202` while preparing and `404` when there is none.
- Bluetooth: the player keeps the RFCOMM link (30 s idle). The app's BT
  transport now keeps one socket and reconnects once for GETs only.
- Transfer mode is a separate thttpd on 4399; `create` refuses an existing
  folder, so the client probes `sonix-list` before failing.

## Verified against the real card

- `/mnt/sd_0/.local/library.db` (8.7 MB, 3341 tracks) has every column the port
  uses: `rowid`, `path`, `name`, `album`, `artist`, `album_artist`, `genre`,
  `dis_id`, `disc`, `album_key`, `ctime`. `ARTIST_LINK`/`GENRE_LINK` contain
  only the *split* names; the fallback to `artist`/`genre` is needed.
- The paths in the index and the Transfer CGI see the same `/mnt/sd_0/` prefix.
- SonixLink was off on the attached player (`[wireless] sonixlink = 0` in
  `/data/device_config.ini`), so the HTTP API has not been exercised live yet.
- `assembleRelease` additionally needs `react-android-0.86.3-release.aar` and
  `hermes-android-…-release.aar`; both were fetched from the Huawei mirror into
  `android/local-repo/` (with their `.pom`/`.module`), and
  `android/build.gradle` lists that repo before `google()`.

- The AP on this network does not forward the player's mDNS answers or its
  7801 broadcast beacons (host-side raw queries heard neither while HTTP on
  192.168.1.45:7800 worked). Discovery therefore includes a unicast /24 scan for
  TCP/7800 (`SubnetDiscovery.kt`) and a module-level MulticastLock.

## Bluetooth discovery (2026-11-26)

- The player is **inquiry-scannable only while its Bluetooth settings (or receiver)
  page is open**: `hciconfig hci0` shows `PSCAN` alone normally and `PSCAN ISCAN` with
  the page open, and bluez `Discoverable` in
  `/usr/var/lib/bluetooth/00:02:5B:00:A5:A5/settings` follows the same page
  (`btsettings.c:728/740`, `btreceiverpage.c:260/279`). `adb shell hciconfig hci0
  iscan|piscan|pscan` emulates it; use `piscan`, not `iscan` (it drops page scan,
  so SDP then fails).
- **The SDP UUID list of a bonded device is not trustworthy.** After pairing, the
  phone answers `ACTION_UUID` for `00:02:5B:00:A5:A5` with 3 UUIDs and no SonixLink
  (`remoteService=false`) although the player's own `sdptool browse local` lists the
  record; Android keeps the list cached from the moment of pairing (the player
  registers the profile late). Filtering discovery by that UUID alone hides the player
  forever.
- The reference client `com.mattiadoronzo.sonixlink` does not filter at all:
  `ConnectActivity.pickBluetooth()` takes `getBondedDevices()` and shows them, and
  `BluetoothTransport.open()` tries `createRfcommSocketToServiceRecord(UUID)` and, on
  failure, reflectively `createRfcommSocket(22)` (`CHANNEL = 22`, then
  `fetchUuidsWithSdp()` to refresh the cache). Its `Discovery` class is network-only
  (mDNS `_sonixlink._tcp.` + UDP 7801).
- Our app now mirrors both: `startDiscovery` seeds the remembered address
  (`PREF_BLUETOOTH_ID`/`PREF_BLUETOOTH_NAME`) and verifies it with SDP; when SDP
  verifies nothing, `emitPairedFallback()` offers bonded, non-LE, Audio/Video-class
  devices with `fallback: true`, and the JS listener accepts `verified || fallback`.
  `BluetoothRfcomm` falls back to channel 22 when the UUID socket fails (not yet
  exercised live — the successful connection used the UUID socket).
- Pairing needs only page scan, so it works once the address is known. The empty-state
  text tells the user to keep the player's Bluetooth page open for a cold search.
- Driving the phone: taps on the Connect screen are ignored while the app is
  auto-reconnecting, and the layout jumps by ~560 px each time the "CONNECTION FAILED"
  card appears/disappears. Re-dump `uiautomator` bounds immediately before every tap,
  and do not trust coordinates from an older dump.
- Release build + install (keeps data: release is signed with the debug keystore):
  `cd android && ANDROID_HOME=/home/alex/android-sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleRelease -Dorg.gradle.java.installations.paths=/home/alex/jdk17 --init-script init-fast3.gradle`,
  then `adb install -r android/app/build/outputs/apk/release/app-release.apk`. A warm
  daemon builds in 10-35 s.

## Live test (Realme RMX3357, 2026-11-22)

- Discovery failed only because `wifiDiscovery.endpoint()` still appended the
  Compás port **8899** to every advertisement; the events themselves (NSD, UDP
  beacon and the custom mDNS parser) all arrived. Never hardcode a port twice:
  `RemoteEndpoint.DEFAULT_PLAYER_PORT` is the single source.
- With that fixed, WiFi discovery lists "TempoTec V3" in ~2 s, connect works,
  and the library imports (93 albums / 3341 tracks) from the downloaded index.
  Now playing shows FLAC 24-bit/48 kHz; queue rows first appear as file names
  until the next queue refresh, because the queue was read before the index
  download finished.
- Native `Log.i("CompasDiscovery", …)` lines remain for diagnosing discovery
  (`scan … start`, `subnet scan: N hosts`, `mdns: player at …`).

## Album identity (2026-11-22)

- `MEDIA_TABLE.album_key` hashes the **album artist** (or folder), not the album
  title. Using it alone as the app's album key merged every album of one artist:
  Anacondaz showed 3 rows and 139 tracks landed in one of them. Albums are now
  keyed `album + "\u001f" + album_key` (the value `ALBUM_VALUE_MATCH` expects),
  so Anacondaz is 20 albums / 139 tracks and the library is 607 albums.
- The catalog revision carries `@2` (`INDEX_MAPPING_VERSION`) so existing
  installs re-import after a mapping change instead of keeping old rows.

## Artwork (2026-11-22)

- A row's picture is requested by its catalog id; a group's id is one
  representative track. That track often has no embedded picture even when
  another track of the same record does, so `RemoteApi` now tries the album's
  tracks first and the artist's after that (8 candidates) until `/api/art`
  answers, and remembers the path that worked.
- Store rows at 160 px (`max=160`); the player decodes faster and the photo is
  still sharp at list size. `/api/art` answers 202 until its worker finishes,
  so the wait is 25 × 200 ms rather than 2 s.
