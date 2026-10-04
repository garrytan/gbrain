/** Absolute gbrain binary resolution for harness registrations and hook commands. */
import { basename, isAbsolute } from 'node:path';

/** Absolute gbrain binary path for registrations/hook commands [CX-P1.4].
 * GUI hosts inherit no PATH, so a bare name is never acceptable. */
export function resolveGbrainBin(): string | null {
  try {
    const which = Bun.which('gbrain');
    if (which && isAbsolute(which)) return which;
  } catch {
    /* fall through */
  }
  // Compiled-binary case: this process IS the gbrain binary.
  if (basename(process.execPath).startsWith('gbrain')) return process.execPath;
  return null;
}
