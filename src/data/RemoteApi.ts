// The app's view of a Sonix player, spoken over SonixLink.
//
// The public surface is the one the rest of the app already uses (`RemoteApi`
// in the Compás client), so the screens did not have to be rewritten: this class
// answers the same questions from the player's own endpoints, and hides what
// this player cannot do through `capabilities().features` instead of failing at
// the point of use.
//
// Two translations are worth knowing about:
//  * commands are addressed by file path, the interface by catalog index; the
//    downloaded index (`SonixIndex`) is the map between them;
//  * `GET /api/db` is the library, not a page of JSON, and `session/catalogSync`
//    stores it in the app's own local database unchanged.

import type { HttpTransport } from './HttpTransport';
import { isFileDownloadTransport } from './HttpTransport';
import { assertIntegerArgument, RemoteApiException } from './remoteApiProtocol';
import { PluginsApi } from './PluginsApi';
import { SettingsApi } from './SettingsApi';
import { validatePlaylistName } from './PlaylistApi';
import { bytesToBase64 } from './cryptoUtils';
import type {
  ArtImage,
  Capabilities,
  CatalogCover,
  CatalogCoversPage,
  CatalogPage,
  CollectionPlayRequest,
  FolderEntry,
  FolderPage,
  LibraryFilter,
  LibraryGroup,
  LibraryPage,
  LibrarySortMode,
  LibrarySortScope,
  LibrarySortingSnapshot,
  PlaybackStatus,
  PlayContext,
  Playlist,
  PlaylistPage,
  QueuePage,
  Song,
  WifiImportDirectoryPage,
  WifiImportStatus,
  WifiImportUploadResult,
} from './types';
import type { NativeUploadProgress } from './nativeFileUpload';
import { SonixLinkClient, textBody, type SonixInfo, type SonixState } from './sonix/SonixLinkClient';
import { SonixIndex, songFromRow, type SongPathRow } from './sonix/SonixIndex';
import { SonixTransferClient } from './sonix/SonixTransferClient';
import {
  albumValue, modeName, modeNumber, remoteApiLibraryId, SONIX_FEATURES, statusFromState,
} from './sonix/SonixMapping';

export { RemoteApiException } from './remoteApiProtocol';

