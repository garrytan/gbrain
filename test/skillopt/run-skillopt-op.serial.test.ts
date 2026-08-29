/**
 * A1 (test-gap wave 1) — run_skillopt's three remote fences + the reversed
 * OperationError args. Pre-fix, four throw sites passed (message, code) into
 * the (code, message) constructor — remote callers matched on prose instead of
 * stable codes; the open ErrorCode union hid it from tsc.
 *
 * Serial lane: runSkillOpt / autoDetectSkillsDirReadOnly are dynamic imports
 * inside the handler, so mock.module is the only stub (isolation rule R2).
 * The runSkillOpt stub is mandatory — without it the allowlisted-pass case
 * would launch a real LLM optimizer run.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

// Hermetic skills dir: a real dir reached through a symlink, so the
// nearest-existing-ancestor confine() branch is exercised the way Conductor
// worktrees and macOS /tmp hit it in production.
const realSkillsRoot = mkdtempSync(join(tmpdir(), 'skillopt-real-'));
const linkParent = mkdtempSync(join(tmpdir(), 'skillopt-link-'));
const linkedSkillsDir = join(linkParent, 'skills');
symlinkSync(realSkillsRoot, linkedSkillsDir);
// A symlink INSIDE the skills dir escaping it — the target must EXIST so
// realpathSync resolves the escape (a dangling target canonicalizes via the
// in-dir parent and is legitimately accepted).
const outsideDir = mkdtempSync(join(tmpdir(), 'skillopt-outside-'));
writeFileSync(join(outsideDir, 'secret.jsonl'), '{}\n');
mkdirSync(join(realSkillsRoot, 'evil'), { recursive: true });
symlinkSync(join(outsideDir, 'secret.jsonl'), join(realSkillsRoot, 'evil', 'escape.jsonl'));
// Existing parent for the not-yet-existing-file acceptance case (the
// nearest-existing-ancestor branch canonicalizes dirname, so dirname must exist).
mkdirSync(join(realSkillsRoot, 'test-skill'), { recursive: true });

let runSkillOptCalls: unknown[] = [];
mock.module('../../src/core/skillopt/orchestrator.ts', () => ({
  runSkillOpt: async (opts: unknown) => {
    runSkillOptCalls.push(opts);
    return { outcome: 'stubbed-run', receipt: null, mutatedSkillFile: null, proposedPath: null };
  },
}));
mock.module('../../src/core/repo-root.ts', () => ({
  autoDetectSkillsDirReadOnly: () => ({ dir: linkedSkillsDir }),
}));

import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
const run_skillopt = operations.find(o => o.name === 'run_skillopt')!;

let engine: PGLiteEngine;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    ...overrides,
  } as OperationContext;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<OperationError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    const err = e as OperationError;
    // The arg-order pin: `code` is the stable token, NOT the prose.
    expect(err.code).toBe(code);
    expect(err.toJSON().error).toBe(code);
    expect(err.message).not.toBe(code);
    return err;
  }
  throw new Error(`expected OperationError(${code}) but the call succeeded`);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  rmSync(realSkillsRoot, { recursive: true, force: true });
  rmSync(linkParent, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  runSkillOptCalls = [];
});

describe('run_skillopt skill_name validation (both trust tiers)', () => {
  for (const remote of [true, false]) {
    test(`remote=${remote}: traversal/case/absolute names → invalid_params code`, async () => {
      for (const bad of ['../etc', 'Foo', '/abs', '', 'a b']) {
        await expectCode(run_skillopt.handler(ctxOf({ remote }), { skill_name: bad }), 'invalid_params');
      }
      expect(runSkillOptCalls.length).toBe(0);
    });
  }
});

describe('run_skillopt remote allowlist (default deny-all)', () => {
  test('unset skillopt.allowed_skills → permission_denied', async () => {
    await expectCode(run_skillopt.handler(ctxOf(), { skill_name: 'some-skill' }), 'permission_denied');
    expect(runSkillOptCalls.length).toBe(0);
  });

  test('malformed-JSON allowlist → still deny-all', async () => {
    await engine.setConfig('skillopt.allowed_skills', 'not-json{');
    await expectCode(run_skillopt.handler(ctxOf(), { skill_name: 'some-skill' }), 'permission_denied');
    expect(runSkillOptCalls.length).toBe(0);
  });

  test('non-allowlisted name denied; allowlisted name reaches the (stubbed) optimizer', async () => {
    await engine.setConfig('skillopt.allowed_skills', JSON.stringify(['test-skill']));
    await expectCode(run_skillopt.handler(ctxOf(), { skill_name: 'other-skill' }), 'permission_denied');
    const res = await run_skillopt.handler(ctxOf(), { skill_name: 'test-skill' }) as { outcome?: string };
    expect(res.outcome).toBe('stubbed-run');
    expect(runSkillOptCalls.length).toBe(1);
  });

  test('local caller (remote === false) bypasses the allowlist entirely', async () => {
    const res = await run_skillopt.handler(ctxOf({ remote: false }), { skill_name: 'never-allowlisted' }) as { outcome?: string };
    expect(res.outcome).toBe('stubbed-run');
    expect(runSkillOptCalls.length).toBe(1);
  });
});

describe('run_skillopt remote path confinement', () => {
  beforeEach(async () => {
    await engine.setConfig('skillopt.allowed_skills', JSON.stringify(['test-skill']));
  });

  test('benchmark_path outside the skills dir → permission_denied', async () => {
    await expectCode(
      run_skillopt.handler(ctxOf(), { skill_name: 'test-skill', benchmark_path: '/etc/passwd' }),
      'permission_denied',
    );
    await expectCode(
      run_skillopt.handler(ctxOf(), { skill_name: 'test-skill', benchmark_path: join(linkedSkillsDir, '..', 'x.jsonl') }),
      'permission_denied',
    );
    expect(runSkillOptCalls.length).toBe(0);
  });

  test('held_out_path outside the skills dir → permission_denied', async () => {
    await expectCode(
      run_skillopt.handler(ctxOf(), { skill_name: 'test-skill', held_out_path: '/etc/passwd' }),
      'permission_denied',
    );
    expect(runSkillOptCalls.length).toBe(0);
  });

  test('in-dir symlink escaping the skills dir → permission_denied', async () => {
    await expectCode(
      run_skillopt.handler(ctxOf(), { skill_name: 'test-skill', benchmark_path: join(linkedSkillsDir, 'evil', 'escape.jsonl') }),
      'permission_denied',
    );
    expect(runSkillOptCalls.length).toBe(0);
  });

  test('not-yet-existing in-dir path under the SYMLINKED skills dir is accepted', async () => {
    const res = await run_skillopt.handler(ctxOf(), {
      skill_name: 'test-skill',
      benchmark_path: join(linkedSkillsDir, 'test-skill', 'skillopt-benchmark.jsonl'),
    }) as { outcome?: string };
    expect(res.outcome).toBe('stubbed-run');
    expect(runSkillOptCalls.length).toBe(1);
  });
});
