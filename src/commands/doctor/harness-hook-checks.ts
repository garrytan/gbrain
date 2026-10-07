/**
 * bootstrap_harness_health carrier rows (#6171): read each receipt-named
 * Claude Code hook carrier (read-only) and report what the receipt alone
 * cannot see. An event wired more than once with this install's entries
 * (marked or unmarked) fires twice → warn `harness_hook_duplicates` with a
 * re-run of the install's own flags. Entries the host stripped of their
 * `_gbrain` marker are expected (Claude Code drops unknown keys when it
 * rewrites settings.json) → an ok info row. A harness-looking entry that is
 * not this install's → warn `harness_hook_unowned`. A carrier that does not
 * parse → warn naming the file.
 */
import { harnessHookIdentity, scanHarnessHookCarrier } from '../../core/bootstrap/hooks.ts';
import type { HarnessReceipt } from '../../core/bootstrap/format.ts';
import { claudeUserSettingsPath } from '../../core/bootstrap/host-specs.ts';
import { resolveGbrainBin } from '../../core/gbrain-bin.ts';
import type { Check } from '../doctor.ts';
import { doctorVerify } from './check-fix.ts';

const NAME = 'bootstrap_harness_health';

export function harnessHookCarrierChecks(hr: HarnessReceipt, launcher: string | null = resolveGbrainBin()): Check[] {
  const checks: Check[] = [];
  const hookTargets = hr.targets.filter((t) => t.host === 'claude-code' && t.kind === 'hooks');
  for (const t of hookTargets) {
    const path = t.scope === 'user' ? (t.path ?? claudeUserSettingsPath()) : t.path!;
    const scan = scanHarnessHookCarrier(path, harnessHookIdentity(hr, t, { launcher }));
    if (scan.state === 'unparseable') {
      checks.push({
        name: NAME, status: 'warn',
        message: `the harness hook carrier ${path} is not valid JSON (${scan.error}) — Claude Code cannot run its hooks and gbrain cannot inspect them. Fix the JSON by hand, then re-run \`gbrain doctor --only ${NAME}\`.`,
        details: { reason: 'harness_hook_carrier_unparseable', path },
        fix_unavailable_reason: 'no_safe_automatic_fix',
      });
      continue;
    }
    const counts = Object.entries(scan.events);
    const duplicates = counts.filter(([, c]) => c.marked + c.command > 1).map(([e]) => e);
    const unowned = counts.filter(([, c]) => c.unowned > 0).map(([e]) => e);
    const unmarked = counts.reduce((n, [, c]) => n + c.command, 0);
    if (duplicates.length > 0) {
      const projects = hookTargets.filter((h) => h.scope !== 'user').flatMap((h) => ['--project', h.scope]);
      const capture = counts.some(([e, c]) => (e === 'Stop' || e === 'SessionEnd') && c.marked + c.command > 0);
      checks.push({
        name: NAME, status: 'warn',
        message: `${duplicates.map((e) => `hooks.${e}`).join(', ')} in ${path} ${duplicates.length > 1 ? 'are' : 'is'} wired more than once by this harness install, so each fires twice per event. Re-running the install converges to one entry per event.`,
        details: { code: 'harness_hook_duplicates', path, events: duplicates },
        fix: {
          argv: ['gbrain', 'bootstrap', 'harness', ...projects, ...(capture ? [] : ['--no-capture']), '--yes'],
          consent: ['persistent_install'], actor: 'agent', requires_exclusive: false,
          why: 'A re-run strips every entry this install owns (marked or not) and writes one per event; it also mints a fresh harness token.',
          user_message: `gbrain's session hooks are wired twice in ${path}, so they fire twice. May I re-run \`gbrain bootstrap harness\` with the same options to clean that up? It rewrites the hook entries and rotates the harness token.`,
          verify: doctorVerify(NAME),
        },
      });
    }
    if (unowned.length > 0) {
      checks.push({
        name: NAME, status: 'warn',
        message: `${unowned.map((e) => `hooks.${e}`).join(', ')} in ${path} looks like gbrain's harness hook but is not this install's exact command (edited, or another install's launcher); gbrain leaves it alone. If it is a leftover it fires next to this install's entry — ask the user whether to delete it by hand.`,
        details: { code: 'harness_hook_unowned', path, events: unowned },
        fix_unavailable_reason: 'operator_judgement',
      });
    }
    if (duplicates.length === 0 && unowned.length === 0 && unmarked > 0) {
      checks.push({
        name: NAME, status: 'ok', severity: 'info',
        message: `${unmarked} harness hook entr${unmarked === 1 ? 'y' : 'ies'} in ${path} carry no _gbrain marker (Claude Code drops unknown keys when it rewrites settings.json); gbrain recognizes them by their exact command, so removal and re-runs still find them. Nothing to do.`,
        details: { reason: 'harness_hook_marker_stripped', path, unmarked },
      });
    }
  }
  return checks;
}
