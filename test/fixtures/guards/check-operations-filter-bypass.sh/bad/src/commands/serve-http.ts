// Guard self-test fixture (known-BAD): the HTTP facade lists operations without the localOnly filter.
import { operations } from '../core/operations.ts';
export const visible = operations.map((op) => op.name);