const ART_MAX_SIDE = 640;
const ART_ROW_SIDE = 240;
const ART_PENDING_TRIES = 10;
const ART_PENDING_DELAY_MS = 200;
const QUEUE_PENDING_TRIES = 20;
const QUEUE_PENDING_DELAY_MS = 250;
const PLAYLIST_KEY_FAVORITES = '@favorites';
const PLAYLIST_KEY_RECENT = '@recently_played';

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'flac', 'wav', 'aac', 'm4a', 'alac', 'ape', 'wv', 'ogg', 'oga', 'opus', 'dsf', 'dff', 'm4b', 'aif', 'aiff', 'mp2', 'wma',
]);
const PLAYLIST_EXTENSIONS = new Set(['m3u', 'm3u8', 'cue']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function fileName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function placeholderSong(path: string): Song {
  return { index: 0, title: fileName(path), artist: '', album: '', albumKey: null };
}

function songOfRow(row: SongPathRow): Song {
  return songFromRow(row);
}

function withQueueOffset(song: Song, offset: number): Song {
  return { ...song, offset };
}

export interface SonixRemoteApiOptions {
  /** The Wi-Fi endpoint the app connected to (`http://host:7800`), for the Transfer server. */
  wifiBaseUrl?: string | null;
}

export class RemoteApi {
  static readonly CATALOG_SYNC_FEATURE = 'catalog_sync_v1';
  static readonly CATALOG_PAGE_LIMIT = 100;

  private readonly client: SonixLinkClient;
  private readonly index: SonixIndex;
  private readonly transport: HttpTransport;
  private readonly wifiBaseUrl: string | null;
  private pin: string | null = null;
  private commands = 0;
  private infoCache: SonixInfo | null = null;
  private stateCache: SonixState | null = null;
  private revisionCache: string | null = null;
  private queueCache: { first: number; paths: string[]; revision: number; count: number } | null = null;
  private cardRoot: string | null = null;

  private settingsClient: SettingsApi | null = null;
  private pluginsClient: PluginsApi | null = null;

  constructor(transport: HttpTransport, pin?: string | null, options: SonixRemoteApiOptions = {}) {
    this.transport = transport;
    this.client = new SonixLinkClient(transport);
    this.index = new SonixIndex(this.client);
    this.wifiBaseUrl = options.wifiBaseUrl ?? null;
    if (pin) this.pin = pin;
  }

  /** SonixLink has no PIN; the method stays so the connection flow does not have to branch. */
  setPin(pin: string | null): void {
    this.pin = pin || null;
  }

  get commandGeneration(): number {
    return this.commands;
  }

  get catalogRevision(): string | null {
    return this.revisionCache;
  }

  get canDownloadArt(): boolean {
    return isFileDownloadTransport(this.transport);
  }

  get canDownloadLibraryArt(): boolean {
    return isFileDownloadTransport(this.transport) && this.transport.downloadRejectsRedirects === true;
  }

  settings(): SettingsApi {
    return (this.settingsClient ??= new SettingsApi(this.transport, () => this.pin));
  }

  plugins(): PluginsApi {
    return (this.pluginsClient ??= new PluginsApi(this.transport, () => this.pin));
  }

  preemptArtworkRequest(index?: number): void {
    const transport = this.transport as { preemptArtworkRequest?: (index?: number) => void };
    transport.preemptArtworkRequest?.(index);
  }

  /** `/api/info`, cached for the length of the status poll that follows. */
  private async info(force = false): Promise<SonixInfo> {
    if (!force && this.infoCache) return this.infoCache;
    const info = await this.client.info();
    this.infoCache = info;
    this.revisionCache = SonixIndex.revisionOf(info);
    return info;
  }

  private async state(force = false): Promise<SonixState> {
    if (!force && this.stateCache) return this.stateCache;
    const state = await this.client.state();
    this.stateCache = state;
    return state;
  }

  async capabilities(_options: { omitPin?: boolean } = {}): Promise<Capabilities> {
    const info = await this.info(true);
    return {
      version: info.api || 1,
      transports: ['wifi', 'bluetooth'],
      features: [...SONIX_FEATURES],
      libraryId: remoteApiLibraryId(info),
      name: info.name?.trim() || null,
    };
  }

  async status(): Promise<PlaybackStatus> {
    const state = await this.state(true);
    const info = await this.info();
    return statusFromState(state, {
      // The firmware's `model` string is the upstream port's board name; the
      // player's own name is what this device actually calls itself.
      deviceModel: info.name?.trim() || info.model?.trim() || null,
      playerVersion: info.firmware?.trim() || null,
    });
  }

  private async currentPath(): Promise<string | null> {
    const state = await this.state();
    return state.path || null;
  }

  private async pathOf(index: number | null | undefined): Promise<string | null> {
    if (index == null) return this.currentPath();
    assertIntegerArgument(index, 'Index', 0);
    if (!this.index.available) return null;
    return this.index.pathForId(index);
  }

  /** Path metadata, or nothing while the index is still being fetched. */
  private async rowsForPaths(paths: readonly string[]): Promise<Map<string, SongPathRow>> {
    if (!this.index.available || !paths.length) return new Map();
    return this.index.rowsForPaths(paths);
  }

  private artTarget(path: string, index: number | null): string {
    const params = new URLSearchParams();
    params.set('path', path);
    // A now-playing picture is drawn large; a row thumbnail is not worth the
    // player decoding and sending a second time at that size.
    params.set('max', String(index == null ? ART_MAX_SIDE : ART_ROW_SIDE));
    // A marker for the app's own request queue; the player ignores it.
    if (index != null) params.set('index', String(index));
    return `/api/art?${params.toString()}`;
  }

  private async readArt(path: string, index: number | null): Promise<ArtImage | null> {
    const target = this.artTarget(path, index);
    const generation = this.commands;
    for (let attempt = 0; attempt < ART_PENDING_TRIES; attempt++) {
      if (generation !== this.commands) throw new RemoteApiException(409, 'Artwork request preempted');
      const response = await this.transport.execute({ method: 'GET', target, headers: {}, timeoutMs: 20000 });
      if (response.statusCode === 404) return null;
      if (response.statusCode === 202) {
        await sleep(ART_PENDING_DELAY_MS);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw new RemoteApiException(response.statusCode, response.text());
      return {
        contentType: response.header('content-type') || 'image/jpeg',
        base64: response.bodyBase64 ?? bytesToBase64(response.body),
      };
    }
    // Still preparing: not an error, simply no picture this time.
    return null;
  }

  async art(index?: number | null): Promise<ArtImage | null> {
    const path = await this.pathOf(index ?? null);
    if (!path) return null;
    return this.readArt(path, index ?? null);
  }

  async downloadArt(fileUri: string, index?: number | null): Promise<boolean> {
    const path = await this.pathOf(index ?? null);
    if (!path || !isFileDownloadTransport(this.transport)) return false;
    const target = this.artTarget(path, index ?? null);
    for (let attempt = 0; attempt < ART_PENDING_TRIES; attempt++) {
      const response = await this.transport.download({ method: 'GET', target, headers: {}, timeoutMs: 20000 }, fileUri);
      if (response.statusCode === 404) return false;
      if (response.statusCode === 202) {
        await sleep(ART_PENDING_DELAY_MS);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw new RemoteApiException(response.statusCode, response.text());
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  private async command(what: string, params: [string, string][] = [], body?: Uint8Array): Promise<void> {
    this.commands++;
    // Anything may have moved the queue; the next read must ask the player.
    this.queueCache = null;
    await this.client.command(what, params, body);
  }

  async togglePlayback(): Promise<void> {
    await this.command('toggle');
  }

  async next(): Promise<void> {
    await this.command('next');
  }

  async previous(): Promise<void> {
    await this.command('prev');
  }

  async cyclePlayMode(): Promise<void> {
    const state = await this.state(true);
    const nextMode = (modeNumber(state.mode) + 1) % 5;
    await this.setPlayMode(nextMode);
  }

  async setPlayMode(mode: number): Promise<void> {
    assertIntegerArgument(mode, 'Play mode', 0, 4);
    await this.command('mode', [['value', modeName(mode)]]);
  }

  async seek(seconds: number): Promise<void> {
    assertIntegerArgument(seconds, 'Seconds', 0);
    await this.command('seek', [['value', String(seconds)]]);
  }

  async setVolume(percent: number): Promise<void> {
    assertIntegerArgument(percent, 'Volume percent', 0, 100);
    await this.command('volume', [['value', String(percent)]]);
  }

  private async rowFor(index: number): Promise<SongPathRow> {
    assertIntegerArgument(index, 'Index', 0);
    if (!this.index.available) await this.ensureIndex();
    const row = await this.index.rowForId(index);
    if (!row) throw new Error('That track is no longer in the player library');
    return row;
  }

  async play(index: number, context: PlayContext = {}, _catalogRevision?: string | null): Promise<void> {
    const row = await this.rowFor(index);
    let list = 'all';
    let value: string | null = null;
    if (context.playlist === PLAYLIST_KEY_FAVORITES) {
      list = 'favourites';
    } else if (context.playlist === PLAYLIST_KEY_RECENT) {
      list = 'all';
    } else if (context.playlist) {
      list = 'playlist';
      value = context.playlist;
    } else if (context.album) {
      list = 'album';
      value = albumValue(context.album, row.albumKey);
    } else if (context.genre) {
      list = 'genre';
      value = context.genre;
    } else if (context.albumArtist) {
      list = 'album_artist';
      value = context.albumArtist;
    } else if (context.artist) {
      list = 'artist';
      value = context.artist;
    }
    const params: [string, string][] = [['path', row.path], ['list', list]];
    if (value) params.push(['value', value]);
    await this.command('play_path', params);
  }

  async addToQueue(index: number, _catalogRevision?: string | null): Promise<void> {
    const row = await this.rowFor(index);
    await this.command('queue_next', [], textBody([row.path]));
  }

  async playCollection(_request: CollectionPlayRequest): Promise<number> {
    throw new Error('The player has no collection jobs; play the list from its own page instead');
  }

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  private async queueWindow(from: number): Promise<{ first: number; paths: string[]; revision: number; count: number }> {
    for (let attempt = 0; attempt < QUEUE_PENDING_TRIES; attempt++) {
      const window = await this.client.queue(from);
      if (!window.pending) {
        const value = { first: window.first, paths: window.paths, revision: window.revision, count: window.count };
        this.queueCache = value;
        return value;
      }
      await sleep(QUEUE_PENDING_DELAY_MS);
    }
    throw new Error('The player is still preparing the queue');
  }

  private async windowFor(offset: number): Promise<{ first: number; paths: string[]; revision: number; count: number }> {
    // The first page is what a refresh asks for; it must never be a cache. The
    // rest of a paged read reuses the window the first page opened.
    if (offset === 0) return this.queueWindow(0);
    const cached = this.queueCache;
    if (cached && offset >= cached.first && offset < cached.first + cached.paths.length) return cached;
    return this.queueWindow(offset);
  }

  async queue(offset: number = 0, limit: number = 25): Promise<QueuePage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new Error('Invalid queue offset or limit');
    }
    const window = await this.windowFor(offset);
    const from = Math.max(0, offset - window.first);
    const paths = window.paths.slice(from, from + limit);
    const rows = await this.rowsForPaths(paths);
    const songs = paths.map((path, at) => {
      const row = rows.get(path);
      const song = row ? songOfRow(row) : placeholderSong(path);
      return withQueueOffset(song, window.first + from + at);
    });
    return {
      total: window.count,
      offset: window.first + from,
      revision: window.revision,
      songs,
    };
  }

  async removeFromQueue(offset: number, revision: number): Promise<void> {
    assertIntegerArgument(offset, 'Offset', 0);
    assertIntegerArgument(revision, 'Revision', 0);
    await this.command('queue_remove', [['rev', String(revision)]], textBody([String(offset)]));
  }

  async clearQueue(_revision: number): Promise<void> {
    throw new Error('The player cannot clear its queue remotely');
  }

  async moveQueueTrack(from: number, to: number, revision: number): Promise<void> {
    assertIntegerArgument(from, 'From', 0);
    assertIntegerArgument(to, 'To', 0);
    assertIntegerArgument(revision, 'Revision', 0);
    await this.command('queue_move', [['from', String(from)], ['to', String(to)], ['rev', String(revision)]]);
  }

  async playQueueTrack(offset: number, _revision: number): Promise<void> {
    assertIntegerArgument(offset, 'Offset', 0);
    await this.command('queue_index', [['value', String(offset)]]);
  }

  // -------------------------------------------------------------------------
  // Favourites, history
  // -------------------------------------------------------------------------

  async favoriteStates(ids: number[]): Promise<Map<number, boolean>> {
    const states = new Map<number, boolean>();
    if (!ids.length) return states;
    const { favourites } = await this.client.favourites();
    const paths = new Set(favourites.map((item) => item.path));
    const rows = await this.rowsForPaths([...paths]);
    for (const row of rows.values()) {
      if (ids.includes(row.id)) states.set(row.id, true);
    }
    return states;
  }

  async ratingStates(ids: number[]): Promise<Map<number, number>> {
    void ids;
    return new Map();
  }

  async setFavorite(favorite: boolean, index?: number, _catalogRevision?: string | null, _signal?: AbortSignal): Promise<boolean> {
    const path = await this.pathOf(index ?? null);
    if (!path) throw new Error('No track is playing');
    await this.command('favourite', [['path', path], ['value', favorite ? '1' : '0']]);
    if (this.stateCache) this.stateCache = { ...this.stateCache, favourite: favorite };
    return favorite;
  }

  async setRating(_index: number | undefined, _stars: number, _catalogRevision?: string | null, _signal?: AbortSignal): Promise<number> {
    throw new Error('This player has no track ratings');
  }

  async recent(_offset: number = 0): Promise<{ songs: Song[]; total: number; nextOffset: number }> {
    const history = await this.client.history(200);
    // The player sends oldest first (its queue page reads that way); the app's
    // "Recently played" is newest first.
    const items = [...history.items].reverse();
    const rows = await this.rowsForPaths(items.map((item) => item.path));
    const songs = items.map((item) => {
      const row = rows.get(item.path);
      const song = row ? songOfRow(row) : {
        index: 0, title: item.title || fileName(item.path), artist: item.artist || '', album: '', albumKey: null,
      } as Song;
      return { ...song, lastPlayed: item.played_at };
    });
    return { songs, total: songs.length, nextOffset: songs.length };
  }

  // -------------------------------------------------------------------------
  // Playlists
  // -------------------------------------------------------------------------

  async playlists(): Promise<Playlist[]> {
    const { playlists } = await this.client.playlists();
    return [
      { name: 'Favorites', key: PLAYLIST_KEY_FAVORITES, internal: true, writable: false },
      ...playlists.map((playlist) => ({
        name: playlist.name,
        key: playlist.name,
        internal: false,
        writable: true,
      })),
    ];
  }

  private async songsForPaths(paths: readonly string[]): Promise<Song[]> {
    const rows = await this.rowsForPaths(paths);
    return paths.map((path) => {
      const row = rows.get(path);
      return row ? songOfRow(row) : placeholderSong(path);
    });
  }

  async playlistPage(key: string, offset: number = 0): Promise<PlaylistPage> {
    assertIntegerArgument(offset, 'Offset', 0);
    if (key === PLAYLIST_KEY_FAVORITES) {
      const { favourites } = await this.client.favourites();
      const songs = await this.songsForPaths(favourites.map((item) => item.path));
      const state = await this.state();
      return {
        songs: songs.map((song, at) => ({ ...song, position: at })),
        total: songs.length,
        nextOffset: songs.length,
        revision: String(state.favourites_revision),
        writable: false,
      };
    }
    const playlist = await this.client.playlist(key);
    const songs = await this.songsForPaths(playlist.tracks.map((track) => track.path));
    const state = await this.state();
    return {
      songs: songs.map((song, at) => ({ ...song, position: at })),
      total: songs.length,
      nextOffset: songs.length,
      revision: String(state.playlists_revision),
      writable: true,
    };
  }

  async playlistSongs(key: string): Promise<Song[]> {
    return (await this.playlistPage(key)).songs;
  }

  private async assertPlaylistAbsent(name: string): Promise<void> {
    const { playlists } = await this.client.playlists();
    const wanted = name.trim().toLocaleLowerCase();
    if (playlists.some((playlist) => playlist.name.trim().toLocaleLowerCase() === wanted)) {
      throw new Error('You already have a playlist with this name');
    }
  }

  async createPlaylist(name: string, index: number): Promise<void> {
    validatePlaylistName(name);
    await this.assertPlaylistAbsent(name);
    const row = await this.rowFor(index);
    await this.command('playlist_add', [['value', name]], textBody([row.path]));
  }

  async addToPlaylist(name: string, index: number): Promise<void> {
    validatePlaylistName(name);
    const row = await this.rowFor(index);
    await this.command('playlist_add', [['value', name]], textBody([row.path]));
  }

  async removePlaylistTrack(key: string, position: number, _revision: string): Promise<string | null> {
    assertIntegerArgument(position, 'Position', 0);
    const page = await this.playlistPage(key);
    const song = page.songs[position];
    if (!song) throw new Error('That playlist entry is no longer there');
    const path = await this.pathOf(song.index);
    if (!path) throw new Error('That track is no longer in the player library');
    await this.command('playlist_remove', [['value', key]], textBody([path]));
    return null;
  }

  async movePlaylistTrack(_key: string, _from: number, _to: number, _revision: string): Promise<string | null> {
    throw new Error('The player cannot reorder playlist entries remotely');
  }

  async importPlaylist(_name: string, _body: Uint8Array): Promise<{ entries: number; matched: number }> {
    throw new Error('The player does not import playlist files over the API');
  }

  async createEmptyPlaylist(name: string): Promise<void> {
    // SonixLink creates an M3U table with the first track added to it; an empty
    // one is not a thing this player has, so the creation step checks the name
    // and lets the tracks that follow make the playlist.
    validatePlaylistName(name);
    await this.assertPlaylistAbsent(name);
  }

  async renamePlaylist(_key: string, _newName: string): Promise<string> {
    throw new Error('The player cannot rename playlists remotely');
  }

  async deletePlaylist(_key: string): Promise<void> {
    throw new Error('The player cannot delete playlists remotely');
  }

  static validatePlaylistName(name: string): void {
    validatePlaylistName(name);
  }

  // -------------------------------------------------------------------------
  // Library
  // -------------------------------------------------------------------------

  private async ensureIndex(): Promise<{ info: SonixInfo; revision: string }> {
    const info = await this.info();
    await this.index.prepare(info);
    const revision = this.index.currentRevision;
    if (!revision) throw new Error('The player library index is unavailable');
    return { info, revision };
  }

  async catalog(offset: number = 0, limit: number = RemoteApi.CATALOG_PAGE_LIMIT, revision?: string | null): Promise<CatalogPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > RemoteApi.CATALOG_PAGE_LIMIT) {
      throw new Error('Invalid catalog offset or limit');
    }
    // The first page is where a sync starts; pick up a rescan or a new card there.
    const info = offset === 0 ? await this.info(true) : await this.info();
    await this.index.prepare(info);
    const current = this.index.currentRevision;
    if (!current) throw new Error('The player library index is unavailable');
    if (revision && revision !== current) throw new Error('Player catalog changed during sync');
    const page = await this.index.catalogPage(offset, limit);
    return {
      libraryId: remoteApiLibraryId(info),
      revision: current,
      total: page.total,
      offset,
      nextOffset: Math.min(offset + page.songs.length, page.total),
      songs: page.songs,
    };
  }

  async catalogCovers(offset: number = 0, _limit: number = RemoteApi.CATALOG_PAGE_LIMIT, revision: string = ''): Promise<CatalogCoversPage> {
    const info = await this.info();
    return {
      libraryId: remoteApiLibraryId(info),
      revision,
      total: 0,
      offset,
      nextOffset: 0,
      covers: [] as CatalogCover[],
    };
  }

  async catalogArt(_revision: string, _representativeId: number, _coverKey: string): Promise<ArtImage | null> {
    return null;
  }

  async downloadCatalogArt(_fileUri: string, _revision: string, _representativeId: number, _coverKey: string): Promise<boolean> {
    return false;
  }

  /** `api.library()`, used when the local catalog is not in play. */
  async library(offset: number = 0, limit: number = 50, query?: string | null, filter: LibraryFilter = {}, signal?: AbortSignal): Promise<LibraryPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid library offset or limit');
    }
    if (signal?.aborted) throw new Error('Request cancelled');
    await this.ensureIndex();
    return this.index.filteredPage(offset, limit, query ?? null, filter);
  }

  private async groups(kind: 'artists' | 'album_artists' | 'genres' | 'albums', filter: LibraryFilter = {}): Promise<LibraryGroup[]> {
    await this.ensureIndex();
    return this.index.groups(kind, filter);
  }

  async artists(_signal?: AbortSignal): Promise<LibraryGroup[]> {
    return this.groups('artists');
  }

  async albumArtists(): Promise<LibraryGroup[]> {
    return this.groups('album_artists');
  }

  async genres(_signal?: AbortSignal): Promise<LibraryGroup[]> {
    return this.groups('genres');
  }

  async albums(filter: LibraryFilter = {}, _signal?: AbortSignal): Promise<LibraryGroup[]> {
    return this.groups('albums', filter);
  }

  async topRatedAlbums(): Promise<LibraryGroup[]> {
    return [];
  }

  async librarySorting(): Promise<LibrarySortingSnapshot> {
    const available = [true, true, true, false, false, false, false, false, false] as const;
    const snapshot = { configured: 0 as LibrarySortMode, effective: 0 as LibrarySortMode, available, reverse: false };
    return { albums: snapshot, artists: snapshot, albumArtists: snapshot };
  }

  async setLibrarySorting(_scope: LibrarySortScope, _mode: LibrarySortMode): Promise<void> {
    throw new Error('The player does not accept library sort changes over the API');
  }

  async libraryAlbumGroups(_options?: {
    scope: LibrarySortScope; artist?: string | null; albumArtist?: string | null; offset?: number; limit?: number;
  }): Promise<{ total: number; offset: number; nextOffset: number; revision: string; groups: LibraryGroup[] }> {
    throw new Error('The player orders albums itself');
  }

  // -------------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------------

  private async cardDirectory(): Promise<string> {
    if (this.cardRoot) return this.cardRoot;
    const browse = await this.client.browse(null);
    this.cardRoot = browse.root || '/mnt/sd_0';
    return this.cardRoot;
  }

  private absoluteCardPath(path: string): string {
    const root = this.cardRoot ?? '/mnt/sd_0';
    const clean = path.replace(/^\/+/, '');
    return clean ? `${root}/${clean}` : root;
  }

  async folderRoots(): Promise<Array<{ id: string; name: string; available: boolean }>> {
    try {
      await this.cardDirectory();
      return [{ id: 'sd', name: 'SD card', available: true }];
    } catch {
      return [{ id: 'sd', name: 'SD card', available: false }];
    }
  }

  async folder(path: string = '', offset: number = 0, _root: string = 'sd'): Promise<FolderPage> {
    assertIntegerArgument(offset, 'Offset', 0);
    await this.cardDirectory();
    const browse = await this.client.browse(this.absoluteCardPath(path));
    const folders: FolderEntry[] = [];
    const files: { name: string; path: string }[] = [];
    for (const entry of browse.entries) {
      if (entry.dir) {
        folders.push({ type: 'folder', name: entry.name });
        continue;
      }
      const extension = extensionOf(entry.name);
      if (PLAYLIST_EXTENSIONS.has(extension)) {
        folders.push({ type: 'playlist', name: entry.name });
      } else if (AUDIO_EXTENSIONS.has(extension)) {
        files.push({ name: entry.name, path: entry.path });
      }
    }
    const rows = await this.rowsForPaths(files.map((file) => file.path));
    const tracks: FolderEntry[] = files.map((file) => {
      const row = rows.get(file.path);
      return {
        type: 'track',
        name: file.name,
        index: row?.id ?? 0,
        title: row?.title ?? file.name,
        artist: row?.artist ?? '',
      };
    });
    const entries = [...folders, ...tracks];
    return {
      root: 'sd',
      path,
      parent: browse.parent
        ? browse.parent.startsWith(this.cardRoot ?? '')
          ? browse.parent.slice((this.cardRoot ?? '').length).replace(/^\/+/, '') || null
          : null
        : null,
      total: entries.length,
      folderCount: folders.length,
      offset,
      nextOffset: entries.length,
      entries,
    };
  }

  async playFolderTrack(path: string, _root: string = 'sd'): Promise<void> {
    await this.cardDirectory();
    await this.command('play_path', [['path', this.absoluteCardPath(path)], ['list', 'folder']]);
  }

  // -------------------------------------------------------------------------
  // Transfer (the player's own thttpd, on port 4399 while Transfer is on)
  // -------------------------------------------------------------------------

  private transfer(): SonixTransferClient {
    return new SonixTransferClient(this.wifiBaseUrl);
  }

  private transferFor(endpoint?: string): SonixTransferClient {
    return new SonixTransferClient(endpoint || this.wifiBaseUrl);
  }

  async importStatus(): Promise<WifiImportStatus> {
    return this.transfer().status();
  }

  async startImport(): Promise<void> {
    await this.transfer().start();
  }

  async stopImport(): Promise<void> {
    await this.transfer().stop();
  }

  async importFiles(path: string = '', offset: number = 0, limit: number = 50, showHidden = false): Promise<WifiImportDirectoryPage> {
    assertIntegerArgument(offset, 'Offset', 0);
    assertIntegerArgument(limit, 'Limit', 1, 100);
    return this.transfer().list(path, offset, limit, showHidden);
  }

  async uploadImportFile(
    endpoint: string,
    fileUri: string,
    path: string,
    name: string,
    onProgress: (progress: NativeUploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<WifiImportUploadResult> {
    let bytes = 0;
    const result = await this.transferFor(endpoint).upload(
      fileUri,
      path,
      name,
      (progress) => {
        bytes = progress.total || progress.sent || bytes;
        onProgress(progress);
      },
      signal,
    );
    return { ...result, bytes };
  }

  async renameImportFile(path: string, name: string): Promise<void> {
    await this.transfer().rename(path, name);
  }

  async deleteImportFile(path: string): Promise<void> {
    await this.transfer().remove(path);
  }

  async createImportDirectory(path: string, name: string): Promise<void> {
    await this.transfer().mkdir(path, name);
  }
}
