# Release notes — 0.2.0

## Added

- Multi-user web control centre
- Multiple IMAP/SMTP mailboxes per user
- AES-256-GCM encrypted mailbox credentials
- Strict backend ownership checks
- Mailbox-labelled cross-account searches
- Correct source-mailbox identity for replies and forwards
- Per-user drafts, approvals, personal MCP tokens, and audit records
- Administrator-created users and account disabling
- Protected first-run setup token
- Browser sessions, CSRF protection, password hashing, and sign-in throttling
- External OAuth JWT verification with verified-email auto-linking
- TrueNAS Custom App YAML and deployment guide
- In-app `/docs` connection guide

## Safety defaults

- Global SMTP sending is disabled
- New mailboxes have sending disabled by default
- Sending requires an unchanged-draft approval
- `AUTH_MODE=none` is refused in production and when multiple active users exist
- Production startup requires `SETUP_TOKEN`
- TLS certificate verification is enabled for IMAP and SMTP

## Validation

- Strict TypeScript type check: passed
- Automated tests: 9 passed across 7 files
- Production build: passed
- HTTP startup smoke test: passed
- `/healthz`, `/api/status`, `/docs`, and setup-token page checks: passed
- `npm audit --omit=dev`: 0 vulnerabilities reported

## Not validated in this environment

- Real provider IMAP authentication
- Real provider SMTP authentication or delivery
- Docker image build (Docker CLI was not installed in the build environment)
- TrueNAS installation on the user's hardware
- End-to-end ChatGPT OAuth against the user's selected identity provider
