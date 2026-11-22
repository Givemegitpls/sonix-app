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
