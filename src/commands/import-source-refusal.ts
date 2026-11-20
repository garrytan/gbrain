/**
 * The sources an ordinary `gbrain import` refuses before it reads a file: a guest source (GBRA-504: only its listed
 * writers save pages there, through put_page) and a company-brain source outside its approved sync. runImport throws
 * ImportAbortError with the returned reason; the CLI prints nothing more, so the reason and next step print here.
 */
import type { BrainEngine } from '../core/engine.ts';
import { currentCompanyBrainSync, getCompanyBrainProfile } from '../core/company-brain/profile.ts';
import { readGuestSource } from '../core/guests/sources.ts';
import { OperationError } from '../core/ops/contract.ts';
import { assertNotOwnedRoot } from '../core/owned-folder/paths.ts';

/** The abort reason for a source this import may not write, after printing why; null when it may. */
export async function importSourceRefusal(engine: BrainEngine, sourceId: string | undefined): Promise<string | null> {
  const id = sourceId ?? 'default';
  if (await readGuestSource(engine, id)) {
    console.error(`source_writer_restricted: source ${id} is a guest source; only its listed writers save pages there, through put_page. Import into another source.`);
    return 'source_writer_restricted: guest sources take no import';
  }
  if (!currentCompanyBrainSync(sourceId) && await getCompanyBrainProfile(engine, id)) {
    console.error('This source accepts only its approved committed company-brain manifest. Use sources resume or sync; ordinary import cannot write back to this read-only repository.');
    return 'company-brain sources require approved committed ingestion';
  }
  return null;
}

/** GST-3022: an import target inside a reserved `.gbrain-owned/` folder (its source writes it), after printing why; null otherwise. */
export function ownedFolderImportRefusal(dir: string): OperationError | null {
  try { assertNotOwnedRoot(dir, 'gbrain import refuses'); return null; } catch (e) {
    if (!(e instanceof OperationError)) throw e;
    console.error(`Error [${e.code}]: ${e.message}\nFix: ${e.suggestion}`);
    return e;
  }
}
