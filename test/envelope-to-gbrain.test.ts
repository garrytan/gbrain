/**
 * Pins the Memvelope envelope importer contract: deterministic markdown output,
 * provenance frontmatter, citation-bearing bodies, and loud collision handling.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The same parser gbrain uses to ingest frontmatter (src/core/markdown.ts), so
// the injection test asserts against the real consumer rather than a substring.
import { safeLoad as yamlSafeLoad } from 'js-yaml';
// F5 asserts against gbrain's REAL consumers, not against a copy of their
// regexes: `parseConversation` is what decides whether an imported page yields
// any conversation-facts at all, and `parseMarkdown`/`serializeMarkdown` are
// what every sync and rewrite of the page runs through.
import { parseConversation } from '../src/core/conversation-parser/parse.ts';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';

const SCRIPT_PATH = join(import.meta.dir, '..', 'scripts', 'envelope-to-gbrain.mjs');
const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'memvelope', 'sample.mve.json');
const TEMP_DIRS: string[] = [];

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-to-gbrain-'));
  TEMP_DIRS.push(dir);
  return dir;
}

async function runImporter(envelopePath: string, outDir = tempDir()) {
  // The script is plain Node-compatible ESM; Bun can execute it directly in CI
  // without requiring a separate node toolchain.
  const proc = Bun.spawn([process.execPath, SCRIPT_PATH, envelopePath, outDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: proc.exitCode, stdout, stderr, outDir };
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
}

function readOnlyMarkdown(dir: string): string {
  const files = markdownFiles(dir);
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]), 'utf8');
}

/**
 * The frontmatter block, delimited the way gray-matter delimits it: the opening
 * `---` line and the next line that is EXACTLY `---`.
 *
 * `page.split('---')[1]` is not equivalent — it splits on the substring
 * anywhere, including inside a quoted value, so a message id containing `---`
 * silently truncates the block and the assertion passes for the wrong reason.
 */
function frontmatterBlock(page: string): string {
  const lines = page.split('\n');
  expect(lines[0]).toBe('---');
  const end = lines.indexOf('---', 1);
  expect(end).toBeGreaterThan(0);
  return lines.slice(1, end).join('\n');
}

function frontmatterOf(page: string): Record<string, unknown> {
  return (yamlSafeLoad(frontmatterBlock(page)) ?? {}) as Record<string, unknown>;
}

function bodyOf(page: string): string {
  const lines = page.split('\n');
  return lines.slice(lines.indexOf('---', 1) + 1).join('\n');
}

/**
 * F5's one way to get it wrong. An UNQUOTED RFC 3339 scalar is read by js-yaml
 * as a JS `Date`: microseconds truncate, a `+05:30` offset is normalised away,
 * the lexical form changes — and gbrain's own `coerceFrontmatterString`
 * (src/core/markdown.ts) slices a Date to its first 10 chars, so the entire
 * time of day is gone. It is also sticky: a Date re-serializes unquoted, so
 * every later round trip keeps it a Date.
 *
 * Both halves are asserted. The lexical half catches the emitter; the
 * structural half catches the consumer actually seeing a string.
 */
function assertEveryTimestampQuoted(page: string): void {
  const tsLines = frontmatterBlock(page)
    .split('\n')
    .filter((line) => /^\s*ts:/.test(line));
  expect(tsLines.length).toBeGreaterThan(0);
  for (const line of tsLines) {
    const value = line.slice(line.indexOf('ts:') + 'ts:'.length).trim();
    // A quoted scalar, or the bare YAML null that a `ts: null` message gets.
    const quoted = value === 'null' || value.startsWith('"');
    // Compared as a string so a failure names the offending line.
    expect(`${line.trim()} => quoted:${quoted}`).toBe(`${line.trim()} => quoted:true`);
  }
  const messages = frontmatterOf(page).messages as Array<Record<string, unknown>>;
  expect(Array.isArray(messages)).toBe(true);
  for (const m of messages) {
    expect(m.ts instanceof Date).toBe(false);
    expect(m.ts === null || typeof m.ts === 'string').toBe(true);
  }
}

/** Round-trip a page through the two functions every gbrain rewrite uses. */
function roundTrip(page: string): { first: string; second: string; parsed: ReturnType<typeof parseMarkdown> } {
  const p1 = parseMarkdown(page, 'brain/conversations/page.md');
  const first = serializeMarkdown(p1.frontmatter, p1.compiled_truth, p1.timeline, {
    type: p1.type,
    title: p1.title,
    tags: p1.tags,
  });
  const p2 = parseMarkdown(first, 'brain/conversations/page.md');
  const second = serializeMarkdown(p2.frontmatter, p2.compiled_truth, p2.timeline, {
    type: p2.type,
    title: p2.title,
    tags: p2.tags,
  });
  return { first, second, parsed: p2 };
}

/** Write an envelope to a temp file and return its path. */
function writeEnvelope(envelope: unknown): string {
  const path = join(tempDir(), 'envelope.mve.json');
  writeFileSync(path, JSON.stringify(envelope));
  return path;
}

/** A one-conversation envelope with the given messages. */
function envelopeWith(
  messages: Array<Record<string, unknown>>,
  conversation: Record<string, unknown> = {},
): unknown {
  return {
    memvelope: 'envelope-v0',
    meta: { source_provider: 'chatgpt', conversation_count: 1, message_count: messages.length },
    conversations: [
      {
        id: 'c-f5',
        title: 'F5 fixture',
        created_at: '2025-11-02T14:22:51.000Z',
        updated_at: '2025-11-02T14:31:12.000Z',
        messages,
        ...conversation,
      },
    ],
  };
}

