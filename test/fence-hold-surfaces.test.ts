/**
 * #6188 (D6, D16, D17, E35, Codex CEO #7, Codex DX #6): what a fence hold
 * tells an agent on every surface.
 *
 * Protects: one hold-repair router: a fence-only source names
 * `gbrain repair fences --source <id>` and never frontmatter, a
 * frontmatter-only source never names the fence repair, a mixed source names
 * both; a single fence hold's fix is that file's preview
 * (`--only <path>`). The fix follows the hold's state: auto-repair pending
 * with an active maintenance run says no action is needed (read-only
 * preview), an inactive run names the preview then the apply, a manual-only
 * reason or gate rejection names the exact edit, a paid wait names the exact
 * config or pricing command with consent `paid` (renders ask_user), the owner
 * state names the owner host; remote callers get `tell_user_to_run` with a
 * user_message saying whether it clears by itself. Hold items carry the D16
 * structured location and holdLine renders it. No claim, holder or kind text
 * reaches any surface.
 * Fails when: a surface keeps the old "edit the fence then sync" next step,
 * routes a fence hold to frontmatter repair, says "no action needed" with no
 * active maintenance run, renders a paid step as `run`, or copies a cell value.
 * Why new: PR1 pinned the edit-and-sync router; PR4 replaces that contract
 * with the repair command and state-dependent fixes.
 * Seams: none (pure functions; the maintenance state is passed in).
 */
