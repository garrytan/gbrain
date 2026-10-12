// A preload runs before every file in every bun process: process-wide by
// design, so the opt-out switch lives here.
if (process.env.GBRAIN_NO_SNAPSHOT === '1') {
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;
}
