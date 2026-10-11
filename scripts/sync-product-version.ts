import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const version = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('desktop/package.json 的版本号无效');
const packagePath = join(root, 'package.json');
const content = readFileSync(packagePath, 'utf8');
writeFileSync(packagePath, content.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));
writeFileSync(join(root, 'VERSION'), `${version}\n`);
writeFileSync(join(root, 'admin/src/product/product-version.ts'), `export const PRODUCT_VERSION = '${version}';\n`);
console.log(`PMBrain ${version}，请运行 build:admin 更新发布清单。`);
