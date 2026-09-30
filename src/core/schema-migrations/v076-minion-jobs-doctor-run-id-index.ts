import type { Migration } from './types.ts';

export const v076: Migration = {
  version: 76,
  name: 'minion_jobs_doctor_run_id_index',
  // v0.36+ autonomous-remediation wave (renumbered v68→v76 during master
  // merge). Partial GIN on minion_jobs.data for `data ? 'doctor_run_id'`.
  // Lets `gbrain doctor --remediate` runs be queried by run id for audit
  // trail without sequential-scanning months of cron history. Partial so
  // only doctor-submitted jobs are indexed; ordinary cron submissions
  // don't bloat the index.
  //
  // PGLite skips via empty sqlFor — JSONB GIN partial indexes aren't
  // supported the same way; audit query falls through to sequential
  // scan, which is fine for PGLite's single-host scope.
  idempotent: true,
  sql: '',
  sqlFor: {
    postgres: `
        CREATE INDEX IF NOT EXISTS minion_jobs_doctor_run_id_idx
          ON minion_jobs USING GIN (data jsonb_path_ops)
          WHERE data ? 'doctor_run_id';
      `,
    pglite: '',
  },
};
