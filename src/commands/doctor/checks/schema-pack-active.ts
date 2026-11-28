/**
 * #10555: `schema_pack_active` (does the active schema pack resolve, and is its mutable file within the warn bound) ran
 * only in the remote run_doctor report, so the local `gbrain doctor --only schema_pack_active` answered "No finding".
 */
import type { Check } from '../../doctor.ts';
import { checkSchemaPackActive } from '../schema-pack-checks.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runSchemaPackActive(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('schema_pack_active');
  checks.push(await checkSchemaPackActive(connectedEngine(ctx)));
  return checks;
}

export const schemaPackActiveEntry: DoctorEntry = {
  name: 'schema_pack_active',
  emits: ['schema_pack_active'],
  run: runSchemaPackActive,
};
