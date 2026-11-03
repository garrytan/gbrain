// Compiled-binary smoketest for gbrain's bundled skills (GBRA-194): prints
// one line per embedded file, "<path>\t<sha256>", from inside a
// `bun build --compile` binary. scripts/check-skills-embedded.sh compares the
// lines with skills/ so a compiled gbrain is proven to serve the same skill
// text and files the source tree has (a .json text import, for one, comes
// back parsed in a compiled binary).
import { createHash } from 'node:crypto';
import { BUNDLED_SKILL_FILES } from '../src/core/skills/bundled-skills.generated.ts';

const lines: string[] = [];
for (const path of Object.keys(BUNDLED_SKILL_FILES).sort()) {
  const text = BUNDLED_SKILL_FILES[path];
  if (typeof text !== 'string') {
    console.log(`NOT_TEXT\t${path}\t${typeof text}`);
    process.exit(1);
  }
  lines.push(`${path}\t${createHash('sha256').update(text).digest('hex')}`);
}
console.log(lines.join('\n'));
