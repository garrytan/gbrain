/**
 * `gbrain sources shared-skills <id> on|off|status [--json]`: the per-source
 * shared-skills opt-out (`config.shared_skills`, refusal reason
 * `source_shared_skills_disabled`). `off` writes `config.shared_skills=false`;
 * `on` deletes the key and releases a parked oversized inventory. Every form
 * prints the configured value and the effective migration policy with its
 * reason, so a connector or external source that stays preserve_files or
 * explicit_pack_required explains itself.
 */
import type { BrainEngine } from '../core/engine.ts';
import { usageError } from '../cli/cli-error.ts';
import { readSharedSkillsSourceView, setSourceSharedSkills, sharedSkillsStatusLines, type SharedSkillsAction } from '../core/shared-skills/source-opt-out.ts';
import { SHARED_SKILLS_OPT_OUT_DOCS } from '../core/shared-skills/setup-source-policy.ts';

export const SOURCES_SHARED_SKILLS_HELP = `Usage: gbrain sources shared-skills <id> on|off|status [--json]

Choose whether the shared-skills migration may adopt this source's skillpack
(config.shared_skills; reason code source_shared_skills_disabled when off).

  status   Print the configured value, the effective policy mode and its reason,
           and a parked oversized inventory with its next step. Read-only.
  off      Opt the source out: the migration preserves its files.
  on       Remove the opt-out (the default) and release a parked inventory so
           the next \`gbrain apply-migrations --migration 0.53.0 --yes\` run
           inventories it again. A connector or external source can still stay
           preserve_files or explicit_pack_required; status says why.

Runs only on the brain host. Docs: ${SHARED_SKILLS_OPT_OUT_DOCS}`;

const ACTIONS: readonly SharedSkillsAction[] = ['on', 'off', 'status'];

export async function runSourcesSharedSkills(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const unknown = args.find(arg => arg.startsWith('-') && arg !== '--json');
  if (unknown) {
    throw usageError(`Unknown flag ${unknown} for sources shared-skills.`, 'Run `gbrain sources shared-skills --help` for the accepted forms.', {
      code: 'unknown_flag',
      fix: { argv: ['gbrain', 'sources', 'shared-skills', '--help'], consent: [], actor: 'agent', requires_exclusive: false, why: 'The help lists the accepted forms.' },
    });
  }
  const [id, action, ...extra] = args.filter(arg => !arg.startsWith('-'));
  if (!id || !ACTIONS.includes(action as SharedSkillsAction) || extra.length) {
    throw usageError(
      !id ? 'sources shared-skills needs a source id and on, off or status.' : `sources shared-skills needs exactly one of on, off or status after the source id${action ? `, not "${[action, ...extra].join(' ')}"` : ''}.`,
      'Run `gbrain sources shared-skills <id> status` to read the current setting first.',
      { fix: id
        ? { argv: ['gbrain', 'sources', 'shared-skills', id, 'status', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the current setting and effective policy, read-only.' }
        : { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the registered source ids, read-only.' } },
    );
  }
  const change = action === 'status' ? null : await setSourceSharedSkills({ engine, remote: false }, id, action === 'on');
  const result = change ?? await readSharedSkillsSourceView(engine, id);
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, action, ...result }, null, 2));
    return;
  }
  if (change) {
    console.log(change.changed
      ? `Shared skills ${action} for source ${id}.${change.released_parked ? ' Released its parked inventory; run gbrain apply-migrations --migration 0.53.0 --yes to inventory it again.' : ''}`
      : `Shared skills were already ${action} for source ${id}; nothing changed.`);
  }
  for (const line of sharedSkillsStatusLines(result)) console.log(line);
}
