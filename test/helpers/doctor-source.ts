/**
 * Shared source-text loader for doctor structural guards.
 *
 * doctor.ts is being peeled into src/commands/doctor/ modules (containment
 * sprint). Guards that assert a string EXISTS somewhere in the doctor
 * implementation must read the whole doctor surface — the façade file plus
 * every extracted module — or a peel silently moves their target out of
 * sight and the guard rots into a permanently-green no-op.
 *
 * Two loaders, two guard classes:
 * - doctorSource(): concatenation of src/commands/doctor.ts + every
 *   src/commands/doctor/**\/*.ts, deterministic order (façade first, then
 *   sorted module paths). For CONTAINMENT assertions (toContain / toMatch
 *   with no ordering semantics). File boundaries are marked so a regex
 *   cannot accidentally span two files.
 * - doctorFileSource(rel): one specific file under the doctor surface, for
 *   POSITIONAL assertions (indexOf ordering, slice windows) — concatenation
 *   would let those match across file boundaries, which is weaker than the
 *   guard intends. Callers name the file that holds the code post-peel.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DOCTOR_FACADE = join(REPO_ROOT, 'src', 'commands', 'doctor.ts');
const DOCTOR_DIR = join(REPO_ROOT, 'src', 'commands', 'doctor');

/** A separator no plausible TS source contains, so cross-file regex matches fail loudly. */
const FILE_BOUNDARY = '\n /* __doctor-source-file-boundary__ */ \n';

function listDoctorModules(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listDoctorModules(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every file on the doctor surface, façade first, then sorted module paths. */
export function doctorSourceFiles(): string[] {
  return [DOCTOR_FACADE, ...listDoctorModules(DOCTOR_DIR)];
}

/** Concatenated doctor surface for containment assertions. */
export function doctorSource(): string {
  return doctorSourceFiles()
    .map((f) => readFileSync(f, 'utf-8'))
    .join(FILE_BOUNDARY);
}

/**
 * One file of the doctor surface for positional assertions.
 * @param rel path relative to src/commands/ — e.g. 'doctor.ts' or 'doctor/checks/calibration.ts'
 */
export function doctorFileSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, 'src', 'commands', rel), 'utf-8');
}