describe('envelope-to-gbrain importer', () => {
  test('sample envelope writes exactly one markdown page and reports count', async () => {
    const result = await runImporter(FIXTURE_PATH);

    expect(result.exitCode).toBe(0);
    expect(markdownFiles(result.outDir)).toHaveLength(1);
    expect(result.stdout).toContain('wrote 1 markdown page(s)');
  });

  test('filename is keyed by conversation id with date prefix', async () => {
    const result = await runImporter(FIXTURE_PATH);

    expect(result.exitCode).toBe(0);
    expect(markdownFiles(result.outDir)).toEqual(['2025-11-02-c-3f9a2b.md']);
  });

  test('frontmatter carries conversation provenance fields', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    expect(page).toContain('type: conversation');
    expect(page).toContain('title: "Onboarding Checklist Draft"');
    expect(page).toContain('date: "2025-11-02"');
    expect(page).toContain('source: "chatgpt"');
    expect(page).toContain('memvelope_conversation_id: "c-3f9a2b"');
    expect(page).toContain('origin: memvelope/envelope-v0');
  });

  // F5: message identity moved OUT of the body and into frontmatter, because
  // no parser-legible turn header can carry it (see the `messages:` array tests
  // below). The body keeps role labels; the ids are still pinned, at their new
  // address. Same claim, stronger assertion — structural, not a substring.
  test('body carries role labels, and message ids are recoverable from frontmatter', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    expect(page).toContain('**Me**');
    expect(page).toContain('**Assistant**');
    expect(frontmatterOf(page).messages).toEqual([
      { id: 'm1', ts: '2025-11-02T14:22:51.000Z' },
      { id: 'm2', ts: '2025-11-02T14:24:03.000Z' },
      { id: 'm3', ts: '2025-11-02T14:28:19.000Z' },
      { id: 'm4', ts: '2025-11-02T14:31:12.000Z' },
    ]);
  });

  test('output is deterministic across repeated runs', async () => {
    const first = await runImporter(FIXTURE_PATH);
    const second = await runImporter(FIXTURE_PATH);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(readOnlyMarkdown(first.outDir)).toBe(readOnlyMarkdown(second.outDir));
  });

  test('duplicate conversation ids warn and report distinct files written', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'duplicate.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          id: 'c-repeat',
          title: 'First repeated id',
          created_at: '2025-11-02T14:22:51.000Z',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example noted the first checklist draft.' }],
        },
        {
          id: 'c-repeat',
          title: 'Second repeated id',
          created_at: '2025-11-02T15:22:51.000Z',
          messages: [{ id: 'm2', role: 'assistant', ts: '2025-11-02T15:22:51.000Z', text: 'Assistant noted the repeated id collision.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('warning: filename collision on "2025-11-02-c-repeat.md"');
    expect(result.stdout).toContain('wrote 1 markdown page(s)');
    expect(markdownFiles(result.outDir)).toHaveLength(1);
  });

  test('missing or foreign format is rejected', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'not-envelope.json');
    writeFileSync(envelopePath, JSON.stringify({ conversations: [] }));

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('envelope-v0');
  });

  test('missing conversation id uses positional fallback filename', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'missing-id.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          title: 'Missing id example',
          created_at: '2025-11-02T14:22:51.000Z',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example asked for a fallback filename.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(0);
    expect(markdownFiles(result.outDir)).toEqual(['2025-11-02-conv-1.md']);
  });

  test('missing conversation id omits the provenance key rather than emitting a value', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'missing-id-frontmatter.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          title: 'Missing id example',
          created_at: '2025-11-02T14:22:51.000Z',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example asked about frontmatter.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    // Absent means absent: never the literal string `undefined`, and never the
    // positional filename fallback masquerading as a real conversation id.
    expect(page).not.toContain('memvelope_conversation_id');
    expect(page).not.toContain('undefined');
    expect(page).toContain('source: "chatgpt"');
  });

  test('a provider string carrying a newline cannot inject frontmatter keys', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'injecting-provider.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt\ntype: injected\nowner: attacker' },
      conversations: [
        {
          id: 'c-inject',
          title: 'Injection attempt',
          created_at: '2025-11-02T14:22:51.000Z',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example sent a hostile provider string.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);
    const frontmatter = page.split('---')[1] ?? '';
    const parsed = yamlSafeLoad(frontmatter) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    // The newline is escaped inside a quoted scalar, so the hostile text stays
    // one value instead of becoming keys. Asserted structurally: a substring
    // check cannot tell a real key from the same characters inside a quoted
    // value, and would pass for the wrong reason.
    expect(Object.keys(parsed).sort()).toEqual([
      'date',
      'memvelope_conversation_id',
      // F5: message identity lives here now. Still an EXACT set, so a new key
      // an attacker injects still fails the assertion.
      'messages',
      'origin',
      'source',
      'title',
      'type',
    ]);
    expect(parsed.type).toBe('conversation');
    expect(parsed.source).toBe('chatgpt\ntype: injected\nowner: attacker');
  });

  // `source` was hardened while `date` — derived from the same third-party
  // envelope, in the line directly above it — was left unquoted. Both halves of
  // the injection surface are pinned now so a future edit can't reopen one.
  test.each([
    ['injects a new key', '1\nowner: z'],
    ['duplicates an existing key', 'x\ntype: a'],
  ])('a created_at that %s cannot alter the frontmatter', async (_label, createdAt) => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'injecting-created-at.mve.json');
    // `date` is created_at.slice(0, 10) — 10 chars is plenty for a newline plus
    // a short key. The duplicate-key case is the nastier of the two: it makes
    // the YAML parse throw, so the page loses every provenance field silently.
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          id: 'c-date',
          title: 'Date injection attempt',
          created_at: createdAt,
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example sent a hostile created_at.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);
    const frontmatter = page.split('---')[1] ?? '';
    const parsed = yamlSafeLoad(frontmatter) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(Object.keys(parsed).sort()).toEqual([
      'date',
      'memvelope_conversation_id',
      // F5: message identity lives here now. Still an EXACT set, so a new key
      // an attacker injects still fails the assertion.
      'messages',
      'origin',
      'source',
      'title',
      'type',
    ]);
    // Still the real values — proves the parse succeeded rather than the
    // frontmatter having been reduced to the injected subset.
    expect(parsed.type).toBe('conversation');
    expect(parsed.date).toBe(createdAt.slice(0, 10));
  });

  // `created_at` also prefixes the FILENAME, and `join(outDir, name)` resolves
  // `../` — so hardening only the frontmatter left the same untrusted value
  // able to write outside the output directory entirely.
  test('a created_at containing path separators cannot write outside outDir', async () => {
    const inputDir = tempDir();
    const parent = tempDir();
    const outDir = join(parent, 'outdir');
    const sibling = join(parent, 'victim');
    mkdirSync(outDir);
    mkdirSync(sibling); // must exist, or the escape fails on ENOENT for the wrong reason

    const envelopePath = join(inputDir, 'traversing-created-at.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          id: 'c-trav',
          title: 'Traversal attempt',
          created_at: '../victim/p',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example sent a traversing created_at.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath, outDir);

    expect(result.exitCode).toBe(0);
    expect(readdirSync(sibling)).toEqual([]);
    expect(markdownFiles(outDir)).toHaveLength(1);
    // Separators are slugged away rather than the write being rejected, so the
    // conversation is still imported — just inside outDir where it belongs.
    expect(markdownFiles(outDir)[0]).not.toContain('/');
  });
});

// Every envelope below is written through this builder so a test says only what
// it is actually about. `meta` is spread last: a test that pins declared counts
// overrides them explicitly, and one that doesn't gets a self-consistent
// envelope rather than an accidental mismatch.
function writeEnvelope(fields: {
  meta?: Record<string, unknown>;
  conversations: Array<Record<string, unknown>>;
  fileName?: string;
}): string {
  const inputDir = tempDir();
  const envelopePath = join(inputDir, fields.fileName ?? 'envelope.mve.json');
  const conversations = fields.conversations;
  const messageTotal = conversations.reduce(
    (sum, c) => sum + ((c.messages as unknown[] | undefined)?.length ?? 0),
    0,
  );
  writeFileSync(envelopePath, JSON.stringify({
    memvelope: 'envelope-v0',
    meta: {
      source_provider: 'chatgpt',
      conversation_count: conversations.length,
      message_count: messageTotal,
      ...(fields.meta ?? {}),
    },
    conversations,
  }));
  return envelopePath;
}

