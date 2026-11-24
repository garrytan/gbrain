/**
 * Reads and writes of the decision, OAuth, feedback, question and credential tables that callers once ran through
 * `executeRaw`, as typed members: SQL once for both SQL engines, so a store that is not SQL serves the same members
 * (rust/docs/store). Each statement keeps the text its caller ran, and each listing breaks ties by byte
 * (`COLLATE "C"`), as the Rust store does.
 *
 * The members are added by the slices that move those callers; this file is the place they live.
 */
export {};