import { describe, expect, test } from 'bun:test';
import { gitHoldDocs, gitHoldFix, gitHoldItem, holdRepairSteps, holdRescreenDue, type GitHoldRecord } from '../src/core/persistence/sync-holds.ts';
import { coverageRoute, fileHeldField, heldFilesNotice, hostOperatorFix, recordRoute } from '../src/core/persistence/held-reads.ts';
import { heldFileDiagnostic, heldFileMessage, writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { holdLine } from '../src/commands/sync-diagnostics.ts';
import { deriveNext, renderAction, type Action } from '../src/core/agent-output.ts';
import { fenceMessage } from '../src/core/fence-repair/reasons.ts';
import { FENCE_VERSION } from '../src/core/fence-repair/refusal.ts';
import { fenceFileLine, fenceHoldStatus, type FenceAutoRepair } from '../src/core/fence-repair/hold-fix.ts';
import { parseMarkdown, RECOVERY_VERSION } from '../src/core/markdown.ts';

const location = { reason: 'holder_unresolved', fence: 'takes', section: 'body', rows: [3], columns: ['who'], line: 7 } as const;
const fenceHold = (extra: Partial<GitHoldRecord> = {}): GitHoldRecord => ({
  version: 1, source_id: 'notes-example', incarnation: 'inc', path: 'people/alice-example.md', source_path: 'people/alice-example.md', slug: 'people/alice-example', page_id: 12,
  code: 'invalid_fence', message: fenceMessage({ ...location, rows: [...location.rows], columns: [...location.columns] }), upstream_version: 'sha', observed_at: '2026-10-01T00:00:00.000Z',
  held_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', run_id: 'run', mode: 'managed',
  meta: { reason: 'holder_unresolved', line: 12, recovery_version: RECOVERY_VERSION, fence: { ...location, rows: [...location.rows], columns: [...location.columns] }, fence_version: FENCE_VERSION },
  ...extra,
});
const withMeta = (meta: Partial<GitHoldRecord['meta']>) => fenceHold({ meta: { ...fenceHold().meta, ...meta } });
const manualHold = () => withMeta({ reason: 'takes_kind_unsupported', fence: { reason: 'takes_kind_unsupported', fence: 'takes', section: 'body', rows: [2], columns: ['kind'], line: 6 } });
const tier3Hold = () => withMeta({ reason: 'short_row', fence: { reason: 'short_row', fence: 'facts', section: 'body', rows: [4], columns: [], line: 9 } });
const frontmatterHold = (): GitHoldRecord => ({ ...fenceHold(), path: 'notes/broken.md', code: 'invalid_frontmatter',
  message: 'Invalid YAML frontmatter: key "title" at line 2 continues on unquoted lines.', meta: { reason: 'needs_interpretation', key: 'title', line: 2, recovery_version: RECOVERY_VERSION } });
const repaired = (reason: string, next: string | null, extra: Record<string, unknown> = {}) =>
  ({ reason, tier: 'llm', at: '2026-10-05T00:00:00.000Z', next_attempt_after: next, ...extra }) as GitHoldRecord['meta']['fence_repair'];

const ACTIVE: FenceAutoRepair = { enabled: true, llm: true, last_maintenance_at: '2026-10-06T00:00:00.000Z', active: true };
const INACTIVE: FenceAutoRepair = { enabled: true, llm: true, last_maintenance_at: null, active: false };
const PAUSED: FenceAutoRepair = { enabled: false, llm: true, last_maintenance_at: '2026-10-06T00:00:00.000Z', active: false };
const LLM_OFF: FenceAutoRepair = { ...ACTIVE, llm: false };

const cli = { transport: 'cli' as const, isCallable: () => false, preapproved: () => false, routing: {} } as never;
const http = { transport: 'http' as const, isCallable: () => false, preapproved: () => false, routing: {} } as never;
const next = (fix: Action, ctx: never) => renderAction(fix, ctx).next;
const preview = (path?: string) => ['gbrain', 'repair', 'fences', '--source', 'notes-example', ...(path ? ['--only', path] : [])];
// #6377: the source-level route names the content-repair lane; one hold's own fix stays that file's fence preview.
const lane = ['gbrain', 'repair', 'content', '--source', 'notes-example'];

describe('one fence hold: the fix by state (D17, E35)', () => {
  test('auto-repair pending with an active maintenance run: no action needed, the read-only preview of that file', () => {
    const fix = gitHoldFix(fenceHold({ meta: { ...fenceHold().meta, fence_repair: repaired('llm_unavailable', '2026-10-06T09:00:00.000Z') } }), ACTIVE);
    expect(fix.argv).toEqual(preview('people/alice-example.md'));
    expect(fix.then).toBeUndefined();
    expect(fix.why).toContain('No action is needed: the next maintenance run repairs it automatically (next attempt after 2026-10-06T09:00:00.000Z)');
    expect([next(fix, cli), next(fix, http)]).toEqual(['run', 'tell_user_to_run']);
  });

  test('maintenance inactive or paused: the preview, then the apply; never "no action needed"', () => {
    for (const auto of [INACTIVE, PAUSED, undefined]) {
      const fix = gitHoldFix(fenceHold(), auto);
      expect(fix.argv).toEqual(preview('people/alice-example.md'));
      expect(fix.then?.argv).toEqual([...preview('people/alice-example.md'), '--apply']);
      expect(fix.why).toContain('--expect <hash>');
      expect(fix.why).not.toContain('No action is needed');
      expect(next(fix, cli)).toBe('run');
    }
    expect(gitHoldFix(fenceHold(), INACTIVE).why).toContain('No maintenance run is active');
    expect(gitHoldFix(fenceHold(), PAUSED).why).toContain('fences.repair.enabled false');
  });

  test('manual-only reasons, gate rejections and model failures name the exact edit through the preview, then the sync', () => {
    const manual = gitHoldFix(manualHold(), ACTIVE);
    expect(manual.argv).toEqual(preview('people/alice-example.md'));
    expect(manual.why).toContain('gbrain will not guess this repair');
    expect(manual.why).toContain('Column `kind` of row(s) 2 in the takes fence');
    expect(manual.then?.argv).toEqual(['gbrain', 'sync', '--source', 'notes-example', '--no-pull']);
    expect(next(manual, cli)).toBe('run');
    const gate = gitHoldFix(withMeta({ fence_repair: repaired('cell_changed', null, { gate: 'f', rows: [3] }) }), ACTIVE);
    expect(fenceHoldStatus(withMeta({ fence_repair: repaired('cell_changed', null, { gate: 'f', rows: [3] }) }).meta, ACTIVE)).toMatchObject({ state: 'manual', reason: 'cell_changed' });
    expect(gate.why).toContain('The proposed repair failed gate f');
    expect(fenceHoldStatus(withMeta({ fence_repair: repaired('llm_malformed', null) }).meta, ACTIVE).state).toBe('manual');
  });

  test('budget, model switch and pricing waits: the exact command with consent paid, which renders ask_user', () => {
    const cases: Array<[string, Partial<GitHoldRecord['meta']>, FenceAutoRepair, string[]]> = [
      ['budget_exhausted', { fence_repair: repaired('budget_exhausted', '2026-10-07T00:00:00.000Z') }, ACTIVE, ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<usd>']],
      ['llm_disabled', {}, LLM_OFF, ['gbrain', 'config', 'set', 'fences.repair.llm', 'true']],
      ['no_pricing', { fence_repair: repaired('no_pricing', null) }, ACTIVE, ['gbrain', 'pricing', 'set', '<model>', '--input', '<usd>', '--output', '<usd>']],
    ];
    for (const [reason, meta, auto, argv] of cases) {
      const record = reason === 'llm_disabled' ? tier3Hold() : withMeta(meta);
      const fix = gitHoldFix(record, auto);
      expect([reason, fenceHoldStatus(record.meta, auto).state]).toEqual([reason, 'paid']);
      expect(fix).toMatchObject({ argv, consent: ['paid'], actor: 'agent', preview_argv: reason === 'llm_disabled' ? preview('people/alice-example.md') : preview('people/alice-example.md') });
      expect(next(fix, cli)).toBe('ask_user');
      expect(fix.why).toContain("the user's call");
      expect(fix.user_message).toContain(argv.join(' '));
    }
    // With the model on, the same Tier 3 hold is ordinary auto-repair work.
    expect(fenceHoldStatus(tier3Hold().meta, ACTIVE).state).toBe('auto');
  });

  test('owner_unavailable names the owner-host command for the host operator', () => {
    const fix = gitHoldFix(withMeta({ fence_repair: repaired('owner_unavailable', '2026-10-06T09:00:00.000Z') }), ACTIVE);
    expect(fix).toMatchObject({ argv: preview('people/alice-example.md'), actor: 'host_admin' });
    expect(fix.why).toContain('owner host');
    expect(next(fix, cli)).toBe('tell_user_to_run');
  });

  test('a prepare-time hold reads its receipt reason; a stored-row collision is a manual edit', () => {
    const hold = withMeta({ reason: 'prepare_time', fence: { reason: 'stored_row_collision', fence: 'takes', section: 'body', rows: [2], columns: [], line: null } });
    expect(fenceHoldStatus(hold.meta, ACTIVE).state).toBe('manual');
    expect(gitHoldFix(hold, ACTIVE).why).toContain('was refused against the stored page (stored_row_collision)');
  });
});

describe('structured location (D16)', () => {
  test('items carry fence, section, rows, columns, classes, tier, auto_retry, next_attempt_after and the file line; holdLine renders it', () => {
    const record = withMeta({ fence_repair: repaired('llm_unavailable', '2026-10-06T09:00:00.000Z', { tier: 'resolver' }) });
    const item = gitHoldItem(record, ACTIVE);
    expect(item).toMatchObject({ code: 'invalid_fence', reason: 'holder_unresolved', line: 12, docs: 'docs/guides/write-refusals.md#fence-holder_unresolved',
      fence: { reason: 'holder_unresolved', fence: 'takes', section: 'body', rows: [3], columns: ['who'], line: 7, classes: ['holder_unresolved'], tier: 'resolver',
        auto_retry: true, next_attempt_after: '2026-10-06T09:00:00.000Z' } });
    expect(holdLine(item, 'Held')).toBe('  Held people/alice-example.md: invalid_fence (holder_unresolved) in the takes fence (body), row 3, column who, at line 12; '
      + 'its page keeps its last good revision and is read-only for put_page until the file is repaired. No action needed: the next maintenance run repairs it. '
      + 'Preview: gbrain repair fences --source notes-example --only people/alice-example.md (docs/guides/write-refusals.md#fence-holder_unresolved)');
    expect(holdLine(gitHoldItem(fenceHold(), INACTIVE), 'Held')).toContain('Next: gbrain repair fences --source notes-example --only people/alice-example.md, '
      + 'then gbrain repair fences --source notes-example --only people/alice-example.md --apply');
    expect(holdLine(gitHoldItem(tier3Hold(), LLM_OFF), 'Held')).toContain('Ask the user first, then: gbrain config set fences.repair.llm true');
    expect(gitHoldItem(fenceHold(), INACTIVE).fence).toMatchObject({ auto_retry: false, next_attempt_after: null });
    expect(gitHoldDocs('invalid_fence', 'prepare_time')).toBe('docs/guides/write-refusals.md#fence-prepare_time');
    expect(gitHoldDocs('invalid_frontmatter', 'yaml_parse')).toBe('docs/guides/write-refusals.md#invalid_frontmatter-yaml_parse');
  });

  test('fenceFileLine adds the section start to the section line, for the body and the timeline', () => {
    const content = '---\ntitle: Example\n---\n\n# Example\n\nIntro.\n\n<!--- gbrain:takes:begin -->\n| # | claim |\n<!--- gbrain:takes:end -->\n\n<!-- timeline -->\n\n- 2026-01-01: an event\n';
    const page = parseMarkdown(content, 'people/example.md');
    const lines = content.split('\n');
    const bodyLine = page.compiled_truth.split('\n').indexOf('| # | claim |') + 1;
    expect(lines[fenceFileLine(content, page, { section: 'body', line: bodyLine })! - 1]).toBe('| # | claim |');
    const timelineLine = page.timeline.split('\n').indexOf('- 2026-01-01: an event') + 1;
    expect(lines[fenceFileLine(content, page, { section: 'timeline', line: timelineLine })! - 1]).toBe('- 2026-01-01: an event');
    expect(fenceFileLine(content, page, { section: 'body', line: null })).toBeNull();
  });

  test('a fence hold an older fence screen wrote is re-screened; a current one only when retried or its bytes change', () => {
    expect(holdRescreenDue(fenceHold(), false)).toBe(false);
    expect(holdRescreenDue(fenceHold(), true)).toBe(true);
    expect(holdRescreenDue(withMeta({ fence_version: FENCE_VERSION - 1 }), false)).toBe(true);
    expect(holdRescreenDue(withMeta({ fence_version: undefined }), false)).toBe(true);
    expect(holdRescreenDue({ ...frontmatterHold(), code: 'frontmatter_slug_conflict' }, false)).toBe(true);
  });
});

describe('source-level routing on every surface (D6)', () => {
  test('fence-only, frontmatter-only and mixed sources name the right repair commands', () => {
    const fences = holdRepairSteps('notes-example', { fences: 2, others: 0 });
    expect(fences.argv).toEqual(lane);
    expect(fences.commands).toEqual(['gbrain repair content --source notes-example']);
    expect(fences.text).not.toContain('frontmatter');
    const frontmatter = holdRepairSteps('notes-example', { fences: 0, others: 2 });
    expect(frontmatter.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', 'notes-example']);
    expect(frontmatter.text).not.toContain('fence');
    const mixed = holdRepairSteps('notes-example', { fences: 1, others: 1 });
    expect(mixed.commands).toEqual(['gbrain repair frontmatter --source notes-example', 'gbrain repair content --source notes-example']);
    // #6377: slug-conflict holds take the same lane route as fence holds.
    const slugs = holdRepairSteps('notes-example', { fences: 0, others: 0, slug_conflicts: 1 });
    expect(slugs.argv).toEqual(lane);
    expect(slugs.text).not.toContain('frontmatter');
    expect(holdRepairSteps('notes-example', { fences: 1, others: 0 }, ACTIVE).text).toContain('the next maintenance run repairs the fence and slug-conflict holds it can by itself');
    expect(holdRepairSteps('notes-example', { fences: 1, others: 0 }, INACTIVE).text).toContain('nothing repairs the fence and slug-conflict holds by itself (no maintenance run is active)');
    expect(holdRepairSteps('notes-example', { fences: 1, others: 0 }, INACTIVE).text).toContain('then run the apply command it prints');
  });

  test('the held_files notice routes each kind; a remote caller gets the owner handoff with no path', () => {
    const fenceOnly = [{ source_id: 'notes-example', missing: 0, stale: 2, fences: 2 }];
    expect(coverageRoute(fenceOnly[0]!)).toEqual({ fences: 2, others: 0 });
    const local = heldFilesNotice(fenceOnly, false)!;
    expect(local.fix!.argv).toEqual(lane);
    expect(local.fix!.why).not.toContain('frontmatter');
    const remote = heldFilesNotice(fenceOnly, true)!;
    expect(remote.fix).toMatchObject({ actor: 'host_admin', argv: lane });
    expect(remote.fix!.user_message).toContain("'gbrain repair content --source notes-example'");
    expect(remote.fix!.user_message).not.toContain('frontmatter');
    expect(deriveNext(remote.fix!, http)).toBe('tell_user_to_run');
    expect(heldFilesNotice([{ source_id: 'notes-example', missing: 1, stale: 0 }], false)!.fix!.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', 'notes-example']);
    const mixed = hostOperatorFix([{ source_id: 'notes-example', route: { fences: 1, others: 1 } }], 'Held.');
    expect(mixed.user_message).toContain("'gbrain repair frontmatter --source notes-example'");
    expect(mixed.user_message).toContain("'gbrain repair content --source notes-example'");
    const frontmatter = hostOperatorFix([{ source_id: 'notes-example' }], 'Held.');
    expect(frontmatter.user_message).toContain("'gbrain repair frontmatter --source notes-example' on the brain host");
    expect(frontmatter.user_message).not.toContain('repair content');
    expect(recordRoute(fenceHold())).toEqual({ fences: 1, others: 0 });
    expect(recordRoute({ code: 'frontmatter_slug_conflict' })).toEqual({ fences: 0, others: 0, slug_conflicts: 1 });
    expect(hostOperatorFix([{ source_id: 'notes-example', route: recordRoute({ code: 'frontmatter_slug_conflict' }) }], 'Held.').user_message).toContain("'gbrain repair content --source notes-example'");
  });

  test('get_page file_held: the local fix is that file\'s preview; the remote read gets tell_user_to_run saying whether it clears by itself (Codex CEO #7)', () => {
    expect(fileHeldField({ record: fenceHold(), revision: 'r1', fenceAuto: ACTIVE }, false)).toMatchObject({ path: 'people/alice-example.md',
      fence: { rows: [3], auto_retry: true }, fix: { argv: preview('people/alice-example.md') } });
    const auto = fileHeldField({ record: fenceHold(), revision: 'r1', fenceAuto: ACTIVE }, true);
    expect(auto.path).toBeUndefined();
    expect(auto.fence).toMatchObject({ rows: [], fence: 'takes', section: 'body' });
    expect(auto.fix).toMatchObject({ actor: 'host_admin', argv: preview() });
    expect(next(auto.fix, http)).toBe('tell_user_to_run');
    expect(auto.fix.user_message).toContain('It clears by itself');
    const inactive = fileHeldField({ record: fenceHold(), revision: 'r1', fenceAuto: INACTIVE }, true);
    expect(inactive.fix.user_message).toContain('It does not clear by itself because no maintenance run is active on the brain host');
    const manual = fileHeldField({ record: manualHold(), revision: 'r1', fenceAuto: ACTIVE }, true);
    expect(manual.fix.user_message).toContain('needs an edit gbrain will not guess');
    const paid = fileHeldField({ record: tier3Hold(), revision: 'r1', fenceAuto: LLM_OFF }, true);
    expect(paid.fix).toMatchObject({ argv: ['gbrain', 'config', 'set', 'fences.repair.llm', 'true'], consent: ['paid'], actor: 'host_admin' });
    expect(next(paid.fix, http)).toBe('tell_user_to_run');
    expect(paid.fix.user_message).toContain('your call');
    for (const field of [auto, inactive, manual, paid]) expect(JSON.stringify(field)).not.toContain('alice-example.md');
  });

  test('write refusals over a held fence file name the fence repair, never frontmatter; a blocked fence receipt names both the edit and the preview', () => {
    const held = heldFileDiagnostic(heldFileMessage('drift', 'invalid_fence'), 'notes-example')!;
    expect(held.suggestion).toContain('gbrain repair fences --source notes-example');
    expect(held.suggestion).not.toContain('repair frontmatter');
    expect(heldFileDiagnostic(heldFileMessage('drift', 'invalid_frontmatter'), 'notes-example')!.suggestion).toContain('gbrain repair frontmatter --source notes-example');
    expect(heldFileDiagnostic(heldFileMessage('drift', 'invalid_frontmatter'), 'notes-example')!.suggestion).not.toContain('repair fences');
    const blocked = writeFailureDiagnostic('invalid_params', fenceHold().message);
    expect(blocked).toMatchObject({ reason: 'invalid_fence', message: fenceHold().message });
    expect(blocked.suggestion).toContain('the takes fence (body), row 3');
    expect(blocked.suggestion).toContain('gbrain repair fences');
    expect(writeFailureDiagnostic('invalid_params', 'The value is invalid.').reason).toBe('invalid_params');
  });
});

describe('location-only privacy (sentinel)', () => {
  test('no claim, holder or kind text reaches a hold item, fix, line, file_held or relay in any state', () => {
    const SECRETS = ['Sentinelclaimq81 renews', 'Sentinelholderq81 Example', 'sentinelkindq81'];
    const records = [fenceHold(), manualHold(), tier3Hold(), withMeta({ fence_repair: repaired('cell_changed', null, { gate: 'f', rows: [3] }) }),
      withMeta({ fence_repair: repaired('budget_exhausted', '2026-10-07T00:00:00.000Z') }), withMeta({ fence_repair: repaired('owner_unavailable', null) })];
    for (const record of records) {
      for (const auto of [ACTIVE, INACTIVE, LLM_OFF, undefined]) {
        const item = gitHoldItem(record, auto);
        const text = JSON.stringify([item, holdLine(item, 'Held'), renderAction(item.fix, cli), renderAction(item.fix, http),
          fileHeldField({ record, revision: 'r1', fenceAuto: auto }, true), fileHeldField({ record, revision: 'r1', fenceAuto: auto }, false)]);
        for (const secret of SECRETS) expect(text).not.toContain(secret);
        expect(text).not.toContain('repair frontmatter');
      }
    }
  });
});
