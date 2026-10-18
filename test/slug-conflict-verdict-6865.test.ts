/**
 * #6865: slug-conflict hold status says what the content-repair lane found.
 * Protects: no verdict (or an older lane's verdict) never escalates to a person after repeated attempts; "decide which page
 * keeps the slug" appears only when the line names a live page; `still_invalid` names the other fix codes and routes to the
 * frontmatter preview; a database-only named page is labelled; an older lane's model verdict is rechecked, not listed.
 * Fails when: status pages a person for a hold whose own fix is an agent-runnable step, or names a second page that does not exist.
 */
import { describe, expect, test } from 'bun:test';
import { classifySyncFault, CONTENT_REPAIR_LANE_VERSION, slugConflictEscalation } from '../src/core/persistence/sync-fault-class.ts';
import { contentHoldFix } from '../src/core/content-repair/hold-fix.ts';
import { contentHoldDisposition } from '../src/core/repair/content-lane.ts';
import type { ContentHoldRepairState, GitHoldRecord } from '../src/core/persistence/sync-holds.ts';

const PATH = 'companies/acme-example.md';
const stale = { attempts: 37, held_for_ms: 55 * 3_600_000 };
const state = (s: Partial<ContentHoldRepairState>): ContentHoldRepairState => ({ action: 'remove_slug', reason: 'still_invalid', at: '2026-10-16T00:00:00.000Z', next_attempt_after: null, lane_version: CONTENT_REPAIR_LANE_VERSION, ...s });
const input = (s: ContentHoldRepairState) => ({ ...s, path: PATH, slug: 'companies/acme-example' });
const record = (s?: ContentHoldRepairState) => ({ code: 'frontmatter_slug_conflict', meta: s ? { content_repair: s } : {} }) as unknown as Pick<GitHoldRecord, 'code' | 'meta'>;

describe('#6865 slug-conflict verdicts', () => {
  test('a hold the lane has not judged never escalates to a person, and the fix is the agent preview', () => {
    const verdict = classifySyncFault({ code: 'frontmatter_slug_conflict', ...stale });
    expect(verdict.needs_human).toBe(false);
    expect(verdict.human_reason).toBeUndefined();
    const fix = contentHoldFix({ source_id: 'default', path: PATH, meta: {} });
    expect(fix.actor).toBe('agent');
    expect(fix.why).toContain('removed by the next managed sync itself');
  });

  test('still_invalid names the other fix codes, routes to the frontmatter preview, and escalates without naming a second page', () => {
    const s = state({ other_codes: ['INVALID_DATE'] });
    const verdict = classifySyncFault({ code: 'frontmatter_slug_conflict', ...stale, content_repair: input(s) });
    expect(verdict.needs_human).toBe(true);
    expect(verdict.human_reason).toContain('INVALID_DATE');
    expect(verdict.human_reason).not.toContain('Decide which page keeps the slug');
    expect(verdict.human_reason).not.toContain('decide which page keeps the slug');
    const fix = contentHoldFix({ source_id: 'default', path: PATH, meta: { content_repair: s } });
    expect(fix.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', 'default', '--only', PATH, '--include-ambiguous']);
    expect(fix.why).toContain('INVALID_DATE');
  });

  test('only a named live page earns "decide which page keeps the slug", with a database-only page labelled', () => {
    const named = state({ action: 'pending', reason: 'llm_disabled', named: 'fund-a', named_db_only: true });
    expect(slugConflictEscalation(input(named))).toContain('page `fund-a` (a database-only page with no file)');
    expect(slugConflictEscalation(input(named))).toContain('decide which page keeps the slug');
    expect(slugConflictEscalation(input(state({ action: 'pending', reason: 'llm_disabled' })))).not.toContain('page `');
    for (const reason of ['sync_in_progress', 'changed_since_read', 'llm_unavailable']) {
      expect(classifySyncFault({ code: 'frontmatter_slug_conflict', ...stale, content_repair: input(state({ action: 'pending', reason })) }).needs_human).toBe(false);
    }
  });

  test('an older lane verdict is rechecked once instead of listed for a person', () => {
    const old = state({ action: 'needs_human', reason: 'content_repair_needs_human', named: 'fund-a', lane_version: undefined });
    expect(contentHoldDisposition(record(old))).toEqual({ action: 'repair', kind: 'slug-conflicts' });
    expect(classifySyncFault({ code: 'frontmatter_slug_conflict', ...stale, content_repair: input(old) }).needs_human).toBe(false);
    const fix = contentHoldFix({ source_id: 'default', path: PATH, meta: { content_repair: old } });
    expect(fix.actor).toBe('agent');
    expect(fix.user_message).toBeUndefined();
    const current = { ...old, lane_version: CONTENT_REPAIR_LANE_VERSION };
    expect(contentHoldDisposition(record(current))).toMatchObject({ action: 'listed', state: 'needs_human' });
    expect(classifySyncFault({ code: 'frontmatter_slug_conflict', content_repair: input(current) }).needs_human).toBe(true);
  });
});
