/**
 * Owner-only purge operations (#5575 Part C). Every one is `cliOnly`: an MCP
 * session (stdio or HTTP, including one hosted by the resident owner process)
 * gets `trusted_local_only` with the exact host command; the local CLI reaches
 * them directly or over the owner's 0600 socket (`LOCAL_CLI_OWNER_OPERATIONS`).
 */

import { WRITE_REQUEST_PARAM } from '../persistence/params.ts';
import { type Operation } from './contract.ts';

const purge_fact: Operation = {
  name: 'purge_fact',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Owner-only, trusted local CLI on the brain host (`gbrain forget <id> --purge`). Removes a fact\'s claim from every live store the deletion inventory sweeps (fact rows, verbatim takes, fence rows in page bodies and versions, chunks, stored write intents, review rows), blocks it from returning (text-free tombstone), hides model-derived rows for re-derivation, and returns a receipt listing residuals first. Not a mode of forget: forget expires, purge deletes. dry_run returns the receipt and a confirmation token; a real run needs confirm equal to that token. Purge removes content from live stores; it never claims physical erasure.',
  params: {
    request_id: WRITE_REQUEST_PARAM,
    id: { type: 'number', description: 'Fact id to purge (from recall or remember).' },
    reason: { type: 'string', description: 'Optional short reason stored in the text-free purge ledger.' },
    all_subjects: { type: 'boolean', description: 'Purge the same claim about every entity in the source (default: only the fact\'s own entity, like forget).' },
    dry_run: { type: 'boolean', description: 'Return the receipt with would-remove counts and the confirmation token; changes nothing.' },
    confirm: { type: 'string', description: 'The confirmation token from the dry run (first 8 hex of the claim fingerprint).' },
    expected_revision: { type: 'string', description: 'The expected_revision from the dry run; refuses when the target set changed since.' },
    match: { type: 'string', description: 'List candidate fact ids whose text contains this; never purges.' },
    status: { type: 'boolean', description: 'Report the stored receipt and completion of the purge named by request_id.' },
    vacuum: { type: 'boolean', description: 'PGLite only: VACUUM the touched tables after the purge.' },
    source_id: { type: 'string', description: 'Source holding the fact (default: the routed source).' },
  },
  mutating: true,
  scope: 'admin',
  cliOnly: { argv: ['gbrain', 'forget', '<id>', '--purge'] },
  handler: async (ctx, p) => {
    const { submitPurgeFactMutation } = await import('../facts/purge.ts');
    return submitPurgeFactMutation(ctx, p);
  },
  area: 'facts',
  cliHints: { name: 'purge-fact', hidden: true },
};

const list_page_purges: Operation = {
  name: 'list_page_purges',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Owner-only (`gbrain pages purges list`). Lists page purge tombstones: slug, content hash prefix, request and time. Never returns content.',
  params: {
    source_id: { type: 'string', description: 'Limit to one source.' },
    limit: { type: 'number', description: 'Maximum rows (default 100).' },
  },
  mutating: false,
  scope: 'admin',
  cliOnly: { argv: ['gbrain', 'pages', 'purges', 'list'] },
  handler: async (ctx, p) => {
    const { listPagePurges } = await import('../persistence/page-purge.ts');
    return listPagePurges(ctx, p);
  },
  area: 'pages',
  cliHints: { name: 'list-page-purges', hidden: true },
};

const unpurge_page: Operation = {
  name: 'unpurge_page',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Owner-only (`gbrain pages unpurge <slug>`). Clears the purge tombstones recorded for a slug so the same content can be imported again. Restores nothing.',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the purged page.' },
    source_id: { type: 'string', description: 'Source of the purged page (default: the routed source).' },
  },
  mutating: true,
  scope: 'admin',
  cliOnly: { argv: ['gbrain', 'pages', 'unpurge', '<slug>'] },
  handler: async (ctx, p) => {
    const { unpurgePage } = await import('../persistence/page-purge.ts');
    return unpurgePage(ctx, p);
  },
  area: 'pages',
  cliHints: { name: 'unpurge-page', hidden: true },
};

export const purgeOperations: Operation[] = [purge_fact, list_page_purges, unpurge_page];
