import type { BrainEngine } from '../engine.ts';
import {
  createLifecycleForgettingStoreForEngine,
  createLifecycleForgettingTransactionForEngine,
} from '../maintenance/lifecycle-forgetting.ts';
import { createLifecycleForgettingService } from './lifecycle-forgetting-service.ts';

export function createLifecycleForgettingServiceForEngine(
  engine: BrainEngine,
  now: () => string = () => new Date().toISOString(),
) {
  return createLifecycleForgettingService({
    store: createLifecycleForgettingStoreForEngine(engine),
    now,
    transaction: createLifecycleForgettingTransactionForEngine(engine),
  });
}

export function maybeCreateLifecycleForgettingServiceForEngine(
  engine: BrainEngine,
  now: () => string = () => new Date().toISOString(),
) {
  try {
    return createLifecycleForgettingServiceForEngine(engine, now);
  } catch {
    return undefined;
  }
}
