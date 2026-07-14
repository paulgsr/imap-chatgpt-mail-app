# Security notes

This application handles mailbox credentials and private email. Treat it as a sensitive service, not as a casual home-page container.

## Implemented controls

- **Backend ownership enforcement:** every mailbox, draft, approval, token, and audit query is scoped to the authenticated application user.
- **Encrypted mailbox credentials:** IMAP and SMTP usernames/passwords are encrypted with AES-256-GCM before SQLite persistence.
- **No plaintext credential display:** saved passwords are never rendered back into the browser.
- **Password hashing:** web passwords use Node's `scrypt` with a random salt.
- **Protected bootstrap:** production requires a private `SETUP_TOKEN` before the first administrator can be created.
- **Secure sessions:** browser sessions use random opaque tokens stored as hashes, `HttpOnly`, `SameSite=Lax`, configurable `Secure`, expiry, and CSRF tokens.
- **Sign-in throttling:** repeated failed browser sign-ins are temporarily blocked per IP-and-email key.
- **Hashed MCP tokens:** personal bearer tokens are shown once and stored only as hashes.
- **Signed message references:** message IDs are opaque and authenticated, include the mailbox identity, and are revalidated against ownership.
- **Least-purpose tools:** there is no generic IMAP command or arbitrary SMTP relay tool.
- **Prompt-injection boundary:** email subjects, bodies, headers, and attachments are described and handled as untrusted data rather than authorization.
- **Send controls:** a global kill switch, per-mailbox send switch, recipient limits, exact-draft approval, approval expiry, and idempotent completion checks.
- **Sender locking:** a reply or forward remains attached to the mailbox that received the source message.
- **TLS validation:** IMAP and SMTP certificate verification is enabled by default.
- **Audit records:** security-relevant mailbox, draft, token, authentication, and send actions are recorded per user.
- **HTTP hardening:** CSP, no-store caching, frame blocking, MIME sniffing protection, referrer restriction, and HSTS when HTTPS is configured.

## Secrets

`CREDENTIAL_ENCRYPTION_KEY` must decode to exactly 32 random bytes. Generate it with:

```bash
openssl rand -base64 32
```

`ID_SIGNING_SECRET` should also be random and at least 32 characters:

```bash
openssl rand -base64 48
```

Keep both outside source control. Protect the `.env` file and back up the encryption key separately from the database. Rotating the credential key without decrypting and re-encrypting every mailbox record will make those records unreadable.

## Deployment boundaries

- Never expose plain HTTP over the public internet.
- Do not directly port-forward the application from a consumer router.
- Prefer OpenAI Secure MCP Tunnel for an on-premises TrueNAS server, or use a hardened HTTPS reverse proxy.
- Initialize the first administrator on a trusted network before making the endpoint externally reachable.
- Use `AUTH_MODE=oauth` with an established OAuth 2.1 identity provider for multiple ChatGPT users.
- `AUTH_MODE=none` is strictly a local, one-active-user mode.
- Put rate limiting, brute-force protection, and request-size controls at the reverse proxy as well as in the app.

## Remaining risks and limitations

Version 0.2 is an MVP, not a completed audited SaaS platform. It does not yet provide:

- two-factor authentication;
- password-reset or account-recovery email;
- device/session management UI;
- attachment malware scanning;
- database-level row security;
- security-key or passkey login;
- built-in key rotation;
- provider OAuth for mailbox credentials;
- independent external penetration testing.

SQLite is suitable for one TrueNAS instance, but not for active-active replicas. Use one running application instance against one database file.

## Reporting a problem

Do not include mailbox credentials, raw access tokens, encryption keys, or private email content in a bug report. Reproduce with a test mailbox and redact addresses and message IDs.
