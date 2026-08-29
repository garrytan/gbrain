/**
 * v0.41.16.0 — `gbrain eval conversation-parser` CLI behavior tests.
 *
 * Covers argv parsing, exit codes (0/1/2), --json envelope shape,
 * --no-llm flag, --min-recall override, USAGE errors. Pure file I/O,
 * no DB, no API keys.
 *
 * Critical because `bun run check:conversation-parser` is wired into
 * `bun run verify` — a silent regression in exit-code handling would
 * make every PR's CI green even when the parser broke.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvalConversationParser } from '../src/commands/eval-conversation-parser.ts';
import { scoreFixture } from '../src/core/conversation-parser/eval.ts';

function tmpFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-cli-'));
  const path = join(dir, 'fix.jsonl');
  writeFileSync(path, content);
  return path;
}

const PASS = `{"fixture_id":"p1","pattern":"imessage-slack","frontmatter":{"date":"2024-03-15"},"body":"**Alice** (2024-03-15 9:00 AM): hi","expected_messages":1,"expected_participants":["Alice"]}`;
const FAIL_PATTERN_MISMATCH = `{"fixture_id":"f1","pattern":"telegram-bracket","frontmatter":{"date":"2024-03-15"},"body":"**Alice** (2024-03-15 9:00 AM): hi","expected_messages":1,"expected_participants":["Alice"]}`;

describe('runEvalConversationParser — exit codes', () => {
  test('exit 0 on all-pass fixture', async () => {
    const path = tmpFixture(PASS);
    const code = await runEvalConversationParser([path, '--no-llm']);
    expect(code).toBe(0);
  });

  test('exit 1 on any failure', async () => {
    const path = tmpFixture(FAIL_PATTERN_MISMATCH);
    const code = await runEvalConversationParser([path, '--no-llm']);
    expect(code).toBe(1);
  });

  test('exit 2 on missing fixture argument', async () => {
    const code = await runEvalConversationParser(['--no-llm']);
    expect(code).toBe(2);
  });

  test('exit 2 on nonexistent fixture path', async () => {
    const code = await runEvalConversationParser([
      '/nonexistent/path.jsonl',
      '--no-llm',
    ]);
    expect(code).toBe(2);
  });

  test('exit 2 on malformed JSONL', async () => {
    const path = tmpFixture('NOT-JSON\n');
    const code = await runEvalConversationParser([path]);
    expect(code).toBe(2);
  });

  test('exit 2 on empty fixture file', async () => {
    const path = tmpFixture('');
    const code = await runEvalConversationParser([path]);
    expect(code).toBe(2);
  });

  test('exit 0 on help', async () => {
    const code = await runEvalConversationParser(['--help']);
    expect(code).toBe(0);
  });
});

describe('runEvalConversationParser — flag parsing', () => {
  test('positional fixture path works without --fixtures', async () => {
    const path = tmpFixture(PASS);
    const code = await runEvalConversationParser([path, '--no-llm']);
    expect(code).toBe(0);
  });

  test('--fixtures <path> form works', async () => {
    const path = tmpFixture(PASS);
    const code = await runEvalConversationParser([
      '--fixtures',
      path,
      '--no-llm',
    ]);
    expect(code).toBe(0);
  });

  test('--fixtures=<path> form works', async () => {
    const path = tmpFixture(PASS);
    const code = await runEvalConversationParser([
      `--fixtures=${path}`,
      '--no-llm',
    ]);
    expect(code).toBe(0);
  });

  test('--min-recall override (lower floor lets near-misses pass)', async () => {
    // A fixture where the parser only catches 0 of 1 expected messages.
    // Default --min-recall 0.9 would fail this; --min-recall 0.0 passes.
    const partial = `{"fixture_id":"pp","pattern":"telegram-bracket","frontmatter":{"date":"2024-03-15"},"body":"this is not a telegram line","expected_messages":1,"expected_participants":["Alice"]}`;
    const path = tmpFixture(partial);
    const defaultCode = await runEvalConversationParser([path, '--no-llm']);
    expect(defaultCode).toBe(1); // expected pattern not matched → fail
    // Lowering min-recall doesn't rescue a pattern mismatch — pattern
    // identity is checked separately. This pins that contract.
    const lowCode = await runEvalConversationParser([
      path,
      '--no-llm',
      '--min-recall',
      '0.0',
    ]);
    expect(lowCode).toBe(1);
  });
});

describe('runEvalConversationParser — --json envelope', () => {
  test('emits stable schema_version=1 + recall + pattern_coverage', async () => {
    const path = tmpFixture(PASS);
    const origWrite = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runEvalConversationParser([path, '--no-llm', '--json']);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    const stdout = captured.join('');
    const json = JSON.parse(stdout.trim());
    expect(json.schema_version).toBe(1);
    expect(json.total_fixtures).toBe(1);
    expect(json.passed).toBe(1);
    expect(json.failed).toBe(0);
    expect(json.recall_mean).toBe(1);
    expect(json.participants_recall_mean).toBe(1);
    expect(json.pattern_coverage).toEqual({ 'imessage-slack': 1 });
    expect(json.fixtures).toHaveLength(1);
    expect(json.failed_fixture_ids).toEqual([]);
  });

  test('--json on failure includes failed_fixture_ids', async () => {
    const path = tmpFixture(FAIL_PATTERN_MISMATCH);
    const origWrite = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runEvalConversationParser([path, '--no-llm', '--json']);
      expect(code).toBe(1);
    } finally {
      process.stdout.write = origWrite;
    }
    const json = JSON.parse(captured.join('').trim());
    expect(json.failed_fixture_ids).toContain('f1');
  });
});

describe('scoreFixture — unrecognized_headings on a positive fixture (TODOS #4136 follow-up)', () => {
  // Body matches markdown-heading-turn on '## User' / '## Assistant', but the
  // '## Trickster Voice' heading is outside the pattern's closed speaker set:
  // the parser folds it (heading + its words) into User's turn and reports it
  // in ParseResult.unrecognized_headings. Recall + participants_recall are
  // both perfect (2/2 messages, both speakers present) — so recall-based
  // scoring alone would pass a fixture whose speaker attribution is wrong.
  const FOLDED_BODY =
    '## User\n\nWhat is the deploy command?\n\n## Trickster Voice\n\nI claim these words.\n\n## Assistant\n\nRun the deploy script.';
  const foldedFixture = {
    fixture_id: 'heading-fold',
    pattern: 'markdown-heading-turn',
    frontmatter: { date: '2026-08-01' },
    body: FOLDED_BODY,
    expected_messages: 2,
    expected_participants: ['User', 'Assistant'],
  };

  test('positive fixture whose parse reports unrecognized_headings → fail', () => {
    const score = scoreFixture(foldedFixture, { noLlm: true });
    expect(score.passed).toBe(false);
    expect(score.reasons.some((r) => r.includes('unrecognized_headings'))).toBe(
      true,
    );
    // The folded label is named so CI triage sees WHICH heading was lost.
    expect(score.reasons.join('\n')).toContain('Trickster Voice');
  });

  test('CLI exits 1 on a folded-heading positive fixture', async () => {
    const path = tmpFixture(`${JSON.stringify(foldedFixture)}\n`);
    const code = await runEvalConversationParser([path, '--no-llm']);
    expect(code).toBe(1);
  });

  test('clean markdown-heading-turn positive fixture still passes', () => {
    const score = scoreFixture(
      {
        fixture_id: 'heading-clean',
        pattern: 'markdown-heading-turn',
        frontmatter: { date: '2026-08-01' },
        body: '## User\n\nWhat is the deploy command?\n\n## Assistant\n\nRun the deploy script.',
        expected_messages: 2,
        expected_participants: ['User', 'Assistant'],
      },
      { noLlm: true },
    );
    expect(score.passed).toBe(true);
    expect(score.reasons).toEqual([]);
  });
});

describe('runEvalConversationParser — adversarial fixture', () => {
  test('adversarial (pattern=null) with non-empty parse → fail', async () => {
    // Adversarial fixture whose body LOOKS like iMessage; parser will
    // match it; eval flags as adversarial false-positive.
    const advFp = `{"fixture_id":"adv-fp","pattern":null,"frontmatter":{"date":"2024-03-15"},"body":"**Alice** (2024-03-15 9:00 AM): I should not parse","expected_messages":0,"expected_participants":[]}`;
    const path = tmpFixture(advFp);
    const code = await runEvalConversationParser([path, '--no-llm']);
    expect(code).toBe(1);
  });

  test('adversarial with truly unparseable body → pass', async () => {
    const advClean = `{"fixture_id":"adv-clean","pattern":null,"frontmatter":{"date":"2024-03-15"},"body":"This is just prose with no chat shape.","expected_messages":0,"expected_participants":[]}`;
    const path = tmpFixture(advClean);
    const code = await runEvalConversationParser([path, '--no-llm']);
    expect(code).toBe(0);
  });
});
