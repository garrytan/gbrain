/**
 * Child-side side-effect probe for the help gate (#6114). Preloaded into the
 * CLI under test (`bun --preload <this> src/cli.ts ...`): every `fetch` and
 * every subprocess spawn (node:child_process goes through Bun.spawn) is
 * appended to GBRAIN_TEST_SIDE_EFFECT_LOG and blocked, so a help invocation
 * that would call a provider or start a process is recorded instead of
 * leaving the machine. The preflight's sanitizing re-exec (marked with
 * GBRAIN_CWD_ENV_QUARANTINED) is the one spawn allowed through.
 */
import { appendFileSync } from 'node:fs';

const log = process.env.GBRAIN_TEST_SIDE_EFFECT_LOG;

function record(kind: string, detail: string): void {
  if (log) appendFileSync(log, `${JSON.stringify({ kind, detail: detail.slice(0, 300) })}\n`);
}

function argvOf(first: unknown): string {
  if (Array.isArray(first)) return first.join(' ');
  if (first && typeof first === 'object' && Array.isArray((first as { cmd?: unknown }).cmd)) return ((first as { cmd: string[] }).cmd).join(' ');
  return String(first);
}

function isPreflightReexec(args: unknown[]): boolean {
  const opts = (Array.isArray(args[0]) ? args[1] : args[0]) as { env?: Record<string, string | undefined> } | undefined;
  return Boolean(opts?.env?.GBRAIN_CWD_ENV_QUARANTINED);
}

if (log) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: unknown) => {
    record('fetch', String(input instanceof Request ? input.url : input));
    throw new Error('network blocked by the help gate probe');
  }, { preconnect: realFetch.preconnect }) as typeof fetch;

  for (const name of ['spawn', 'spawnSync'] as const) {
    const real = Bun[name] as (...a: unknown[]) => unknown;
    (Bun as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      if (isPreflightReexec(args)) return real(...args);
      record(name, argvOf(args[0]));
      throw new Error('subprocess blocked by the help gate probe');
    };
  }
}
