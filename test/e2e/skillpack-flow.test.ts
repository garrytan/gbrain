/**
 * E2E flow tests for `gbrain skillpack` — the new v0.33 scaffold+
 * reference+migrate+harvest contract.
 *
 * Real gbrain subprocess against tempdir workspaces. No DATABASE_URL
 * needed — skillpack is filesystem-only.
 *
 * 9 user flows:
 *   1. scaffold first-run lands files
 *   2. scaffold re-run is a no-op (refuses overwrite)
 *   3. reference shows diff + framing
 *   4. reference --apply-clean-hunks applies upstream change
 *   5. migrate-fence strips fence, preserves rows
 *   6. scrub-legacy-fence-rows tears the bridge down
 *   7. harvest privacy-lint catches Wintermute (exit non-zero)
 *   8. harvest --no-lint bypasses
 *   9. install returns unknown-subcommand error (clean break, no alias)
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const GBRAIN_CMD = 'bun';
const GBRAIN_ARGS = ['run', join(REPO_ROOT, 'src', 'cli.ts')];

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runGbrain(args: string[], opts: { cwd?: string } = {}): RunResult {
  const result = spawnSync(GBRAIN_CMD, [...GBRAIN_ARGS, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, OPENCLAW_WORKSPACE: '' }, // ensure walk-up tier wins
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}

const tempdirs: string[] = [];
afterAll(() => {
  while (tempdirs.length) {
    const p = tempdirs.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sp-e2e-ws-'));
  tempdirs.push(ws);
  return ws;
}

describe('skillpack flow (E2E)', () => {
  test('1. scaffold first-run lands files into the workspace', () => {
    const ws = scratchWorkspace();
    const r = runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('scaffold');
    expect(existsSync(join(ws, 'skills', 'book-mirror', 'SKILL.md'))).toBe(true);
  });

  test('2. scaffold re-run is a no-op (refuses overwrite)', () => {
    const ws = scratchWorkspace();
    runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);
    const r = runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('skipped');
  });

  test('3. reference shows diff + agent-readable framing', () => {
    const ws = scratchWorkspace();
    runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);

    // Edit local copy.
    const skillMd = join(ws, 'skills', 'book-mirror', 'SKILL.md');
    writeFileSync(skillMd, readFileSync(skillMd, 'utf-8') + '\n## My local edits\n');

    const r = runGbrain(['skillpack', 'reference', 'book-mirror', '--workspace', ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('do not blindly overwrite');
    expect(r.stdout).toContain('differs');
  });

  test('4. reference --apply-clean-hunks applies upstream change to local workspace', () => {
    // Use a private bundle (scratch gbrain root) so we can mutate the
    // bundle source without polluting the real gbrain repo.
    const gbrainRoot = mkdtempSync(join(tmpdir(), 'sp-e2e-gb-'));
    tempdirs.push(gbrainRoot);
    mkdirSync(join(gbrainRoot, 'src'), { recursive: true });
    writeFileSync(join(gbrainRoot, 'src', 'cli.ts'), '// stub');
    mkdirSync(join(gbrainRoot, 'skills', 'apply-demo'), { recursive: true });
    const initial = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n';
    writeFileSync(join(gbrainRoot, 'skills', 'apply-demo', 'SKILL.md'), initial);
    writeFileSync(
      join(gbrainRoot, 'openclaw.plugin.json'),
      JSON.stringify({
        name: 'gbrain-test',
        version: '0.33.0-test',
        skills: ['skills/apply-demo'],
        shared_deps: [],
      }, null, 2),
    );

    const ws = scratchWorkspace();
    // Run scaffold from gbrainRoot so it picks up our scratch bundle.
    const r0 = spawnSync(GBRAIN_CMD, [...GBRAIN_ARGS, 'skillpack', 'scaffold', 'apply-demo', '--workspace', ws], {
      cwd: gbrainRoot,
      encoding: 'utf-8',
      env: { ...process.env, OPENCLAW_WORKSPACE: '' },
    });
    expect(r0.status).toBe(0);

    // gbrain ships an upstream change.
    writeFileSync(
      join(gbrainRoot, 'skills', 'apply-demo', 'SKILL.md'),
      initial.replace('Line 10\n', 'Line 10 UPSTREAM\n'),
    );

    // Apply clean hunks.
    const r = spawnSync(GBRAIN_CMD, [...GBRAIN_ARGS, 'skillpack', 'reference', 'apply-demo', '--workspace', ws, '--apply-clean-hunks'], {
      cwd: gbrainRoot,
      encoding: 'utf-8',
      env: { ...process.env, OPENCLAW_WORKSPACE: '' },
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(ws, 'skills', 'apply-demo', 'SKILL.md'), 'utf-8')).toContain(
      'Line 10 UPSTREAM',
    );
  });

  test('5. migrate-fence strips legacy fence, preserves rows', () => {
    const ws = scratchWorkspace();
    mkdirSync(join(ws, 'skills'), { recursive: true });
    writeFileSync(
      join(ws, 'skills', 'RESOLVER.md'),
      `# RESOLVER

<!-- gbrain:skillpack:begin -->

<!-- gbrain:skillpack:manifest cumulative-slugs="legacy-skill" version="0.32.0" -->

| Trigger | Skill |
|---------|-------|
| "legacy trigger" | \`skills/legacy-skill/SKILL.md\` |

<!-- gbrain:skillpack:end -->
`,
    );

    const r = runGbrain(['skillpack', 'migrate-fence', '--workspace', ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('fence_stripped');
    const rewritten = readFileSync(join(ws, 'skills', 'RESOLVER.md'), 'utf-8');
    expect(rewritten).not.toContain('gbrain:skillpack:begin');
    expect(rewritten).toContain('| "legacy trigger" | `skills/legacy-skill/SKILL.md` |');
  });

  test('6. scrub-legacy-fence-rows tears down the bridge after migrate-fence', () => {
    const ws = scratchWorkspace();
    mkdirSync(join(ws, 'skills', 'real-skill'), { recursive: true });
    writeFileSync(
      join(ws, 'skills', 'real-skill', 'SKILL.md'),
      '---\nname: real-skill\ntriggers:\n  - "real trigger"\n---\n# real\n',
    );
    writeFileSync(
      join(ws, 'skills', 'RESOLVER.md'),
      `| "real trigger" | \`skills/real-skill/SKILL.md\` |\n`,
    );

    const r = runGbrain(['skillpack', 'scrub-legacy-fence-rows', '--workspace', ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('1 removed');
    expect(readFileSync(join(ws, 'skills', 'RESOLVER.md'), 'utf-8')).not.toContain(
      '| "real trigger" |',
    );
  });

  test('7. harvest privacy-lint catches Wintermute → exit 1', () => {
    const hostRoot = mkdtempSync(join(tmpdir(), 'sp-e2e-host-'));
    tempdirs.push(hostRoot);
    mkdirSync(join(hostRoot, 'skills', 'contaminated'), { recursive: true });
    writeFileSync(
      join(hostRoot, 'skills', 'contaminated', 'SKILL.md'),
      '---\nname: contaminated\ntriggers:\n  - "tt"\n---\n# from Wintermute\n',
    );

    const gbrainRoot = mkdtempSync(join(tmpdir(), 'sp-e2e-gb-'));
    tempdirs.push(gbrainRoot);
    mkdirSync(join(gbrainRoot, 'src'), { recursive: true });
    writeFileSync(join(gbrainRoot, 'src', 'cli.ts'), '// stub');
    mkdirSync(join(gbrainRoot, 'skills'), { recursive: true });
    writeFileSync(
      join(gbrainRoot, 'openclaw.plugin.json'),
      JSON.stringify({ name: 'gb', version: '0.33', skills: [], shared_deps: [] }, null, 2),
    );

    const r = spawnSync(
      GBRAIN_CMD,
      [...GBRAIN_ARGS, 'skillpack', 'harvest', 'contaminated', '--from', hostRoot],
      { cwd: gbrainRoot, encoding: 'utf-8', env: { ...process.env, OPENCLAW_WORKSPACE: '' } },
    );
    expect(r.status).toBe(1); // lint_failed
    expect((r.stdout ?? '') + (r.stderr ?? '')).toContain('Wintermute');
    expect(existsSync(join(gbrainRoot, 'skills', 'contaminated'))).toBe(false); // rolled back
  });

  test('8. harvest --no-lint bypasses the privacy linter', () => {
    const hostRoot = mkdtempSync(join(tmpdir(), 'sp-e2e-host-'));
    tempdirs.push(hostRoot);
    mkdirSync(join(hostRoot, 'skills', 'bypass-test'), { recursive: true });
    writeFileSync(
      join(hostRoot, 'skills', 'bypass-test', 'SKILL.md'),
      '---\nname: bypass-test\ntriggers:\n  - "bt"\n---\n# from Wintermute\n',
    );

    const gbrainRoot = mkdtempSync(join(tmpdir(), 'sp-e2e-gb-'));
    tempdirs.push(gbrainRoot);
    mkdirSync(join(gbrainRoot, 'src'), { recursive: true });
    writeFileSync(join(gbrainRoot, 'src', 'cli.ts'), '// stub');
    mkdirSync(join(gbrainRoot, 'skills'), { recursive: true });
    writeFileSync(
      join(gbrainRoot, 'openclaw.plugin.json'),
      JSON.stringify({ name: 'gb', version: '0.33', skills: [], shared_deps: [] }, null, 2),
    );

    const r = spawnSync(
      GBRAIN_CMD,
      [
        ...GBRAIN_ARGS,
        'skillpack',
        'harvest',
        'bypass-test',
        '--from',
        hostRoot,
        '--no-lint',
      ],
      { cwd: gbrainRoot, encoding: 'utf-8', env: { ...process.env, OPENCLAW_WORKSPACE: '' } },
    );
    expect(r.status).toBe(0);
    expect(existsSync(join(gbrainRoot, 'skills', 'bypass-test', 'SKILL.md'))).toBe(true);
  });

  test('9. install returns unknown-subcommand error (clean break, no alias)', () => {
    const r = runGbrain(['skillpack', 'install', 'anything']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('removed in v0.33');
    expect(r.stderr).toContain('scaffold');
  });

  // ─── v0.36 DX coverage ────────────────────────────────────────────
  // The fixes shipped after the initial DX audit. Each test pins one
  // user-facing contract: agent-onboarding lands, every CLI tells the
  // reader the next action, and the two-way merge warning surfaces at
  // the right channel (stderr, not stdout, suppressed in --json).

  test('10. scaffold lands skills/_AGENT_README.md (agent-onboarding contract)', () => {
    const ws = scratchWorkspace();
    runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);
    expect(existsSync(join(ws, 'skills', '_AGENT_README.md'))).toBe(true);
    const body = readFileSync(join(ws, 'skills', '_AGENT_README.md'), 'utf-8');
    // Pin the load-bearing contract phrases — agents read these.
    expect(body).toContain('walking every `skills/<slug>/SKILL.md`');
    expect(body).toContain('frontmatter');
    expect(body).toContain('triggers:');
    expect(body).toContain('reference --all');
  });

  test('11. scaffold stdout prints next-action hint on real writes', () => {
    const ws = scratchWorkspace();
    const r = runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Next:');
    expect(r.stdout).toContain('triggers:');
    expect(r.stdout).toContain('_AGENT_README.md');
    expect(r.stdout).toContain('reference --all');
  });

  test('12. scaffold re-run does NOT print the next-action hint (already installed)', () => {
    const ws = scratchWorkspace();
    runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);
    const r = runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('skipped');
    // Hint suppressed when nothing new was written — keeps re-runs quiet.
    expect(r.stdout).not.toContain('Next: your agent walks');
  });

  test('13. reference stdout prints per-category decision policy when there are differs', () => {
    const ws = scratchWorkspace();
    runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);
    const skillMd = join(ws, 'skills', 'book-mirror', 'SKILL.md');
    writeFileSync(skillMd, readFileSync(skillMd, 'utf-8') + '\n## edits\n');

    const r = runGbrain(['skillpack', 'reference', 'book-mirror', '--workspace', ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Agent decision policy');
    expect(r.stdout).toContain('was your local edit intentional');
    expect(r.stdout).toContain('two-way merge warning');
  });

  test('14. --apply-clean-hunks prints two-way WARNING to STDERR, not stdout', () => {
    // Use a private bundle so we can mutate it without polluting the repo.
    const gbrainRoot = mkdtempSync(join(tmpdir(), 'sp-e2e-gb-warn-'));
    tempdirs.push(gbrainRoot);
    mkdirSync(join(gbrainRoot, 'src'), { recursive: true });
    writeFileSync(join(gbrainRoot, 'src', 'cli.ts'), '// stub');
    mkdirSync(join(gbrainRoot, 'skills', 'warn-demo'), { recursive: true });
    const initial = Array.from({ length: 15 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    writeFileSync(join(gbrainRoot, 'skills', 'warn-demo', 'SKILL.md'), initial);
    writeFileSync(
      join(gbrainRoot, 'openclaw.plugin.json'),
      JSON.stringify({
        name: 'gb', version: '0.36-test',
        skills: ['skills/warn-demo'], shared_deps: [],
      }, null, 2),
    );

    const ws = scratchWorkspace();
    spawnSync(GBRAIN_CMD, [...GBRAIN_ARGS, 'skillpack', 'scaffold', 'warn-demo', '--workspace', ws], {
      cwd: gbrainRoot, encoding: 'utf-8', env: { ...process.env, OPENCLAW_WORKSPACE: '' },
    });
    // Cause drift to make apply do something.
    writeFileSync(
      join(gbrainRoot, 'skills', 'warn-demo', 'SKILL.md'),
      initial.replace('L8\n', 'L8 NEW\n'),
    );

    const r = spawnSync(
      GBRAIN_CMD,
      [...GBRAIN_ARGS, 'skillpack', 'reference', 'warn-demo', '--workspace', ws, '--apply-clean-hunks'],
      { cwd: gbrainRoot, encoding: 'utf-8', env: { ...process.env, OPENCLAW_WORKSPACE: '' } },
    );
    expect(r.status).toBe(0);
    // WARNING must be on stderr (survives stdout redirection).
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).toContain('two-way');
    expect(r.stderr).toContain('aligned to gbrain');
    // And must NOT be on stdout (where machine consumers parse).
    expect(r.stdout).not.toContain('WARNING:');
  });

  test('15. --apply-clean-hunks --json does NOT print the WARNING (machine mode)', () => {
    const gbrainRoot = mkdtempSync(join(tmpdir(), 'sp-e2e-gb-json-'));
    tempdirs.push(gbrainRoot);
    mkdirSync(join(gbrainRoot, 'src'), { recursive: true });
    writeFileSync(join(gbrainRoot, 'src', 'cli.ts'), '// stub');
    mkdirSync(join(gbrainRoot, 'skills', 'json-demo'), { recursive: true });
    writeFileSync(join(gbrainRoot, 'skills', 'json-demo', 'SKILL.md'), 'a\nb\nc\n');
    writeFileSync(
      join(gbrainRoot, 'openclaw.plugin.json'),
      JSON.stringify({
        name: 'gb', version: '0.36-test',
        skills: ['skills/json-demo'], shared_deps: [],
      }, null, 2),
    );

    const ws = scratchWorkspace();
    spawnSync(GBRAIN_CMD, [...GBRAIN_ARGS, 'skillpack', 'scaffold', 'json-demo', '--workspace', ws], {
      cwd: gbrainRoot, encoding: 'utf-8', env: { ...process.env, OPENCLAW_WORKSPACE: '' },
    });

    const r = spawnSync(
      GBRAIN_CMD,
      [...GBRAIN_ARGS, 'skillpack', 'reference', 'json-demo', '--workspace', ws, '--apply-clean-hunks', '--json'],
      { cwd: gbrainRoot, encoding: 'utf-8', env: { ...process.env, OPENCLAW_WORKSPACE: '' } },
    );
    expect(r.status).toBe(0);
    // JSON mode: stderr stays clean for machine consumers.
    expect(r.stderr).not.toContain('WARNING');
    // And stdout is valid JSON.
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  test('16. migrate-fence stdout points the agent at the new routing model', () => {
    const ws = scratchWorkspace();
    mkdirSync(join(ws, 'skills'), { recursive: true });
    writeFileSync(
      join(ws, 'skills', 'RESOLVER.md'),
      `# RESOLVER

<!-- gbrain:skillpack:begin -->
<!-- gbrain:skillpack:manifest cumulative-slugs="lx" version="0.32.0" -->
| "trigger" | \`skills/lx/SKILL.md\` |
<!-- gbrain:skillpack:end -->
`,
    );
    const r = runGbrain(['skillpack', 'migrate-fence', '--workspace', ws]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('fence_stripped');
    expect(r.stdout).toContain('routing model just changed');
    expect(r.stdout).toContain('scrub-legacy-fence-rows');
    expect(r.stdout).toContain('_AGENT_README.md');
  });

  test('17. reference --all --since <bad-tag> falls back to full sweep with a warn', () => {
    const ws = scratchWorkspace();
    runGbrain(['skillpack', 'scaffold', 'book-mirror', '--workspace', ws]);
    const r = runGbrain([
      'skillpack', 'reference', '--all', '--workspace', ws, '--since', 'v999.999.999.0',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('--since');
    expect(r.stderr).toContain('could not be resolved');
    // Full sweep still ran — header line present.
    expect(r.stdout).toContain('as reference');
  });
});
