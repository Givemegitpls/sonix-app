# Sompas

A fork of [Compás Remote](https://github.com/Starnished66/compas-app) that talks to the
**Sonix** player firmware instead of the Compás player.

The interface, the session layer and the Android application are Compás's. What changed is
the protocol underneath: the player is addressed through **SonixLink**, the HTTP/JSON API
that the Sonix firmware already ships (`sonix-player/src/system/remote/sonixlink.c`), over
Wi-Fi or Bluetooth RFCOMM. **No firmware change is needed or made.**

## What works

- Connect over Wi-Fi (port 7800) or Bluetooth (SonixLink's RFCOMM profile, channel 22).
- Discovery by mDNS `_sonixlink._tcp`, by the player's UDP beacon on port 7801,
  and by a unicast scan of the local /24 for TCP/7800 when the access point
  drops multicast or broadcast traffic (which is what makes typing the IP by
  hand work while discovery does not).
- Playback: play/pause/next/previous, seek, volume, play mode, favourites.
- Library: the player's own SQLite index is downloaded once (`/api/db`) and queried on the
  phone, so browsing, search, albums, artists, genres and album artists behave as they do
  in Compás.
- Folder browsing from the card.
- Queue: paging, play, remove, move, add next.
- Playlists: read, add tracks, remove tracks, create by adding the first track.
- Recently played and favourites from the player's history and stars.
- Artwork from the player, decoded and cached on the phone.
- Transfer: when the player's **Transfer** mode is on (its own web server on port 4399), the
  Transfer tab browses the card and can upload, create folders, rename and delete files
  through the firmware's own CGI programs.

## What is hidden, because SonixLink has no answer

- Track ratings, server-side library sorting, player settings, plugins/layouts.
- Renaming, deleting, importing and reordering playlists (`Move earlier`/`Move later`).
- Clearing the whole queue (the player only removes entries after the one playing).
- The Compás release/update feed: this fork has no feed of its own and must not offer the
  upstream APK, so update checks report nothing.

## Enabling it on the player

1. On the player, turn on **SonixLink** (Wireless section). That is the Wi-Fi/BT remote API.
2. For file transfer, also open **Transfer**; it is a separate mode with its own web server.
3. In the app, find the player on the same network, or pair it over Bluetooth first.

## Build

```sh
npm ci
npx expo prebuild --platform android
cd android && ./gradlew assembleDebug
```

Release signing is inherited from Compás: see `docs/android-releases.md`. The fork has its
own application id (`com.sompas.remote`) and version, so it installs alongside Compás.

## Where the port lives

- `src/data/sonix/SonixLinkClient.ts` — the wire: every `/api/*` endpoint.
- `src/data/sonix/SonixIndex.ts` — the downloaded SQLite index and the path ↔ index map.
- `src/data/sonix/SonixTransferClient.ts` — the Transfer server's CGI interface.
- `src/data/sonix/SonixMapping.ts` — features, play modes, status and codec mapping.
- `src/data/RemoteApi.ts` — the app-facing surface, answered by SonixLink.
- `docs/SONIXLINK.md` — the endpoint map and the semantics that differ.

## Licence

MIT, as upstream. See `LICENSE`.
