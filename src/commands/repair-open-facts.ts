/**
 * The CLI side of `gbrain repair open-facts` (#8194), so the repair core touches no filesystem (GBRA-248): its undo
 * ledger at <gbrain home>/repair/open-facts/<brain_id>.jsonl (0700 directory, 0600 file, as private-labels keeps its
 * own) and the fact ids an `--ids-file` lists.
 */
import { readFileSync } from 'node:fs';
import { opError } from '../core/ops/contract.ts';
import type { OpenFactsLedger, OpenFactsLedgerLine } from '../core/repair/open-facts.ts';
import { repairLedger } from './repair-private-labels.ts';

export const openFactsLedger = (brainId: string): OpenFactsLedger => repairLedger<OpenFactsLedgerLine>('open-facts', brainId);

/** The fact ids a file lists, one per line; blank lines and # comments are skipped. */
export function readFactIdsFile(path: string): number[] {
  const refused = (why: string) => opError('invalid_params', `--ids-file ${path} ${why}.`, 'Pass a readable file with one fact id per line (# starts a comment), e.g. the ids a preview listed.',
    { reason: 'ids_file_unreadable' });
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) { throw refused(`could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`); }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const bad = lines.find(line => !/^[1-9]\d{0,15}$/.test(line));
  if (bad !== undefined) throw refused(`lists "${bad.slice(0, 40)}", which is not a fact id`);
  if (!lines.length) throw refused('lists no fact id');
  return lines.map(Number);
}
