import type { BrainEngine } from '../../src/core/engine.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';

export function withManagedFixtureWrite<T>(
  engine: BrainEngine,
  sourceIds: string[],
  write: (tx: BrainEngine) => Promise<T>,
): Promise<T> {
  return engine.transaction(tx => withCoordinatedWrite(tx, sourceIds, () => write(tx)));
}

export function createManagedFixtureSource(
  engine: BrainEngine,
  id: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('INSERT INTO sources(id, name, config) VALUES ($1, $1, $2::text::jsonb)', [id, JSON.stringify(config)]);
  });
}
