// Guard self-test fixture (known-GOOD): facade keeps the filter; the bad file is serve-http-mcp.ts.
import { operations } from '../core/operations.ts';
export const visible = operations.filter(op => !op.localOnly);
