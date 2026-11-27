/**
 * The access member reads a page write makes (engine-sql/access-control.ts), served from the store's member records
 * (gbrain-store `access_members`).
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import { storeCall, type StoreMember } from './common.ts';

/** The ids of the members neither disabled nor removed, by id. */
export const listActiveAccessMembers: StoreMember<[], string[]> = async (brain) =>
  await storeCall({ member: 'listActiveAccessMembers' }, () => brain.listActiveAccessMembers()) as string[];
