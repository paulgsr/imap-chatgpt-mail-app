# Running v0.2 on TrueNAS SCALE

This guide targets TrueNAS SCALE releases with Docker-backed Apps and **Custom App / Install via YAML** support. TrueNAS 24.10 introduced the Docker Apps backend; current SCALE documentation also supports Compose YAML and host-path datasets for Custom Apps.

Official references:

- https://www.truenas.com/docs/scale/apps/installcustomappscreens/
- https://www.truenas.com/docs/scale/apps/appsscreens/

## Resulting layout

```text
/mnt/tank/app-config/imap-chatgpt-mail/.env
/mnt/tank/app-data/imap-chatgpt-mail/mailapp.sqlite
/mnt/tank/app-data/imap-chatgpt-mail/mailapp.sqlite-wal
/mnt/tank/app-data/imap-chatgpt-mail/mailapp.sqlite-shm
```

Replace `tank` with the name of your pool.

## 1. Create datasets

In **Datasets**, create:

```text
tank/app-config/imap-chatgpt-mail
tank/app-data/imap-chatgpt-mail
```

The image runs as the non-root `node` user, UID/GID `1000:1000`. Give that identity write permission to the data dataset. From the TrueNAS shell:

```bash
chown -R 1000:1000 /mnt/tank/app-data/imap-chatgpt-mail
chmod 700 /mnt/tank/app-data/imap-chatgpt-mail
```

Keep the configuration dataset readable only by administrators:

```bash
chmod 700 /mnt/tank/app-config/imap-chatgpt-mail
```

## 2. Create the TrueNAS `.env`

Copy `.env.example` to:

```text
/mnt/tank/app-config/imap-chatgpt-mail/.env
```

Generate secrets on a trusted machine or in the TrueNAS shell:

```bash
openssl rand -base64 48
openssl rand -base64 32
openssl rand -base64 32
```

Use the values for:

```dotenv
ID_SIGNING_SECRET=FIRST_VALUE
CREDENTIAL_ENCRYPTION_KEY=SECOND_VALUE
SETUP_TOKEN=THIRD_VALUE
```

`SETUP_TOKEN` is required in production and must be entered once on the first administrator form.

A safe initial LAN configuration looks like:

```dotenv
NODE_ENV=production
PORT=3000
BIND_HOST=0.0.0.0
PUBLIC_BASE_URL=http://192.168.1.50:2091
ALLOWED_HOSTS=192.168.1.50,truenas.local,localhost,127.0.0.1
TRUST_PROXY=false
LOG_LEVEL=info
DATA_DIR=/app/data
SETUP_TOKEN=REPLACE_WITH_PRIVATE_FIRST_RUN_TOKEN

AUTH_MODE=token
OAUTH_SCOPES=mail.read,mail.draft,mail.send
OAUTH_AUTO_LINK_EMAIL=true

ID_SIGNING_SECRET=REPLACE_WITH_RANDOM_VALUE
CREDENTIAL_ENCRYPTION_KEY=REPLACE_WITH_BASE64_32_BYTE_KEY

SESSION_COOKIE_NAME=mailapp_session
SESSION_TTL_DAYS=30
COOKIE_SECURE=false

ALLOW_SEND=false

MAX_MAILBOXES_PER_USER=20
MAX_PARALLEL_MAILBOX_SEARCHES=4
MAX_SEARCH_RESULTS=50
MAX_PREVIEW_SOURCE_BYTES=65536
MAX_MESSAGE_BYTES=10485760
MAX_BODY_CHARS=50000
MAX_FORWARD_ATTACHMENT_BYTES=20971520
MAX_RECIPIENTS=20
SEND_APPROVAL_TTL_SECONDS=600
```

Replace `192.168.1.50` with the TrueNAS IP. When you later place the app behind HTTPS, set `PUBLIC_BASE_URL` to the HTTPS address, add its hostname to `ALLOWED_HOSTS`, set `TRUST_PROXY=true` when appropriate for your proxy, and set `COOKIE_SECURE=true`.

Protect the file:

```bash
chmod 600 /mnt/tank/app-config/imap-chatgpt-mail/.env
```

Do not put any mailbox password in this file. Mailbox accounts are added through the web UI and encrypted in SQLite.

## 3. Build and publish the image

TrueNAS needs an image it can pull. On a machine with Docker, from the project directory:

```bash
docker build -t ghcr.io/YOUR_GITHUB_USERNAME/imap-chatgpt-mail-app:0.2.0 .
docker login ghcr.io
docker push ghcr.io/YOUR_GITHUB_USERNAME/imap-chatgpt-mail-app:0.2.0
```

You may use another private registry. Configure its credentials in the TrueNAS Apps registry settings before installation.

## 4. Install as a Custom App

Open:

```text
Apps -> Discover -> Custom App -> Install via YAML
```

