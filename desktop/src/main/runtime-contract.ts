export const DESKTOP_RUNTIME_CONTRACT = {
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
} as const;

export type DesktopRuntimeContract = typeof DESKTOP_RUNTIME_CONTRACT;
