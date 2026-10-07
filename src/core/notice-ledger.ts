/**
 * Notice dedupe, coaching budget and mute (agent operator contract v1, A6).
 *
 * - stdio / CLI: one process-wide ledger (dedupe per process).
 * - HTTP is stateless: the ledger lives in ServeHttpContext and is keyed by
 *   authenticated principal + transport-resolved session id (never a
 *   `_meta.session_id` taken from tool arguments); with no session id, by
 *   principal. Bounded: 10k keys, 24 h TTL.
 * - `degraded` and `safety` notices are never deduped on HTTP (attached to
 *   every affected call). At most 2 `coaching` notices per session.
 * - Mute applies to `coaching` and `info` only: globally for the local owner
 *   (`gbrain notices mute <code>`), per client on remote transports
 *   (`mute_notice`). Persisted under GBRAIN_HOME.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from './config.ts';
import type { Notice, Transport } from './agent-output.ts';

const MAX_KEYS = 10_000;
const TTL_MS = 24 * 60 * 60 * 1000;
export const COACHING_BUDGET_PER_SESSION = 2;
/** Notices that describe THIS call's result (never deduped): the diagnosis must ride every affected call. */
/** The one muteable `ask`: an unanswered first-run bundle must stay dismissible. Every other ask always shows. */
export const MUTEABLE_ASK_CODES: ReadonlySet<string> = new Set(['first_run_decisions']);
export const PER_CALL_NOTICE_CODES: ReadonlySet<string> = new Set(['empty_retrieval', 'unknown_param', 'listing_truncated', 'former_relationships_hidden', 'source_binding_narrowed', 'local_transcripts', 'held_files', 'relational_chain', 'mention_index', 'delta_incomplete']);

export interface NoticeAudience {
  transport: Transport;
  /** Authenticated principal (HTTP client id); undefined for the local owner. */
  principal?: string;
  /** Transport-resolved session id. */
  sessionId?: string;
}

export class NoticeLedger {
  private seen = new Map<string, number>();
  private coaching = new Map<string, { count: number; at: number }>();
  private tallies = new Map<string, { n: number; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private session(a: NoticeAudience): string {
    return `${a.principal ?? 'local'}|${a.sessionId ?? ''}`;
  }

  private prune<V>(map: Map<string, V>, at: (v: V) => number): void {
    const cutoff = this.now() - TTL_MS;
    for (const [k, v] of map) {
      if (at(v) >= cutoff && map.size <= MAX_KEYS) break;
      map.delete(k);
    }
  }

  /** Count one more `key` event in this audience's session (e.g. a reranker-degraded call) and return the session total. */
  tally(audience: NoticeAudience, key: string): number {
    const k = `${this.session(audience)}|${key}`;
    const n = (this.tallies.get(k)?.n ?? 0) + 1;
    this.tallies.delete(k);
    this.tallies.set(k, { n, at: this.now() });
    this.prune(this.tallies, v => v.at);
    return n;
  }

  /** Filter one call's notices: mute, dedupe and the coaching budget. Never throws. */
  admit(notices: readonly Notice[], audience: NoticeAudience, muted: ReadonlySet<string> = new Set()): Notice[] {
    const out: Notice[] = [];
    const session = this.session(audience);
    for (const n of notices) {
      if ((n.kind === 'coaching' || n.kind === 'info' || MUTEABLE_ASK_CODES.has(n.code)) && muted.has(n.code)) continue;
      const always = PER_CALL_NOTICE_CODES.has(n.code)
        || (audience.transport === 'http' && (n.kind === 'degraded' || n.kind === 'safety'));
      const key = `${session}|${n.code}`;
      if (!always && this.seen.has(key)) continue;
      if (n.kind === 'coaching') {
        const used = this.coaching.get(session)?.count ?? 0;
        if (used >= COACHING_BUDGET_PER_SESSION) continue;
        this.coaching.delete(session);
        this.coaching.set(session, { count: used + 1, at: this.now() });
      }
      if (!always) {
        this.seen.delete(key);
        this.seen.set(key, this.now());
      }
      out.push(n);
    }
    this.prune(this.seen, at => at);
    this.prune(this.coaching, v => v.at);
    return out;
  }
}

let processLedger: NoticeLedger | null = null;
/** The stdio / CLI ledger: one per process. */
export function processNoticeLedger(): NoticeLedger {
  processLedger ??= new NoticeLedger();
  return processLedger;
}
export function __resetProcessNoticeLedgerForTests(): void { processLedger = null; }

// ── mute store ──────────────────────────────────────────────────────────────

interface MuteFile { global: string[]; clients: Record<string, string[]> }

export function noticeMutePath(): string {
  return gbrainPath('notices', 'muted.json');
}

function readMuteFile(): MuteFile {
  try {
    const raw = JSON.parse(readFileSync(noticeMutePath(), 'utf8')) as Partial<MuteFile>;
    return { global: Array.isArray(raw.global) ? raw.global : [], clients: raw.clients && typeof raw.clients === 'object' ? raw.clients : {} };
  } catch {
    return { global: [], clients: {} };
  }
}

/** Muted codes for an audience: the owner's global list plus the client's own list on remote transports. */
export function mutedNoticeCodes(principal?: string): Set<string> {
  const f = readMuteFile();
  return new Set([...f.global, ...(principal ? f.clients[principal] ?? [] : [])]);
}

/** Persist a (un)mute. `principal` scopes it to one remote client; omitted = the local owner (global). */
export function setNoticeMuted(code: string, muted: boolean, principal?: string): string[] {
  const f = readMuteFile();
  const list = new Set(principal ? f.clients[principal] ?? [] : f.global);
  if (muted) list.add(code); else list.delete(code);
  const sorted = [...list].sort();
  if (principal) f.clients[principal] = sorted; else f.global = sorted;
  writeMuteFile(f);
  return sorted;
}

/**
 * The owner's unmute: clears the code from the global list and from the
 * stdio MCP pipe's list (`mute_notice` over stdio stores under `stdio`).
 * Returns the owner's remaining muted codes across both.
 */
export function unmuteNoticeForOwner(code: string): string[] {
  const f = readMuteFile();
  f.global = f.global.filter(c => c !== code);
  if (f.clients.stdio) f.clients.stdio = f.clients.stdio.filter(c => c !== code);
  writeMuteFile(f);
  return [...new Set([...f.global, ...(f.clients.stdio ?? [])])].sort();
}

function writeMuteFile(f: MuteFile): void {
  const path = noticeMutePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
