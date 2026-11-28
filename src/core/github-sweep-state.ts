/**
 * The GitHub connector's sweep state (github-source.ts, which reads and writes the file): the classic state file's shape
 * and the sweep ledger (#10578) that lets a sweep stopped short resume under the same cursor.
 */
import { join } from 'node:path';

export function gitHubStateFile(dir: string): string {
  return join(dir, '.github-source.json');
}

export interface GitHubState {
  last_sweep_at: string | null;
  /** owner/name -> default branch (for check fetches we only need head sha, so this stays small). */
  repos: string[];
  /** Fix wave 4: connector item holds (src/core/connectors/item-holds.ts). */
  item_holds?: unknown;
  /** #10578: the unfinished sweep's ledger (SweepLedger); it never moves the freshness cursor. */
  sweep_progress?: unknown;
}

/** The classic state file's text; anything unreadable reads as no state. */
export function parseGitHubState(raw: string): GitHubState {
  try {
    const parsed = JSON.parse(raw) as Partial<GitHubState>;
    return {
      last_sweep_at: typeof parsed.last_sweep_at === 'string' ? parsed.last_sweep_at : null,
      // Legacy state files may carry canonical-case names; the module keys
      // on lowercase everywhere.
      repos: Array.isArray(parsed.repos)
        ? parsed.repos.filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase())
        : [],
      ...(parsed.item_holds ? { item_holds: parsed.item_holds } : {}),
      ...(parsed.sweep_progress ? { sweep_progress: parsed.sweep_progress } : {}),
    };
  } catch {
    return { last_sweep_at: null, repos: [] };
  }
}


type ListedItem = { kind: string; state: string; updated_at: string };
const LEDGER_KEY = /^[^\s#/]+\/[^\s#/]+#[1-9]\d*$/;

function ledgerEntries(map: unknown): Record<string, string> | null {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const entries = Object.entries(map as Record<string, unknown>);
  return entries.every(([key, version]) => LEDGER_KEY.test(key) && typeof version === 'string' && version)
    ? Object.fromEntries(entries) as Record<string, string> : null;
}

/**
 * #10578: the work a sweep that stopped short already did, keyed `owner/name#number` with the version the listing showed
 * (`kind:state:updated_at`): `done` items are complete, `listed` items passed the first pass and wait only for their
 * detail fetch. It holds only for the cursor (`since`) and mode (`full`) it was built under, so the next run under that
 * cursor picks up where the last one stopped instead of reading every page again. A changed version is checked from
 * scratch, and open PRs (checks change without moving updated_at) and items with no version are never recorded.
 */
export class SweepLedger {
  private constructor(private readonly since: string | null, private readonly full: boolean,
    private readonly done: Record<string, string>, private readonly listed: Record<string, string>) {}

  /** The saved ledger when it is well formed and built under this cursor and mode; otherwise (damaged, stale) an empty one. */
  static resume(raw: unknown, since: string | null, full: boolean): SweepLedger {
    const saved = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const done = ledgerEntries(saved.done), listed = ledgerEntries(saved.listed);
    return saved.since === since && saved.full === full && done && listed ? new SweepLedger(since, full, done, listed) : new SweepLedger(since, full, {}, {});
  }

  private static version(item: ListedItem): string | null {
    return item.updated_at && !(item.kind === 'pr' && item.state === 'open') ? `${item.kind}:${item.state}:${item.updated_at}` : null;
  }

  /** What an earlier run finished for this item at its listed version: `done`, `listed` (detail still due) or null. */
  resumed(key: string, item: ListedItem): 'done' | 'listed' | null {
    const version = SweepLedger.version(item);
    return !version ? null : this.done[key] === version ? 'done' : this.listed[key] === version ? 'listed' : null;
  }

  record(stage: 'done' | 'listed', key: string, item: ListedItem): void {
    delete this.listed[key];
    const version = SweepLedger.version(item);
    if (version) this[stage][key] = version;
  }

  drop(key: string): void {
    delete this.done[key];
    delete this.listed[key];
  }

  toJSON() {
    return { since: this.since, full: this.full, done: this.done, listed: this.listed };
  }
}
