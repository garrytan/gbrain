/**
 * A page whose leading frontmatter fence is indented (` ---`), or whose block the parser otherwise does not read, was
 * parsed as EMPTY frontmatter, so the `readable_by` it named (in block style or in a `{...}` flow mapping) was dropped and the
 * page was stored readable by every member. Now put_page, edit_page and capture refuse it (`invalid_frontmatter`, reason
 * `ambiguous_protected_key`) and store nothing, sync and import hold the file, and an unlisted member never reads it.
 * Content with the fence in the first column, and an indented fence that names no readers, behave as they always did.
 *
 * Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP dispatch as
 * serve-http-mcp does, on a repo-less brain; embeddings stubbed. Runs on PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';
import { importStreamedMarkdownFile } from '../src/core/page-body/streamed-import.ts';
import { isFrontmatterHoldMessage, parseMarkdown } from '../src/core/markdown.ts';
import { screenImportContent } from '../src/core/import-screen.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { noncanonicalPrivateHold } from '../src/core/persistence/visibility-request.ts';
import { assertCaptureBlockRead, assertReadersBlockRead, unreadReadersFileHold, unreadReadersHold, unreadReadersLine } from '../src/core/persistence/unread-readers.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

const SRC = 'unread-src';
const OWNER = 'owner-example';
const OTHER = 'bob-example';
const BODY = (canary: string) => `Harbor ledger planning notes ${canary} for the roadmap.\n`;
const keys = 'title: Example\ntype: note\nreadable_by: [alice-example]\n';

/** Pages that open with a block the parser does not read and that names its readers: each must be refused. */
const UNREAD: Array<{ label: string; content: (canary: string) => string }> = [
  { label: 'an indented block fence with the correct readable_by', content: c => ` ---\n${keys}---\n${BODY(c)}` },
  { label: 'an indented flow mapping with Readable_By', content: c => ` ---\n{title: Example, Readable_By: [alice-example]}\n---\n${BODY(c)}` },
  { label: 'an indented flow mapping with readable_by', content: c => ` ---\n{title: Example, readable_by: [alice-example]}\n---\n${BODY(c)}` },
  { label: 'a tab before the fence', content: c => `\t---\n${keys}---\n${BODY(c)}` },
  { label: 'a no-break space before the fence', content: c => `\u00A0---\n${keys}---\n${BODY(c)}` },
  { label: 'blank lines then an indented fence', content: c => `\n\n  ---\n${keys}---\n${BODY(c)}` },
  { label: 'an indented fence with CRLF line endings', content: c => ` ---\r\n${keys.replace(/\n/g, '\r\n')}---\r\n${BODY(c)}` },
  { label: 'a byte order mark then an indented fence', content: c => `\uFEFF ---\n${keys}---\n${BODY(c)}` },
  { label: 'an indented fence with readable-by', content: c => ` ---\ntitle: Example\nreadable-by: [alice-example]\n---\n${BODY(c)}` },
  { label: 'a zero-width space before the fence', content: c => `\u200B---\n${keys}---\n${BODY(c)}` },
  { label: 'a zero-width space inside the key', content: c => ` ---\ntitle: Example\nreadable\u200B_by: [alice-example]\n---\n${BODY(c)}` },
  { label: 'an explicit-key marker before the key', content: c => ` ---\n? readable_by : [alice-example]\n---\n${BODY(c)}` },
  { label: 'an anchor before the key', content: c => ` ---\n&a readable_by: [alice-example]\n---\n${BODY(c)}` },
  { label: 'a tag before the key', content: c => ` ---\n!!str readable_by: [alice-example]\n---\n${BODY(c)}` },
  { label: 'a tag before the key in a flow mapping', content: c => ` ---\n{title: Example, !!str readable_by: [alice-example]}\n---\n${BODY(c)}` },
  { label: 'an explicit key whose value is on the next line', content: c => ` ---\n? readable_by\n: [alice-example]\n---\n${BODY(c)}` },
  { label: 'a --- inside an indented block scalar before the key', content: c => ` ---\ndescription: |\n  ---\nreadable_by: [alice-example]\n---\n${BODY(c)}` },
  { label: 'a byte order mark, a blank line and a no-break space line before the fence', content: c => `\uFEFF\n\u00A0\n---\n${keys}---\n${BODY(c)}` },
  { label: 'a four-dash fence', content: c => `----\n${keys}---\n${BODY(c)}` },
  { label: 'a fence that never closes', content: c => `---\n${keys}${BODY(c)}` },
  { label: 'a fence closed by an indented line', content: c => `---\n${keys}  ---\n${BODY(c)}` },
];

