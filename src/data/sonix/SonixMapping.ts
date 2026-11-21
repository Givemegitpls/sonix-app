// One place for the small translations between SonixLink's vocabulary and the
// app's: what the player can do, how its five play modes number in Compás, and
// what a file extension says about the track.

import type { PlaybackStatus } from '../types';
import type { SonixInfo, SonixState } from './SonixLinkClient';

/**
 * What this player can actually answer. Everything absent is hidden by the
 * interface rather than offered and then failing: no ratings, no server-side
 * sorting, no player settings, no plugins, no playlists' rename/delete, no
 * collection jobs.
 *
 * `wifi_import` and `wifi_import_files` are the Transfer tab. On this player it
 * is a separate mode (thttpd with the firmware's own CGIs on port 4399); the
 * app can browse and write while it runs but cannot start it remotely, which is
 * why `startImport` explains that instead of pretending.
 */
export const SONIX_FEATURES: readonly string[] = [
  // The capability probe in connectionDiscovery asks for this one by name.
  'status',
  'catalog_sync_v1',
  'genre_split',
  'folder_browse',
  'recently_played',
  'favorites_edit',
  'playlist_edit',
  'queue_edit',
  'shuffle_modes',
  'player_accent',
  'device_info',
  'wifi_import',
  'wifi_import_files',
  // Transfer is a mode on the player, not something the phone can switch on or
  // off; the interface says so instead of waiting for the server to disappear.
  'wifi_import_manual',
];

/** A stable identity for this player's library, used to scope local data. */
export function remoteApiLibraryId(info: SonixInfo): string {
  const serial = info.serial?.trim();
  if (serial) return serial;
  const name = info.name?.trim();
  if (name) return name;
  return 'sonix-player';
}

export function modeNumber(name: string | undefined): number {
  switch ((name || '').toLowerCase()) {
    case 'repeat_all': return 1;
    case 'repeat_one': return 2;
    case 'shuffle_repeat': return 3;
    case 'shuffle': return 4;
    case 'normal':
    default: return 0;
  }
}

export function modeName(mode: number): string {
  switch (mode) {
    case 1: return 'repeat_all';
    case 2: return 'repeat_one';
    case 3: return 'shuffle_repeat';
    case 4: return 'shuffle';
    default: return 'normal';
  }
}

const CODECS: ReadonlyArray<[string, string]> = [
  ['flac', 'FLAC'],
  ['dsf', 'DSD'],
  ['dff', 'DSD'],
  ['mp3', 'MP3'],
  ['m4a', 'M4A'],
  ['aac', 'AAC'],
  ['ogg', 'OGG'],
  ['opus', 'OPUS'],
  ['wav', 'WAV'],
  ['ape', 'APE'],
  ['wv', 'WAVPACK'],
  ['alac', 'ALAC'],
  ['m4b', 'M4A'],
];

export function codecFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  for (const [suffix, name] of CODECS) {
    if (extension === suffix) return name;
  }
  return extension.toUpperCase();
}

export interface StatusExtras {
  deviceModel: string | null;
  playerVersion: string | null;
}

/** `/api/state` as the app's playback status. */
export function statusFromState(state: SonixState, extras: StatusExtras): PlaybackStatus {
  return {
    playing: state.state === 1,
    paused: state.state === 2,
    title: state.title || '',
    artist: state.artist || '',
    album: state.album || '',
    positionSeconds: Number(state.position || 0),
    durationSeconds: Number(state.duration || 0),
    volume: Number(state.volume || 0),
    playMode: modeNumber(state.mode),
    codec: codecFromPath(state.path) ?? undefined,
    sourceBitDepth: Number(state.bits || 0) || undefined,
    sourceSampleRateHz: Number(state.sample_rate || 0) || undefined,
    bluetoothAudioOutput: null,
    favorite: state.favourite,
    rating: null,
    accentColor: /^#[0-9a-fA-F]{6}$/.test(state.accent || '') ? state.accent.toUpperCase() : null,
    deviceModel: extras.deviceModel,
    playerVersion: extras.playerVersion,
    settingsRevision: null,
    settingsEpoch: null,
    collectionJob: null,
  };
}

/**
 * The value the player's album list uses for a record: its name, a 0x1f, and
 * the key album_key() gave it. That is what keeps two "Greatest Hits" apart
 * (`ALBUM_VALUE_MATCH` in src/system/library/library.c).
 */
export function albumValue(album: string, albumKey: string | null | undefined): string {
  return albumKey ? `${album}\u001f${albumKey}` : album;
}
