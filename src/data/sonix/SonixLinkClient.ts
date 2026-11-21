// SonixLink: the player's own HTTP API, as described in
// `sonix-player/src/system/remote/sonixlink.h`. Plain HTTP with JSON bodies on
// port 7800, or the same requests over an RFCOMM link (sonixlink_bt.c).
//
// This file is only the wire. Turning the answers into the shapes the app's
// session layer expects is `SonixLinkApi`'s job.

import { isFileDownloadTransport, type HttpRequest, type HttpTransport } from '../HttpTransport';
import { RemoteApiException } from '../remoteApiProtocol';
import { bytesToBase64 } from '../cryptoUtils';

export const SONIXLINK_PORT = 7800;
export const SONIXLINK_TRANSFER_PORT = 4399;
export const SONIXLINK_BLUETOOTH_UUID = '8d6e3a52-4c1f-4b7e-9a2d-5f0c7e1b3a90';

export type SonixParam = [string, string];

function failure(statusCode: number, body: string): RemoteApiException {
  return new RemoteApiException(statusCode, body);
}

export interface SonixSort {
  desc: number;
  added: number;
  artist_by_album: boolean;
  favourites_reversed: boolean;
}

export interface SonixInfo {
  name: string;
  model: string;
  firmware: string;
  serial: string;
  api: number;
  port: number;
  tracks: number;
  scanning: boolean;
  sort: SonixSort;
  db_available: boolean;
  db_size: number;
  db_mtime: number;
  db_hash?: string;
  covers_available: boolean;
  covers_size: number;
  covers_mtime: number;
  covers_hash?: string;
  accent: string;
}

export interface SonixState {
  state: number;
  mode: string;
  volume: number;
  position: number;
  duration: number;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  path: string;
  sample_rate: number;
  bitrate: number;
  bits: number;
  lossless: boolean;
  battery: number;
  charging: boolean;
  favourite: boolean;
  accent: string;
  sort: SonixSort;
  queue_position: number;
  queue_count: number;
  queue_revision: number;
  display_position: number;
  display_count: number;
  favourites_revision: number;
  playlists_revision: number;
  history_revision: number;
  scanning: boolean;
  scan_count: number;
  tracks: number;
}

export interface SonixQueue {
  count: number;
  position: number;
  revision: number;
  pending: boolean;
  first: number;
  paths: string[];
}

export interface SonixHistoryItem {
  id: number;
  path: string;
  title: string;
  artist: string;
  played_at: number;
}

export interface SonixHistory {
  revision: number;
  items: SonixHistoryItem[];
}

export interface SonixFavourite {
  path: string;
  name: string;
  artist: string;
}

export interface SonixPlaylistSummary {
  name: string;
  count: number;
}

export interface SonixPlaylists {
  revision: number;
  playlists: SonixPlaylistSummary[];
}

export interface SonixPlaylistTrack {
  path: string;
  title: string;
  artist: string;
}

export interface SonixPlaylist {
  name: string;
  tracks: SonixPlaylistTrack[];
}

export interface SonixBrowseEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface SonixBrowse {
  path: string;
  root: string;
  parent: string;
  entries: SonixBrowseEntry[];
}

export interface SonixArt {
  contentType: string;
  base64: string;
}

export interface SonixRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function query(params: SonixParam[]): string {
  if (!params.length) return '';
  return `?${params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')}`;
}

/** The body is a list of paths (or queue indices), one per line, as the C parser expects. */
export function textBody(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(lines.join('\n'));
}

export class SonixLinkClient {
  constructor(private readonly transport: HttpTransport) {}

  private request(method: 'GET' | 'POST', target: string, body?: Uint8Array, options: SonixRequestOptions = {}): HttpRequest {
    const headers: Record<string, string> = {};
    if (body) {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
      headers['Content-Length'] = String(body.length);
    }
    return {
      method,
      target,
      headers,
      body,
      timeoutMs: options.timeoutMs,
      queueSignal: options.signal,
    };
  }

  private async json<T>(path: string, params: SonixParam[] = [], options: SonixRequestOptions = {}): Promise<T> {
    const response = await this.transport.execute(this.request('GET', `${path}${query(params)}`, undefined, options));
    if (response.statusCode < 200 || response.statusCode >= 300) throw failure(response.statusCode, response.text());
    return JSON.parse(response.text()) as T;
  }

