/**
 * The commands that can turn a brain shared (gbrain access member add and member enable, gbrain access owner set,
 * gbrain config set brain.audience) call this after their change, so conversation archive pages written while the
 * brain was personal are kept to the owner before the command returns (rescopeArchiveOnShared).
 */
import type { BrainEngine } from '../core/engine.ts';

/** Runs the owner-only archive re-scope and says what happened on stderr, so stdout and --json stay the command's own. */
export async function rescopeArchiveAfter(engine: BrainEngine): Promise<void> {
  let results: Array<{ source_id: string; skipped: { message: string } | null }>;
  try {
    results = await (await import('../core/transcripts/archive.ts')).rescopeArchiveOnShared(engine);
  } catch (e) {
    process.exitCode = 1;
    console.error('Conversation archive: keeping the pages written while this brain was personal to the owner failed (' + (e instanceof Error ? e.message : String(e)) + '); until it succeeds every member may read them. Run gbrain transcripts archive run now.');
    return;
  }
  for (const r of results) {
    console.error('Conversation archive (source ' + r.source_id + '): ' + (r.skipped ? r.skipped.message : 'pages written while this brain was personal are now kept to the owner.'));
  }
}
