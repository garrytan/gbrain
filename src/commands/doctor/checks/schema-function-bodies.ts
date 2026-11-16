/**
 * schema_function_bodies doctor check (#7776): every function this gbrain's schema defines has this gbrain's body.
 *
 * initSchema replays the schema with CREATE OR REPLACE FUNCTION, so an older gbrain sharing the database reinstalled its
 * superseded bodies over a newer schema (among them the writer-fence guards that v197, v272 and v278 replace). A current
 * binary refuses that replay (client_behind), but bodies an older one already reverted stay until the next replay of a
 * current schema. The expected bodies are the ones this binary's schema installs, which a fresh install also ends at
 * (pinned on both engines by test/doctor-schema-function-bodies.test.ts and the #7776 e2e file), so the set is derived
 * from the schema, never hand-listed. Checked only at head: below it pending migrations differ legitimately, above it
 * the newer gbrain's bodies are the right ones. FTS configuration literals are ignored (GBRAIN_FTS_LANGUAGE stamps
 * them; fts_reindex covers that). Read-only.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { LATEST_VERSION } from '../../../core/migrate.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

export type FunctionBodyDrift = { status: 'checked'; checked: number; differing: string[] }
  | { status: 'skipped'; reason: 'client_behind' | 'migrations_pending'; version: number; latest: number };

const FUNCTION_DEFINITION = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\([\s\S]*?\bAS\s+(\$[a-z_]*\$)([\s\S]*?)\2/gi;
const normalize = (body: string) => body.replace(/to_tsvector\('[a-z][a-z0-9_]*'/g, "to_tsvector('?'").replace(/\s+/g, ' ').trim();

/** Which functions of this binary's schema have another body installed (or none); skipped off head. */
export async function schemaFunctionBodyDrift(engine: BrainEngine): Promise<FunctionBodyDrift> {
  const version = parseInt((await engine.getConfig('version')) || '0', 10);
  if (version !== LATEST_VERSION) return { status: 'skipped', reason: version > LATEST_VERSION ? 'client_behind' : 'migrations_pending', version, latest: LATEST_VERSION };
  const schema = engine.kind === 'postgres'
    ? (await import('../../../core/schema-embedded.generated.ts')).SCHEMA_SQL
    : (await import('../../../core/pglite-schema.generated.ts')).PGLITE_SCHEMA_SQL_TEMPLATE;
  const expected = new Map([...schema.matchAll(FUNCTION_DEFINITION)].map(m => [m[1]!, normalize(m[3]!)]));
  const rows = await engine.executeRaw<{ proname: string; prosrc: string }>(
    `SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`, [[...expected.keys()]]);
  const differing = [...expected].filter(([name, body]) => {
    const installed = rows.filter(r => r.proname === name);
    return installed.length === 0 || installed.some(r => normalize(r.prosrc) !== body);
  }).map(([name]) => name).sort();
  return { status: 'checked', checked: expected.size, differing };
}

async function runSchemaFunctionBodies(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('schema_function_bodies');
  try {
    const drift = await schemaFunctionBodyDrift(engine);
    if (drift.status === 'skipped') {
      checks.push({ name: 'schema_function_bodies', status: 'ok', message: drift.reason === 'client_behind'
        ? `Skipped: the brain schema is v${drift.version}, newer than this client (v${drift.latest}); upgrade gbrain to check it.`
        : `Skipped: the brain schema is v${drift.version} with migrations to v${drift.latest} pending (schema_version covers it).` });
    } else if (drift.differing.length === 0) {
      checks.push({ name: 'schema_function_bodies', status: 'ok', message: `Every function this gbrain's schema defines has its body` });
    } else {
      checks.push({
        name: 'schema_function_bodies',
        status: 'fail',
        message: `${drift.differing.length} function(s) have a body other than this gbrain's schema installs (${drift.differing.join(', ')}), so an older body, `
          + `most likely replayed by an older gbrain sharing this database (#7776), is in force. Upgrade every gbrain that uses this database, then run gbrain init --migrate-only to reinstall this version's bodies.`,
        details: { differing: drift.differing, checked: drift.checked },
        fix: agentFix(['gbrain', 'init', '--migrate-only'], "Replays this gbrain's schema, which reinstalls its function bodies and changes no rows. Upgrade older gbrain processes on this database first, or their next schema setup reverts the bodies again.",
          'schema_function_bodies', { requires_exclusive: true }),
      });
    }
  } catch (e) {
    checks.push(checkError('schema_function_bodies', 'compare schema function bodies', e));
  }
  return checks;
}

export const schemaFunctionBodiesEntry: DoctorEntry = { name: 'schema_function_bodies', emits: ['schema_function_bodies'], run: runSchemaFunctionBodies };
