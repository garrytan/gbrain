/**
 * OpenClaw lane for always-loaded core memory and the context-pressure
 * notice (core-memory.ts, pressure.ts). One core assembly per TTL window,
 * shared across sessions of the process (core is per brain + source, not per
 * session); staleness of ordinary edits of at most CORE_MEMO_TTL_MS is
 * accepted. The pressure notice fires once per session until its next
 * compaction (at the warn ratio, or earlier when the context grows fast),
 * only when a remember tool is available.
 *
 * #5575 ENG-11: the memo's identity is the brain's trust policy generation
 * plus the core_delivery eligibility (eligibility/generation.ts). Every
 * delivery inside the window revalidates it first (the serve answers
 * `coreTrust.unchanged` without assembling; the direct Postgres path reads
 * it itself), so a tier change, quarantine transition, floor or `trust.%`
 * config change or purge is never answered from the memo. A failed or timed
 * out refresh or revalidation delivers no core block and drops the memo; it
 * never serves the previous value. A serve that cannot report an identity
 * (older serve, unreadable generation) is delivered fresh and not memoized.
 */
import type { BrainEngine } from '../engine.ts';
import { pressureNotice, readPressureGate, shouldWarn, type PressureGate } from './pressure.ts';

export const CORE_MEMO_TTL_MS = 60_000;

interface CoreFetch { text: string; pressure: PressureGate | null }

/**
 * One refresh: a fresh core with its trust identity (null: do not memoize),
 * `unchanged` when the memo's identity still holds (pressure re-read), or
 * null when the fetch failed (deliver nothing).
 */
export type CoreRefresh =
  | { kind: 'fresh'; value: CoreFetch; identity: string | null }
  | { kind: 'unchanged'; identity: string; pressure: PressureGate | null }
  | null;

/** A core fetch given the memo's identity (when one is still inside the TTL window). */
export type CoreFetcher = (sessionId: string | null, memoIdentity: string | null) => Promise<CoreRefresh>;

/** The core_delivery cache identity (generation, then eligibility); null when it cannot be read. Read before the core content. */
export async function coreTrustIdentity(engine: BrainEngine): Promise<string | null> {
  try {
    const { proactiveCacheIdentity } = await import('../eligibility/generation.ts');
    return (await proactiveCacheIdentity({ engine }, 'core_delivery')).identity;
  } catch {
    return null;
  }
}

/** The direct-engine refresh: identity first, then assembly only when it changed. The serve's coreOnly arm follows the same order. */
export async function refreshCoreFromEngine(engine: BrainEngine, sourceId: string, memoIdentity: string | null): Promise<CoreRefresh> {
  const identity = await coreTrustIdentity(engine);
  const pressure = await readPressureGate(engine, true).catch(() => null);
  if (identity !== null && identity === memoIdentity) return { kind: 'unchanged', identity, pressure };
  const { loadCoreBlock } = await import('../core-memory.ts');
  return { kind: 'fresh', value: { text: (await loadCoreBlock(engine, { sessionSourceId: sourceId, excludePrivate: true })).text, pressure }, identity };
}

/** The engine's token estimate for a message list (chars / 4 per message; content-less messages count 0, #2880). */
export function estimateMessageTokens(msgs: ReadonlyArray<{ content?: unknown }>): number {
  return msgs.reduce((sum, m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + (typeof text === 'string' ? Math.ceil(text.length / 4) : 0);
  }, 0);
}

export interface OpenClawCoreLane {
  /** Parts to append after the live context block: the core block and, when due, the pressure notice. */
  additions(input: { sessionId: string | null; messages: ReadonlyArray<{ content?: unknown }>; tokenBudget?: number; availableTools?: Set<string> }): Promise<string[]>;
  /** A compaction starts a new segment: the session may be warned again. */
  compacted(sessionId: string | null): void;
}

