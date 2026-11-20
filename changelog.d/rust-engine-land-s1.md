**The queries behind `gbrain schema detect --fields`, the large-page check, fact withdrawal and `gbrain files list` now sit behind named engine members; nothing changes for users.**

### Changed
- Seven new engine members (`readFieldUsageSamples`, `listFiles`, `readStoredBodyBytes`, `readPageBodySizes`, `listSegmentedPages`, `invalidateWithdrawnPages`, `hasWithdrawnFenceClaim`) hold the field-usage, large-page, withdrawal-page, withdrawal-fence and file-list queries. PGLite and Postgres brains return the same results as before. `gbrain schema detect --fields` is the only command that calls one of them today, and it still reads one page type's sample bodies at a time, so its memory use is unchanged.
- On the opt-in Rust engine, the field-usage member works; the other six refuse with `engine_capability_missing` until the Rust engine gets native methods for them.
