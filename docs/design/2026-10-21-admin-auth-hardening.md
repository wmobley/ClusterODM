# ClusterODM admin authentication and registration hardening

Status: Implemented

## Objective

Harden the ClusterODM admin and node-registration surfaces identified in the October 19 production log and preserve the intended JWT login experience. The default session-secret value remains unchanged by explicit request.

## User need

Operators need a safe ClusterODM control plane for starting, monitoring, and managing photogrammetry work, while Tapis workers need a reliable, authenticated registration path. The admin service must not expose passwordless administrative controls or accept forged/unauthenticated registration requests. When no JWT is supplied in the URL, the admin page must still load and present the JWT paste form; when a JWT is supplied in the hash, the existing automatic login flow must continue to work. Success means valid users can log in and use the protected APIs, invalid or missing credentials fail closed, and workers receive a clear rollout requirement instead of silently falling back to metadata-only authentication.

## Goals

- Close the identified JWT forgery, webhook bypass, passwordless CLI, credential-leakage, CSRF/CORS, and bind-error paths.
- Preserve hash-token auto-login and the no-token JWT paste form.
- Keep the default `admin-session-secret` value unchanged.
- Make worker credential requirements explicit and testable.

## Non-goals

- Replacing the existing session store or redesigning the Tapis job scheduler in this change.
- Adding a new per-job capability service. Exact job-bound capabilities remain a follow-up if the existing Tapis token plus owner/job matching is insufficient for deployment requirements.

## Current code/system summary

- `adminweb.js` serves the static admin shell, session-protected `/r/*` APIs, Tapis/WebODM login routes, and node-registration webhooks.
- Tapis admin login currently decodes JWT claims locally but does not validate the token with Tapis.
- Registration and de-registration accept UUID-shaped values, arbitrary `tapisJobOwner` values, or no credentials as authentication in some configurations.
- Registration payloads are logged as raw JSON, and the existing proxy has already begun redacting task/query tokens.
- `admincli.js` can expose the administrative TCP CLI without a password; `config-default.json` enables port 8080 with an empty password.
- The public admin shell and `public/component/loginForm.mjs` already implement the JWT paste form and hash-token auto-login behavior.

## Proposed design

1. Keep the static admin shell public so unauthenticated visitors receive the login page. Continue requiring a valid session for every `/r/*` API and session-authenticated logout route. If no authentication mode is configured, fail closed with a service error rather than exposing the APIs.
2. Validate Tapis JWTs through the configured Tapis provider before trusting claims for admin login or webhook credentials. Apply expiration, tenant, and user allowlists only after validation. A Tapis token is required to have a usable numeric expiry; provider failures return a bounded service error and invalid tokens return a generic authentication error. Never store the bearer token in the session.
3. Store only validated identity (`username`, `userId`, `email`, `tenantId`) and `exp`/`iat` in the session. Regenerate the session on login and apply an explicit bounded cookie lifetime; no bearer token is retained server-side.
4. Require a real credential for registration and de-registration: a provider-validated Tapis token or a configured registration secret compared using a constant-time comparison. If a Tapis token is supplied, it takes precedence and must validate; the secret is not a fallback for an invalid supplied token. Treat `registrationUuid` and `tapisJobOwner` as metadata/ownership hints only, not authentication factors. Remove the no-auth fallback.
5. When a validated Tapis token and `tapisJobOwner` are both present, accept only an owner matching the validated username or `username@tenant` identity. Secret-authenticated requests may use the owner field as trusted metadata for the existing routing logic. Tapis-token de-registration is limited to nodes owned by that identity; registration-secret de-registration remains cluster-wide. Keep existing pending-task and worker/primary-node matching behavior.
6. Redact token, secret, password, authorization, and similar sensitive fields recursively in webhook diagnostic logs. Keep proxy URL/query redaction and avoid logging authentication error payloads that may contain credentials.
7. Remove wildcard CORS from the same-origin admin interface and reject state-changing requests carrying a foreign `Origin`; requests without an `Origin` remain compatible with CLI/worker clients. The session cookie remains `HttpOnly`, `SameSite=Lax`, optionally `Secure`, and bounded by a maximum lifetime.
8. Do not bind the admin CLI without `admin-pass`; log that it was disabled and continue starting the web/proxy services. Bind the CLI to loopback by default and use constant-time password comparison. Make admin web and CLI bind failures reject cleanly so port conflicts do not become unhandled Node errors.
9. Return only `{mode}` from public `/auth/config`; do not disclose tenant/user allowlists.
10. Leave `config-default.json`'s `admin-session-secret` value and the existing random fallback behavior unchanged.

## Files likely affected

- `adminweb.js` — JWT validation, webhook authorization, redaction, CORS removal, session contents, and listen error handling.
- `admincli.js` — reject passwordless direct creation and retain clean bind errors.
- `index.js` — skip passwordless CLI startup and handle admin-web bind failures.
- `public/component/loginForm.mjs` — adjust copy if needed to describe cookie-backed sessions without claiming the bearer token is stored.
- `docs/webhook-registration.md`, `README.md`, and/or `docs/tapis.md` — document required CLI/registration credentials and preserved login behavior.
- `test/test-admincli-port.js`, `test/test-secret-hygiene.js`, and a focused admin-web auth test — cover the hardened behavior.
- `test/test-adminweb-auth.js` — use dependency injection for Tapis validation and an ephemeral HTTP port so auth behavior can be tested without external Tapis calls.
- `package.json` — include focused tests in the normal test command if compatible with the existing test layout.

