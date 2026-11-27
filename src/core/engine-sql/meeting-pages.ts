/**
 * The meetings connector's page lookup (src/core/meetings/meetings-source.ts `existingPath`): the live page of a
 * source that holds a meeting, found by its frontmatter `meeting_id`. The statement is the caller's, byte for byte, and
 * both SQL engines run it through their own `executeRaw`. The Rust store serves the same member
 * (rust/crates/gbrain-store/src/meeting_pages.rs).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** A meeting's page: its slug and recorded path. */
export interface MeetingPageRow { slug: string; source_path: string | null }

/** The live page of the source whose frontmatter `meeting_id` text is `meetingId`, the lowest id first; null when none. */
export async function readMeetingPage(raw: Raw, sourceId: string, meetingId: string): Promise<MeetingPageRow | null> {
  const [row] = await raw.executeRaw<MeetingPageRow>(
    `SELECT slug,source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'meeting_id'=$2 ORDER BY id LIMIT 1`, [sourceId, meetingId]);
  return row ?? null;
}
