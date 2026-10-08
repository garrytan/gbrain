/**
 * bootstrap/harness-hooks.ts — the harness lane's Claude Code hook entries
 * after the host dropped their `_gbrain` marker (#6092, #6171). Claude Code
 * rewrites settings.json through its own schema and can drop unknown keys, so
 * an entry is this install's when it carries the marker OR its command is
 * exactly the harness hook this install (or its receipt) rendered
 * (hooks.ts classifyHarnessHook). This module holds the receipt-aware glue
 * harness.ts calls: removal of one hooks target (with the `--dry-run`
 * preview), the `harness_hook_unowned` notice, the cross-HOME `--project`
 * guard probe and the `--status` carrier census.
 */
import { cliRenderContext, noticeBlock, renderNotice } from '../agent-output.ts';
import type { HarnessReceipt, HarnessTarget } from './format.ts';
import { GBRAIN_HARNESS_MARKER_VALUE } from './host-specs.ts';
import { harnessHookIdentity, removeClaudeHooksAt, scanHarnessHookCarrier } from './hooks.ts';

interface HookDeps {
  userSettingsPath: string;
  gbrainBin: string | null;
  log: (line: string) => void;
  logError: (line: string) => void;
}

const STATUS_ARGV = ['gbrain', 'bootstrap', 'harness', '--status'];

function carrierPath(t: HarnessTarget, d: Pick<HookDeps, 'userSettingsPath'>): string {
  return t.scope === 'user' ? (t.path ?? d.userSettingsPath) : t.path!;
}

/** The agent-first block for harness-looking entries gbrain would not delete. */
export function harnessHookUnownedNotice(settingsPath: string, events: string[]): string {
  const where = events.map((e) => `hooks.${e}`).join(', ');
  const rendered = renderNotice({
    code: 'harness_hook_unowned',
    kind: 'safety',
    why: `${where} in ${settingsPath} looks like gbrain's harness hook but is not this install's exact command ` +
      '(edited, or written by another install or launcher), so gbrain left it in place and does not report the harness as removed.',
    fix: {
      argv: ['gbrain', 'bootstrap', 'harness', '--remove'],
      consent: [],
      actor: 'user',
      requires_exclusive: false,
      why: 'Only the user can say whether that entry is a leftover; once it is gone the removal completes and consumes the receipt.',
      user_message: `Open ${settingsPath} and delete the ${where} entry that runs \`gbrain hook\` if you no longer want it ` +
        '(keep it only if you added it on purpose), then run `gbrain bootstrap harness --remove` again.',
      verify: { argv: STATUS_ARGV },
    },
  }, cliRenderContext());
  return `${noticeBlock(rendered)}\nverify: ${STATUS_ARGV.join(' ')}`;
}

/**
 * Remove one claude-code hooks target: marked entries plus unmarked entries
 * whose command is this install's (receipt launcher/seat, receipt source, the
 * running launcher). Logs each unmarked entry by event and why it matched.
 * Throws when a harness-looking entry that is not ours survives, so the
 * target stays failed on the receipt (`harness_hook_unowned`). `dryRun`
 * reports the same lines and writes nothing.
 */
export function removeHarnessHooksTarget(t: HarnessTarget, receipt: HarnessReceipt, d: HookDeps, dryRun = false): void {
  const settingsPath = carrierPath(t, d);
  const r = removeClaudeHooksAt(settingsPath, t.marker ?? GBRAIN_HARNESS_MARKER_VALUE, {
    identity: harnessHookIdentity(receipt, t, { launcher: d.gbrainBin }),
    dryRun,
  });
  if (r.notes.some((n) => n.startsWith('WARNING'))) throw new Error(r.notes.join('; '));
  const verb = dryRun ? 'would remove' : 'removed';
  for (const u of r.unmarked) d.log(`  ${verb} unmarked hooks.${u.event} entry: ${u.why}.`);
  const entries = `${r.removed} harness hook entr${r.removed === 1 ? 'y' : 'ies'}`;
  if (r.removed > 0) d.log(dryRun ? `would remove ${entries} from ${settingsPath}.` : `${entries} removed from ${settingsPath}.`);
  if (r.unowned.length > 0) {
    d.logError(harnessHookUnownedNotice(settingsPath, r.unowned));
    throw new Error(
      `harness_hook_unowned: ${r.unowned.map((e) => `hooks.${e}`).join(', ')} in ${settingsPath} looks like a gbrain harness hook ` +
        'this install did not write — left in place; delete it by hand, then re-run `gbrain bootstrap harness --remove`',
    );
  }
  if (r.removed === 0) d.log(`no harness hook entries in ${settingsPath}${dryRun ? '.' : ' — counted as removed.'}`);
}

/** `gbrain bootstrap harness --remove --dry-run`: what removal would do, with
 * the unmarked hook entries listed; nothing is written and the receipt stays. */
export function previewHarnessRemoval(receipt: HarnessReceipt, d: HookDeps): number {
  d.log('dry run: nothing is written; the receipt stays in place.');
  let blocked = false;
  for (const t of receipt.targets) {
    if (t.host === 'claude-code' && t.kind === 'hooks') {
      try {
        removeHarnessHooksTarget(t, receipt, d, true);
      } catch (e) {
        blocked = true;
        d.logError(`would fail ${t.host}/${t.kind}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    if (t.kind === 'permission' && t.mechanism === 'pre-existing') {
      d.log(`would leave permissions.allow entry '${t.entry}' in place (it predates the harness install).`);
      continue;
    }
    d.log(`would remove ${t.host}/${t.kind}${t.name ? ` '${t.name}'` : t.entry ? ` '${t.entry}'` : ''}${t.path ? ` (${t.path})` : ''}.`);
  }
  if (receipt.token.minted && receipt.token.id) d.log(`would revoke the harness token (id ${receipt.token.id}).`);
  return blocked ? 1 : 0;
}

/** True when the user-scope settings carry any harness hook entry, marked or
 * not, exact or edited (`unowned` by shape, W4.8), from any install —
 * `--project` wiring would double-fire next to it. */
export function harnessHooksPresent(settingsPath: string): boolean {
  const scan = scanHarnessHookCarrier(settingsPath, 'any');
  return Object.values(scan.events).some((c) => c.marked + c.command + c.unowned > 0);
}

/** `--status` census of each receipt-named hook carrier (read-only). */
export function harnessHookCarrierStatus(receipt: HarnessReceipt, d: Pick<HookDeps, 'userSettingsPath' | 'gbrainBin'>): Array<{
  path: string; state: string; ours: number; unmarked: number; duplicates: string[]; unowned: string[];
}> {
  return receipt.targets.filter((t) => t.host === 'claude-code' && t.kind === 'hooks').map((t) => {
    const path = carrierPath(t, d);
    const scan = scanHarnessHookCarrier(path, harnessHookIdentity(receipt, t, { launcher: d.gbrainBin }));
    const counts = Object.entries(scan.events);
    return {
      path,
      state: scan.state,
      ours: counts.reduce((n, [, c]) => n + c.marked + c.command, 0),
      unmarked: counts.reduce((n, [, c]) => n + c.command, 0),
      duplicates: counts.filter(([, c]) => c.marked + c.command > 1).map(([e]) => e),
      unowned: counts.filter(([, c]) => c.unowned > 0).map(([e]) => e),
    };
  });
}
