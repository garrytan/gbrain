import type { Migration } from './types.ts';
import { REQUEST_PROTOCOL_GUARD_SQL } from '../shared-skills/persistence-schema.ts';

export const v275: Migration = {
  // GBRA-190 G4 (D2): one publication may write several pages (a withdrawal strikes its claim on every page that
  // carries it; remember linking a fact saved without an entity strikes its memory/unattributed row) and commit them in
  // one Git commit. Its recovery record is version 3 (several page files, model.ts PagesRecoveryRecord), which binaries
  // that predate it refuse unread (recovery-version.ts). Only the request guard's trigger function is replaced so it
  // accepts that record on a page target: no table, column or row changes.
  version: 275,
  name: 'multi_page_recovery_record',
  idempotent: true,
  sql: REQUEST_PROTOCOL_GUARD_SQL + ';',
};
