/**
 * The typed members N4 added to BrainEngine, for the stub engines that answer through `executeRaw`.
 *
 * A caller that used to run a statement through `engine.executeRaw` now calls a member (`listSourceRecords`,
 * `readSourceIncarnation`, `hasCompanyBrainReceipt`). A stub engine that fakes the database by recognising SQL text
 * spreads `...N4_SOURCE_MEMBERS` into its literal: each member answers from the stub's own `executeRaw` with master's
 * statement text (test/helpers/n4-master-sql.ts). The members read `this.executeRaw` when they are called, so a stub
 * that replaces `executeRaw` later (a spy, a counter), or that is spread into another stub, still sees the statements.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import * as M from './n4-master-sql.ts';

type Self = Pick<BrainEngine, 'executeRaw'>;

export const N4_SOURCE_MEMBERS = {
  /** `loadAllSources`' source list: master's two statements, the minimal-columns one after an undefined-column error. */
  listSourceRecords(this: Self): ReturnType<BrainEngine['listSourceRecords']> {
    return M.sourcesLoadRows(this) as unknown as ReturnType<BrainEngine['listSourceRecords']>;
  },
  /** The company-brain profile's source row. */
  async readSourceIncarnation(this: Self, sourceId: string) {
    const [row] = await M.sourceIncarnationRows(this, sourceId);
    return row ?? null;
  },
  /** The company-brain profile's ingestion receipt check. */
  async hasCompanyBrainReceipt(this: Self, sourceId: string) {
    return (await M.companyReceiptRows(this, sourceId)).length > 0;
  },
};
