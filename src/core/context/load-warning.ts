/**
 * Lazy module loads on the OpenClaw assemble() path (#6906). Each caller fails
 * open around its load, so a module the host runtime cannot load (OpenClaw
 * runs the engine under Node, which rejects Bun-only imports) would otherwise
 * read as "no relevant notes". One warning line per module names what failed
 * and its error code; the error is rethrown so the caller's fail-open path is
 * unchanged. A leaf module with no imports so it always loads.
 */
const warned = new Set<string>();

export async function loadContextModule<T>(module: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!warned.has(module)) {
      warned.add(module);
      const { code, name } = (err ?? {}) as { code?: unknown; name?: unknown };
      const reason = typeof code === 'string' ? code : typeof name === 'string' ? name : 'unknown error';
      console.warn(`[gbrain] context engine: failed to load ${module} (${reason}); brain context is degraded`);
    }
    throw err;
  }
}
