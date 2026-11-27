type Engine = { executeRaw(sql: string): Promise<Array<{ mode: string }>> };

// A Rust brain refuses this untyped SQL by name; the fallback below turns that refusal into a quiet default.
export async function storageMode(engine: Engine): Promise<{ mode: string }> {
  try {
    const rows = await engine.executeRaw('SELECT mode FROM storage_settings LIMIT 1');
    return rows[0] ?? { mode: 'git' };
  } catch (err) {
    console.warn(String(err));
    return { mode: 'git' };
  }
}
