/**
 * #6661 option B: `gbrain bootstrap harness --token` on a PGLite brain while no serve answers.
 *
 * The serve holds the PGLite single-writer lock, so a stopped serve is the normal state for wiring. When
 * `/health` gets no response at all and no serve holds the brain, the run wires every target and ends
 * `pending_verify` (exit 13) instead of failing before any write. A serve that holds the brain but does not
 * answer at this url (a wrong --url/--port), anything answering with a non-ok reply, a run without --token,
 * registrar mode and Postgres brains still fail the health check.
 *
 * The completion step is the same --token run once the serve is up: it needs no PGLite lock (nothing is
 * minted, and source resolution falls back while a serve holds the brain), verifies over HTTP and enrolls
 * shared skills. `--status` stays partial while the receipt carries `verify_pending`; each run writes a
 * fresh receipt, so the next run that passes its smoke clears it.
 */
import { cliRenderContext, renderAction, type Action, type RenderedAction } from '../agent-output.ts';
import type { GBrainConfig } from '../config.ts';
import type { HarnessReceipt } from './format.ts';
import type { ServeHealth } from './serve-health.ts';

interface PendingVerifyDeps {
  loadFileConfig: () => GBrainConfig | null;
  pgliteLiveServe: () => boolean;
  logError: (line: string) => void;
}

/**
 * The step-2 health verdict: true when the run proceeds as pending_verify. Logs the hard-stop line when
 * the caller must return 1 (`!health.ok` and not pending), or the pending note.
 */
export function harnessVerifyPending(health: ServeHealth, flags: { token?: string }, registrarMode: boolean, url: string, d: PendingVerifyDeps): boolean {
  if (health.ok) return false;
  const pending = health.unreachable === true && flags.token !== undefined && !registrarMode &&
    d.loadFileConfig()?.engine === 'pglite' && !d.pgliteLiveServe();
  d.logError(pending
    ? `no gbrain serve answers at ${url} and none holds this PGLite brain: wiring with the supplied --token now; verification waits for the serve (pending_verify).`
    : `no healthy gbrain serve at ${url} (${health.detail ?? 'unreachable'}) — start \`gbrain serve --http\` on this box first (or pass --url/--port).`);
  return pending;
}

/** The fix: this run's argv with the token shown as `<TOKEN>`, the resolved source pinned, and --yes. */
export function harnessPendingVerifyFix(raw: readonly string[], url: string, resolvedSource: string | null): Action {
  const argv = ['gbrain', 'bootstrap', 'harness'];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--json') continue;
    if (raw[i] === '--token') { i++; argv.push('--token', '<TOKEN>'); continue; }
    argv.push(raw[i]!);
  }
  if (resolvedSource) argv.push('--source', resolvedSource);
  if (!argv.includes('--yes')) argv.push('--yes');
  return {
    argv,
    inputs: [{ name: 'TOKEN', how: 'The same token this run was given with --token.' }],
    consent: [],
    actor: 'user',
    why: 'The smoke test needs a running serve; the re-run verifies the wiring over HTTP while the serve holds the PGLite brain.',
    user_message: `Start \`gbrain serve --http\` for this brain (it must answer at ${url}), then re-run this command with the same --token. ` +
      '`gbrain bootstrap harness --status` reports partial until that run passes its smoke test.',
    verify: { argv: ['gbrain', 'bootstrap', 'harness', '--status', '--json'] },
    docs: 'docs/guides/bootstrap.md#pending-verify',
    requires_exclusive: false,
  };
}

/** Records the marker on the receipt, logs the outcome and returns the fix. */
export function finishPendingVerify(receipt: HarnessReceipt, save: () => void, raw: readonly string[], url: string,
  resolvedSource: string | null, d: Pick<PendingVerifyDeps, 'logError'>): Action {
  const fix = harnessPendingVerifyFix(raw, url, resolvedSource);
  receipt.verify_pending = { since: new Date().toISOString(), reason: 'serve_unreachable' };
  save();
  d.logError(`pending_verify: the harness is wired but not verified. ${fix.user_message}`);
  return fix;
}

/** The apply `--json` outcome fields: `status`, and `code` + rendered `fix` when pending. */
export function harnessOutcomeFields(pendingFix: Action | null, ok: boolean): { status: string; code?: string; fix?: RenderedAction } {
  if (!pendingFix) return { status: ok ? 'ok' : 'failed' };
  return { status: 'pending_verify', code: 'pending_verify', fix: renderAction(pendingFix, cliRenderContext()) };
}

export function pendingVerifyStatusLine(pending: NonNullable<HarnessReceipt['verify_pending']>): string {
  return `  partial: wired ${pending.since} while no serve answered (pending_verify) — with \`gbrain serve --http\` running, ` +
    're-run the same `gbrain bootstrap harness --token <TOKEN>` command to verify and finish.';
}