function message(id: string, text: string, role: 'user' | 'assistant' = 'user') {
  return { id, role, ts: '2025-11-02T14:22:51.000Z', text };
}

function conversation(fields: Record<string, unknown> = {}) {
  return {
    title: 'Fixture conversation',
    created_at: '2025-11-02T14:22:51.000Z',
    updated_at: '2025-11-02T14:31:12.000Z',
    messages: [message('m1', 'alice-example wrote the fixture body.')],
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// F1. envelope-v0 makes `meta.conversation_count` and `meta.message_count`
// mandatory — the envelope carries its own integrity check — and the importer
// read neither. A file declaring 353 conversations and 9412 messages that
// actually held one of each imported one, exited 0, and wrote zero stderr
// bytes. The receipt counted only pages, never messages, so message-level loss
// was invisible by construction rather than by accident.
// ---------------------------------------------------------------------------
describe('envelope-to-gbrain importer — declared-count integrity (F1)', () => {
  test('a truncated envelope is refused before anything is written', async () => {
    // The reproduction verbatim: the envelope says 353/9412 and carries 1/1.
    const envelopePath = writeEnvelope({
      meta: { conversation_count: 353, message_count: 9412 },
      conversations: [conversation({ id: 'c-truncated' })],
    });

    const result = await runImporter(envelopePath);

    expect(result.exitCode).not.toBe(0);
    // Refusal happens before the first write, so a rejected envelope leaves no
    // partial import behind to be mistaken for a whole one.
    expect(markdownFiles(result.outDir)).toEqual([]);
    // Both declared numbers and both actual numbers, so the operator can see
    // which half is wrong without re-deriving anything by hand.
    expect(result.stderr).toContain('353');
    expect(result.stderr).toContain('9412');
    expect(result.stderr).toContain('conversation_count');
    expect(result.stderr).toContain('message_count');
  });

  test('a message_count mismatch alone is caught even when conversation_count agrees', async () => {
    // The sharper half of F1: the script never counted messages at all, so an
    // envelope that loses turns but keeps every conversation passed silently.
    const envelopePath = writeEnvelope({
      meta: { message_count: 9412 },
      conversations: [conversation({ id: 'c-msg-loss' })],
    });

    const result = await runImporter(envelopePath);

    expect(result.exitCode).not.toBe(0);
    expect(markdownFiles(result.outDir)).toEqual([]);
    expect(result.stderr).toContain('message_count');
  });

  // From the adversarial pass. Duplicate ids are CONFORMING input — the spec is
  // explicit that merging never deduplicates — and converting an old export
  // together with a newer one is what the memvelope CLI tells users to do. The
  // first wording of this warning announced "N message(s) in the envelope are
  // not on disk" on exactly that flow, while every unique turn WAS on disk. A
  // data-loss alarm that fires on the mainstream path trains its reader to
  // ignore the one that matters.
  test('the message-delta warning ties itself to the overwritten pages rather than claiming loss', async () => {
    const envelopePath = writeEnvelope({
      conversations: [
        conversation({ id: 'c-same', messages: [message('m1', 'TURN_ONE')] }),
        conversation({
          id: 'c-same',
          messages: [message('m1', 'TURN_ONE'), message('m2', 'TURN_TWO', 'assistant')],
        }),
      ],
    });

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('overwritten page(s) carried');
    // The raw tally still has to be there — hiding it is what made every
    // message-level loss invisible in the first place.
    expect(result.stderr).toContain('3 read, 2 written');
    expect(result.stderr).toContain('may already contain');
    // The surviving page is the superset, so nothing unique is actually gone.
    const page = readFileSync(join(result.outDir, markdownFiles(result.outDir)[0]), 'utf8');
    expect(page).toContain('TURN_ONE');
    expect(page).toContain('TURN_TWO');
  });

  test('the stdout receipt reports messages as well as pages', async () => {
    const envelopePath = writeEnvelope({
      conversations: [
        conversation({
          id: 'c-receipt',
          messages: [
            message('m1', 'alice-example asked the first question.'),
            message('m2', 'The assistant answered.', 'assistant'),
            message('m3', 'alice-example followed up.'),
          ],
        }),
      ],
    });

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('wrote 1 markdown page(s)');
    expect(result.stdout).toContain('3 message(s)');
  });

  test('CONTROL: an envelope whose counts agree imports clean and warns nothing', async () => {
    const envelopePath = writeEnvelope({
      conversations: [
        conversation({ id: 'c-a', messages: [message('m1', 'alice-example spoke once.')] }),
        conversation({ id: 'c-b', messages: [message('m1', 'bob-example spoke once.'), message('m2', 'And again.', 'assistant')] }),
      ],
    });

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(0);
    expect(markdownFiles(result.outDir)).toHaveLength(2);
    // A guard that cries wolf on valid producer output is worse than the bug it
    // replaces, so the clean path must stay byte-silent on stderr.
    expect(result.stderr).toBe('');
  });

  test('CONTROL: an envelope carrying no counts still imports, and says the check was skipped', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'no-counts.mve.json');
    // Not a conforming envelope-v0 file — both count fields are required — but
    // refusing it outright would break every hand-authored envelope, so it
    // imports. It must not, however, pass in silence: an unchecked import that
    // looks identical to a checked one is the whole defect restated.
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [conversation({ id: 'c-nocounts' })],
    }));

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(0);
    expect(markdownFiles(result.outDir)).toHaveLength(1);
    expect(result.stderr).toContain('integrity check skipped');
  });

  // Found by the silent-loss sweep, attacking the guard above rather than the
  // original script: a HALF-declared envelope got a half check and total
  // silence. `hasDeclaredCounts` was true as soon as either field existed, so
  // an envelope declaring only `conversation_count` had its messages validated
  // against nothing and still exited 0 with zero stderr bytes — F1 restated in
  // a narrower window, introduced by F1's own fix.
  test.each([
    ['message_count', { source_provider: 'chatgpt', conversation_count: 1 }],
    ['conversation_count', { source_provider: 'chatgpt', message_count: 1 }],
  ])('an envelope that omits only %s says so, rather than passing in silence', async (absent, meta) => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'half-declared.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta,
      conversations: [conversation({ id: 'c-half' })],
    }));

    const result = await runImporter(envelopePath);

    // Nothing to compare the absent half against, so refusing would be wrong —
    // but a half-checked import must not look like a fully checked one.
    expect(result.exitCode).toBe(0);
    expect(markdownFiles(result.outDir)).toHaveLength(1);
    expect(result.stderr).toContain('integrity check skipped');
    expect(result.stderr).toContain(absent);
  });

  // The same sweep: a count that is PRESENT but not an integer took the
  // "absent" branch, so the importer printed "declares neither count" about an
  // envelope that declares both — a false statement covering a real truncation.
  test.each([
    ['strings', '353', '9412'],
    ['nulls', null, null],
    ['negative', -1, -1],
    ['fractional', 1.5, 1.5],
  ])('counts declared as %s are refused rather than treated as absent', async (_label, conversationCount, messageCount) => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'malformed-counts.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: {
        source_provider: 'chatgpt',
        conversation_count: conversationCount,
        message_count: messageCount,
      },
      conversations: [conversation({ id: 'c-malformed' })],
    }));

    const result = await runImporter(envelopePath);

    expect(result.exitCode).not.toBe(0);
    expect(markdownFiles(result.outDir)).toEqual([]);
    expect(result.stderr).toContain('conversation_count');
  });
});

