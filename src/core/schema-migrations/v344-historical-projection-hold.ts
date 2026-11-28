import type { Migration } from './types.ts';
import { PAGE_PROJECTION_QUEUE_FUNCTION_SQL } from '../page-state/projection-schema.ts';

/** Keep historical queue reasons across page updates and refuse an unauthorized seal. */
export const v344: Migration = {
  version: 344,
  name: 'historical_projection_hold',
  idempotent: true,
  sql: PAGE_PROJECTION_QUEUE_FUNCTION_SQL,
};
