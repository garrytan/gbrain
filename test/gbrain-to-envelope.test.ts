/**
 * Pins the envelope-v0 exporter contract: conforming output, honest handling of
 * the fields a gbrain page cannot carry, deterministic ordering, and loud
 * skipping. The mirror of test/envelope-to-gbrain.test.ts - the corpus is built
 * by running the importer on its own fixture, so the round trip is the test.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMPORTER_PATH = join(import.meta.dir, '..', 'scripts', 'envelope-to-gbrain.mjs');
const EXPORTER_PATH = join(import.meta.dir, '..', 'scripts', 'gbrain-to-envelope.mjs');
const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'memvelope', 'sample.mve.json');
/**
 * envelope-v0 as published, vendored byte-for-byte. Fetched 2026-08-02 from
 * memvelope.com/schema/envelope-v0.schema.json and checked identical, by sha256,
 * to raw.githubusercontent.com/memvelope/memvelope/main/public/schema/envelope-v0.schema.json
 * and to the copy in the memvelope package - all three
 * 423813d563de394cde2798848e90fdadc85ba52458f5c18b1da897e6c8ae52b9. The checker
 * below reads these bytes, so a constraint is enforced because the schema states
 * it and not because someone transcribed it.
 */
const SCHEMA_PATH = join(import.meta.dir, 'fixtures', 'memvelope', 'envelope-v0.schema.json');
const SCHEMA_BYTES = readFileSync(SCHEMA_PATH);
const SCHEMA_SHA256 = '423813d563de394cde2798848e90fdadc85ba52458f5c18b1da897e6c8ae52b9';
const ENVELOPE_V0_SCHEMA = JSON.parse(SCHEMA_BYTES.toString('utf8')) as Record<string, unknown>;
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
    pagesDir,
    outPath,
    // A multi-provider directory writes per-provider files instead of outPath;
    // those tests read their own files, so a missing outPath is null here.
    envelope: result.exitCode === 0 && existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null,
  };
}

/**
 * The draft-07 keywords the checker below implements, split into the ones that
 * constrain a document and the ones that only annotate it. Anything else in the
 * vendored schema is a constraint this checker would silently ignore, so
 * `assertSchemaFullyImplemented` fails on it rather than letting it through -
 * which is the whole point of validating against the bytes instead of a
 * transcription.
 */
const ANNOTATION_KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'examples', 'default']);
const CONSTRAINT_KEYWORDS = new Set([
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'minLength', 'minimum', 'anyOf', 'format',
]);
const IMPLEMENTED_FORMATS = new Set(['date', 'date-time']);

/** Recursively asserts the vendored schema states nothing the checker cannot enforce. */
function assertSchemaFullyImplemented(schema: unknown, path = '#'): void {
  expect(schema).toBeObject();
  const node = schema as Record<string, unknown>;
  for (const key of Object.keys(node)) {
    if (ANNOTATION_KEYWORDS.has(key) || CONSTRAINT_KEYWORDS.has(key)) continue;
    throw new Error(`${SCHEMA_PATH} states \`${key}\` at ${path}, which this checker does not implement`);
  }
  if (typeof node.format === 'string' && !IMPLEMENTED_FORMATS.has(node.format)) {
    throw new Error(`${SCHEMA_PATH} names format \`${node.format}\` at ${path}, which this checker does not implement`);
  }
  // `additionalProperties: true` is the only form here; a subschema there would
  // need walking too, so anything else is refused.
  if ('additionalProperties' in node && node.additionalProperties !== true) {
    throw new Error(`${SCHEMA_PATH} sets a non-\`true\` additionalProperties at ${path}, which this checker does not implement`);
  }
  if (node.properties) {
    for (const [name, sub] of Object.entries(node.properties as Record<string, unknown>)) {
      assertSchemaFullyImplemented(sub, `${path}/properties/${name}`);
    }
  }
  if (node.items) assertSchemaFullyImplemented(node.items, `${path}/items`);
  if (node.anyOf) {
    for (const [i, sub] of (node.anyOf as unknown[]).entries()) {
      assertSchemaFullyImplemented(sub, `${path}/anyOf/${i}`);
    }
  }
}

function jsonTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: throw new Error(`unsupported JSON Schema type \`${type}\``);
  }
}

/** Collects every way `value` violates `schema`, as human-readable paths. */
function schemaErrors(schema: Record<string, unknown>, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => jsonTypeMatches(t, value))) {
      errors.push(`${path}: expected type ${types.join('|')}`);
      return;
    }
  }
  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof schema.format === 'string' && typeof value === 'string') {
    const ok = schema.format === 'date' ? isRfc3339Date(value) : isRfc3339DateTime(value);
    if (!ok) errors.push(`${path}: ${JSON.stringify(value)} is not a ${schema.format}`);
  }
  if (typeof schema.minLength === 'number' && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path}: below minimum ${schema.minimum}`);
  }
  if (schema.anyOf) {
    const branches = schema.anyOf as Array<Record<string, unknown>>;
    if (!branches.some((sub) => {
      const local: string[] = [];
      schemaErrors(sub, value, path, local);
      return local.length === 0;
    })) {
      errors.push(`${path}: matched none of the anyOf branches`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      for (const [i, item] of value.entries()) {
        schemaErrors(schema.items as Record<string, unknown>, item, `${path}[${i}]`, errors);
      }
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required \`${key}\``);
    }
    for (const [name, sub] of Object.entries((schema.properties as Record<string, unknown> | undefined) ?? {})) {
      // Absent optional properties are the `source_export_date` case: omitted,
      // not null, is what the spec asks for, so absence is never an error here.
      if (name in obj) schemaErrors(sub as Record<string, unknown>, obj[name], `${path}/${name}`, errors);
    }
  }
}

/**
 * Structural conformance against envelope-v0 as published, by validating the
 * document against the vendored schema bytes rather than against a list of
 * constraints someone read off it. The walker above implements the draft-07
 * subset the schema uses and refuses to run against any keyword it does not,
 * so a constraint added upstream turns this suite red instead of going
 * unchecked. Zero dependencies, matching the scripts' own posture.
 *
 * Nothing is asserted about extra keys, because envelope-v0 sets
 * `additionalProperties: true` at every level.
 *
 * `expected` carries what the caller knows about the INPUT, independently of
 * the document in hand. The meta counts are not a schema constraint - the
 * schema only says they are non-negative integers - so they are cross-checked
 * here: against the arrays they were computed from, and, when the caller passes
 * it, against a number from outside the document. Without that second number
 * the count check is self-consistency only, which an envelope that quietly lost
 * half its turns satisfies perfectly.
 */
function assertEnvelopeV0(
  doc: unknown,
  expected?: { conversations: number; messages: number },
): void {
  const errors: string[] = [];
  schemaErrors(ENVELOPE_V0_SCHEMA, doc, 'envelope', errors);
  expect(errors).toEqual([]);

  const env = doc as Record<string, unknown>;
  const meta = env.meta as Record<string, unknown>;
  const conversations = env.conversations as Array<Record<string, unknown>>;
  const totalMessages = conversations.reduce(
    (n, c) => n + (c.messages as unknown[]).length,
    0,
  );
  // The counts are part of the document, so they get checked against it...
  expect(meta.conversation_count).toBe(conversations.length);
  expect(meta.message_count).toBe(totalMessages);
  // ...and, when the caller knows the input, against a number from outside it.
  if (expected) {
    expect(conversations.length).toBe(expected.conversations);
    expect(meta.conversation_count).toBe(expected.conversations);
    expect(totalMessages).toBe(expected.messages);
    expect(meta.message_count).toBe(expected.messages);
  }
}

/**
 * The checker's public shape. assertEnvelopeV0 takes the second argument now,
 * so this alias is a plain rename, kept for readability at the call sites that
 * pass counts the test knows from its own input.
 */
type EnvelopeChecker = (
  doc: unknown,
  expected?: { conversations: number; messages: number },
) => void;
const checkEnvelope: EnvelopeChecker = assertEnvelopeV0;

/**
 * Strict RFC 3339 `date-time`, the profile JSON Schema's `format: date-time`
 * names. Regex for shape, then real calendar and clock bounds - a loose
 * `\d{4}-\d{2}-\d{2}T...` regex would accept 2026-02-30T25:61:00Z.
 *
 * Second 60 is a leap second, and a leap second is inserted at midnight UTC, so
 * the local clock may read anything that names that instant - RFC 3339's own
 * examples include `1990-12-31T15:59:60-08:00`. The offset is normalized away
 * and the UTC time-of-day has to be 23:59. This matches ajv 8.20.0 +
 * ajv-formats 3.0.1 in strict/full mode value for value, including
 * `2026-02-01T09:00:60Z` and `2026-12-31T23:59:60+01:00`, which both fail.
 */
