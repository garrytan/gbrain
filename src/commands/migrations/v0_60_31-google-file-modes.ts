/**
 * Security fix wave: the one-time notice for Google sources whose directory
 * is outside `~/.gbrain`. Files gbrain wrote there before this release keep
 * the permissions they were written with (typically 0644), and only a rewrite
 * tightens them. Detection only: the notice names each directory, the count
 * of group/world-readable entries found now and the opt-in repair commands.
 * Nothing is chmod-ed here. A config marker makes it print once per brain.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { googleFileModesApplyCommand, googleFileModesPreviewCommand, scanGoogleFileModes } from '../../core/google/file-modes.ts';
import type { OrchestratorPhaseResult } from './types.ts';

export const GOOGLE_FILE_MODES_NOTICE_KEY = 'google.file_modes_notice';

export function googleFileModesNoticeLines(scans: Awaited<ReturnType<typeof scanGoogleFileModes>>): string[] {
  return scans.map(scan => `[google] Google source ${scan.sourceId} keeps its files in ${scan.dir}, outside ~/.gbrain. `
    + 'Files gbrain wrote there before this version keep their old permissions and may be readable by other local users '
    + `(${scan.loose.length} found now). Preview the fix: ${googleFileModesPreviewCommand(scan.sourceId)} — `
    + `apply after review: ${googleFileModesApplyCommand(scan.sourceId)}. Verify and repair options: docs/guides/google-connect.md`);
}

export async function googleFileModesNoticePhase(engine: BrainEngine | null, opts: { dryRun: boolean; print?: (line: string) => void }): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'google_file_modes_notice', status: 'skipped', detail: 'dry-run' };
  if (!engine) return { name: 'google_file_modes_notice', status: 'skipped', detail: 'no_brain_configured' };
  if (await engine.getConfig(GOOGLE_FILE_MODES_NOTICE_KEY)) return { name: 'google_file_modes_notice', status: 'skipped', detail: 'already_shown' };
  const lines = googleFileModesNoticeLines(await scanGoogleFileModes(engine));
  for (const line of lines) (opts.print ?? console.log)(line);
  await engine.setConfig(GOOGLE_FILE_MODES_NOTICE_KEY, new Date().toISOString());
  return { name: 'google_file_modes_notice', status: 'complete', detail: `${lines.length} custom-dir Google source(s)` };
}
