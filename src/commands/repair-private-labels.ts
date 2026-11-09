/**
 * The undo ledger of `gbrain repair private-labels`, kept by the CLI so the
 * repair core touches no filesystem (GBRA-248): one JSON line per cleared or
 * restored page at <gbrain home>/repair/private-labels/<brain_id>.jsonl, in a
 * 0700 directory, the file 0600. The core reads the lines for --class restore
 * and appends through `record`.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from '../core/config.ts';
import type { PrivateLabelsLedger, PrivateLabelsLedgerLine } from '../core/repair/private-labels.ts';

export function privateLabelsLedger(brainId: string): PrivateLabelsLedger {
  const path = gbrainPath('repair', 'private-labels', `${brainId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  const lines: PrivateLabelsLedgerLine[] = [];
  let unreadable = 0;
  for (const text of existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []) {
    if (!text.trim()) continue;
    try { lines.push(JSON.parse(text) as PrivateLabelsLedgerLine); } catch { unreadable++; }
  }
  return { path, lines, unreadable, record(line) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } };
}
