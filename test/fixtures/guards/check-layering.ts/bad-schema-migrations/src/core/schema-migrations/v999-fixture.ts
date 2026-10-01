// Guard self-test fixture (known-BAD): a split migration importing migrate.ts (EO10).
import { migrate } from '../migrate.ts';
export const x = migrate;
