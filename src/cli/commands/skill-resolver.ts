/**
 * Dispatch for `gbrain skills index ...` and `gbrain skills resolve ...`
 * (routed here from `skills` by src/cli/command-route.ts). Engine-free:
 * no brain connection, works on thin clients, brainless installs and while
 * `gbrain serve` holds the PGLite lock. Behavior: src/commands/skill-resolver.ts.
 */
export async function run(args: string[]): Promise<void> {
  const { runSkillResolver } = await import('../../commands/skill-resolver.ts');
  await runSkillResolver(args);
}
