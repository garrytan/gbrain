/**
 * #5312 B(i): the Windows private-path refusal names what happened at this destination, not a categorical rule.
 *
 * The reporter hit `private_backup_path_unavailable` for a directory directly under a drive root while the same
 * command worked under the user profile. The mechanism was read, not run: a categorical "a directory directly under a
 * drive root does not work" overstates it, and a pre-check would re-run the `SetOwner` the script already runs and
 * refuse protectable paths without native positive and negative fixtures. So the text says that this destination's
 * permissions prevented protection and points at the user profile, and the script still attempts protection
 * unconditionally and verifies owner, rules and identity before trusting the path.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// test-reads-source-ok[structural]: the row is the refusal's wording and the PowerShell script's shape, both string
// literals that only execute on win32; there is no Linux runtime path that surfaces either.
const source = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'backup', 'private-path.ts'), 'utf8');
const refusal = source.match(/new AgentInstallError\('private_backup_path_unavailable', (["'])(.*?)\1\)/)?.[2] ?? '';

test('the refusal says the destination\'s permissions prevented protection and names the user profile as the fix', () => {
  expect(refusal).toContain("permissions prevented");
  expect(refusal).toContain('user profile');
  expect(refusal).toContain('No payload was written');
});

test('the refusal makes no categorical claim about drive roots or any other location class', () => {
  expect(refusal.toLowerCase()).not.toContain('drive root');
  expect(refusal.toLowerCase()).not.toContain('does not work');
  expect(refusal.toLowerCase()).not.toContain('never');
});

test('no pre-check gates protection: the script sets the owner unconditionally and verifies the result itself', () => {
  const script = source.slice(0, source.indexOf('export function __resetPowerShellWarmupForTests'));
  expect(script).toContain('$acl.SetOwner($user)');
  expect(script).toContain('$acl.SetAccessRuleProtection($true, $false)');
  expect(script).toContain("throw 'Owner or inheritance mismatch'");
  // Nothing inspects the inherited ACL before SetOwner.
  expect(script).not.toMatch(/GetAccessControl[\s\S]*?SetOwner/);
  expect(source).not.toContain('precheck');
  expect(source).not.toContain('preCheck');
});
