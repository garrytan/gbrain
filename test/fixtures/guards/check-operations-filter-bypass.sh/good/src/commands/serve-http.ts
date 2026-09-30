// Guard self-test fixture (known-GOOD): the HTTP facade applies the canonical filter.
import { operations } from '../core/operations.ts';
export const visible = operations.filter(op => !op.localOnly);
