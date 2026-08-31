/**
 * bootstrapDoctorChecks — verbatim peel from src/commands/doctor.ts
 * (containment sprint). No behavior change; doctor.ts re-exports the symbol
 * and buildChecks consumes it.
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import type { BrainEngine } from '../../core/engine.ts';
import { LATEST_VERSION } from '../../core/migrate.ts';
// Agent-bootstrap doctor group (plan B2/B4/ENG-4 + one-live-serve note).
import { readHarnessReceiptState, readReceipt } from '../../core/bootstrap/format.ts';
import { probeLivePgliteHolder, resolveBrainDataDir } from '../../core/bootstrap/uninstall.ts';
import { readRunbookStamp, hooksInstalled, listVerifyRuns } from '../../core/bootstrap/status.ts';
import { resolveGbrainHome } from '../../core/gbrain-home.ts';
import { VERSION as GBRAIN_BINARY_VERSION } from '../../version.ts';
import type { Check } from '../doctor.ts';

/**
 * Agent-bootstrap check group (plan B2, B4, ENG-4, one-live-serve, C1 skew).
 *
 * Gated on bootstrap state actually existing on this machine (install
 * receipt, hook heartbeat, or push-status) — machines that never ran
 * `gbrain bootstrap` get ZERO checks from this group. Every probe is
 * fail-soft: a broken telemetry file degrades to a warn, never a throw.
 */
