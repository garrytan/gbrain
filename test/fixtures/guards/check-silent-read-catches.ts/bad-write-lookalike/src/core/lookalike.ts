type Engine = { setConfigLike(key: string, value: string): Promise<void> };

/** setConfigLike is not on the write-only list, so a try around it still counts. */
export async function remember(engine: Engine): Promise<boolean> {
  try {
    await engine.setConfigLike('k', 'v');
    return true;
  } catch {
    return false;
  }
}
