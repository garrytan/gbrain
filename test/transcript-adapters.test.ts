/**
 * transcript-adapters.test.ts — the cathedral-4 adapter seam.
 *
 * Carries the MANDATORY regression pin (plan T12): parseTranscript's output
 * on the shipped fixture is pinned EXACTLY — the hook session-end lane and
 * ambient hooks consume it, and the import lane's additive
 * parseClaudeSessionFile must never change it.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
import {
  grokAdapter,
  isGrokChatHistoryFile,
  isGrokSessionSidecar,
  mapGrokLine,
} from '../src/core/transcripts/grok.ts';
import { chatgptExportAdapter } from '../src/core/transcripts/chatgpt-export.ts';
import { claudeExportAdapter } from '../src/core/transcripts/claude-export.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { discoverTranscriptFiles, buildStatusRows } from '../src/core/transcripts/discover.ts';
import { redactSession } from '../src/core/transcripts/render.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { withEnv } from './helpers/with-env.ts';

const CHATGPT_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'chatgpt-conversations.json');
const CLAUDE_EXPORT_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'claude-export.json');

const FIXTURE = join(import.meta.dir, 'fixtures', 'conversation-formats', 'claude-code.jsonl');
const CODEX_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'codex-rollout.jsonl');
const GROK_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'grok-session', 'chat_history.jsonl');
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
    expect(
      buildTranscriptSlug('grok', '2026-08-08T11:00:00.000Z', { sessionId: 'grok-fixture-session-1' }),
    ).toMatch(/^conversations\/sessions\/2026-08-08-grok-[0-9a-f]{12}$/);
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
  test('covers the five harnesses and is override-injectable for tests', () => {
    const formats = harnessRoots().map((r) => r.format);
    expect(formats).toEqual(['claude-code', 'codex', 'openclaw', 'hermes', 'grok']);
    const injected = harnessRoots([{ format: 'codex', root: '/tmp/x', extension: '.jsonl' }]);
    expect(injected).toHaveLength(1);
    expect(injected[0].root).toBe('/tmp/x');
  });

  test('GROK_HOME relocates the grok session root (docs/mcp/GROK-CLI-PIN.md)', async () => {
    await withEnv({ GROK_HOME: '/tmp/grok-home-relocated' }, async () => {
      const grok = harnessRoots().find((r) => r.format === 'grok')!;
      expect(grok.root).toBe(join('/tmp/grok-home-relocated', 'sessions'));
    });
    await withEnv({ GROK_HOME: undefined }, async () => {
      const grok = harnessRoots().find((r) => r.format === 'grok')!;
      expect(grok.root.endsWith(join('.grok', 'sessions'))).toBe(true);
    });
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

// ── Grok adapter [chat_history.jsonl; sidecars skipped; no per-message times] ─

const GROK_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function writeGrokTree(
  root: string,
  opts: {
    cwd?: string;
    id?: string;
    body?: string;
    summary?: Record<string, unknown> | null;
    sidecars?: boolean;
  } = {},
): string {
  const cwd = opts.cwd ?? '/home/alice-example/agent-workspace';
  const id = opts.id ?? GROK_SESSION_ID;
  const sessionDir = join(root, encodeURIComponent(cwd), id);
  mkdirSync(sessionDir, { recursive: true });
  const p = join(sessionDir, 'chat_history.jsonl');
  writeFileSync(p, opts.body ?? readFileSync(GROK_FIXTURE, 'utf8'));
  if (opts.summary !== null) {
    const summary =
      opts.summary ??
      JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'transcripts', 'grok-session', 'summary.json'), 'utf8'));
    writeFileSync(join(sessionDir, 'summary.json'), JSON.stringify(summary));
  }
  if (opts.sidecars) {
    writeFileSync(join(sessionDir, 'updates.jsonl'), '{"timestamp":1,"method":"session/update","params":{}}\n');
    writeFileSync(join(sessionDir, 'events.jsonl'), '{"ts":1,"type":"turn_started"}\n');
    writeFileSync(join(root, encodeURIComponent(cwd), 'prompt_history.jsonl'), '{"timestamp":1,"session_id":"x","prompt":"hi"}\n');
  }
  return p;
}

describe('grokAdapter', () => {
  test('user/assistant text only; system, reasoning, tools, synthetic user never leak', async () => {
    const { sessions, diag } = await drain(grokAdapter.parse(GROK_FIXTURE));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.meta.harness).toBe('grok');
    expect(s.meta.sessionId).toBe('grok-fixture-session-1');
    expect(s.meta.cwd).toBe('/home/alice-example/agent-workspace');
    expect(s.meta.title).toBe('Widget seed round');
    expect(s.meta.model).toBe('grok-4.6-build');
    expect(s.meta.startedAt).toBe('2026-08-08T11:00:00.000Z');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(s.messages[0].text).toContain('Which fund led the widget-co seed');
    expect(s.messages[1].text).toContain('fund-a led the widget-co seed');
    expect(s.messages[0].timestamp).toBe('2026-08-08T11:00:00.000Z');
    expect(s.messages[3].timestamp).toBe('2026-08-08T11:05:00.000Z');
    const all = s.messages.map((m) => m.text).join('\n');
    expect(all).not.toContain('SYSTEM-ONLY-TEXT');
    expect(all).not.toContain('REASONING-ONLY-TEXT');
    expect(all).not.toContain('TOOL-OUTPUT-ONLY-TEXT');
    expect(all).not.toContain('SYNTHETIC-ONLY-TEXT');
    expect(diag.sessions).toBe(1);
    expect(diag.skippedLines).toBe(1);
    expect(diag.expectedEmpty).toBe(false);
  });

  test('cwd is url-decoded from the session-store path when summary is absent', async () => {
    const p = writeGrokTree(tdir(), { summary: null });
    const { sessions } = await drain(grokAdapter.parse(p));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].meta.sessionId).toBe(GROK_SESSION_ID);
    expect(sessions[0].meta.cwd).toBe('/home/alice-example/agent-workspace');
  });

  test('summary.json present → session times carry summary.json provenance', async () => {
    const { sessions } = await drain(grokAdapter.parse(GROK_FIXTURE));
    expect(sessions[0].meta.raw?.timestamp_source).toBe('summary.json');
  });

  test('missing summary.json (in-progress session / partial rsync) imports with file-mtime provenance; no drift, no per-file error', async () => {
    // Grok writes summary.json at session END, so a live session — or a
    // partial rsync — has none. Pre-fix the session parsed and yielded, then
    // render refused it ('carries no timestamps') → per-file error →
    // cleanScan=false → the --since-last watermark froze for the WHOLE grok
    // root on every run. The log file's mtime is a real filesystem time for
    // this file; it is used and STAMPED as such, never presented as a
    // summary time.
    const p = writeGrokTree(tdir(), { summary: null });
    const mtimeIso = statSync(p).mtime.toISOString();
    const { sessions, diag } = await drain(grokAdapter.parse(p));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.meta.startedAt).toBe(mtimeIso);
    expect(s.meta.raw?.timestamp_source).toBe('file_mtime');
    expect(s.messages.length).toBeGreaterThan(0);
    expect(s.messages.every((m) => m.timestamp === mtimeIso)).toBe(true);
    expect(diag.sessions).toBe(1);
    expect(diag.expectedEmpty).toBe(false);

    const r = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect(r.sessionsSeen).toBe(1);
    expect(r.sessionsErrored).toBe(0);
    expect(r.erroredFiles).toBe(0);
    expect(r.driftFiles).toBe(0);
    expect(r.files[0].error).toBeUndefined();
    expect(r.pages.planned).toBeGreaterThan(0);
  });

  test('a malformed summary.json is ignored: sessionId from the UUID dir, no summary title/model, mtime provenance', async () => {
    const p = writeGrokTree(tdir(), { summary: null });
    writeFileSync(join(p, '..', 'summary.json'), '{"info": {"id": "should-not-win", ');
    const mtimeIso = statSync(p).mtime.toISOString();
    const { sessions, diag } = await drain(grokAdapter.parse(p));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.meta.sessionId).toBe(GROK_SESSION_ID);
    expect(s.meta.title).toBeUndefined();
    expect(s.meta.model).toBeUndefined();
    // Nothing from the broken sidecar leaks into the times: the log's own
    // mtime is used and STAMPED as such (never presented as a summary time).
    expect(s.meta.raw?.timestamp_source).toBe('file_mtime');
    expect(s.meta.startedAt).toBe(mtimeIso);
    expect(diag.sessions).toBe(1);
    expect(diag.expectedEmpty).toBe(false);
  });

  test("created_at 'yesterday' is never parsed into a fabricated timestamp", async () => {
    // With a valid last_active_at, that real source time owns the session.
    const withLast = writeGrokTree(tdir(), {
      summary: {
        info: { id: GROK_SESSION_ID, cwd: '/tmp' },
        created_at: 'yesterday',
        last_active_at: '2026-08-08T11:05:00.000Z',
      },
    });
    const a = (await drain(grokAdapter.parse(withLast))).sessions[0];
    expect(a.meta.startedAt).toBe('2026-08-08T11:05:00.000Z');
    expect(a.meta.raw?.timestamp_source).toBe('summary.json');
    for (const m of a.messages) {
      expect(m.timestamp).toBe('2026-08-08T11:05:00.000Z');
      expect(Number.isNaN(new Date(m.timestamp).getTime())).toBe(false);
    }

    // With ONLY the unparseable created_at, no summary time exists at all →
    // file-mtime provenance, never 'Invalid Date' / NaN.
    const onlyBad = writeGrokTree(tdir(), {
      summary: { info: { id: GROK_SESSION_ID, cwd: '/tmp' }, created_at: 'yesterday' },
    });
    const mtimeIso = statSync(onlyBad).mtime.toISOString();
    const b = (await drain(grokAdapter.parse(onlyBad))).sessions[0];
    expect(b.meta.startedAt).toBe(mtimeIso);
    expect(b.meta.raw?.timestamp_source).toBe('file_mtime');
    expect(b.messages.every((m) => m.timestamp === mtimeIso)).toBe(true);
    expect(JSON.stringify(b)).not.toContain('Invalid Date');
  });

  test('an oversized (70k) system head still detects via the truncated-line sniff; a claude-family key in it → false', () => {
    const d = tdir();
    const big = 'a'.repeat(70_000);
    const rest =
      '\n' +
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello' }] }) +
      '\n' +
      JSON.stringify({ type: 'assistant', content: 'hi', model_id: 'grok-4.6-build' }) +
      '\n';
    // Not named chat_history.jsonl and no UUID segment → the head sniff is
    // the only signal; the 64KB sample truncates the first line mid-string.
    const grokPath = join(d, 'exported-session.jsonl');
    writeFileSync(grokPath, JSON.stringify({ type: 'system', content: big }) + rest);
    const sample = readSample(grokPath);
    expect(sample.length).toBeLessThan(70_000);
    expect(grokAdapter.detect(grokPath, sample)).toBe(true);

    const claudePath = join(d, 'claude-led-session.jsonl');
    writeFileSync(
      claudePath,
      JSON.stringify({ type: 'system', sessionId: 'abc-123', content: big }) + rest,
    );
    expect(grokAdapter.detect(claudePath, readSample(claudePath))).toBe(false);
  });

  test('a percent-encoded cwd segment that fails decodeURIComponent → cwd undefined, sessionId still set', async () => {
    const d = tdir();
    const badEncoded = '%E0%A4%A'; // truncated multibyte escape → URIError
    expect(() => decodeURIComponent(badEncoded)).toThrow();
    const sessionDir = join(d, badEncoded, GROK_SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    const p = join(sessionDir, 'chat_history.jsonl');
    writeFileSync(p, readFileSync(GROK_FIXTURE, 'utf8'));
    const { sessions } = await drain(grokAdapter.parse(p));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].meta.sessionId).toBe(GROK_SESSION_ID);
    expect(sessions[0].meta.cwd).toBeUndefined();
    expect(sessions[0].meta.raw?.cwd).toBeNull();
  });

  test('a summary-less session outside a UUID dir gets a stable path-hash id, not the literal "chat_history"', async () => {
    const d = tdir();
    const body =
      JSON.stringify({ type: 'system', content: 'sys' }) +
      '\n' +
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello there' }] }) +
      '\n' +
      JSON.stringify({ type: 'assistant', content: 'hi', model_id: 'grok-4.6-build' }) +
      '\n';
    mkdirSync(join(d, 'not-a-uuid'), { recursive: true });
    mkdirSync(join(d, 'other-dir'), { recursive: true });
    const p1 = join(d, 'not-a-uuid', 'chat_history.jsonl');
    const p2 = join(d, 'other-dir', 'chat_history.jsonl');
    writeFileSync(p1, body);
    writeFileSync(p2, body);
    const a = (await drain(grokAdapter.parse(p1))).sessions[0];
    const b = (await drain(grokAdapter.parse(p1))).sessions[0];
    const c = (await drain(grokAdapter.parse(p2))).sessions[0];
    expect(a.meta.sessionId).not.toBe('chat_history');
    expect(a.meta.sessionId).toMatch(/^grok-[0-9a-f]{16}$/);
    expect(b.meta.sessionId).toBe(a.meta.sessionId); // stable across parses
    expect(c.meta.sessionId).not.toBe(a.meta.sessionId); // distinct per path
  });

  test('rejects (never tail-reads) a chat_history.jsonl over the cap', async () => {
    await expect(drain(grokAdapter.parse(GROK_FIXTURE, { maxBytes: 64 }))).rejects.toThrow(/too large/);
  });

  test('a file of ONLY malformed lines is REAL drift (expectedEmpty=false, driftFiles=1)', async () => {
    const p = writeGrokTree(tdir(), {
      body: 'not json at all\n{"type":"user","content":[{"type":"text","text":"broken\n',
      summary: {
        info: { id: GROK_SESSION_ID, cwd: '/tmp' },
        created_at: '2026-08-08T11:00:00.000Z',
      },
    });
    const { sessions, diag } = await drain(grokAdapter.parse(p));
    expect(sessions).toHaveLength(0);
    expect(diag.sessions).toBe(0);
    expect(diag.skippedLines).toBe(2);
    expect(diag.expectedEmpty).toBe(false);
    const r = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect(r.driftFiles).toBe(1);
    expect(r.sessionsSeen).toBe(0);
    expect(r.cleanScan).toBe(false);
  });

  test('user rows whose text sits under an unknown field are MALFORMED, not typed: expectedEmpty=false, driftFiles=1', async () => {
    // Schema-drift shape: recognised `type:'user'` rows whose text moved off
    // `content`. Pre-fix these mapped to 'typed' — indistinguishable from
    // intentional tool/reasoning rows — so the file read as expectedEmpty and
    // ingestion advanced the watermark past it silently (disappearing
    // conversations). Undecodable HUMAN turns count as skipped lines.
    const p = writeGrokTree(tdir(), {
      body:
        JSON.stringify({ type: 'system', content: 'sys' }) +
        '\n' +
        JSON.stringify({ type: 'user', text: 'hello there' }) +
        '\n' +
        JSON.stringify({ type: 'user', text: 'and again' }) +
        '\n',
      summary: {
        info: { id: GROK_SESSION_ID, cwd: '/tmp' },
        created_at: '2026-08-08T11:00:00.000Z',
      },
    });
    const { sessions, diag } = await drain(grokAdapter.parse(p));
    expect(sessions).toHaveLength(0);
    expect(diag.sessions).toBe(0);
    expect(diag.skippedLines).toBe(2);
    expect(diag.expectedEmpty).toBe(false);
    expect(diag.zeroSessionsReason).toMatch(/malformed/);
    const r = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect(r.driftFiles).toBe(1);
    expect(r.sessionsSeen).toBe(0);
    expect(r.cleanScan).toBe(false);
  });

  test('mapGrokLine: undecodable human turns are malformed; intentional tool-only turns stay typed', () => {
    expect(mapGrokLine({ type: 'user' }).kind).toBe('malformed');
    expect(mapGrokLine({ type: 'user', content: 42 }).kind).toBe('malformed');
    expect(mapGrokLine({ type: 'user', content: ['not-a-block'] }).kind).toBe('malformed');
    expect(mapGrokLine({ type: 'assistant', content: [{ type: 'text', text: 'moved into blocks' }] }).kind).toBe('malformed');
    expect(mapGrokLine({ type: 'assistant' }).kind).toBe('malformed');
    // Intentional shapes keep their classification.
    expect(mapGrokLine({ type: 'user', synthetic_reason: 'system_reminder', content: [{ type: 'text', text: 'x' }] }).kind).toBe('typed');
    expect(mapGrokLine({ type: 'user', content: [{ type: 'tool_result', tool_call_id: 'c1', content: 'out' }] }).kind).toBe('typed');
    expect(mapGrokLine({ type: 'user', content: [] }).kind).toBe('typed');
    expect(mapGrokLine({ type: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'search', arguments: '{}' }] }).kind).toBe('typed');
    expect(mapGrokLine({ type: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'search', arguments: '{}' }] }).kind).toBe('typed');
    expect(mapGrokLine({ type: 'reasoning', id: 'r' }).kind).toBe('typed');
    expect(mapGrokLine({ type: 'unknown_row_type' }).kind).toBe('skip');
  });

  test('redaction runs on grok text the same as every other format', async () => {
    const planted = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const p = writeGrokTree(tdir(), {
      body:
        JSON.stringify({ type: 'system', content: 'sys' }) +
        '\n' +
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: `key ${planted}` }] }) +
        '\n' +
        JSON.stringify({ type: 'assistant', content: 'ok', model_id: 'grok-4.6-build' }) +
        '\n',
      summary: {
        info: { id: GROK_SESSION_ID, cwd: '/tmp' },
        created_at: '2026-08-08T11:00:00.000Z',
        last_active_at: '2026-08-08T11:00:01.000Z',
      },
    });
    const { sessions } = await drain(grokAdapter.parse(p));
    const redacted = redactSession(sessions[0], { userPatternsPath: '/nonexistent' });
    expect(redacted.redactionCount).toBeGreaterThan(0);
    expect(redacted.session.messages[0].text).not.toContain(planted);
  });

  test('empty (system-only) session explains itself and is not host-format drift', async () => {
    const p = writeGrokTree(tdir(), {
      body: JSON.stringify({ type: 'system', content: 'SYSTEM-ONLY-TEXT' }) + '\n',
      summary: {
        info: { id: GROK_SESSION_ID, cwd: '/tmp' },
        created_at: '2026-08-08T11:00:00.000Z',
      },
    });
    const { sessions, diag } = await drain(grokAdapter.parse(p));
    expect(sessions).toHaveLength(0);
    expect(diag.sessions).toBe(0);
    expect(diag.bytesRead).toBeGreaterThan(0);
    expect(diag.expectedEmpty).toBe(true);
    expect(diag.zeroSessionsReason).toMatch(/tool\/reasoning-only|no user\/assistant text/);
    const r = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect(r.driftFiles).toBe(0);
    expect(r.sessionsSeen).toBe(0);
  });

  test('malformed lines are skipped and the rest of the session still imports', async () => {
    const { diag } = await drain(grokAdapter.parse(GROK_FIXTURE));
    expect(diag.skippedLines).toBe(1);
    expect(diag.sessions).toBe(1);
  });

  test('detect matches chat_history.jsonl and the system-head sniff; sidecars are rejected', () => {
    expect(grokAdapter.detect(GROK_FIXTURE, readSample(GROK_FIXTURE))).toBe(true);
    expect(grokAdapter.detect(CODEX_FIXTURE, readSample(CODEX_FIXTURE))).toBe(false);
    expect(grokAdapter.detect(FIXTURE, readSample(FIXTURE))).toBe(false);
    const d = tdir();
    const sidecar = join(d, GROK_SESSION_ID, 'updates.jsonl');
    mkdirSync(join(d, GROK_SESSION_ID), { recursive: true });
    writeFileSync(sidecar, '{"timestamp":1}\n');
    expect(isGrokSessionSidecar(sidecar)).toBe(true);
    expect(grokAdapter.detect(sidecar, readSample(sidecar))).toBe(false);
    expect(isGrokChatHistoryFile(GROK_FIXTURE)).toBe(true);
    // Nested scratch under the session UUID (Grok's terminal/ logs) must
    // also count as sidecars — a parent-only check misses them.
    const nested = join(d, GROK_SESSION_ID, 'terminal', 'call-1.log');
    mkdirSync(join(d, GROK_SESSION_ID, 'terminal'), { recursive: true });
    writeFileSync(nested, 'not json\n');
    expect(isGrokSessionSidecar(nested)).toBe(true);
  });

  test('auto-detect picks grok for the fixture and for the session-store path shape', () => {
    const r = detectAdapter(GROK_FIXTURE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adapter.format).toBe('grok');
    const p = writeGrokTree(tdir(), { sidecars: true });
    const r2 = detectAdapter(p);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.adapter.format).toBe('grok');
  });

  test('discovery keeps chat_history.jsonl and drops sidecars; status gap uses parent UUID', async () => {
    const root = tdir();
    const p = writeGrokTree(root, { sidecars: true });
    const roots = [{ format: 'grok' as const, root, extension: '.jsonl' as const }];
    const discovered = discoverTranscriptFiles(roots);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].path).toBe(p);
    const imported = { byHarness: new Map([['grok', new Set([GROK_SESSION_ID])]]), pagesScanned: 1 };
    const rows = buildStatusRows(discovered, imported, roots);
    const grok = rows.find((x) => x.format === 'grok')!;
    expect(grok.found).toBe(1);
    expect(grok.importedSessions).toBe(1);
    expect(grok.gapFiles).toBe(0);
    const empty = { byHarness: new Map<string, Set<string>>(), pagesScanned: 0 };
    expect(buildStatusRows(discovered, empty, roots).find((x) => x.format === 'grok')!.gapFiles).toBe(1);
  });

  test('a claude-code session led by a system row is NOT stolen by the grok head sniff', () => {
    // Claude Code writes `type:'system'` rows (string `content`, plus the
    // claude-family keys sessionId/uuid/parentUuid). Pre-fix the grok head
    // sniff claimed any .jsonl whose first line was {type:'system',
    // content:string}; every claude row then mapped to 'typed', so the
    // session parsed to zero messages with expectedEmpty=true — silently
    // swallowed instead of imported.
    const d = tdir();
    const p = join(d, 'claude-system-head.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          sessionId: 's-red-1',
          type: 'system',
          content: 'Session hook fired',
          uuid: 'sys-0001',
          timestamp: '2026-08-10T08:00:00.000Z',
        }),
        JSON.stringify({
          parentUuid: 'sys-0001',
          isSidechain: false,
          sessionId: 's-red-1',
          type: 'user',
          message: { role: 'user', content: 'A real question' },
          uuid: 'u-0001',
          timestamp: '2026-08-10T08:00:01.000Z',
        }),
        JSON.stringify({
          parentUuid: 'u-0001',
          isSidechain: false,
          sessionId: 's-red-1',
          type: 'assistant',
          message: { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'A real answer' }] },
          uuid: 'a-0001',
          timestamp: '2026-08-10T08:00:02.000Z',
        }),
      ].join('\n') + '\n',
    );
    expect(grokAdapter.detect(p, readSample(p))).toBe(false);
    const r = detectAdapter(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adapter.format).toBe('claude-code');
  });

  test('the grok skip is format-scoped: a bare-UUID dir in another harness root hides nothing', () => {
    // Triage rework for the adoption: an openclaw (or any non-grok) tree
    // whose path happens to contain a UUID directory segment must still
    // surface its sessions — the sidecar heuristic applies only under the
    // grok root.
    const root = tdir();
    const nested = join(root, GROK_SESSION_ID);
    mkdirSync(nested, { recursive: true });
    const sessionPath = join(nested, 'legit-session.jsonl');
    writeFileSync(
      sessionPath,
      JSON.stringify({ type: 'session', version: 3, id: 's-1', timestamp: '2026-08-10T08:00:00.000Z', cwd: '/tmp' }) + '\n',
    );
    const discovered = discoverTranscriptFiles([
      { format: 'openclaw', root, extension: '.jsonl' },
    ]);
    expect(discovered.map((d) => d.path)).toEqual([sessionPath]);
  });

  test('mapGrokLine classifies synthetic user and tool-only assistant as typed skips', () => {
    expect(mapGrokLine({ type: 'user', synthetic_reason: 'system_reminder', content: [{ type: 'text', text: 'x' }] }).kind).toBe('typed');
    expect(mapGrokLine({ type: 'assistant', content: '', tool_calls: [{ id: 'c' }] }).kind).toBe('typed');
    expect(mapGrokLine({ type: 'reasoning', id: 'r' }).kind).toBe('typed');
    const msg = mapGrokLine({ type: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(msg.kind).toBe('message');
    if (msg.kind === 'message') expect(msg.message.text).toBe('hello');
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
      [GROK_FIXTURE, 'grok'],
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
