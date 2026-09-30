import type { BrainEngine } from '../../../core/engine.ts';
import type { PageReadScope } from '../../../core/types.ts';
import { probeProjectionReadiness } from '../../../core/search/projection-readiness.ts';
import type { Check } from '../../doctor.ts';

export async function checkProjectionReadiness(engine: BrainEngine, scope: PageReadScope = {}): Promise<Check> {
  const readiness = await probeProjectionReadiness(engine, scope);
  return {
    name: 'text_projection_readiness',
    status: readiness.ready ? 'ok' : 'warn',
    message: readiness.status === 'ready'
      ? 'Visible text projections match their canonical revisions.'
      : readiness.status === 'projection_pending'
        ? 'Visible pages have missing or stale text projections; search and code results may be incomplete. Restart the upgraded resident `gbrain serve` to drain queued Markdown and code rebuilds. For code metadata repair, run `gbrain reindex-code --force --no-embed`. If work stays pending, inspect the recorded source path. No repair or embedding was started by this check.'
        : 'Text projection readiness is unknown because its read-only probe failed; index completeness could not be verified.',
    details: { readiness: readiness.status, ready: readiness.ready },
  };
}
