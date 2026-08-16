// GOOD: file has no write path at all — unscoped first-match reads are allowed.
export async function readOnlyProbe(engine: any, slug: string): Promise<boolean> {
  const page = await engine.getPage(slug);
  return page !== null;
}
