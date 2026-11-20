/**
 * Census tracer: a Bun preload for one census child process (`bun --preload <this> src/cli.ts ...`).
 *
 * It changes no behaviour, except the ` census_ref=<n>` tag on a refusal's detail text. It records, as JSON lines in the file GBRAIN_CENSUS_TRACE names:
 *  - `refusal`: every `capabilityMissing(...)` the process builds (caught or not), with a sequence number, the
 *    capability, the member text and the first stack frames outside the Rust engine shell, so the census can name the
 *    file:line that asked. The refusal's `detail` also gets ` census_ref=<seq>`, so the census can tell which refusal
 *    reached the output (and strips it again before comparing);
 *  - `call`: every RustEngine member the process calls, once per member (served or refused), and for the raw-SQL
 *    members (executeRaw, executeRawDirect, withReservedConnection, keywordBoundedRead, runMigration) the first
 *    120 characters of the SQL text of the first call. Each call record has its stack frames: a refusal raised after
 *    an await inside the shell loses its caller's frames, and the call record still has them.
 *
 * The refusal hook is a source transform of src/core/rust-engine/errors.ts (Bun.plugin onLoad), because the refusal is
 * built by a plain exported function; the member hook wraps RustEngine.prototype after the module loads. Nothing in
 * src/ is edited. Without GBRAIN_CENSUS_TRACE the preload does nothing.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { plugin } from 'bun';

const TRACE = process.env.GBRAIN_CENSUS_TRACE;
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

function write(record: Record<string, unknown>): void {
  if (!TRACE) return;
  try { appendFileSync(TRACE, JSON.stringify(record) + '\n'); } catch { /* the census reads what it can */ }
}

/** Stack frames as `src/...:line`, skipping the tracer, the refusal builder and the Rust shell's member stubs. */
function frames(stack: string | undefined): string[] {
  const out: string[] = [];
  for (const line of (stack ?? '').split('\n')) {
    const m = /\(?((?:\/|file:\/\/)[^\s()]+?):(\d+):\d+\)?\s*$/.exec(line.trim());
    if (!m) continue;
    const file = m[1]!.replace(/^file:\/\//, '').replace(ROOT + '/', '');
    if (file.includes('scripts/rust-census/') || file.endsWith('src/core/rust-engine/errors.ts')) continue;
    if (file.includes('node_modules/')) continue;
    out.push(`${file}:${m[2]}`);
    // Rust-shell frames (store members, common.ts) do not count, so the caller outside the shell is still captured.
    if (out.filter((f) => !f.startsWith('src/core/rust-engine')).length >= 8 || out.length >= 24) break;
  }
  return out;
}

if (TRACE) {
  let seq = 0;
  (globalThis as Record<string, unknown>).__gbrainCensusRefusal = (capability: string, member: string, outcome: string) => {
    seq += 1;
    write({ kind: 'refusal', seq, capability, member, outcome, frames: frames(new Error().stack) });
    return seq;
  };

  plugin({
    name: 'gbrain-census-trace',
    setup(build) {
      build.onLoad({ filter: /src\/core\/rust-engine\/errors\.ts$/ }, (args) => {
        const text = readFileSync(args.path, 'utf8');
        const hooked = text.replace(
          /export function capabilityMissing\(([^)]*)\): OperationError \{/,
          (whole) => `${whole}\n  const __censusRef = (globalThis as any).__gbrainCensusRefusal?.(arguments[0], arguments[1], arguments[2] ?? 'none');`,
        ).replace(
          "written=${nothingRan ? 'nothing' : outcome}`",
          "written=${nothingRan ? 'nothing' : outcome} census_ref=${__censusRef}`",
        );
        if (hooked === text || !hooked.includes('census_ref=')) write({ kind: 'tracer_error', message: 'capabilityMissing signature or detail text not found; refusals are not fully traced' });
        return { contents: hooked, loader: 'ts' };
      });
    },
  });

  const RAW = new Set(['executeRaw', 'executeRawDirect', 'withReservedConnection', 'keywordBoundedRead', 'runMigration']);
  const seen = new Set<string>();
  const mod = await import('../../src/core/rust-engine.ts');
  const proto = mod.RustEngine.prototype as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== 'function') continue;
    const original = desc.value as (...args: unknown[]) => unknown;
    Object.defineProperty(proto, name, {
      ...desc,
      value: function traced(this: unknown, ...args: unknown[]) {
        if (!seen.has(name)) {
          seen.add(name);
          const sql = RAW.has(name) && typeof args[0] === 'string' ? (args[0] as string).replace(/\s+/g, ' ').trim().slice(0, 120) : undefined;
          write({ kind: 'call', member: name, ...(sql ? { sql } : {}), frames: frames(new Error().stack) });
        }
        return original.apply(this, args);
      },
    });
  }
}
