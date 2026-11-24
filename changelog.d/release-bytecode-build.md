**The release binary now starts about half a second faster on every command, and the download is about 74 MB larger.**

### Changed
- The downloadable `gbrain` binary is now built with Bun's bytecode cache (`--bytecode --format=esm`), so it no longer parses its whole JavaScript bundle at each start. On Linux x64, `gbrain get` on a PGLite brain went from 0.79 s to 0.24 s and `gbrain serve` answers its first MCP request in 0.29 s instead of 0.86 s. The binary grows by about 74 MB (linux-x64 216.6 MB to 290.4 MB, darwin-arm64 197.5 MB to 271.8 MB). Output does not change. A new check builds the release binary with and without the flags and requires the same output, error text and exit code from a fixed set of commands. Installs through `bun install -g` run the source and are unchanged.
