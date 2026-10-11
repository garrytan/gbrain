import { bunSpawn } from './spawn.ts';
export const status = () => bunSpawn(['tailscale', 'status']);