// ---------------------------------------------------------------------------
// F2. `filesWritten` is per-process and the default outDir is a fixed literal,
// so a second import into the same directory clobbered the first with no
// read-back and no warning. The trigger is the positional fallback `conv-N`,
// which fires whenever `c.id` is not a non-empty string — and the spec is
// explicit that `id` is `string | null` and that a converter MUST NOT
// synthesize one, so null is the CONFORMING shape. Filenames then become a
// function of array position rather than identity.
// ---------------------------------------------------------------------------
describe('envelope-to-gbrain importer — cross-run overwrite (F2)', () => {
  test('a second null-id import cannot destroy the first', async () => {
    const outDir = tempDir();
    const first = writeEnvelope({
      fileName: 'first.mve.json',
      conversations: [conversation({ id: null, title: 'Export one', messages: [message('m1', 'SECRET_FROM_EXPORT_ONE')] })],
    });
    const second = writeEnvelope({
      fileName: 'second.mve.json',
      conversations: [conversation({ id: null, title: 'Export two', messages: [message('m1', 'SECRET_FROM_EXPORT_TWO')] })],
    });

    const a = await runImporter(first, outDir);
    expect(a.exitCode).toBe(0);
    expect(markdownFiles(outDir)).toEqual(['2025-11-02-conv-1.md']);

    const b = await runImporter(second, outDir);

    // Refuse: with null ids there is no identity to reconcile, so the importer
    // cannot tell "this conversation, updated" from "a different conversation
    // that happens to sit at index 0". It must not guess, and it must not
    // destroy. The remedy — a different outDir — is cheap and lossless.
    expect(b.exitCode).not.toBe(0);
    expect(b.stderr).toContain('2025-11-02-conv-1.md');
    const surviving = readFileSync(join(outDir, '2025-11-02-conv-1.md'), 'utf8');
    expect(surviving).toContain('SECRET_FROM_EXPORT_ONE');
    expect(surviving).not.toContain('SECRET_FROM_EXPORT_TWO');
  });

  test('a foreign file already holding the target name is never overwritten', async () => {
    const outDir = tempDir();
    writeFileSync(join(outDir, '2025-11-02-c-foreign.md'), 'HAND_WRITTEN_BY_THE_USER\n');
    const envelopePath = writeEnvelope({
      conversations: [conversation({ id: 'c-foreign', messages: [message('m1', 'IMPORTED_TEXT')] })],
    });

    const result = await runImporter(envelopePath, outDir);

    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(outDir, '2025-11-02-c-foreign.md'), 'utf8')).toBe('HAND_WRITTEN_BY_THE_USER\n');
  });

  test('CONTROL: re-importing the identical envelope is silent and lossless', async () => {
    // The commonest re-run of all. It must stay exit 0 and stay quiet, or the
    // guard makes ordinary use painful.
    const outDir = tempDir();
    const envelopePath = writeEnvelope({
      conversations: [conversation({ id: 'c-idem', messages: [message('m1', 'IDEMPOTENT_BODY')] })],
    });

    const a = await runImporter(envelopePath, outDir);
    const b = await runImporter(envelopePath, outDir);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(b.stderr).toBe('');
    expect(markdownFiles(outDir)).toHaveLength(1);
    expect(readFileSync(join(outDir, markdownFiles(outDir)[0]), 'utf8')).toContain('IDEMPOTENT_BODY');
  });

  test('CONTROL: a refreshed export updates its own page in place', async () => {
    // The other ordinary case named in the field: re-export after the
    // conversation grew. Same real id, more messages. A guard that refused this
    // would be refusing the whole point of re-importing.
    const outDir = tempDir();
    const before = writeEnvelope({
      fileName: 'before.mve.json',
      conversations: [conversation({ id: 'c-grow', messages: [message('m1', 'FIRST_TURN')] })],
    });
    const after = writeEnvelope({
      fileName: 'after.mve.json',
      conversations: [conversation({
        id: 'c-grow',
        messages: [message('m1', 'FIRST_TURN'), message('m2', 'SECOND_TURN', 'assistant')],
      })],
    });

    expect((await runImporter(before, outDir)).exitCode).toBe(0);
    const result = await runImporter(after, outDir);

    expect(result.exitCode).toBe(0);
    expect(markdownFiles(outDir)).toHaveLength(1);
    const page = readFileSync(join(outDir, markdownFiles(outDir)[0]), 'utf8');
    expect(page).toContain('FIRST_TURN');
    expect(page).toContain('SECOND_TURN');
  });

  test('CONTROL: unrelated markdown already in the directory is not a conflict', async () => {
    const outDir = tempDir();
    writeFileSync(join(outDir, 'my-own-note.md'), 'UNRELATED_NOTE\n');
    const envelopePath = writeEnvelope({
      conversations: [conversation({ id: 'c-neighbour', messages: [message('m1', 'IMPORTED_NEIGHBOUR')] })],
    });

    const result = await runImporter(envelopePath, outDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(outDir, 'my-own-note.md'), 'utf8')).toBe('UNRELATED_NOTE\n');
    expect(markdownFiles(outDir)).toContain('2025-11-02-c-neighbour.md');
  });

  // Found by the adversarial pass. The filename slugs `c.id.trim()`, and the
  // first version of this guard compared the TRIMMED id too — so two ids
  // differing only by surrounding whitespace looked like one conversation to
  // both halves, and the second import destroyed the first at exit 0 with zero
  // stderr bytes. The spec has ids copied verbatim, so the whitespace is part
  // of the id; identity is now compared raw.
  test('ids differing only by surrounding whitespace are not the same conversation', async () => {
    const outDir = tempDir();
    const first = writeEnvelope({
      fileName: 'untrimmed-a.mve.json',
      conversations: [conversation({ id: 'c-ws', messages: [message('m1', 'WHITESPACE_ORIGINAL')] })],
    });
    const second = writeEnvelope({
      fileName: 'untrimmed-b.mve.json',
      conversations: [conversation({ id: 'c-ws ', messages: [message('m1', 'WHITESPACE_IMPOSTOR')] })],
    });

    expect((await runImporter(first, outDir)).exitCode).toBe(0);
    const result = await runImporter(second, outDir);

    expect(result.exitCode).not.toBe(0);
    const surviving = readFileSync(join(outDir, '2025-11-02-c-ws.md'), 'utf8');
    expect(surviving).toContain('WHITESPACE_ORIGINAL');
    expect(surviving).not.toContain('WHITESPACE_IMPOSTOR');
  });

  // Also from the adversarial pass, and the nastier half: the identity scan
  // required the file to start with exactly `---\n`, so a page THIS IMPORTER
  // WROTE that later picked up CRLF line endings (a git autocrlf checkout, a
  // cross-platform sync, an editor save) or a UTF-8 BOM was reclassified as
  // foreign — and one such page refused the WHOLE envelope. Under the previous
  // script that was a harmless overwrite, so this guard had turned a cosmetic
  // byte change into an unrecoverable block.
  test.each([
    ['CRLF line endings', (b: string) => b.replace(/\n/g, '\r\n')],
    ['a UTF-8 BOM', (b: string) => `﻿${b}`],
    ['a trailing newline', (b: string) => `${b}\n`],
  ])('our own page still recognized after it picks up %s', async (_label, mutate) => {
    const outDir = tempDir();
    const before = writeEnvelope({
      fileName: 'mutated-before.mve.json',
      conversations: [conversation({ id: 'c-mut', messages: [message('m1', 'MUTATED_FIRST')] })],
    });
    const after = writeEnvelope({
      fileName: 'mutated-after.mve.json',
      conversations: [conversation({
        id: 'c-mut',
        messages: [message('m1', 'MUTATED_FIRST'), message('m2', 'MUTATED_SECOND', 'assistant')],
      })],
    });

    expect((await runImporter(before, outDir)).exitCode).toBe(0);
    const page = join(outDir, '2025-11-02-c-mut.md');
    writeFileSync(page, mutate(readFileSync(page, 'utf8')));

    const result = await runImporter(after, outDir);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(page, 'utf8')).toContain('MUTATED_SECOND');
  });

  test('an unrecognizable target file is described without asserting who wrote it', async () => {
    const outDir = tempDir();
    writeFileSync(join(outDir, '2025-11-02-c-unknown.md'), 'SOMETHING_ELSE_ENTIRELY\n');
    const envelopePath = writeEnvelope({
      conversations: [conversation({ id: 'c-unknown', messages: [message('m1', 'IMPORTED')] })],
    });

    const result = await runImporter(envelopePath, outDir);

    expect(result.exitCode).not.toBe(0);
    // The importer cannot know who wrote a file it does not recognize, and
    // saying otherwise put a false statement in front of the operator.
    expect(result.stderr).not.toContain('was not written by this importer');
    expect(result.stderr).toContain('could not be recognized');
  });

  test('CONTROL: a fresh output directory is unaffected by an earlier import', async () => {
    const first = writeEnvelope({
      fileName: 'first.mve.json',
      conversations: [conversation({ id: null, messages: [message('m1', 'SECRET_FROM_EXPORT_ONE')] })],
    });
    const second = writeEnvelope({
      fileName: 'second.mve.json',
      conversations: [conversation({ id: null, messages: [message('m1', 'SECRET_FROM_EXPORT_TWO')] })],
    });

    const a = await runImporter(first);
    const b = await runImporter(second);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(b.stderr).toBe('');
    expect(readFileSync(join(a.outDir, '2025-11-02-conv-1.md'), 'utf8')).toContain('SECRET_FROM_EXPORT_ONE');
    expect(readFileSync(join(b.outDir, '2025-11-02-conv-1.md'), 'utf8')).toContain('SECRET_FROM_EXPORT_TWO');
  });
});

