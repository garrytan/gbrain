import { fileURLToPath } from 'node:url';
export const REPO = fileURLToPath(new URL('..', import.meta.url));
export const HERE = import.meta.dir;
export const route = (url: URL) => url.pathname;
