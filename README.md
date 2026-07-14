# IMAP ChatGPT Mail App

A self-hosted TypeScript application that gives ChatGPT controlled access to ordinary IMAP/SMTP mailboxes. Version 0.2 adds a browser-based control centre, multiple mailboxes per user, multiple isolated users, encrypted credentials, mailbox-labelled search results, and source-mailbox-locked sending.

> Status: working self-hosted MVP. The application, database, web interface, MCP tools, authentication boundaries, and automated tests are included. Real IMAP/SMTP access still has to be tested against your own provider, and a production multi-user ChatGPT deployment needs an established OAuth 2.1 identity provider.

## What it does

Each application user can:

- sign in to a private web dashboard;
- add, edit, test, disable, or remove multiple IMAP/SMTP mailboxes;
- let ChatGPT search all readable mailboxes together or select particular mailboxes;
- see the receiving mailbox address and display label on every result;
- read messages and best-effort threads;
- create reply and forward drafts;
- keep each draft bound to the mailbox that received the source message;
- review the exact sender, recipients, subject, body, and attachments before sending;
- create or revoke personal MCP tokens for compatible clients;
- inspect recent drafts and a per-user audit trail.

Administrators can create and disable application users. A user cannot read another user's mailbox records, credentials, drafts, tokens, approvals, or audit history.

## How the separation works

```text
Authenticated ChatGPT / MCP identity
                  |
                  v
           application user
                  |
       ownership check on every call
                  |
       +----------+-----------+
       |          |           |
    mailbox A  mailbox B   mailbox C
       |          |           |
    IMAP/SMTP  IMAP/SMTP   IMAP/SMTP
```

The client never chooses a trusted `user_id`. The server resolves the user from the authenticated access token, then adds that user's ID to every database query. Opaque message IDs also contain a signed mailbox reference, but ownership is rechecked before the server opens an IMAP connection.

## Mailbox categorization

A search across four accounts returns structured records like:

```json
{
  "mailbox_id": "a9a65e18-...",
  "mailbox_address": "support@example.com",
  "mailbox_display_name": "Support",
  "received_by": "support@example.com",
  "from": [{ "name": "Customer", "address": "customer@example.net" }],
  "subject": "Delivery question"
}
```

That lets ChatGPT group or filter results by the address that received them. Replies and forwards are created through that source mailbox. The backend rejects a send if the draft's stored identity no longer matches the mailbox.

## Included interfaces

### Web control centre

Routes include:

- `/setup` — create the first administrator;
- `/login` — browser sign-in;
- `/app` — mailbox status, recent drafts, and recent activity;
- `/app/mailboxes/new` — add an IMAP/SMTP account;
- `/app/users` — create and disable users (administrator only);
- `/app/security` — change password and manage personal MCP tokens.

The web interface is server-rendered and responsive. It does not expose saved passwords after creation. Production first-run setup is protected by a server-side setup token, and repeated failed sign-ins are temporarily rate-limited in memory.

### MCP endpoint

The stateless Streamable HTTP endpoint is:

```text
POST /mcp
```

Current tools:

1. `list_mailboxes`
2. `list_mail_folders`
3. `search_emails`
4. `get_email`
5. `get_email_thread`
6. `create_reply_draft`
7. `create_forward_draft`
8. `update_draft`
9. `prepare_send_draft`

The send review component performs the final confirmed delivery call without disclosing the approval secret to the model-visible tool output.

## Sending safety

Sending has three independent gates:

1. `ALLOW_SEND=true` must be set globally.
2. Sending must be enabled on the particular mailbox.
3. The user must approve an unchanged draft in the review component.

An approval is bound to a hash of the exact draft. Changing recipients, subject, body, attachment choice, or revision cancels prior approval. SMTP retries are not silently treated as success. The app records sending activity in the audit table.

Email content is always treated as untrusted data. Instructions found inside a message cannot authorize reading another mailbox, forwarding data, changing recipients, or sending mail.

## Requirements

- Node.js 22 or newer
- npm
- an IMAP/SMTP account with TLS
- an app password or provider-supported mailbox credential
- for containers: Docker or a compatible TrueNAS SCALE Apps environment

The application uses Node's built-in `node:sqlite`. Node 22 may print an experimental-feature warning for that module; the warning does not indicate a failed database operation.

## Local installation

### 1. Create configuration

```bash
cp .env.example .env
```

Generate the two long-lived cryptographic secrets and a one-time first-run setup token:

```bash
openssl rand -base64 48
openssl rand -base64 32
openssl rand -base64 32
```

Put the first value in `ID_SIGNING_SECRET`, the second in `CREDENTIAL_ENCRYPTION_KEY`, and the third in `SETUP_TOKEN`. Production mode refuses to start without `SETUP_TOKEN`, which prevents an unauthorised visitor from claiming the first administrator account.

For a first local run, keep:

```dotenv
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:3000
ALLOWED_HOSTS=localhost,127.0.0.1
AUTH_MODE=token
ALLOW_SEND=false
```

Mailbox credentials are not stored in `.env`; add them later through the dashboard.

### 2. Install and validate

```bash
npm ci
npm run check
```

`npm run check` runs strict TypeScript checking, automated tests, and a production build.

### 3. Start the application

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Open:

```text
http://localhost:3000/setup
```

Create the first administrator, sign in, and add mailboxes.

### 4. Test each mailbox

