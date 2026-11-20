/**
 * The commands that can turn a brain shared (gbrain access member add and member enable, gbrain access serves several,
 * the admin API's member add and enable, gbrain access owner set, gbrain config set brain.audience) keep conversation
 * archive pages written while the brain was personal to the owner before they return. Member add and enable, on every
 * path, do it before the member is added or enabled
 * (rescopeArchiveBefore), so the member's credentials never read those pages; every command then records it
 * (rescopeArchiveAfter, rescopeArchiveOnShared).
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { assertAccessId, getMember } from '../core/access/members.ts';

/**
 * Before gbrain access member add or member enable: when the member will be newly enabled, keeps the personal-era archive
 * pages to the owner first. member add calls it from addMember's beforeWrite, after every input check passed, so a
 * refused add changes nothing; member enable calls it for a disabled member only. A failure throws before the member is
 * added, enabled or bound, so nothing changes.
 */
export async function rescopeArchiveBefore(engine: BrainEngine, rawId: unknown, change: 'add' | 'enable'): Promise<void> {
  const id = assertAccessId(rawId);
  if (change === 'enable' && (await getMember(engine, id))?.status !== 'disabled') return;
  try {
    await (await import('../core/transcripts/archive.ts')).rescopeArchiveBeforeJoin(engine, id);
  } catch (e) {
    throw new Error('Nothing was changed: keeping the conversation archive pages written while this brain was personal to the owner failed before ' + id + ' was ' + (change === 'add' ? 'added' : 'enabled') + ' (' + (e instanceof Error ? e.message : String(e)) + '). Fix the cause, then rerun the command.');
  }
}

/** Runs the owner-only archive re-scope and says what happened on stderr, so stdout and --json stay the command's own. */
export async function rescopeArchiveAfter(engine: BrainEngine): Promise<void> {
  let results: Array<{ source_id: string; skipped: { message: string } | null }>;
  try {
    results = await (await import('../core/transcripts/archive.ts')).rescopeArchiveOnShared(engine);
  } catch (e) {
    setCliExitVerdict(1);
    console.error('Conversation archive: keeping the pages written while this brain was personal to the owner failed (' + (e instanceof Error ? e.message : String(e)) + '); until it succeeds every member may read them. Run gbrain transcripts archive run now.');
    return;
  }
  for (const r of results) {
    console.error('Conversation archive (source ' + r.source_id + '): ' + (r.skipped ? r.skipped.message : 'pages written while this brain was personal are now kept to the owner.'));
  }
}
