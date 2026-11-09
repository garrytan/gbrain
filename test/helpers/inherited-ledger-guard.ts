import { afterAll, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { brainFirstLedgerPath } from '../../src/core/setup/brain-first.ts';

const read = (path: string): string | null => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

/**
 * Fails the file when one of its tests wrote the brain-first ledger of the GBRAIN_HOME the run inherited
 * (a developer shell's real brain, or the preload's per-process scratch home): installer tests must give
 * each install its own GBRAIN_HOME with withEnv (#8434).
 */
export function guardInheritedInstructionLedger(): void {
  const ledger = brainFirstLedgerPath();
  const before = read(ledger);
  afterAll(() => expect(read(ledger), `${ledger} changed during this file`).toBe(before));
}