Use the **Test** button on the mailbox card. It verifies both the IMAP and SMTP login without sending a message.

You can also test every mailbox owned by one user from the command line:

```bash
npm run check:connections -- user@example.com
```

Keep `ALLOW_SEND=false` until reading, searching, drafting, provider folders, and SMTP verification all work with a test mailbox.

## Docker

```bash
cp .env.example .env
# edit .env and generate both secrets
docker compose up --build -d
```

The default Compose file exposes the app only on `127.0.0.1:3000` and stores its SQLite database under `./data`.

For TrueNAS SCALE, use [docs/TRUENAS.md](docs/TRUENAS.md) and the included [custom-app YAML](docs/truenas-custom-app.yml).

## Authentication modes

### `AUTH_MODE=none`

Only for local development or a private single-user tunnel. It is rejected when `NODE_ENV=production`, and the MCP endpoint refuses requests unless exactly one active application user exists.

### `AUTH_MODE=token`

Each user can create a personal bearer token in **Security**. Tokens are stored only as SHA-256 hashes. This mode is useful with MCP clients and API tools that let you supply an `Authorization: Bearer ...` header.

A token is shown once at creation. It is tied to one application user and cannot access another user's rows.

### `AUTH_MODE=oauth`

Use this for several people connecting through ChatGPT. The app acts as an OAuth resource server and verifies JWT access tokens from an established OAuth 2.1 provider such as Auth0, Stytch, or a suitably configured enterprise identity provider.

Required settings:

```dotenv
AUTH_MODE=oauth
OAUTH_ISSUER_URL=https://your-issuer.example.com/
OAUTH_JWKS_URL=https://your-issuer.example.com/.well-known/jwks.json
OAUTH_AUDIENCE=https://mail.example.com
OAUTH_SCOPES=mail.read,mail.draft,mail.send
OAUTH_AUTO_LINK_EMAIL=true
```

Create each user in the local dashboard with the same email address delivered in the identity provider's signed `email` claim with `email_verified=true`. On first successful OAuth request, the app links the immutable OAuth subject to that local account. It then uses that local user ID for all ownership checks.

The identity provider must support the current MCP/ChatGPT OAuth requirements, including discovery, authorization code with PKCE, suitable client registration, the `resource` parameter, and access tokens minted for this MCP resource. Do not implement a casual home-grown OAuth provider for a production mail service.

See [docs/CHATGPT.md](docs/CHATGPT.md).

## TrueNAS architecture

```text
ChatGPT
   |
   | HTTPS or Secure MCP Tunnel
   v
TrueNAS SCALE Custom App
   |-- web dashboard
   |-- MCP endpoint
   |-- encrypted SQLite records on a dataset
   |-- outbound IMAP connections
   `-- outbound SMTP connections
```

Do not forward the raw application port directly from a router to the public internet. Use a properly configured HTTPS reverse proxy or OpenAI's Secure MCP Tunnel, and initialize the first administrator before making the endpoint reachable externally.

## Data stored on disk

The SQLite database contains:

- users and password hashes;
- browser sessions and CSRF secrets;
- mailbox settings and AES-256-GCM-encrypted credentials;
- personal MCP token hashes;
- drafts and approvals;
- audit records.

The `CREDENTIAL_ENCRYPTION_KEY` is not stored in the database. Losing it makes existing mailbox secrets unrecoverable. Someone who obtains both the database and this key can decrypt the mailbox credentials, so back up and protect them separately.

## Useful health endpoints

```text
GET /healthz
GET /api/status
GET /.well-known/oauth-protected-resource
```

Example health response:

```json
{
  "status": "ok",
  "version": "0.2.0",
  "users": 1
}
```

## Current limitations

This release intentionally does not yet include:

- moving, archiving, deleting, or bulk-changing messages;
- public self-registration;
- password-reset email flows or two-factor authentication;
- organization/shared-mailbox ACLs between several users;
- full-text indexing or background mailbox synchronization;
- provider OAuth for IMAP/SMTP credentials;
- a built-in OAuth authorization server for ChatGPT;
- horizontal scaling or a PostgreSQL backend;
- antivirus scanning of attachments;
- a recovery workflow for a lost encryption key.

It stores drafts locally rather than in each provider's IMAP Drafts folder. Thread reconstruction is best-effort because IMAP providers do not expose one universal conversation model.

## Production checklist

Before using real business mail:

- deploy behind HTTPS or Secure MCP Tunnel;
- set and protect `SETUP_TOKEN` before the first production start;
- use an established OAuth provider for multiple ChatGPT users;
- keep the encryption and signing secrets out of Git;
- set restrictive permissions on the data dataset;
- enable encrypted, tested backups;
- test with a separate mailbox first;
- keep `ALLOW_SEND=false` until read/draft tests pass;
- enable SMTP per mailbox only where needed;
- review audit logs;
- add reverse-proxy rate limits and login protection;
- arrange dependency updates and security monitoring.

## Validation included with this release

The automated suite covers:

- signed opaque message IDs and mailbox identity;
- encrypted credentials at rest;
- denial of cross-user mailbox access;
- send approval invalidation after a draft change;
- MCP mailbox labels and hidden approval secrets;
- setup-token protection, browser sessions, sign-in throttling, CSRF-protected mailbox creation, and encrypted persistence.
- per-user personal MCP token resolution.

Run it with:

```bash
npm run check
```

## License

MIT. See [LICENSE](LICENSE).
