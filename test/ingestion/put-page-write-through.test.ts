/**
 * put_page write-through tests (v0.38).
 *
 * Verifies that put_page writes the markdown file to disk alongside the
 * DB row when sync.repo_path is configured. Trust gating: subagent
 * sandbox writes stay DB-only; dry-run stays DB-only; missing-repo
 * stays DB-only, with a loud warning for remote callers.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { operations, OperationError } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withEnv } from '../helpers/with-env.ts';
import { parseMarkdown, serializePageToMarkdown } from '../../src/core/markdown.ts';
import { upsertFactRow } from '../../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  // Don't leak the reset-state to sibling files in the same bun shard
  // (the v0.40.4.1 gateway state-leak class). beforeEach already reset
  // for our own tests; this is defense for the next file's siblings.
  resetGateway();
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  // CI fix: put_page's handler at src/core/operations.ts:622 computes
  // `noEmbed = !isAvailable('embedding')`. When the gateway has been
  // configured by a sibling test (or by the cli.ts module-load path
  // reading .env.testing) with a fake/stale VOYAGE_API_KEY,
  // isAvailable returns true → put_page tries to embed → the real
  // Voyage API returns 401 in CI. This test exercises write-through
  // behavior, not embedding. Reset the gateway so isAvailable returns
  // false → noEmbed=true → no network call.
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-wt-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  // Wire sync.repo_path so write-through can find the repo.
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(async () => {
  await disposePersistenceConsumer(engine);
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
    config: { engine: 'pglite' as const, embedding_disabled: true },
    logger,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPageOperation = operations.find((o) => o.name === 'put_page')!;
const putPage = { ...putPageOperation,
  handler: (ctx: OperationContext, params: Record<string, unknown>) =>
    withEnv({ GBRAIN_HOME: path.join(tmpRoot, 'home') }, () => putPageOperation.handler(ctx, params)),
};

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
    expect(JSON.stringify(result)).not.toContain(brainDir);
    expect(fs.existsSync(expectedPath)).toBe(true);
    const onDisk = fs.readFileSync(expectedPath, 'utf8');
    expect(onDisk).toContain('WT body');
  });

  test("remote writes infer a custom type from the active pack through no-op and file checks", async () => {
    const packDir = path.join(
      tmpRoot,
      "home",
      ".gbrain",
      "schema-packs",
      "route-test",
    );
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(
      path.join(packDir, "pack.yaml"),
      `api_version: gbrain-schema-pack-v1
name: route-test
version: 1.0.0
extends: gbrain-base-v2
page_types:
  - name: goal
    primitive: concept
    path_prefixes: [goals/]
    aliases: []
    extractable: false
    expert_routing: false
`,
    );
    await withEnv({ GBRAIN_SCHEMA_PACK: "route-test" }, async () => {
      const ctx = makeCtx({ remote: true });
      const slug = "goals/learn-guitar";
      const content = "---\ntitle: Learn guitar\n---\n\nPractice regularly.";
      const first = (await putPage.handler(ctx, { slug, content })) as {
        revision: string;
      };
      const file = path.join(brainDir, `${slug}.md`);
      expect(
        (await engine.readPageSnapshot(slug, { sourceId: "default" }))?.page
          .type,
      ).toBe("goal");
      expect(fs.readFileSync(file, "utf8")).toContain("type: goal");

      const unchanged = await putPage.handler(ctx, {
        slug,
        content,
        expected_revision: first.revision,
      });
      expect(unchanged).toMatchObject({
        state: "committed",
        noop: true,
        revision: first.revision,
      });

      // A canonical file imported under the pack can omit type frontmatter.
      fs.writeFileSync(
        file,
        fs.readFileSync(file, "utf8").replace(/^type: goal\n/m, ""),
      );
      const edited = await putPage.handler(ctx, {
        slug,
        content: content.replace("regularly", "daily"),
        expected_revision: first.revision,
      });
      expect(edited).toMatchObject({ state: "committed" });
      expect(
        (await engine.readPageSnapshot(slug, { sourceId: "default" }))?.page
          .type,
      ).toBe("goal");
    });
  });

  test('stamps provenance frontmatter (ingested_via=put_page for local CLI)', async () => {
    const ctx = makeCtx({ remote: false });
    const result = (await putPage.handler(ctx, {
      slug: 'inbox/provenance',
      content: '---\ntitle: P\n---\n\nbody',
    })) as { write_through?: { written: boolean; path?: string } };
    expect(result.write_through?.written).toBe(true);
    const onDisk = fs.readFileSync(path.join(brainDir, 'inbox/provenance.md'), 'utf8');
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
    expect(JSON.stringify(result)).not.toContain(brainDir);
    const onDisk = fs.readFileSync(path.join(brainDir, 'inbox/mcp-prov.md'), 'utf8');
    // YAML quotes strings containing `:` so the literal frontmatter line
    // is `ingested_via: 'mcp:put_page'`. Match the value substring.
    expect(onDisk).toMatch(/ingested_via:\s*['"]?mcp:put_page['"]?/);
  });

  test.each([false, true])('first-write provenance survives replay, identical no-op and later edits (remote=%s)', async (remote) => {
    const ctx = makeCtx({ remote });
    const slug = 'inbox/stable-provenance';
    const content = '---\ntitle: Stable provenance\ningested_at: forged timestamp\ningested_via: forged channel\nsource_kind: forged channel\n---\n\nOriginal body';
    const params = { slug, content, request_id: randomUUID() };
    const first = await putPage.handler(ctx, params) as { revision: string; created_at: string };
    const initial = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const file = path.join(brainDir, `${slug}.md`);
    const bytes = fs.readFileSync(file, 'utf8');
    expect(initial.page.frontmatter).toMatchObject({ source_kind: remote ? 'mcp:put_page' : 'put_page',
      ingested_via: remote ? 'mcp:put_page' : 'put_page', ingested_at: first.created_at });
    expect(initial.page.ingested_at?.toISOString()).toBe(first.created_at);
    expect(parseMarkdown(bytes, slug)).toMatchObject({ frontmatter: initial.page.frontmatter,
      compiled_truth: initial.page.compiled_truth, timeline: initial.page.timeline, tags: initial.tags });
    expect(bytes).not.toContain('forged');
    expect(await putPage.handler(ctx, params)).toEqual(first);

    const unchanged = await putPage.handler(ctx, { ...params, request_id: randomUUID(), expected_revision: first.revision });
    expect(unchanged).toMatchObject({ state: 'committed', noop: true, revision: first.revision });
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [initial.page.id])).toEqual([]);

    const edited = await putPage.handler(ctx, { ...params, request_id: randomUUID(), expected_revision: first.revision,
      content: content.replace('Original body', 'Updated body') });
    const final = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(edited).toMatchObject({ state: 'committed', revision: final.revision });
    expect(final.revision).not.toBe(first.revision);
    expect(final.page.frontmatter).toEqual(initial.page.frontmatter);
    expect(final.page.ingested_at?.toISOString()).toBe(first.created_at);
    expect(parseMarkdown(fs.readFileSync(file, 'utf8'), slug)).toMatchObject({ frontmatter: final.page.frontmatter,
      compiled_truth: final.page.compiled_truth, timeline: final.page.timeline, tags: final.tags });
    expect(await putPage.handler(ctx, params)).toEqual(first);
  });

  test('an exact no-op on a historical unstamped page adds no provenance or revision', async () => {
    const slug = 'inbox/historical';
    await engine.putPage(slug, { type: 'note', title: 'Historical', compiled_truth: 'Existing body', timeline: '', frontmatter: {} });
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const bytes = serializePageToMarkdown(before.page, before.tags);
    fs.mkdirSync(path.join(brainDir, 'inbox'), { recursive: true });
    const file = path.join(brainDir, `${slug}.md`);
    fs.writeFileSync(file, bytes);
    expect(await putPage.handler(makeCtx(), { slug, content: bytes, expected_revision: before.revision }))
      .toMatchObject({ state: 'committed', noop: true, revision: before.revision });
    const after = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(after.page.frontmatter).toEqual({});
    expect(after.page.ingested_at).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  test('a filtered remote round-trip remains an unstamped no-op after hidden-fact restoration', async () => {
    const slug = 'inbox/historical-private';
    const body = upsertFactRow('Existing body', { claim: 'Private fixture claim', kind: 'fact', visibility: 'private',
      confidence: 1, notability: 'medium' }).body.trim();
    await engine.putPage(slug, { type: 'note', title: 'Historical private', compiled_truth: body, timeline: '', frontmatter: {} });
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const file = path.join(brainDir, `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = serializePageToMarkdown(before.page, before.tags);
    fs.writeFileSync(file, bytes);
    const remote = makeCtx({ remote: true });
    const visible = await operations.find(op => op.name === 'get_page')!.handler(remote, { slug, include_content: true }) as { content: string; revision: string };
    expect(visible.content).not.toContain('Private fixture claim');
    expect(await putPage.handler(remote, { slug, content: visible.content, expected_revision: visible.revision }))
      .toMatchObject({ state: 'committed', noop: true, revision: before.revision });
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.frontmatter).toEqual({});
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [before.page.id])).toEqual([]);
  });

  test('editing legacy frontmatter cannot promote forged audit stamps into trusted columns', async () => {
    const slug = 'inbox/legacy-audit';
    await engine.putPage(slug, { type: 'note', title: 'Legacy audit', compiled_truth: 'Existing body', timeline: '',
      frontmatter: { source_kind: 'forged kind', ingested_via: 'forged channel', ingested_at: 'unknown' },
      source_kind: 'mcp:put_page', ingested_via: 'mcp:put_page' });
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const file = path.join(brainDir, `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = serializePageToMarkdown(before.page, before.tags);
    fs.writeFileSync(file, content);
    await putPage.handler(makeCtx({ remote: true }), { slug, content: content.replace('Existing body', 'Edited body'), force: true });
    const after = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(after.page.frontmatter).toEqual({ source_kind: 'mcp:put_page', ingested_via: 'mcp:put_page',
      ingested_at: before.page.ingested_at!.toISOString() });
    expect(after.page.source_kind).toBe('mcp:put_page');
    expect(after.page.ingested_at).toEqual(before.page.ingested_at);
    expect(parseMarkdown(fs.readFileSync(file, 'utf8'), slug).frontmatter).toEqual(after.page.frontmatter);
  });

  test('a legacy unstamped external-ID duplicate creates neither a second page nor a file', async () => {
    const slug = 'inbox/legacy-id';
    await engine.putPage(slug, { type: 'note', title: 'Legacy ID', compiled_truth: 'Existing body', timeline: '',
      frontmatter: { id: 'legacy-external-id' } });
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const file = path.join(brainDir, `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = serializePageToMarkdown(before.page, before.tags);
    fs.writeFileSync(file, content);
    expect(await putPage.handler(makeCtx(), { slug: 'inbox/legacy-copy', content }))
      .toMatchObject({ state: 'committed', status: 'duplicate', slug });
    expect(await engine.executeRaw('SELECT id FROM pages')).toHaveLength(1);
    expect(fs.existsSync(path.join(brainDir, 'inbox/legacy-copy.md'))).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(before.revision);
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
    expect(fs.existsSync(path.join(brainDir, 'wiki/personal/reflections/note.md'))).toBe(true);
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
    })) as { write_through?: { skipped?: string; warning?: string } };
    expect(result.write_through?.skipped).toBe('no_repo_configured');
    expect(result.write_through?.warning).toBeUndefined();
  });

  test('remote repo not configured → warns that the write is DB-only', async () => {
    await engine.executeRaw("DELETE FROM config WHERE key = 'sync.repo_path'");
    const ctx = makeCtx({ remote: true });
    const result = (await putPage.handler(ctx, {
      slug: 'inbox/no-repo-remote',
      content: '---\ntitle: Remote\n---\n\nbody',
    })) as { write_through?: { skipped?: string; warning?: string } };
    expect(result.write_through?.skipped).toBe('no_repo_configured');
    expect(result.write_through?.warning).toContain('wrote only to the database');
    expect(result.write_through?.warning).toContain("source 'default'");
    expect(result.write_through?.warning).toContain('no durable markdown file');
  });

  test.each([false, true])('missing directory returns a private typed error before admission (remote=%s)', async (remote) => {
    await engine.setConfig('sync.repo_path', path.join(tmpRoot, 'does-not-exist'));
    const ctx = makeCtx({ remote });
    const requestId = randomUUID();
    const error = await putPage.handler(ctx, {
      slug: 'inbox/missing-repo', content: '---\ntitle: M\n---\n\nbody', request_id: requestId,
    }).then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).toJSON()).toMatchObject({ error: 'storage_error' });
    expect((error as OperationError).writeRequest).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(tmpRoot);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId])).toEqual([]);
    expect(await engine.executeRaw('SELECT id FROM persistence_worktrees')).toEqual([]);
    expect(await engine.executeRaw('SELECT source_id FROM persistence_source_bindings')).toEqual([]);
    expect(await ctx.engine.getPage('inbox/missing-repo', { sourceId: 'default' })).toBeNull();
  });
});

describe('put_page write-through — multi-source filing', () => {
  test('non-default source writes inside its explicitly configured root', async () => {
    const sourceRoot = path.join(brainDir, '.sources/team-x');
    fs.mkdirSync(sourceRoot, { recursive: true });
    await engine.executeRaw(
      "INSERT INTO sources (id, name, local_path) VALUES ('team-x', 'team-x', $1)", [sourceRoot],
    );
    const ctx = makeCtx({ sourceId: 'team-x' });
    const result = (await putPage.handler(ctx, {
      slug: 'shared/page',
      content: '---\ntitle: X\n---\n\nbody',
    })) as { write_through?: { written: boolean; path?: string } };
    expect(result.write_through?.written).toBe(true);
    expect(fs.readFileSync(path.join(sourceRoot, 'shared/page.md'), 'utf8')).toContain('body');
    expect(fs.existsSync(path.join(brainDir, 'shared/page.md'))).toBe(false);
  });

  test('a source without a root stays database-only instead of using the default root', async () => {
    await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('database-only','Database only')");
    const result = await putPage.handler(makeCtx({ sourceId: 'database-only' }), {
      slug: 'shared/database-page', content: '---\ntitle: Database only\n---\n\nbody',
    });
    expect(result).toMatchObject({ state: 'committed', write_through: { written: false, skipped: 'no_repo_configured' } });
    expect(await engine.getPage('shared/database-page', { sourceId: 'database-only' })).not.toBeNull();
    expect(fs.existsSync(path.join(brainDir, 'shared/database-page.md'))).toBe(false);
    expect(fs.existsSync(path.join(brainDir, '.sources/database-only/shared/database-page.md'))).toBe(false);
  });
});

describe('put_page write-through — failure isolation', () => {
  test('disk-write failure rejects the call and rolls back the new page (no index-only orphan)', async () => {
    // Point the config at a path that exists but isn't writable so the
    // write fails. Best portable trick: a regular file (writeFileSync to
    // a path inside a regular file fails with ENOTDIR).
    const blockFile = path.join(tmpRoot, 'block');
    fs.writeFileSync(blockFile, 'i am a file, not a dir');
    await engine.setConfig('sync.repo_path', blockFile);

    const ctx = makeCtx();
    await expect(
      putPage.handler(ctx, {
        slug: 'inbox/fail-isolated',
        content: '---\ntitle: F\n---\n\nbody',
      }),
    ).rejects.toBeInstanceOf(OperationError);

    // The markdown file is the system of record; a page that only exists
    // as a DB row is an orphan the caller can't see or fix. Since this was
    // a brand-new slug, the failed write is rolled back entirely.
    const page = await engine.getPage('inbox/fail-isolated');
    expect(page).toBeNull();
  });
});
