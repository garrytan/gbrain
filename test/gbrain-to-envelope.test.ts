/**
 * Pins the envelope-v0 exporter contract: conforming output, honest handling of
 * the fields a gbrain page cannot carry, deterministic ordering, and loud
 * skipping. The mirror of test/envelope-to-gbrain.test.ts - the corpus is built
 * by running the importer on its own fixture, so the round trip is the test.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMPORTER_PATH = join(import.meta.dir, '..', 'scripts', 'envelope-to-gbrain.mjs');
const EXPORTER_PATH = join(import.meta.dir, '..', 'scripts', 'gbrain-to-envelope.mjs');
const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'memvelope', 'sample.mve.json');
const TEMP_DIRS: string[] = [];

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-to-envelope-'));
  TEMP_DIRS.push(dir);
  return dir;
}

// Both scripts are plain Node-compatible ESM; Bun executes them directly in CI
// without a separate node toolchain.
async function run(script: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  return {
    exitCode: proc.exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

/** Runs the importer, then the exporter, and returns both results plus the parsed envelope. */
async function roundTrip(envelopePath = FIXTURE_PATH) {
  const pagesDir = join(tempDir(), 'pages');
  const outPath = join(tempDir(), 'out.mve.json');
  const imported = await run(IMPORTER_PATH, [envelopePath, pagesDir]);
  const exported = await run(EXPORTER_PATH, [pagesDir, outPath]);
  return {
    imported,
    exported,
    pagesDir,
    outPath,
    envelope: exported.exitCode === 0 ? JSON.parse(readFileSync(outPath, 'utf8')) : null,
  };
}

