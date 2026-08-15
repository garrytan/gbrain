// Guard self-test fixture (known-GOOD): direct engine call, no outer retry.
declare const engine: { addLinksBatch: (rows: unknown[], opts?: unknown) => Promise<void> };
declare const rows: unknown[];
export async function good(): Promise<void> {
  await engine.addLinksBatch(rows, { auditSite: 'fixture.good' });
}
