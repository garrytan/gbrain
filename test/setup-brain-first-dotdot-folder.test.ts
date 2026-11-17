/**
 * The per-turn brain-first rule for a project-scope install (a Claude Code
 * CLAUDE.local.md) applies only to sessions started inside that project
 * (src/core/setup/brain-first.ts, brainFirstTurnRule).
 *
 * Authoring gate:
 * 1. Protects: a session started in `<project>/..drafts/work` still gets the
 *    rule, because that folder is inside the project; a session in the parent
 *    folder, in a sibling folder that shares the project's name prefix, or in
 *    another project still does not.
 * 2. Regression that fails it: the "is the cwd inside the project" test
 *    matching any relative path that starts with the two characters `..`
 *    instead of only a `..` path component. A legal folder named `..drafts`
 *    then silently turns the rule off.
 * 3. Why existing coverage misses it: brain-first-turn-rule.test.ts only
 *    asserts user-scope installs; no test starts a session from a project
 *    subfolder or from outside the project.
 * 4. Production seam: none. brainFirstTurnRule is exported; the ledger is a
 *    real file under a private GBRAIN_HOME set with withEnv.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { brainFirstTurnRule, renderBrainFirstTurnRule } from '../src/core/setup/brain-first.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const RULE = renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain' });

/** A GBRAIN_HOME whose ledger records one installed project-scope block, plus the project folder it names. */
function projectInstall(): { home: string; project: string; scratch: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-first-dotdot-'));
  roots.push(scratch);
  const home = join(scratch, 'home');
  const project = join(scratch, 'project');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, '.gbrain', 'agent-instructions.json'), JSON.stringify({ version: 1, entries: [{
    harness: 'claude-code', status: 'installed', path: join(project, 'CLAUDE.local.md'), block_version: 2,
    access: { kind: 'mcp', server: 'gbrain' }, writer: 'test', created_file: true, updated_at: new Date(Date.UTC(2026, 9, 25)).toISOString(),
  }] }));
  return { home, project, scratch };
}

const ruleFor = (home: string, cwd: string) =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_AGENT_INSTRUCTIONS: undefined }, async () => brainFirstTurnRule('claude-code', cwd));

describe('brain-first turn rule: a project-scope install and the session folder', () => {
  test('a session in the project folder gets the rule', async () => {
    const { home, project } = projectInstall();
    expect(await ruleFor(home, project)).toBe(RULE);
  });

  test('a session in a subfolder named ..drafts gets the rule', async () => {
    const { home, project } = projectInstall();
    expect(await ruleFor(home, join(project, '..drafts'))).toBe(RULE);
    expect(await ruleFor(home, join(project, '..drafts', 'work'))).toBe(RULE);
  });

  test('a session in the parent folder does not get the rule', async () => {
    const { home, project, scratch } = projectInstall();
    expect(await ruleFor(home, scratch)).toBeNull();
    expect(await ruleFor(home, join(project, '..'))).toBeNull();
  });

  test('a session in a sibling folder that shares the project name prefix does not get the rule', async () => {
    const { home, scratch } = projectInstall();
    expect(await ruleFor(home, join(scratch, 'project2'))).toBeNull();
  });

  test('a session in another project, or in a ..other folder next to the project, does not get the rule', async () => {
    const { home, scratch } = projectInstall();
    expect(await ruleFor(home, join(scratch, 'elsewhere', 'app'))).toBeNull();
    expect(await ruleFor(home, join(scratch, '..other'))).toBeNull();
  });
});
