/**
 * GBRA-156: inside one search's connection budget, a read started under withUrgentSearchConnections (the retrieval
 * arms) takes the next free slot ahead of reads that were already waiting outside it (the keyword count and entity
 * resolution a search starts early for its response). The limit itself is unchanged.
 * Regression that fails it: a released slot went to the oldest waiter, so the title arm queued behind entity
 * resolution's reads.
 */
import { describe, expect, test } from 'bun:test';
import { holdSearchConnection, SEARCH_CONNECTION_LIMIT, withSearchConnectionBudget, withUrgentSearchConnections } from '../src/core/search/connection-budget.ts';

describe('search connection budget: urgent reads', () => {
  test('a released slot goes to a waiting urgent read before older ordinary waiters; at most the limit run at once', async () => {
    const order: string[] = [];
    let running = 0, peak = 0;
    const gates: Array<() => void> = [];
    const hold = (label: string, gated: boolean) => holdSearchConnection(async () => {
      running++; peak = Math.max(peak, running);
      order.push(label);
      if (gated) await new Promise<void>(resolve => gates.push(resolve));
      running--;
    });
    await withSearchConnectionBudget(async () => {
      const holders = Array.from({ length: SEARCH_CONNECTION_LIMIT }, (_, i) => hold(`holder-${i}`, true));
      await Bun.sleep(0);
      const ordinary = [hold('count', false), hold('entity', false)];
      const urgent = withUrgentSearchConnections(() => hold('title-arm', false));
      await Bun.sleep(0);
      expect(order).toEqual(['holder-0', 'holder-1', 'holder-2', 'holder-3']);
      gates.shift()!();
      await urgent;
      gates.splice(0).forEach(open => open());
      await Promise.all([...holders, ...ordinary]);
    });
    expect(order.slice(SEARCH_CONNECTION_LIMIT)).toEqual(['title-arm', 'count', 'entity']);
    expect(peak).toBe(SEARCH_CONNECTION_LIMIT);
  });

  test('without waiters an urgent read takes a free slot like any other, and outside a budget nothing waits', async () => {
    expect(await withSearchConnectionBudget(() => withUrgentSearchConnections(() => holdSearchConnection(async () => 'ran')))).toBe('ran');
    expect(await withUrgentSearchConnections(() => holdSearchConnection(async () => 'unbudgeted'))).toBe('unbudgeted');
  });
});
