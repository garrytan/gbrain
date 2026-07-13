# Tinyauth v5: local-user email for OIDC claims

Session source: user asked how to specify email while reading `https://tinyauth.app/docs/guides/oidc/`.

## Grounded findings

- Tinyauth OIDC server supports scopes `openid`, `profile`, `email`, `groups` in the docs; source currently also lists `phone` and `address` as supported scopes.
- The `email` claim is returned only when the OIDC request includes the `email` scope.
- OIDC client registration (`TINYAUTH_OIDC_CLIENTS_<NAME>_*`) configures client id/secret/redirect/name; it does **not** set per-user email.
- Local-user profile attributes live under auth user attributes:
  - env form: `TINYAUTH_AUTH_USERATTRIBUTES_<username>_EMAIL`
  - YAML form: `auth.userAttributes.<username>.email`
- Optional local-user attributes include `name`, `givenName`, `familyName`, `nickname`, `picture`, `website`, `locale`, `phoneNumber`, `address`, etc.
- If a local user has no explicit email attribute, Tinyauth derives one:
  - if username parses as an email address, email = username;
  - otherwise email = `lowercase(username)@cookieDomain`.
- Source path seen during verification:
  - `.env.example` exposes `TINYAUTH_AUTH_USERATTRIBUTES_name_EMAIL=`.
  - `internal/model/config.go` defines `AuthConfig.UserAttributes map[string]UserAttributes` and `UserAttributes.Email`.
  - `internal/service/oidc_service.go` sets `email_verified` true when the compiled userinfo has an email and `email` scope was requested.

## Minimal answer pattern

Docker Compose env example:

```yaml
environment:
  TINYAUTH_AUTH_USERS: "demo-user:$$2a$$..." # bcrypt hash; $ escaped as $$ in compose
  TINYAUTH_AUTH_USERATTRIBUTES_nikita_EMAIL: "user [at] example [dot] com"
  TINYAUTH_AUTH_USERATTRIBUTES_nikita_NAME: "Example User"
```

Relying-party/client scope:

```text
openid profile email
```

YAML config alternative, useful when usernames are awkward as env-map keys:

```yaml
auth:
  users:
    - "demo-user:$2a$..."
  userAttributes:
    demo-user:
      email: "user [at] example [dot] com"
      name: "Example User"
```

Then mount or point Tinyauth to the config file, e.g. `TINYAUTH_CONFIGFILE=/data/config.yml`.

## Common pitfall

If the app receives no email claim, check both sides:

1. Tinyauth local user has `auth.userAttributes.<username>.email` or username is an email.
2. The OIDC relying party requests the `email` scope.
