/**
 * Tests for src/commands/article-mirror.ts — the article companion to
 * book-mirror's trusted CLI pattern.
 *
 * Same surface strategy as test/book-mirror.test.ts:
 *   - prove the CLI dispatches the command (not "Unknown command")
 *   - prove a no-DB invocation never reaches queue submission
 *   - pin the trust-boundary strings in the source file
 *   - pin the bundle/routing surfaces so skillpack scaffold can see it
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exit: number;
}> {
  const tmpHome = await import('os').then(os =>
    import('fs').then(fs => fs.mkdtempSync(`${os.tmpdir()}/gbrain-test-`)),
  );
  try {
    const proc = Bun.spawn(
      ['bun', 'run', 'src/cli.ts', 'article-mirror', ...args],
      {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, DATABASE_URL: '', GBRAIN_HOME: tmpHome },
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    return { stdout, stderr, exit };
  } finally {
    const fs = await import('fs');
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

describe('gbrain article-mirror — CLI registration', () => {
  it('article-mirror is in CLI_ONLY (does not get "Unknown command")', async () => {
    const { stderr } = await runCli([]);
    expect(stderr).not.toContain('Unknown command');
  }, 30000);

  it('without DB, never reaches queue submission', async () => {
    const { stderr, exit } = await runCli(['--slug', 'noop']);
    expect(exit).not.toBe(0);
    expect(stderr).not.toContain('submitted:');
  }, 30000);
});

describe('gbrain article-mirror — source file invariants', () => {
  const sourcePath = join(REPO_ROOT, 'src/commands/article-mirror.ts');
  const source = readFileSync(sourcePath, 'utf-8');

  it('exports runArticleMirrorCmd', () => {
    expect(source).toContain('export async function runArticleMirrorCmd');
  });

  it('documents the article mirror trust contract', () => {
    expect(source).toContain('media/articles/');
    expect(source).toContain('allowed_tools');
  });

  it('uses read-only allowed_tools for the child subagent', () => {
    expect(source).toContain("allowed_tools: ['get_page', 'search']");
  });

  it('writes via operator-trust put_page', () => {
    expect(source).toContain('putPageOp.handler');
    expect(source).toContain('remote: false');
    expect(source).toContain('viaSubagent intentionally omitted');
  });

  it('prints a cost-estimate confirmation before launching', () => {
    expect(source).toContain('estimateCost');
    expect(source).toContain('confirmInteractive');
  });

  it('uses an idempotency key for the single child job', () => {
    expect(source).toContain('idempotency_key');
    expect(source).toContain('article-mirror:');
  });

  it('submits exactly one child job and waits for it', () => {
    expect(source).toContain('submitted: 1 subagent job');
    expect(source).toContain('waiting for article analysis to complete');
  });
});

describe('gbrain article-mirror — bundle and routing surfaces', () => {
  it('ships a skill with paired-source frontmatter for scaffold', () => {
    const skillPath = join(REPO_ROOT, 'skills/article-mirror/SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('name: article-mirror');
    expect(skill).toContain('sources:');
    expect(skill).toContain('src/commands/article-mirror.ts');
    expect(skill).toContain('media/articles/');
  });

  it('ships routing fixtures with at least 5 positive article-mirror intents', () => {
    const evalPath = join(REPO_ROOT, 'skills/article-mirror/routing-eval.jsonl');
    expect(existsSync(evalPath)).toBe(true);
    const lines = readFileSync(evalPath, 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('//'));
    const positives = lines
      .map(line => JSON.parse(line) as { expected_skill: string | null })
      .filter(row => row.expected_skill === 'article-mirror');
    expect(positives.length).toBeGreaterThanOrEqual(5);
  });

  it('is registered in manifest, resolver, and openclaw plugin bundle', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'skills/manifest.json'), 'utf-8')) as {
      skills: Array<{ name: string; path: string }>;
    };
    expect(manifest.skills.some(skill =>
      skill.name === 'article-mirror' && skill.path === 'article-mirror/SKILL.md')).toBe(true);

    const resolver = readFileSync(join(REPO_ROOT, 'skills/RESOLVER.md'), 'utf-8');
    expect(resolver).toContain('skills/article-mirror/SKILL.md');

    const plugin = JSON.parse(readFileSync(join(REPO_ROOT, 'openclaw.plugin.json'), 'utf-8')) as {
      skills: string[];
    };
    expect(plugin.skills).toContain('skills/article-mirror');
  });
});
