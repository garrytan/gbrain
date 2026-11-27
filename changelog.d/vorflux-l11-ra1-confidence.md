**A Rust brain keeps an entity identity's confidence exactly, so a NaN or infinite value no longer breaks every identity listing.**

### Fixed
- On a Rust brain, linking an entity identity with a confidence of NaN, Infinity or -Infinity stored an empty value, and every later identity listing then failed. The Rust store now keeps these values, as Postgres and PGLite do, and the listing returns them the same way on every engine.
