declare const e: Record<string, (q: string) => unknown>;
export const r = () => e['executeRaw']('SELECT id FROM pages');
