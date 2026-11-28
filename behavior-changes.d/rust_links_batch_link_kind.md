---
kind: fix
---
On the Rust engine, a batch of link writes that carried a link kind or a resolution type was refused, so none of its links were written. The links pass after a remote page write sends both fields, so those links never landed on a Rust brain. The Rust engine now stores both fields the same way PGLite and Postgres do, and still rejects a value outside the allowed set. Nothing you run changes.
