import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_DIR = join(import.meta.dir, '..', '..', 'src');
const ENGINE_PATH = join(SRC_DIR, 'core', 'example.ts');

export const ENGINE_SRC = readFileSync(ENGINE_PATH, 'utf8');
export const DIR_SRC = readFileSync(join(SRC_DIR, 'other.ts'), 'utf8');