## API/schema changes

- `/auth/login` in Tapis mode will reject syntactically valid but unvalidated JWTs.
- `/auth/config` will expose exactly the non-sensitive authentication mode; allowlists will not be returned to unauthenticated clients.
- `/webhook/register-node` and `/webhook/deregister-node` will return `401` when neither a valid Tapis token nor the configured registration secret is supplied.
- `registrationUuid` and `tapisJobOwner` remain accepted request fields for routing/ownership metadata but no longer authenticate a request by themselves.
- No persistent schema changes.

## Data flow

Admin browser → public static shell → `/auth/config` and `/auth/session` → JWT paste form or hash auto-login → `/auth/login` → Tapis provider validation → allowlist checks → regenerated session cookie → protected `/r/*` APIs.

Node worker/client → registration webhook → bearer token validation or constant-time registration-secret check → optional owner consistency check → existing pending-task/regular-node registration logic.

## Risks and tradeoffs

- Existing worker deployments that rely on only `tapisJobOwner`, a UUID-shaped value, or no credential will receive `401` until they provide a valid Tapis token or registration secret. This is intentional because those values are forgeable metadata.
- Removing wildcard CORS may affect a separately hosted admin UI; the supported admin UI is same-origin through the existing proxy/nginx path.
- Provider-backed JWT validation adds a Tapis API call to admin login and tests must inject a validator or use a controlled provider.
- Disabling the default passwordless CLI changes local behavior, but prevents an exposed administrative TCP port from being unauthenticated.
- Hardened webhooks are intentionally incompatible with the current log’s owner-only worker payload until worker credentials are staged.

## Alternatives considered

- Blocking the initial HTML request until authentication: rejected because it prevents the designed paste-form login flow.
- Treating `registrationUuid` or `tapisJobOwner` as shared secrets: rejected because format-valid UUIDs and user IDs are not proof of possession.
- Changing the default session secret: explicitly excluded by the user; retain current behavior and require deployment configuration to override it.
- Keeping wildcard CORS and adding more session checks: rejected because the admin app is same-origin and wildcard CORS unnecessarily broadens the credentialed surface.

## Test plan

- Verify an unauthenticated GET of the admin shell succeeds and the JWT login form remains the default mode when no hash token exists.
- Verify forged JWT login is rejected, validated JWT login creates a session, expired JWTs are rejected, and protected APIs require that session.
- Verify webhook requests without credentials, with UUID-only credentials, and with owner-only credentials are rejected; valid injected Tapis validation and registration-secret requests succeed.
- Verify sensitive webhook fields and proxy query tokens are not written to logs.
- Verify passwordless CLI startup is skipped and occupied admin ports fail cleanly without an unhandled error.
- Verify admin-web bind failures reject cleanly, foreign origins are rejected for state-changing requests, sessions contain no bearer token, and Tapis-token node removal is ownership-bound.
- Run the existing test suite and focused auth/security tests.

## Documentation plan

Update operator-facing docs and client examples to state that the admin CLI requires `--admin-pass` (or can be disabled with `--admin-cli-port 0`), registration requires a validated Tapis token or registration secret, workers must be updated before rollout, and the web admin page presents a JWT form when no hash token is supplied.

## Rollout/rollback plan

Roll out the ClusterODM service and update worker/job environments to provide a Tapis token or registration secret before enabling the hardened webhook behavior. Monitor `401` registration responses and admin login failures. Roll back by reverting the service version only if authenticated worker registration cannot be updated; do not reintroduce the unauthenticated fallback in production.

## Open questions

- The separately deployed NodeODM/Tapis worker image must be confirmed to receive either the registration secret or a valid Tapis token after this change. The repository clients already support both mechanisms, but the production worker shown in the log sends only owner metadata.
- Whether the worker should receive a per-job capability rather than a cluster-wide registration secret remains a follow-up security decision; this change does not invent a new capability format.

## Decisions

- 2026-10-21: Preserve the public login shell and JWT paste form; authentication protects data/control APIs rather than the initial HTML.
- 2026-10-21: Preserve the default session-secret value exactly as requested.
- 2026-10-21: Remove metadata-only and no-credential webhook authentication instead of attempting to make UUID/user-ID heuristics stronger.
- 2026-10-21: If both credentials are supplied, a supplied Tapis token must validate; registration-secret fallback is only available when no Tapis token is supplied.
- 2026-10-21: Treat no-auth mode as unavailable for protected APIs, because the public shell requirement must not become an API bypass.
- 2026-10-21: Use same-origin checks for browser state changes and leave credential-less non-browser requests compatible when no `Origin` header is present.

## User feedback / decisions

- 2026-10-21: User approved fixing all identified issues except changing the default session secret and explicitly requested the JWT paste form as the no-token default.
- 2026-10-21: Implemented the approved hardening. The default session secret remains unchanged; the public admin shell remains reachable so the no-token JWT paste form can render.
- 2026-10-21: Verification completed with syntax checks, secret-hygiene checks, and admin-CLI bind/auth tests. The admin-web integration test remains blocked in this checkout because `express-session` is not installed.
