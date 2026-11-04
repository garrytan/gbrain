/**
 * Preload for test/embedded-hermeticity.test.ts: records every environment
 * variable that repository source (src/) reads while the child runs, and
 * writes the list to HERMETIC_LOG on exit. Bun lets process.env be replaced,
 * so a Proxy sees reads through process.env; a stack frame under src/ marks
 * the read as gbrain's rather than the runtime's.
 */
import { writeFileSync } from 'node:fs';
import { sep } from 'node:path';

const marker = sep + 'src' + sep;
const reads = new Set<string>();
const env = process.env;
const record = (key: string | symbol) => {
  if (typeof key !== 'string') return;
  const stack = new Error().stack ?? '';
  if (stack.split('\n').slice(2).some((frame) => frame.includes(marker))) reads.add(key);
};
process.env = new Proxy(env, {
  get(target, key) { record(key); return Reflect.get(target, key); },
  has(target, key) { record(key); return Reflect.has(target, key); },
});
const log = env.HERMETIC_LOG;
process.on('exit', () => { if (log) writeFileSync(log, JSON.stringify([...reads].sort())); });
