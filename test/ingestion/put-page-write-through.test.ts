/**
 * put_page write-through tests (v0.38).
 *
 * Verifies that put_page writes the markdown file to disk alongside the
 * DB row when sync.repo_path is configured. Trust gating: subagent
 * sandbox writes stay DB-only; dry-run stays DB-only; missing-repo
 * stays DB-only.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  // Don't leak the reset-state to sibling files in the same bun shard
  // (the v0.40.4.1 gateway state-leak class). beforeEach already reset
  // for our own tests; this is defense for the next file's siblings.
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // CI fix: put_page's handler at src/core/operations.ts:622 computes
  // `noEmbed = !isAvailable('embedding')`. When the gateway has been
  // configured by a sibling test (or by the cli.ts module-load path
  // reading .env.testing) with a fake/stale ZEROENTROPY_API_KEY,
  // isAvailable returns true → put_page tries to embed → the real
  // ZeroEntropy API returns 401 in CI. This test exercises write-through
  // behavior, not embedding. Reset the gateway so isAvailable returns
  // false → noEmbed=true → no network call.
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-wt-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  // Wire sync.repo_path so write-through can find the repo.
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const captureLogger = () => {
  const messages: Array<{ level: string; msg: string }> = [];
  return {
    logger: {
      info: (msg: string) => messages.push({ level: 'info', msg }),
      warn: (msg: string) => messages.push({ level: 'warn', msg }),
      error: (msg: string) => messages.push({ level: 'error', msg }),
    },
    messages,
  };
};

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const { logger } = captureLogger();
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;

describe('put_page write-through — happy path', () => {
  test('writes the markdown file to disk at brainDir/<slug>.md', async () => {
    const ctx = makeCtx();
    const content = '---\ntitle: Test\n---\n\n# WT body';
    const result = (await putPage.handler(ctx, { slug: 'inbox/test-wt-1', content })) as {
      slug: string;
      write_through?: { written: boolean; path?: string };
    };
    expect(result.write_through?.written).toBe(true);
    const expectedPath = path.join(brainDir, 'inbox/test-wt-1.md');
    expect(result.write_through?.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    const onDisk = fs.readFileSync(expectedPath, 'utf8');
    expect(onDisk).toContain('WT body');
  });

  test('stamps provenance frontmatter (ingested_via=put_page for local CLI)', async () => {
    const ctx = makeCtx({ remote: false });
    const result = (await putPage.handler(ctx, {
      slug: 'inbox/provenance',
      content: '---\ntitle: P\n---\n\nbody',
    })) as { write_through?: { written: boolean; path?: string } };
    expect(result.write_through?.written).toBe(true);
    const onDisk = fs.readFileSync(result.write_through!.path!, 'utf8');
    expect(onDisk).toMatch(/ingested_via:\s*put_page/);
    expect(onDisk).toMatch(/ingested_at:/);
  });

  test('MCP/remote callers get ingested_via=mcp:put_page', async () => {
    const ctx = makeCtx({ remote: true });
    const result = (await putPage.handler(ctx, {
      slug: 'inbox/mcp-prov',
      content: '---\ntitle: Q\n---\n\nbody',
    })) as { write_through?: { written: boolean; path?: string } };
    expect(result.write_through?.written).toBe(true);
    const onDisk = fs.readFileSync(result.write_through!.path!, 'utf8');
    // YAML quotes strings containing `:` so the literal frontmatter line
    // is `ingested_via: 'mcp:put_page'`. Match the value substring.
    expect(onDisk).toMatch(/ingested_via:\s*['"]?mcp:put_page['"]?/);
  });
});

describe('put_page write-through — trust gating', () => {
  test('subagent sandbox write (viaSubagent without allowedSlugPrefixes) stays DB-only', async () => {
    const ctx = makeCtx({
      remote: true,
      viaSubagent: true,
      subagentId: 42,
      // No allowedSlugPrefixes — sandbox writes only.
    });
    const result = (await putPage.handler(ctx, {
      slug: 'wiki/agents/42/scratch',
      content: '---\ntitle: S\n---\n\nbody',
    })) as { write_through?: { written: boolean; skipped?: string } };
    expect(result.write_through?.written).toBe(false);
    expect(result.write_through?.skipped).toBe('subagent_sandbox');
    expect(fs.existsSync(path.join(brainDir, 'wiki/agents/42/scratch.md'))).toBe(false);
  });

  test('trusted-workspace subagent (viaSubagent + allowedSlugPrefixes) writes through', async () => {
    const ctx = makeCtx({
      remote: true,
      viaSubagent: true,
      subagentId: 7,
      allowedSlugPrefixes: ['wiki/personal/reflections/*'],
    });
    const result = (await putPage.handler(ctx, {
      slug: 'wiki/personal/reflections/note',
      content: '---\ntitle: R\n---\n\nreflection',
    })) as { write_through?: { written: boolean; path?: string } };
    expect(result.write_through?.written).toBe(true);
    expect(fs.existsSync(result.write_through!.path!)).toBe(true);
  });

  test('dry-run stays DB-only (early-return before importFromContent)', async () => {
    const ctx = makeCtx({ dryRun: true });
    const result = (await putPage.handler(ctx, {
      slug: 'inbox/dryrun',
      content: '---\ntitle: D\n---\n\nbody',
    })) as { dry_run?: boolean; write_through?: { skipped?: string } };
    // put_page's existing handler short-circuits on dry-run BEFORE
    // importFromContent, so write_through never fires. The legacy dry_run
    // contract is what callers see.
    expect(result.dry_run).toBe(true);
    expect(fs.existsSync(path.join(brainDir, 'inbox/dryrun.md'))).toBe(false);
  });
});

describe('put_page write-through — config edge cases', () => {
  test('repo not configured → skipped no_repo_configured', async () => {
    // No deleteConfig helper; remove via raw SQL.
    await engine.executeRaw("DELETE FROM config WHERE key = 'sync.repo_path'");
    const ctx = makeCtx();
    const result = (await putPage.handler(ctx, {
      slug: 'inbox/no-repo',
      content: '---\ntitle: N\n---\n\nbody',
    })) as { write_through?: { skipped?: string } };
    expect(result.write_through?.skipped).toBe('no_repo_configured');
  });

  test('repo path points at a missing directory → skipped repo_not_found', async () => {
    await engine.setConfig('sync.repo_path', path.join(tmpRoot, 'does-not-exist'));
    const ctx = makeCtx();
    const result = (await putPage.handler(ctx, {
      slug: 'inbox/missing-repo',
      content: '---\ntitle: M\n---\n\nbody',
    })) as { write_through?: { skipped?: string } };
    expect(result.write_through?.skipped).toBe('repo_not_found');
  });
});

describe('put_page write-through — multi-source filing', () => {
  test('non-default source lands at brainDir/.sources/<id>/<slug>.md', async () => {
    // Create a non-default source row first. Schema fields: id (PK),
    // name (UNIQUE), plus the v0.26.5 archive columns with defaults.
    await engine.executeRaw(
      "INSERT INTO sources (id, name) VALUES ('team-x', 'team-x')",
    );
    const ctx = makeCtx({ sourceId: 'team-x' });
    const result = (await putPage.handler(ctx, {
      slug: 'shared/page',
      content: '---\ntitle: X\n---\n\nbody',
    })) as { write_through?: { written: boolean; path?: string } };
    expect(result.write_through?.written).toBe(true);
    expect(result.write_through?.path).toBe(path.join(brainDir, '.sources/team-x/shared/page.md'));
    expect(fs.existsSync(result.write_through!.path!)).toBe(true);
  });
});

describe('put_page write-through — failure isolation', () => {
  test('disk-write failure does not roll back DB', async () => {
    // Point the config at a path that exists but isn't writable so the
    // write fails. Best portable trick: a regular file (writeFileSync to
    // a path inside a regular file fails with ENOTDIR).
    const blockFile = path.join(tmpRoot, 'block');
    fs.writeFileSync(blockFile, 'i am a file, not a dir');
    await engine.setConfig('sync.repo_path', blockFile);

    const ctx = makeCtx();
    const result = (await putPage.handler(ctx, {
      slug: 'inbox/fail-isolated',
      content: '---\ntitle: F\n---\n\nbody',
    })) as { write_through?: { skipped?: string; error?: string } };
    // Either skipped (existsSync sees a file, not a dir) or error during write.
    expect(
      result.write_through?.skipped === 'repo_not_found' ||
        typeof result.write_through?.error === 'string',
    ).toBe(true);

    // DB write succeeded.
    const page = await engine.getPage('inbox/fail-isolated');
    expect(page).not.toBeNull();
  });
});
