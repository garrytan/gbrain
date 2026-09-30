import * as fs from 'fs';
import { readFile } from 'fs/promises';

export async function load(): Promise<string[]> {
  return [
    await readFile('src/core/example.ts', 'utf8'),
    await fs.promises.readFile('src/core/other.ts', 'utf8'),
  ];
}
