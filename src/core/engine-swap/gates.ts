/**
 * The S5b gates a swap run checks before it writes anything, beyond S5a's readiness verdict: what the Rust engine
 * cannot serve yet for this brain (folder rules, until the Rust engine reports `access_control`; access tokens, OAuth
 * clients and remote MCP, until it checks a bearer token).
 *
 * Each gate reads only, and names what it found without values (rule ids, token names and secrets are never read
 * out). A table an older schema lacks counts as empty.
 */
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { EngineCapabilities } from '../engine-capabilities.ts';
import { servedCapabilities } from '../rust-engine/store-capabilities.ts';
import { swapRefusal } from './refusals.ts';
import type { OperationError } from '../ops/contract.ts';

export interface SwapBlocker {
  reason: 'folder_rules_unserved' | 'remote_access_unserved';
  /** What was found, as counts and file names only. */
  detail: string;
}

async function count(engine: BrainEngine, sql: string): Promise<number> {
  try {
    const [row] = await engine.executeRaw<{ n: number }>(sql);
    return Number(row?.n ?? 0);
  } catch (error) {
    rethrowCapabilityRefusal(error);
    if (/does not exist/i.test(String((error as Error)?.message ?? error))) return 0;
    throw error;
  }
}

/** The local paths of this brain's sources (where `.gbrain/access.yml` would be). */
async function sourceRoots(engine: BrainEngine): Promise<string[]> {
  try {
    const rows = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE local_path IS NOT NULL ORDER BY id');
    return rows.map(r => r.local_path!).filter(Boolean);
  } catch (error) {
    rethrowCapabilityRefusal(error);
    if (/does not exist/i.test(String((error as Error)?.message ?? error))) return [];
    throw error;
  }
}

/** Every S5b gate this brain trips, in a fixed order. Empty when none. */
export async function swapBlockers(
  engine: BrainEngine,
  opts: { remoteMcpConfigured: boolean; rustServes?: EngineCapabilities },
): Promise<SwapBlocker[]> {
  const out: SwapBlocker[] = [];
  // Folder rules lift once the Rust member table serves every access_control member (rule add, rm, revert and
  // import included); rust-engine/access-serves-rust f9e6f6876f is the first head where it does.
  const rulesServed = (opts.rustServes ?? servedCapabilities()).has('access_control');
  const rules = await count(engine, 'SELECT count(*)::int AS n FROM access_rules');
  const files = (await sourceRoots(engine)).filter(root => existsSync(join(root, '.gbrain', 'access.yml')));
  if (!rulesServed && (rules > 0 || files.length > 0)) {
    out.push({ reason: 'folder_rules_unserved', detail: `${rules} access rule row(s); ${files.length} source(s) with .gbrain/access.yml` });
  }
  const tokens = await count(engine, 'SELECT count(*)::int AS n FROM access_tokens WHERE revoked_at IS NULL');
  const clients = await count(engine, 'SELECT count(*)::int AS n FROM oauth_clients');
  if (tokens > 0 || clients > 0 || opts.remoteMcpConfigured) {
    out.push({ reason: 'remote_access_unserved', detail: `${tokens} active access token(s); ${clients} OAuth client(s); remote MCP ${opts.remoteMcpConfigured ? 'configured' : 'not configured'}` });
  }
  return out;
}

/** The refusal for the first blocker (the plan lists them all). */
export function blockerRefusal(b: SwapBlocker): OperationError {
  return b.reason === 'folder_rules_unserved'
    ? swapRefusal('folder_rules_unserved', `this brain has folder rules (${b.detail}), which the Rust engine cannot edit yet.`,
      'gbrain access rule add, rm, revert and import refuse on this build\'s Rust engine (it does not report access_control), so a swapped brain could not change who reads its folders.')
    : swapRefusal('remote_access_unserved', `remote callers use this brain (${b.detail}), and the Rust engine cannot check their tokens yet.`,
      'The Rust engine does not check a bearer token yet, so every remote caller would be refused after the swap.');
}
