import { opError } from '../ops/contract.ts';
import { hostFix } from '../ops/op-fix.ts';

const SAFE_SLUG = /^[a-z0-9][a-z0-9._/-]*$/i;

/** Shape/trust checks do not read the current page or resolve a replay target. */
export function assertPurgeParams(params: Record<string, unknown>, remote: boolean | undefined): void {
  const slug = typeof params.slug === 'string' && SAFE_SLUG.test(params.slug) ? params.slug : undefined;
  if (params.purge !== undefined && typeof params.purge !== 'boolean') {
    throw opError('invalid_params', 'purge must be a boolean.', `Pass purge: true (CLI: gbrain delete ${slug ?? '<slug>'} --purge).`);
  }
  if (params.purge === true && remote !== false) {
    throw opError('permission_denied', 'purge is only available to the local CLI.',
      `Remote callers soft-delete only (omit purge; restore_page can undo it for 72h). To remove the page immediately the user runs \`gbrain delete ${slug ?? '<slug>'} --purge\` on the brain host.`,
      slug ? { fix: hostFix({ remote: true }, ['gbrain', 'delete', '--purge', '--', slug],
        'Purging skips the 72-hour restore window, so only the trusted CLI on the brain host may do it.', { consent: ['destructive'] }) } : {});
  }
}
