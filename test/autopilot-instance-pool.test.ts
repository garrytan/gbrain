/**
 * Regression guards for the autopilot's "switch to instance-owned pool" step.
 *
 * Bug class (companion issue): when `connectEngine()` calls
 * `engine.connect(config)` WITHOUT `poolSize`, PostgresEngine routes through
 * the module-level singleton in `db.ts` and the engine's own `_sql` stays
 * null. Any mid-cycle code path that nulls that singleton makes every later
 * engine call through the `this.sql` getter throw "connect() has not been
 * called" — silently losing rows in `extract.ts`'s catch-and-swallow batch
 * path AND breaking the post-cycle `engine.getHealth()` call.
 *
 * The fix re-calls `engine.connect({ ...savedConfig, poolSize: N })` at
 * autopilot startup so the engine owns its own pool and is immune to
 * singleton dropouts. PGLite engines are unaffected (poolSize is ignored).
 *
 * runAutopilot's startup path is deep enough that a full behavioral test
 * needs a Postgres fixture. These static-shape regressions pin the
 * load-bearing pieces so the fix can't silently regress in a future
 * refactor.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

describe('autopilot.ts instance-pool switch (companion to issue)', () => {
  it('imports EngineConfig for the connect-config widening cast', () => {
    expect(AUTOPILOT_SRC).toContain(
      "import type { EngineConfig } from '../core/types.ts';",
    );
  });

  it("gates the switch on engine.kind === 'postgres'", () => {
    // PGLite engines must NOT enter this branch — poolSize is ignored on
    // PGLite and the file-lock model makes a second connect() unsafe.
    expect(AUTOPILOT_SRC).toMatch(/engine\.kind\s*===\s*'postgres'/);
  });

  it("reads _savedConfig from the engine (private-field cast)", () => {
    // The field is private on PostgresEngine. The narrow `as unknown as
    // { _savedConfig?: EngineConfig }` cast is intentional — going through
    // a structural shape rather than `as any` keeps the type-check coverage
    // for the rest of the block.
    expect(AUTOPILOT_SRC).toMatch(
      /_savedConfig\?:\s*EngineConfig\s*\}\)\._savedConfig/,
    );
  });

  it("skips the switch when _sql is already set (instance pool already owned)", () => {
    // If a future caller wires the autopilot engine with poolSize directly,
    // _sql will be non-null and the second connect() is unnecessary work.
    // The guard prevents that wasted reconnect.
    expect(AUTOPILOT_SRC).toMatch(/_sql\?:\s*unknown\s*\}\)\._sql\s*!=\s*null/);
  });

  it("calls engine.connect with poolSize: 5 cast to the widened type", () => {
    // The exact shape `{ ...savedCfg, poolSize: 5 } as EngineConfig & ...`
    // is load-bearing — `EngineConfig` alone doesn't have `poolSize` so
    // the cast is required.
    expect(AUTOPILOT_SRC).toMatch(
      /engine\.connect\(\{\s*\.\.\.savedCfg,\s*poolSize:\s*5\s*\}\s*as\s*EngineConfig\s*&\s*\{\s*poolSize:\s*number\s*\}/,
    );
  });

  it("guards the connect call in try/catch so a single-pool startup error doesn't abort the daemon", () => {
    // If the fresh pool can't be created (transient network, DB down), the
    // daemon should log and continue, not crash. The launchd respawn path
    // would kick in if continued operation also fails, but a one-shot
    // pool-init blip shouldn't take down the supervisor.
    expect(AUTOPILOT_SRC).toMatch(
      /try\s*\{[\s\S]{0,300}engine\.connect\(\{[\s\S]{0,80}poolSize:\s*5[\s\S]{0,80}\}[\s\S]{0,300}catch[\s\S]{0,200}could not switch engine to instance pool/,
    );
  });

  it("runs the switch BEFORE mode-resolution + worker spawn", () => {
    // The switch must happen before any phase tries to use this.sql. Source
    // ordering: instance-pool block appears before `const mode = loadPreferences`
    // and before `if (spawnManagedWorker)`.
    const switchIdx = AUTOPILOT_SRC.indexOf('could not switch engine to instance pool');
    const modeIdx = AUTOPILOT_SRC.indexOf('loadPreferences().minion_mode');
    const spawnIdx = AUTOPILOT_SRC.indexOf('if (spawnManagedWorker)');
    expect(switchIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBeGreaterThan(switchIdx);
    expect(spawnIdx).toBeGreaterThan(switchIdx);
  });
});
