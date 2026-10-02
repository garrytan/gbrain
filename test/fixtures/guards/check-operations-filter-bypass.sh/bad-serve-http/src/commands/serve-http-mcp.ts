// Guard self-test fixture (known-BAD): a new serve-http module (refactor wave 1) imports operations without an ALLOWED row.
import { operations } from '../core/operations.ts';
export const visible = operations.filter(op => !op.localOnly);
