import {
  buildSkillSurfaceManifest,
  listSkillSurfaceResources,
} from '../core/services/skill-surface-manifest-service.ts';

export function runSkillSurface(args: string[]) {
  const action = args[0] ?? 'manifest';
  const json = args.includes('--json');

  if (action !== 'manifest' && action !== 'resources') {
    console.error('Usage: mbrain skill-surface [manifest|resources] [--json]');
    process.exitCode = 1;
    return;
  }

  if (action === 'resources') {
    const resources = listSkillSurfaceResources();
    if (json) {
      console.log(JSON.stringify({ resources }, null, 2));
      return;
    }

    for (const resource of resources) {
      console.log(`${resource.uri} ${resource.manifestHash}`);
    }
    return;
  }

  const manifest = buildSkillSurfaceManifest();
  if (json) {
    console.log(JSON.stringify({ manifest }, null, 2));
    return;
  }

  for (const entry of manifest) {
    console.log(`${entry.id} ${entry.sha256} ${entry.relative_path}`);
  }
}