// ---------------------------------------------------------------------------
// F5 — the pages this importer writes must be readable by gbrain's OWN
// conversation parser.
//
// Before F5 every page set `type: conversation` (which opens the gate to
// conversation-facts extraction, chronicle eligibility and format coverage)
// and then presented a turn header matching none of the built-in patterns. The
// extractor hit `messages.length === 0` and incremented `pages_skipped` in
// silence: pages stored and searchable, no facts ever extracted.
//
// Every test below runs the REAL `parseConversation` — not a copy of its
// regex — because a regex copy is exactly the thing that drifted.
// ---------------------------------------------------------------------------
describe('envelope-to-gbrain importer — F5 parser-legible format', () => {
  /** Parse an emitted page the way `extract-conversation-facts` parses it. */
  function parsePage(page: string) {
    const parsed = parseMarkdown(page, 'brain/conversations/page.md');
    return parseConversation(parsed.compiled_truth, {
      page: { frontmatter: parsed.frontmatter } as never,
    });
  }

  test('the emitted body parses as imessage-slack with every turn intact', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const page = readOnlyMarkdown(result.outDir);

    const parsed = parsePage(page);
    expect(result.exitCode).toBe(0);
    expect(parsed.phase).toBe('regex_match');
    expect(parsed.matched_pattern_id).toBe('imessage-slack');
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages.map((m) => m.speaker)).toEqual([
      'Me',
      'Assistant',
      'Me',
      'Assistant',
    ]);
    // Reconstructed to the minute, from the header alone.
    expect(parsed.messages.map((m) => m.timestamp)).toEqual([
      '2025-11-02T14:22:00Z',
      '2025-11-02T14:24:00Z',
      '2025-11-02T14:28:00Z',
      '2025-11-02T14:31:00Z',
    ]);
  });

  test('every message text survives the round trip through the parser verbatim', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const envelope = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const parsed = parsePage(readOnlyMarkdown(result.outDir));

    expect(parsed.messages.map((m) => m.text)).toEqual(
      envelope.conversations[0].messages.map((m: { text: string }) => m.text),
    );
  });

  // SENTINEL. Without this the test above proves nothing: it would pass just as
  // happily if the format had never changed and some other pattern happened to
  // match. This pins the defect F5 exists to close — and it is built from the
  // pre-F5 shape verbatim, so it fails the day someone reverts the header.
  test('SENTINEL: the pre-F5 header shape parses to zero messages', () => {
    const preF5 = [
      '# Onboarding Checklist Draft',
      '',
      '**Me** (2025-11-02T14:22:51.000Z · m1):',
      '',
      'first turn',
      '',
      '---',
      '',
      '**Assistant** (2025-11-02T14:24:03.000Z · m2):',
      '',
      'second turn',
      '',
    ].join('\n');

    const parsed = parseConversation(preF5, {
      page: { frontmatter: { date: '2025-11-02' } } as never,
    });
    expect(parsed.phase).toBe('no_match');
    expect(parsed.messages).toHaveLength(0);
  });

  // Dropping the message id from the old header is NOT the fix — the ISO `T`
  // alone is enough to miss every pattern. Pins why identity had to move to
  // frontmatter rather than simply being deleted.
  test('SENTINEL: dropping the id from the old header still parses to zero messages', () => {
    const parsed = parseConversation(
      '**Me** (2025-11-02T14:22:51.000Z):\n\nfirst turn\n',
      { page: { frontmatter: { date: '2025-11-02' } } as never },
    );
    expect(parsed.phase).toBe('no_match');
    expect(parsed.messages).toHaveLength(0);
  });

  test('the body carries no per-turn message id any more', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const body = bodyOf(readOnlyMarkdown(result.outDir));

    expect(body).not.toContain('· m1');
    expect(body).not.toContain('· m4');
    expect(body).toContain('**Me** (2025-11-02 14:22):');
    expect(body).toContain('**Assistant** (2025-11-02 14:31):');
  });

  test('the frontmatter array survives parseMarkdown -> serializeMarkdown', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const page = readOnlyMarkdown(result.outDir);
    const expected = [
      { id: 'm1', ts: '2025-11-02T14:22:51.000Z' },
      { id: 'm2', ts: '2025-11-02T14:24:03.000Z' },
      { id: 'm3', ts: '2025-11-02T14:28:19.000Z' },
      { id: 'm4', ts: '2025-11-02T14:31:12.000Z' },
    ];

    const { first, second, parsed } = roundTrip(page);
    // Order preserved, values byte-identical, and a fixpoint — a page rewritten
    // twice does not keep drifting.
    expect(parsed.frontmatter.messages).toEqual(expected);
    expect(first).toBe(second);
    // And the re-serialized page is still parseable as a conversation, which is
    // the property that actually matters after a rewrite.
    const reparsed = parsePage(first);
    expect(reparsed.matched_pattern_id).toBe('imessage-slack');
    expect(reparsed.messages).toHaveLength(4);
  });

  test('no timestamp is ever emitted unquoted', async () => {
    const result = await runImporter(FIXTURE_PATH);
    assertEveryTimestampQuoted(readOnlyMarkdown(result.outDir));
  });

  // SENTINEL for the guard above. A guard that has never been shown to fire is
  // not a guard. This is the exact page the importer would write if the quoting
  // were dropped, and gbrain's own parser is what proves the damage.
  test('SENTINEL: the unquoted-timestamp guard fires, and names the damage', () => {
    const unquoted = [
      '---',
      'type: conversation',
      'title: "F5 fixture"',
      'messages:',
      '  - id: "m1"',
      '    ts: 2025-11-02T14:22:51.123456Z',
      '  - id: "m2"',
      '    ts: 2025-11-02T14:22:51+05:30',
      '---',
      '',
      '# F5 fixture',
      '',
      '**Me** (2025-11-02 14:22):',
      '',
      'hello',
      '',
    ].join('\n');

    expect(() => assertEveryTimestampQuoted(unquoted)).toThrow();

    // What the guard is protecting against, measured rather than asserted.
    const messages = frontmatterOf(unquoted).messages as Array<{ ts: unknown }>;
    expect(messages[0].ts).toBeInstanceOf(Date);
    // Microseconds truncated to milliseconds.
    expect((messages[0].ts as Date).toISOString()).toBe('2025-11-02T14:22:51.123Z');
    // Offset normalised away — a different wall clock than the export recorded.
    expect((messages[1].ts as Date).toISOString()).toBe('2025-11-02T08:52:51.000Z');
  });

  test('hostile message ids cannot inject frontmatter keys or break the page', async () => {
    // Every value here has broken a hand-rolled YAML emitter somewhere.
    const hostile = [
      'a\nb',
      '---\ntype: person\n---',
      'a: b',
      '-danger',
      '*anchor',
      '&anchor',
      'trailing ',
      'a\tb',
      'say "hi"',
      "it's",
      '\u{1f642}id',
      'null',
      'yes',
      '0123',
      '',
      'title: injected',
      'x\ninjected: true',
      // YAML 1.1 counts U+2028, U+2029 and U+0085 as line breaks, and
      // JSON.stringify passes all three through RAW rather than escaping them.
      // If js-yaml honored that, each would close the quoted scalar and inject a
      // key — the exact failure the quoting exists to prevent.
      'x\u2028injected: true',
      'x\u2029injected: true',
      'x\u0085injected: true',
    ];
    const envelopePath = writeEnvelope(
      envelopeWith(
        hostile.map((id, i) => ({
          id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          ts: `2025-11-02T14:${String(i).padStart(2, '0')}:51.000Z`,
          text: `turn ${i + 1}`,
        })),
      ),
    );

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);
    const frontmatter = frontmatterOf(page);

    expect(result.exitCode).toBe(0);
    // Exact key set: not one injected key, and not one provenance key lost to a
    // duplicate-key parse failure.
    expect(Object.keys(frontmatter).sort()).toEqual([
      'date',
      'memvelope_conversation_id',
      'messages',
      'origin',
      'source',
      'title',
      'type',
    ]);
    // Every id back verbatim, in order — including the empty one.
    expect((frontmatter.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(hostile);
    // And the page is still a readable conversation.
    const parsed = parsePage(page);
    expect(parsed.matched_pattern_id).toBe('imessage-slack');
    expect(parsed.messages).toHaveLength(hostile.length);
    // Survives a rewrite too.
    const { first, second, parsed: reparsed } = roundTrip(page);
    expect(first).toBe(second);
    expect((reparsed.frontmatter.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(hostile);
  });

  test('a message with ts null records null, and still anchors its own turn', async () => {
    const envelopePath = writeEnvelope(
      envelopeWith([
        { id: 'm1', role: 'user', ts: null, text: 'no timestamp on this turn' },
        { id: 'm2', role: 'assistant', ts: '2025-11-02T14:31:12.000Z', text: 'this one has one' },
      ]),
    );

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    // `ts: null` is envelope-v0 conforming ("or null if absent"), so the page
    // records null rather than inventing a time.
    expect(frontmatterOf(page).messages).toEqual([
      { id: 'm1', ts: null },
      { id: 'm2', ts: '2025-11-02T14:31:12.000Z' },
    ]);
    assertEveryTimestampQuoted(page);
    // The body still has to anchor the turn or it merges into its neighbour and
    // two speakers become one message. It falls back to the conversation's own
    // date at midnight — the same convention parse.ts uses for no-time formats.
    expect(bodyOf(page)).toContain('**Me** (2025-11-02 00:00):');
    const parsed = parsePage(page);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map((m) => m.speaker)).toEqual(['Me', 'Assistant']);
    expect(parsed.messages[0].text).toBe('no timestamp on this turn');
  });

  test('no ts and no created_at falls back to the parser\'s own epoch date', async () => {
    const envelopePath = writeEnvelope(
      envelopeWith(
        [
          { id: 'm1', role: 'user', ts: null, text: 'dateless one' },
          { id: 'm2', role: 'assistant', ts: null, text: 'dateless two' },
        ],
        { created_at: null },
      ),
    );

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    // 1970-01-01 is what deriveDateContext() picks when a page has no date at
    // all, so the header introduces no value gbrain would not have chosen.
    expect(bodyOf(page)).toContain('**Me** (1970-01-01 00:00):');
    expect(frontmatterOf(page).date).toBeNull();
    const parsed = parsePage(page);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].timestamp).toBe('1970-01-01T00:00:00Z');
  });

  test('an offset-bearing timestamp is normalised to UTC in the header, verbatim in frontmatter', async () => {
    const envelopePath = writeEnvelope(
      envelopeWith([
        { id: 'm1', role: 'user', ts: '2025-11-02T14:22:51+05:30', text: 'offset turn' },
        { id: 'm2', role: 'assistant', ts: '2025-11-02T14:22:51.123456Z', text: 'microsecond turn' },
      ]),
    );

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    // imessage-slack declares timezone_policy 'inline_utc': the parser reads the
    // inline clock AS UTC. Writing the un-normalised local clock would record a
    // time 5.5 hours off. Header normalised; frontmatter keeps the original.
    expect(bodyOf(page)).toContain('**Me** (2025-11-02 08:52):');
    expect(frontmatterOf(page).messages).toEqual([
      { id: 'm1', ts: '2025-11-02T14:22:51+05:30' },
      { id: 'm2', ts: '2025-11-02T14:22:51.123456Z' },
    ]);
    assertEveryTimestampQuoted(page);
    const parsed = parsePage(page);
    expect(parsed.messages[0].timestamp).toBe('2025-11-02T08:52:00Z');
    expect(parsed.messages[1].timestamp).toBe('2025-11-02T14:22:00Z');
  });

  test('a single-message conversation still parses', async () => {
    const envelopePath = writeEnvelope(
      envelopeWith([
        { id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'the only turn' },
      ]),
    );

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    expect(frontmatterOf(page).messages).toEqual([
      { id: 'm1', ts: '2025-11-02T14:22:51.000Z' },
    ]);
    const parsed = parsePage(page);
    expect(parsed.matched_pattern_id).toBe('imessage-slack');
    expect(parsed.messages).toHaveLength(1);
  });

  test('a conversation with no messages emits an explicit empty array', async () => {
    const envelopePath = writeEnvelope(envelopeWith([]));

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    // Explicit `[]`, not an omitted key: omission cannot be told apart from a
    // page written before F5, and a consumer reading identity back needs to
    // know the difference.
    expect(frontmatterOf(page).messages).toEqual([]);
    const { first, second } = roundTrip(page);
    expect(first).toBe(second);
  });

  test('a long conversation title does not disturb the array', async () => {
    const title = ('A conversation about the quarterly diligence process and its many attendant complications ').repeat(3).trim();
    const envelopePath = writeEnvelope(
      envelopeWith(
        [
          { id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'first' },
          { id: 'm2', role: 'assistant', ts: '2025-11-02T14:23:51.000Z', text: 'second' },
        ],
        { title },
      ),
    );

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    expect(frontmatterOf(page).title).toBe(title);
    expect(frontmatterOf(page).messages).toEqual([
      { id: 'm1', ts: '2025-11-02T14:22:51.000Z' },
      { id: 'm2', ts: '2025-11-02T14:23:51.000Z' },
    ]);
    // serializeMarkdown folds a long title onto continuation lines (`title: >-`).
    // The array must survive that unchanged, and the page must stay a fixpoint.
    const { first, second, parsed } = roundTrip(page);
    expect(first).toContain('title: >-');
    expect(parsed.frontmatter.messages).toEqual([
      { id: 'm1', ts: '2025-11-02T14:22:51.000Z' },
      { id: 'm2', ts: '2025-11-02T14:23:51.000Z' },
    ]);
    expect(first).toBe(second);
  });

  test('frontmatter message ids and timestamps mirror the envelope exactly', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const envelope = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const frontmatter = frontmatterOf(readOnlyMarkdown(result.outDir));

    expect(frontmatter.messages).toEqual(
      envelope.conversations[0].messages.map((m: { id: string; ts: string }) => ({
        id: m.id,
        ts: m.ts,
      })),
    );
  });
});

