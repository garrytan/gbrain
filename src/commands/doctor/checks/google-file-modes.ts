import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { googleFileModesApplyCommand, googleFileModesPreviewCommand, scanGoogleFileModes } from '../../../core/google/file-modes.ts';

/**
 * Security fix wave: group/world-readable files and directories gbrain wrote
 * under a Google source directory outside `~/.gbrain`. Detection only; the
 * message names each directory with its counts (file names embed mail
 * subjects, so none are printed) and the exact preview and apply commands.
 */
export async function checkGoogleFileModes(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const scans = (await scanGoogleFileModes(engine, { sourceIds })).filter(scan => scan.loose.length);
    const sources = scans.map(scan => ({ source_id: scan.sourceId, dir: scan.dir,
      loose_files: scan.loose.filter(entry => entry.kind === 'file').length, loose_dirs: scan.loose.filter(entry => entry.kind === 'dir').length,
      preview_command: googleFileModesPreviewCommand(scan.sourceId), apply_command: googleFileModesApplyCommand(scan.sourceId) }));
    const details = { count: sources.reduce((sum, s) => sum + s.loose_files + s.loose_dirs, 0), sources, repair: 'google-file-modes',
      docs: 'docs/guides/google-connect.md' };
    if (!sources.length) return { name: 'google_file_modes', status: 'ok', message: 'No group- or world-readable gbrain files under Google source directories outside ~/.gbrain.', details };
    return { name: 'google_file_modes', status: 'warn', details,
      message: sources.map(s => `Google source ${s.source_id}: ${s.loose_files} file(s) and ${s.loose_dirs} director${s.loose_dirs === 1 ? 'y' : 'ies'} `
        + `gbrain wrote under ${s.dir} are readable by other local users (written before this release). `
        + `Preview: ${s.preview_command} — apply after the user agrees: ${s.apply_command}`).join(' ') };
  } catch (error) {
    return { name: 'google_file_modes', status: 'warn', details: { count: 'unknown' },
      message: `Google source file permissions could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
