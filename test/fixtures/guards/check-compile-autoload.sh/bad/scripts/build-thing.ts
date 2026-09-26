// Known-BAD: spawn-array compile WITHOUT --no-compile-autoload-bunfig.
declare const spawnSync: (cmd: string, args: string[], opts: unknown) => unknown;
declare const binPath: string;
declare const ROOT: string;
spawnSync('bun', ['build', '--compile', '--outfile', binPath, 'src/cli.ts'], { cwd: ROOT });
export {};
