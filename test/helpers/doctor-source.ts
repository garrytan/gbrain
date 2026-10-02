/**
 * Shared source-text loader for doctor structural guards.
 *
 * doctor.ts is being peeled into src/commands/doctor/ modules (containment
 * sprint). Guards that assert a string EXISTS somewhere in the doctor
 * implementation must read the whole doctor surface — the façade file plus
 * every extracted module — or a peel silently moves their target out of
 * sight and the guard rots into a permanently-green no-op.
 *
 * The doctor surface is one instance of the generic per-surface loaders in
 * test/helpers/source-surface.ts (refactor wave 1, A10); these wrappers keep
 * the original call sites and semantics.
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
import { surfaceFileSource, surfaceFiles, surfaceSource } from './source-surface.ts';

/** Every file on the doctor surface, façade first, then sorted module paths. */
export function doctorSourceFiles(): string[] {
  return surfaceFiles('doctor');
}

/** Concatenated doctor surface for containment assertions. */
export function doctorSource(): string {
  return surfaceSource('doctor');
}

/**
 * One file of the doctor surface for positional assertions.
 * @param rel path relative to src/commands/ — e.g. 'doctor.ts' or 'doctor/checks/calibration.ts'
 */
export function doctorFileSource(rel: string): string {
  return surfaceFileSource('doctor', `src/commands/${rel}`);
}