// ---------------------------------------------------------------------------
// F5 — the offset branch of the header clock, pinned separately. It is the only
// place in this script that does arithmetic on a timestamp, so it is the only
// place an hour can come out wrong.
// ---------------------------------------------------------------------------
describe('envelope-to-gbrain importer — F5 header clock arithmetic', () => {
  /** Import a one-message envelope with the given `ts` and return its header. */
  async function headerFor(ts: unknown): Promise<string> {
    const envelopePath = join(tempDir(), 'clock.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt', conversation_count: 1, message_count: 1 },
      conversations: [{
        id: 'c-clock',
        title: 'Clock',
        created_at: '2025-11-02T00:00:00.000Z',
        updated_at: '2025-11-02T00:00:00.000Z',
        messages: [{ id: 'm1', role: 'user', ts, text: 'turn' }],
      }],
    }));
    const result = await runImporter(envelopePath);
    expect(result.exitCode).toBe(0);
    const line = bodyOf(readOnlyMarkdown(result.outDir))
      .split('\n')
      .find((l) => l.startsWith('**Me**'));
    return line ?? '';
  }

  test.each([
    // A Z or designator-less timestamp is copied across digit for digit — no
    // arithmetic at all, which is the point of choosing a 24-hour clock.
    ['2025-11-02T14:22:51.000Z', '2025-11-02 14:22'],
    ['2025-11-02T14:22:51Z', '2025-11-02 14:22'],
    ['2025-11-02T14:22:51.123456Z', '2025-11-02 14:22'],
    ['2025-11-02T00:00:00Z', '2025-11-02 00:00'],
    ['2025-11-02T23:59:00Z', '2025-11-02 23:59'],
    ['2025-11-02 14:22:51', '2025-11-02 14:22'],
    // Offsets shift to UTC, because imessage-slack reads the inline clock AS
    // UTC. Including the two that cross a day boundary in each direction.
    ['2025-11-02T14:22:51+05:30', '2025-11-02 08:52'],
    ['2025-11-02T14:22:51-05:00', '2025-11-02 19:22'],
    ['2025-11-02T14:22:51+0530', '2025-11-02 08:52'],
    ['2025-11-02T00:30:00+05:30', '2025-11-01 19:00'],
    ['2025-11-02T23:30:00-05:00', '2025-11-03 04:30'],
    ['2025-11-02T14:22:51+00:00', '2025-11-02 14:22'],
    // A four-digit year below 100. `Date.UTC` would read this as 1949 —
    // MakeFullYear maps 0..99 onto 1900+y — and quietly move the page by 1900
    // years. Reachable: the shape regex accepts any four digits.
    ['0050-01-01T00:30:00+05:30', '0049-12-31 19:00'],
    ['0050-01-01T00:30:00Z', '0050-01-01 00:30'],
  ])('ts %s renders header clock %s', async (ts, expected) => {
    expect(await headerFor(ts)).toBe(`**Me** (${expected}):`);
  });

  test.each([
    ['null', null],
    ['absent', undefined],
    ['not a timestamp', 'yesterday afternoon'],
    ['date only', '2025-11-02'],
    ['a number', 1762093371000],
    ['an object', { iso: '2025-11-02T14:22:51.000Z' }],
  ])('an unusable ts (%s) falls back to the conversation date at midnight', async (_label, ts) => {
    // Never a fabricated clock and never a dropped turn: the conversation's own
    // date, at 00:00, which is the convention parse.ts uses for no-time formats.
    expect(await headerFor(ts)).toBe('**Me** (2025-11-02 00:00):');
  });
});

