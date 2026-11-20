/**
 * Runs one effect pass on the brain this process's GBRAIN_HOME configures, then exits; prints `{"ran":N}`.
 * A one-shot command stops its effect drain once it has replied (GBRA-156), so whether the command's own process
 * settled an effect is a race. A test that compares settled effects runs this first, in the brain's own environment.
 */
import { loadConfig, toEngineConfig } from '../../src/core/config.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';

const config = loadConfig();
if (!config) throw new Error('no brain configured');
const engineConfig = toEngineConfig(config);
const engine = await createEngine(engineConfig);
await engine.connect(engineConfig);
try {
  let ran = 0;
  for (let batch = 20; batch >= 20;) ran += batch = await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 20 });
  console.log(JSON.stringify({ ran }));
} finally {
  await engine.disconnect();
}
