const seen = new Set<string>();
export const home = process.env.HOME;
seen.add(home ?? '');
