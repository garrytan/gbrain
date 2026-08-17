/**
 * Pre-test setup: point GBRAIN_HOME at a per-run scratch directory so unit
 * tests never resolve the operator's real `~/.gbrain`.
 *
 * Why this exists: config resolution (`configPath()`/`gbrainPath()` and every
 * loadConfig tier-6 file-plane read) falls back to the real home when
 * GBRAIN_HOME is unset. Any test that exercises a config-honoring code path
 * without its own `withEnv({ GBRAIN_HOME: ... })` silently changes behavior
 * with whatever the operator's live `~/.gbrain/config.json` happens to say —
 * schema_pack, engine, model routing, feature toggles. Concretely observed:
 * 27 cycle/autopilot/dream tests flipped red on a dev box the moment a
 * sibling workspace's run rewrote the real config.json mid-day, while the
 * identical commit stayed green in CI (which has no ~/.gbrain at all). The
 * reverse leak is worse — tests have historically CLOBBERED the operator's
 * real config (`config.json.clobbered-*` remnants).
 *
 * Fix: same pattern as audit-dir-preload (#2823) and sync-failures-preload —
 * set the env once, globally, before any test file loads, to a fresh mkdtemp
 * dir unique to THIS process. Each shard is its own bun process, so shards
 * don't collide; the OS reaps tmp.
 *
 * Only sets the var if it isn't already set: the e2e wrapper
 * (scripts/run-e2e.sh) exports its own isolated GBRAIN_HOME before bun
 * starts, and tests that manage GBRAIN_HOME via withEnv save/restore around
 * this default like any other env var. An operator who deliberately exports
 * GBRAIN_HOME keeps their override.
 *
 * Imported by `bunfig.toml` via
 * `preload = [..., "./test/helpers/gbrain-home-preload.ts"]`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.GBRAIN_HOME) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-test-home-'));
  process.env.GBRAIN_HOME = dir;
  if (process.env.GBRAIN_DEBUG_PRELOAD === '1') {
    console.error(`[gbrain-home-preload] GBRAIN_HOME=${dir}`);
  }
}
