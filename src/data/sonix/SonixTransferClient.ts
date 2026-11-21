// The player's Transfer mode: a thttpd on the same Wi-Fi, serving the firmware's
// own CGI programs (`list`, `upload`, `create`, `move`, `delete`, and the
// player's `sonix-list`), described in
// `sonix-player/web/build/index.html`. It is a different server from SonixLink:
// port 4399 (and 80 under the name), alive only while Transfer is on.
//
// The card is always visible to those CGIs as /mnt/sd_0/ — the player bind
// mounts its real root there when the transfer server starts — so the paths
// this class trades in are card-relative, exactly like the app's own.

import type { WifiImportDirectoryPage, WifiImportFileEntry, WifiImportStatus, WifiImportUploadResult } from '../types';
import type { NativeUploadProgress } from '../nativeFileUpload';

const CARD_ROOT = '/mnt/sd_0';
const PROBE_TIMEOUT_MS = 2500;

interface SonixListEntry {
  path: string;
  name: string;
  ctime?: string;
  size?: number;
}

function transferBase(wifiBaseUrl: string | null | undefined): string | null {
  if (!wifiBaseUrl) return null;
  const match = /^http:\/\/(\[[^\]]+\]|[^/:]+)(?::\d+)?\/?$/i.exec(wifiBaseUrl.trim());
  if (!match) return null;
  return `http://${match[1]}:4399`;
}

function absolute(path: string): string {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  return clean ? `${CARD_ROOT}/${clean}` : CARD_ROOT;
}

function relative(path: string): string {
  return path.startsWith(`${CARD_ROOT}/`) ? path.slice(CARD_ROOT.length + 1).replace(/\/+$/, '') : path.replace(/^\/+/, '');
}

export class SonixTransferClient {
  private readonly base: string | null;

  constructor(wifiBaseUrl: string | null | undefined) {
    this.base = transferBase(wifiBaseUrl);
  }

  get available(): boolean {
    return this.base != null;
  }

  private async fetch(path: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
    if (!this.base) throw new Error('File transfer needs a Wi-Fi connection to the player');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.base}/${path}`, { ...init, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(): Promise<boolean> {
    if (!this.base) return false;
    try {
      const response = await this.fetch(`sonix-list?path=${encodeURIComponent(CARD_ROOT)}`, { cache: 'no-store' }, PROBE_TIMEOUT_MS);
      return response.ok;
    } catch {
      return false;
    }
  }

  async status(): Promise<WifiImportStatus> {
    if (!this.base) return { state: 'stopped', error: null };
    return (await this.probe()) ? { state: 'ready', error: null } : { state: 'stopped', error: null };
  }

  async start(): Promise<void> {
    if (await this.probe()) return;
    throw new Error('Turn on Transfer on the player (Wireless → Transfer), then try again.');
  }

  async stop(): Promise<void> {
    // The transfer server is switched off on the player, not by the phone.
  }

  async list(path: string, offset: number, limit: number, showHidden: boolean): Promise<WifiImportDirectoryPage> {
    const target = absolute(path);
    const hidden = showHidden ? '&hidden=1' : '';
    const response = await this.fetch(`sonix-list?path=${encodeURIComponent(target)}${hidden}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 404 ? 'Could not read this folder.' : `Could not read the SD card (HTTP ${response.status})`);
    const json = (await response.json()) as SonixListEntry[];
    if (!Array.isArray(json)) throw new Error('The player returned an invalid folder listing');

    const entries: WifiImportFileEntry[] = json
      .filter((entry) => entry && typeof entry.name === 'string' && typeof entry.path === 'string')
      .map((entry) => ({
        name: entry.name,
        path: relative(entry.path),
        isDirectory: entry.size === undefined || entry.size === null,
        size: typeof entry.size === 'number' && entry.size > 0 ? entry.size : 0,
      }))
      .sort((left, right) => (left.isDirectory === right.isDirectory
        ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
        : left.isDirectory ? -1 : 1));

    const slice = entries.slice(offset, offset + limit);
    return {
      path: relative(target),
      entries: slice,
      offset,
      nextOffset: offset + slice.length < entries.length ? offset + slice.length : null,
      total: entries.length,
    };
  }

  private async action(name: string, fields: Record<string, string>): Promise<Response> {
    // The CGIs live at the web root: "create", "move", "delete", "upload".
    const response = await this.fetch(name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Object.entries(fields)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&'),
    });
    return response;
  }

  async mkdir(path: string, name: string): Promise<void> {
    const target = `${absolute(path)}/${name}`;
    const response = await this.action('create', { path: target });
    if (response.ok) return;
    // The folder may already be there; the CGI has no separate "exists" answer,
    // so ask the listing instead of failing an upload that had nothing to do.
    const listed = await this.fetch(`sonix-list?path=${encodeURIComponent(target)}`, { cache: 'no-store' });
    if (!listed.ok) throw new Error('Could not create the folder.');
  }

  async rename(path: string, name: string): Promise<void> {
    const from = absolute(path);
    const slash = path.lastIndexOf('/');
    const destination = `${absolute(slash < 0 ? '' : path.slice(0, slash))}/${name}`;
    const response = await this.action('move', { oldPath: from, newPath: destination });
    if (!response.ok) throw new Error('The player cannot rename files on this SD card.');
  }

  async remove(path: string): Promise<void> {
    const response = await this.action('delete', { path: absolute(path) });
    if (!response.ok) throw new Error('Could not delete file.');
  }

  async upload(fileUri: string, path: string, name: string, onProgress: (progress: NativeUploadProgress) => void, signal?: AbortSignal): Promise<WifiImportUploadResult> {
    if (!this.base) throw new Error('File transfer needs a Wi-Fi connection to the player');
    const { uploadMultipartNative } = await import('../nativeFileUpload');
    const response = await uploadMultipartNative(
      `${this.base}/upload`,
      fileUri,
      { path: absolute(path) },
      'files[]',
      name,
      onProgress,
      signal,
    );
    if (response.status < 200 || response.status >= 300) throw new Error(`The player refused the file (HTTP ${response.status})`);
    return { ok: true, path: path ? `${path}/${name}` : name, name, bytes: 0 };
  }
}
