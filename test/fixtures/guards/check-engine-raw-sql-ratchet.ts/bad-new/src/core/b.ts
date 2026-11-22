declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;
export const rows = (slug: string) => sql`SELECT id FROM pages WHERE slug = ${slug}`;
