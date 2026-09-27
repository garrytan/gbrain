// Known-GOOD: spawn-array compile carrying the flag on the same line.
declare const spawnSync: (cmd: string, args: string[], opts: unknown) => unknown;
declare const binPath: string;
declare const ROOT: string;
spawnSync('bun', ['build', '--compile', '--no-compile-autoload-bunfig', '--outfile', binPath, 'src/cli.ts'], { cwd: ROOT });
export {};
