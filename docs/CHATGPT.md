# Connecting the app to ChatGPT

The application exposes a Streamable HTTP MCP server at:

```text
https://YOUR-HOST/mcp
```

OpenAI's current Apps SDK documentation describes creating a developer-mode app from an HTTPS `/mcp` endpoint, and recommends OAuth 2.1 for customer-specific data and write actions.

Official references:

- https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- https://developers.openai.com/apps-sdk/build/auth
- https://developers.openai.com/apps-sdk/build/mcp-server
- https://developers.openai.com/api/docs/guides/tools-connectors-mcp#secure-mcp-tunnel

## Reachability

ChatGPT must be able to reach the MCP endpoint. Use one of:

- OpenAI Secure MCP Tunnel for an on-premises/private TrueNAS server;
- a public HTTPS reverse proxy with a valid certificate;
- a temporary development tunnel for testing.

Do not expose the raw HTTP container port directly to the public internet.

## One-user development test

A simple private test can use:

```dotenv
NODE_ENV=development
AUTH_MODE=none
ALLOW_SEND=false
```

This mode works only when the database has exactly one active user. It intentionally returns an error if a second active user exists. Use it to validate MCP tool discovery, mailbox labels, reading, and drafts before adding production authentication.

## Personal token mode

With:

```dotenv
AUTH_MODE=token
```

users can create `mcp_pat_...` bearer tokens in the dashboard's **Security** page. This is useful with MCP clients, API test harnesses, and tools that permit a custom Authorization header.

The token is shown once, stored only as a hash, and resolves to exactly one application user. It is not a replacement for the normal interactive OAuth linking experience expected for a broadly deployed multi-user ChatGPT app.

## Multi-user ChatGPT deployment

Use:

```dotenv
AUTH_MODE=oauth
```

The included app is an OAuth resource server. It verifies signed JWT access tokens, checks issuer/audience/expiry through JWKS, extracts scopes, and maps the token to a local application user.

Use an established OAuth 2.1 identity provider. OpenAI currently recommends this rather than building an authorization server from scratch.

### Required token claims

A usable access token should include:

- `iss` — exactly the configured issuer;
- `aud` — the MCP application's configured audience/resource;
- `exp` — expiry;
- `sub` — stable identity-provider subject;
- `email` — the user's email, for first-time local linking;
- `email_verified=true` — required before automatic email-based linking;
- `scope`, `scp`, or `permissions` — including the granted mail scopes.

The app accepts these scopes:

```text
mail.read
mail.draft
mail.send
```

### Local user mapping

1. An administrator creates `alice@example.com` in the web dashboard.
2. Alice starts the ChatGPT app OAuth flow.
3. The identity provider authenticates Alice and issues a signed token containing `email=alice@example.com`, `email_verified=true`, and a stable `sub`.
4. On the first request, the app links that `sub` to Alice's local record, provided `OAUTH_AUTO_LINK_EMAIL=true` and the local account is active and not already linked to a different subject.
5. Every MCP request thereafter resolves to Alice's local user ID.
6. Queries are restricted to mailboxes whose `owner_id` is Alice's ID.

Bob's token resolves to Bob's ID, so even if Bob guesses Alice's mailbox UUID or reuses an opaque message ID from Alice, the ownership check fails.

### Environment example

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://mail.example.com
ALLOWED_HOSTS=mail.example.com
TRUST_PROXY=true
COOKIE_SECURE=true

AUTH_MODE=oauth
OAUTH_ISSUER_URL=https://YOUR-ISSUER.example.com/
OAUTH_JWKS_URL=https://YOUR-ISSUER.example.com/.well-known/jwks.json
OAUTH_AUDIENCE=https://mail.example.com
OAUTH_SCOPES=mail.read,mail.draft,mail.send
OAUTH_AUTO_LINK_EMAIL=true
```

The identity provider must satisfy current MCP authorization requirements, including authorization code with PKCE, metadata discovery, client registration compatible with ChatGPT, and preservation of the OAuth `resource` parameter into the issued token's intended audience/resource.

## Create the developer-mode app

The current ChatGPT flow is:

1. Make the MCP server reachable over HTTPS or Secure MCP Tunnel.
2. Enable Developer mode in ChatGPT settings, subject to workspace policy.
3. Open the plugin/app management page.
4. Create a developer-mode app.
5. Enter a descriptive name and description.
6. Set the MCP server URL to `https://YOUR-HOST/mcp` or select the configured tunnel.
7. Complete the OAuth link when prompted.
8. Confirm that ChatGPT discovers the advertised tools.
9. Start a new conversation, add the app, and begin with read-only requests.

After changing tool metadata or authentication settings, refresh the app metadata in ChatGPT.

## Suggested first tests

Keep `ALLOW_SEND=false` and try:

```text
List my connected mailboxes.

Show unread mail from today across all mailboxes, grouped by receiving address.

Read the newest message in Support and summarize the thread.

Draft a reply, but do not send it.
```

Verify that every result is labelled with the correct mailbox and that one user never sees another user's mailbox list.

## Sending test

Only after read-only tests pass:

1. enable sending on one test mailbox;
2. set `ALLOW_SEND=true` and restart;
3. ask ChatGPT to draft a message to your controlled test address;
4. inspect the review component;
5. approve the exact draft;
6. verify the delivered and Sent-folder copies.

ChatGPT tool permission settings provide an additional approval layer, but the application still enforces its own exact-draft send approval.

## Troubleshooting identity

### `UNLINKED_OAUTH_IDENTITY`

The JWT is valid, but no active local user is linked. Ensure:

- the administrator created the local user first;
- the signed `email` claim with `email_verified=true` matches that user exactly;
- auto-linking is enabled, or the subject was linked administratively;
- the user is not disabled;
- the account is not already linked to another subject.

### Scope failure

Ensure the identity provider includes the requested scopes in `scope`, `scp`, or `permissions` and that ChatGPT requested them.

### Audience or issuer failure

The JWT's exact `iss` and `aud` values must match the application environment. Also ensure the authorization server carries the OAuth `resource` value through to the token.

### App cannot connect

Confirm:

- `/healthz` works from the deployment network;
- the public/tunnel endpoint ends in `/mcp`;
- the TLS certificate is valid;
- `PUBLIC_BASE_URL` is the external origin, without `/mcp`;
- `ALLOWED_HOSTS` contains the external host;
- reverse proxy requests reach container port 3000;
- protected resource metadata is available at `/.well-known/oauth-protected-resource`.
