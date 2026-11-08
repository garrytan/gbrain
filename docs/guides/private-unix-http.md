# Private local HTTP transport

On Unix, `GBRAIN_HTTP_UNIX_SOCKET=/absolute/protected/path/gbrain.sock`
optionally exposes the existing HTTP application on a Unix-domain socket.
It uses the same engine, OAuth checks, scopes, and routes as the regular HTTP
listener. It does not create a second writer or disable the normal TCP listener.
This is intended for an already-authorized local reverse proxy or private tunnel;
GBrain does not provision that proxy, publish a URL, or grant it credentials.

The final parent directory must already exist, be owned by the process user,
and have no group/other permissions (for example mode 0700). Ancestors must be
root- or user-owned and not writable by group/other; a root-owned sticky directory
is allowed only immediately above a user-owned private directory. Symlinks and
pre-existing socket paths are refused rather than removed. The socket is mode
0600. Use canonical absolute paths, not symlinked temporary-directory aliases.
The operating-system account can reach the transport, but requests still need
the existing application authorization. All socket peers share one loopback
rate-limit bucket; forwarded headers do not create separate identities.

Shutdown closes the optional listener before the resident engine disconnects.
A cleanup error is reported without skipping the remaining resident cleanup.
The transport is opt-in; unset the variable to keep the existing behavior.
Windows named pipes are not supported by this option. No client-device installation
or cross-device transport is included by this setting alone.
