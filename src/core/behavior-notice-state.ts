/**
 * Release order, baselines and the chat-fallback chain disclosure behind the `behavior_changes` notice
 * (core/behavior-change-notice.ts holds the BEHAVIOR_CHANGES table and the module doc; delivery and markers live in
 * core/behavior-notice-delivery.ts).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { gbrainPath, type GBrainConfig } from './config.ts';
import { VERSION } from '../version.ts';
import { diagnoseChatFallbackEntry, readChatFallbackPlanes, type ChatFallbackPlane } from './ai/chat-fallback-planes.ts';
import { mergedProviderEnv } from './ai/provider-env.ts';

export const TRANSCRIPT_REINGEST_MULTIPLIER = 'about 6.75x';
export const BEHAVIOR_NOTICE_CODE = 'behavior_changes';
/** A brain created this recently, with no recorded baseline, counts as a fresh install. */
export const FRESH_BRAIN_GRACE_MS = 60 * 60 * 1000;
export const HTTP_SHOWN_KEY = 'notices.behavior_changes.http';
export const HTTP_SHOWN_CAP = 500;
export const CLIENT_ID_MAX = 128;
/** The baseline recorded for a brain that existed before baselines were kept. */
export const PREDATES = '0';
export const RELEASE = /^\d+(\.\d+)*$/;

export type BehaviorChannel = 'cli' | 'stdio' | 'http';

/** Release order over every numeric segment (`0.60.65.0` style; missing segments are 0). */
export function compareReleases(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function noticeDir(): string {
  return gbrainPath('notices', 'behavior-changes');
}

export const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Brain identity under GBRAIN_HOME: the brain id plus a hash of its database location (never the location itself). */
export function behaviorBrainKey(cfg: GBrainConfig | null | undefined, brainId = 'host'): string {
  const location = cfg?.database_url ?? cfg?.database_path ?? '';
  return `${safe(brainId)}-${createHash('sha256').update(location).digest('hex').slice(0, 12)}`;
}

let brainIdMemo: Promise<string> | null = null;

/** The brain id this process routes to (`--brain`, GBRAIN_BRAIN_ID, .gbrain-mount), `host` when unresolvable; resolved once per process. */
export function currentBrainId(): Promise<string> {
  brainIdMemo ??= (async () => {
    try {
      const { resolveBrainId } = await import('./brain-resolver.ts');
      const { getCliOptions } = await import('./cli-options.ts');
      return resolveBrainId(getCliOptions().brain);
    } catch {
      return 'host';
    }
  })();
  return brainIdMemo;
}

// ── eligibility ─────────────────────────────────────────────────────────────

const baselinePath = (brainKey: string) => join(noticeDir(), `${brainKey}.baseline`);

export function readBaseline(brainKey: string): string | null {
  try {
    const v = readFileSync(baselinePath(brainKey), 'utf8').trim();
    return RELEASE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Record a baseline; `exclusive` keeps an existing one (first writer wins). Never throws. */
export function writeBaseline(brainKey: string, since: string, exclusive: boolean): void {
  try {
    mkdirSync(noticeDir(), { recursive: true });
    writeFileSync(baselinePath(brainKey), `${since}\n`, { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
  } catch { /* unwritable home or a concurrent first writer: eligibility is re-derived next time */ }
}

/** `gbrain init` created this brain's database: it is a fresh install at this version. */
export function stampFreshBrainBaseline(brainKey: string): void {
  writeBaseline(brainKey, VERSION, false);
}

export const laterRelease = (a: string, b: string) => (compareReleases(a, b) >= 0 ? a : b);

// ── content ─────────────────────────────────────────────────────────────────

export interface ChainDisclosure {
  plane: ChatFallbackPlane;
  entries: string[];
  providers: string[];
  onRefusal: boolean;
  filePath: string;
}

/** The effective chain as disclosed to the local owner, or null when no chain is set. Never throws. */
export async function chainDisclosure(engine: BrainEngine | null, cfg: GBrainConfig | null): Promise<ChainDisclosure | null> {
  try {
    const planes = await readChatFallbackPlanes(engine);
    if (!planes.effective) return null;
    const env = mergedProviderEnv(cfg, process.env);
    const providers = [...new Set(planes.effective.chain
      .map(entry => diagnoseChatFallbackEntry(entry, { env, userCapKeys: [] }).provider)
      .filter((p): p is string => !!p))];
    return { plane: planes.effective.plane, entries: planes.effective.chain, providers, onRefusal: planes.onRefusal.value, filePath: planes.filePath };
  } catch {
    return null;
  }
}

export const DOCTOR_ARGV = ['gbrain', 'doctor', '--only', BEHAVIOR_NOTICE_CODE, '--json'];
