// The player's library index, as the app needs it.
//
// SonixLink does not page the library over the wire: `GET /api/db` is the
// player's own SQLite file (MEDIA_TABLE and friends, see
// `sonix-player/src/system/library/library.c`). The phone downloads it once,
// keeps it in the cache directory and answers `catalog()` pages from it, which
// is exactly the shape `src/session/catalogSync.ts` already knows how to store.
//
// The same file is the bridge between the two worlds the player speaks: its
// commands are addressed by *path*, while the app's UI addresses tracks by the
// numeric index from the catalog. `pathForId` and `rowsForPaths` are that
// bridge.

import * as FileSystem from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { CatalogSong, LibraryFilter, LibraryGroup, Song } from '../types';
import type { SonixLinkClient, SonixInfo } from './SonixLinkClient';
import { remoteApiLibraryId } from './SonixMapping';

const INDEX_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Larger than any real card index; protects the JS heap when the only transport
// is Bluetooth and the body cannot stream to a file.
const MAX_MEMORY_INDEX_BYTES = 48 * 1024 * 1024;
const PATH_CHUNK = 400;
// Bumped when the mapping from MEDIA_TABLE to the app's catalog changes, so
// existing installs re-import instead of keeping rows written by an older map.
const INDEX_MAPPING_VERSION = 2;

interface MediaRow {
  id: number;
  path: string;
  name: string | null;
  album: string | null;
  artist: string | null;
  album_artist: string | null;
  genre: string | null;
  dis_id: number | null;
  disc: number | null;
  album_key: string | null;
  ctime: number | null;
}

export interface SongPathRow {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  trackNumber: number | null;
  discNumber: number | null;
  albumKey: string | null;
}

function safePart(text: string): string {
  return (text || 'player').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'player';
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pathName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function toSongRow(row: MediaRow): SongPathRow {
  return {
    id: Number(row.id),
    path: row.path,
    title: string(row.name) || pathName(row.path),
    artist: string(row.artist),
    album: string(row.album),
    albumArtist: string(row.album_artist),
    genre: string(row.genre),
    trackNumber: positive(row.dis_id),
    discNumber: positive(row.disc),
    albumKey: row.album_key ? string(row.album_key) : null,
  };
}

/**
 * A record is its name *and* whose it is: the player's `album_key` hashes the
 * album artist (or folder), not the album title, so all albums by one artist
 * share it. Grouping the app's catalog by the bare key would merge them; the
 * separator is the one `ALBUM_VALUE_MATCH` expects in the firmware.
 */
export function albumIdentity(row: Pick<SongPathRow, 'album' | 'albumKey'>): string | null {
  return row.albumKey ? `${row.album}\u001f${row.albumKey}` : null;
}

function toCatalogSong(row: SongPathRow, artists: string[], genres: string[] = []): CatalogSong {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumArtist: row.albumArtist,
    // The split names the player wrote are better than its raw tag: the app
    // splits on `;` again when it files the genre rows.
    genre: genres.length ? genres.join('; ') : row.genre,
    trackNumber: row.trackNumber,
    discNumber: row.discNumber,
    albumKey: albumIdentity(row),
    artists: artists.length ? artists : row.artist ? [row.artist] : [],
  };
}

export class SonixIndex {
  private db: SQLiteDatabase | null = null;
  private fileUri: string | null = null;
  private revision: string | null = null;
  private seenRevision: string | null = null;
  private columns = new Set<string>();
  private preparing: Promise<void> | null = null;
  private info: SonixInfo | null = null;

  constructor(private readonly client: SonixLinkClient) {}

  get currentRevision(): string | null {
    return this.revision;
  }

  /** The revision `/api/info` currently advertises, whether or not it is downloaded. */
  static revisionOf(info: SonixInfo): string {
    return `${info.db_hash || `${info.db_mtime}-${info.db_size}`}@${INDEX_MAPPING_VERSION}`;
  }

  static libraryIdOf(info: SonixInfo): string {
    return remoteApiLibraryId(info);
  }

