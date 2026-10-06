/**
 * OpenClaw lane for always-loaded core memory and the context-pressure
 * notice (core-memory.ts, pressure.ts). One read-only core fetch per TTL
 * window, shared across sessions of the process (core is per brain + source,
 * not per session); staleness of at most CORE_MEMO_TTL_MS is accepted. The
 * pressure notice fires once per session until its next compaction (at the
 * warn ratio, or earlier when the context grows fast), only when a remember
 * tool is available.
 */
import { pressureNotice, shouldWarn, type PressureGate } from './pressure.ts';

export const CORE_MEMO_TTL_MS = 60_000;

interface CoreFetch { text: string; pressure: PressureGate | null }

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

export function createOpenClawCoreLane(opts: { workspaceDir?: string; timeoutMs: number }): OpenClawCoreLane {
  let memo: { at: number; value: CoreFetch } | null = null;
  const warned = new Set<string>();
  const lastTokens = new Map<string, number>();

  async function fetchCore(sessionId: string | null): Promise<CoreFetch | null> {
    const work = (async (): Promise<CoreFetch | null> => {
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
            ...(sessionId ? { sessionId } : {}),
            ...(process.env.GBRAIN_SOURCE ? { sourceId: process.env.GBRAIN_SOURCE } : {}),
          });
          if (res === ipc.IPC_UNAVAILABLE || !('ok' in res) || !res.ok || !res.block) return null;
          return { text: res.block.core?.text ?? '', pressure: res.block.pressure ?? null };
        }
        const { getDirectPostgresEngine } = await import('./reflex.ts');
        const pg = await getDirectPostgresEngine(cfg);
        if (!pg) return null;
        const { resolveSourceId } = await import('../source-resolver.ts');
        const sourceId = await resolveSourceId(pg, null, opts.workspaceDir);
        const { loadCoreBlock } = await import('../core-memory.ts');
        const { readPressureGate } = await import('./pressure.ts');
        return {
          text: (await loadCoreBlock(pg, { sessionSourceId: sourceId, excludePrivate: true })).text,
          pressure: await readPressureGate(pg, true).catch(() => null),
        };
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
    if (memo && Date.now() - memo.at < CORE_MEMO_TTL_MS) return memo.value;
    const value = await fetchCore(sessionId);
    // A failed fetch keeps the previous value for one more window rather than flapping.
    memo = { at: Date.now(), value: value ?? memo?.value ?? { text: '', pressure: null } };
    return memo.value;
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
