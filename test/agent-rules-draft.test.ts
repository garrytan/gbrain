import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// N-1 first slice: docs/MBRAIN_AGENT_RULES.next.md is an owner-reviewable DRAFT
// of the five-surface rules restructure. The full cut is gated on an EV-2 A/B
// eval, so the draft must NOT replace or be wired into the live rules file.
// This test fences both halves: the draft keeps every load-bearing invariant,
// and setup-agent keeps injecting the live file.

const repoRoot = new URL('..', import.meta.url).pathname;
const draftPath = join(repoRoot, 'docs', 'MBRAIN_AGENT_RULES.next.md');
const livePath = join(repoRoot, 'docs', 'MBRAIN_AGENT_RULES.md');
const setupAgentPath = join(repoRoot, 'src', 'commands', 'setup-agent.ts');

describe('agent rules draft (N-1)', () => {
  test('draft file exists', () => {
    expect(existsSync(draftPath)).toBe(true);
  });

  test('draft is marked as a non-live draft gated on EV-2', () => {
    const draft = readFileSync(draftPath, 'utf-8');
    expect(draft).toContain('DRAFT');
    expect(draft).toContain('EV-2');
    expect(draft).toContain('Do not inject');
  });

  test('draft preserves every load-bearing behavioral invariant', () => {
    const draft = readFileSync(draftPath, 'utf-8');
    const anchors = [
      // evidence boundary
      'retrieve_context',
      '`read_context --selectors',
      'canonical evidence boundary',
      // pointers-not-evidence
      'candidate_signals',
      'not answer evidence',
      'targetless candidates are never evidence',
      // Codex lazy-loading caveat
      '`tool_search` for `mbrain read_context`',
      // route-before-write governance
      'route_memory_writeback',
      'canonical_write_allowed',
      '`route_first`',
      // hash-gated put_page
      'target_snapshot_hash',
      'expected_content_hash',
      'content_hash',
      'write_session_id',
      // candidate verification + promotion debt
      'verify_memory_candidate_entry',
      'canonical_write_pending',
      // session capture defaults
      'preview_agent_session_memory',
      'candidate_only',
      // never-write list
      'secrets',
      'transient task mechanics',
      // filing + page shape + backlinks + sync
      'brain/originals/{slug}.md',
      'brain/systems/',
      '[Source: User, direct message, YYYY-MM-DD HH:MM TZ]',
      'Referenced in [page title]',
      'sync_brain',
      '`no_pull: true`',
    ];
    for (const anchor of anchors) {
      expect(draft).toContain(anchor);
    }
  });

  test('draft is measurably smaller than the live rules file', () => {
    const draft = readFileSync(draftPath, 'utf-8');
    const live = readFileSync(livePath, 'utf-8');
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    // Draft body (agents would consume this without the draft-note comment).
    const body = draft.slice(draft.indexOf('# MBrain'));
    expect(words(body)).toBeLessThan(words(live) * 0.65);
  });

  test('live rules file is untouched by this slice', () => {
    const live = readFileSync(livePath, 'utf-8');
    // Still the injected live file: version marker + canonical source URL intact.
    expect(live).toContain('mbrain-agent-rules-version:');
    expect(live).toContain('docs/MBRAIN_AGENT_RULES.md');
    // Live file does not point at or defer to the draft.
    expect(live).not.toContain('MBRAIN_AGENT_RULES.next');
  });

  test('setup-agent still injects the live file, not the draft', () => {
    const source = readFileSync(setupAgentPath, 'utf-8');
    expect(source).toContain("'MBRAIN_AGENT_RULES.md'");
    expect(source).not.toContain('MBRAIN_AGENT_RULES.next');
  });
});
