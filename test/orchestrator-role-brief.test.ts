/**
 * Role-brief priming on the run path.
 *   - loadRoleBrief: reads roles/<role>.md (+ shared protocol), strips frontmatter,
 *     graceful on missing.
 *   - makeSubagentExecutor: prepends the brief to the prompt for each agent,
 *     cached per role; no brief when no loader is injected.
 * Hermetic: loader uses a tmpdir; executor uses an injected capturing runner.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadRoleBrief, defaultRolesDir } from '../src/core/orchestrator/role-brief.ts';
import { makeSubagentExecutor, type SubagentSpec, type SubagentResult } from '../src/core/orchestrator/execute.ts';
import type { OrchestratorContext, SkillRecommendation } from '../src/core/orchestrator/types.ts';
import type { SkillRole } from '../src/core/skill-frontmatter.ts';

// --- loadRoleBrief -----------------------------------------------------------

describe('loadRoleBrief', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'roles-'));
    writeFileSync(join(dir, 'nurse.md'), '---\nrole: nurse\n---\n\n# Nurse brief\nYou are a nurse.\n');
    writeFileSync(join(dir, '_daily-protocol.md'), '---\nrole: shared\n---\n\n# Protocol\nHydration mid-morning.\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('returns role brief + shared protocol, frontmatter stripped', () => {
    const b = loadRoleBrief(dir, 'nurse');
    expect(b).toContain('# Nurse brief');
    expect(b).toContain('You are a nurse.');
    expect(b).toContain('# Protocol'); // protocol appended
    expect(b).not.toContain('role: nurse'); // frontmatter stripped
  });

  test('includeProtocol:false omits the shared protocol', () => {
    const b = loadRoleBrief(dir, 'nurse', { includeProtocol: false });
    expect(b).toContain('# Nurse brief');
    expect(b).not.toContain('# Protocol');
  });

  test('missing role brief → empty string (graceful)', () => {
    expect(loadRoleBrief(dir, 'psychiatrist')).toBe('');
    expect(loadRoleBrief('/no/such/dir', 'nurse')).toBe('');
  });

  test('defaultRolesDir is a sibling of the skills dir', () => {
    expect(defaultRolesDir('/repo/skills')).toBe('/repo/roles');
  });
});

// --- executor priming --------------------------------------------------------

function rec(role: SkillRole = 'nurse'): SkillRecommendation {
  return { skill: `${role}-skill`, role, reason: 'test', confidence: 0.9 };
}
const ctx: OrchestratorContext = {
  input: { text: 'chest pain' },
  history: [],
  now: new Date(),
  remote: false,
};

function capturingRunner() {
  const prompts: string[] = [];
  const runner = async (spec: SubagentSpec): Promise<SubagentResult> => {
    prompts.push(spec.prompt);
    return { status: 'completed', text: 'ok' };
  };
  return { runner, prompts };
}

describe('makeSubagentExecutor — role-brief priming', () => {
  test('prepends the brief before the base prompt', async () => {
    const { runner, prompts } = capturingRunner();
    const exec = makeSubagentExecutor({ runner, loadBrief: (r) => `BRIEF for ${r}` });
    await exec(rec('nurse'), ctx);
    expect(prompts[0]).toContain('BRIEF for nurse');
    // base prompt still present, and brief comes first
    expect(prompts[0]).toContain('Run the clinical skill "nurse-skill"');
    expect(prompts[0].indexOf('BRIEF for nurse')).toBeLessThan(prompts[0].indexOf('Run the clinical skill'));
  });

  test('no loader → base prompt only (unchanged behavior)', async () => {
    const { runner, prompts } = capturingRunner();
    const exec = makeSubagentExecutor({ runner });
    await exec(rec('nurse'), ctx);
    expect(prompts[0]).not.toContain('BRIEF');
    expect(prompts[0]).toContain('Run the clinical skill "nurse-skill"');
  });

  test('brief is cached per role (loader called once across runs)', async () => {
    const { runner } = capturingRunner();
    let calls = 0;
    const exec = makeSubagentExecutor({
      runner,
      loadBrief: (r) => {
        calls++;
        return `BRIEF ${r}`;
      },
    });
    await exec(rec('nurse'), ctx);
    await exec(rec('nurse'), ctx);
    await exec(rec('psychiatrist'), ctx);
    expect(calls).toBe(2); // nurse once (cached 2nd time) + psychiatrist once
  });
});
