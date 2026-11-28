---
kind: fix
---
On the Rust engine, a batch of link writes that carried a link kind or a resolution type was refused, so none of its links were written. The links pass after a remote page write on a SQL primary sends a link kind, so its sampled writes could not be replayed on the Rust side. Remote page writes sent straight to a Rust brain are still refused. The Rust engine now stores both fields the same way PGLite and Postgres do, and still rejects a value outside the allowed set. Nothing you run changes.
