/**
 * A child process that runs one Rust `backup restore` and is interrupted at a named point (test/backup-rust-restore-interrupt.test.ts).
 * The parent either SIGKILLs it while it is stopped at the point (INTERRUPT_MODE=hang) or lets the point throw (INTERRUPT_MODE=throw).
 * Env: RESTORE_ARCHIVE, RESTORE_INTO, RESTORE_ADDON, INTERRUPT_POINT, INTERRUPT_MODE, INTERRUPT_MARKER (a file written when the point is reached).
 */
import * as fs from 'node:fs';
import { spyOn } from 'bun:test';
import { dirname, join } from 'node:path';
import { loadRustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { restoreBackup } from '../../src/core/backup/rust-snapshot.ts';

const { RESTORE_ARCHIVE, RESTORE_INTO, RESTORE_ADDON, INTERRUPT_POINT, INTERRUPT_MODE, INTERRUPT_MARKER } = process.env as Record<string, string>;
const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: RESTORE_ADDON } }) as any;

let reached = false;
/** Stops here for good (the parent kills the process) or throws, once. */
function interrupt(): void {
  if (reached) return;
  reached = true;
  fs.writeFileSync(INTERRUPT_MARKER, INTERRUPT_POINT);
  if (INTERRUPT_MODE === 'throw') throw new Error(`injected interruption at ${INTERRUPT_POINT}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const wrap = (proto: any, name: string, before: (() => void) | null, after: (() => void) | null): void => {
  const original = proto[name];
  proto[name] = async function (...args: unknown[]) {
    before?.();
    const result = await original.apply(this, args);
    after?.();
    return result;
  };
};
const isPublish = (from: unknown, to: unknown): boolean => String(to).startsWith(RESTORE_INTO + '/') && String(from).includes('/restored/') && dirname(String(to)) === RESTORE_INTO;

/** How many store files the archive extraction has written into the stage so far. */
const extracted = (): number => {
  const stage = fs.readdirSync(RESTORE_INTO).find(name => name.startsWith('.restore-'));
  const store = stage ? join(RESTORE_INTO, stage, 'payload', 'store') : '';
  return store && fs.existsSync(store) ? fs.readdirSync(store).length : 0;
};
let verifies = 0;
let publishes = 0;
const renameSync = fs.renameSync;
const fsyncSync = fs.fsyncSync;
switch (INTERRUPT_POINT) {
  case 'extract': // the second archive entry is written, its checksum not yet checked: the stage holds part of the payload
    spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => { if (extracted() >= 2) interrupt(); return fsyncSync(fd); }) as never);
    break;
  case 'verify': // before the first look at the restored bytes
    wrap(addon.Pool.prototype, 'verifyStoreDir', () => { if (++verifies === 1) interrupt(); }, null);
    break;
  case 'quarantine-before-commit': // inside the quarantine call, before its one transaction commits
    wrap(addon.Brain.prototype, 'restoreQuarantine', interrupt, null);
    break;
  case 'quarantine-after-commit': // the transaction has committed in the staged store; nothing after it has run
    wrap(addon.Brain.prototype, 'restoreQuarantine', null, interrupt);
    break;
  case 'before-publish': // the staged brain is complete and verified; the first move into the target has not run
  case 'mid-publish': // exactly one staged entry has been moved into the target
    spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      const publish = isPublish(from, to);
      if (publish && INTERRUPT_POINT === 'before-publish') interrupt();
      const result = renameSync(from, to);
      if (publish && ++publishes === 1 && INTERRUPT_POINT === 'mid-publish') interrupt();
      return result;
    }) as never);
    break;
  default: throw new Error(`unknown interrupt point ${INTERRUPT_POINT}`);
}

try {
  await restoreBackup({ archive: RESTORE_ARCHIVE, into: RESTORE_INTO, addon });
  console.log(JSON.stringify({ outcome: 'published', point: INTERRUPT_POINT, reached }));
} catch (error) {
  console.log(JSON.stringify({ outcome: 'threw', reached, code: (error as { code?: string }).code ?? null, message: (error as Error).message }));
}