/** Runs the exporter over a directory of pages written by the test itself. */
async function exportPages(pages: Record<string, string>) {
  const pagesDir = join(tempDir(), 'pages');
  const outPath = join(tempDir(), 'out.mve.json');
  for (const [name, content] of Object.entries(pages)) {
    const full = join(pagesDir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  const result = await run(EXPORTER_PATH, [pagesDir, outPath]);
  return {
    ...result,
    envelope: result.exitCode === 0 ? JSON.parse(readFileSync(outPath, 'utf8')) : null,
  };
}

/**
 * Structural conformance against envelope-v0 as published (JSON Schema draft-07
 * at memvelope.com/schema/envelope-v0.schema.json). Every constraint the schema
 * states is asserted here rather than paraphrased: required keys, types, the
 * role enum, `minItems: 1` on messages, `minLength: 1` on text, and the integer
 * minimums on the meta counts. Written out longhand so the test needs no
 * validator dependency, matching the scripts' own zero-dependency posture.
 */
function assertEnvelopeV0(doc: unknown): void {
  expect(doc).toBeObject();
  const env = doc as Record<string, unknown>;
  expect(env.memvelope).toBe('envelope-v0');

  expect(env.meta).toBeObject();
  const meta = env.meta as Record<string, unknown>;
  expect(typeof meta.source_provider).toBe('string');
  expect(Number.isInteger(meta.conversation_count)).toBe(true);
  expect(meta.conversation_count as number).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(meta.message_count)).toBe(true);
  expect(meta.message_count as number).toBeGreaterThanOrEqual(0);
  // Optional, and the spec says omitted rather than null when unknown.
  if ('source_export_date' in meta) expect(typeof meta.source_export_date).toBe('string');

  expect(Array.isArray(env.conversations)).toBe(true);
  const conversations = env.conversations as Array<Record<string, unknown>>;
  for (const c of conversations) {
    for (const key of ['id', 'title', 'created_at', 'updated_at', 'messages']) {
      expect(c).toHaveProperty(key);
    }
    expect(c.id === null || typeof c.id === 'string').toBe(true);
    expect(typeof c.title).toBe('string');
    expect(c.created_at === null || typeof c.created_at === 'string').toBe(true);
    expect(c.updated_at === null || typeof c.updated_at === 'string').toBe(true);
    expect(Array.isArray(c.messages)).toBe(true);
    const messages = c.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBeGreaterThanOrEqual(1);
    for (const m of messages) {
      for (const key of ['id', 'role', 'ts', 'text']) {
        expect(m).toHaveProperty(key);
      }
      expect(typeof m.id).toBe('string');
      expect(['user', 'assistant']).toContain(m.role as string);
      expect(m.ts === null || typeof m.ts === 'string').toBe(true);
      expect(typeof m.text).toBe('string');
      expect((m.text as string).length).toBeGreaterThanOrEqual(1);
    }
  }
  // The counts are part of the document, so they get checked against it.
  expect(meta.conversation_count).toBe(conversations.length);
  expect(meta.message_count).toBe(
    conversations.reduce((n, c) => n + (c.messages as unknown[]).length, 0),
  );
}

/** The page shape gbrain itself writes: js-yaml frontmatter, unquoted scalars. */
function gbrainPage(front: string, body: string): string {
  return `---\n${front}\n---\n\n${body}\n`;
}

const TURNS = [
  '**Me** (2026-02-01T09:00:00.000Z · m1):',
  '',
  'alice-example asked about the widget-co rollout.',
  '',
  '---',
  '',
  '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
  '',
  'Start with the acme-example owner.',
].join('\n');

describe('gbrain-to-envelope exporter', () => {
  test('sample envelope round-trips to a conforming envelope and reports counts', async () => {
    const result = await roundTrip();

    expect(result.imported.exitCode).toBe(0);
    expect(result.exported.exitCode).toBe(0);
    expect(result.exported.stdout).toContain('wrote 1 conversation(s), 4 message(s)');
    assertEnvelopeV0(result.envelope);
  });

  test('round trip preserves ids, titles, roles, text, timestamps and provider', async () => {
    const result = await roundTrip();
    const source = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

    expect(result.exported.exitCode).toBe(0);
    // The whole document, not a field spot-check: on this fixture the round trip
    // is exact, so any future loss shows up here rather than in a gap between
    // the fields someone remembered to assert.
    expect(result.envelope).toEqual({
      memvelope: 'envelope-v0',
      meta: {
        source_provider: 'chatgpt',
        conversation_count: 1,
        message_count: 4,
      },
      conversations: source.conversations,
    });
  });

  test('output is deterministic across repeated runs', async () => {
    const first = await roundTrip();
    const second = await roundTrip();

    expect(first.exported.exitCode).toBe(0);
    expect(second.exported.exitCode).toBe(0);
    expect(readFileSync(first.outPath, 'utf8')).toBe(readFileSync(second.outPath, 'utf8'));
  });

  test('reads the frontmatter style gbrain itself writes, including nested slug directories', async () => {
    // `gbrain export` serializes through js-yaml: plain unquoted scalars, a
    // single-quoted date, and one file per slug under its slug directory. The
    // importer writes flat files with JSON-quoted values. Both are the same
    // page set and both must read.
    const result = await exportPages({
      'conversations/2026-02-01-c-nested.md': gbrainPage(
        [
          'type: conversation',
          'title: Rollout notes',
          "date: '2026-02-01'",
          'origin: memvelope/envelope-v0',
          'source: chatgpt',
          'memvelope_conversation_id: c-nested',
        ].join('\n'),
        `# Rollout notes\n\n${TURNS}`,
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope);
    expect(result.envelope.meta.source_provider).toBe('chatgpt');
    expect(result.envelope.conversations[0].id).toBe('c-nested');
    expect(result.envelope.conversations[0].title).toBe('Rollout notes');
    expect(result.envelope.conversations[0].messages).toHaveLength(2);
  });

  test('created_at and updated_at come from the first and last message timestamps', async () => {
    // The page keeps only `date`, a day. It cannot carry either date-time, so
    // both are taken from the messages. This is a documented lossy edge, pinned
    // here so it stays deliberate.
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Timestamps', "date: '2026-02-01'", 'source: chatgpt'].join('\n'),
        TURNS,
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations[0].created_at).toBe('2026-02-01T09:00:00.000Z');
    expect(result.envelope.conversations[0].updated_at).toBe('2026-02-01T09:05:00.000Z');
  });

  test('a turn written without a timestamp becomes null, not the literal text', async () => {
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: No timestamp', 'source: chatgpt'].join('\n'),
        '**Me** (no timestamp · m1):\n\nalice-example wrote with no timestamp.',
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope);
    expect(result.envelope.conversations[0].messages[0].ts).toBeNull();
    expect(result.envelope.conversations[0].created_at).toBeNull();
  });

  test('a page without a conversation id emits null rather than a synthesized id', async () => {
    // envelope-v0 permits a null id and tells converters not to invent one, so
    // the positional filename must never leak into the id field.
    const result = await exportPages({
      '2026-02-01-conv-1.md': gbrainPage(
        ['type: conversation', 'title: No id', 'source: chatgpt'].join('\n'),
        TURNS,
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope);
    expect(result.envelope.conversations[0].id).toBeNull();
    expect(JSON.stringify(result.envelope)).not.toContain('conv-1');
  });

  test('pages that are not conversations are skipped and accounted for', async () => {
    const result = await exportPages({
      'people/alice-example.md': gbrainPage('type: person\ntitle: alice-example', 'A person page.'),
      'no-frontmatter.md': 'Just a body, no frontmatter at all.\n',
      'conversations/keep.md': gbrainPage(
        ['type: conversation', 'title: Keep me', 'source: chatgpt', 'memvelope_conversation_id: c-keep'].join('\n'),
        TURNS,
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(1);
    expect(result.envelope.conversations[0].id).toBe('c-keep');
    expect(result.stderr).toContain('1 not type conversation');
    expect(result.stderr).toContain('1 without frontmatter');
  });

  test('a conversation page with no speaker turns is skipped loudly', async () => {
    // envelope-v0 requires at least one message per conversation, so a page
    // whose body no longer carries turn headers cannot be emitted at all.
    // Silence here would produce a conforming envelope that quietly lost a
    // conversation.
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Compiled away', 'source: chatgpt'].join('\n'),
        'A summary of the conversation, with the speaker turns gone.',
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(0);
    expect(result.stderr).toContain('no speaker turns found');
    expect(result.stdout).toContain('wrote 0 conversation(s)');
  });

  test('an empty turn is dropped loudly rather than emitted', async () => {
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Empty turn', 'source: chatgpt'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
          '',
          'acme-example replied to an empty turn.',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope);
    expect(result.envelope.conversations[0].messages).toHaveLength(1);
    expect(result.envelope.meta.message_count).toBe(1);
    expect(result.stderr).toContain('has no text; dropped');
  });

  test('a horizontal rule inside a message survives; the turn separator does not leak in', async () => {
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Rules', 'source: chatgpt'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'before the rule',
          '',
          '---',
          '',
          'after the rule',
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
          '',
          'fund-a replied.',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations[0].messages).toHaveLength(2);
    expect(result.envelope.conversations[0].messages[0].text).toBe('before the rule\n\n---\n\nafter the rule');
  });

  test('a timeline section never becomes message text', async () => {
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: With timeline', 'source: chatgpt'].join('\n'),
        `${TURNS}\n\n<!-- timeline -->\n\n- 2026-02-02: gbrain added a timeline entry.`,
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations[0].messages).toHaveLength(2);
    expect(JSON.stringify(result.envelope)).not.toContain('added a timeline entry');
  });

  test('conversations are emitted in sorted path order', async () => {
    // Deterministic, and not the source envelope's array order. Pinned so the
    // documented ordering loss is a decision rather than an accident.
    const page = (id: string) =>
      gbrainPage(
        ['type: conversation', `title: ${id}`, 'source: chatgpt', `memvelope_conversation_id: ${id}`].join('\n'),
        TURNS,
      );
    const result = await exportPages({
      '2026-03-09-c-later.md': page('c-later'),
      '2026-03-01-c-earlier.md': page('c-earlier'),
      'nested/2026-03-05-c-middle.md': page('c-middle'),
    });

    expect(result.exitCode).toBe(0);
    // Files at a level come before that level's subdirectories here only because
    // a digit sorts before `n`; the rule is one sort over entry names, applied
    // at every level.
    expect(result.envelope.conversations.map((c: { id: string }) => c.id)).toEqual([
      'c-earlier',
      'c-later',
      'c-middle',
    ]);
  });

  test('a page saved with CRLF line endings still parses', async () => {
    // Every match in the script is line-anchored, so without normalization a
    // CRLF page reads as having no frontmatter and disappears into the skip
    // count.
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: CRLF', 'source: chatgpt', 'memvelope_conversation_id: c-crlf'].join('\n'),
        TURNS,
      ).replace(/\n/g, '\r\n'),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope);
    expect(result.envelope.conversations[0].id).toBe('c-crlf');
    expect(result.envelope.conversations[0].messages).toHaveLength(2);
    expect(JSON.stringify(result.envelope)).not.toContain('\\r');
  });

  test('two pages sharing a conversation id warn and both are emitted', async () => {
    // envelope-v0 says ids should be unique and that consumers must tolerate
    // duplicates. Dropping one to keep the field clean would lose a
    // conversation, so both ship and the collision is reported.
    const page = (title: string) =>
      gbrainPage(
        ['type: conversation', `title: ${title}`, 'source: chatgpt', 'memvelope_conversation_id: c-repeat'].join('\n'),
        TURNS,
      );
    const result = await exportPages({ 'a.md': page('First'), 'b.md': page('Second') });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope);
    expect(result.envelope.conversations).toHaveLength(2);
    expect(result.stderr).toContain('already used by another page');
  });

  test('pages naming different providers warn and keep the first', async () => {
    // An envelope carries one source_provider. A page set spanning two is a
    // real structural loss, so it is reported instead of resolved silently.
    const page = (id: string, source: string) =>
      gbrainPage(
        ['type: conversation', `title: ${id}`, `source: ${source}`, `memvelope_conversation_id: ${id}`].join('\n'),
        TURNS,
      );
    const result = await exportPages({
      'a.md': page('c-a', 'chatgpt'),
      'b.md': page('c-b', 'claude'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.meta.source_provider).toBe('chatgpt');
    expect(result.stderr).toContain('source providers');
    expect(result.envelope.conversations).toHaveLength(2);
  });

  test('a missing directory argument or unreadable path exits 1', async () => {
    const noArgs = await run(EXPORTER_PATH, []);
    expect(noArgs.exitCode).toBe(1);
    expect(noArgs.stderr).toContain('usage:');

    const missing = await run(EXPORTER_PATH, [join(tempDir(), 'nope'), join(tempDir(), 'out.json')]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('cannot read');

    const notADir = join(tempDir(), 'file.md');
    writeFileSync(notADir, 'x\n');
    const file = await run(EXPORTER_PATH, [notADir, join(tempDir(), 'out.json')]);
    expect(file.exitCode).toBe(1);
    expect(file.stderr).toContain('not a directory');
  });
});