export async function bootstrapDoctorChecks(engine: BrainEngine | null): Promise<Check[]> {
  const checks: Check[] = [];
  let home: string;
  try {
    home = resolveGbrainHome();
  } catch {
    return [];
  }

  // 00. Plugin-lane coexistence. Runs BEFORE the bootstrap-state gate: a
  // hand-wired registration can coexist with a plugin on machines that never
  // ran `gbrain bootstrap`. Emits rows ONLY when a gbrain plugin is ENABLED
  // in a harness config (machines without the plugin get zero noise):
  // warn = a hand-wired registration also exists (duplicate tool
  // registration; which server wins is host-defined), ok = the plugin is the
  // sole owner. "Enabled" is a CONFIG signal, not a health signal — the row
  // says so. Fail-soft like every probe in this group.
  try {
    const {
      codexPluginProvidesName,
      claudePluginProvidesName,
      codexAnyRegistrationExists,
      claudeAnyRegistrationExists,
    } = await import('../../core/bootstrap/harness.ts');
    const { codexConfigPath, claudeUserSettingsPath, claudeUserMcpConfigPath } = await import('../../core/bootstrap/host-specs.ts');
    const claudeUserMcpConfig = claudeUserMcpConfigPath();
    const lanes: Array<{ harness: string; plugin: string; dup: boolean; disambiguate: string }> = [];
    const codexPlugin = codexPluginProvidesName(codexConfigPath(), 'gbrain');
    if (codexPlugin) {
      lanes.push({
        harness: 'codex',
        plugin: codexPlugin,
        dup: codexAnyRegistrationExists(codexConfigPath(), 'gbrain'),
        disambiguate: 'keep one owner: `codex mcp remove gbrain` (drop the hand-wired entry) or `codex plugin remove gbrain@gbrain` (drop the plugin)',
      });
    }
    const claudePlugin = claudePluginProvidesName(claudeUserSettingsPath(), 'gbrain');
    if (claudePlugin) {
      lanes.push({
        harness: 'claude-code',
        plugin: claudePlugin,
        dup: claudeAnyRegistrationExists(claudeUserMcpConfig, 'gbrain', process.cwd()),
        disambiguate: 'keep one owner: `claude mcp remove gbrain` (drop the hand-wired entry) or disable the plugin in Claude Code',
      });
    }
    for (const lane of lanes) {
      checks.push(
        lane.dup
          ? {
              name: 'plugin_lane_collision',
              status: 'warn',
              message:
                `${lane.harness}: the '${lane.plugin}' plugin AND a hand-wired gbrain MCP registration both exist — ` +
                `duplicate tool registration is host-defined behavior; ${lane.disambiguate}. ` +
                '(Plugin enabled is a config signal, not a health signal.)',
            }
          : {
              name: 'plugin_lane_collision',
              status: 'ok',
              message: `${lane.harness}: the '${lane.plugin}' plugin provides gbrain and no hand-wired registration was found in the scanned configs (user scope + this directory).`,
            },
      );
    }
  } catch {
    /* fail-soft: a broken harness config never breaks doctor */
  }

  const receipt = readReceipt(home);
  // One reader for every push-status surface [D8]; per-root files [D13].
  const { readPushStatuses, pushStatusFilesExist } = await import('../../core/workspace-push.ts');
  const pushStatuses = readPushStatuses();
  const statusFilesOnDisk = pushStatusFilesExist();
  const heartbeatFile = join(home, 'integrations', 'hooks', 'heartbeat.jsonl');
  // #4043: a harness-only box (bootstrap harness, no workspace install) is
  // bootstrap state too — without this, such a machine gets ZERO checks.
  const harnessState = readHarnessReceiptState(home);
  const hasBootstrapState =
    receipt !== null || statusFilesOnDisk || existsSync(heartbeatFile) || harnessState.state !== 'absent';
  // Return the pre-gate rows (plugin-lane coexistence) even on machines with
  // no bootstrap state — the plugin lane needs no bootstrap to exist.
  if (!hasBootstrapState) return checks;

  const ws = receipt?.workspace_dir ?? null;

  // 0. Harness registration health (#4043): three states so it neither cries
  // wolf nor goes silent — skip (not a harness box) / warn (serve unreachable,
  // a normal transient; or receipt unreadable) / fail (a target failed, or a
  // prior rotation never converged). Token liveness needs the bearer (only
  // recoverable from host config) — that's `gbrain bootstrap harness
  // --status`'s job; doctor stays offline-cheap.
  if (harnessState.state === 'ok') {
    const hr = harnessState.receipt;
    const failed = hr.targets.filter((t) => t.state === 'failed');
    const pending = hr.targets.filter((t) => t.state === 'pending');
    if (failed.length > 0 || pending.length > 0) {
      checks.push({
        name: 'bootstrap_harness_health',
        status: 'fail',
        message:
          `harness wiring incomplete: ${failed.length} failed / ${pending.length} pending target(s)` +
          ` — re-run \`gbrain bootstrap harness\` to converge (details: gbrain bootstrap harness --status).`,
      });
    } else if (hr.token.previous_ids && hr.token.previous_ids.length > 0) {
      checks.push({
        name: 'bootstrap_harness_health',
        status: 'fail',
        message: `${hr.token.previous_ids.length} previous harness token(s) were never revoked (ids ${hr.token.previous_ids.join(', ')}) — re-run \`gbrain bootstrap harness\`, or run \`gbrain auth revoke\` with the id flag per id.`,
      });
    } else if (hr.targets.length === 0 && hr.token.minted && hr.token.id !== undefined) {
      // Half-removed state: a remove under a live PGLite serve strips every
      // host target but defers the revoke — the wiring is gone yet the minted
      // token stays ACTIVE. A vacuous all-confirmed must not read green.
      // (Flag names spelled without dashes here: the flag-registry generator
      // harvests bare flag tokens from comments one import level deep.)
      checks.push({
        name: 'bootstrap_harness_health',
        status: 'fail',
        message: `harness removal pending: host wiring removed but the minted token (id ${hr.token.id}) is not yet revoked — stop the serve and re-run \`gbrain bootstrap harness\` with the remove flag, or run \`gbrain auth revoke\` with the id flag.`,
      });
    } else {
      try {
        const base = hr.url.replace(/\/mcp$/, '');
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
        const body = res.ok ? ((await res.json()) as { status?: string }) : null;
        if (body?.status === 'ok') {
          checks.push({
            name: 'bootstrap_harness_health',
            status: 'ok',
            message: `harness wired to ${hr.url} (serve healthy; token check: gbrain bootstrap harness --status)`,
          });
        } else {
          checks.push({
            name: 'bootstrap_harness_health',
            status: 'warn',
            message: `harness wired to ${hr.url} but the serve is not answering /health — start \`gbrain serve\` in http mode (a down serve is a normal transient, sessions just lose brain access until it returns).`,
          });
        }
      } catch {
        checks.push({
          name: 'bootstrap_harness_health',
          status: 'warn',
          message: `harness wired to ${hr.url} but the serve is unreachable — start \`gbrain serve\` in http mode.`,
        });
      }
    }
  } else if (harnessState.state !== 'absent') {
    checks.push({
      name: 'bootstrap_harness_health',
      status: 'warn',
      message: `the harness receipt is unreadable (${harnessState.state}) — see \`gbrain bootstrap harness --status\`.`,
    });
  }

  // 1. Hook heartbeat failure rate [B3 read side]. Hard errors only —
  // degraded entries are DESIGNED fallbacks (pull-mode, no serve).
  let hooksSeen = false;
  try {
    const { readHeartbeatTail, HEARTBEAT_FAILURE_WINDOW, HEARTBEAT_FAILURE_RATE_THRESHOLD } =
      await import('../hook.ts');
    const tail = await readHeartbeatTail(HEARTBEAT_FAILURE_WINDOW);
    if (tail.length > 0) {
      hooksSeen = true;
      const failures = tail.filter((e) => e.outcome === 'error').length;
      const rate = failures / tail.length;
      if (rate > HEARTBEAT_FAILURE_RATE_THRESHOLD) {
        checks.push({
          name: 'bootstrap_hooks_heartbeat',
          status: 'fail',
          message: `${failures}/${tail.length} recent hook invocations hard-failed — brain context is not reaching the session. Check \`gbrain bootstrap verify\` and the serve process.`,
        });
      } else if (rate > 0.2) {
        checks.push({
          name: 'bootstrap_hooks_heartbeat',
          status: 'warn',
          message: `${failures}/${tail.length} recent hook invocations hard-failed. Watch it; hooks fail open so sessions still work.`,
        });
      } else {
        // Degraded entries are designed fallbacks, but a window that is
        // MOSTLY one degrade reason is a standing misconfiguration hiding
        // behind "healthy" — name the top reason so it is at least visible.
        const degradedReasons = tail.filter((e) => e.outcome === 'degraded' && e.reason).map((e) => e.reason as string);
        let topClause = '';
        if (degradedReasons.length > 0) {
          const counts = new Map<string, number>();
          for (const r of degradedReasons) counts.set(r, (counts.get(r) ?? 0) + 1);
          const [topReason, topN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
          topClause = `; ${degradedReasons.length}/${tail.length} degraded (top: ${topReason} x${topN})`;
        }
        checks.push({
          name: 'bootstrap_hooks_heartbeat',
          status: 'ok',
          message: `hook heartbeat healthy (${failures}/${tail.length} hard failures in the trailing window${topClause})`,
        });
      }
    }
  } catch {
    checks.push({ name: 'bootstrap_hooks_heartbeat', status: 'warn', message: 'hook heartbeat unreadable' });
  }

  // 2. Push staleness [B4]: fail when the last successful push is >48h old
  // AND the workspace tree is dirty (recent work provably unpushed). Per-root
  // status files [D13]: the WORST entry decides, so one workspace's success
  // can never mask another's failure.
  try {
    if (pushStatuses.length > 0) {
      const { PUSH_STALE_MS } = await import('../hook.ts'); // hook.ts owns the threshold (single source)
      const failing = pushStatuses.filter((s) => s.ok === false);
      if (failing.length > 0) {
        const s = failing[0]!;
        const target = s.repoRoot ?? ws ?? undefined;
        const rest = failing.length > 1 ? ` [+${failing.length - 1} more workspace(s)]` : '';
        checks.push({
          name: 'bootstrap_push_health',
          status: 'warn',
          message: `last workspace push FAILED${target ? ` for ${target}` : ''} (${s.ts ?? 'unknown'}): ${s.reason ?? 'unknown'}${rest} — run \`gbrain sources push${target ? ` --path ${target}` : ''}\``,
        });
      } else {
        const stamps = pushStatuses.map((s) => Date.parse(s.ts ?? '')).filter((t) => Number.isFinite(t));
        const stalest = stamps.length > 0 ? Math.min(...stamps) : NaN;
        const staleIso = Number.isFinite(stalest) ? new Date(stalest).toISOString() : 'unknown';
        const stale = Number.isFinite(stalest) && Date.now() - stalest > PUSH_STALE_MS;
        let dirty = false;
        if (ws) {
          try {
            dirty = execFileSync('git', ['-C', ws, 'status', '--porcelain'], {
              stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
            }).toString().trim() !== '';
          } catch { dirty = false; }
        }
        if (stale && dirty) {
          checks.push({
            name: 'bootstrap_push_health',
            status: 'fail',
            message: `last successful push ${staleIso} (>48h) with a DIRTY workspace tree — recent agent memory is unpushed [B4]. Run \`gbrain sources push --path ${ws}\`.`,
          });
        } else if (stale) {
          checks.push({ name: 'bootstrap_push_health', status: 'warn', message: `last successful push ${staleIso} (>48h ago); tree clean — likely just idle` });
        } else {
          checks.push({ name: 'bootstrap_push_health', status: 'ok', message: `last push ok (${staleIso})` });
        }
      }
    } else if (statusFilesOnDisk) {
      // Files exist but none parsed — the tolerant reader skips corrupt
      // records; doctor must not let that read as "no news is good news".
      checks.push({ name: 'bootstrap_push_health', status: 'warn', message: 'push status unreadable' });
    }
  } catch {
    checks.push({ name: 'bootstrap_push_health', status: 'warn', message: 'push status unreadable' });
  }

  // 2b. Durability job [B7/D7]: presence + LIVENESS. A presence-only check
  // certifies dead jobs as healthy (the autopilot-status failure mode), so
  // this warns on plist-present-but-unloaded and stale pull logs. Only warns
  // when the user actually consented to the job; containers/cloud sandboxes
  // are expected to have none.
  try {
    if (ws !== null && receipt !== null) {
      const { detectExecutionEnvironment } = await import('../../core/execution-env.ts');
      const envKind = detectExecutionEnvironment();
      if (envKind !== 'local') {
        // Answered BEFORE the subprocess probes — cloud/container doctor
        // runs must not pay launchctl/crontab spawns for an answer that is
        // discarded (no scheduler exists there by design).
        checks.push({
          name: 'bootstrap_durability_job',
          status: 'ok',
          message: `no scheduler in this environment (${envKind}) — expected; per-turn and session-end pushes cover persistence`,
        });
      } else {
      const { durabilityJobStatus } = await import('../../core/brain-repo-durability.ts');
      const { readInterviewState } = await import('../../core/bootstrap/interview.ts');
      const sourceId = receipt.source_id ?? 'workspace';
      const js = durabilityJobStatus(sourceId);
      let consented = false;
      try {
        const iv = readInterviewState(ws);
        consented = iv.ok && (iv.state.answers['PERSIST_CRON']?.value ?? '').toLowerCase() === 'yes';
      } catch { consented = false; }
      if (!consented) {
        if (js.kind !== 'none') {
          checks.push({ name: 'bootstrap_durability_job', status: 'ok', message: `${js.kind} pull job present (not required by consent — fine)` });
        }
        // no consent + no job → nothing to check; stay silent
      } else if (js.kind === 'none') {
        checks.push({
          name: 'bootstrap_durability_job',
          status: 'warn',
          message: `background persistence was consented (PERSIST_CRON=yes) but no scheduled job exists — run \`gbrain sources harden ${sourceId}\``,
        });
      } else if (js.live === false) {
        checks.push({
          name: 'bootstrap_durability_job',
          status: 'warn',
          message: `${js.kind} job is on disk but NOT loaded — a dead job looks healthy to presence checks. Re-run \`gbrain sources harden ${sourceId}\` to reload it.`,
        });
      } else if (!js.wrapperPresent) {
        checks.push({
          name: 'bootstrap_durability_job',
          status: 'warn',
          message: `${js.kind} job exists but its wrapper script is missing — re-run \`gbrain sources harden ${sourceId}\``,
        });
      } else if (js.logFresh === false) {
        checks.push({
          name: 'bootstrap_durability_job',
          status: 'warn',
          message: `${js.kind} job present but the pull log is stale (no run within 2× the interval) — the job may be dead; re-run \`gbrain sources harden ${sourceId}\``,
        });
      } else if (js.kind === 'crontab' && js.logFresh === undefined) {
        // The crontab LINE existing proves installation, not that the cron
        // daemon runs it — with no pull log yet we can't claim liveness.
        checks.push({ name: 'bootstrap_durability_job', status: 'ok', message: 'crontab pull job installed (no run logged yet — liveness confirmed once it first fires)' });
      } else {
        checks.push({ name: 'bootstrap_durability_job', status: 'ok', message: `${js.kind} pull job present and live` });
      }
      }
    }
  } catch { /* best-effort — durability probing never fails doctor */ }

  // 3. One-live-serve / lock collision note. A live serve is the healthy
  // shape (it provides hook IPC); the note names the v1 contract.
  try {
    const dataDir = resolveBrainDataDir(home);
    const holder = probeLivePgliteHolder(dataDir);
    if (holder) {
      checks.push({
        name: 'bootstrap_serve_lock',
        status: holder.serve ? 'ok' : 'warn',
        message: holder.serve
          ? `live serve (pid ${holder.pid}) owns the brain — hook IPC available. One live serve per brain is the v1 contract; a second simultaneous session collides politely.`
          : `a non-serve gbrain process (pid ${holder.pid}) holds the PGLite lock — hook IPC and new sessions will fail until it exits.`,
      });
    }
  } catch { /* probe is best-effort */ }

  // 4. [ENG-4] Hooks-in-use + unmigrated brain: the direct-engine hook paths
  // swallow missing-table errors on pre-v110/v117 schemas, so context
  // degrades SILENTLY. Pair the two signals into a named warning.
  const hooksActive = hooksSeen || (ws !== null && hooksInstalled(ws));
  if (hooksActive && engine) {
    try {
      const versionStr = await engine.getConfig('version');
      const version = parseInt(versionStr || '0', 10);
      if (version < LATEST_VERSION) {
        checks.push({
          name: 'bootstrap_hook_schema_pairing',
          status: 'warn',
          message: `hooks are in use but the brain schema is v${version} (< v${LATEST_VERSION}) — hook context can degrade silently on missing tables [ENG-4]. Run \`gbrain apply-migrations --yes\`.`,
        });
      }
    } catch { /* schema_version check above already covers unreadable version */ }
  }

  // 5. Runbook skew [C1]: the fetched runbook's stamp vs this binary.
  if (ws) {
    try {
      const stamp = readRunbookStamp(ws);
      if (stamp !== null && stamp !== GBRAIN_BINARY_VERSION) {
        checks.push({
          name: 'bootstrap_runbook_skew',
          status: 'warn',
          message: `BOOTSTRAP_FOR_AGENTS.md stamp ${stamp} != installed binary ${GBRAIN_BINARY_VERSION} — prefer the binary's instructions; re-fetch the runbook.`,
        });
      }
    } catch { /* best effort */ }
  }

  // 6. Last verify freshness [B2 read side] — surfaced so "verify weekly"
  // has a nag with teeth.
  try {
    const runs = listVerifyRuns(home);
    if (runs.length > 0) {
      const last = runs[0];
      const t = Date.parse(last.ts);
      const ageDays = Number.isFinite(t) ? (Date.now() - t) / 86_400_000 : NaN;
      if (!last.ok) {
        checks.push({ name: 'bootstrap_last_verify', status: 'warn', message: `last bootstrap verify FAILED (${last.ts}): ${last.checks_failed.join(', ') || 'see snapshot'} — re-run \`gbrain bootstrap verify\`` });
      } else if (Number.isFinite(ageDays) && ageDays > 14) {
        checks.push({ name: 'bootstrap_last_verify', status: 'warn', message: `last bootstrap verify passed ${Math.floor(ageDays)}d ago — re-run it as the workspace rot self-check` });
      } else {
        checks.push({ name: 'bootstrap_last_verify', status: 'ok', message: `last verify passed (${last.ts})` });
      }
    }
  } catch { /* best effort */ }

  return checks;
}
