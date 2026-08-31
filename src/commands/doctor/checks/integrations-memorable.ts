/**
 * Memorable-relay health — the doctor surface for the optional third-party
 * session-end relay (see the consent-stamp + receipt sections in
 * src/core/context/hook-heartbeat.ts).
 *
 * Engine-free and read-only: every signal is a file-plane read (config gate,
 * consent stamp, the CLI's own config, the receipts/relay JSONL tails), so
 * the check runs under --fast and --scope=brain alike. Ladder:
 *
 *   gate off (default)                 → ok    ("intentionally off" — zero noise)
 *   enabled WITHOUT the gbrain stamp   → FAIL  (the `memorable enable`
 *                                        out-of-band state; names the fix)
 *   stamp ok, CLI shows no opt-in      → warn  (relay skips every spawn)
 *   stamp ok, no runnable binary       → FAIL  (enabled-but-not-installed)
 *   last relay run reported ok:false   → warn  (names the clamped cause;
 *                                        EXCEPT no_decisive_steps — the
 *                                        documented openclaw rejection — which
 *                                        becomes a DEFERRED ok-with-note that
 *                                        surfaces only after the codex rung
 *                                        below passes, so it never masks a
 *                                        dead codex trust entry)
 *   receipts exist, child NEVER wrote  → warn  (spawned, never reported —
 *                                        the silent-failure shape this whole
 *                                        surface exists to catch)
 *   otherwise                          → ok with structured details
 *
 * `out_of_band_settable: true` rides in details always: the enable flag in
 * ~/.gbrain/config.json can be flipped by the external CLI, which is exactly
 * why the gate also demands the gbrain-authored stamp.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../../../core/config.ts';
import { CODEX_HOOK_OWNERSHIP_TOKEN } from '../../../core/bootstrap/codex-hooks.ts';
import { codexHooksPath } from '../../../core/bootstrap/host-specs.ts';
import {
  clampRelayCause,
  lastRelayResult,
  memorableConsentEvidence,
  memorableGateAllowed,
  readSessionReceiptsTail,
  resolveMemorableBin,
} from '../../../core/context/hook-heartbeat.ts';
import type { Check } from '../../doctor.ts';

const NAME = 'memorable_relay_health';
const ENABLE_FIX = 'gbrain config set integrations.memorable.enabled true';

export async function buildMemorableRelayCheck(): Promise<Check> {
  try {
    const cfg = loadConfig();
    const gate = await memorableGateAllowed(cfg);
    const details: Record<string, unknown> = {
      enabled: gate.allowed || gate.reason === 'disclosure_missing',
      out_of_band_settable: true,
    };
    if (!gate.allowed) {
      if (gate.reason === 'disclosure_missing') {
        return {
          name: NAME,
          status: 'fail',
          message:
            'memorable relay is enabled but the gbrain-authored disclosure was never accepted ' +
            '(the flag was set out-of-band, e.g. by `memorable enable`). The relay stays OFF. ' +
            `Fix: run \`${ENABLE_FIX}\` and accept the disclosure.`,
          details: { ...details, reason: gate.reason },
        };
      }
      return {
        name: NAME,
        status: 'ok',
        message: `memorable relay off (${gate.reason === 'kill_switch' ? 'GBRAIN_MEMORABLE kill switch' : 'default'})`,
        details: { ...details, reason: gate.reason },
      };
    }
    const evidence = memorableConsentEvidence();
    if (!evidence.ok) {
      return {
        name: NAME,
        status: 'warn',
        message:
          `memorable relay is enabled but Memorable itself shows no opt-in (${evidence.reason}) — ` +
          'every spawn is skipped. Fix: `memorable init` then `memorable enable`.',
        details: { ...details, reason: evidence.reason },
      };
    }
    const bin = resolveMemorableBin();
    if (!bin) {
      return {
        name: NAME,
        status: 'fail',
        message:
          'memorable relay is enabled but no runnable `memorable` CLI was found (memorable_cli_missing). ' +
          'Fix: `npm i -g memorable-cli` (or point MEMORABLE_BIN at the binary).',
        details: { ...details, reason: 'memorable_cli_missing' },
      };
    }
    details.bin = bin;
    const [last, receipts] = await Promise.all([lastRelayResult(), readSessionReceiptsTail(200)]);
    details.receipts_recent = receipts.length;
    if (last) {
      details.last_relay_ts = last.ts;
      details.last_relay_ok = last.ok;
    }
    // The DOCUMENTED openclaw rejection (name-only traces, refused until
    // argument capture lands) is visible but ok — a rung that is known-red
    // for a whole supported cohort trains operators to ignore it. It is a
    // PENDING note, not an early return: on a mixed openclaw+codex host the
    // rejection is the persistent last-relay state, and returning here would
    // paint the check green forever while the codex rung below has a dead
    // trust entry to name.
    let expectedRejection: Check | null = null;
    if (last && !last.ok) {
      const cause = clampRelayCause(last.reason);
      if (cause === 'no_decisive_steps') {
        expectedRejection = {
          name: NAME,
          status: 'ok',
          message:
            'memorable relay running; last trace was refused as not replayable (no_decisive_steps) — expected for ' +
            'openclaw name-only capture until argument capture lands. See the capture matrix in docs/memorable-agents.md.',
          details: { ...details, reason: 'expected_openclaw_rejection' },
        };
      } else {
        return {
          name: NAME,
          status: 'warn',
          message: `the last memorable relay run reported failure (${cause}) — a fix becomes visible one session after it lands. \`memorable doctor\` has the child's side.`,
          details: { ...details, reason: `memorable_relay_${cause}` },
        };
      }
    }
    if (!last && receipts.length > 0) {
      return {
        name: NAME,
        status: 'warn',
        message:
          `${receipts.length} session receipt(s) written but the relay child has never reported an outcome — ` +
          'enabled-but-broken looks exactly like this. Check `memorable doctor` and that `memorable record` runs at all.',
        details: { ...details, reason: 'relay_never_reported' },
      };
    }
    // Codex hooks are TRUST-GATED and fail silently on 0.147.0 (a stale trust
    // index after the user reorders their own SessionEnd groups looks exactly
    // like "nothing happened") — wired-but-zero-receipts is the one signal
    // that failure mode leaves behind [OV8c].
    if (codexHooksWired() && !receipts.some((r) => r.harness === 'codex')) {
      return {
        name: NAME,
        status: 'warn',
        message:
          'codex SessionEnd hook is wired but no codex-harness receipt appears in the recent receipt window — codex hooks fail ' +
          'SILENTLY when their config.toml trust entry is stale/missing. Re-run `gbrain bootstrap hooks --harness codex` to re-trust.',
        details: { ...details, reason: 'codex_hooks_never_fired' },
      };
    }
    if (expectedRejection) return expectedRejection;
    return { name: NAME, status: 'ok', message: 'memorable relay healthy (consented, installed, last run ok)', details };
  } catch {
    return { name: NAME, status: 'warn', message: 'memorable relay state unreadable', details: { out_of_band_settable: true } };
  }
}

/** True when a gbrain-owned SessionEnd entry sits in the codex hooks file. */
function codexHooksWired(): boolean {
  try {
    const p = codexHooksPath();
    if (!existsSync(p)) return false;
    return readFileSync(p, 'utf8').includes(CODEX_HOOK_OWNERSHIP_TOKEN);
  } catch {
    return false;
  }
}
