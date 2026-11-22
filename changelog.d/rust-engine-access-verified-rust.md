**On the Rust engine, a member key or any other legacy token signs in to `gbrain serve --http`, and its use is recorded.**

### Fixed
- On a brain with the Rust engine, `gbrain serve --http` signs in a legacy access token, including every member key `gbrain access serves several` mints and every token bound with `--bind-token`, as the member it is bound to, with the same scopes and sources as PGLite; a read-shared key signs in on Rust with its stored sources only; read-shared on Rust follows in 32d-2. Before, every legacy token was refused at sign-in.
- On the Rust engine, `gbrain auth list` shows when each token was last used.
- OAuth client tokens still cannot be issued on the Rust engine; that follows separately.
