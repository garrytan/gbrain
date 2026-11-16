/**
 * The upgrade matrix's own break issue (GBRA-224 W2, stability plan item 3a): the nightly run opens or
 * updates one issue carrying ISSUE_MARKER and the ISSUE_LABEL label when it is red, and closes it when a later
 * run is green. scripts/stable-daily.ts holds stable while that issue is open; any other issue with the label
 * holds nothing. The issue names the from-versions that failed on a RED_FROM_MARKER line, which is what lets a
 * security or data-loss fix pass an open break when it is green on every other from-version.
 * No imports: stable-daily.yml installs no dependencies.
 */
export const ISSUE_MARKER = '<!-- gbrain-upgrade-matrix:nightly -->';
export const ISSUE_LABEL = 'upgrade-break';
const RED_FROM_PREFIX = '<!-- gbrain-upgrade-matrix:red-from ';

/** A run summary's shape as far as the failing from-versions go (scripts/upgrade-matrix.ts buildSummary). */
export interface RunSummaryCells {
  cells?: Array<{ id: string; from: string; verdict: string; fault?: string | null }>;
  red?: string[];
  holds?: string[];
}

/** Cell ids are `<from tag>__<engine>__<keys>__<brain>` (cell.ts cellId); a door id (`door:<name>`) has no from-version. */
const fromOfId = (id: string): string | null => (id.startsWith('door:') ? null : id.split('__')[0] || null);

/**
 * The from-versions with a red or held cell, sorted, and whether a door failed or held (a door has no
 * from-version, so nothing can excuse it).
 */
export function failingFrom(s: RunSummaryCells): { from: string[]; door: boolean } {
  const out = new Set<string>();
  let door = false;
  for (const id of [...(s.red ?? []), ...(s.holds ?? [])]) {
    const cell = s.cells?.find(c => c.id === id);
    const from = cell ? cell.from : fromOfId(id);
    if (from === null) door = true;
    else out.add(from);
  }
  return { from: [...out].sort(), door };
}

export const renderRedFrom = (from: readonly string[]) => RED_FROM_PREFIX + from.join(',') + ' -->';

/** The from-versions an issue body names, or null when it names none (an issue written before this line existed). */
export function parseRedFrom(body: string): string[] | null {
  const line = body.split('\n').find(l => l.startsWith(RED_FROM_PREFIX) && l.trimEnd().endsWith('-->'));
  if (!line) return null;
  const from = line.slice(RED_FROM_PREFIX.length).replace(/-->\s*$/, '').split(',').map(t => t.trim()).filter(t => /^v\d+\.\d+\.\d+(\.\d+)?$/.test(t));
  return from.length ? from : null;
}