describe('unread leading block detection', () => {
  test('each page that opens with an unread block naming readers is found, with the line of the key', () => {
    for (const { label, content } of UNREAD) expect({ label, line: unreadReadersLine(content('canaryx')) !== null }).toEqual({ label, line: true });
    expect(unreadReadersLine(` ---\n${keys}---\nbody`)).toBe(4);
    expect(unreadReadersLine(`+++\ntitle = "x"\nreadable_by = ["a"]\n+++\nbody`)).toBe(3);
  });

  test('a block the parser reads, a block that names no readers, readers in the body and a block that is not leading are not found', () => {
    const none = [
      `---\n${keys}---\nbody`, // the fence is in the first column: the parser reads it
      `---\n{title: Example, readable_by: [alice-example]}\n---\nbody`,
      `---\n{title: Example,\n readable_by: [alice-example]}\n---\nbody`,
      `---\n${keys}---\n---\nfoo\n---\n`, // a second fence in the body of a page whose block was read
      ' ---\ntitle: Example\ntype: note\n---\nbody', // an indented fence that names no readers
      '---\ntitle: Example\n---\nreadable_by: [alice-example]\n',
      `intro\n\n ---\n${keys}---\nbody`,
      ' ---\nwe say readable by nobody\n---\n',
      ' ---\ntitle: Example\n# Example: {readable_by: [alice-example]}\n---\nbody', // a comment names no readers
      '', 'plain text', '---\n---\n',
    ];
    for (const content of none) expect({ content, found: unreadReadersLine(content) }).toEqual({ content, found: null });
  });

  test('a long line of padding is scanned in linear time and an oversized flow line is still caught', () => {
    const started = performance.now();
    expect(unreadReadersLine('---' + ' '.repeat(64_000) + '!\nbody\n')).toBeNull();
    expect(unreadReadersLine(' ---\n' + ' '.repeat(64_000) + '{ { { x\n---\nbody\n')).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(unreadReadersLine(` ---\n{title: ${'x'.repeat(5000)}, readable_by: [alice-example]}\n---\nbody`)).toBe(2);
  });

  test('the detector agrees with the parser: it flags only content the parser read no frontmatter from, and a read block is never flagged', () => {
    for (const { label, content } of UNREAD) {
      expect({ label, readersRead: 'readable_by' in parseMarkdown(content('canaryx'), 'notes/x.md').frontmatter }).toEqual({ label, readersRead: false });
    }
    for (const content of [`---\n${keys}---\nbody`, `\n\n---\n${keys}---\nbody`, `\uFEFF---\n${keys}---\nbody`, `---\r\n${keys.replace(/\n/g, '\r\n')}---\r\nbody`]) {
      expect(unreadReadersLine(content)).toBeNull();
      expect(parseMarkdown(content, 'notes/x.md').frontmatter.readable_by).toEqual(['alice-example']);
    }
  });

  test('the hold is a frontmatter hold the importer already recognises, and it never echoes the spelling the author used', () => {
    const hold = unreadReadersHold(' ---\nREADABLE BY: [alice-example]\n---\nbody')!;
    expect(hold).toMatchObject({ code: 'invalid_frontmatter', reason: 'ambiguous_protected_key', key: 'readable_by', line: 2 });
    expect(isFrontmatterHoldMessage(hold.message)).toBe(true);
    expect(hold.message).not.toContain('READABLE BY');
    expect(noncanonicalPrivateHold(' ---\nreadable_by: [alice-example]\n---\nbody', {})).toMatchObject({ code: 'invalid_frontmatter' });
    expect(noncanonicalPrivateHold('---\nreadable_by: [alice-example]\n---\nbody', { readable_by: ['alice-example'] })).toBeNull();
  });

  test('the write refusal names the fix, the check to run and the docs, and a remote caller gets no key name', () => {
    const row = { slug: 'notes/x', source_id: 'default' };
    let local: any, remote: any;
    try { assertReadersBlockRead(row, ` ---\n${keys}---\nbody`, false); } catch (e) { local = e; }
    try { assertReadersBlockRead(row, ` ---\n${keys}---\nbody`, true); } catch (e) { remote = e; }
    expect(local).toMatchObject({ code: 'invalid_params', canonical: 'invalid_frontmatter', reason: 'ambiguous_protected_key' });
    expect(local.suggestion).toContain('first column');
    expect(local.suggestion).toContain('readable_by: [alice-example]');
    expect(local.suggestion).toContain('gbrain access check --token <name> --as <member>');
    expect(local.docs).toContain('write-refusals.md#invalid_frontmatter-ambiguous_protected_key');
    expect(local.message).toContain('readable_by');
    expect(remote.message).not.toContain('readable_by');
    expect(() => assertCaptureBlockRead(` ---\n${keys}---\nbody`, false)).toThrow(/not read/);
    expect(() => assertCaptureBlockRead(`---\n${keys}---\nbody`, false)).not.toThrow();
  });

  test('the file-head hold reads the first 256 KiB of a file and holds the same content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unread-head-'));
    try {
      const path = join(dir, 'big.md');
      writeFileSync(path, ` ---\n${keys}---\n${'x'.repeat(300 * 1024)}\n`);
      const handle = await open(path, 'r');
      try { expect(await unreadReadersFileHold(handle, 300 * 1024)).toMatchObject({ code: 'invalid_frontmatter', line: 4 }); } finally { await handle.close(); }
      // The readers line sits past the head and the fence has not closed inside it: the whole file is read.
      writeFileSync(path, ` ---\ntitle: Example\n${'x'.repeat(300 * 1024)}\nreadable_by: [alice-example]\n---\nbody\n`);
      const far = await open(path, 'r');
      try { expect(await unreadReadersFileHold(far, (await far.stat()).size)).toMatchObject({ code: 'invalid_frontmatter', line: 4 }); } finally { await far.close(); }
      for (const opener of ['----', '+++']) {
        writeFileSync(path, `${opener}\ntitle: Example\n${'x'.repeat(300 * 1024)}\nreadable_by: [alice-example]\n---\nbody\n`);
        const wide = await open(path, 'r');
        try { expect({ opener, hold: (await unreadReadersFileHold(wide, (await wide.stat()).size))?.code }).toEqual({ opener, hold: 'invalid_frontmatter' }); } finally { await wide.close(); }
      }
      // A first-column block that runs past the head is read by the parser, so it is not held.
      writeFileSync(path, `---\ntitle: Example\nnote: ${'x'.repeat(300 * 1024)}\nreadable_by: [alice-example]\n---\nbody\n`);
      const readBlock = await open(path, 'r');
      try { expect(await unreadReadersFileHold(readBlock, (await readBlock.stat()).size)).toBeNull(); } finally { await readBlock.close(); }
      writeFileSync(path, ` ---\ntitle: Example\n---\n${'x'.repeat(1000)}\n`);
      const clean = await open(path, 'r');
      try { expect(await unreadReadersFileHold(clean, 1000)).toBeNull(); } finally { await clean.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

for (const kind of testBackends()) {
  describe(`unread frontmatter block that names readers (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: 'local' | 'owner' | 'bob', op: string, params: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
      if (who === 'local') {
        const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: SRC });
        return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
      }
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }

    /** Whether `who` gets the canary through get_page and through search. */
    async function sees(who: 'local' | 'owner' | 'bob', slug: string, canary: string): Promise<{ get_page: boolean; search: boolean }> {
      const got = await call(who, 'get_page', { slug });
      const found = await call(who, 'search', { query: 'harbor ledger planning notes', fields: 'full', limit: 50 });
      return { get_page: !got.isError && got.text.includes(canary), search: found.text.includes(canary) };
    }
    const put = (slug: string, content: string, expectedRevision?: string) =>
      call('local', 'put_page', { slug, content, request_id: crypto.randomUUID(), wait_ms: 25_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) });
    const stored = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: SRC, includeDeleted: true })) !== null;
    const refused = (out: { isError: boolean; text: string }) => ({ isError: out.isError, invalid_frontmatter: out.text.includes('invalid_frontmatter') || out.text.includes('Invalid YAML frontmatter') });
    const canaryRows = async (canary: string) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE compiled_truth LIKE $1', [`%${canary}%`]))[0]!.n);

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of [OWNER, OTHER]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, member: string) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      };
      await mint('owner', OWNER);
      await mint('bob', OTHER);
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('put_page refuses every unread block that names readers, stores nothing, and an unlisted member reads nothing', async () => {
      let n = 0;
      for (const { label, content } of UNREAD) {
        const canary = `canaryunread${n}`;
        const slug = `notes/unread-${n++}`;
        const out = await put(slug, content(canary));
        expect({ label, ...refused(out) }).toEqual({ label, isError: true, invalid_frontmatter: true });
        expect({ label, stored: await stored(slug) }).toEqual({ label, stored: false });
        for (const who of ['local', 'owner', 'bob'] as const) expect({ label, who, ...await sees(who, slug, canary) }).toEqual({ label, who, get_page: false, search: false });
      }
    }, 240_000);

    test('capture refuses an indented fence with readers before it is wrapped, and stores nothing', async () => {
      for (const [i, { label, content }] of UNREAD.slice(0, 3).entries()) {
        const canary = `canarycapture${i}`;
        const out = await call('local', 'capture', { content: content(canary), slug: `notes/captured-${i}` });
        expect({ label, ...refused(out) }).toEqual({ label, isError: true, invalid_frontmatter: true });
        expect({ label, rows: await canaryRows(canary) }).toEqual({ label, rows: 0 });
        expect(await sees('bob', `notes/captured-${i}`, canary)).toEqual({ get_page: false, search: false });
      }
    }, 120_000);

    test('edit_page refuses an edit whose result opens with an unread block that names readers, and the page keeps its restriction', async () => {
      const slug = 'notes/edited';
      const first = await put(slug, `---\ntitle: Example\ntype: note\nreadable_by: [${OWNER}]\n---\n${BODY('canaryeditone')}`);
      expect(first.isError).toBe(false);
      const before = (await engine.readPageSnapshot(slug, { sourceId: SRC }))?.revision;
      const out = await call('local', 'edit_page', { slug, edits: [{ old_text: '---\ntype: note', new_text: ' ---\ntype: note' }], expected_revision: before });
      expect(refused(out)).toEqual({ isError: true, invalid_frontmatter: true });
      expect((await engine.readPageSnapshot(slug, { sourceId: SRC }))?.revision).toBe(before);
      expect(await sees('bob', slug, 'canaryeditone')).toEqual({ get_page: false, search: false });
      expect(await sees('owner', slug, 'canaryeditone')).toEqual({ get_page: true, search: true });
    }, 120_000);

    test('a fence in the first column with readable_by still stores and restricts', async () => {
      const slug = 'notes/column-zero';
      const out = await put(slug, `---\ntitle: Example\ntype: note\nreadable_by: [${OWNER}]\n---\n${BODY('canarycolzero')}`);
      expect(out.isError).toBe(false);
      expect(await sees('owner', slug, 'canarycolzero')).toEqual({ get_page: true, search: true });
      expect(await sees('bob', slug, 'canarycolzero')).toEqual({ get_page: false, search: false });
      const flow = await put('notes/column-zero-flow', `---\n{title: Example, type: note, readable_by: [${OWNER}]}\n---\n${BODY('canarycolflow')}`);
      expect(flow.isError).toBe(false);
      expect(await sees('bob', 'notes/column-zero-flow', 'canarycolflow')).toEqual({ get_page: false, search: false });
    }, 120_000);

    test('an indented fence that names no readers stores as it does on master', async () => {
      const slug = 'notes/indented-no-readers';
      const out = await put(slug, ` ---\ntitle: Example\ntype: note\n---\n${BODY('canaryindented')}`);
      expect(out.isError).toBe(false);
      expect(await stored(slug)).toBe(true);
      expect(await sees('bob', slug, 'canaryindented')).toEqual({ get_page: true, search: true });
    }, 120_000);

    test('a frontmatter-language block the parser throws on is still refused by the existing path, not stored', async () => {
      const out = await put('notes/js-block', `---js\n${keys}---\n${BODY('canaryjsblock')}`);
      expect(out.isError).toBe(true);
      expect(await stored('notes/js-block')).toBe(false);
    }, 120_000);

    test('a streamed import holds an unread block that names readers, even when the readers line is past the first 256 KiB, and still imports a first-column block', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-unread-stream-'));
      const path = join(dir, 'page.md');
      const policy = { ...(await readPageBodyPolicy(engine)), segmented: true };
      const body = 'A line about acme-example.\n'.repeat(2000);
      try {
        for (const [slug, head] of [['notes/large-spaced', ' ---\nreadable_by: [alice-example]\n---\n'], ['notes/large-far', ` ---\ntitle: Example\n${'x'.repeat(300 * 1024)}\nreadable_by: [alice-example]\n---\n`]] as const) {
          writeFileSync(path, head + body);
          expect({ slug, result: await importStreamedMarkdownFile(engine, path, `${slug}.md`, { noEmbed: true, sourceId: SRC, inferFrontmatter: false }, statSync(path), policy) })
            .toMatchObject({ result: { status: 'skipped', skip_reason: 'invalid_frontmatter' } });
          expect({ slug, stored: await stored(slug) }).toEqual({ slug, stored: false });
        }
        writeFileSync(path, `---\nreadable_by: [${OWNER}]\n---\n` + body);
        expect((await importStreamedMarkdownFile(engine, path, 'notes/large-fixed.md', { noEmbed: true, sourceId: SRC, inferFrontmatter: false }, statSync(path), policy)).status).not.toBe('skipped');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 120_000);

    test('sync and import hold the file: the screen, the legacy import and a stored page that is not written', async () => {
      const content = ` ---\n${keys}---\n${BODY('canarysyncunread')}`;
      const screened = screenImportContent({ content, path: 'notes/held.md', expectedSlug: 'notes/held', holdNoncanonicalPrivate: true });
      expect(screened).toMatchObject({ status: 'refused', refusal: { code: 'invalid_frontmatter', reason: 'ambiguous_protected_key' } });
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-unread-import-'));
      try {
        const path = join(dir, 'held.md');
        writeFileSync(path, content);
        const result = await importFromFile(engine, path, 'held.md', { noEmbed: true, sourceId: SRC });
        expect(result).toMatchObject({ status: 'skipped', skip_reason: 'invalid_frontmatter' });
        expect(await stored('held')).toBe(false);
        const ok = join(dir, 'fine.md');
        writeFileSync(ok, `---\n${keys}---\n${BODY('canarysyncfine')}`);
        expect((await importFromFile(engine, ok, 'fine.md', { noEmbed: true, sourceId: SRC })).status).toBe('imported');
      } finally { rmSync(dir, { recursive: true, force: true }); }
      expect(await importFromContent(engine, 'notes/direct', ` ---\n${keys}---\n${BODY('canarydirect')}`, { sourceId: SRC, noEmbed: true, holdNoncanonicalPrivate: true }))
        .toMatchObject({ status: 'error', skip_reason: 'invalid_frontmatter', refusal: { reason: 'ambiguous_protected_key' } });
      expect(await stored('notes/direct')).toBe(false);
    }, 120_000);
  });
}
