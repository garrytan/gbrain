/** Engine-aware chat readiness for an already connected native server.
 * The synchronous configReadiness API stays file/environment-only.
 * This overlay checks the same DB-resolved extraction model as the worker;
 * it makes no provider call and does not claim a successful chat request.
 */
import type { BrainEngine } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import type { Transport } from './agent-output.ts';
import { configReadiness, type ReadinessEntry } from './readiness.ts';
import { resolveExtractionAvailability } from './facts/extraction-availability.ts';

export async function effectiveReadiness(engine: BrainEngine, config: GBrainConfig,
  transport: Transport, timeoutMs = 2_000): Promise<ReadinessEntry[]> {
  const entries = configReadiness(config, { transport }).entries;
  if (config.remote_mcp) return entries;
  const base = { capability: 'chat_llm' as const, tier: 'probed' as const, http_visible: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chat: ReadinessEntry;
  try {
    const availability = await Promise.race([
      resolveExtractionAvailability(engine),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    chat = availability === null
      ? { ...base, state: 'unknown', reason: 'probe_timeout', why: 'The effective chat-model configuration could not be checked within its budget.' }
      : availability.available
        ? { ...base, state: 'ok', reason: 'configured', why: 'The gateway can serve the engine-resolved extraction model. No chat request was made by this readiness check.' }
        : { ...base, state: 'degraded', reason: 'model_unavailable', why: 'The gateway cannot serve the engine-resolved extraction model in this process. Inspect the existing model route before adding credentials.',
          fix: { argv: ['gbrain', 'providers', 'list'], consent: [], actor: 'agent', requires_exclusive: false,
            why: 'Compare configured model routes and provider availability; this command does not add a key or make a chat request.' } };
  } catch {
    chat = { ...base, state: 'unknown', reason: 'probe_failed', why: 'The effective chat-model configuration could not be read; no missing-key diagnosis is inferred.' };
  } finally { if (timer !== undefined) clearTimeout(timer); }
  return entries.map(entry => entry.capability === 'chat_llm' ? chat : entry);
}
