const entry = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const readme = readFileSync(join(ROOT, 'changelog.d', 'README.md'), 'utf8');
put(root, { 'changelog.d/feature-x.md': '**Faster sync.**\n' });
