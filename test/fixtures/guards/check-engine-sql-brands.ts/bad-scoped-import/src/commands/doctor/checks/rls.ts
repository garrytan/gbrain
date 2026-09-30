// Guard self-test fixture (known-BAD): doctor may take unscoped reads but never mint a ScopedRead.
import { scopedRead } from "../../../core/engine-sql/brands.ts";

export const mint = scopedRead;
