/**
 * Wave B write operations from the local CLI (spec 3.1, 6.1, 6.2, 6.5):
 * `gbrain put <slug> --file` and `gbrain capture --file` read the page from a
 * file (no stdin); over the page ceiling the trusted local CLI streams it
 * through the import's two-pass reader, with no upload session.
 * `gbrain append` adds text with append_page, idempotent by --request-id,
 * through an upload session when the text is over one request. Runs the real
 * CLI on PGLite and on Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { normalizeForHash } from '../src/core/capture-content.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
/** Quotes, backslashes, tabs and other control characters, multi-byte and astral text. */
const ESCAPE_HEAVY = 'said "hi" \\ path\\to\\x \t tab \u0007 bell é 中文 😀 🧠';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** The body `gbrain get` prints after the page's frontmatter block. */
const printedBody = (stdout: string) => stdout.slice(stdout.indexOf('\n---\n\n') + 6);
/** A page just over the single-string ceiling. */
const hugeBody = (title: string) => {
  const line = `- ${ESCAPE_HEAVY} row\n`;
  return `# ${title}\n\n` + line.repeat(Math.ceil((PAGE_MAX_BYTES + 1024 * 1024) / Buffer.byteLength(line)));
};

for (const backend of testBackends()) {
  describe(`CLI page writes (${backend})`, () => {
    let home: string;
    let close: (() => Promise<void>) | undefined;
    let pg: BrainEngine | undefined;
    let pglite: PGLiteEngine | undefined;

    async function cli(args: string[], stdin?: string) {
      const child = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
        cwd: home, stdout: 'pipe', stderr: 'pipe', stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
        env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_DISABLE_UPDATE_CHECK: '1', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' },
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    }
    async function page(slug: string): Promise<{ compiled_truth: string; knowledge_revision: string }> {
      const read = await cli(['get', slug, '--json']);
      expect(read.code, read.stderr).toBe(0);
      return JSON.parse(read.stdout);
    }
    /** Reads the brain directly between CLI runs (the PGLite lock is free once the CLI exits). */
    async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
      if (pg) return pg.executeRaw<T>(text, params);
      const { database_path } = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
      await pglite!.connect({ database_path });
      try { return await pglite!.executeRaw<T>(text, params); } finally { await pglite!.disconnect(); }
    }
    const uploads = async () => (await sql<{ n: number }>("SELECT count(*)::int AS n FROM page_body_stagings WHERE kind = 'upload'"))[0]!.n;
    const stored = async (slug: string) => (await sql<{ body_storage: string; source_path: string | null; source_uri: string | null; knowledge_revision: string }>(
      'SELECT body_storage, source_path, source_uri, knowledge_revision FROM pages WHERE slug = $1', [slug]))[0]!;
    const file = (name: string, content: string | Buffer) => { const path = join(home, name); writeFileSync(path, content); return path; };

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), `gbrain-cli-page-writes-${backend}-`));
      if (backend === 'postgres') {
        const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        close = isolated.close;
        pg = isolated.engine;
        const [database] = await pg.executeRaw<{ name: string }>('SELECT current_database() AS name');
        const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database.name}`;
        const init = await cli(['init', '--url', url.toString(), '--non-interactive', '--no-embedding']);
        expect(init.code, init.stderr).toBe(0);
      } else {
        pglite = new PGLiteEngine();
        const init = await cli(['init', '--pglite', '--no-embedding']);
        expect(init.code, init.stderr).toBe(0);
      }
    }, 180_000);
    afterAll(async () => {
      await close?.();
      rmSync(home, { recursive: true, force: true });
    });

    test('put --file reads the page from the file, escape-heavy text intact, without stdin', async () => {
      const body = `# File page\n\n${ESCAPE_HEAVY}\nsecond line`;
      const put = await cli(['put', 'notes/from-file', '--file', file('from-file.md', body + '\n')]);
      expect(put.code, put.stderr).toBe(0);
      expect((await page('notes/from-file')).compiled_truth).toBe(body);
    }, 120_000);

    test('put --file=PATH replaces with --expected-revision; a missing file writes nothing', async () => {
      await cli(['put', 'notes/replaced', '--file', file('v1.md', '# V1\n\nfirst version\n')]);
      const { knowledge_revision } = await page('notes/replaced');
      const put = await cli(['put', 'notes/replaced', `--file=${file('v2.md', '# V2\n\nsecond version\n')}`, '--expected-revision', knowledge_revision]);
      expect(put.code, put.stderr).toBe(0);
      expect((await page('notes/replaced')).compiled_truth).toBe('# V2\n\nsecond version');
      const missing = await cli(['put', 'notes/missing', '--file', join(home, 'nope.md')]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain('invalid_params');
      expect((await cli(['get', 'notes/missing', '--json'])).code).not.toBe(0);
    }, 120_000);

    test('put --file refuses binary input before any write', async () => {
      const denied = await cli(['put', 'notes/binary', '--file', file('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]))]);
      expect(denied.code).toBe(2);
      expect(denied.stderr).toContain('binary (PNG)');
    }, 60_000);

    test('append adds text from a file and from stdin in order; a replayed --request-id appends once', async () => {
      await cli(['put', 'notes/log', '--file', file('log.md', '# Log\n\n- first message\n')]);
      const fromFile = await cli(['append', 'notes/log', '--file', file('next.md', `- second ${ESCAPE_HEAVY}\n`), '--json']);
      expect(fromFile.code, fromFile.stderr).toBe(0);
      expect(JSON.parse(fromFile.stdout)).toMatchObject({ slug: 'notes/log' });
      const requestId = crypto.randomUUID();
      for (let i = 0; i < 2; i++) {
        const fromStdin = await cli(['append', 'notes/log', '--request-id', requestId], '- third message\n');
        expect(fromStdin.code, fromStdin.stderr).toBe(0);
      }
      const body = (await page('notes/log')).compiled_truth;
      expect(body).toBe(`# Log\n\n- first message\n- second ${ESCAPE_HEAVY}\n- third message`);
    }, 120_000);

    test('append with no text, or an invalid --region, is a usage error', async () => {
      const empty = await cli(['append', 'notes/log']);
      expect(empty.code).toBe(2);
      const region = await cli(['append', 'notes/log', '--region', 'middle'], 'x\n');
      expect(region.code).toBe(2);
      expect(region.stderr).toContain('--region must be one of: auto, truth, timeline');
    }, 60_000);

    const tailOf = async (slug: string) => {
      const read = await cli(['get', slug, '--body', 'none', '--json']);
      expect(read.code, read.stderr).toBe(0);
      return /"tail_sha256":\s*"([0-9a-f]{64})"/.exec(read.stdout)![1]!;
    };
    const lines = (bytes: number) => {
      const line = `- ${ESCAPE_HEAVY} message\n`;
      return line.repeat(Math.ceil(bytes / Buffer.byteLength(line)));
    };

    test('a 2 MiB local append is one direct append_page, with no upload session, and honours --expect-tail', async () => {
      await cli(['put', 'notes/big-append', '--file', file('big-append.md', '# Big append\n\nstart\n')]);
      const before = await uploads();
      const tail = await tailOf('notes/big-append');
      const text = lines(2 * 1024 * 1024);
      const path = file('big-append-text.md', text);
      const stale = await cli(['append', 'notes/big-append', '--file', path, '--expect-tail', 'f'.repeat(64)]);
      expect(stale.code).not.toBe(0);
      expect(stale.stderr).toContain('tail_changed');
      expect(printedBody((await cli(['get', 'notes/big-append'])).stdout).trimEnd()).toBe('# Big append\n\nstart');
      const appended = await cli(['append', 'notes/big-append', '--file', path, '--expect-tail', tail, '--region', 'truth', '--separator', 'auto', '--json']);
      expect(appended.code, appended.stderr).toBe(0);
      expect(await uploads()).toBe(before);
      const read = await cli(['get', 'notes/big-append']);
      expect(read.code, read.stderr).toBe(0);
      expect(printedBody(read.stdout).trimEnd()).toBe(`# Big append\n\nstart\n${text}`.trimEnd());
    }, 300_000);

    test('an append over the 4 MiB part cap goes through an upload session; --expect-tail, --region and --separator are refused there', async () => {
      await cli(['put', 'notes/huge-append', '--file', file('huge-append.md', '# Huge append\n\nstart\n')]);
      const before = await uploads();
      const text = lines(4 * 1024 * 1024 + 64 * 1024);
      const path = file('huge-append-text.md', text);
      for (const flags of [['--expect-tail', await tailOf('notes/huge-append')], ['--region', 'truth'], ['--separator', 'none']]) {
        const refused = await cli(['append', 'notes/huge-append', '--file', path, ...flags]);
        expect(refused.code, refused.stderr).toBe(2);
        expect(refused.stderr).toContain(`${flags[0]} apply only to an append whose call fits`);
      }
      expect(await uploads()).toBe(before);
      const appended = await cli(['append', 'notes/huge-append', '--file', path, '--json']);
      expect(appended.code, appended.stderr).toBe(0);
      expect(await uploads()).toBe(before + 1);
      const read = await cli(['get', 'notes/huge-append']);
      expect(read.code, read.stderr).toBe(0);
      expect(printedBody(read.stdout).trimEnd()).toBe(`# Huge append\n\nstart\n${text}`.trimEnd());
    }, 300_000);

    test('local put --file over the page ceiling on a managed brain goes through an upload session, byte-identical', async () => {
      const managed = async () => (await sql<{ enabled: boolean }>('SELECT enabled FROM persistence_brain'))[0]!.enabled;
      if (!await managed()) {
        await registerLocalWriter(pg!, 'cli');
        expect((await activatePersistence(pg!, { confirmQuiesced: true })).enabled).toBe(true);
      }
      expect(await managed()).toBe(true);
      const body = hugeBody('Managed huge');
      const path = file('managed-huge.md', body);
      let put = await cli(['put', 'notes/managed-huge', '--file', path]);
      if (put.code === 10) {
        const requestId = /Retry the same put with --request-id ([0-9a-f-]{36})/.exec(put.stderr)?.[1];
        expect(requestId, put.stderr).toBeDefined();
        put = await cli(['put', 'notes/managed-huge', '--file', path, '--request-id', requestId!]);
      }
      expect(put.code, put.stderr).toBe(0);
      expect(await stored('notes/managed-huge')).toMatchObject({ body_storage: 'segmented' });
      expect(await uploads()).toBeGreaterThan(0);
      expect(sha(printedBody((await cli(['get', 'notes/managed-huge'])).stdout))).toBe(sha(body));
    }, 600_000);

    test('local put --file over the page ceiling on an unmanaged brain streams in segmented and byte-identical, with no upload session', async () => {
      await sql('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const before = await uploads();
      const body = hugeBody('Huge');
      const put = await cli(['put', 'notes/huge', '--file', file('huge.md', body)]);
      expect(put.code, put.stderr).toBe(0);
      expect(await stored('notes/huge')).toMatchObject({ body_storage: 'segmented', source_path: null, source_uri: null });
      expect(await uploads()).toBe(before);
      const read = await cli(['get', 'notes/huge']);
      expect(read.code, read.stderr).toBe(0);
      expect(sha(printedBody(read.stdout))).toBe(sha(body));
      const replacement = file('huge-2.md', hugeBody('Huge v2'));
      const unconditional = await cli(['put', 'notes/huge', '--file', replacement]);
      expect(unconditional.code).not.toBe(0);
      expect(unconditional.stderr).toContain('revision');
      const replaced = await cli(['put', 'notes/huge', '--file', replacement, '--expected-revision', (await stored('notes/huge')).knowledge_revision]);
      expect(replaced.code, replaced.stderr).toBe(0);
      expect(sha(printedBody((await cli(['get', 'notes/huge'])).stdout))).toBe(sha(hugeBody('Huge v2')));
      expect(await uploads()).toBe(before);
    }, 600_000);

    test('local capture --file over the page ceiling on an unmanaged brain streams in under the capture slug and frontmatter once the write gate allows it, with no upload session', async () => {
      const before = await uploads();
      const raw = hugeBody('Captured');
      const path = file('captured.md', raw);
      const gated = await cli(['capture', '--file', path]);
      expect(gated.code).toBe(1);
      expect(gated.stderr).toContain('the write gate scans the whole body of a agent_written page');
      expect((await cli(['config', 'set', 'write_gate.agent_mode', 'off'])).code).toBe(0);
      const capture = await cli(['capture', '--file', path, '--json']);
      expect(capture.code, capture.stderr).toBe(0);
      const receipt = JSON.parse(capture.stdout);
      const hash = sha(normalizeForHash(raw));
      expect(receipt).toMatchObject({ content_hash: hash, source_kind: 'capture-cli', slug: `inbox/${new Date().toISOString().slice(0, 10)}-${hash.slice(0, 8)}` });
      expect(await stored(receipt.slug)).toMatchObject({ body_storage: 'segmented', source_path: null, source_uri: 'cli-file' });
      expect(await uploads()).toBe(before);
      const read = await cli(['get', receipt.slug]);
      expect(read.code, read.stderr).toBe(0);
      expect(read.stdout).toContain('captured_via: capture-cli');
      expect(sha(printedBody(read.stdout))).toBe(sha(raw));
    }, 600_000);
  });
}
