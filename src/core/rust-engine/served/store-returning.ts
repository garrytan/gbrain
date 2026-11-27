/**
 * BrainEngine members that return a store object whose async methods run on the engine (or the transaction) they
 * came from. A served client gets a proxy for each (served/engine.ts): a method call crosses as `<member>.<method>`
 * inside a transaction, or as the whole operation `servedStoreCall` (owner-ops.ts) on the engine itself.
 */
export const STORE_RETURNING_MEMBERS: ReadonlySet<string> = new Set([
  'worktreeClaimStore', 'writerAdminStore', 'writerReleaseStore', 'publicationJournalStore', 'chronicleStore',
  // The managed-mode stores (store-members/managed-hold.ts): a client of a multi-writer server reaches them outside a
  // server-held transaction (a remove_link's links-fence projection, Git effects, topology), so they cross the same way.
  'manualLinkStore', 'topologyStore', 'gitEffectStore', 'gitDurabilityStore', 'refreshStore', 'groupPublishStore',
]);
export const SERVED_STORE_CALL = 'servedStoreCall';

/**
 * Store methods (`StoreBrain`) that engine code outside the members calls on the store itself (the shared-skill
 * publication path, shared-skills/rust-publication.ts). A served client has no store, so these cross the wire too:
 * `brain.<method>` inside a transaction, or the whole operation `servedBrainCall` on the engine itself. Only the methods
 * listed here run; any other name refuses.
 */
export const SERVED_BRAIN_METHODS: ReadonlySet<string> = new Set([
  'activateSharedSkillPublication', 'checkSharedSkillPublication', 'listSharedSkillHeadKeys', 'readSharedSkillHeadRevisions',
  'readSharedSkillPack', 'readSharedSkillPublication', 'readSharedSkillRetention', 'readSharedSkillSource', 'writeSharedSkillPack',
]);
export const SERVED_BRAIN_CALL = 'servedBrainCall';

/**
 * The stand-in for its store a served engine (or one of its transaction handles) carries, set by served/engine.ts. A
 * symbol property, not a side table, so a wrapper that forwards property reads (a recording proxy, a view) finds it.
 */
const SERVED_BRAIN: unique symbol = Symbol.for('gbrain.served-brain') as never;

export function registerServedBrain(engine: object, brain: object): void {
  Object.defineProperty(engine, SERVED_BRAIN, { value: brain, configurable: true, enumerable: false, writable: false });
}
export function unregisterServedBrain(engine: object): void { delete (engine as Record<symbol, unknown>)[SERVED_BRAIN]; }

/** The store stand-in of a served engine or transaction handle, or undefined when `engine` opens its own store. */
export function servedBrainFor(engine: object): object | undefined {
  const brain = (engine as Record<symbol, unknown>)[SERVED_BRAIN];
  return brain && typeof brain === 'object' ? brain : undefined;
}

/** True when `name` is a store method a served client may call. */
export function servedBrainMethod(name: unknown): name is string {
  return typeof name === 'string' && SERVED_BRAIN_METHODS.has(name);
}
