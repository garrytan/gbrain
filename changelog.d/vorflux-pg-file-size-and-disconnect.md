**On Postgres, file records now report their size as a plain number, and closing the engine a second time no longer runs its shutdown steps again. PGLite already worked this way.**

### Fixed
- On Postgres, `getFile` and `listFilesForPage` returned `size_bytes` as a BigInt. PGLite returned a number, and the declared type is a number. Both engines now return a number. The output of the `gbrain files` CLI and the MCP file operations does not change, because those paths already converted the value.
- On Postgres, a second `disconnect()` of an engine that was already closed ran the registered shutdown hooks again. A second `disconnect()` now does nothing, as on PGLite.
