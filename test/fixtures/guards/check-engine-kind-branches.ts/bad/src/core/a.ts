export function pick(engine: { kind: string }) { return engine.kind === 'pglite' ? 1 : 2; }
export function other(cfg: { engine: string }) { return cfg.engine !== 'postgres'; }
