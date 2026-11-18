/**
 * gbrain dedupe --preview: list groups of person and company pages that are likely one entity, with the
 * evidence and a class. Read-only: it writes nothing and needs no API key. `--json` prints the versioned
 * contract gbrain-evals scores (core/entities/duplicates.ts, research/entity-resolution/finder-contract.md).
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { DUPLICATE_KINDS, findDuplicateGroups, type DuplicateEvidence, type DuplicateKind } from '../core/entities/duplicates.ts';

const HELP = `Usage: gbrain dedupe --preview [--json] [--kind cross-source|in-source|conflict|thin] [--source <id>]

List groups of person and company pages that are likely the same person or company, with the evidence
(shared keys by type, never their values) and a class: clean, likely, weak, thin or conflict.
clean: the pages share an account or registry id (LinkedIn, GitHub or a declared id) and exactly the same name;
it is a strong hint for review, not proof they are one person.
Read-only: nothing is changed.

  --preview         list the groups (the default and, for now, the only mode)
  --json            print the versioned JSON contract
  --kind <kind>     only groups of this kind (hyphens or underscores)
                    a cross-source pair whose ids disagree is listed with class conflict but keeps kind
                    cross_source, so filter by class (class == conflict in --json), not --kind, to see every conflict
  --source <id>     only groups with a member in this source
`;

function evidenceText(e: DuplicateEvidence): string {
  const others = e.other_pages_same_name === undefined ? '' : `also on ${e.other_pages_same_name} same-name and ${e.other_pages_other_name} other-name page(s)`;
  const veto = e.veto ? 'veto (if they are one person, correct the wrong id on one page)' : '';
  return [e.rule, e.key, e.role_address ? 'role address' : '', others, veto].filter(Boolean).join(' ');
}

export async function runDedupe(engine: BrainEngine, args: string[]): Promise<void> {
  let json = false;
  let kind: DuplicateKind | undefined;
  let sourceId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--help' || a === '-h') { console.log(HELP); return; }
    if (a === '--preview') continue;
    if (a === '--json') { json = true; continue; }
    if (a === '--kind' || a === '--source') {
      const v = args[++i];
      if (!v) { console.error(`gbrain dedupe: ${a} needs a value.\n\n${HELP}`); setCliExitVerdict(2); return; }
      if (a === '--source') { sourceId = v; continue; }
      const k = v.replace(/-/g, '_').replace(/^conflicts$/, 'conflict') as DuplicateKind;
      if (!DUPLICATE_KINDS.includes(k)) { console.error(`gbrain dedupe: unknown --kind ${v}; use cross-source, in-source, conflict or thin.`); setCliExitVerdict(2); return; }
      kind = k;
      continue;
    }
    console.error(`gbrain dedupe: unknown argument ${a}.\n\n${HELP}`);
    setCliExitVerdict(2);
    return;
  }
  const result = await findDuplicateGroups(engine, { kind, sourceId });
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  const { by_kind, by_class } = result.counts;
  console.log(`${result.groups.length} duplicate group(s): ${DUPLICATE_KINDS.map(k => `${k} ${by_kind[k]}`).join(', ')} (clean ${by_class.clean}). Nothing was changed.`);
  for (const g of result.groups) {
    console.log(`\n${g.id}  ${g.kind}  ${g.class}`);
    console.log(`  members:  ${g.members.map(m => `${m.source_id}:${m.slug}`).join(', ')}`);
    console.log(`  evidence: ${g.evidence.map(evidenceText).join('; ')}`);
  }
  if (result.counts.crowded_key_values) console.log(`\n${result.counts.crowded_key_values} key value(s) carried by more than five pages were not used as keys.`);
}
