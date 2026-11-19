/**
 * The spend ledger and the spend columns of `oauth_clients` (engine-sql/spend-log.ts), served by the store
 * (rust/docs/store/spend-log.md). A time crosses the binding as ISO text. Each admission is one store write.
 */
import type {
  AgentClientSpendRow, ClientReserveOutcome, ClientReserveSpec, GroupReserveOutcome, GroupReserveSpec, GroupSpendRow,
  SettleLogOutcome, SpendLogInsert,
} from '../../engine-sql/spend-log.ts';
import { storeCall, type StoreMember } from './common.ts';

export const reserveClientSpend: StoreMember<[spec: ClientReserveSpec], ClientReserveOutcome> = (brain, spec) =>
  storeCall({ member: 'reserveClientSpend' }, () =>
    brain.reserveClientSpend({ ...spec, expires_at: spec.expires_at.toISOString(), day_start: spec.day_start.toISOString() }));

export const reserveGroupSpend: StoreMember<[spec: GroupReserveSpec], GroupReserveOutcome> = (brain, spec) =>
  storeCall({ member: 'reserveGroupSpend' }, () =>
    brain.reserveGroupSpend({ ...spec, expires_at: spec.expires_at.toISOString() }));

export const readGroupSpendTotals: StoreMember<[budgetKey: string], GroupSpendRow> = (brain, budgetKey) =>
  storeCall({ member: 'readGroupSpendTotals' }, () => brain.readGroupSpendTotals(budgetKey));

export const settleSpendWithLog: StoreMember<
  [reservationId: string, actualCents: number, operation: string, tokenName: string | null], SettleLogOutcome
> = (brain, reservationId, actualCents, operation, tokenName) =>
  storeCall({ member: 'settleSpendWithLog' }, () => brain.settleSpendWithLog(reservationId, actualCents, operation, tokenName));

export const insertSpendLog: StoreMember<[row: SpendLogInsert], void> = async (brain, row) => {
  await storeCall({ member: 'insertSpendLog' }, () => brain.insertSpendLog(row));
};

export const sumClientSpendSince: StoreMember<[clientId: string, since: Date], number> = (brain, clientId, since) =>
  storeCall({ member: 'sumClientSpendSince' }, () => brain.sumClientSpendSince(clientId, since.toISOString()));

export const readClientBudgetUsd: StoreMember<[clientId: string], string | null> = (brain, clientId) =>
  storeCall({ member: 'readClientBudgetUsd' }, () => brain.readClientBudgetUsd(clientId));

export const updateOauthClientBudget: StoreMember<[clientId: string, usd: number | null], boolean> = (brain, clientId, usd) =>
  storeCall({ member: 'updateOauthClientBudget' }, () => brain.updateOauthClientBudget(clientId, usd));

export const readAgentClientSpend: StoreMember<[], AgentClientSpendRow[]> = (brain) =>
  storeCall({ member: 'readAgentClientSpend' }, () => brain.readAgentClientSpend());