function isRfc3339DateTime(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  // Explicit leap math, not Date.UTC: Date.UTC applies the two-digit-year
  // rule, mapping year 0 to 1900, so 0000-02-29 - a real date in RFC 3339's
  // proleptic Gregorian calendar (year 0 % 400 === 0), accepted by
  // ajv-formats - was falsely rejected. The exporter's own check always had
  // the explicit math; the two now agree on this too.
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = month === 2 && leap ? 29 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) return false;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (hour > 23 || minute > 59 || second > 60) return false;
  let offsetMinutes = 0;
  if (m[8] !== 'Z' && m[8] !== 'z') {
    const offsetHour = Number(m[10]);
    const offsetMinute = Number(m[11]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
    offsetMinutes = (m[9] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  if (second === 60) {
    const utcMinuteOfDay = (((hour * 60 + minute - offsetMinutes) % 1440) + 1440) % 1440;
    if (utcMinuteOfDay !== 23 * 60 + 59) return false;
  }
  return true;
}

/** Strict RFC 3339 full-date, the `format: date` half of meta.source_export_date's anyOf. */
function isRfc3339Date(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return false;
  const day = Number(m[3]);
  // Explicit leap math for the same year-0 reason as isRfc3339DateTime above.
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day >= 1 && day <= (month === 2 && leap ? 29 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]);
}

/** Every timestamp the document emits, labelled by where it came from. */
function timestampsIn(doc: any): Array<{ where: string; value: unknown }> {
  const found: Array<{ where: string; value: unknown }> = [];
  for (const [i, c] of (doc.conversations as any[]).entries()) {
    found.push({ where: `conversations[${i}].created_at`, value: c.created_at });
    found.push({ where: `conversations[${i}].updated_at`, value: c.updated_at });
    for (const [j, m] of (c.messages as any[]).entries()) {
      found.push({ where: `conversations[${i}].messages[${j}].ts`, value: m.ts });
    }
  }
  return found;
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
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 4 });
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
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
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
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 1 });
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
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
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
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 1 });
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
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
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
    assertEnvelopeV0(result.envelope, { conversations: 2, messages: 4 });
    expect(result.envelope.conversations).toHaveLength(2);
    expect(result.stderr).toContain('already used by another page');
  });

  test('pages naming different providers write one envelope per provider', async () => {
    // An envelope carries one source_provider. This script used to collapse a
    // mixed set to the first provider in sorted path order, and re-importing
    // that envelope stamped the winner onto every losing page - check 2 saw a
    // legitimate refresh and overwrote `source:` at exit 0, with nothing on
    // disk retaining the truth. A mixed set now fans out, one conforming
    // envelope per provider, each file named for the provider it carries.
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
    // outPath itself is NOT written: there is no single envelope that could
    // describe this directory without falsifying someone's provider.
    expect(existsSync(result.outPath)).toBe(false);
    const dir = join(result.outPath, '..');
    const cg = JSON.parse(readFileSync(join(dir, 'out.chatgpt.mve.json'), 'utf8'));
    const cl = JSON.parse(readFileSync(join(dir, 'out.claude.mve.json'), 'utf8'));
    assertEnvelopeV0(cg, { conversations: 1, messages: 2 });
    assertEnvelopeV0(cl, { conversations: 1, messages: 2 });
    expect(cg.meta.source_provider).toBe('chatgpt');
    expect(cg.conversations.map((c: any) => c.id)).toEqual(['c-a']);
    expect(cl.meta.source_provider).toBe('claude');
    expect(cl.conversations.map((c: any) => c.id)).toEqual(['c-b']);
    expect(result.stderr).toContain('source providers');
    expect(result.stdout).toContain(`wrote 1 conversation(s), 2 message(s) to ${join(dir, 'out.chatgpt.mve.json')}`);
    expect(result.stdout).toContain(`wrote 1 conversation(s), 2 message(s) to ${join(dir, 'out.claude.mve.json')}`);
  });

  // --- Regression tests for six verified defects. -------------------------
  // Each was reproduced against the script before the fix, and each guards the
  // fixed behavior here.

  test('D1: a message that quotes the timeline sentinel does not destroy the turns after it', async () => {
    // Guards the rule that only a sentinel with no speaker turn after it is a
    // timeline boundary. Cutting at the FIRST literal `<!-- timeline -->`
    // instead, without asking whether that occurrence is gbrain's delimiter or
    // ordinary prose, truncated a conversation ABOUT gbrain's page format -
    // exactly the kind this brain holds - mid-sentence and lost every later
    // turn, at exit 0 with an empty stderr and a meta.message_count that agreed
    // with the reduced array. The loss was invisible from the output alone,
    // which is why the assertion below is on the ids and not on the count.
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Sentinel in prose', 'source: chatgpt', 'memvelope_conversation_id: c-sentinel'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'How does gbrain mark the timeline section inside a page?',
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
          '',
          'It writes the literal comment <!-- timeline --> on its own line, then the entries below it.',
          '',
          '---',
          '',
          '**Me** (2026-02-01T09:10:00.000Z · m3):',
          '',
          'So anything after that marker is timeline rather than prose.',
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:15:00.000Z · m4):',
          '',
          'Right, and a message that merely quotes the marker must not be cut short.',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(1);
    const messages = result.envelope.conversations[0].messages as Array<{ id: string; text: string }>;
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(messages[1].text).toContain('then the entries below it');
    expect(messages[3].text).toContain('must not be cut short');
    expect(result.envelope.meta.message_count).toBe(4);
  });

  test('D2: a turn header quoted inside a fenced block yields no non-conforming timestamp', async () => {
    // Guards the fence mask over TURN_HEADER. With a line-anchored but not
    // block-aware match, a header-shaped line inside a fenced sample split the
    // message in two and the split half's timestamp was lifted straight out of
    // prose, so conforming input produced output that violated
    // `format: date-time`. The fence here opens and closes inside one turn,
    // which is the case where a fence legitimately hides a header - the R1
    // tests below pin the case where it must not.
    const FENCE = '```';
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Quoted transcript', 'source: chatgpt', 'memvelope_conversation_id: c-quoted'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'The export I am pasting has header lines shaped like this:',
          '',
          FENCE,
          '**Assistant** (yesterday afternoon · m-quoted):',
          '',
          'sample data inside a fenced block, not a real turn',
          FENCE,
          '',
          'Can you parse that shape?',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    // The schema violation first: every emitted timestamp is null or a strict
    // RFC 3339 date-time, with no exceptions.
    const nonConforming = timestampsIn(result.envelope).filter(
      (t) => t.value !== null && !isRfc3339DateTime(t.value),
    );
    expect(nonConforming).toEqual([]);
    // And the fenced sample line is sample text, not a second turn.
    expect(result.envelope.conversations[0].messages).toHaveLength(1);
    expect(result.envelope.conversations[0].messages[0].text).toContain('Can you parse that shape?');
  });

  test('D3: a folded frontmatter title and id survive the documented gbrain export path', async () => {
    // Guards block-scalar frontmatter. This is byte-for-byte what gbrain's own
    // serializeMarkdown produces (matter.stringify -> js-yaml at the default
    // lineWidth of 80): any string of 80+ characters becomes a folded block
    // scalar. A parseFrontmatter that dropped `>-` outright turned the title
    // silently into 'Untitled conversation' and an 80+ character id silently
    // into null - on the input path the script header advertises. The
    // untruncated title is also one line below in the body's H1, which gbrain's
    // own parser falls back to (inferTitleFromBody), so both routes are pinned.
    const FOLDED_TITLE =
      'Onboarding checklist for the acme-example widget-co rollout and the fund-a reporting questions';
    const FOLDED_ID =
      'c-3f9a2b-onboarding-checklist-acme-example-widget-co-rollout-fund-a-reporting-question';
    const result = await exportPages({
      'conversations/2026-02-01-folded.md': [
        '---',
        'type: conversation',
        'title: >-',
        '  Onboarding checklist for the acme-example widget-co rollout and the fund-a',
        '  reporting questions',
        "date: '2026-02-01'",
        'source: chatgpt',
        'memvelope_conversation_id: >-',
        `  ${FOLDED_ID}`,
        'origin: memvelope/envelope-v0',
        '---',
        '',
        `# ${FOLDED_TITLE}`,
        '',
        TURNS,
        '',
      ].join('\n'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(1);
    expect(result.envelope.conversations[0].title).toBe(FOLDED_TITLE);
    expect(result.envelope.conversations[0].id).toBe(FOLDED_ID);
  });

  test('D4: the envelope checker rejects every document the published schema rejects', async () => {
    // Guards the checker itself. It once paraphrased the schema and left
    // `format: date-time` and the source_export_date anyOf out entirely, which
    // is how D2 stayed green through seventeen tests; it now walks the vendored
    // schema bytes (see R4). A checker is only worth as much as the documents it
    // refuses, so each constraint the exporter could plausibly break gets a
    // document that breaks it.
    const conforming = () => ({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt', conversation_count: 1, message_count: 1 },
      conversations: [
        {
          id: 'c-1',
          title: 'Conforming',
          created_at: '2026-02-01T09:00:00.000Z',
          updated_at: '2026-02-01T09:00:00.000Z',
          messages: [{ id: 'm1', role: 'user', ts: '2026-02-01T09:00:00.000Z', text: 'hi' }],
        },
      ],
    });
    // Guard against a checker that rejects everything.
    expect(() => assertEnvelopeV0(conforming())).not.toThrow();
    // Sanity on the checkers this test leans on, so a bug there cannot be
    // mistaken for a bug in the exporter.
    expect(isRfc3339DateTime('2026-02-30T09:00:00Z')).toBe(false);
    expect(isRfc3339DateTime('2026-02-01T25:00:00Z')).toBe(false);
    expect(isRfc3339DateTime('2026-02-01')).toBe(false);
    expect(isRfc3339DateTime('2026-02-01T09:00:00+05:30')).toBe(true);
    expect(isRfc3339Date('2026-02-01')).toBe(true);
    expect(isRfc3339Date('2026-13-01')).toBe(false);

    const cases: Array<{ label: string; mutate: (d: any) => void }> = [
      { label: 'conversation.created_at lifted from prose', mutate: (d) => { d.conversations[0].created_at = 'yesterday afternoon'; } },
      { label: 'conversation.created_at is a date, not a date-time', mutate: (d) => { d.conversations[0].created_at = '2026-02-01'; } },
      { label: 'conversation.updated_at lifted from prose', mutate: (d) => { d.conversations[0].updated_at = 'no timestamp'; } },
      { label: 'conversation.updated_at names a day that does not exist', mutate: (d) => { d.conversations[0].updated_at = '2026-02-30T09:00:00.000Z'; } },
      { label: 'message.ts lifted from prose', mutate: (d) => { d.conversations[0].messages[0].ts = 'no timestamp'; } },
      { label: 'meta.source_export_date is neither a date nor a date-time', mutate: (d) => { d.meta.source_export_date = 'sometime last week'; } },
      { label: 'conversations[] item is not an object', mutate: (d) => { d.conversations[0] = 'c-1'; } },
      { label: 'messages[] item is not an object', mutate: (d) => { d.conversations[0].messages[0] = 'm1'; } },
      { label: 'memvelope const is wrong', mutate: (d) => { d.memvelope = 'envelope-v1'; } },
      { label: 'meta is missing', mutate: (d) => { delete d.meta; } },
      { label: 'meta.source_provider is missing', mutate: (d) => { delete d.meta.source_provider; } },
      { label: 'meta.message_count is negative', mutate: (d) => { d.meta.message_count = -1; } },
      { label: 'meta.conversation_count is not an integer', mutate: (d) => { d.meta.conversation_count = 1.5; } },
      { label: 'conversation.id is neither a string nor null', mutate: (d) => { d.conversations[0].id = 7; } },
      { label: 'conversation.title is missing', mutate: (d) => { delete d.conversations[0].title; } },
      { label: 'conversation.messages is empty', mutate: (d) => { d.conversations[0].messages = []; d.meta.message_count = 0; } },
      { label: 'message.role is outside the enum', mutate: (d) => { d.conversations[0].messages[0].role = 'system'; } },
      { label: 'message.ts key is absent rather than null', mutate: (d) => { delete d.conversations[0].messages[0].ts; } },
      { label: 'message.text is empty', mutate: (d) => { d.conversations[0].messages[0].text = ''; } },
      { label: 'message.id is null', mutate: (d) => { d.conversations[0].messages[0].id = null; } },
      { label: 'conversations is not an array', mutate: (d) => { d.conversations = {}; } },
    ];
    const wronglyAccepted = cases
      .filter(({ mutate }) => {
        const doc = conforming();
        mutate(doc);
        try {
          assertEnvelopeV0(doc);
          return true;
        } catch {
          return false;
        }
      })
      .map((c) => c.label);
    expect(wronglyAccepted).toEqual([]);
  });

  test('D5: a page set with no source frontmatter reports the provider token it invents', async () => {
    // meta.source_provider is REQUIRED by the published schema and its
    // description names a registry ("chatgpt", "claude"); 'unknown' is not a
    // registered token. It cannot be omitted, so minting it silently is the
    // wrong trade - the guess has to be reported the way every other lossy edge
    // in this script is.
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: No provider', 'memvelope_conversation_id: c-noprov'].join('\n'),
        TURNS,
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(1);
    expect(result.stderr).toContain('source_provider');
    // Whatever token it settles on, the warning has to name it so the operator
    // can find it in the output.
    expect(result.stderr).toContain(result.envelope.meta.source_provider);
  });

  test('D6: the checker verifies meta counts against independently known numbers', async () => {
    // Guards the count check against collapsing back into a tautology.
    // meta.conversation_count against conversations.length is one object
    // agreeing with itself, and an envelope that lost half its turns satisfies
    // it perfectly - which is how D1 stayed invisible. The counts have to be
    // checked against a number the test knows from its own input as well.
    const result = await roundTrip();
    expect(result.exported.exitCode).toBe(0);

    // The fixture states 1 conversation and 4 messages, and holds 4 messages.
    expect(() => checkEnvelope(result.envelope, { conversations: 1, messages: 4 })).not.toThrow();
    expect(() => checkEnvelope(result.envelope, { conversations: 1, messages: 2 })).toThrow();
    expect(() => checkEnvelope(result.envelope, { conversations: 2, messages: 4 })).toThrow();
  });

  test('R4: the checker runs against the vendored schema bytes, and implements all of them', async () => {
    // The checker used to be a hand transcription of the published schema, with
    // the gap that let D2 through. It now reads
    // test/fixtures/memvelope/envelope-v0.schema.json, which is the published
    // file byte-for-byte: fetched 2026-08-02 from memvelope.com and confirmed
    // identical, by sha256, to the raw.githubusercontent.com copy on
    // memvelope/memvelope@main and to the copy shipped in the memvelope
    // package. Pinning the digest here is what makes "vendored, not
    // transcribed" checkable rather than asserted.
    expect(createHash('sha256').update(SCHEMA_BYTES).digest('hex')).toBe(SCHEMA_SHA256);
    expect(ENVELOPE_V0_SCHEMA.$id).toBe('https://memvelope.com/schema/envelope-v0.schema.json');
    expect(ENVELOPE_V0_SCHEMA.$schema).toBe('http://json-schema.org/draft-07/schema#');

    // And the checker enforces every keyword the file states. A constraint
    // added upstream lands in these bytes and fails here, instead of sitting
    // unchecked until someone notices it needs transcribing.
    expect(() => assertSchemaFullyImplemented(ENVELOPE_V0_SCHEMA)).not.toThrow();
    // The guard is real: a keyword the walker does not implement is refused.
    expect(() => assertSchemaFullyImplemented({ type: 'string', pattern: '^x$' })).toThrow('pattern');
    expect(() => assertSchemaFullyImplemented({ type: 'string', format: 'uri' })).toThrow('uri');
    expect(() =>
      assertSchemaFullyImplemented({ type: 'object', properties: { a: { maxLength: 3 } } }),
    ).toThrow('maxLength');
  });

  // --- Regression tests for the round-3 defects. --------------------------
  // R1 guards the rule that a code fence never reaches past the turn it opened
  // in. The round-2 fence fix masked lines between an opening fence and its
  // close across the WHOLE body, with no notion of turn boundaries, and the
  // header scan then skipped masked lines - so a fence that opened in one turn
  // and closed in a later one hid every turn header in between. Those turns'
  // ids, roles and timestamps were destroyed and their text swallowed into the
  // preceding message, at exit 0, with zero stderr, and with meta.message_count
  // agreeing with the reduced array: nothing in the output showed a message had
  // ever existed. Each case below was measured against the pre-fix script, and
  // the measured pre-fix result is recorded on each so the test cannot be
  // weakened into passing by accident.
  //
  // The trigger was a turn holding an ODD number of fence lines. Balanced
  // nesting was never affected and D2 pins that a fence opening and closing
  // inside one turn still hides a header; these three cases are the odd-count
  // shapes an ordinary conversation produces.

  test('R1: a fence that opens in one turn and closes in a later turn loses no turn', async () => {
    // Pre-fix: 4 turns in, ids ["m1","m4"] out, stderr empty - m2 and m3
    // annihilated and their text swallowed into m1.
    const FENCE = '```';
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Half a paste', 'source: chatgpt', 'memvelope_conversation_id: c-spanning'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'I pasted half a block by mistake:',
          '',
          `${FENCE}js`,
          "const widget = 'acme-example';",
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
          '',
          'The block is still open - nothing closed it.',
          '',
          '---',
          '',
          '**Me** (2026-02-01T09:10:00.000Z · m3):',
          '',
          'Here is the rest of what I meant to paste:',
          '',
          FENCE,
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:15:00.000Z · m4):',
          '',
          'Now the block is balanced again.',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 4 });
    const messages = result.envelope.conversations[0].messages as Array<{ id: string; role: string; ts: string | null; text: string }>;
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The destroyed turns' own timestamps, which vanish with their headers.
    expect(messages[1].ts).toBe('2026-02-01T09:05:00.000Z');
    expect(messages[2].ts).toBe('2026-02-01T09:10:00.000Z');
    // ...and their text belongs to them, not to the turn above.
    expect(messages[1].text).toContain('nothing closed it');
    expect(messages[0].text).not.toContain('nothing closed it');
    expect(messages[0].text).not.toContain('**Assistant**');
    // The fence lost, and the operator is told which one and where, because the
    // script read something as prose that its author may have meant as code.
    expect(result.stderr).toContain('is still open at the turn header');
  });

  test('R1: a fence opened inside a bullet does not swallow the turns after it', async () => {
    // The same annihilation, reached the way a conversation about markdown
    // reaches it: a bullet whose continuation line is a bare fence, indented two
    // spaces, which the fence scanner still treats as a fence (it allows up to
    // three). One fence line in m1, one in m3. Pre-fix: ids ["m1","m4"], stderr
    // empty - nothing between them survived.
    const FENCE = '```';
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Fence in a bullet', 'source: chatgpt', 'memvelope_conversation_id: c-bullet'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'Two things about the page format:',
          '',
          '- a code block starts with a line like',
          `  ${FENCE}`,
          '- and it runs until the same characters appear again',
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
          '',
          'That is right for gbrain pages too.',
          '',
          '---',
          '',
          '**Me** (2026-02-01T09:10:00.000Z · m3):',
          '',
          'So the closing line is also:',
          '',
          '- the same three characters, like',
          `  ${FENCE}`,
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:15:00.000Z · m4):',
          '',
          'Exactly.',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 4 });
    const messages = result.envelope.conversations[0].messages as Array<{ id: string; text: string }>;
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(messages[1].text).toContain('right for gbrain pages too');
    expect(messages[2].text).toContain('the closing line is also');
    expect(messages[0].text).not.toContain('right for gbrain pages too');
    expect(result.stderr).toContain('is still open at the turn header');
  });

  test('R1: a turn asking how to close a fence does not annihilate the reply', async () => {
    // The plainest trigger there is, and one this brain will actually hold: a
    // user asks how to close a triple-backtick block, writing the opening line
    // on its own; the assistant answers by writing the same line. Two turns,
    // one fence line each, and the reply's header sits between them. Pre-fix:
    // ids ["m1","m3"] - the assistant's whole turn gone, at exit 0 with an
    // empty stderr.
    const FENCE = '```';
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Closing a fence', 'source: chatgpt', 'memvelope_conversation_id: c-howto'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'How do I close a block that starts with this line?',
          '',
          FENCE,
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
          '',
          'You end it with the same three characters on their own line:',
          '',
          FENCE,
          '',
          '---',
          '',
          '**Me** (2026-02-01T09:10:00.000Z · m3):',
          '',
          'Thanks, that is clear.',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 3 });
    const messages = result.envelope.conversations[0].messages as Array<{ id: string; role: string; text: string }>;
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    // The only assistant turn in the page. Losing it turns a Q-and-A into a
    // monologue, which no count in the document contradicts.
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(messages[1].text).toContain('on their own line');
    expect(messages[0].text).not.toContain('on their own line');
    expect(result.stderr).toContain('is still open at the turn header');
  });

  test('R2: second 60 is accepted only at 23:59:60 UTC, the one leap second RFC 3339 allows', async () => {
    // Guards the leap-second bound. An unconditional `second > 60` let ANY
    // `:60` timestamp through; RFC 3339 permits second 60 only at the instant a
    // leap second is inserted, midnight UTC, so the offset has to be normalized
    // away before the hour and minute are judged. Measured against ajv 8.20.0 +
    // ajv-formats 3.0.1 in strict/full mode, which is what a consumer
    // validating the published schema runs:
    //   2026-02-01T09:00:60.000Z   -> rejected (UTC 09:00, not 23:59)
    //   2026-12-31T23:59:60Z       -> accepted
    //   2026-12-31T23:59:60+00:00  -> accepted
    //   2026-12-31T23:59:60+01:00  -> rejected (UTC 22:59, not 23:59)
    //   1990-12-31T15:59:60-08:00  -> accepted (UTC 23:59; RFC 3339's own example)
    // A non-conforming value takes the route every other unparseable timestamp
    // takes - null, and a warning - rather than shipping a document that fails
    // validation. A conforming one is kept, offset and all.
    const turn = (ts: string) => `**Me** (${ts} · m1):\n\nA turn stamped ${ts}.`;
    const page = (title: string, id: string, ts: string) =>
      gbrainPage(
        ['type: conversation', `title: ${title}`, 'source: chatgpt', `memvelope_conversation_id: ${id}`].join('\n'),
        turn(ts),
      );
    const result = await exportPages({
      'a-not-leap.md': page('Not a leap second', 'c-notleap', '2026-02-01T09:00:60.000Z'),
      'b-leap-z.md': page('Leap second Z', 'c-leapz', '2026-12-31T23:59:60Z'),
      'c-leap-offset.md': page('Leap second +00:00', 'c-leapoffset', '2026-12-31T23:59:60+00:00'),
      'd-leap-nonutc.md': page('Second 60 at +01:00', 'c-nonutc', '2026-12-31T23:59:60+01:00'),
      'e-leap-pacific.md': page('Leap second at -08:00', 'c-pacific', '1990-12-31T15:59:60-08:00'),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 5, messages: 5 });
    const byId = Object.fromEntries(
      (result.envelope.conversations as Array<{ id: string; created_at: string | null; messages: Array<{ ts: string | null }> }>)
        .map((c) => [c.id, c]),
    );

    // Rejected: emitted as null, and said out loud, exactly as a turn header
    // carrying prose where a timestamp goes already is.
    expect(byId['c-notleap'].messages[0].ts).toBeNull();
    expect(byId['c-notleap'].created_at).toBeNull();
    expect(byId['c-nonutc'].messages[0].ts).toBeNull();
    expect(result.stderr).toContain('2026-02-01T09:00:60.000Z');
    expect(result.stderr).toContain('2026-12-31T23:59:60+01:00');
    expect(result.stderr).toContain('not an RFC 3339 date-time');

    // Accepted: a genuine leap second is a valid date-time and must not be
    // thrown away by a fix that simply bans `:60`.
    expect(byId['c-leapz'].messages[0].ts).toBe('2026-12-31T23:59:60Z');
    expect(byId['c-leapoffset'].messages[0].ts).toBe('2026-12-31T23:59:60+00:00');
    // The same instant on a Pacific clock. Banning `:60` outside hour 23 would
    // throw this away, and it is RFC 3339's own worked example.
    expect(byId['c-pacific'].messages[0].ts).toBe('1990-12-31T15:59:60-08:00');

    // Nothing non-conforming reached the document by any route.
    const nonConforming = timestampsIn(result.envelope).filter(
      (t) => t.value !== null && !isRfc3339DateTime(t.value),
    );
    expect(nonConforming).toEqual([]);

    // The checker carried the same unconditional `> 60` bound, so it would have
    // waved the bad document through and the assertion above would have proved
    // nothing. D4 claims this checker rejects everything the published schema
    // rejects; that claim covers this too.
    expect(isRfc3339DateTime('2026-02-01T09:00:60.000Z')).toBe(false);
    expect(isRfc3339DateTime('2026-12-31T23:59:60+01:00')).toBe(false);
    expect(isRfc3339DateTime('2026-12-31T23:59:60Z')).toBe(true);
    expect(isRfc3339DateTime('2026-12-31T23:59:60+00:00')).toBe(true);
    // Every value the ajv probe covered, so the two implementations agree on
    // the whole boundary and not only on the four the exporter emitted above.
    expect(isRfc3339DateTime('1990-12-31T15:59:60-08:00')).toBe(true);
    expect(isRfc3339DateTime('2026-12-31T00:29:60+00:30')).toBe(true);
    expect(isRfc3339DateTime('2026-01-01T05:29:60+05:30')).toBe(true);
    expect(isRfc3339DateTime('2026-06-30T23:59:60Z')).toBe(true);
    expect(isRfc3339DateTime('2026-12-31T23:58:60Z')).toBe(false);
    expect(isRfc3339DateTime('2026-12-31T22:59:60Z')).toBe(false);
    expect(isRfc3339DateTime('2026-12-31T23:59:60+05:30')).toBe(false);
  });

  // --- Red-first regression tests for J, C and D2 on the frontmatter-identity
  // format. Each was run against the exporter as of the importer-f5 merge
  // (ccaed050) and FAILED there - the old exporter reads identity out of
  // `**Me** (<ts> · <id>):` headers, a shape the new importer no longer writes -
  // so each pins that the rebuild actually closed its defect rather than
  // documenting it as non-survival.
  //
  // J, C and D2 all existed because identity lived in prose, where message text
  // could break or forge it. Identity now lives in the frontmatter `messages:`
  // array, which measured hostile-id probing (17 values, including an embedded
  // newline and a whole `---`/`type:`/`---` block) shows message content cannot
  // reach.

  /** Writes an envelope to a temp file and round-trips it through the real
   *  in-tree importer, then the exporter - the actual producer, not a
   *  hand-transcription of its output. */
  async function roundTripEnvelope(envelope: unknown) {
    const envelopePath = join(tempDir(), 'probe.mve.json');
    writeFileSync(envelopePath, JSON.stringify(envelope, null, 2) + '\n');
    return roundTrip(envelopePath);
  }

  test('J: hostile message ids - embedded newline included - survive the round trip verbatim', async () => {
    // Pre-rebuild: an id containing a newline broke the header line the old
    // importer wrote it into, the header no longer matched, and the turn was
    // silently absorbed into the previous one - the last silent loss reachable
    // from a well-formed envelope. Ids now ride in frontmatter as JSON-quoted
    // scalars, so no id value can break the line that carries it.
    const HOSTILE_IDS = [
      'm\n1',
      '---\ntype: hacked\n---',
      'a: b',
      '- leading dash',
      'id with trailing space ',
      'mid · dot',
      '"quoted" \\ and emoji \u{1F680}',
    ];
    const messages = HOSTILE_IDS.map((id, i) => ({
      id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      ts: `2026-02-01T09:0${i}:1${i}.000Z`,
      text: `turn ${i + 1} text`,
    }));
    const result = await roundTripEnvelope({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt', conversation_count: 1, message_count: messages.length },
      conversations: [
        {
          id: 'c-hostile-ids',
          title: 'Hostile ids',
          created_at: '2026-02-01T09:00:10.000Z',
          updated_at: '2026-02-01T09:06:16.000Z',
          messages,
        },
      ],
    });

    expect(result.imported.exitCode).toBe(0);
    expect(result.exported.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: messages.length });
    const out = result.envelope.conversations[0].messages as Array<{ id: string; ts: string; text: string }>;
    // Verbatim, every one - not trimmed, not truncated at the newline, not
    // reassigned to a neighbouring turn.
    expect(out.map((m) => m.id)).toEqual(HOSTILE_IDS);
    expect(out.map((m) => m.text)).toEqual(messages.map((m) => m.text));
    expect(out.map((m) => m.ts)).toEqual(messages.map((m) => m.ts));
  });

  test('C: a turn header mangled with one trailing space still anchors its turn', async () => {
    // Pre-rebuild: the old header regex was `$`-anchored with no trailing-space
    // tolerance, so one space added by an editor or a sync absorbed the whole
    // turn into its neighbour, silently. gbrain's own `imessage-slack` pattern
    // (src/core/conversation-parser/builtins.ts) tolerates trailing whitespace
    // after the colon, so the exporter now does too - and if a header is
    // mangled past recognition entirely, the frontmatter count no longer
    // matches the body and the page is refused loudly instead of joined wrong.
    const result = await exportPages({
      'a.md': [
        '---',
        'type: conversation',
        'title: "Trailing space"',
        'date: "2026-02-01"',
        'source: "chatgpt"',
        'memvelope_conversation_id: "c-trailing"',
        'origin: memvelope/envelope-v0',
        'messages:',
        '  - id: "m1"',
        '    ts: "2026-02-01T09:00:00.000Z"',
        '  - id: "m2"',
        '    ts: "2026-02-01T09:05:00.000Z"',
        '---',
        '# Trailing space',
        '',
        '**Me** (2026-02-01 09:00):',
        '',
        'first turn',
        '',
        '**Assistant** (2026-02-01 09:05): ', // <- the one trailing space
        '',
        'second turn',
        '',
      ].join('\n'),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    const out = result.envelope.conversations[0].messages as Array<{ id: string; role: string; text: string }>;
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[1].text).toBe('second turn');
    expect(out[0].text).not.toContain('second turn');
  });

  test('D2: a header-shaped line in unfenced prose no longer splits the message', async () => {
    // Pre-rebuild: any line shaped like a turn header split the message in two
    // and the second half's identity was lifted straight out of prose. A
    // boundary now has to carry the clock derived from the NEXT frontmatter
    // `ts` - a value message text would have to predict to forge - so this
    // line, whose clock matches no expected turn, stays prose. Driven through
    // the real importer: the forged line arrives in the body exactly the way a
    // real conversation about page formats would put it there.
    const FORGED = '**Assistant** (2099-12-31 23:59):';
    const messages = [
      {
        id: 'm1',
        role: 'user' as const,
        ts: '2026-02-01T09:00:00.000Z',
        text: `Here is the header shape I keep seeing:\n\n${FORGED}\n\nCan you parse it?`,
      },
      { id: 'm2', role: 'assistant' as const, ts: '2026-02-01T09:05:00.000Z', text: 'Yes - and it must stay prose.' },
    ];
    const result = await roundTripEnvelope({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt', conversation_count: 1, message_count: 2 },
      conversations: [
        {
          id: 'c-forged-header',
          title: 'Forged header',
          created_at: '2026-02-01T09:00:00.000Z',
          updated_at: '2026-02-01T09:05:00.000Z',
          messages,
        },
      ],
    });

    expect(result.imported.exitCode).toBe(0);
    expect(result.exported.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    const out = result.envelope.conversations[0].messages as Array<{ id: string; ts: string | null; text: string }>;
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
    // The forged line is still IN the text - not a boundary, and not deleted.
    expect(out[0].text).toContain(FORGED);
    expect(out[0].text).toContain('Can you parse it?');
    // No identity was forged from it: the line survives as text, but no
    // timestamp field anywhere in the document carries its clock.
    expect(out.map((m) => m.ts)).toEqual(['2026-02-01T09:00:00.000Z', '2026-02-01T09:05:00.000Z']);
    for (const { value } of timestampsIn(result.envelope)) {
      expect(String(value)).not.toContain('2099');
    }
    // And the operator is told a header-shaped line was read as prose.
    expect(result.exported.stderr).toContain('read as prose');
  });

  // --- Pins for two round-3 header overclaims, corrected 2026-08-02. -------
  // In both cases the code was right and the documentation was not; these pin
  // the behavior the header now states, so the corrected claims stay true.

  test('legacy path: a demoted fence exposes every header-shaped line it covered, separator or not', async () => {
    // The old header said a header-shaped line inside a still-open fence is
    // taken as a turn "only when" the blank / `---` / blank separator sits
    // above it. Measured: the separator decides whether the fence loses; once
    // it has lost, an exposed separatorless header-shaped line becomes a turn
    // too. That is the deliberate spurious-message-over-silent-loss trade,
    // and the header now says so.
    const FENCE = '```';
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Demotion reach', 'source: chatgpt', 'memvelope_conversation_id: c-reach'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'before fence',
          '',
          `${FENCE}js`,
          'inside the fence, no separator above the next line',
          '**Assistant** (fake-ts · forged-id):',
          'still inside what was the fence',
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
          '',
          'real second turn',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    const messages = result.envelope.conversations[0].messages as Array<{ id: string; ts: string | null }>;
    expect(messages.map((m) => m.id)).toEqual(['m1', 'forged-id', 'm2']);
    expect(messages[1].ts).toBeNull();
    expect(result.stderr).toContain('is still open at the turn header');
  });

  test('the timeline-cut note claims a cut, not a timeline the page may not have carried', async () => {
    // The old note said the page "carried a gbrain timeline section". A final
    // message that ends by quoting the sentinel on its own line is cut
    // identically - from this side of the page the two cases cannot be told
    // apart - so the note now states only what happened: a cut, and where the
    // loss is. The text after the sentinel is the price, and it is paid
    // loudly rather than reported falsely.
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Quoted at the end', 'source: chatgpt', 'memvelope_conversation_id: c-endquote'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'The marker gbrain uses is this, on its own line:',
          '',
          '<!-- timeline -->',
          '',
          'and this sentence is cut away with the pseudo-timeline.',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations[0].messages[0].text).toBe('The marker gbrain uses is this, on its own line:');
    expect(result.stderr).toContain('were cut at a timeline sentinel');
    expect(result.stderr).not.toContain('carried a gbrain timeline');
  });

  // --- The recorded (frontmatter-identity) path's own contract. -------------

  /** A recorded-format page in the exact shape the importer writes. */
  function recordedPage(opts: {
    title?: string;
    id?: string;
    record: string[];
    body: string;
    date?: string;
  }): string {
    return [
      '---',
      'type: conversation',
      `title: ${JSON.stringify(opts.title ?? 'Recorded')}`,
      `date: ${JSON.stringify(opts.date ?? '2026-02-01')}`,
      'source: "chatgpt"',
      ...(opts.id ? [`memvelope_conversation_id: ${JSON.stringify(opts.id)}`] : []),
      'origin: memvelope/envelope-v0',
      ...opts.record,
      '---',
      `# ${opts.title ?? 'Recorded'}`,
      '',
      opts.body,
      '',
    ].join('\n');
  }

  const RECORD_2 = [
    'messages:',
    '  - id: "m1"',
    '    ts: "2026-02-01T09:00:00.000Z"',
    '  - id: "m2"',
    '    ts: "2026-02-01T09:05:00.000Z"',
  ];
  const BODY_2 = [
    '**Me** (2026-02-01 09:00):',
    '',
    'first turn',
    '',
    '**Assistant** (2026-02-01 09:05):',
    '',
    'second turn',
  ].join('\n');

  test('recorded path: the quoting styles gbrain re-serializes to still read', async () => {
    // gbrain's serializeMarkdown re-emits the array semantically, not
    // textually: plain unquoted ids, single-quoted timestamps. Both must read
    // identically to the importer's JSON-quoted originals.
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-requoted',
        record: [
          'messages:',
          '  - id: m1',
          "    ts: '2026-02-01T09:00:00.000Z'",
          '  - id: m2',
          "    ts: '2026-02-01T09:05:00.000Z'",
        ],
        body: BODY_2,
      }),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    const out = result.envelope.conversations[0].messages as Array<{ id: string; ts: string }>;
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out.map((m) => m.ts)).toEqual(['2026-02-01T09:00:00.000Z', '2026-02-01T09:05:00.000Z']);
  });

  test('recorded path: a body anchoring fewer turns than the record is refused loudly', async () => {
    // A positional join over unequal counts assigns real ids to the wrong
    // text. Refusing is the only honest option, and it has to say both
    // numbers so the operator can find the missing turn.
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-short',
        record: RECORD_2,
        body: '**Me** (2026-02-01 09:00):\n\nonly turn',
      }),
      'b.md': recordedPage({ id: 'c-ok', record: RECORD_2, body: BODY_2 }),
    });

    expect(result.exitCode).toBe(0);
    // The sound page still exports; the unsound one is skipped, not guessed.
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    expect(result.envelope.conversations[0].id).toBe('c-ok');
    expect(result.stderr).toContain('records 2 message(s)');
    expect(result.stderr).toContain('anchors 1 turn(s)');
    expect(result.stderr).toContain('1 whose body does not match their messages record');
  });

  test('recorded path: a null or non-string recorded id is refused loudly, never invented', async () => {
    const nullId = recordedPage({
      id: 'c-nullid',
      record: ['messages:', '  - id: null', '    ts: "2026-02-01T09:00:00.000Z"'],
      body: '**Me** (2026-02-01 09:00):\n\na turn',
    });
    // An unquoted number is a YAML number, not a string - reading it as the
    // string "123" would fabricate an id the record does not hold.
    const numericId = recordedPage({
      id: 'c-numid',
      record: ['messages:', '  - id: 123', '    ts: "2026-02-01T09:00:00.000Z"'],
      body: '**Me** (2026-02-01 09:00):\n\na turn',
    });
    const result = await exportPages({ 'a.md': nullId, 'b.md': numericId });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(0);
    expect(result.stderr).toContain('messages[0] records null');
    expect(result.stderr).toContain('messages[0] records "123"');
    expect(result.stderr).toContain('2 with a messages record that could not be read');
  });

  test('recorded path: an empty or unreadable messages record is refused loudly', async () => {
    const empty = recordedPage({
      id: 'c-empty',
      record: ['messages: []'],
      body: 'No turns at all.',
    });
    const unreadable = recordedPage({
      id: 'c-unreadable',
      record: ['messages: not an array'],
      body: '**Me** (2026-02-01 09:00):\n\na turn',
    });
    const missingTs = recordedPage({
      id: 'c-missing-ts',
      record: ['messages:', '  - id: "m1"'],
      body: '**Me** (2026-02-01 09:00):\n\na turn',
    });
    const result = await exportPages({ 'a.md': empty, 'b.md': unreadable, 'c.md': missingTs });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(0);
    expect(result.stderr).toContain('the messages record is empty');
    expect(result.stderr).toContain('could not be read');
    expect(result.stderr).toContain('does not carry both id and ts');
  });

  test('recorded path: ts null takes the page-date fallback clock and stays null', async () => {
    // The importer writes `<date> 00:00` in the header when a message's ts is
    // null or unusable; the exporter expects the same clock, joins on it, and
    // the recorded null comes back as the null the schema permits.
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-nullts',
        record: [
          'messages:',
          '  - id: "m1"',
          '    ts: null',
          '  - id: "m2"',
          '    ts: "2026-02-01T09:05:00.000Z"',
        ],
        body: [
          '**Me** (2026-02-01 00:00):',
          '',
          'no timestamp on this one',
          '',
          '**Assistant** (2026-02-01 09:05):',
          '',
          'this one has one',
        ].join('\n'),
      }),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    const out = result.envelope.conversations[0].messages as Array<{ ts: string | null }>;
    expect(out[0].ts).toBeNull();
    expect(out[1].ts).toBe('2026-02-01T09:05:00.000Z');
    expect(result.envelope.conversations[0].created_at).toBeNull();
  });

  test('recorded path: a recorded ts that is not RFC 3339 is emitted as null, loudly', async () => {
    // TS_SHAPE reads a wall clock out of `2026-02-01T09:00` (no seconds), so
    // the header join works - but the schema's date-time requires seconds, so
    // the value itself cannot ship. Null plus a warning, like every other
    // non-conforming timestamp.
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-badts',
        record: ['messages:', '  - id: "m1"', '    ts: "2026-02-01T09:00"'],
        body: '**Me** (2026-02-01 09:00):\n\na turn',
      }),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 1 });
    expect(result.envelope.conversations[0].messages[0].ts).toBeNull();
    expect(result.stderr).toContain('"2026-02-01T09:00"');
    expect(result.stderr).toContain('not an RFC 3339 date-time');
  });

  test('recorded path: a fence spanning a turn boundary loses to the recorded clock', async () => {
    // The R1 rule, re-anchored: the legacy separator is gone from this format,
    // so the signal that a fence has swallowed a boundary is coming up short
    // on turns. A fence that never closes at all is demoted as unclosed; a
    // fence that closes in a LATER turn is demoted at the swallowed header.
    // Either way the turns are kept and the operator is told.
    const FENCE = '```';
    const neverCloses = await exportPages({
      'a.md': recordedPage({
        id: 'c-fencespan',
        record: RECORD_2,
        body: [
          '**Me** (2026-02-01 09:00):',
          '',
          'I pasted half a block by mistake:',
          '',
          `${FENCE}js`,
          "const widget = 'acme-example';",
          '',
          '**Assistant** (2026-02-01 09:05):',
          '',
          'The block above me never closed.',
        ].join('\n'),
      }),
    });

    expect(neverCloses.exitCode).toBe(0);
    assertEnvelopeV0(neverCloses.envelope, { conversations: 1, messages: 2 });
    const out = neverCloses.envelope.conversations[0].messages as Array<{ id: string; text: string }>;
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out[1].text).toBe('The block above me never closed.');
    expect(out[0].text).not.toContain('never closed');
    // Body line 7: the recordedPage helper's H1 and blank line sit above.
    expect(neverCloses.stderr).toContain('an unclosed code fence opens at body line 7');

    const closesLater = await exportPages({
      'a.md': recordedPage({
        id: 'c-fencespan-later',
        record: [
          'messages:',
          '  - id: "m1"',
          '    ts: "2026-02-01T09:00:00.000Z"',
          '  - id: "m2"',
          '    ts: "2026-02-01T09:05:00.000Z"',
          '  - id: "m3"',
          '    ts: "2026-02-01T09:10:00.000Z"',
        ],
        body: [
          '**Me** (2026-02-01 09:00):',
          '',
          'half a paste:',
          '',
          `${FENCE}js`,
          'const half = true;',
          '',
          '**Assistant** (2026-02-01 09:05):',
          '',
          'The fence above is still open here.',
          '',
          '**Me** (2026-02-01 09:10):',
          '',
          'And here is the rest:',
          '',
          FENCE,
        ].join('\n'),
      }),
    });

    expect(closesLater.exitCode).toBe(0);
    assertEnvelopeV0(closesLater.envelope, { conversations: 1, messages: 3 });
    const out2 = closesLater.envelope.conversations[0].messages as Array<{ id: string; text: string }>;
    expect(out2.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(out2[1].text).toBe('The fence above is still open here.');
    expect(closesLater.stderr).toContain('hides the header of a recorded turn');
  });

  test('recorded path: a header quoted in a closed fence is sample text, not a turn', async () => {
    // The quoted-transcript case: the fence opens and closes inside one turn,
    // so even a line carrying a REAL upcoming clock stays sample text - the
    // fence is balanced, and balanced fences win.
    const FENCE = '```';
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-quotedfence',
        record: RECORD_2,
        body: [
          '**Me** (2026-02-01 09:00):',
          '',
          'The page format looks like this:',
          '',
          FENCE,
          '**Assistant** (2027-01-01 12:00):',
          FENCE,
          '',
          'Right?',
          '',
          '**Assistant** (2026-02-01 09:05):',
          '',
          'Right.',
        ].join('\n'),
      }),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    const out = result.envelope.conversations[0].messages as Array<{ text: string }>;
    expect(out[0].text).toContain('(2027-01-01 12:00)');
    expect(out[0].text).toContain('Right?');
    expect(out[1].text).toBe('Right.');
    expect(result.stderr).toContain('read as sample text');
  });

  test('recorded path: an empty turn drops its record entry too, keeping the join aligned', async () => {
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-emptyturn',
        record: [
          'messages:',
          '  - id: "m1"',
          '    ts: "2026-02-01T09:00:00.000Z"',
          '  - id: "m2"',
          '    ts: "2026-02-01T09:05:00.000Z"',
          '  - id: "m3"',
          '    ts: "2026-02-01T09:10:00.000Z"',
        ],
        body: [
          '**Me** (2026-02-01 09:00):',
          '',
          'first turn',
          '',
          '**Assistant** (2026-02-01 09:05):',
          '',
          '**Me** (2026-02-01 09:10):',
          '',
          'third turn',
        ].join('\n'),
      }),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    const out = result.envelope.conversations[0].messages as Array<{ id: string; text: string }>;
    // m2 dropped WITH its entry: m3 keeps its own id and text, not m2's.
    expect(out.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(out[1].text).toBe('third turn');
    expect(result.stderr).toContain('no text remained for message "m2"');
  });

  test('recorded path: a new-format body without its record is skipped loudly, not guessed', async () => {
    // A page carrying clock-only headers but NO messages key has no identity
    // source at all - the legacy parser cannot read these headers, and there
    // is no record to join. It lands in the legacy path and is skipped as
    // turnless, which is loud and honest.
    const result = await exportPages({
      'a.md': recordedPage({ id: 'c-recordless', record: [], body: BODY_2 }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(0);
    expect(result.stderr).toContain('no speaker turns found');
  });

  // --- Regressions for the adversarial-gate findings of 2026-08-02/03. -----
  // Each of these reproduced against the rebuild's first cut; each is pinned
  // so the fix stays fixed.

  test('G1: U+2028/U+2029 in ids and titles survive - JSON leaves them raw and the reader must cross them', async () => {
    // JSON.stringify escapes \n and \r but NOT U+2028/U+2029, so a conforming
    // envelope value puts a raw LineTerminator inside a frontmatter line.
    // JavaScript's `.` cannot cross those two characters without the `s`
    // flag, so the id/title lines silently failed to parse: the conversation
    // id exported as null and the title as the fallback with ZERO stderr -
    // defect J's mechanism, one encoding layer down.
    const LS = ' ';
    const PS = ' ';
    const result = await roundTripEnvelope({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt', conversation_count: 1, message_count: 2 },
      conversations: [
        {
          id: `c${LS}real`,
          title: `Half${PS}Title`,
          created_at: '2026-02-01T09:00:00.000Z',
          updated_at: '2026-02-01T09:05:00.000Z',
          messages: [
            { id: `a${LS}b`, role: 'user', ts: '2026-02-01T09:00:00.000Z', text: 'first' },
            { id: 'm2', role: 'assistant', ts: '2026-02-01T09:05:00.000Z', text: 'second' },
          ],
        },
      ],
    });

    expect(result.imported.exitCode).toBe(0);
    expect(result.exported.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    expect(result.envelope.conversations[0].id).toBe(`c${LS}real`);
    expect(result.envelope.conversations[0].title).toBe(`Half${PS}Title`);
    expect(result.envelope.conversations[0].messages.map((m: { id: string }) => m.id)).toEqual([`a${LS}b`, 'm2']);
  });

  test('G2: a UTF-8 BOM does not make a conversation vanish', async () => {
    // gray-matter strips a BOM, so a BOM page is a first-class conversation
    // to gbrain; refusing to see its frontmatter dropped the whole
    // conversation into the anonymous "without frontmatter" count.
    const result = await exportPages({
      'a.md': '﻿' + recordedPage({ id: 'c-bom', record: RECORD_2, body: BODY_2 }),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    expect(result.envelope.conversations[0].id).toBe('c-bom');
  });

  test('G3: trailing YAML comments are stripped, and a comment can never become an id', async () => {
    // js-yaml strips comments on read. Keeping them read `type: conversation
    // # imported` as a different type (conversation dropped), `id: m1 # first`
    // as a different id, and `id: # placeholder` - a null id under YAML - as
    // the invented string "# placeholder", bypassing the null-id gate.
    const commented = [
      '---',
      'type: conversation # imported',
      'title: "Commented" # the title',
      'date: "2026-02-01"',
      'source: "chatgpt"',
      'memvelope_conversation_id: "c-comment"',
      'messages:',
      '  - id: m1 # first',
      '    ts: "2026-02-01T09:00:00.000Z"',
      '---',
      '# Commented',
      '',
      '**Me** (2026-02-01 09:00):',
      '',
      'a turn',
      '',
    ].join('\n');
    const nullIdComment = recordedPage({
      id: 'c-nullcomment',
      record: ['messages:', '  - id: # placeholder', '    ts: "2026-02-01T09:00:00.000Z"'],
      body: '**Me** (2026-02-01 09:00):\n\na turn',
    });
    const result = await exportPages({ 'a.md': commented, 'b.md': nullIdComment });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 1 });
    expect(result.envelope.conversations[0].id).toBe('c-comment');
    expect(result.envelope.conversations[0].messages[0].id).toBe('m1');
    // The null id was refused, not read as "# placeholder".
    expect(result.stderr).toContain('messages[0] records null');
    expect(JSON.stringify(result.envelope)).not.toContain('placeholder');
  });

  test('G4: js-yaml 3.14 int forms - sexagesimal and binary - are refused as non-string ids', async () => {
    // `190:20:30` is the integer 685230 and `0b1010` is 10 to gbrain's own
    // YAML reader; exporting them as strings would emit ids the record does
    // not hold.
    const page = (name: string, idLine: string) => recordedPage({
      id: name,
      record: ['messages:', `  - id: ${idLine}`, '    ts: "2026-02-01T09:00:00.000Z"'],
      body: '**Me** (2026-02-01 09:00):\n\na turn',
    });
    const result = await exportPages({
      'a.md': page('c-sexa', '190:20:30'),
      'b.md': page('c-bin', '0b1010'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(0);
    expect(result.stderr).toContain('"190:20:30"');
    expect(result.stderr).toContain('"0b1010"');
  });

  test('G5: a balanced fence keeps a quoted next-clock header as sample text', async () => {
    // The first cut demoted a fence the instant the next expected clock
    // appeared inside it, with no look at whether the fence closes in its own
    // turn - so a pasted transcript quoting the conversation's own next turn
    // stole the boundary from the real header below. Balanced fences now win:
    // demotion is considered only when the body anchors fewer turns than the
    // record holds.
    const FENCE = '```';
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-balanced',
        record: RECORD_2,
        body: [
          '**Me** (2026-02-01 09:00):',
          '',
          'look at this transcript:',
          '',
          FENCE,
          '**Assistant** (2026-02-01 09:05):',
          'quoted reply',
          FENCE,
          '',
          'end of quote',
          '',
          '**Assistant** (2026-02-01 09:05):',
          '',
          'real reply',
        ].join('\n'),
      }),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    const out = result.envelope.conversations[0].messages as Array<{ role: string; text: string }>;
    expect(out[0].text).toContain('quoted reply');
    expect(out[0].text).toContain('end of quote');
    expect(out[1].text).toBe('real reply');
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.stderr).toContain('read as sample text');
    expect(result.stderr).not.toContain('is still open at the turn header');
  });

  test('G6: a timeline cut is named per page with its body line', async () => {
    // The aggregate note alone could not tell an operator WHICH page was cut;
    // every other loss event names its file, and now this one does too.
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-cutnamed',
        record: ['messages:', '  - id: "m1"', '    ts: "2026-02-01T09:00:00.000Z"'],
        body: '**Me** (2026-02-01 09:00):\n\nkept\n\n<!-- timeline -->\n\n- an entry',
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations[0].messages[0].text).toBe('kept');
    expect(result.stderr).toContain('a.md');
    expect(result.stderr).toContain('cut at the timeline sentinel on body line');
  });

  test('G7: conversation ids differing only by surrounding whitespace stay distinct', async () => {
    // The importer records ids verbatim precisely so these stay two
    // conversations; the exporter trimming them re-collapsed the identities
    // on the way out.
    const page = (name: string, id: string) => recordedPage({
      title: name,
      id,
      record: ['messages:', '  - id: "m1"', '    ts: "2026-02-01T09:00:00.000Z"'],
      body: '**Me** (2026-02-01 09:00):\n\na turn',
    });
    const result = await exportPages({
      'a.md': page('A', 'abc'),
      'b.md': page('B', ' abc '),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 2, messages: 2 });
    expect((result.envelope.conversations as Array<{ id: string }>).map((c) => c.id).sort()).toEqual([' abc ', 'abc']);
    // Distinct ids - no duplicate-id warning belongs here.
    expect(result.stderr).not.toContain('already used by another page');
  });

  test('G8: a messages record with items at column 0 still reads', async () => {
    // Valid YAML (the noArrayIndent style); js-yaml reads it, so refusing it
    // with "the record is empty" was a false diagnosis.
    const result = await exportPages({
      'a.md': [
        '---',
        'type: conversation',
        'title: "Column zero"',
        'date: "2026-02-01"',
        'source: "chatgpt"',
        'memvelope_conversation_id: "c-col0"',
        'messages:',
        '- id: "m1"',
        '  ts: "2026-02-01T09:00:00.000Z"',
        '- id: "m2"',
        '  ts: "2026-02-01T09:05:00.000Z"',
        '---',
        '# Column zero',
        '',
        BODY_2,
        '',
      ].join('\n'),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 2 });
    expect(result.envelope.conversations[0].messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
  });

  test('G9: non-blank body content before the first turn header is reported', async () => {
    // Documented loss, but it was the one loss class with no stderr trace.
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-preamble',
        record: ['messages:', '  - id: "m1"', '    ts: "2026-02-01T09:00:00.000Z"'],
        body: 'a preamble line the export drops\n\n**Me** (2026-02-01 09:00):\n\nhello',
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations[0].messages[0].text).toBe('hello');
    expect(result.stderr).toContain('before the first turn header were not exported');
  });

  test('G10: ids survive gbrain\'s own serializer byte-for-byte, whitespace shapes included', async () => {
    // The block-scalar reader once collapsed whitespace-only content lines
    // and miscounted keep-chomping breaks, so ids like "a\n \nb" came back
    // corrupted with zero stderr. This drives gbrain's actual serializer
    // (gray-matter = js-yaml, the engine of serializeMarkdown) over a battery
    // of whitespace-hostile ids and requires every one back verbatim.
    const matter = (await import('gray-matter')).default;
    const HOSTILE = ['a\n \nb', ' \na', '\n', '\n\n', 'a\n', 'a\n\n', '\na', 'a \n', 'x'.repeat(90), 'm-plain'];
    const ts = (i: number) => `2026-02-01T09:${String(i).padStart(2, '0')}:00.000Z`;
    const front = {
      type: 'conversation',
      title: 'Rewritten',
      date: '2026-02-01',
      source: 'chatgpt',
      memvelope_conversation_id: 'c-rewritten',
      messages: HOSTILE.map((id, i) => ({ id, ts: ts(i) })),
    };
    const body = HOSTILE.map((_, i) => `**Me** (2026-02-01 09:${String(i).padStart(2, '0')}):\n\nturn ${i + 1}`).join('\n\n');
    const page = matter.stringify(`\n# Rewritten\n\n${body}\n`, front);
    const result = await exportPages({ 'a.md': page });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: HOSTILE.length });
    expect(result.envelope.conversations[0].messages.map((m: { id: string }) => m.id)).toEqual(HOSTILE);
  });

  test('G11: the checker accepts year-0000 leap dates the published schema accepts', async () => {
    // Date.UTC maps year 0 to 1900 (the two-digit-year rule), so the checker
    // falsely rejected 0000-02-29 - a real date in the proleptic Gregorian
    // calendar, accepted by ajv-formats - turning the suite red against a
    // conforming document. Only ever a false-red, never a false-green.
    expect(isRfc3339DateTime('0000-02-29T12:34:56Z')).toBe(true);
    expect(isRfc3339DateTime('0000-02-30T12:34:56Z')).toBe(false);
    expect(isRfc3339Date('0000-02-29')).toBe(true);
    expect(isRfc3339Date('0000-02-30')).toBe(false);
    // The 1900-mapping would also have accepted 1900's non-leap February.
    expect(isRfc3339DateTime('1900-02-29T00:00:00Z')).toBe(false);
  });

  // --- Round-2 gate pins: the fixes' own fixes. -----------------------------

  test('G12: plain-scalar typing is js-yaml 3.14\'s, exactly - "089" is a string, "017" is a number', async () => {
    // An approximating regex refused "089" - a STRING to js-yaml, which its
    // dumper re-emits unquoted - so a conversation with that id survived the
    // importer and died at the exporter after one brain cycle. The typing is
    // now a port of js-yaml's own resolvers. Strings export; numbers refuse.
    const page = (name: string, idLine: string) => recordedPage({
      id: name,
      record: ['messages:', `  - id: ${idLine}`, '    ts: "2026-02-01T09:00:00.000Z"'],
      body: '**Me** (2026-02-01 09:00):\n\na turn',
    });
    const result = await exportPages({
      'a.md': page('c-089', '089'), // not octal (8), not decimal (leading 0): a string
      'b.md': page('c-0o17', '0o17'), // js-yaml 3 has no 0o form: a string
      'c.md': page('c-underscore', '123_'), // trailing underscore: a string
      'd.md': page('c-octal', '017'), // 1.1 leading-zero octal: a NUMBER
      'e.md': page('c-signedhex', '-0x1F'), // signed hex: a NUMBER
      'f.md': page('c-dotfloat', '._5'), // dot-float with underscore: a NUMBER
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 3, messages: 3 });
    const byConv = Object.fromEntries(
      (result.envelope.conversations as Array<{ id: string; messages: Array<{ id: string }> }>).map((c) => [c.id, c.messages[0].id]),
    );
    expect(byConv['c-089']).toBe('089');
    expect(byConv['c-0o17']).toBe('0o17');
    expect(byConv['c-underscore']).toBe('123_');
    expect(result.stderr).toContain('"017"');
    expect(result.stderr).toContain('"-0x1F"');
    expect(result.stderr).toContain('"._5"');
  });

  test('G13: the fence that loses is the fence that swallowed the turn, not a balanced one quoting it', async () => {
    // With greedy demotion, a balanced fence quoting the next expected clock
    // was demoted first when a LATER fence caused the shortfall - the quote
    // stole the boundary and flipped the stolen turn's role. Each fence is
    // now tried alone, and only the one whose demotion recovers every
    // recorded turn loses.
    const FENCE = '```';
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-rightfence',
        record: [
          'messages:',
          '  - id: "m1"',
          '    ts: "2026-02-01T09:00:00.000Z"',
          '  - id: "m2"',
          '    ts: "2026-02-01T09:05:00.000Z"',
          '  - id: "m3"',
          '    ts: "2026-02-01T09:10:00.000Z"',
        ],
        body: [
          '**Me** (2026-02-01 09:00):',
          '',
          'a quoted transcript:',
          '',
          FENCE,
          '**Assistant** (2026-02-01 09:05):',
          'quoted, inside a BALANCED fence',
          FENCE,
          '',
          'end of quote',
          '',
          '**Assistant** (2026-02-01 09:05):',
          '',
          'real second turn, and half a paste:',
          '',
          FENCE,
          'const half = true;',
          '',
          '**Me** (2026-02-01 09:10):',
          '',
          'real third turn, closing the paste:',
          '',
          FENCE,
        ].join('\n'),
      }),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 3 });
    const out = result.envelope.conversations[0].messages as Array<{ id: string; role: string; text: string }>;
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // The balanced fence kept its quote; the spanning fence lost.
    expect(out[0].text).toContain('quoted, inside a BALANCED fence');
    expect(out[1].text).toContain('real second turn');
    expect(out[2].text).toContain('real third turn');
    expect(result.stderr).toContain('hides the header of a recorded turn');
  });

  test('G14: a comment straight after a closing quote ends the value', async () => {
    // YAML ends a quoted scalar's value at a '#' with or without whitespace
    // after the closing quote. Keeping it made `"a"# c` a silent garbage
    // conversation id at top level and a falsely-refused member below.
    const result = await exportPages({
      'a.md': [
        '---',
        'type: conversation',
        'title: "Quote comment"',
        'date: "2026-02-01"',
        'source: "chatgpt"',
        'memvelope_conversation_id: "a"# c',
        'messages:',
        '  - id: "m1"# first',
        '    ts: "2026-02-01T09:00:00.000Z"',
        '---',
        '# Quote comment',
        '',
        '**Me** (2026-02-01 09:00):',
        '',
        'a turn',
        '',
      ].join('\n'),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 1, messages: 1 });
    expect(result.envelope.conversations[0].id).toBe('a');
    expect(result.envelope.conversations[0].messages[0].id).toBe('m1');
  });

  test('G15: the no-provider warning does not claim pages lack a source: key they carry', async () => {
    // A sourced page skipped for an unreadable record contributed no
    // provider; the warning then asserted "no page carries a source: key" -
    // false, with advice about a key that was already set.
    const result = await exportPages({
      'a.md': recordedPage({
        id: 'c-sourced-skipped',
        record: ['messages: not an array'],
        body: '**Me** (2026-02-01 09:00):\n\na turn',
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.conversations).toHaveLength(0);
    expect(result.stderr).toContain('was skipped before it could contribute one');
    expect(result.stderr).not.toContain('no page carries');
  });

  // --- Sweep 2.2: one envelope per provider. --------------------------------
  // The mainstream memvelope pitch is merging several vendors' history into
  // one directory. These tests pin the per-provider fan-out end to end: the
  // full circle back through the importer, the sourceless residue, the
  // untouched single-provider path, and the filename token rules.

  const providerEnvelope = (provider: string, id: string, text: string) => ({
    memvelope: 'envelope-v0',
    meta: { source_provider: provider, conversation_count: 1, message_count: 1 },
    conversations: [
      {
        id,
        title: `From ${provider}`,
        created_at: '2026-02-01T09:00:00.000Z',
        updated_at: '2026-02-01T09:00:00.000Z',
        messages: [{ id: 'm1', role: 'user', ts: '2026-02-01T09:00:00.000Z', text }],
      },
    ],
  });

  test('a mixed-provider directory round-trips with no page\'s source falsified', async () => {
    // The full circle the defect lived on: two providers' envelopes imported
    // into ONE directory, exported, and re-imported into the same directory.
    // Byte-identical pages after the circle is the strongest form of "no
    // page's `source:` changed hands" - check 2 matches per-conversation ids,
    // sees a refresh carrying the same truth, and rewrites the same bytes.
    const dir = tempDir();
    const pagesDir = join(dir, 'pages');
    const cgIn = join(dir, 'cg.mve.json');
    const clIn = join(dir, 'cl.mve.json');
    writeFileSync(cgIn, JSON.stringify(providerEnvelope('chatgpt', 'c-cg', 'hello from chatgpt')));
    writeFileSync(clIn, JSON.stringify(providerEnvelope('claude', 'c-cl', 'hello from claude')));
    expect((await run(IMPORTER_PATH, [cgIn, pagesDir])).exitCode).toBe(0);
    expect((await run(IMPORTER_PATH, [clIn, pagesDir])).exitCode).toBe(0);

    const snapshot = new Map<string, string>();
    for (const name of readdirSync(pagesDir)) {
      if (name.endsWith('.md')) snapshot.set(name, readFileSync(join(pagesDir, name), 'utf8'));
    }
    expect(snapshot.size).toBe(2);

    const outPath = join(dir, 'out.mve.json');
    const exported = await run(EXPORTER_PATH, [pagesDir, outPath]);
    expect(exported.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(false);

    const cgOut = join(dir, 'out.chatgpt.mve.json');
    const clOut = join(dir, 'out.claude.mve.json');
    const cgEnv = JSON.parse(readFileSync(cgOut, 'utf8'));
    const clEnv = JSON.parse(readFileSync(clOut, 'utf8'));
    assertEnvelopeV0(cgEnv, { conversations: 1, messages: 1 });
    assertEnvelopeV0(clEnv, { conversations: 1, messages: 1 });
    // Field for field, each per-provider envelope is the one that went in.
    expect(cgEnv).toEqual(providerEnvelope('chatgpt', 'c-cg', 'hello from chatgpt'));
    expect(clEnv).toEqual(providerEnvelope('claude', 'c-cl', 'hello from claude'));

    expect((await run(IMPORTER_PATH, [cgOut, pagesDir])).exitCode).toBe(0);
    expect((await run(IMPORTER_PATH, [clOut, pagesDir])).exitCode).toBe(0);
    expect(readdirSync(pagesDir).filter((n) => n.endsWith('.md'))).toHaveLength(2);
    for (const [name, bytes] of snapshot) {
      expect(readFileSync(join(pagesDir, name), 'utf8')).toBe(bytes);
    }
  });

  test('pages with no source: land in their own unknown envelope, never a named provider\'s', async () => {
    // Absence of a `source:` key is not membership in whichever provider the
    // directory also holds: folding these pages into the chatgpt envelope
    // would stamp `source: "chatgpt"` onto them at re-import - the same
    // falsification the per-provider split exists to stop, arriving through
    // absence instead of collision. They travel under the documented
    // placeholder instead, loudly.
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Sourced', 'source: chatgpt', 'memvelope_conversation_id: c-a'].join('\n'),
        TURNS,
      ),
      'b.md': gbrainPage(
        ['type: conversation', 'title: Sourceless', 'memvelope_conversation_id: c-b'].join('\n'),
        TURNS,
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(result.outPath)).toBe(false);
    const dir = join(result.outPath, '..');
    const cg = JSON.parse(readFileSync(join(dir, 'out.chatgpt.mve.json'), 'utf8'));
    const unk = JSON.parse(readFileSync(join(dir, 'out.unknown.mve.json'), 'utf8'));
    assertEnvelopeV0(cg, { conversations: 1, messages: 2 });
    assertEnvelopeV0(unk, { conversations: 1, messages: 2 });
    expect(cg.meta.source_provider).toBe('chatgpt');
    expect(cg.conversations.map((c: any) => c.id)).toEqual(['c-a']);
    expect(unk.meta.source_provider).toBe('unknown');
    expect(unk.conversations.map((c: any) => c.id)).toEqual(['c-b']);
    expect(result.stderr).toContain('carry no `source:` key');
    expect(result.stderr).toContain('"unknown"');
  });

  test('a single-provider directory is unchanged: one file, the same name and words as before', async () => {
    // The compatibility half of the fan-out. One provider - however many
    // pages - keeps today's behavior byte for byte: outPath itself, the same
    // stdout line, and a silent stderr.
    const page = (id: string) =>
      gbrainPage(
        ['type: conversation', `title: ${id}`, 'source: chatgpt', `memvelope_conversation_id: ${id}`].join('\n'),
        TURNS,
      );
    const result = await exportPages({
      'a.md': page('c-a'),
      'b.md': page('c-b'),
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(result.outPath)).toBe(true);
    assertEnvelopeV0(result.envelope, { conversations: 2, messages: 4 });
    expect(result.envelope.meta.source_provider).toBe('chatgpt');
    expect(existsSync(join(result.outPath, '..', 'out.chatgpt.mve.json'))).toBe(false);
    expect(result.stdout).toContain(`wrote 2 conversation(s), 4 message(s) to ${result.outPath}`);
    expect(result.stdout).not.toContain('provider "');
    expect(result.stderr).toBe('');
  });

  test('filename tokens are sanitized and case-colliding providers get distinct files', async () => {
    // meta.source_provider stays verbatim; only the FILENAME token is
    // sanitized (anything outside [A-Za-z0-9._-] becomes '-', so a provider
    // cannot steer the write outside the output directory) and deduplicated
    // case-insensitively, so 'ChatGPT' and 'chatgpt' pages survive as two
    // files even on the case-insensitive filesystems macOS ships - and the
    // names come out the same on every platform.
    const page = (id: string, source: string) =>
      gbrainPage(
        ['type: conversation', `title: ${id}`, `source: ${source}`, `memvelope_conversation_id: ${id}`].join('\n'),
        TURNS,
      );
    const result = await exportPages({
      'a.md': page('c-a', 'ChatGPT'),
      'b.md': page('c-b', 'chatgpt'),
      'c.md': page('c-c', 'open ai/gpt'),
    });

    expect(result.exitCode).toBe(0);
    const dir = join(result.outPath, '..');
    const first = JSON.parse(readFileSync(join(dir, 'out.ChatGPT.mve.json'), 'utf8'));
    const second = JSON.parse(readFileSync(join(dir, 'out.chatgpt-2.mve.json'), 'utf8'));
    const third = JSON.parse(readFileSync(join(dir, 'out.open-ai-gpt.mve.json'), 'utf8'));
    expect(first.meta.source_provider).toBe('ChatGPT');
    expect(first.conversations.map((c: any) => c.id)).toEqual(['c-a']);
    expect(second.meta.source_provider).toBe('chatgpt');
    expect(second.conversations.map((c: any) => c.id)).toEqual(['c-b']);
    expect(third.meta.source_provider).toBe('open ai/gpt');
    expect(third.conversations.map((c: any) => c.id)).toEqual(['c-c']);
  });

  // --- Sweep 2.9: all four gbrain timeline-sentinel forms. ------------------
  // gbrain's findTimelineSplitIndex (src/core/markdown.ts) accepts four forms:
  // the two comment spellings, `--- timeline ---` under /^---\s+timeline\s+---$/i,
  // and a bare `---` whose next non-blank line is a `## Timeline`/`## History`
  // heading. The exporter knew three exact strings, so the case/space-tolerant
  // decorated variants and the bare-`---` fallback cut in gbrain but exported
  // as message text here. Each closed form joins the discipline the known forms
  // already had: fence-masked candidates, a cut only past the last accepted
  // turn, and a stderr line for the cut and for the refusal alike.

  test('form 3 variants gbrain accepts (case, spacing) cut like the exact string', async () => {
    const timelineTail = (sentinel: string) => `${TURNS}\n\n${sentinel}\n\n- 2026-02-02: gbrain added a timeline entry.`;
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Uppercase sentinel', 'source: chatgpt', 'memvelope_conversation_id: c-upper'].join('\n'),
        timelineTail('--- TIMELINE ---'),
      ),
      'b.md': gbrainPage(
        ['type: conversation', 'title: Wide sentinel', 'source: chatgpt', 'memvelope_conversation_id: c-wide'].join('\n'),
        timelineTail('---   timeline   ---'),
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 2, messages: 4 });
    expect(JSON.stringify(result.envelope)).not.toContain('added a timeline entry');
    expect(JSON.stringify(result.envelope)).not.toContain('TIMELINE');
    expect(result.stderr).toContain('cut at the timeline sentinel');
  });

  test('form 4 - a bare --- above a Timeline or History heading cuts, as gbrain reads it', async () => {
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Bare rule form', 'source: chatgpt', 'memvelope_conversation_id: c-t4'].join('\n'),
        `${TURNS}\n\n---\n\n## Timeline\n\n- 2026-02-02: gbrain added a timeline entry.`,
      ),
      'b.md': gbrainPage(
        ['type: conversation', 'title: History heading', 'source: chatgpt', 'memvelope_conversation_id: c-hist'].join('\n'),
        `${TURNS}\n\n---\n\n## History of the rollout\n\n- 2026-02-02: gbrain added a timeline entry.`,
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 2, messages: 4 });
    expect(JSON.stringify(result.envelope)).not.toContain('added a timeline entry');
    expect(JSON.stringify(result.envelope)).not.toContain('## Timeline');
    expect(JSON.stringify(result.envelope)).not.toContain('## History');
    const texts = result.envelope.conversations.flatMap((c: any) => c.messages.map((m: any) => m.text));
    for (const text of texts) expect(text).not.toContain('---');
    expect(result.stderr).toContain('cut at the timeline sentinel');
  });

  test('form 4 does not fire without its heading: a trailing --- stays message text', async () => {
    // The old header called bare `---` unrecognizable because it is also the
    // legacy turn separator. The heading lookahead is what makes it safe: a
    // rule with anything else below it - prose, or a heading the \b rejects -
    // is still message text, byte for byte.
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Rule then prose', 'source: chatgpt', 'memvelope_conversation_id: c-rule'].join('\n'),
        `${TURNS}\n\n---\n\nNot a heading, only prose after a rule.`,
      ),
      'b.md': gbrainPage(
        ['type: conversation', 'title: Rule then near-heading', 'source: chatgpt', 'memvelope_conversation_id: c-near'].join('\n'),
        `${TURNS}\n\n---\n\n## Timelines are lists, not the Timeline heading`,
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 2, messages: 4 });
    const [a, b] = result.envelope.conversations as Array<{ messages: Array<{ text: string }> }>;
    expect(a.messages[1].text).toContain('---');
    expect(a.messages[1].text).toContain('Not a heading, only prose after a rule.');
    expect(b.messages[1].text).toContain('## Timelines are lists');
    expect(result.stderr).not.toContain('cut at the timeline sentinel');
  });

  test('new sentinel forms follow the only-terminal rule: quoted mid-conversation they warn and do not cut', async () => {
    // The mirror of D1 for the closed forms. gbrain's own parser cuts at the
    // FIRST hit and truncates every turn below it - the upstream defect this
    // exporter deliberately does not copy. A decorated or bare-rule sentinel
    // with accepted turns after it is prose, kept, and reported.
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Quoted decorated', 'source: chatgpt', 'memvelope_conversation_id: c-q3'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'gbrain also accepts this spelling:',
          '',
          '--- TIMELINE ---',
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
          '',
          'And turns after it must survive.',
        ].join('\n'),
      ),
      'b.md': gbrainPage(
        ['type: conversation', 'title: Quoted bare rule', 'source: chatgpt', 'memvelope_conversation_id: c-q4'].join('\n'),
        [
          '**Me** (2026-02-01T09:00:00.000Z · m1):',
          '',
          'The fallback form looks like this:',
          '',
          '---',
          '',
          '## Timeline',
          '',
          'and gbrain reads a real one only after the last turn.',
          '',
          '---',
          '',
          '**Assistant** (2026-02-01T09:05:00.000Z · m2):',
          '',
          'And turns after it must survive.',
        ].join('\n'),
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 2, messages: 4 });
    const [a, b] = result.envelope.conversations as Array<{ messages: Array<{ text: string }> }>;
    expect(a.messages[0].text).toContain('--- TIMELINE ---');
    expect(a.messages[1].text).toContain('must survive');
    expect(b.messages[0].text).toContain('## Timeline');
    expect(b.messages[0].text).toContain('---');
    expect(b.messages[1].text).toContain('must survive');
    expect(result.stderr).toContain('is not a timeline boundary');
    expect(result.stderr).not.toContain('cut at the timeline sentinel');
  });

  test('the tight comment and exact decorated forms cut too (all four forms covered)', async () => {
    // Forms 1 and 2 plus the exact decorated string predate this sweep; pinned
    // here so the "all four forms" claim has a receipt per form, not a set
    // membership nobody exercises.
    const timelineTail = (sentinel: string) => `${TURNS}\n\n${sentinel}\n\n- 2026-02-02: gbrain added a timeline entry.`;
    const result = await exportPages({
      'a.md': gbrainPage(
        ['type: conversation', 'title: Tight comment', 'source: chatgpt', 'memvelope_conversation_id: c-tight'].join('\n'),
        timelineTail('<!--timeline-->'),
      ),
      'b.md': gbrainPage(
        ['type: conversation', 'title: Exact decorated', 'source: chatgpt', 'memvelope_conversation_id: c-exact'].join('\n'),
        timelineTail('--- timeline ---'),
      ),
    });

    expect(result.exitCode).toBe(0);
    assertEnvelopeV0(result.envelope, { conversations: 2, messages: 4 });
    expect(JSON.stringify(result.envelope)).not.toContain('added a timeline entry');
    expect(result.stderr).toContain('cut at the timeline sentinel');
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
