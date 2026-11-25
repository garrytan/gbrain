/**
 * A Rust-engine stand-in over a SQL engine: every BrainEngine member the Rust store does not serve refuses with the same
 * typed `engine_capability_missing` the Rust engine raises (src/core/rust-engine/members.ts names each member's
 * capability), before any work. The served members run on the wrapped engine. It lets a case find the callers that
 * still reach a refused member without building the addon; the Rust arm (GBRAIN_TEST_RUST_ARM=1) is the real check.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Capability } from '../../src/core/engine-capabilities.ts';
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';
import { RUST_ENGINE_MEMBERS } from '../../src/core/rust-engine/members.ts';
import { servedCapabilities } from '../../src/core/rust-engine/store-capabilities.ts';
import { STORE_MEMBERS } from '../../src/core/rust-engine/store-members/index.ts';

/** The capability the Rust engine refuses `member` with, or null when it serves it. */
function refusalOf(member: string): Capability | null {
  if (Object.hasOwn(STORE_MEMBERS, member)) return null;
  const cls = (RUST_ENGINE_MEMBERS as Record<string, string>)[member];
  return cls === undefined || cls === 'implemented' ? null : (cls as Capability);
}

/** The first stack frame outside this helper, as `src/file.ts:function:line`: the caller that reached a refused member. */
function callerSite(): string {
  for (const line of (new Error().stack ?? '').split('\n').slice(1)) {
    const m = line.match(/at (?:async )?(?:([^\s(]+) )?\(?(\/[^):]+):(\d+):\d+\)?/);
    if (!m || /rust-stand-in|node_modules|bun:/.test(m[2]!)) continue;
    return `${m[2]!.replace(/^.*?\/(src|test)\//, '$1/')}:${m[1] ?? '<anonymous>'}:${m[3]}`;
  }
  return '<unknown>';
}

/** Wraps `engine`; `refused` collects each refusal the stand-in raised (a caller may catch one and carry on). */
export function rustStandIn(engine: BrainEngine, refused: string[] = [], opts: { observe?: boolean } = {}): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'kind') return 'rust';
      if (prop === 'capabilities') return servedCapabilities();
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      const capability = refusalOf(prop);
      if (capability && opts.observe) {
        return (...args: unknown[]) => {
          refused.push(`${prop} ${callerSite()}`);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (capability) {
        return async () => {
          refused.push(`${prop} ${callerSite()}`);
          throw capabilityMissing(capability, prop);
        };
      }
      if (prop === 'transaction' || prop === 'transactionDirect') {
        return (fn: (tx: BrainEngine) => Promise<unknown>, ...rest: unknown[]) =>
          (value as (f: unknown, ...r: unknown[]) => Promise<unknown>).call(target, (tx: BrainEngine) => fn(rustStandIn(tx, refused, opts)), ...rest);
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}
