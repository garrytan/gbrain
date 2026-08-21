/**
 * transcript-adapters.test.ts — the cathedral-4 adapter seam.
 *
 * Carries the MANDATORY regression pin (plan T12): parseTranscript's output
 * on the shipped fixture is pinned EXACTLY — the hook session-end lane and
 * ambient hooks consume it, and the import lane's additive
 * parseClaudeSessionFile must never change it.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseTranscript,
  parseClaudeSessionFile,
} from '../src/core/transcripts/claude-code-jsonl.ts';
import { claudeCodeAdapter } from '../src/core/transcripts/claude-code.ts';
import {
  detectAdapter,
  harnessRoots,
  readSample,
} from '../src/core/transcripts/detect.ts';
import {
  buildTranscriptSlug,
  transcriptFullId,
  transcriptSlugId,
  type FileDiagnostics,
  type ParsedSession,
  type TranscriptFormat,
} from '../src/core/transcripts/types.ts';

import { codexAdapter } from '../src/core/transcripts/codex.ts';
import {
  isOpenclawCheckpointFile,
  mapOpenclawLine,
  openclawAdapter,
  type OpenclawLineResult,
} from '../src/core/transcripts/openclaw.ts';
import { hermesAdapter } from '../src/core/transcripts/hermes.ts';
import { chatgptExportAdapter } from '../src/core/transcripts/chatgpt-export.ts';
import { claudeExportAdapter } from '../src/core/transcripts/claude-export.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';

const CHATGPT_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'chatgpt-conversations.json');
const CLAUDE_EXPORT_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'claude-export.json');

const FIXTURE = join(import.meta.dir, 'fixtures', 'conversation-formats', 'claude-code.jsonl');
const CODEX_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'codex-rollout.jsonl');
const AGENT_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'agent-session.jsonl');
const CHECKPOINT_FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'transcripts',
  'agent-session.checkpoint.11111111-aaaa-bbbb-cccc-222222222222.jsonl',
);

let tmp: string | null = null;
function tdir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'gb-adapters-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

async function drain(
  gen: AsyncGenerator<ParsedSession, FileDiagnostics>,
): Promise<{ sessions: ParsedSession[]; diag: FileDiagnostics }> {
  const sessions: ParsedSession[] = [];
  let r = await gen.next();
  while (!r.done) {
    sessions.push(r.value);
    r = await gen.next();
  }
  return { sessions, diag: r.value };
}

// ── T12: REGRESSION PIN on the shipped hook-lane parser ─────────────────────

describe('parseTranscript regression pin [T12 — hook lane must not move]', () => {
  test('fixture output is byte-identical to the pinned shape', () => {
    const r = parseTranscript(FIXTURE);
    expect(r.parsedLines).toBe(8);
    expect(r.skippedLines).toBe(1);
    expect(r.compactBoundaries).toBe(1);
    // Cathedral 5: boundary POSITION in turns-index space (additive; the
    // fixture's compact_boundary line follows all 5 turns). Always same
    // length as compactBoundaries.
    expect(r.boundaryTurnIndexes).toEqual([5]);
    expect(r.injectedContextBlocks).toEqual([]);
    expect(r.turns).toEqual([
      { role: 'user', text: "What do we know about widget-co's seed round?" },
      {
        role: 'assistant',
        text:
          'widget-co raised a seed round led by fund-a.\n' +
          'alice-example introduced the founders to charlie-example.',
      },
      {
        role: 'assistant',
        text: 'Let me check the brain for acme-example connections.\n[tool: search_brain]',
      },
      { role: 'user', text: '[tool result]\n[image]' },
      {
        role: 'assistant',
        text:
          '[thinking]\nSummary: the widget-co seed closed in early 2026 with ' +
          'fund-a leading and fund-b participating.',
      },
    ]);
  });
});

// ── parseClaudeSessionFile (additive import lane) ───────────────────────────

describe('parseClaudeSessionFile [timestamps preserved, never invented]', () => {
  test('turns carry real source timestamps and match the hook-lane turns 1:1', () => {
    const s = parseClaudeSessionFile(FIXTURE);
    expect(s.sessionId).toBe('fixture-session-1');
    expect(s.cwd).toBe('/home/alice-example/agent-workspace');
    expect(s.startedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(s.skippedLines).toBe(1);
    expect(s.turns.map((t) => t.timestamp)).toEqual([
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:00:05.000Z',
      '2026-08-01T10:00:09.000Z',
      '2026-08-01T10:00:11.000Z',
      '2026-08-01T10:00:20.000Z',
    ]);
    const hookTurns = parseTranscript(FIXTURE).turns;
    expect(s.turns.map(({ role, text }) => ({ role, text }))).toEqual(hookTurns);
  });

  test('rejects (never tail-reads) a file over the cap', () => {
    expect(() => parseClaudeSessionFile(FIXTURE, { maxBytes: 64 })).toThrow(/too large/);
  });
});

// ── Slug builder [one helper, collision-proof suffixes] ─────────────────────

describe('buildTranscriptSlug', () => {
  test('harness sessions get per-day format+hash12 slugs', () => {
    const slug = buildTranscriptSlug('codex', '2026-08-14T15:12:45.000Z', {
      sessionId: 'AB12cd34ef56',
    });
    expect(slug).toMatch(/^conversations\/sessions\/2026-08-14-codex-[0-9a-f]{12}$/);
    expect(slug).toBe(
      `conversations/sessions/2026-08-14-codex-${transcriptSlugId('AB12cd34ef56')}`,
    );
  });
  test('exports get per-provider dirs with title + hash12', () => {
    expect(
      buildTranscriptSlug('chatgpt', '2026-01-02T03:04:05Z', {
        sessionId: 'thread-777xyz00',
        title: 'Planning the Widget Co launch!',
      }),
    ).toMatch(/^conversations\/chatgpt\/2026-01-02-planning-the-widget-co-launch-[0-9a-f]{12}$/);
    expect(
      buildTranscriptSlug('claude-export', '2026-01-02T03:04:05Z', { sessionId: 'thread-777xyz00' }),
    ).toMatch(/^conversations\/claude\/2026-01-02-untitled-[0-9a-f]{12}$/);
  });
  test('identity is HASHED, never a prefix — same-prefix ids cannot collide', () => {
    // The adversarially-reproduced P0: prefix identity made 'attackaa-one'
    // and 'attackaa-two' share slug + dedup id (silent overwrite/skip).
    expect(transcriptSlugId('attackaa-one')).not.toBe(transcriptSlugId('attackaa-two'));
    expect(transcriptFullId('attackaa-one')).not.toBe(transcriptFullId('attackaa-two'));
    // Fallback-id shapes that collided under prefixing are distinct too.
    expect(transcriptSlugId('chatgpt-1')).not.toBe(transcriptSlugId('chatgpt-10'));
    expect(transcriptSlugId('claude-export-0')).not.toBe(transcriptSlugId('claude-export-1'));
    // Deterministic + well-formed.
    expect(transcriptSlugId('x')).toBe(transcriptSlugId('x'));
    expect(transcriptSlugId('x')).toMatch(/^[0-9a-f]{12}$/);
    expect(transcriptFullId('x')).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── Detection registry ──────────────────────────────────────────────────────

describe('detectAdapter', () => {
  test('detects the claude-code fixture', () => {
    const r = detectAdapter(FIXTURE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adapter.format).toBe('claude-code');
  });

  test('unknown format names every detector tried', () => {
    const d = tdir();
    const p = join(d, 'mystery.jsonl');
    writeFileSync(p, '{"totally":"unrelated"}\n');
    const r = detectAdapter(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown_format');
      expect(r.tried).toContain('claude-code');
    }
  });

  test('rejects symlinks (lstat, never followed)', () => {
    const d = tdir();
    const link = join(d, 'link.jsonl');
    symlinkSync(FIXTURE, link);
    const r = detectAdapter(link);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('symlink');
  });

  test('explicit format wins over sniffing', () => {
    const d = tdir();
    const p = join(d, 'whatever.txt');
    writeFileSync(p, 'not json at all');
    const r = detectAdapter(p, { explicitFormat: 'claude-code' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adapter.format).toBe('claude-code');
  });
});

describe('harnessRoots', () => {
  test('covers the four harnesses and is override-injectable for tests', () => {
    const formats = harnessRoots().map((r) => r.format);
    expect(formats).toEqual(['claude-code', 'codex', 'openclaw', 'hermes']);
    const injected = harnessRoots([{ format: 'codex', root: '/tmp/x', extension: '.jsonl' }]);
    expect(injected).toHaveLength(1);
    expect(injected[0].root).toBe('/tmp/x');
  });
});

// ── Claude adapter through the seam ─────────────────────────────────────────

describe('claudeCodeAdapter', () => {
  test('yields one session with diagnostics on the fixture', async () => {
    const { sessions, diag } = await drain(claudeCodeAdapter.parse(FIXTURE));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.meta.harness).toBe('claude-code');
    expect(s.meta.sessionId).toBe('fixture-session-1');
    expect(s.messages).toHaveLength(5);
    expect(s.messages[0].timestamp).toBe('2026-08-01T10:00:00.000Z');
    expect(diag.sessions).toBe(1);
    expect(diag.skippedLines).toBe(1);
    expect(diag.bytesRead).toBeGreaterThan(0);
    expect(diag.truncated).toBe(false);
  });

  test('zero-turn file explains itself (drift signal shape)', async () => {
    const d = tdir();
    const p = join(d, 'empty-turns.jsonl');
    writeFileSync(p, '{"type":"summary","summary":"nothing"}\n');
    const { sessions, diag } = await drain(claudeCodeAdapter.parse(p));
    expect(sessions).toHaveLength(0);
    expect(diag.sessions).toBe(0);
    expect(diag.bytesRead).toBeGreaterThan(0);
    expect(diag.zeroSessionsReason).toBeTruthy();
  });

  test('detect sniffs the first line shape', () => {
    expect(claudeCodeAdapter.detect(FIXTURE, readSample(FIXTURE))).toBe(true);
  });

  // Regression: Claude Code leads its transcripts with non-turn control
  // records (`queue-operation`, `last-prompt`, `mode`, `ai-title`). Measured
  // 2026-08-16 over 400 live files: 273/115/10/2 led with those and ZERO led
  // with a turn, so a line-1-only probe rejected 100% of real sessions.
  test('detect accepts a transcript led by control records', () => {
    const p = join(tdir(), 'led-by-control.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({ type: 'queue-operation', operation: 'add', sessionId: 's1', timestamp: '2026-08-16T00:00:00Z', content: 'x' }),
        JSON.stringify({ type: 'mode', mode: 'default', sessionId: 's1' }),
        JSON.stringify({ type: 'user', sessionId: 's1', message: { role: 'user', content: 'hi' } }),
      ].join('\n') + '\n',
    );
    expect(claudeCodeAdapter.detect(p, readSample(p))).toBe(true);
  });

  // A control-record head must not turn every .jsonl into a Claude transcript:
  // hook-telemetry files under ~/.claude/projects have no sessionId and must
  // still be rejected.
  test('detect still rejects non-transcript jsonl', () => {
    const p = join(tdir(), 'hook-telemetry.jsonl');
    writeFileSync(
      p,
      JSON.stringify({ event: 'skill-injection', hookEvent: 'UserPromptSubmit', matchedSkills: [], contextChunks: 0 }) + '\n',
    );
    expect(claudeCodeAdapter.detect(p, readSample(p))).toBe(false);
  });
});

// ── Codex adapter [structural turn selection, never preamble heuristics] ────

describe('codexAdapter', () => {
  // Regression: an oversized rollout used to throw and contribute NOTHING.
  // It now degrades to a bounded head+tail read like the claude-code adapter.
  // HEAD is load-bearing: `session_meta` — session_id, cwd, provenance — is the
  // FIRST record of a rollout, so a tail-only read imports turns that cannot be
  // attributed to a session.
  test('oversized rollout degrades to head+tail instead of throwing, keeping session_meta', async () => {
    const p = join(tdir(), 'huge-rollout.jsonl');
    const meta = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { session_id: 'sess-head-1', cwd: '/w', cli_version: '1.2.3' },
    });
    const filler = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: { type: 'reasoning', content: 'x'.repeat(4000) },
    });
    const newest = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-01-01T00:09:00.000Z',
      payload: { type: 'user_message', message: 'the newest turn' },
    });
    writeFileSync(p, [meta, ...Array(400).fill(filler), newest].join('\n') + '\n');

    const { sessions, diag } = await drain(codexAdapter.parse(p, { maxBytes: 64 * 1024 }));
    expect(sessions).toHaveLength(1);
    // Identity came from the HEAD window...
    expect(sessions[0].meta.sessionId).toBe('sess-head-1');
    expect(sessions[0].meta.cwd).toBe('/w');
    // ...and the newest turn from the TAIL window.
    expect(sessions[0].messages.at(-1)?.text).toBe('the newest turn');
    // Honest accounting: a partial read must say so, and must read less than
    // the file. A `truncated: false` here would be the false-green this
    // replaces.
    expect(diag.truncated).toBe(true);
    expect(diag.bytesRead).toBeLessThan(statSync(p).size);
    // The head/tail seam leaves a partial line on each side; both must be
    // counted, not silently swallowed. Untested, this is where a "clean"
    // truncated read could quietly appear.
    expect(diag.skippedLines).toBeGreaterThanOrEqual(2);
  });

  test('a rollout within budget is read whole and not marked truncated', async () => {
    const { diag } = await drain(codexAdapter.parse(CODEX_FIXTURE));
    expect(diag.truncated).toBe(false);
    expect(diag.bytesRead).toBe(statSync(CODEX_FIXTURE).size);
  });

  test('user turns from event_msg, assistant from output_text; injected preambles never leak', async () => {
    const { sessions, diag } = await drain(codexAdapter.parse(CODEX_FIXTURE));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.meta.sessionId).toBe('codex-fixture-session-1');
    expect(s.meta.cwd).toBe('/home/alice-example/agent-workspace');
    expect(s.meta.startedAt).toBe('2026-08-02T09:00:00.000Z');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(s.messages[0].text).toContain('which fund led the widget-co seed');
    expect(s.messages[0].timestamp).toBe('2026-08-02T09:00:03.000Z');
    expect(s.messages[1].text).toContain('fund-a led the widget-co seed');
    expect(s.messages[3].text).toBe('Noted: bridge check-in every Thursday.\nI will keep that in the plan.');
    const all = s.messages.map((m) => m.text).join('\n');
    expect(all).not.toContain('PREAMBLE-ONLY-TEXT');
    expect(all).not.toContain('PLUGIN-LIST-ONLY-TEXT');
    expect(all).not.toContain('REASONING-ONLY-TEXT');
    expect(all).not.toContain('TOOL-OUTPUT-ONLY-TEXT');
    expect(diag.sessions).toBe(1);
    expect(diag.skippedLines).toBe(1); // the malformed tail line
  });

  test('detect matches the rollout head line', () => {
    expect(codexAdapter.detect(CODEX_FIXTURE, readSample(CODEX_FIXTURE))).toBe(true);
    expect(codexAdapter.detect(FIXTURE, readSample(FIXTURE))).toBe(false);
  });
});

// ── OpenClaw adapter [checkpoint siblings never imported] ───────────────────

describe('openclawAdapter', () => {
  test('messages only; model_change/custom/compaction skipped; timestamps kept', async () => {
    const { sessions, diag } = await drain(openclawAdapter.parse(AGENT_FIXTURE));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.meta.sessionId).toBe('agent-fixture-session-1');
    expect(s.meta.startedAt).toBe('2026-08-03T14:00:00.000Z');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(s.messages[1].timestamp).toBe('2026-08-03T14:00:05.000Z');
    const all = s.messages.map((m) => m.text).join('\n');
    expect(all).toContain('acme-seed memo');
    expect(all).not.toContain('CUSTOM-ONLY-TEXT');
    expect(all).not.toContain('COMPACTION-ONLY-TEXT');
    expect(diag.skippedLines).toBe(1);
  });

  test('checkpoint siblings are rejected by detect and flagged by the helper', () => {
    expect(isOpenclawCheckpointFile(CHECKPOINT_FIXTURE)).toBe(true);
    expect(isOpenclawCheckpointFile(AGENT_FIXTURE)).toBe(false);
    expect(openclawAdapter.detect(CHECKPOINT_FIXTURE, readSample(CHECKPOINT_FIXTURE))).toBe(false);
    expect(openclawAdapter.detect(AGENT_FIXTURE, readSample(AGENT_FIXTURE))).toBe(true);
  });

  // Cathedral 5: the exported line mapper is the SAME mapping the adapter
  // uses (single source of truth for the dated SPEC_TARGET); boundary lines
  // classify as 'boundary' with positions derivable in message-index space.
  test('mapOpenclawLine classifies session/boundary/message/skip; boundary sits after 2 fixture messages', () => {
    const lines = readFileSync(AGENT_FIXTURE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter((e) => e !== undefined);
    const kinds = lines.map((e) => mapOpenclawLine(e).kind);
    expect(kinds[0]).toBe('session');
    expect(kinds.filter((k) => k === 'boundary')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'message')).toHaveLength(4);
    // Boundary position in message-index space: count messages before it.
    const boundaryAt = (() => {
      let msgs = 0;
      for (const e of lines) {
        const m = mapOpenclawLine(e);
        if (m.kind === 'boundary') return msgs;
        if (m.kind === 'message') msgs++;
      }
      return -1;
    })();
    expect(boundaryAt).toBe(2);
    // Mapper output matches the adapter's messages 1:1 (behavior identity).
    const mapped = lines
      .map((e) => mapOpenclawLine(e))
      .filter((m): m is Extract<OpenclawLineResult, { kind: 'message' }> => m.kind === 'message')
      .map((m) => m.message);
    return drain(openclawAdapter.parse(AGENT_FIXTURE)).then(({ sessions }) => {
      expect(mapped).toEqual(sessions[0].messages);
    });
  });
});

// ── Hermes adapter [copy-then-read; multi-session cardinality] ──────────────

describe('hermesAdapter', () => {
  test('yields sessions in start order; tool rows and empty content skipped; epoch → ISO', async () => {
    const d = tdir();
    const dbPath = buildHermesFixture(d);
    const { sessions, diag } = await drain(hermesAdapter.parse(dbPath));
    // Session 3 is tool-only → skipped entirely.
    expect(sessions).toHaveLength(2);
    const [s1, s2] = sessions;
    expect(s1.meta.sessionId).toBe('hermes-fixture-1');
    expect(s1.meta.title).toBe('widget planning');
    expect(s1.meta.startedAt).toBe('2026-08-05T08:00:00.000Z');
    expect(s1.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s1.messages[0].text).toContain('widget-co launch checklist');
    // JSON block-array contents unwrap to text.
    expect(s2.meta.sessionId).toBe('hermes-fixture-2');
    expect(s2.messages.map((m) => m.text)).toEqual([
      'When is the acme-seed close?',
      'acme-seed closes at the end of the month.',
    ]);
    expect(diag.sessions).toBe(2);
    // The original store is untouched and still readable after copy-then-read.
    const again = await drain(hermesAdapter.parse(dbPath));
    expect(again.sessions).toHaveLength(2);
  });

  test('detect requires the sqlite magic', async () => {
    const d = tdir();
    const dbPath = buildHermesFixture(d);
    expect(hermesAdapter.detect(dbPath, readSample(dbPath))).toBe(true);
    const fake = join(d, 'fake.db');
    writeFileSync(fake, 'not a database');
    expect(hermesAdapter.detect(fake, readSample(fake))).toBe(false);
  });
});

// ── ChatGPT export adapter [mapping-tree walk: T13 edge fixture] ────────────

describe('chatgptExportAdapter', () => {
  test('canonical path via current_node; branches, tool nodes, and system-only convs never leak', async () => {
    const { sessions, diag } = await drain(chatgptExportAdapter.parse(CHATGPT_FIXTURE));
    // Conversation 3 is system-only → skipped.
    expect(sessions).toHaveLength(2);
    const [c1, c2] = sessions;
    expect(c1.meta.sessionId).toBe('cgpt-conv-0001');
    expect(c1.meta.title).toBe('Widget launch naming');
    expect(c1.meta.startedAt).toBe(new Date(1786080000 * 1000).toISOString());
    expect(c1.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const all = c1.messages.map((m) => m.text).join('\n');
    expect(all).toContain('Call it LaunchPanel.');
    expect(all).toContain('LaunchPanel works. Ship it Friday.');
    expect(all).not.toContain('BRANCH-A-ONLY-TEXT');
    expect(all).not.toContain('TOOL-ONLY-TEXT');
    // Fallback walk: no current_node, orphaned root pointer terminates quietly.
    expect(c2.meta.sessionId).toBe('cgpt-conv-0002');
    expect(c2.messages.map((m) => m.text)).toEqual([
      'Where did we land on pricing?',
      'Pricing lands at 49.',
    ]);
    expect(diag.sessions).toBe(2);
  });

  test('rejects a non-array file with an unzip-first error', async () => {
    const d = tdir();
    const p = join(d, 'not-export.json');
    writeFileSync(p, '{"mapping": {}}');
    await expect(drain(chatgptExportAdapter.parse(p))).rejects.toThrow(/unzip the export first/);
  });
});

// ── Claude.ai export adapter ────────────────────────────────────────────────

describe('claudeExportAdapter', () => {
  test('human→user mapping, empty-text rows skipped, empty threads skipped', async () => {
    const { sessions, diag } = await drain(claudeExportAdapter.parse(CLAUDE_EXPORT_FIXTURE));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.meta.sessionId).toBe('claude-conv-0001');
    expect(s.meta.title).toBe('Deal memo review');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[0].timestamp).toBe('2026-08-07T12:00:05.000Z');
    expect(diag.sessions).toBe(1);
  });
});

// ── Source hygiene regression [the NUL-byte class] ──────────────────────────

describe('adapter sources stay text-mode', () => {
  test('no raw NUL bytes in src/core/transcripts (git would flag binary, guards would skip)', () => {
    const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs');
    const dir = join(import.meta.dir, '..', 'src', 'core', 'transcripts');
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const buf = readFileSync(join(dir, f));
      expect(buf.includes(0)).toBe(false);
    }
  });
});

// ── Cross-format detection matrix ───────────────────────────────────────────

describe('detection matrix', () => {
  test('each fixture detects as its own format', async () => {
    const d = tdir();
    const dbPath = buildHermesFixture(d);
    const cases: Array<[string, TranscriptFormat]> = [
      [FIXTURE, 'claude-code'],
      [CODEX_FIXTURE, 'codex'],
      [AGENT_FIXTURE, 'openclaw'],
      [dbPath, 'hermes'],
      [CHATGPT_FIXTURE, 'chatgpt'],
      [CLAUDE_EXPORT_FIXTURE, 'claude-export'],
    ];
    for (const [path, format] of cases) {
      const r = detectAdapter(path);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.adapter.format).toBe(format);
    }
  });
});
