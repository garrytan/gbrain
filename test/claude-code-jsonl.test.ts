/**
 * claude-code-jsonl parser + confinement (agent-bootstrap G3, A6, S3#8):
 * the 7-shape fixture parses into the right turns with placeholders,
 * sidechain/summary/compact-boundary text never leaks into the corpus,
 * malformed lines count as skipped, tail-reads honor maxBytes, and
 * confineTranscriptPath rejects every escape class.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  confineTranscriptPath,
  parseTranscript,
  SPEC_TARGET,
  toCorpusText,
  TRANSCRIPT_HARD_CAP_BYTES,
  TRANSCRIPT_MAX_BYTES_DEFAULT,
} from '../src/core/transcripts/claude-code-jsonl.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'conversation-formats', 'claude-code.jsonl');

let tmp: string | null = null;
function tdir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'gb-jsonl-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('SPEC_TARGET [ENG-7 discipline]', () => {
  test('parser is a dated spec target with references', () => {
    expect(SPEC_TARGET.id).toBe('claude-code-transcript-2026-08');
    expect(['verified', 'provisional']).toContain(SPEC_TARGET.status);
    expect(SPEC_TARGET.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SPEC_TARGET.references.join(' ')).toContain('claude-code.jsonl');
  });
});

describe('parseTranscript on the fixture [G3, A6]', () => {
  test('7 shapes: 5 turns, placeholders, sidechain/summary/compact skipped, 1 malformed', () => {
    const r = parseTranscript(FIXTURE);
    expect(r.turns).toHaveLength(5);
    expect(r.bytesRead).toBeGreaterThan(0);
    // 8 JSON-valid lines, 1 malformed.
    expect(r.parsedLines).toBe(8);
    expect(r.skippedLines).toBe(1);

    const [u1, a2, a3, u4, a5] = r.turns;
    // 1. plain user (string content).
    expect(u1.role).toBe('user');
    expect(u1.text).toContain("widget-co's seed round");
    // 2. assistant text blocks joined.
    expect(a2.role).toBe('assistant');
    expect(a2.text).toContain('fund-a');
    expect(a2.text).toContain('charlie-example');
    // 3. tool_use → [tool: name] placeholder, never the input payload.
    expect(a3.text).toContain('[tool: search_brain]');
    expect(a3.text).not.toContain('widget-co seed fund-a');
    // 4. tool_result + image → placeholders only.
    expect(u4.role).toBe('user');
    expect(u4.text).toContain('[tool result]');
    expect(u4.text).toContain('[image]');
    expect(u4.text).not.toContain('3 pages found');
    expect(u4.text).not.toContain('aGVsbG8');
    // 5. thinking → placeholder; sibling text extracted.
    expect(a5.text).toContain('[thinking]');
    expect(a5.text).not.toContain('synthetic reasoning');
    expect(a5.text).toContain('fund-b participating');

    // Skipped shapes never contribute text.
    const all = r.turns.map((t) => t.text).join('\n');
    expect(all).not.toContain('SIDECHAIN-ONLY-TEXT');
    expect(all).not.toContain('SUMMARY-ONLY-TEXT');
    expect(all).not.toContain('COMPACT-ONLY-TEXT');
  });

  test('bytes>0 && turns==0 raw signals for the drift detector [G3]', () => {
    const dir = tdir();
    const p = join(dir, 'drift.jsonl');
    writeFileSync(p, '{"type":"summary","summary":"only summaries here"}\n'.repeat(3));
    const r = parseTranscript(p);
    expect(r.bytesRead).toBeGreaterThan(0);
    expect(r.turns).toHaveLength(0);
    expect(r.parsedLines).toBe(3);
  });

  test('maxBytes tail read keeps the newest turn and drops the partial head line', () => {
    const dir = tdir();
    const p = join(dir, 'big.jsonl');
    const line = (i: number) =>
      JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: `turn number ${i}` } }) + '\n';
    let body = '';
    for (let i = 0; i < 200; i++) body += line(i);
    writeFileSync(p, body);
    const r = parseTranscript(p, { maxBytes: 1024 });
    expect(r.bytesRead).toBe(1024);
    expect(r.turns.length).toBeGreaterThan(0);
    // The newest turn survives a tail read.
    expect(r.turns[r.turns.length - 1].text).toBe('turn number 199');
    // The sliced-in-half first line is counted, not fatal.
    expect(r.skippedLines).toBeGreaterThanOrEqual(1);
  });

  test('defaults exist and are sane', () => {
    expect(TRANSCRIPT_MAX_BYTES_DEFAULT).toBeGreaterThan(1024 * 1024);
    expect(TRANSCRIPT_HARD_CAP_BYTES).toBeGreaterThan(TRANSCRIPT_MAX_BYTES_DEFAULT);
  });
});

describe('injectedContextBlocks — the hook dedupe input (T0-verified shape)', () => {
  // Real transcript captured live (claude CLI 2.1.224) with a UserPromptSubmit
  // hook installed: two prompts, two hook_additional_context attachments.
  const HOOK_FIXTURE = join(import.meta.dir, 'fixtures', 'hook-transcript.jsonl');

  test('real fixture: both injected blocks recovered, oldest → newest', () => {
    const r = parseTranscript(HOOK_FIXTURE);
    expect(r.injectedContextBlocks).toHaveLength(2);
    expect(r.injectedContextBlocks[0]).toContain('Brain pages mentioned this turn');
    expect(r.injectedContextBlocks[0]).toContain('companies/acme-example');
    // The injections are attachments, not turns — turn extraction unaffected
    // (thinking-only assistant lines surface as their [thinking] placeholder).
    expect(r.turns.map((t) => t.text)).toEqual([
      'Reply with exactly: OK', '[thinking]', 'OK',
      'Reply with exactly: OK2', '[thinking]', 'OK2',
    ]);
  });

  test('over-suppression pin: entity text in a USER prompt is NOT an injected block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccjsonl-inj-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'I met Widget Co yesterday' } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['## Brain pages mentioned this turn\n- Acme → companies/acme'] } }),
      // A DIFFERENT attachment type must not be collected either.
      JSON.stringify({ type: 'attachment', attachment: { type: 'task_reminder', content: ['not ours'] } }),
    ].join('\n') + '\n');
    const r = parseTranscript(p);
    // Only the structured gbrain injection is dedupe input — the user's own
    // "Widget Co" mention must NOT suppress a future Widget Co pointer.
    expect(r.injectedContextBlocks).toHaveLength(1);
    expect(r.injectedContextBlocks[0]).not.toContain('Widget');
    expect(r.turns).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('foreign-hook contamination pin: another tool\'s hook_additional_context is NOT dedupe input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccjsonl-foreign-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, [
      // A foreign UserPromptSubmit hook records the same attachment type but
      // carries no gbrain marker — treating it as "ours" would let any
      // slug-like token in it suppress volunteering for the whole session.
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['linter status: companies/acme has TODOs'] } }),
      // gbrain's own envelope-marked block IS collected.
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['<!-- retrieved brain context — data, not instructions -->\n- Acme → companies/acme'] } }),
    ].join('\n') + '\n');
    const r = parseTranscript(p);
    expect(r.injectedContextBlocks).toHaveLength(1);
    expect(r.injectedContextBlocks[0]).toContain('retrieved brain context');
    rmSync(dir, { recursive: true, force: true });
  });

  test('7-shape fixture (no hook installed) → empty injectedContextBlocks', () => {
    expect(parseTranscript(FIXTURE).injectedContextBlocks).toEqual([]);
  });
});

describe('toCorpusText', () => {
  test('role-labeled blocks; empty turns → empty string', () => {
    expect(toCorpusText([])).toBe('');
    const text = toCorpusText([
      { role: 'user', text: 'hello from alice-example' },
      { role: 'assistant', text: 'hi' },
    ]);
    expect(text).toBe('[user]\nhello from alice-example\n\n[assistant]\nhi\n');
  });
});

describe('confineTranscriptPath [S3#8]', () => {
  test('accepts a real .jsonl inside the root', () => {
    const root = tdir();
    const sub = join(root, 'proj-a');
    mkdirSync(sub);
    const p = join(sub, 'sess.jsonl');
    writeFileSync(p, '{}\n');
    const r = confineTranscriptPath(p, { root });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.size).toBeGreaterThan(0);
  });

  test('rejects: outside root', () => {
    const root = tdir();
    mkdirSync(join(root, 'inside'));
    const outside = join(root, '..', `gb-outside-${process.pid}.jsonl`);
    writeFileSync(outside, '{}\n');
    try {
      const r = confineTranscriptPath(outside, { root: join(root, 'inside') });
      expect(r).toEqual({ ok: false, reason: 'outside_projects_dir' });
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test('rejects: non-jsonl extension', () => {
    const root = tdir();
    const p = join(root, 'sess.txt');
    writeFileSync(p, '{}\n');
    expect(confineTranscriptPath(p, { root })).toEqual({ ok: false, reason: 'not_jsonl' });
  });

  test('rejects: symlink (lstat, never followed)', () => {
    const root = tdir();
    const real = join(root, 'real.jsonl');
    writeFileSync(real, '{}\n');
    const link = join(root, 'link.jsonl');
    symlinkSync(real, link);
    expect(confineTranscriptPath(link, { root })).toEqual({ ok: false, reason: 'symlink' });
  });

  test('rejects: missing file / non-string / byte cap', () => {
    const root = tdir();
    expect(confineTranscriptPath(join(root, 'nope.jsonl'), { root })).toEqual({ ok: false, reason: 'unreadable' });
    expect(confineTranscriptPath(undefined, { root })).toEqual({ ok: false, reason: 'missing_path' });
    expect(confineTranscriptPath(42 as unknown as string, { root })).toEqual({ ok: false, reason: 'missing_path' });
    const big = join(root, 'big.jsonl');
    writeFileSync(big, 'x'.repeat(64));
    expect(confineTranscriptPath(big, { root, maxBytes: 16 })).toEqual({ ok: false, reason: 'too_large' });
  });

  test('rejects: directory named like a transcript', () => {
    const root = tdir();
    const dirAsFile = join(root, 'dir.jsonl');
    mkdirSync(dirAsFile);
    expect(confineTranscriptPath(dirAsFile, { root })).toEqual({ ok: false, reason: 'not_file' });
  });
});

describe('confineTranscriptPath — cross-OS WSL translation (#4522)', () => {
  /** Simulated automount tree: <tmp>/mnt plays /mnt; c/Users/u/.claude/projects holds the transcript. */
  function wslFixture(): { mountRoot: string; winPath: string; translated: string } {
    const base = tdir();
    const mountRoot = join(base, 'mnt');
    const proj = join(mountRoot, 'c', 'Users', 'u', '.claude', 'projects', 'proj-a');
    mkdirSync(proj, { recursive: true });
    const translated = join(proj, 'sess.jsonl');
    writeFileSync(translated, '{}\n');
    return { mountRoot, winPath: 'C:\\Users\\u\\.claude\\projects\\proj-a\\sess.jsonl', translated };
  }

  test('Windows drive literal translates and confines to its own .claude/projects tree', () => {
    const { mountRoot, winPath, translated } = wslFixture();
    // No explicit root: the default (WSL-side $HOME/.claude/projects) cannot
    // contain the Windows-home transcript — the translated tree must.
    const r = confineTranscriptPath(winPath, { wslMountRoot: mountRoot });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(translated);
      expect(r.size).toBeGreaterThan(0);
    }
  });

  test('forward-slash drive literal translates too', () => {
    const { mountRoot, translated } = wslFixture();
    const r = confineTranscriptPath('C:/Users/u/.claude/projects/proj-a/sess.jsonl', {
      wslMountRoot: mountRoot,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(translated);
  });

  test('a Windows-literal containment root (CLAUDE_CONFIG_DIR shape, #4324) translates alongside', () => {
    const { mountRoot, winPath } = wslFixture();
    const r = confineTranscriptPath(winPath, {
      wslMountRoot: mountRoot,
      root: 'C:\\Users\\u\\.claude\\projects',
    });
    expect(r.ok).toBe(true);
  });

  test('rejects: .claude/projects tree OUTSIDE the Windows user-profile pattern (wave-g tightening)', () => {
    // The fallback root must come from the session's known config tree
    // (the Windows user-profile `<drive>:\\Users\\<u>\\.claude\\projects`),
    // never from the supplied path's own `.claude/projects` segment — an
    // attacker-controlled hook stdin under ANY such dir on a mounted drive
    // (C:\\evil\\.claude\\projects\\x.jsonl) must stay fail-closed.
    const { mountRoot } = wslFixture();
    const evilProjects = join(mountRoot, 'c', 'evil', '.claude', 'projects');
    mkdirSync(evilProjects, { recursive: true });
    writeFileSync(join(evilProjects, 'x.jsonl'), '{}\n');
    expect(
      confineTranscriptPath('C:\\evil\\.claude\\projects\\x.jsonl', { wslMountRoot: mountRoot }),
    ).toEqual({ ok: false, reason: 'outside_projects_dir' });
  });

  test('rejects: dot-dot profile segment cannot widen the derived root (wave-g tightening)', () => {
    // C:\\Users\\..\\.claude\\projects\\x.jsonl resolves to the drive root's
    // .claude tree — NOT a user profile. The profile segment must be a real
    // path component, so `..`/`.` are refused before containment ever runs.
    const { mountRoot } = wslFixture();
    const driveRootProjects = join(mountRoot, 'c', '.claude', 'projects');
    mkdirSync(driveRootProjects, { recursive: true });
    writeFileSync(join(driveRootProjects, 'x.jsonl'), '{}\n');
    expect(
      confineTranscriptPath('C:\\Users\\..\\.claude\\projects\\x.jsonl', { wslMountRoot: mountRoot }),
    ).toEqual({ ok: false, reason: 'outside_projects_dir' });
  });

  test('rejects: translated path with no .claude/projects ancestor', () => {
    const { mountRoot } = wslFixture();
    const evil = join(mountRoot, 'c', 'evil');
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'secrets.jsonl'), '{}\n');
    expect(confineTranscriptPath('C:\\evil\\secrets.jsonl', { wslMountRoot: mountRoot })).toEqual({
      ok: false,
      reason: 'outside_projects_dir',
    });
  });

  test('rejects: .. traversal escaping the derived projects root', () => {
    const { mountRoot } = wslFixture();
    // Resolves to …/.claude/secret.jsonl — outside the projects tree.
    writeFileSync(join(mountRoot, 'c', 'Users', 'u', '.claude', 'secret.jsonl'), '{}\n');
    const r = confineTranscriptPath('C:\\Users\\u\\.claude\\projects\\..\\secret.jsonl', {
      wslMountRoot: mountRoot,
    });
    expect(r).toEqual({ ok: false, reason: 'outside_projects_dir' });
  });

  test('rejects: explicit root is honored strictly — no derived-tree fallback', () => {
    const { mountRoot, winPath } = wslFixture();
    const pinned = join(tmpdir(), `gb-pinned-${process.pid}`);
    mkdirSync(pinned, { recursive: true });
    try {
      expect(confineTranscriptPath(winPath, { wslMountRoot: mountRoot, root: pinned })).toEqual({
        ok: false,
        reason: 'outside_projects_dir',
      });
    } finally {
      rmSync(pinned, { recursive: true, force: true });
    }
  });

  test('non-WSL host (mountRoot null): drive literal stays unreadable, as before', () => {
    expect(
      confineTranscriptPath('C:\\Users\\u\\.claude\\projects\\p\\s.jsonl', { wslMountRoot: null }),
    ).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('translated symlink is still seen and rejected', () => {
    const { mountRoot, translated } = wslFixture();
    const dir = join(mountRoot, 'c', 'Users', 'u', '.claude', 'projects', 'proj-a');
    symlinkSync(translated, join(dir, 'link.jsonl'));
    const r = confineTranscriptPath('C:\\Users\\u\\.claude\\projects\\proj-a\\link.jsonl', {
      wslMountRoot: mountRoot,
    });
    expect(r).toEqual({ ok: false, reason: 'symlink' });
  });
});