  async info(options?: SonixRequestOptions): Promise<SonixInfo> {
    return this.json<SonixInfo>('/api/info', [], options);
  }

  async state(options?: SonixRequestOptions): Promise<SonixState> {
    return this.json<SonixState>('/api/state', [], options);
  }

  async queue(from?: number, options?: SonixRequestOptions): Promise<SonixQueue> {
    return this.json<SonixQueue>('/api/queue', from == null ? [] : [['from', String(from)]], options);
  }

  async history(limit = 200, options?: SonixRequestOptions): Promise<SonixHistory> {
    return this.json<SonixHistory>('/api/history', [['limit', String(limit)]], options);
  }

  async favourites(options?: SonixRequestOptions): Promise<{ favourites: SonixFavourite[] }> {
    return this.json('/api/favourites', [], options);
  }

  async playlists(options?: SonixRequestOptions): Promise<SonixPlaylists> {
    return this.json<SonixPlaylists>('/api/playlists', [], options);
  }

  async playlist(name: string, options?: SonixRequestOptions): Promise<SonixPlaylist> {
    return this.json<SonixPlaylist>('/api/playlist', [['name', name]], options);
  }

  async browse(path?: string | null, options?: SonixRequestOptions): Promise<SonixBrowse> {
    return this.json<SonixBrowse>('/api/browse', path ? [['path', path]] : [], options);
  }

  async ping(options?: SonixRequestOptions): Promise<void> {
    const response = await this.transport.execute(this.request('GET', '/api/ping', undefined, options));
    if (response.statusCode < 200 || response.statusCode >= 300) throw failure(response.statusCode, response.text());
  }

  async bye(options?: SonixRequestOptions): Promise<void> {
    const response = await this.transport.execute(this.request('GET', '/api/bye', undefined, { ...options, timeoutMs: options?.timeoutMs ?? 1500 }));
    if (response.statusCode < 200 || response.statusCode >= 300) throw failure(response.statusCode, response.text());
  }

  async command(what: string, params: SonixParam[] = [], body?: Uint8Array, options?: SonixRequestOptions): Promise<void> {
    const target = `/api/command${query([['do', what], ...params])}`;
    const response = await this.transport.execute(this.request('POST', target, body ?? new Uint8Array(0), options));
    if (response.statusCode < 200 || response.statusCode >= 300) throw failure(response.statusCode, response.text());
  }

  /**
   * The artwork for one track, at most `max` pixels on its longest side.
   * 202 means the player is still preparing it and the caller should ask again;
   * 404 means this track has none.
   */
  async art(path: string, max: number, index: number | null, options?: SonixRequestOptions): Promise<SonixArt | 'pending' | null> {
    const params: SonixParam[] = [['path', path], ['max', String(max)]];
    // `index` is a marker for the app's own request queue and is ignored by the
    // player; it lets a command cancel the read for a track that has moved on.
    if (index != null) params.push(['index', String(index)]);
    const response = await this.transport.execute(this.request('GET', `/api/art${query(params)}`, undefined, options));
    if (response.statusCode === 404) return null;
    if (response.statusCode === 202) return 'pending';
    if (response.statusCode < 200 || response.statusCode >= 300) throw failure(response.statusCode, response.text());
    return {
      contentType: response.header('content-type') || 'image/jpeg',
      base64: response.bodyBase64 ?? bytesToBase64(response.body),
    };
  }

  /** True when the transport can write a response body straight to a file. */
  get canStreamDownloads(): boolean {
    return isFileDownloadTransport(this.transport);
  }

  /** Runs a request whose body streams to a file (the index file). */
  async download(target: string, fileUri: string, timeoutMs: number): Promise<void> {
    if (isFileDownloadTransport(this.transport)) {
      const response = await this.transport.download(this.request('GET', target, undefined, { timeoutMs }), fileUri);
      if (response.statusCode < 200 || response.statusCode >= 300) throw failure(response.statusCode, response.text());
      return;
    }
    // No file-download transport (Bluetooth): the body arrives in memory.
    const response = await this.transport.execute(this.request('GET', target, undefined, { timeoutMs }));
    if (response.statusCode < 200 || response.statusCode >= 300) throw failure(response.statusCode, response.text());
    const { writeBytesToFile } = await import('./writeBytes');
    await writeBytesToFile(fileUri, response.body);
  }
}
