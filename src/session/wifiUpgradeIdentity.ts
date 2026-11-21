import { RemoteApi } from '../data/RemoteApi';

type CatalogProbe = Pick<RemoteApi, 'capabilities' | 'catalogRevision'>;
type PublicIdentity = { revision: string | null; libraryId: string };
/** Resolves true when a read over the current (possibly Bluetooth) link may be sent now. */
export type SourceReadGate = () => Promise<boolean>;
const ungated: SourceReadGate = async () => true;
const publicIdentities = new WeakMap<RemoteApi, { revision: string | null; read: Promise<PublicIdentity | null> }>();

export function readPublicLibraryIdentity(api: RemoteApi, refresh = false, gate = ungated): Promise<PublicIdentity | null> {
  const revision = api.catalogRevision;
  const cached = publicIdentities.get(api);
  if (!refresh && cached && cached.revision === revision) return cached.read;
  const evict = () => {
    if (publicIdentities.get(api)?.read === read) publicIdentities.delete(api);
    return null;
  };
  const read = gate().then(async (allowed) => {
    if (!allowed) return evict();
    const { libraryId } = await api.capabilities({ omitPin: true });
    return libraryId?.trim() ? { revision, libraryId } : evict();
  }).catch(evict);
  publicIdentities.set(api, { revision, read });
  return read;
}

export async function verifyPublicWifiIdentity(
  source: RemoteApi,
  candidateId: string | null | undefined,
  expected: PublicIdentity,
  gate = ungated,
): Promise<boolean> {
  if (!candidateId?.trim()) return false;
  if (expected.revision !== null && expected.revision === source.catalogRevision &&
      publicLibraryIdentityMatches(expected.libraryId, candidateId)) return true;
  const refreshed = await readPublicLibraryIdentity(source, true, gate);
  return refreshed !== null && refreshed.revision === source.catalogRevision &&
    publicLibraryIdentityMatches(refreshed.libraryId, candidateId);
}

const PASSIVE_PROBE_INTERVAL = 30_000;
const PASSIVE_PROBE_MAX_BACKOFF = 120_000;

export class PassiveWifiProbe {
  private api: RemoteApi | null = null;
  private inFlight = false;
  private nextProbeAt = 0;
  private delay = PASSIVE_PROBE_INTERVAL;

  request(api: RemoteApi, upgrade: () => Promise<boolean>): void {
    if (this.api !== api) {
      this.api = api;
      this.inFlight = false;
      this.nextProbeAt = 0;
      this.delay = PASSIVE_PROBE_INTERVAL;
    }
    if (this.inFlight || Date.now() < this.nextProbeAt) return;
    this.inFlight = true;
    void upgrade().catch(() => false).then((upgraded) => {
      if (this.api !== api) return;
      this.inFlight = false;
      this.nextProbeAt = Date.now() + this.delay;
      this.delay = upgraded ? PASSIVE_PROBE_INTERVAL : Math.min(this.delay * 2, PASSIVE_PROBE_MAX_BACKOFF);
    });
  }
}

export function publicLibraryIdentityMatches(expected: string | null | undefined, candidate: string | null | undefined): boolean {
  return Boolean(expected?.trim() && candidate?.trim() && expected === candidate);
}

/**
 * A saved address is only a candidate; it may now belong to another player.
 *
 * Both sides are asked who they are (`/api/info` on SonixLink), not for their
 * library: the identity is the serial, the revision is the index fingerprint.
 * Asking for a catalog page here would download a whole index over the very
 * Bluetooth link this check exists to leave.
 */
export async function verifyWifiUpgradeIdentity(
  current: CatalogProbe,
  candidate: CatalogProbe & Pick<RemoteApi, 'setPin'>,
  publicLibraryId: string,
  pin: string | null,
  canContinue: () => boolean,
  gate = ungated,
  onVerified?: (matchingRevision: string | null) => void,
): Promise<boolean> {
  if (!canContinue() || !(await gate())) return false;
  try {
    // A pending status poll can leave the cached public identity tied to an old library.
    const source = await current.capabilities({ omitPin: true });
    if (!canContinue() || !publicLibraryIdentityMatches(source.libraryId, publicLibraryId)) return false;
    if (pin) candidate.setPin(pin);
    const destination = await candidate.capabilities({ omitPin: true });
    if (!canContinue() || source.libraryId !== destination.libraryId) return false;
    const sourceRevision = current.catalogRevision;
    onVerified?.(sourceRevision != null && sourceRevision === candidate.catalogRevision ? sourceRevision : null);
    return true;
  } catch {
    return false;
  }
}
