export interface DesktopRuntimeContract {
  schemaVersion: 1;
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  flavor: 'baseline' | 'standard';
  minimumWindowsRelease?: string;
  minimumCpuFeature?: string;
  bunVersion: string;
  bunRevision: string;
  archiveUrl: string;
  archiveEntry: string;
  archiveSha256: string;
  executableSha256: string;
  runtimeExecutableName: 'bun.exe' | 'bun';
  nativeCanvasPackage: string;
  nativeCanvasBinary: string;
}

export const WINDOWS_DESKTOP_RUNTIME_CONTRACT = {
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  flavor: 'baseline',
  minimumWindowsRelease: '10.0.17763',
  minimumCpuFeature: 'SSE4.2',
  bunVersion: '1.3.14',
  bunRevision: '1.3.14+0d9b296af',
  archiveUrl: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-windows-x64-baseline.zip',
  archiveEntry: 'bun-windows-x64-baseline/bun.exe',
  archiveSha256: '538f9c846355d9e847b2671bc00c47da4229a0befb24df3282b739770f3b475f',
  executableSha256: '9005d0d585d80425e9b715690de3e614651124c94458ef3d3a302ca1a6d3d813',
  runtimeExecutableName: 'bun.exe',
  nativeCanvasPackage: 'canvas-win32-x64-msvc',
  nativeCanvasBinary: 'skia.win32-x64-msvc.node',
} as const satisfies DesktopRuntimeContract;

export const MACOS_DESKTOP_RUNTIME_CONTRACT = {
  schemaVersion: 1,
  platform: 'darwin',
  arch: 'arm64',
  flavor: 'standard',
  bunVersion: '1.3.14',
  bunRevision: '1.3.14+0d9b296af',
  archiveUrl: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip',
  archiveEntry: 'bun-darwin-aarch64/bun',
  archiveSha256: 'd8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620',
  executableSha256: 'e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233',
  runtimeExecutableName: 'bun',
  nativeCanvasPackage: 'canvas-darwin-arm64',
  nativeCanvasBinary: 'skia.darwin-arm64.node',
} as const satisfies DesktopRuntimeContract;

export const LINUX_DESKTOP_RUNTIME_CONTRACT = {
  schemaVersion: 1,
  platform: 'linux',
  arch: 'x64',
  flavor: 'baseline',
  bunVersion: '1.3.14',
  bunRevision: '1.3.14+0d9b296af',
  archiveUrl: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip',
  archiveEntry: 'bun-linux-x64-baseline/bun',
  archiveSha256: 'a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7',
  executableSha256: 'a8f9ebd1770ddc8e55dab7a68d4ec1ec1eebf374bb97cc65cf2c3cb373fc6791',
  runtimeExecutableName: 'bun',
  nativeCanvasPackage: 'canvas-linux-x64-gnu',
  nativeCanvasBinary: 'skia.linux-x64-gnu.node',
} as const satisfies DesktopRuntimeContract;

export const DESKTOP_RUNTIME_CONTRACTS = [
  WINDOWS_DESKTOP_RUNTIME_CONTRACT,
  MACOS_DESKTOP_RUNTIME_CONTRACT,
  LINUX_DESKTOP_RUNTIME_CONTRACT,
] as const;

export function getDesktopRuntimeContract(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): DesktopRuntimeContract {
  const contract = DESKTOP_RUNTIME_CONTRACTS.find(item => item.platform === platform && item.arch === arch);
  if (!contract) throw new Error(`Unsupported PMBrain Desktop platform: ${platform}-${arch}`);
  return contract;
}

export const DESKTOP_RUNTIME_CONTRACT = getDesktopRuntimeContract();
