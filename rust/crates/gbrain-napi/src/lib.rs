//! The Node-API binding for the gbrain Rust engine. This is the only crate that knows JavaScript.
//!
//! In this first version the addon has no engine in it. It reports who it is and carries the
//! probes that prove how Bun behaves around native code: async tasks off the event loop, typed
//! arrays, panics turned into errors, cancellation after a task started, shutdown with work
//! pending, process exit with work pending, and a full or closing threadsafe-function queue.
//!
//! Layout: `error` and `pool` hold the rules and have no JavaScript types (plain `cargo test`
//! covers them); `binding` is the thin layer that turns them into JavaScript values.

// The napi macros register exports at load time, so under `cargo test` they look unused.
#[cfg_attr(test, allow(dead_code))]
mod binding;
#[cfg(test)]
mod boundary_props;
pub mod error;
#[cfg_attr(test, allow(dead_code))]
mod families;
pub mod pool;
mod store_bind;
#[cfg_attr(test, allow(dead_code))]
mod store_binding;

/// A digest of the `rust/` sources the addon was built from. `build.rs` documents how it is
/// computed. Reported to JavaScript as `engineBuild`.
pub const ENGINE_BUILD: &str = env!("GBRAIN_ENGINE_BUILD");

/// Bumped when the binding surface changes. Reported as `engineAbi`.
pub const ENGINE_ABI: u32 = 1;

/// Version of the relation catalog the addon was built with. 0 until a catalog exists.
pub const CATALOG_VERSION: u32 = 0;

/// The target this addon was built for, in the names the loader uses: `linux-x64-glibc`,
/// `linux-arm64-musl`, `darwin-arm64`, `win32-x64`, and so on. Reported as `target`.
pub const fn target() -> &'static str {
    if cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "musl"
    )) {
        "linux-x64-musl"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64-glibc"
    } else if cfg!(all(
        target_os = "linux",
        target_arch = "aarch64",
        target_env = "musl"
    )) {
        "linux-arm64-musl"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "linux-arm64-glibc"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "win32-arm64"
    } else {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engine_build_is_a_sha256_hex_digest() {
        assert_eq!(ENGINE_BUILD.len(), 64);
        assert!(ENGINE_BUILD.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn the_target_is_one_the_loader_knows() {
        assert_ne!(
            target(),
            "unsupported",
            "add the new target to target() and the build script"
        );
        assert!(
            target().contains('-'),
            "target names look like os-arch[-libc]"
        );
    }
}
