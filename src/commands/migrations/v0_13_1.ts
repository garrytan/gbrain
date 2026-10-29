/**
 * v0.13.1 migration — the retired `validate: false` grandfather (#7814).
 *
 * v0.13.1 used to walk every page and write `validate: false` into its
 * frontmatter, so that BrainWriter's citation / link / back-link / triple-HR
 * validators would not reject legacy pages. That write changed every page's
 * content_hash. On a repo brain the database then disagreed with Git (the
 * unmanaged path), or the stamp was committed into the user's files (the
 * managed path).
 *
 * Orchestrators apply by ledger alone: a version with no row in
 * ~/.gbrain/migrations/completed.jsonl is pending. A brain whose ledger never
 * recorded v0.13.1 (created by `gbrain init` before init stamped
 * fresh-install migrations, or reached from a new GBRAIN_HOME) therefore ran
 * the grandfather on upgrade against pages written long after v0.13.1, and
 * the upgrade rewrote the user's frontmatter.
 *
 * Nothing needs the stamp: the only BrainWriter in the product runs with
 * `strictMode: 'off'` (src/commands/integrity.ts), so a page without
 * `validate` is never refused. A `validate` value a page already carries
 * keeps its meaning (integrity scans still skip `validate: false`). The
 * orchestrator now records completion and writes nothing; a managed
 * grandfather write an older binary queued is refused without writing
 * (src/core/persistence/grandfather.ts).
 *
 * Pages an older release stamped keep the stamp. Their pre-stamp
 * frontmatter is in ~/.gbrain/migrations/v0_13_1-rollback.jsonl on the
 * machine that ran it.
 */

import type { Migration, OrchestratorOpts, OrchestratorResult } from './types.ts';

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  return {
    version: '0.13.1',
    status: 'complete',
    phases: [{
      name: 'grandfather',
      status: 'skipped',
      detail: `retired (#7814): an upgrade writes nothing to pages; validate: false is no longer added to existing pages${opts.dryRun ? ' (dry-run)' : ''}`,
    }],
    files_rewritten: 0,
  };
}

export const v0_13_1: Migration = {
  version: '0.13.1',
  fresh_install_noop: true,
  featurePitch: {
    headline: 'BrainWriter integrity validators (no page is rewritten on upgrade).',
    description:
      'The Knowledge Runtime BrainWriter validators (citation / link / back-link / ' +
      'triple-HR) shipped in v0.13.1. Upgrading records this migration and changes no page: ' +
      'the validators never refuse a write, so existing pages need no `validate: false` stamp (#7814).',
  },
  orchestrator,
};
