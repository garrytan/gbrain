import { spawn } from 'node:child_process';
export const c = () => spawn('ls', [], { stdio: 'inherit' });