// ---------------------------------------------------------------------------
// F5 — the H1 heading is the one place a third-party string reaches the BODY.
// Every frontmatter value is JSON-escaped; the heading was interpolated raw.
// Since F5 made the body parseable, a newline in the title no longer just looks
// wrong — it manufactures a turn AHEAD of every real one, so `messages[0]` in
// frontmatter names content the user never sent and every id after it is off by
// one. That is the positional contract this format rests on.
// ---------------------------------------------------------------------------
describe('envelope-to-gbrain importer — F5 heading cannot manufacture a turn', () => {
  async function pageFor(title: unknown) {
    const envelopePath = writeEnvelope(
      envelopeWith(
        [
          { id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'first turn text' },
          { id: 'm2', role: 'assistant', ts: '2025-11-02T14:24:03.000Z', text: 'second turn text' },
        ],
        { title },
      ),
    );
    const result = await runImporter(envelopePath);
    expect(result.exitCode).toBe(0);
    const page = readOnlyMarkdown(result.outDir);
    const md = parseMarkdown(page, 'brain/conversations/page.md');
    return {
      page,
      md,
      parsed: parseConversation(md.compiled_truth, { page: { frontmatter: md.frontmatter } as never }),
    };
  }

  test.each([
    ['a header-shaped line', 'Real Title\n\n**Me** (2020-01-01 09:00): INJECTED FROM TITLE'],
    ['a telegram-shaped line', 'Real Title\n\n**[09:00] Attacker:** injected'],
    ['a bare newline', 'Real Title\nsecond line'],
    ['a carriage return', 'Real Title\r\nsecond line'],
  ])('a title containing %s adds no turn', async (_label, title) => {
    const { md, parsed } = await pageFor(title);

    // The heading stays ONE line, so it can anchor nothing.
    const headings = md.compiled_truth.split('\n').filter((l) => l.startsWith('# '));
    expect(headings).toHaveLength(1);
    // Exactly the real turns, in order, with the real timestamps.
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map((m) => m.timestamp)).toEqual([
      '2025-11-02T14:22:00Z',
      '2025-11-02T14:24:00Z',
    ]);
    expect(parsed.messages.map((m) => m.text)).toEqual(['first turn text', 'second turn text']);
    // The positional contract: frontmatter[i] is body turn i.
    expect((md.frontmatter.messages as unknown[]).length).toBe(parsed.messages.length);
    // The title itself is still recorded in full, newline and all.
    expect(frontmatterOf(await pageFor(title).then((r) => r.page)).title).toBe(title);
  });

  test('an empty title gets one fallback, not two different ones', async () => {
    const { page, md } = await pageFor('');

    // Frontmatter said "Untitled conversation" while the heading said
    // "Conversation" — the same absent title under two names.
    expect(frontmatterOf(page).title).toBe('Untitled conversation');
    expect(md.compiled_truth.split('\n')[0]).toBe('# Untitled conversation');
  });
});