Copy `docs/truenas-custom-app.yml` into the YAML editor, then replace:

- `YOUR_GITHUB_USERNAME`
- `tank`
- host port `2091` if it is already in use

The template is:

```yaml
services:
  imap-chatgpt-mail:
    image: ghcr.io/YOUR_GITHUB_USERNAME/imap-chatgpt-mail-app:0.2.0
    container_name: imap-chatgpt-mail
    restart: unless-stopped
    env_file:
      - /mnt/tank/app-config/imap-chatgpt-mail/.env
    environment:
      BIND_HOST: 0.0.0.0
      DATA_DIR: /app/data
    ports:
      - "2091:3000"
    volumes:
      - /mnt/tank/app-data/imap-chatgpt-mail:/app/data
```

The container does not need privileged mode, host networking, device access, or additional Linux capabilities.

## 5. Verify the deployment

From another computer on the LAN:

```bash
curl http://192.168.1.50:2091/healthz
```

Expected response:

```json
{"status":"ok","version":"0.2.0","users":0}
```

Open:

```text
http://192.168.1.50:2091/setup
```

Enter the `SETUP_TOKEN` from the server configuration and create the first administrator. The `/setup` page stops accepting account creation after the first user exists.

## 6. Add your mailboxes

In the dashboard:

1. Select **Add mailbox**.
2. Enter the receiving address and a clear label, such as `Orders` or `Support`.
3. Enter the IMAP and SMTP hosts, ports, usernames, and app passwords.
4. Initially enable reading but leave sending disabled.
5. Save and press **Test**.

Repeat for all four addresses. Search results returned to ChatGPT will contain both the label and exact receiving address.

## 7. Add another person safely

As an administrator, open **Users** and create their application account. They sign in with their own account and add only their own mailbox credentials. Their records receive a different owner ID.

Neither the web routes nor MCP tools accept a user ID from the client as authority. The server resolves the user from the session or access token and checks mailbox ownership in the backend.

## 8. Connect it to ChatGPT

Do not forward `2091` directly from your router.

For a private TrueNAS server, prefer OpenAI Secure MCP Tunnel. For a public deployment, use a hardened HTTPS reverse proxy. OpenAI's current documentation says an on-premises or firewalled MCP server can use Secure MCP Tunnel instead of being exposed publicly:

- https://developers.openai.com/api/docs/guides/tools-connectors-mcp#secure-mcp-tunnel
- https://developers.openai.com/apps-sdk/deploy/connect-chatgpt

The endpoint is:

```text
https://YOUR-REACHABLE-HOST/mcp
```

For one-person testing, `AUTH_MODE=none` can be used only with `NODE_ENV=development` and exactly one active user. For several people in ChatGPT, use `AUTH_MODE=oauth`; see `docs/CHATGPT.md`.

## 9. Enable sending only after testing

First leave:

```dotenv
ALLOW_SEND=false
```

After reading, thread retrieval, drafting, and connection tests all work with test mail:

1. enable sending on only the required mailbox cards;
2. change the global setting to `ALLOW_SEND=true`;
3. restart the Custom App;
4. send only to a controlled test address;
5. verify the recipient copy and Sent folder behavior.

The app still requires an unchanged-draft approval before delivery.

## Logs and troubleshooting

Use the app's **Logs** action in TrueNAS. Common failures:

- `EACCES` or SQLite open failure — UID 1000 cannot write the data dataset;
- startup says `SETUP_TOKEN` is required — set a random value of at least 16 characters in production;
- invalid encryption key — the base64 value does not decode to exactly 32 bytes;
- invalid host header — add the accessed IP/hostname to `ALLOWED_HOSTS`;
- secure cookie but HTTP URL — set `COOKIE_SECURE=false` only for trusted LAN HTTP;
- IMAP/SMTP login failure — use an app password and verify provider host/port/TLS settings;
- certificate error — correct the provider hostname; do not disable verification except for a controlled internal test server;
- MCP 401 — the selected authentication mode does not match the client token;
- MCP 503 in no-auth mode — there is not exactly one active user.

## Updating

Build and push a new immutable image tag, update the tag in the Custom App YAML, and redeploy. Do not use `latest` for a mail service unless you have a tested rollback process.

Before an upgrade:

1. back up `.env` and the encryption key securely;
2. snapshot the app-data dataset;
3. record the current image tag;
4. stop or quiesce the app for the cleanest SQLite backup;
5. deploy the new image;
6. verify `/healthz`, login, mailbox tests, and a read-only MCP query before enabling sends.

## Backup and restore

The database and its WAL/SHM files live in the data dataset. A dataset snapshot captures them atomically, but stopping the app during a manual copy is safest. Restore the database together with the same `CREDENTIAL_ENCRYPTION_KEY`; without that key, mailbox credentials cannot be decrypted.
