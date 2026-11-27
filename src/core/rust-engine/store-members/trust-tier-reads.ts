/**
 * The trust-tier reads a page write makes. `pageAwaitsRederive` asks whether a purge queued the page for re-derivation;
 * the store keeps no re-derive queue (gbrain-store `cli_reads::put_reads`), so the answer is false, as on a SQL brain
 * whose `needs_rederive` table holds no row for the page.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function requireInteger(member: string, name: string, value: number): void {
  if (!Number.isSafeInteger(value)) refuseMember(member, `a ${name} that is not an integer`);
}

/** Whether a purge marked the page in `needs_rederive`; false for a missing page. */
export const pageAwaitsRederive: Member<'pageAwaitsRederive'> = async (brain, pageId) => {
  requireInteger('pageAwaitsRederive', 'page id', pageId);
  return storeCall({ member: 'pageAwaitsRederive' }, () => brain.pageAwaitsRederive(pageId));
};
