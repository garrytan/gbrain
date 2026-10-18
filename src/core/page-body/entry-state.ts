/**
 * Segmented page storage (Wave B): the parser state carried into a segment
 * (`page_body_manifest.entry_state`, spec 1.3). Everything a streaming parse
 * needs to process one segment alone, and to resume segmentation at that
 * segment, is here; page-global decisions known only at EOF (fence trust, the
 * truncated tail) live in `pages.body_flags`.
 *
 * JSON-safe (stored as JSONB) and versioned. Positions appear only while
 * something is open across the cut (a protected region's start, a truncated
 * tail), so an unchanged segment that merely shifted keeps an equal entry
 * state and its occurrence.
 */
import type { BodyRegion } from './types.ts';
import { newRegionTrack, type LinePosition, type PemStart, type RegionTrack } from './region-scan.ts';

export const ENTRY_STATE_VERSION = 1;

export type TimelineEntryState = 'none' | 'entry' | 'detail';
export type MarkerState = 'none' | 'after_marker' | 'details';

export interface EntryState {
  v: typeof ENTRY_STATE_VERSION;
  region: BodyRegion;
  /** The segment starts after `\n`, after a bare `\r`, or inside a line longer than a segment (forced cut). */
  at: LinePosition;
  /**
   * The protected-region scan under each fence trust. Stored regions use the
   * page's trust; the no-cut rule uses both, so a trust flip by append moves
   * regions but never a cut.
   */
  trusted: RegionTrack;
  untrusted: RegionTrack;
  /**
   * Projected chars since the last `PRIVATE KEY-----` under each trust (null:
   * none within PEM_CONTEXT_CHARS), and the partial match at the cut.
   */
  pemMargin: { trusted: number | null; untrusted: number | null; carryTrusted: string; carryUntrusted: string };
  /** Whether a PEM scan restarted here finds the same spans after the cut, and where it restarts. */
  pem: { clean: boolean; start: PemStart };
  /** Inside a withdrawal fence block (withdrawal-overlay.ts): the last facts marker seen was a begin. */
  withdrawal: { open: boolean; carry: string };
  /** parseTimelineEntries' detail run (link-extraction.ts): after a dated entry, with or without detail lines yet. */
  timeline: { entry: TimelineEntryState; heading: boolean };
  /** A materialized marker line, then its bullet and indented details (canonical-projections.ts). */
  marker: MarkerState;
  prevBlank: boolean;
  /** The page's winning conversation pattern, the day-header date context, the last anchor's date, and whether a message is open. */
  conversation: { pattern: string | null; fallbackDate: string | null; lastDate: string | null; open: boolean };
  /** pageOutline's fence toggle over the projection, and whether the projection is mid-line at the cut. */
  outline: { fence: boolean; midLine: boolean };
}

/** The state at the start of a region: `truth` for a page, or the timeline after the truth (see timelineEntryState). */
export function initialEntryState(opts: { region: BodyRegion; conversationPattern?: string | null }): EntryState {
  return {
    v: ENTRY_STATE_VERSION,
    region: opts.region,
    at: 'lf',
    trusted: newRegionTrack(),
    untrusted: newRegionTrack(),
    pemMargin: { trusted: null, untrusted: null, carryTrusted: '', carryUntrusted: '' },
    pem: { clean: true, start: 'region_start' },
    withdrawal: { open: false, carry: '' },
    timeline: { entry: 'none', heading: false },
    marker: 'none',
    prevBlank: false,
    conversation: { pattern: opts.conversationPattern ?? null, fallbackDate: null, lastDate: null, open: false },
    outline: { fence: false, midLine: false },
  };
}

/**
 * The timeline's entry state after the truth's exit state. Each column is
 * scanned alone today (fences, protected regions, private keys, timeline
 * entries), so those restart; the conversation context and the outline's
 * fence toggle run across the joined projection, so they carry.
 */
export function timelineEntryState(truthExit: EntryState): EntryState {
  return {
    ...initialEntryState({ region: 'timeline', conversationPattern: truthExit.conversation.pattern }),
    conversation: { ...truthExit.conversation },
    outline: { fence: truthExit.outline.fence, midLine: false },
  };
}

/** A stored entry state of this version, or null (the caller resegments the page). */
export function readEntryState(json: unknown): EntryState | null {
  if (!json || typeof json !== 'object') return null;
  const state = json as Partial<EntryState>;
  return state.v === ENTRY_STATE_VERSION && (state.region === 'truth' || state.region === 'timeline') ? state as EntryState : null;
}

/** Segmentation can resume at a segment with this entry state and reproduce a full run's stored regions too (cuts always match). */
export function isCleanResumePoint(state: EntryState): boolean {
  return state.pem.clean;
}

export function cloneEntryState(state: EntryState): EntryState {
  return structuredClone(state);
}
