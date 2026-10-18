/**
 * #6621 / #6663: the grant diagnosis names execution prerequisites a snapshot
 * or scope change alone does not satisfy (confirm_memory needs memory_confirm;
 * membership operations need explicit snapshot approval, which a grant with no
 * snapshot never gives), and `auth rescope --refresh-operations --add` works on
 * a token with no snapshot without narrowing it or approving other membership
 * operations (D17).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { describeGrantDiagnosis, grantOperationGaps } from '../src/core/harness/capabilities.ts';
import { EXECUTION_PREREQUISITES, requiresExplicitApproval } from '../src/core/ops/execution-prerequisites.ts';
import { MEMORY_CONFIRM_SCOPE, requireOwnerConfirmation } from '../src/core/trust/confirm.ts';
import { memberAuthority } from '../src/core/shared-skills/membership-authority.ts';
import { rescopeLegacyToken, type LegacyGrantAxis } from '../src/core/grants/legacy-token.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { operations } from '../src/core/operations.ts';
import { operationScopesAllowed } from '../src/core/scope.ts';

const gapsFor = (scopes: string[], allowedOperations: string[] | null) =>
  grantOperationGaps({ scopes, allowedOperations, clientSurface: null, serverSurface: null, disabled: new Set() });
const diagnose = (gaps: Awaited<ReturnType<typeof gapsFor>>, hasSnapshot: boolean, target = { kind: 'legacy_token', flag: ['--token', 't'] } as const) =>
  describeGrantDiagnosis(gaps, { hasSnapshot, provenance: null, clientSurface: null, clientSurfaceSetBy: null, serverSurface: null, target: target as never });
const MEMBERSHIP = ['join_brain', 'leave_brain', 'sync_brain_skills'];

describe('execution prerequisite table', () => {
  test('names registered operations and the enforcement it describes', () => {
    const names = new Set(operations.map(op => op.name));
    for (const op of Object.keys(EXECUTION_PREREQUISITES)) expect(names.has(op)).toBe(true);
    expect(EXECUTION_PREREQUISITES.confirm_memory).toMatchObject({ kind: 'owner_granted_scope', scope: MEMORY_CONFIRM_SCOPE });
    // test-reads-source-ok[structural]: the membership ops' enforcement is the memberAuthority call sites; this pins that the prerequisite table names exactly those ops.
    const membershipSource = readFileSync(join(resolve(import.meta.dir, '..'), 'src/core/shared-skills/membership.ts'), 'utf8');
    const enforced = [...membershipSource.matchAll(/memberAuthority\(\w+, '([a-z_]+)'\)/g)].map(m => m[1]).sort();
    expect(enforced).toEqual(MEMBERSHIP);
    expect(Object.keys(EXECUTION_PREREQUISITES).filter(requiresExplicitApproval).sort()).toEqual(MEMBERSHIP);
  });
});

describe('#6621 confirm_memory needs memory_confirm, not just a snapshot', () => {
  test('the diagnosis names the prerequisite next to the snapshot repair; counts are unchanged', async () => {
    const gaps = await gapsFor(['read', 'write'], ['get_page', 'put_page']);
    expect(gaps.unreachable).toContain('confirm_memory');
    expect(gaps.prerequisites).toContainEqual(expect.objectContaining({ operation: 'confirm_memory', prerequisite: `scope:${MEMORY_CONFIRM_SCOPE}` }));
    const d = diagnose(gaps, true);
    expect(d.unreachable_count).toBe(gaps.unreachable.length);
    expect(d.prerequisites.map(p => p.operation)).toContain('confirm_memory');
    expect(d.fix?.user_message).toContain(MEMORY_CONFIRM_SCOPE);
    let gate = 'allowed';
    try {
      await requireOwnerConfirmation({ remote: true, auth: { scopes: ['read', 'write', 'admin'] } } as never,
        { ref: 'f1', token: 't', summary: 's', command: ['gbrain', 'trust', 'confirm', 'f1'] });
    } catch (e) { gate = (e as { code?: string }).code ?? String(e); }
    expect(gate).toBe('insufficient_scope');
  });

  test('a grant that holds memory_confirm has no prerequisite left', async () => {
    const gaps = await gapsFor(['read', 'write', MEMORY_CONFIRM_SCOPE], null);
    expect(gaps.prerequisites.map(p => p.operation)).not.toContain('confirm_memory');
  });
});

describe('#6663 membership operations on a grant with no snapshot', () => {
  test('are unreachable, named, and get a refresh repair', async () => {
    const scopes = ['read', 'skills_member_self'];
    const gaps = await gapsFor(scopes, null);
    expect(gaps.approvalExcluded.sort()).toEqual(MEMBERSHIP);
    for (const op of MEMBERSHIP) expect(gaps.unreachable).toContain(op);
    expect(gaps.unreachable).toHaveLength(MEMBERSHIP.length);
    let gate = 'allowed';
    try {
      await memberAuthority({ remote: true, auth: { scopes, principal: { kind: 'legacy_token', id: 't1' }, allowedOperations: undefined }, engine: { executeRaw: async () => [] } } as never, 'join_brain');
    } catch (e) { gate = (e as { code?: string }).code ?? String(e); }
    expect(gate).toBe('permission_denied');
    const d = diagnose(gaps, false);
    expect(d.blockers).toContainEqual({ blocker: 'explicit_approval', excluded_count: MEMBERSHIP.length });
    expect(d.fix?.argv).toEqual(['gbrain', 'auth', 'rescope', '--token', 't', '--refresh-operations']);
    expect(d.fix?.then_argv).toEqual(['gbrain', 'auth', 'rescope', '--token', 't', '--refresh-operations', '--add', '<OPERATIONS>']);
    const client = diagnose(gaps, false, { kind: 'oauth_client', id: 'c1' } as never);
    expect(client.fix?.then_argv).toEqual(['gbrain', 'auth', 'rescope', '--client', 'c1', '--operations', '<OPERATIONS>']);
  });

  test('a snapshot that names a membership operation reaches it', async () => {
    const gaps = await gapsFor(['read', 'skills_member_self'], ['get_page', 'join_brain']);
    expect(gaps.approvalExcluded).toEqual([]);
    expect(gaps.unreachable).not.toContain('join_brain');
    expect(gaps.prerequisites.map(p => p.operation)).not.toContain('join_brain');
  });
});

describe('D17: --refresh-operations --add on a token with no snapshot', () => {
  let engine: BrainEngine;
  beforeAll(async () => { const pg = new PGLiteEngine(); await pg.connect({}); await pg.initSchema(); engine = pg; }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('previews the approval-only operations, then materializes the reachable set plus exactly the added one', async () => {
    const scopes = ['read', 'write', 'skills_member_self'];
    await mintLegacyToken(engine, { name: 'member-example', scopes, takesHolders: ['world'] });
    const base = { target: { name: 'member-example' }, reset: [] as LegacyGrantAxis[], refreshOperations: true, allNew: false, json: true };
    const preview = await rescopeLegacyToken(engine, { ...base, dryRun: false });
    expect(preview.written).toBe(false);
    expect(preview.after.operations).toBe('unrestricted');
    expect(preview.refresh).toMatchObject({ materialized: true, added: [] });
    expect([...preview.refresh!.available].sort()).toEqual(MEMBERSHIP);

    await expect(rescopeLegacyToken(engine, { ...base, allNew: true, dryRun: false })).rejects.toThrow(/name each one with --add/);

    const applied = await rescopeLegacyToken(engine, { ...base, add: ['join_brain'], dryRun: false });
    expect(applied.written).toBe(true);
    const granted = applied.after.operations as string[];
    const reachable = operations.filter(op => !op.localOnly && operationScopesAllowed(scopes, op) && !MEMBERSHIP.includes(op.name)).map(op => op.name);
    expect([...granted].sort()).toEqual([...reachable, 'join_brain'].sort());
    expect(granted).not.toContain('sync_brain_skills');
    expect(granted).not.toContain('leave_brain');
  });
});
