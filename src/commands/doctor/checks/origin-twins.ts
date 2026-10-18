/**
 * #6948 `origin_twins`: live pages of one source recording the same file (duplicate-origin twins), which sync holds
 * `origin_conflict`, and the state of the `pages_live_origin_key` index that makes a new twin unwritable. With the
 * index present no twin can exist, so nothing else is read. Without it the check counts groups per source (one
 * grouped read over live file-backed pages): twins name the read-only `gbrain repair origin-twins --source <id>`
 * preview; no twins name its apply, which builds the index ("index pending").
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { originIndexState, originTwinCounts, originTwinsRepairCommand, ORIGIN_INDEX } from '../../../core/persistence/origin-index.ts';

const DOCS = 'docs/guides/repair.md#origin-twins';

async function runOriginTwins(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const index = await originIndexState(engine);
    if (index === 'present') {
      checks.push({ name: 'origin_twins', status: 'ok', details: { index, docs: DOCS }, message: `${ORIGIN_INDEX.name} is present: no two live pages can record one file.` });
      return checks;
    }
    const sources = await originTwinCounts(engine);
    if (sources.length) {
      const first = sources[0]!.source_id;
      checks.push({ name: 'origin_twins', status: 'warn', details: { index, sources, docs: DOCS },
        message: `Index pending: ${sources.map(s => `source ${s.source_id} has ${s.groups} file(s) recorded by several live pages (${s.twins} extra page(s))`).join('; ')}. `
          + `Sync holds each such file origin_conflict and imports the rest. Preview the fix with ${originTwinsRepairCommand(first)} (writes nothing); its apply builds ${ORIGIN_INDEX.name} once no source has a group.`,
        fix: agentFix(['gbrain', 'repair', 'origin-twins', '--source', first, '--json'],
          'Read-only preview: lists each duplicate-origin group with its pages, revisions and verdict, and prints the apply command with its hash. Apply only after the user agrees (merged twins are soft-deleted; their file stays).',
          'origin_twins', { docs: DOCS }) });
      return checks;
    }
    const [source] = await engine.executeRaw<{ id: string }>("SELECT id FROM sources ORDER BY (id = 'default') DESC, id LIMIT 1");
    const id = source?.id ?? 'default';
    checks.push({ name: 'origin_twins', status: 'warn', details: { index, sources: [], docs: DOCS },
      message: `Index pending: no duplicate-origin twins remain, but ${ORIGIN_INDEX.name} is ${index}. Build it with ${originTwinsRepairCommand(id)} --apply --expect <hash from its preview> --yes (online; writes no page).`,
      fix: agentFix(['gbrain', 'repair', 'origin-twins', '--source', id, '--json'],
        'Read-only preview of an empty set; its printed apply command builds the index online and changes no page.', 'origin_twins', { docs: DOCS }) });
  } catch (error) {
    checks.push(checkError('origin_twins', 'check for duplicate-origin twins and the origin index', error, { details: { index: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const originTwinsEntry: DoctorEntry = { name: 'origin_twins', emits: ['origin_twins'], run: runOriginTwins };
