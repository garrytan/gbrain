// Guard self-test fixture (known-BAD): the MCP-facing ops layer imports the unscoped factory.
import { unscopedExecutor as bypass } from "../engine-sql/brands.ts";

export const escapeHatch = bypass;
