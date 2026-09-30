// Guard self-test fixture (known-BAD): a lazy import back up to the Postgres façade.
export async function load(): Promise<unknown> {
  return import('../postgres-engine.ts');
}
