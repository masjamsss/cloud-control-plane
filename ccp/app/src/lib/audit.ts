import { currentProjectId, scopedKey, SAMPLE_ESTATE_ID } from '@/lib/projectScope';

/**
 * Append-only audit log for governance actions (enrolments, role/team changes,
 * team edits, policy changes …). A leaf store — depends on nothing but
 * projectScope — so any module can record without a dependency cycle. Persisted
 * locally; a real `ccp-api` would keep the same append-only shape server-side.
 *
 * Project-scoped: the storage key is computed at call time from the
 * active project, so switching projects never needs a reload. Every entry also
 * carries the projectId it was recorded under.
 */

export interface AuditEntry {
  id: string;
  at: string; // ISO
  actor: string; // account id (resolve to a name at render time)
  action: string; // short verb phrase, e.g. "Changed role"
  summary: string; // human detail
  projectId: string; // the project this action was recorded under
}

// legacy key from the Gerbang era — reads old data, never written
const LEGACY_KEY = 'gerbang.audit.v1';
const storeKey = (): string => scopedKey('audit');
const CAP = 500;
const memory = new Map<string, string>();

function readRaw(): string | null {
  // One-time legacy migration: an un-namespaced v1 key surfaces under the
  // sample estate exactly once.
  try {
    if (
      currentProjectId() === SAMPLE_ESTATE_ID &&
      localStorage.getItem(LEGACY_KEY) !== null &&
      localStorage.getItem(storeKey()) === null
    ) {
      localStorage.setItem(storeKey(), localStorage.getItem(LEGACY_KEY)!);
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch {
    /* storage unavailable — memory fallback path needs no migration */
  }
  try {
    return localStorage.getItem(storeKey());
  } catch {
    return memory.get(storeKey()) ?? null;
  }
}
function writeRaw(value: string): void {
  try {
    localStorage.setItem(storeKey(), value);
  } catch {
    memory.set(storeKey(), value);
  }
}
function load(): AuditEntry[] {
  const raw = readRaw();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuditEntry[]) : [];
  } catch {
    return [];
  }
}

/** Append an entry (newest first). Best-effort — never throws into the caller. */
export function recordAudit(actor: string, action: string, summary: string): void {
  try {
    const entries = load();
    entries.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actor,
      action,
      summary,
      projectId: currentProjectId(),
    });
    writeRaw(JSON.stringify(entries.slice(0, CAP)));
  } catch {
    /* auditing must never break the action it records */
  }
}

/** Newest first. */
export function listAudit(): AuditEntry[] {
  return load();
}

export function resetAuditForTests(): void {
  writeRaw('[]');
}
