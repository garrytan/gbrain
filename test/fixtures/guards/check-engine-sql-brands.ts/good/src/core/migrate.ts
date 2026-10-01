// Guard self-test fixture (known-GOOD): migrations may name the unscoped brand type.
import type { LegacyUnscopedRead } from "./engine-sql/brands.ts";

export type MigrationRead = LegacyUnscopedRead;
