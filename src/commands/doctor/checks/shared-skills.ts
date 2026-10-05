import type { BrainEngine } from '../../../core/engine.ts';
import { readSharedSkillsSourceView } from '../../../core/shared-skills/source-opt-out.ts';
import { SHARED_SKILLS_OPT_OUT_DOCS } from '../../../core/shared-skills/setup-source-policy.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';

/**
 * Sources opted out of shared-skills adoption (`config.shared_skills=false`)
 * and sources the 0.53.0 migration parked because their pack exceeds an
 * inventory bound. Null when neither exists. Opting out is a choice (ok);
 * a parked source waits for the operator (warn).
 */
export async function checkSharedSkillsSources(engine: BrainEngine): Promise<Check | null> {
  try {
    const ids = (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id')).map(row => row.id);
    const views = await Promise.all(ids.map(id => readSharedSkillsSourceView(engine, id)));
    const optedOut = views.filter(view => view.configured === false).map(view => view.source_id);
    const parked = views.filter(view => view.parked);
    if (!optedOut.length && !parked.length) return null;
    const details = { opted_out: optedOut, parked: parked.map(view => ({ source_id: view.source_id, limit: view.parked!.limit, parked_at: view.parked!.parked_at })), docs: SHARED_SKILLS_OPT_OUT_DOCS };
    const off = optedOut.length ? `Opted out of shared-skills adoption (config.shared_skills=false): ${optedOut.join(', ')}; turn one back on with gbrain sources shared-skills <id> on.` : '';
    if (!parked.length) return { name: 'shared_skills_sources', status: 'ok', message: off, details };
    return {
      name: 'shared_skills_sources', status: 'warn', details,
      message: `${parked.length} source(s) parked by the shared-skills migration because the pack exceeds an inventory bound: `
        + `${parked.map(view => `${view.source_id} (${view.parked!.limit})`).join(', ')}. The migration completes and skips them until the bound is raised, the source opts out, or it is released. ${off}`.trim(),
      fix: agentFix(['gbrain', 'sources', 'shared-skills', parked[0]!.source_id, 'status', '--json'],
        'Shows the parked bound and the three ways to resume (raise the bound, opt out, or shrink and release); it changes nothing.', 'shared_skills_sources', { docs: SHARED_SKILLS_OPT_OUT_DOCS }),
    };
  } catch (error) {
    if (/does not exist|no such table/i.test(String(error))) return null;
    return { name: 'shared_skills_sources', status: 'warn', fix_unavailable_reason: 'check_errored',
      message: `Shared-skills source settings could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
