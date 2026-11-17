/**
 * Bun `--preload` for graduation crash and pause tests. Registers
 * `GraduationHooks` before the real CLI starts, so the test drives the actual
 * `foresights migrate` process and still stops it at an exact custody boundary.
 *
 * Environment (set only by test/helpers/graduation-e2e.ts):
 * - GBRAIN_TEST_GRADUATION_EVENTS: file that receives one JSON line per
 *   boundary reached ({ boundary, detail, pid, at }).
 * - GBRAIN_TEST_GRADUATION_PAUSE: comma list of `boundary` or
 *   `boundary@relation` entries (`*` pauses at every boundary). On a match
 *   the process writes a `paused` line and blocks until
 *   `<events>.release.<n>` exists (n = the pause ordinal) or it is killed.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { GRADUATION_HOOKS, type GraduationBoundary, type GraduationBoundaryDetail, type GraduationHooks } from '../../src/core/persistence/engine-graduation.types.ts';

const events = process.env.GBRAIN_TEST_GRADUATION_EVENTS;
const pauses = (process.env.GBRAIN_TEST_GRADUATION_PAUSE ?? '').split(',').map(s => s.trim()).filter(Boolean);
let ordinal = 0;

function matches(name: GraduationBoundary, detail: GraduationBoundaryDetail): boolean {
  return pauses.some(entry => {
    if (entry === '*') return true;
    const [boundary, relation] = entry.split('@');
    return boundary === name && (!relation || relation === detail.relation);
  });
}

if (events) {
  const hooks: GraduationHooks = {
    async boundary(name, detail) {
      const line = (event: string, extra: Record<string, unknown> = {}) =>
        appendFileSync(events, `${JSON.stringify({ event, boundary: name, detail, pid: process.pid, at: Date.now(), ...extra })}\n`);
      line('boundary');
      if (!matches(name, detail)) return;
      const n = ++ordinal;
      line('paused', { ordinal: n });
      const release = `${events}.release.${n}`;
      await new Promise<void>(resolve => {
        const timer = setInterval(() => { if (existsSync(release)) { clearInterval(timer); resolve(); } }, 20);
      });
      line('released', { ordinal: n });
    },
  };
  (globalThis as Record<symbol, GraduationHooks>)[GRADUATION_HOOKS] = hooks;
}