  /** Makes sure the index in memory is the one the player advertises right now. */
  async prepare(info: SonixInfo): Promise<void> {
    this.info = info;
    const revision = SonixIndex.revisionOf(info);
    this.seenRevision = revision;
    if (this.db && this.revision === revision) return;
    if (this.preparing) {
      await this.preparing;
      if (this.db && this.revision === revision) return;
    }
    this.preparing = this.load(info, revision).finally(() => {
      this.preparing = null;
    });
    await this.preparing;
  }

  /** True once `prepare` has a database open for the advertised revision. */
  get available(): boolean {
    return this.db != null;
  }

  private async load(info: SonixInfo, revision: string): Promise<void> {
    if (!info.db_available) throw new Error('The player has no library index yet. Scan the library on the player first.');
    if (info.scanning) throw new Error('The player is scanning its library. Try again when the scan is finished.');
    const directory = FileSystem.cacheDirectory;
    if (!directory) throw new Error('No cache directory is available for the player index');
    // FileSystem talks in URIs; SQLite's native open wants a filesystem path.
    const directoryPath = directory.replace(/^file:\/\//, '');

    const name = `sonix-${safePart(SonixIndex.libraryIdOf(info))}-${safePart(revision)}.sqlite`;
    const uri = `${directory}${name}`;
    const exists = await FileSystem.getInfoAsync(uri);
    if (!exists.exists) {
      if (!this.client.canStreamDownloads && (info.db_size ?? 0) > MAX_MEMORY_INDEX_BYTES) {
        throw new Error('The library index is too large for a Bluetooth connection. Connect over Wi-Fi once to download it.');
      }
      const partial = `${uri}.part`;
      await FileSystem.deleteAsync(partial, { idempotent: true });
      await this.client.download('/api/db', partial, INDEX_DOWNLOAD_TIMEOUT_MS);
      const downloaded = await FileSystem.getInfoAsync(partial);
      if (!downloaded.exists || (downloaded.size ?? 0) === 0) throw new Error('The player sent an empty library index');
      if (!this.client.canStreamDownloads && (downloaded.size ?? 0) > MAX_MEMORY_INDEX_BYTES) {
        await FileSystem.deleteAsync(partial, { idempotent: true });
        throw new Error('The library index is too large for a Bluetooth connection. Connect over Wi-Fi once to download it.');
      }
      await FileSystem.deleteAsync(uri, { idempotent: true });
      await FileSystem.moveAsync({ from: partial, to: uri });
    }

    await this.close();
    const { openDatabaseAsync } = require('expo-sqlite') as typeof import('expo-sqlite');
    const db = await openDatabaseAsync(name, { useNewConnection: true }, directoryPath);
    try {
      await db.execAsync('PRAGMA query_only = ON');
      const table = await db.getFirstAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'MEDIA_TABLE'"
      );
      if (!table) throw new Error('The player index has no MEDIA_TABLE');
      const infoRows = await db.getAllAsync<{ name: string }>('PRAGMA table_info(MEDIA_TABLE)');
      this.columns = new Set(infoRows.map((row) => row.name));
      this.db = db;
      this.fileUri = uri;
      this.revision = revision;
      await this.pruneOtherFiles(directory);
    } catch (error) {
      await db.closeAsync().catch(() => {});
      throw error;
    }
  }

  private async pruneOtherFiles(directory: string): Promise<void> {
    const prefix = `sonix-${safePart(this.info ? SonixIndex.libraryIdOf(this.info) : '')}-`;
    const keep = this.fileUri;
    const keepName = keep && keep.startsWith(directory) ? keep.slice(directory.length) : '';
    try {
      const names = await FileSystem.readDirectoryAsync(directory);
      await Promise.all(names
        // `-wal` and `-shm` belong to the database that is open; only the
        // other revisions' files may go.
        .filter((entry) => entry.startsWith(prefix) && !entry.startsWith(keepName))
        .map((entry) => FileSystem.deleteAsync(`${directory}${entry}`, { idempotent: true })));
    } catch {
      // Cache cleanup is best effort; a stale index costs space, not correctness.
    }
  }

