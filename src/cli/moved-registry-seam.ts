/**
 * Tests only: GBRAIN_TEST_SKILLS_MOVED_REGISTRY holds a moved-skills registry
 * document (the shape of skills/moved-skills.json) as JSON. When set and
 * valid it replaces the committed registry for this process, so a CLI test
 * can give the moved skills a destination; unset or invalid, nothing changes.
 * Read here, outside src/core, so the registry module stays free of process
 * reads.
 */
import { parseMovedRegistry, setMovedRegistryForTests } from '../core/skillpack/moved.ts';

export function applyMovedRegistryTestSeam(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.GBRAIN_TEST_SKILLS_MOVED_REGISTRY;
  if (!raw) return;
  try {
    setMovedRegistryForTests(parseMovedRegistry(JSON.parse(raw)));
  } catch { /* invalid: the committed registry stays in effect */ }
}