// ---------------------------------------------------------------------------
// F5 — behavior on NON-CONFORMING input, pinned so the header's claims stay
// true. envelope-v0 types `ts` as `string | null` and `id` as a required
// string; JSON quotes strings, so anything else comes out unquoted. That is
// lossless and carries no `Date` hazard, but "every value is quoted" would be a
// false claim, and a false claim in a file header is worse than a limitation.
// ---------------------------------------------------------------------------
describe('envelope-to-gbrain importer — F5 non-conforming scalars', () => {
  async function frontmatterFor(message: Record<string, unknown>) {
    const envelopePath = writeEnvelope(
      envelopeWith([
        { id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'conforming turn' },
        message,
      ]),
    );
    const result = await runImporter(envelopePath);
    expect(result.exitCode).toBe(0);
    const page = readOnlyMarkdown(result.outDir);
    return { page, frontmatter: frontmatterOf(page), md: parseMarkdown(page, 'brain/conversations/p.md') };
  }

  test('a numeric ts is emitted as a YAML integer — unquoted, but never a Date', async () => {
    const { page, md } = await frontmatterFor({ id: 'm2', role: 'assistant', ts: 1762093371000, text: 'b' });

    expect(page).toContain('    ts: 1762093371000');
    const messages = md.frontmatter.messages as Array<{ ts: unknown }>;
    expect(typeof messages[1].ts).toBe('number');
    // The property that actually matters: no Date, so nothing is truncated and
    // nothing is sticky.
    expect(messages[1].ts).not.toBeInstanceOf(Date);
    // And the conforming sibling is still quoted.
    expect(page).toContain('    ts: "2025-11-02T14:22:51.000Z"');
  });

  test('a missing message id is emitted as null, and the page still parses', async () => {
    const { page, md } = await frontmatterFor({ role: 'assistant', ts: '2025-11-02T14:24:03.000Z', text: 'b' });

    expect(page).toContain('  - id: null');
    expect((md.frontmatter.messages as Array<{ id: unknown }>)[1].id).toBeNull();
    const parsed = parseConversation(md.compiled_truth, {
      page: { frontmatter: md.frontmatter } as never,
    });
    expect(parsed.messages).toHaveLength(2);
  });

  test('a hostile non-string ts cannot break the frontmatter', async () => {
    const { page, frontmatter } = await frontmatterFor({
      id: 'm2',
      role: 'assistant',
      ts: { evil: '\n---\ntype: injected\n---\n' },
      text: 'b',
    });

    // Emitted as JSON flow, which is valid YAML and stays one physical line.
    expect(Object.keys(frontmatter).sort()).toEqual([
      'date',
      'memvelope_conversation_id',
      'messages',
      'origin',
      'source',
      'title',
      'type',
    ]);
    // Asserted structurally, never by substring: the hostile text IS on the
    // page, `\n`-escaped inside a one-line JSON flow scalar, and a
    // `not.toContain` would be checking the wrong thing — it cannot tell a real
    // key from the same characters inside a value.
    expect(frontmatter.type).toBe('conversation');
    expect(Object.keys(frontmatter)).not.toContain('injected');
    // One physical line, which is why it cannot close the scalar.
    const tsLines = frontmatterBlock(page).split('\n').filter((l) => /^\s*ts:/.test(l));
    expect(tsLines).toHaveLength(2);
    expect(tsLines[1].trim()).toBe('ts: {"evil":"\\n---\\ntype: injected\\n---\\n"}');
  });

  test('a gbrain rewrite keeps the values and changes only the quoting style', async () => {
    const envelopePath = writeEnvelope(
      envelopeWith([{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'a' }]),
    );
    const result = await runImporter(envelopePath);
    const { first, parsed } = roundTrip(readOnlyMarkdown(result.outDir));

    // Pinned because the header states it, and because the importer's own
    // conflict check reads this block by scanning lines rather than parsing it.
    expect(first).toContain('  - id: m1');
    expect(first).toContain("    ts: '2025-11-02T14:22:51.000Z'");
    expect(parsed.frontmatter.messages).toEqual([{ id: 'm1', ts: '2025-11-02T14:22:51.000Z' }]);
  });
});
