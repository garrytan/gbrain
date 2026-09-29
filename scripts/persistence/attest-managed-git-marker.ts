import { parseArgs } from 'node:util';
import { attestLegacyGitMarkerScope } from '../../src/core/persistence/root-registry.ts';

const { values } = parseArgs({
  options: {
    'git-root': { type: 'string' },
    'owner-home': { type: 'string' },
    'brain-id': { type: 'string' },
    'roots-json': { type: 'string' },
    'attest-owner-and-complete-roots': { type: 'boolean' },
  },
  strict: true,
});
if (!values['attest-owner-and-complete-roots'] || !values['git-root'] || !values['owner-home']
  || !values['brain-id'] || !values['roots-json']) {
  throw new Error('Supply --git-root, --owner-home, --brain-id, --roots-json and --attest-owner-and-complete-roots.');
}
const expectedRoots: unknown = JSON.parse(values['roots-json']);
if (!Array.isArray(expectedRoots) || expectedRoots.some(root => typeof root !== 'string'))
  throw new Error('--roots-json must be a JSON array of absolute canonical root paths.');
const result = attestLegacyGitMarkerScope({
  gitRoot: values['git-root'], ownerHome: values['owner-home'], brainId: values['brain-id'], expectedRoots,
});
console.log(JSON.stringify(result));
