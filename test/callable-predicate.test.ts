/**
 * Agent operator contract v1 (A2): isCallable is the one predicate behind
 * tools/list (stdio + HTTP) and dispatch. For every transport × surface ×
 * scope set × gate state, the listed set equals ops.filter(isCallable), and
 * the shared dispatch layer refuses exactly the surface-hidden and
 * network-local ops with the uniform unknown_tool envelope (it never admits
 * an op the list hid on those axes).
 */
import { describe, expect, test } from 'bun:test';
import { operations, type Operation } from '../src/core/operations.ts';
import { isCallable, publishGatesFromDisabled, type CallableContext } from '../src/core/ops/callable.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { operationScopesAllowed } from '../src/core/scope.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const SURFACES = ['verbs', 'starter', 'full'] as const;
const SCOPE_SETS: readonly string[][] = [['read'], ['read', 'write'], ['admin'], ['agent'], ['admin', 'skills_member_self']];
const GATE_STATES: Record<string, boolean>[] = [{}, { 'mcp.publish_skills': true, 'mcp.publish_advisor': true }];

/** The pre-A2 HTTP list filter minus F5's owner-only (`cliOnly`) ops, kept here as the independent oracle. */
function legacyHttpList(surface: typeof SURFACES[number], scopes: string[], gates: Record<string, boolean>): string[] {
  return filterOpsForSurface(operations.filter(op => !op.localOnly && !op.cliOnly), surface)
    .filter(op => operationScopesAllowed(scopes, op) && !(op.publishGateKey && gates[op.publishGateKey] !== true))
    .map(op => op.name);
}

/** The pre-A2 stdio list filter (surface, required-scope grant, gates), minus F5's owner-only (`cliOnly`) ops. */
function legacyStdioList(surface: typeof SURFACES[number], scopes: string[], gates: Record<string, boolean>): string[] {
  return filterOpsForSurface(operations.filter(op => !op.cliOnly), surface)
    .filter(op => !op.requiredScopes?.length || operationScopesAllowed(scopes, op))
    .filter(op => !(op.publishGateKey && gates[op.publishGateKey] !== true))
    .map(op => op.name);
}

describe('isCallable agrees with the list filters it replaced', () => {
  for (const surface of SURFACES) {
    for (const scopes of SCOPE_SETS) {
      for (const gates of GATE_STATES) {
        const label = `${surface} ${scopes.join('+')} gates=${Object.keys(gates).length ? 'on' : 'off'}`;
        test(`http ${label}`, () => {
          const ctx: CallableContext = { transport: 'http', surface, scopes, publishGates: gates };
          expect(operations.filter(op => isCallable(op, ctx)).map(op => op.name)).toEqual(legacyHttpList(surface, scopes, gates));
        });
        test(`stdio ${label}`, () => {
          const ctx: CallableContext = { transport: 'stdio', surface, scopes, publishGates: gates };
          expect(operations.filter(op => isCallable(op, ctx)).map(op => op.name)).toEqual(legacyStdioList(surface, scopes, gates));
        });
      }
    }
  }

  test('publishGatesFromDisabled: a gate is on only when none of its ops is disabled', () => {
    const gated = operations.filter(op => op.publishGateKey);
    expect(Object.values(publishGatesFromDisabled(operations, new Set())).every(Boolean)).toBe(true);
    const off = publishGatesFromDisabled(operations, new Set([gated[0].name]));
    expect(off[gated[0].publishGateKey!]).toBe(false);
  });
});

describe('dispatch refuses what the list hides on the dispatch-enforced axes', () => {
  const engine = {} as BrainEngine;
  const unknown = async (op: Operation, transport: 'stdio' | 'http', allowed: ReadonlySet<string> | undefined) => {
    const r = await dispatchToolCall(engine, op.name, {}, { remote: true, transport, sourceId: 'default', ...(allowed ? { allowedOps: allowed } : {}) });
    if (!r.isError) return false;
    // F5: an owner-only op on stdio is refused with its CLI command instead.
    return ['unknown_tool', 'trusted_local_only'].includes(JSON.parse(r.content[0].text).code);
  };

  for (const surface of SURFACES) {
    for (const transport of ['stdio', 'http'] as const) {
      test(`${transport} ${surface}: unknown_tool ⇔ not callable on surface/locality`, async () => {
        const allowed = surface === 'full' ? undefined : new Set(filterOpsForSurface(operations, surface).map(o => o.name));
        const allScopes = ['admin', 'agent', ...new Set(operations.flatMap(o => o.requiredScopes ?? []))];
        const ctx: CallableContext = { transport, surface, scopes: allScopes, publishGates: { 'mcp.publish_skills': true, 'mcp.publish_advisor': true } };
        const mismatches: string[] = [];
        for (const op of operations) {
          const hidden = !isCallable(op, ctx);
          const refused = await unknown(op, transport, allowed);
          if (hidden !== refused) mismatches.push(`${op.name}: hidden=${hidden} refused=${refused}`);
        }
        expect(mismatches).toEqual([]);
      });
    }
  }
});
