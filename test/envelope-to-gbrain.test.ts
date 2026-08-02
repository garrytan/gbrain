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

  test('body carries role labels and message-id citations', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    expect(page).toContain('· m1');
    expect(page).toContain('· m4');
    expect(page).toContain('**Me**');
    expect(page).toContain('**Assistant**');
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
