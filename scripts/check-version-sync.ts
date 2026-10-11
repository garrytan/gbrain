#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VersionContract {
  versionFile: string;
  corePackage: string;
  desktopPackage: string;
  manifestCore: string;
  manifestDesktop: string;
  manifestSidecar: string;
}

export function validateVersionContract(contract: VersionContract): string[] {
  const errors: string[] = [];
  const rootVersion = contract.versionFile.trim().replace(/^\uFEFF/, '');

  if (contract.desktopPackage !== rootVersion) errors.push(`desktop/package.json=${contract.desktopPackage}, VERSION=${rootVersion}`);
  if (!rootVersion) errors.push('VERSION is empty');
  if (contract.corePackage !== rootVersion) {
    errors.push(`package.json=${contract.corePackage}, VERSION=${rootVersion}`);
  }
  if (contract.manifestCore !== rootVersion) {
    errors.push(`release-manifest core=${contract.manifestCore}, VERSION=${rootVersion}`);
  }
  if (contract.manifestSidecar !== rootVersion) {
    errors.push(`release-manifest sidecar=${contract.manifestSidecar}, VERSION=${rootVersion}`);
  }
  if (contract.manifestDesktop !== contract.desktopPackage) {
    errors.push(
      `release-manifest desktop=${contract.manifestDesktop}, desktop/package.json=${contract.desktopPackage}`,
    );
  }
  return errors;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function checkWorkspaceVersions(root = join(import.meta.dir, '..')): void {
  const corePackage = readJson(join(root, 'package.json'));
  const desktopPackage = readJson(join(root, 'desktop', 'package.json'));
  const manifest = readJson(join(root, 'release-manifest.json'));
  const errors = validateVersionContract({
    versionFile: readFileSync(join(root, 'VERSION'), 'utf8'),
    corePackage: corePackage.version,
    desktopPackage: desktopPackage.version,
    manifestCore: manifest.core?.version,
    manifestDesktop: manifest.desktop?.version,
    manifestSidecar: manifest.sidecar?.version,
  });

  const embedded = readFileSync(join(root, 'admin/src/product/product-version.ts'), 'utf8').match(/PRODUCT_VERSION = '([^']+)'/)?.[1];
  if (embedded !== desktopPackage.version) errors.push(`admin product version=${embedded ?? ''}, desktop/package.json=${desktopPackage.version}`);
  if (errors.length > 0) {
    throw new Error(
      `Version contract mismatch:\n- ${errors.join('\n- ')}\n` +
      "Synchronize VERSION and package versions, then run 'bun run build:admin'.",
    );
  }
  console.log(`[check-version-sync] PMBrain ${desktopPackage.version} (unified)`);
}

if (import.meta.main) checkWorkspaceVersions();
