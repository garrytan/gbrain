// Step 0 (T1): SQL grammar inspection. Loads the vendored DerekStride
// tree-sitter-sql wasm, parses representative SQL fixtures, prints
// top-level node types + extractSymbolName output. Output pins or
// corrects the D3 TOP_LEVEL_TYPES set and the extractSymbolName SQL
// branch decision in src/core/chunkers/code.ts.
//
// Run from repo root: bun tools/inspect-sql-grammar.ts

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TREE_SITTER_WASM = resolve(ROOT, 'src/assets/wasm/tree-sitter.wasm');
const GRAMMAR = resolve(ROOT, 'src/assets/wasm/grammars/tree-sitter-sql.wasm');

const FIXTURES: { name: string; sql: string }[] = [
  {
    name: 'CREATE TABLE simple',
    sql: 'CREATE TABLE users (id INT PRIMARY KEY, email TEXT NOT NULL);',
  },
  {
    name: 'CREATE FUNCTION with $$ body',
    sql: `CREATE OR REPLACE FUNCTION get_user_by_email(p_email TEXT)
RETURNS users AS $$
  SELECT * FROM users WHERE email = p_email;
$$ LANGUAGE SQL;`,
  },
  {
    name: 'CREATE INDEX',
    sql: 'CREATE INDEX idx_users_email ON users (email);',
  },
  {
    name: 'CREATE VIEW',
    sql: 'CREATE VIEW active_users AS SELECT * FROM users WHERE active = true;',
  },
  {
    name: 'ALTER TABLE',
    sql: 'ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT NOW();',
  },
  {
    name: 'CREATE TYPE enum',
    sql: "CREATE TYPE user_role AS ENUM ('admin', 'member', 'guest');",
  },
  {
    name: 'Mixed DDL + DML',
    sql: `CREATE TABLE pages (id INT, slug TEXT);
INSERT INTO pages (id, slug) VALUES (1, 'home');
SELECT * FROM pages WHERE slug = 'home';`,
  },
  {
    name: 'Pure DML',
    sql: `SELECT u.id, u.email FROM users u WHERE u.active = true;`,
  },
  {
    name: 'Invalid SQL',
    sql: `SELECT FROM WHERE`,
  },
];

function sanitize(name: string): string {
  return name.replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractSymbolNameGeneric(node: any): string | null {
  const directName = node.childForFieldName?.('name');
  if (directName?.text?.trim()) return sanitize(directName.text);
  const declaration = node.childForFieldName?.('declaration');
  if (declaration) {
    const nested = extractSymbolNameGeneric(declaration);
    if (nested) return nested;
  }
  for (let i = 0; i < (node.namedChildCount || 0); i++) {
    const child = node.namedChild(i);
    if (child.type.endsWith('identifier') || child.type === 'constant') {
      const v = sanitize(child.text);
      if (v) return v;
    }
  }
  return null;
}

async function main() {
  const mod: any = await import('web-tree-sitter');
  const P: any = mod.default || mod;
  await P.init({ locateFile: () => TREE_SITTER_WASM });
  const lang = await P.Language.load(GRAMMAR);
  const parser = new P();
  parser.setLanguage(lang);

  for (const fixture of FIXTURES) {
    console.log('\n=== ' + fixture.name + ' ===');
    const tree = parser.parse(fixture.sql);
    if (!tree) {
      console.log('  PARSE FAILED — parser.parse returned null');
      continue;
    }
    const root = tree.rootNode;
    console.log('  root.type: ' + root.type);
    console.log('  root.hasError: ' + root.hasError);
    for (let i = 0; i < root.namedChildCount; i++) {
      const node = root.namedChild(i);
      const childTypes: string[] = [];
      for (let j = 0; j < node.namedChildCount; j++) {
        childTypes.push(node.namedChild(j).type);
      }
      console.log('  child[' + i + '].type: ' + node.type);
      console.log('    extractSymbolNameGeneric: ' + JSON.stringify(extractSymbolNameGeneric(node)));
      console.log('    named children: ' + childTypes.slice(0, 8).join(', ') + (childTypes.length > 8 ? ', ... (' + childTypes.length + ' total)' : ''));
      for (const fn of ['name', 'object_reference', 'identifier', 'declaration', 'function']) {
        const f = node.childForFieldName?.(fn);
        if (f) console.log('    field "' + fn + '": ' + f.type + ' = ' + JSON.stringify(sanitize(f.text).slice(0, 50)));
      }
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
