// Known-bad: a computed help specifier is dropped from a compiled binary.
const name = 'example';
export const CLI_COMMANDS = [
  { name: 'example', help: () => import(`./help/${name}.ts`), load: () => import('./commands/example.ts') },
];