  private column(name: string, fallback: string): string {
    return this.columns.has(name) ? name : `${fallback} AS ${name}`;
  }

  private get selectColumns(): string {
    return [
      'rowid AS id',
      'path',
      this.column('name', 'NULL'),
      this.column('album', 'NULL'),
      this.column('artist', 'NULL'),
      this.column('album_artist', 'NULL'),
      this.column('genre', 'NULL'),
      this.column('dis_id', 'NULL'),
      this.column('disc', 'NULL'),
      this.column('album_key', 'NULL'),
      this.column('ctime', 'NULL'),
    ].join(', ');
  }

  private async query<T>(sql: string, params: readonly (string | number | null)[] = []): Promise<T[]> {
    if (!this.db) throw new Error('The player index is not open');
    return this.db.getAllAsync<T>(sql, params as never[]);
  }

  private async first<T>(sql: string, params: readonly (string | number | null)[] = []): Promise<T | null> {
    if (!this.db) throw new Error('The player index is not open');
    return this.db.getFirstAsync<T>(sql, params as never[]);
  }

  async count(): Promise<number> {
    const row = await this.first<{ total: number }>(
      "SELECT COUNT(*) AS total FROM MEDIA_TABLE WHERE path IS NOT NULL AND path <> ''"
    );
    return Number(row?.total ?? 0);
  }

  async page(offset: number, limit: number): Promise<{ total: number; rows: SongPathRow[] }> {
    const total = await this.count();
    const rows = await this.query<MediaRow>(
      `SELECT ${this.selectColumns} FROM MEDIA_TABLE
       WHERE path IS NOT NULL AND path <> ''
       ORDER BY rowid LIMIT ?1 OFFSET ?2`,
      [limit, offset]
    );
    return { total, rows: rows.map(toSongRow) };
  }

  /** One catalog page, with the split artist names the library's Artists list uses. */
  async catalogPage(offset: number, limit: number): Promise<{ total: number; songs: CatalogSong[] }> {
    const { total, rows } = await this.page(offset, limit);
    const paths = rows.map((row) => row.path);
    // One connection: keep the statements sequential.
    const artists = await this.artistsForPaths(paths);
    const genres = await this.genresForPaths(paths);
    return {
      total,
      songs: rows.map((row) => toCatalogSong(row, artists.get(row.path) ?? [], genres.get(row.path) ?? [])),
    };
  }

  private async artistsForPaths(paths: readonly string[]): Promise<Map<string, string[]>> {
    return this.linkedNames('ARTIST_LINK', 'artist', paths);
  }

  private async genresForPaths(paths: readonly string[]): Promise<Map<string, string[]>> {
    return this.linkedNames('GENRE_LINK', 'genre', paths);
  }

