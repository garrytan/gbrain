**A multi-user MCP gateway can record which person each write was for.**

<!-- behavior-change: end_user_attribution -->

### Added
- `X-Gbrain-End-User` request header and the `declare_end_user` scope: a service credential granted the scope (`gbrain auth rescope --token <name> --scopes read,write,declare_end_user`) names the person a request serves, and its writes show it as `end_user` in `get_write_attribution` and in `get_versions` (`written_by` / `archived_by`). `whoami` echoes it. A holder of the scope also reads `written_by` / `archived_by` on `get_versions`, so a gateway can show its users who changed a page.
- A credential without the scope that sends the header is refused before any work (`insufficient_scope`); a value that is not 1-256 visible ASCII characters is refused (`invalid_params`). The person is attribution only: no grant, access rule, audience or trust tier reads it, and `admin` does not imply the scope.