export function createOpenClawCoreLane(opts: { workspaceDir?: string; timeoutMs: number; fetcher?: CoreFetcher }): OpenClawCoreLane {
  let memo: { at: number; identity: string; value: CoreFetch } | null = null;
  const warned = new Set<string>();
  const lastTokens = new Map<string, number>();

  async function fetchCore(sessionId: string | null, memoIdentity: string | null): Promise<CoreRefresh> {
    const work = opts.fetcher ? opts.fetcher(sessionId, memoIdentity).catch(() => null) : (async (): Promise<CoreRefresh> => {
      try {
        const { loadConfig } = await import('../config.ts');
        const cfg = loadConfig();
        if (cfg?.engine === 'pglite' && cfg.database_path) {
          const ipc = await import('./resolve-ipc.ts');
          const secret = ipc.readIpcSecret(cfg.database_path);
          if (!secret) return null;
          // bankOnly rides along for version skew: an older serve without the
          // coreOnly arm takes the no-op banking arm instead of assembling.
          const res = await ipc.requestContextPack(ipc.resolveSocketPath(cfg.database_path), {
            secret, coreOnly: true, bankOnly: true,
            ...(memoIdentity ? { coreIdentity: memoIdentity } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(process.env.GBRAIN_SOURCE ? { sourceId: process.env.GBRAIN_SOURCE } : {}),
          });
          if (res === ipc.IPC_UNAVAILABLE || !('ok' in res) || !res.ok || !res.block) return null;
          const trust = res.block.coreTrust;
          const pressure = res.block.pressure ?? null;
          if (trust?.unchanged) return memoIdentity && trust.identity === memoIdentity ? { kind: 'unchanged', identity: trust.identity, pressure } : null;
          return { kind: 'fresh', value: { text: res.block.core?.text ?? '', pressure }, identity: trust?.identity ?? null };
        }
        const { getDirectPostgresEngine } = await import('./reflex.ts');
        const pg = await getDirectPostgresEngine(cfg);
        if (!pg) return null;
        const { resolveSourceId } = await import('../source-resolver.ts');
        return await refreshCoreFromEngine(pg, await resolveSourceId(pg, null, opts.workspaceDir), memoIdentity);
      } catch {
        return null;
      }
    })();
    return Promise.race([work, new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), opts.timeoutMs);
      (t as { unref?: () => void }).unref?.();
    })]);
  }

  async function getCore(sessionId: string | null): Promise<CoreFetch> {
    const live = memo && Date.now() - memo.at < CORE_MEMO_TTL_MS ? memo : null;
    const refresh = await fetchCore(sessionId, live?.identity ?? null);
    if (refresh === null || (refresh.kind === 'unchanged' && refresh.identity !== live?.identity)) {
      memo = null;
      return { text: '', pressure: null };
    }
    if (refresh.kind === 'unchanged') return { text: live!.value.text, pressure: refresh.pressure };
    memo = refresh.identity === null ? null : { at: Date.now(), identity: refresh.identity, value: refresh.value };
    return refresh.value;
  }

  return {
    async additions({ sessionId, messages, tokenBudget, availableTools }) {
      const estimatedTokens = estimateMessageTokens(messages);
      let core: CoreFetch = { text: '', pressure: null };
      try { core = await getCore(sessionId); } catch { /* fail-open */ }
      const out: string[] = [];
      if (core.text && process.env.GBRAIN_CORE !== '0') out.push(core.text);
      const gate = core.pressure;
      const window = gate?.context_window ?? tokenBudget ?? 0;
      const key = sessionId ?? 'default';
      const rememberTool = [...(availableTools ?? [])].some((t) => /(^|[_.:-])remember$/.test(t));
      const growth = Math.max(0, estimatedTokens - (lastTokens.get(key) ?? estimatedTokens));
      lastTokens.set(key, estimatedTokens);
      if (gate?.enabled && rememberTool && window > 0 && !warned.has(key) && process.env.GBRAIN_PRESSURE !== '0'
        && shouldWarn({ used: estimatedTokens, window, warnRatio: gate.warn_ratio, growth })) {
        warned.add(key);
        out.push(pressureNotice(Math.min(99, Math.round((estimatedTokens / window) * 100))));
      }
      return out;
    },
    compacted(sessionId) {
      warned.delete(sessionId ?? 'default');
      lastTokens.delete(sessionId ?? 'default');
    },
  };
}

const lanes = new Map<string, OpenClawCoreLane>();

/** One lane per engine workspace, so the memo and warned set outlive a single assemble() call. */
export function openClawCoreLane(workspaceDir: string | undefined, timeoutMs: number): OpenClawCoreLane {
  const key = workspaceDir ?? '';
  let lane = lanes.get(key);
  if (!lane) { lane = createOpenClawCoreLane({ workspaceDir, timeoutMs }); lanes.set(key, lane); }
  return lane;
}
