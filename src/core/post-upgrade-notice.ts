/**
 * The post-upgrade summary as a notice (agent operator contract v1, F7):
 * `kind: safety`, carrying contract_version (rendered) and the behavior-table
 * URL, emitted once by `gbrain post-upgrade` (terminal lines, or an [AGENT]
 * block for an agent) and once per upgraded version to the first stdio MCP
 * session (persisted under GBRAIN_HOME, so restarts do not repeat it).
 * GBRAIN_NO_ONBOARD_NUDGE=1 silences both. Never throws.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Notice } from './agent-output.ts';
import { writeCliNotices } from './interop-notices.ts';
import { gbrainPath } from './config.ts';
import { VERSION } from '../version.ts';

const BEHAVIOR_TABLE = 'CHANGELOG.md#behavior-changes-for-scripts-and-agents';

export function postUpgradeNotice(from: string | undefined, to: string = VERSION): Notice {
  return {
    code: 'post_upgrade',
    kind: 'safety',
    why: `gbrain was upgraded${from ? ` from v${from}` : ''} to v${to}. Agent contract v1 is in effect: errors carry \`code\` and a structured \`fix\` (follow fix.next), notices arrive as extra blocks, and exit 3 now means confirmation_required only. Scripts and agent instructions written for the old behavior should be checked against the behavior table.`,
    fix: {
      argv: ['gbrain', 'errors', '--changed'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Lists the error codes renamed in this release (old error value → new code); read-only.',
      docs: BEHAVIOR_TABLE,
    },
  };
}

/** The last upgrade gbrain recorded (`~/.gbrain/upgrade-state.json`, written by `gbrain upgrade`). */
function lastUpgrade(): { from?: string; to?: string } | null {
  try {
    const path = join(process.env.HOME || '', '.gbrain', 'upgrade-state.json');
    if (!existsSync(path)) return null;
    const state = JSON.parse(readFileSync(path, 'utf8')) as { last_upgrade?: { from?: string; to?: string } };
    return state.last_upgrade ?? null;
  } catch {
    return null;
  }
}

const seenPath = () => gbrainPath('notices', 'post-upgrade.json');
let checked = false;

/** Test seam: re-arm the once-per-process check. */
export function __resetPostUpgradeNoticeForTests(): void { checked = false; }

/**
 * stdio MCP: the notice for the first session after an upgrade to this
 * version, then never again for it. Checked once per process.
 */
export function takePostUpgradeMcpNotice(): Notice | null {
  if (checked) return null;
  checked = true;
  try {
    if (process.env.GBRAIN_NO_ONBOARD_NUDGE === '1') return null;
    const up = lastUpgrade();
    if (!up?.from || up.to !== VERSION) return null;
    const path = seenPath();
    try {
      if ((JSON.parse(readFileSync(path, 'utf8')) as { shown_version?: string }).shown_version === VERSION) return null;
    } catch { /* never shown */ }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ shown_version: VERSION, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return postUpgradeNotice(up.from, VERSION);
  } catch {
    return null;
  }
}

/** `gbrain post-upgrade`: write the summary notice once (terminal lines or an [AGENT] block). */
export function writePostUpgradeCliNotice(): void {
  if (process.env.GBRAIN_NO_ONBOARD_NUDGE === '1') return;
  writeCliNotices([postUpgradeNotice(lastUpgrade()?.from)]);
}
