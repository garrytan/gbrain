/**
 * Memory-verbs + retrieval-reflex check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { loadConfig } from '../../../core/config.ts';
import { reflexEnabled } from '../../../core/context/reflex.ts';
import { resolveSocketPath } from '../../../core/context/resolve-ipc.ts';
import type { Check } from '../../doctor.ts';

/**
 * Retrieval Reflex health (#1981). Read-only, fail-open. The deterministic
 * pointer layer is on by default; this reports the TRUTH, not an aspiration:
 *   - config/env disabled            → warn (pointer layer off)
 *   - heartbeat fired recently       → ok, "active" (it's demonstrably working,
 *                                       whatever path — Postgres/IPC/host)
 *   - enabled, no recent heartbeat   → ok if a viable path looks present
 *                                       (postgres, or pglite serve socket),
 *                                       else warn (likely inactive — policy
 *                                       skill carries). Never claims a host
 *                                       capability it can't observe.
 * Policy-skill install state is reported in details (it ships into the HOST
 * repo, so absence in gbrain's own skills dir is expected, not a failure).
 */
/**
 * MEMORY_VERBS v1 (Cathedral 1, E4) — usage-sidecar health. Read-only,
 * fail-open. Stats only (local JSONL, never uploaded; never source of truth):
 *   - no sidecar file        → ok, "no verb calls recorded yet" (fresh install)
 *   - recent events parse    → ok, names the last verb + timestamp
 *   - file exists, unreadable→ warn (observability degraded, verbs unaffected)
 */
export async function buildMemoryVerbsCheck(): Promise<Check> {
  const name = 'memory_verbs_usage';
  try {
    const { readVerbUsage, usageLogPath } = await import('../../../core/verbs/usage-log.ts');
    if (!existsSync(usageLogPath())) {
      return {
        name,
        status: 'ok',
        message: 'no verb calls recorded yet (sidecar appears on first remember/recall/entity/synthesize/forget)',
      };
    }
    const events = await readVerbUsage({ days: 30 });
    if (events.length === 0) {
      return { name, status: 'ok', message: 'sidecar present; no verb calls in the last 30 days' };
    }
    const last = events[events.length - 1];
    const byVerb = new Map<string, number>();
    for (const e of events) byVerb.set(e.verb, (byVerb.get(e.verb) ?? 0) + 1);
    const mix = [...byVerb.entries()].map(([v, n]) => `${v}:${n}`).join(' ');
    return {
      name,
      status: 'ok',
      message: `${events.length} verb calls in 30d (${mix}); last ${last.verb} at ${last.ts} — local JSONL only, never uploaded`,
    };
  } catch (e) {
    return {
      name,
      status: 'warn',
      message: `verb usage sidecar unreadable (${e instanceof Error ? e.message : String(e)}) — observability degraded; verbs unaffected`,
    };
  }
}

export function buildRetrievalReflexCheck(skillsDir: string | null): Check {
  const name = 'retrieval_reflex_health';
  try {
    const cfg = loadConfig();
    const enabled = reflexEnabled(cfg);
    const engineKind = cfg?.engine ?? 'unknown';
    const skillInstalled = !!skillsDir && existsSync(join(skillsDir, 'retrieval-reflex', 'SKILL.md'));

    if (!enabled) {
      return {
        name,
        status: 'ok',
        message: 'retrieval reflex intentionally disabled (config/env) — entity pointer layer off',
        details: { enabled: false, engine: engineKind, policy_skill_installed: skillInstalled },
      };
    }

    // Heartbeat is the authority for "is it firing".
    const hbPath = join(homedir(), '.gbrain', 'integrations', 'retrieval-reflex', 'heartbeat.jsonl');
    let lastFired: string | null = null;
    try {
      if (existsSync(hbPath)) {
        const lines = readFileSync(hbPath, 'utf8').trim().split('\n').filter(Boolean);
        const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
        if (last && typeof last.ts === 'string') lastFired = last.ts;
      }
    } catch { /* heartbeat unreadable — treat as never fired */ }
    const firedRecently =
      !!lastFired && Date.now() - new Date(lastFired).getTime() < 7 * 24 * 60 * 60 * 1000;

    // Detect a viable resolve path the doctor CAN see (host ctx.brainQuery is invisible).
    let pathDesc: string;
    let viablePathVisible: boolean;
    if (engineKind === 'postgres') {
      pathDesc = 'postgres direct';
      viablePathVisible = true;
    } else if (engineKind === 'pglite' && cfg?.database_path) {
      const socket = resolveSocketPath(cfg.database_path);
      viablePathVisible = existsSync(socket);
      pathDesc = viablePathVisible ? 'pglite via serve IPC' : 'pglite — serve IPC socket not present';
    } else {
      pathDesc = `engine ${engineKind}`;
      viablePathVisible = false;
    }

    // #4474: when the socket is absent, say the operational truth plainly —
    // ONLY a running `gbrain serve` (stdio or --http) binds it, and until
    // one does every lifecycle hook degrades to no_serve on this brain.
    const runtimeMsg = firedRecently
      ? `active (last fired ${lastFired})`
      : viablePathVisible
        ? 'enabled; not observed firing yet'
        : 'enabled but NO resolve path exists right now: the IPC socket is only bound by a running `gbrain serve` (stdio or --http) — until one is up, hooks/reflex degrade to no_serve on this brain (host capability may still supply pointers; policy skill carries otherwise)';

    const status: Check['status'] = firedRecently || viablePathVisible ? 'ok' : 'warn';
    const skillHint = skillInstalled
      ? ''
      : ' — policy skill not installed; run `gbrain integrations install retrieval-reflex --target <host-repo>`';
    return {
      name,
      status,
      message: `${pathDesc}; ${runtimeMsg}${skillHint}`,
      details: {
        enabled: true,
        engine: engineKind,
        path: pathDesc,
        fired_recently: firedRecently,
        last_fired: lastFired,
        policy_skill_installed: skillInstalled,
      },
    };
  } catch (e) {
    return { name, status: 'warn', message: `could not check: ${(e as Error).message}` };
  }
}

