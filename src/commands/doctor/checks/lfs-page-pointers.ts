/**
 * `lfs_page_pointers` (Wave C 1D, §4.6): how many files each source holds `lfs_pointer_unsmudged` (a page file committed as a Git
 * LFS pointer, which sync never imports), with the first paths (the check is host-only, so paths never reach a remote
 * caller). Warns while any is held; the fix reads the source's holds, whose own fix lists the steps for that source's
 * writer and needs the user's agreement, since storing a file without LFS changes how it is kept.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix } from '../check-fix.ts';
import { LFS_POINTER_DOCS, readLfsPointerHolds } from '../../../core/persistence/lfs-pointer.ts';

const SAMPLE_PATHS = 5;

async function runLfsPagePointers(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  ctx.progress.heartbeat('lfs_page_pointers');
  const checks: Check[] = [];
  try {
    const sources = await readLfsPointerHolds(engine, SAMPLE_PATHS);
    if (!sources.length) {
      checks.push({ name: 'lfs_page_pointers', status: 'ok', message: 'No source holds a page file committed as a Git LFS pointer.', details: { sources: [], docs: LFS_POINTER_DOCS } });
      return checks;
    }
    const held = sources.reduce((sum, source) => sum + source.held, 0);
    const first = sources[0]!.source_id;
    checks.push({ name: 'lfs_page_pointers', status: 'warn', details: { sources, held, docs: LFS_POINTER_DOCS },
      message: `${held} page file(s) are committed as Git LFS pointers, so sync holds them and their stored pages stay as they were: `
        + `${sources.map(source => `${source.source_id}: ${source.held} (${source.paths.join(', ')}${source.held > source.paths.length ? ', …' : ''})`).join('; ')}. `
        + 'Storing them without LFS is the user\'s call; each hold\'s fix lists the steps.',
      fix: agentFix(['gbrain', 'sources', 'status', first, '--json'],
        `Read-only: lists ${first}'s held files with each hold's fix, the ordered steps that store the file without LFS for this source's writer; relay them and run them only after the user agrees.`,
        'lfs_page_pointers', { docs: LFS_POINTER_DOCS }) });
  } catch (error) {
    checks.push({ name: 'lfs_page_pointers', status: 'ok', details: { health: 'unknown', docs: LFS_POINTER_DOCS },
      message: `Could not read the sync holds (${error instanceof Error ? error.message : String(error)}); gbrain sources status <id> --json lists them.` });
  }
  return checks;
}

export const lfsPagePointersEntry: DoctorEntry = { name: 'lfs_page_pointers', emits: ['lfs_page_pointers'], run: runLfsPagePointers };
