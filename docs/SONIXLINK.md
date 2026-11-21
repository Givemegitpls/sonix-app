# SonixLink, as this app speaks it

The player's API is documented in its own source:
`sonix-player/src/system/remote/sonixlink.h` (endpoints and semantics),
`sonixlink_bt.c` (RFCOMM profile) and `src/system/net/wifitransfer.c` +
`web/build/index.html` (Transfer mode). This file records how the app's
`RemoteApi` maps onto it, and what it cannot express.

## Transport and discovery

| What | Sonix | Compás (upstream) |
|---|---|---|
| HTTP port | 7800 | 8899 |
| Bluetooth | RFCOMM profile `8d6e3a52-4c1f-4b7e-9a2d-5f0c7e1b3a90`, channel 22, keep-alive | own UUID, one socket per request |
| mDNS | `_sonixlink._tcp.local` | `_compas-remote._tcp.local` |
| UDP | passive beacons on 7801: `SONIXLINK1 <ip> <port> <name>` | request/response on 8899 |
| Auth | none | PIN header |

The Bluetooth link is kept open between requests (the player closes it after
30 s idle); a lost link is reconnected and idempotent GETs are retried once.

## Endpoint map

| `RemoteApi` call | SonixLink |
|---|---|
| `capabilities()` | `GET /api/info` (`api`, `serial`/`name`, index stamps) |
| `status()` | `GET /api/state` |
| `togglePlayback/next/previous/seek/volume/mode` | `POST /api/command?do=…` |
| `play(index, context)` | `POST /api/command?do=play_path&path=&list=&value=` |
| `addToQueue(index)` | `POST /api/command?do=queue_next` (path in body) |
| `queue()` | `GET /api/queue?from=` |
| `removeFromQueue/moveQueueTrack/playQueueTrack` | `POST /api/command?do=queue_remove|queue_move|queue_index` |
| `art()` / `downloadArt()` | `GET /api/art?path=&max=&index=` (202 = still preparing) |
| `favoriteStates/setFavorite` | `GET /api/favourites`, `do=favourite` |
| `recent()` | `GET /api/history` |
| `playlists/playlistPage` | `GET /api/playlists`, `GET /api/playlist`; `@favorites` → `/api/favourites` |
| `addToPlaylist/createPlaylist` | `do=playlist_add` (path body) |
| `removePlaylistTrack` | `do=playlist_remove` (path body) |
| `folderRoots/folder` | `GET /api/browse` |
| `playFolderTrack` | `do=play_path&list=folder` |
| `catalog()` | the downloaded `GET /api/db` (SQLite), paged from `MEDIA_TABLE` |
| `catalogCovers()` | empty manifest; covers are read per track from `/api/art` |
| `import*` | the Transfer server's CGIs (below) |

## Library index

`GET /api/db` is the player's own SQLite file. The app downloads it to its cache
directory and opens it read-only with `expo-sqlite`; `catalog()` pages
`MEDIA_TABLE` ordered by `rowid`, which becomes the app's song id.

- `dis_id` is the track number, `disc` the disc, `album_key` the record's key
  (see `album_key()` in `src/system/library/library.c`).
- Split artist names come from `ARTIST_LINK` when the player wrote one.
- Address ↔ path: commands are paths, the UI is indices. `SonixIndex` keeps the
  map; a queue entry or playlist row resolves its numeric id by path.
- An album is addressed by name **and** key (`name\u001fkey`), which is what
  `ALBUM_VALUE_MATCH` expects and what keeps two "Greatest Hits" apart.
- Over Bluetooth the index is downloaded in memory; it is refused above 48 MB,
  and the Compás sync policy only lets it run while playback is paused. That
  download owns the single RFCOMM link for its duration, so status polling and
  commands wait behind it — connect over Wi-Fi for the first sync of a large
  card.

## Transfer mode

Transfer is a different server, alive only while the mode is on: thttpd on 4399
(and 80 under the player's `.local` name), with the firmware's own CGIs.

| App call | CGI |
|---|---|
| `importStatus()` | `GET sonix-list?path=/mnt/sd_0` (a probe) |
| `importFiles(path, offset, limit)` | `GET sonix-list?path=/mnt/sd_0/<path>[&hidden=1]`, paged client-side |
| `uploadImportFile()` | `POST upload`, multipart `path` + `files[]` |
| `createImportDirectory()` | `POST create`, form `path` |
| `renameImportFile()` | `POST move`, form `oldPath`, `newPath` |
| `deleteImportFile()` | `POST delete`, form `path` |
| `startImport()` | impossible remotely: explains where to switch it on |
| `stopImport()` | no-op; the player owns the mode |

Paths in this app stay card-relative; the client adds `/mnt/sd_0/`. An existing
folder is accepted even when `create` refuses it.

## Differences the interface has to respect

- Modes are `normal|repeat_all|repeat_one|shuffle|shuffle_repeat`; Compás's
  numeric modes map as 0,1,2,4,3.
- Playlists are M3U tables on the player. They are created by the first track
  added; rename, delete, import and reorder have no command.
- Queue edits only apply after the current track, and are dropped when the
  queue revision moved on.
- Collections (`play_all`) exist, but Compás's asynchronous collection jobs do
  not, so the `collection_playback` feature is not advertised.
- Withdrawal of the card closes the index (the player does the same via
  `sonixlink_forget_card()`); the next sync re-downloads it.
