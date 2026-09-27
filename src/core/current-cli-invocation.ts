/** Resolve the executable that launched this CLI, independent of PATH. */
export function currentCliInvocation(args: string[]): { file: string; args: string[] } {
  const file = process.execPath;
  if (!file) throw new Error('current CLI executable unavailable');
  const isDevRuntime = /(?:^|[/\\])(?:bun|node)(?:\.exe)?$/.test(file);
  const entrypoint = isDevRuntime ? process.argv[1] : undefined;
  if (isDevRuntime && !entrypoint) throw new Error('current CLI entrypoint unavailable');
  return { file, args: [...(entrypoint ? [entrypoint] : []), ...args] };
}
