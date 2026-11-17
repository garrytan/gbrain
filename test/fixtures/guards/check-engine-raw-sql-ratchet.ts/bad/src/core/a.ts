export async function read(engine: { executeRaw(q: string): Promise<unknown[]> }) {
  // engine.executeRaw('SELECT 1') in a comment never counts
  return engine.executeRaw('SELECT id FROM pages WHERE slug = $1');
}
export async function more(engine: { executeRaw(q: string): Promise<unknown[]> }) { return engine.executeRaw('DELETE FROM pages WHERE id = $1'); }
