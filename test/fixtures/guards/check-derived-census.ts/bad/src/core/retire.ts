type Engine = { softDeletePage: (slug: string) => Promise<void> };

export async function retire(engine: Engine): Promise<void> {
  await engine.softDeletePage('derived/example');
}