  private async linkedNames(table: string, column: string, paths: readonly string[]): Promise<Map<string, string[]>> {
    const found = new Map<string, string[]>();
    if (!paths.length) return found;
    const hasTable = await this.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
      [table]
    );
    if (!hasTable) return found;
    for (let at = 0; at < paths.length; at += PATH_CHUNK) {
      const chunk = paths.slice(at, at + PATH_CHUNK);
      const marks = chunk.map((_, index) => `?${index + 1}`).join(', ');
      const rows = await this.query<{ path: string; name: string }>(
        `SELECT path, ${column} AS name FROM ${table} WHERE path IN (${marks}) ORDER BY path, ${column}`,
        chunk
      );
      for (const row of rows) {
        const list = found.get(row.path) ?? [];
        if (row.name && !list.includes(row.name)) list.push(row.name);
        found.set(row.path, list);
      }
    }
    return found;
  }

  async rowForId(id: number): Promise<SongPathRow | null> {
    const rows = await this.query<MediaRow>(
      `SELECT ${this.selectColumns} FROM MEDIA_TABLE WHERE rowid = ?1 LIMIT 1`,
      [id]
    );
    return rows.length ? toSongRow(rows[0]) : null;
  }

  /**
   * Paths worth asking for this row's artwork, best first: the album's tracks
   * (an embedded picture can live in only some of them), then the artist's.
   * The app tries each until the player has a picture.
   */
  private artPaths = new Map<number, string>();
  private artCandidates = new Map<number, string[]>();
  async artCandidatePaths(id: number, limit = 8): Promise<string[]> {
    const known = this.artPaths.get(id);
    if (known) return [known];
    const cached = this.artCandidates.get(id);
    if (cached) return cached;
    const row = await this.rowForId(id);
    if (!row) return [];
    const paths: string[] = [row.path];
    const add = (value: string | null): void => {
      if (value && !paths.includes(value)) paths.push(value);
    };
    if (row.album && this.columns.has('album_key')) {
      const rows = await this.query<{ path: string }>(
        `SELECT path FROM MEDIA_TABLE
         WHERE album = ?1 AND album_key = ?2 AND path IS NOT NULL AND path <> ''
         ORDER BY rowid LIMIT ?3`,
        [row.album, row.albumKey, Math.max(2, limit >> 1)]
      );
      rows.forEach((item) => add(item.path));
    }
    if (paths.length < limit && this.columns.has('artist') && row.artist) {
      const rows = await this.query<{ path: string }>(
        `SELECT path FROM MEDIA_TABLE
         WHERE artist = ?1 AND path IS NOT NULL AND path <> ''
         ORDER BY rowid LIMIT ?2`,
        [row.artist, limit]
      );
      rows.forEach((item) => add(item.path));
    }
    const list = paths.slice(0, limit);
    if (this.artCandidates.size > 2048) this.artCandidates.clear();
    this.artCandidates.set(id, list);
    return list;
  }

  rememberArtPath(id: number, path: string): void {
    if (this.artPaths.size > 2048) this.artPaths.clear();
    this.artPaths.set(id, path);
  }

  async pathForId(id: number): Promise<string | null> {
    const row = await this.first<{ path: string }>(
      'SELECT path FROM MEDIA_TABLE WHERE rowid = ?1 LIMIT 1',
      [id]
    );
    return row?.path ?? null;
  }

  async idForPath(path: string): Promise<number | null> {
    const row = await this.first<{ id: number }>(
      'SELECT rowid AS id FROM MEDIA_TABLE WHERE path = ?1 LIMIT 1',
      [path]
    );
    return row ? Number(row.id) : null;
  }

  async rowsForPaths(paths: readonly string[]): Promise<Map<string, SongPathRow>> {
    const found = new Map<string, SongPathRow>();
    for (let at = 0; at < paths.length; at += PATH_CHUNK) {
      const chunk = paths.slice(at, at + PATH_CHUNK);
      const marks = chunk.map((_, index) => `?${index + 1}`).join(', ');
      const rows = await this.query<MediaRow>(
        `SELECT ${this.selectColumns} FROM MEDIA_TABLE WHERE path IN (${marks})`,
        chunk
      );
      for (const row of rows) {
        const song = toSongRow(row);
        found.set(song.path, song);
      }
    }
    return found;
  }

  /** A track as the app's rows want it; `path` is kept on a side table of callers. */
  async songsForPaths(paths: readonly string[]): Promise<Map<string, Song>> {
    const rows = await this.rowsForPaths(paths);
    const songs = new Map<string, Song>();
    for (const [path, row] of rows) {
      songs.set(path, songFromRow(row));
    }
    return songs;
  }

  async songForPath(path: string): Promise<Song | null> {
    const rows = await this.rowsForPaths([path]);
    const row = rows.get(path);
    return row ? songFromRow(row) : null;
  }

  /** Network-mode fallback: `api.library()` when the app's own catalog is not in use. */
  async filteredPage(offset: number, limit: number, query: string | null, filter: LibraryFilter): Promise<{ total: number; songs: Song[] }> {
    const where: string[] = ["path IS NOT NULL AND path <> ''"];
    const params: (string | number)[] = [];
    const bind = (value: string | number): void => {
      params.push(value);
    };
    if (query?.trim()) {
      bind(`%${query.trim()}%`);
      const at = params.length;
      where.push(`(name LIKE ?${at} OR artist LIKE ?${at} OR album LIKE ?${at})`);
    }
    for (const [column, value] of [
      ['artist', filter.artist],
      ['album_artist', filter.albumArtist],
      ['album', filter.album],
      ['genre', filter.genre],
    ] as const) {
      if (value == null || !this.columns.has(column)) continue;
      bind(value);
      where.push(`${column} = ?${params.length} COLLATE NOCASE`);
    }
    const clause = where.join(' AND ');
    const total = Number((await this.first<{ total: number }>(
      `SELECT COUNT(*) AS total FROM MEDIA_TABLE WHERE ${clause}`, params
    ))?.total ?? 0);
    const rows = await this.query<MediaRow>(
      `SELECT ${this.selectColumns} FROM MEDIA_TABLE WHERE ${clause}
       ORDER BY album COLLATE NOCASE, COALESCE(disc, 1), dis_id, rowid LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
      [...params, limit, offset]
    );
    return { total, songs: rows.map((row) => songFromRow(toSongRow(row))) };
  }

  async groups(kind: 'artists' | 'album_artists' | 'genres' | 'albums', filter: LibraryFilter = {}): Promise<LibraryGroup[]> {
    if (kind === 'albums') {
      const where: string[] = ["path IS NOT NULL AND path <> ''"];
      const params: string[] = [];
      for (const [column, value] of [['artist', filter.artist], ['album_artist', filter.albumArtist]] as const) {
        if (value == null || !this.columns.has(column)) continue;
        params.push(value);
        where.push(`${column} = ?${params.length} COLLATE NOCASE`);
      }
      const key = this.columns.has('album_key') ? 'album_key' : 'album';
      const rows = await this.query<{ name: string; count: number; idx: number; album_artist: string | null; album_key: string | null }>(
        `SELECT MAX(album) AS name, COUNT(*) AS count, MIN(rowid) AS idx,
                MAX(album_artist) AS album_artist,
                ${this.columns.has('album_key') ? "MAX(album || char(31) || album_key)" : 'NULL'} AS album_key
         FROM MEDIA_TABLE WHERE ${where.join(' AND ')}
         GROUP BY album COLLATE NOCASE, ${key} ORDER BY MAX(album) COLLATE NOCASE`,
        params
      );
      return rows.map((row) => ({
        name: string(row.name),
        count: Number(row.count ?? 0),
        index: Number(row.idx ?? 0),
        albumArtist: string(row.album_artist),
        albumKey: row.album_key ? String(row.album_key) : null,
      }));
    }
    const column = kind === 'artists' ? 'artist' : kind === 'album_artists' ? 'album_artist' : 'genre';
    if (!this.columns.has(column)) return [];
    const rows = await this.query<{ name: string; count: number; idx: number }>(
      `SELECT ${column} AS name, COUNT(*) AS count, MIN(rowid) AS idx FROM MEDIA_TABLE
       WHERE path IS NOT NULL AND path <> '' AND ${column} IS NOT NULL AND ${column} <> ''
       GROUP BY ${column} COLLATE NOCASE ORDER BY ${column} COLLATE NOCASE`
    );
    return rows.map((row) => ({
      name: string(row.name),
      count: Number(row.count ?? 0),
      index: Number(row.idx ?? 0),
      albumArtist: '',
      albumKey: null,
    }));
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    this.revision = null;
    this.columns.clear();
    if (db) await db.closeAsync().catch(() => {});
  }
}

export function songFromRow(row: SongPathRow): Song {
  return {
    index: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumArtist: row.albumArtist,
    genre: row.genre,
    trackNumber: row.trackNumber,
    discNumber: row.discNumber,
    albumKey: albumIdentity(row),
  };
}
