import type { ApiTokenRecord, AuditRecord, DraftRecord, MailboxRecord, MailboxSummary, UserRecord } from "../domain.js";

export interface PageMessage { notice?: string; error?: string }

interface ShellOptions {
  title: string;
  user?: UserRecord;
  csrfToken?: string;
  message?: PageMessage;
  body: string;
  active?: "mailboxes" | "users" | "security";
  publicWide?: boolean;
}

export function setupPage(message: PageMessage = {}, setupTokenRequired = false): string {
  return shell({
    title: "Create the first administrator",
    message,
    body: `
      <section class="auth-card">
        <div class="eyebrow">First-time setup</div>
        <h1>Create your administrator account</h1>
        <p class="lede">This account owns only its own mailboxes. You can add separate users later without sharing access.</p>
        <form method="post" action="/setup" class="stack">
          ${field("Name", "name", "text", "Patrick Göser", true, "name")}
          ${field("Email address", "email", "email", "patrick@example.com", true, "username")}
          ${field("Password", "password", "password", "At least 12 characters", true, "new-password")}
          ${setupTokenRequired ? field("Setup token", "setup_token", "password", "", true, "off", "Value from SETUP_TOKEN") : ""}
          <button class="button primary" type="submit">Create administrator</button>
        </form>
      </section>`,
  });
}

export function loginPage(message: PageMessage = {}): string {
  return shell({
    title: "Sign in",
    message,
    body: `
      <section class="auth-card">
        <div class="eyebrow">Mailbox control centre</div>
        <h1>Sign in</h1>
        <p class="lede">Your session can see only mailboxes assigned to your user account.</p>
        <form method="post" action="/login" class="stack">
          ${field("Email address", "email", "email", "you@example.com", true, "username")}
          ${field("Password", "password", "password", "", true, "current-password")}
          <button class="button primary" type="submit">Sign in</button>
        </form>
      </section>`,
  });
}

export function dashboardPage(input: {
  user: UserRecord;
  csrfToken: string;
  mailboxes: MailboxSummary[];
  drafts: DraftRecord[];
  audit: AuditRecord[];
  sendGloballyEnabled: boolean;
  authMode: string;
  message?: PageMessage;
}): string {
  const { user, csrfToken, mailboxes, drafts, audit } = input;
  const connected = mailboxes.filter((entry) => entry.status === "connected").length;
  const readable = mailboxes.filter((entry) => entry.readEnabled).length;
  const sendable = mailboxes.filter((entry) => entry.sendEnabled).length;
  return shell({
    title: "Mailboxes",
    user,
    csrfToken,
    ...(input.message ? { message: input.message } : {}),
    active: "mailboxes",
    body: `
      <div class="page-head">
        <div><div class="eyebrow">Your private workspace</div><h1>Mailboxes</h1><p class="lede">ChatGPT can search these together while every message remains labelled with the receiving address.</p></div>
        <a class="button primary" href="/app/mailboxes/new">Add mailbox</a>
      </div>
      <section class="stats">
        ${stat("Configured", mailboxes.length)}${stat("Connected", connected)}${stat("Readable", readable)}${stat("Send enabled", sendable)}
      </section>
      <div class="callout ${input.sendGloballyEnabled ? "safe" : "warn"}">
        <strong>Global sending: ${input.sendGloballyEnabled ? "enabled" : "disabled"}</strong>
        <span>${input.sendGloballyEnabled ? "Each mailbox still needs its own send switch and an explicit draft approval." : "Reading and drafting work, but SMTP delivery is blocked until ALLOW_SEND=true."}</span>
      </div>
      <section class="mailbox-grid">
        ${mailboxes.length ? mailboxes.map((mailbox) => mailboxCard(mailbox, csrfToken)).join("") : emptyState("No mailboxes yet", "Add your first IMAP/SMTP account. Credentials are encrypted before they are written to disk.")}
      </section>
      <section class="panel split-top">
        <div class="panel-head"><div><h2>Recent drafts</h2><p>Every draft is locked to the mailbox that received the original email.</p></div></div>
        ${drafts.length ? `<div class="table-wrap"><table><thead><tr><th>Mailbox</th><th>Type</th><th>Subject</th><th>Status</th><th>Updated</th></tr></thead><tbody>${drafts.slice(0, 12).map(draftRow).join("")}</tbody></table></div>` : `<p class="panel-empty">No drafts have been created yet.</p>`}
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Recent activity</h2><p>Security-relevant actions for your account.</p></div><span class="chip">MCP auth: ${escapeHtml(input.authMode)}</span></div>
        ${audit.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Status</th><th>Details</th></tr></thead><tbody>${audit.slice(0, 30).map(auditRow).join("")}</tbody></table></div>` : `<p class="panel-empty">No activity recorded yet.</p>`}
      </section>`,
  });
}

export function mailboxFormPage(input: {
  user: UserRecord;
  csrfToken: string;
  mailbox?: MailboxRecord;
  message?: PageMessage;
}): string {
  const m = input.mailbox;
  const editing = Boolean(m);
  const action = editing ? `/app/mailboxes/${encodeURIComponent(m!.id)}` : "/app/mailboxes";
  return shell({
    title: editing ? "Edit mailbox" : "Add mailbox",
    user: input.user,
    csrfToken: input.csrfToken,
    ...(input.message ? { message: input.message } : {}),
    active: "mailboxes",
    body: `
      <div class="page-head compact"><div><div class="eyebrow">${editing ? "Mailbox settings" : "New connection"}</div><h1>${editing ? `Edit ${escapeHtml(m!.emailAddress)}` : "Add a mailbox"}</h1><p class="lede">The password fields are never shown again. Leave them blank while editing to keep the existing secrets.</p></div></div>
      <form method="post" action="${action}" class="panel form-panel">
        <input type="hidden" name="_csrf" value="${escapeAttr(input.csrfToken)}">
        <div class="section-title"><h2>Identity</h2><p>This label appears beside every result returned to ChatGPT.</p></div>
        <div class="fields two">
          ${field("Email address", "email_address", "email", m?.emailAddress ?? "", true, "email", "name@example.com")}
          ${field("Display name", "display_name", "text", m?.displayName ?? "", false, "name", "Support, Orders, Patrick…")}
        </div>
        <div class="section-title"><h2>Incoming mail (IMAP)</h2><p>Used for folders, search, reading, threads, attachments, and Sent copies.</p></div>
        <div class="fields two">
          ${field("IMAP host", "imap_host", "text", m?.imapHost ?? "", true, "off", "imap.example.com")}
          ${field("IMAP port", "imap_port", "number", String(m?.imapPort ?? 993), true, "off")}
          ${field("IMAP username", "imap_username", "text", editing ? "" : (m?.emailAddress ?? ""), !editing, "username", editing ? "Leave blank to keep the existing username" : "Usually the full email address")}
          ${field(editing ? "New IMAP password (optional)" : "IMAP password / app password", "imap_password", "password", "", !editing, "new-password")}
          ${field("Sent folder override", "imap_sent_folder", "text", m?.imapSentFolder ?? "", false, "off", "Optional, e.g. Sent or INBOX.Sent")}
          <div class="checks">${checkbox("imap_secure", "Use implicit TLS", m?.imapSecure ?? true)}${checkbox("imap_reject_unauthorized", "Verify TLS certificate", m?.imapRejectUnauthorized ?? true)}</div>
        </div>
        <div class="section-title"><h2>Outgoing mail (SMTP)</h2><p>Used only after an unchanged draft receives an explicit send approval.</p></div>
        <div class="fields two">
          ${field("SMTP host", "smtp_host", "text", m?.smtpHost ?? "", true, "off", "smtp.example.com")}
          ${field("SMTP port", "smtp_port", "number", String(m?.smtpPort ?? 465), true, "off")}
          ${field("SMTP username", "smtp_username", "text", editing ? "" : (m?.emailAddress ?? ""), !editing, "username", editing ? "Leave blank to keep the existing username" : "Usually the full email address")}
          ${field(editing ? "New SMTP password (optional)" : "SMTP password / app password", "smtp_password", "password", "", !editing, "new-password")}
          <div class="checks">${checkbox("smtp_secure", "Use implicit TLS", m?.smtpSecure ?? true)}${checkbox("smtp_reject_unauthorized", "Verify TLS certificate", m?.smtpRejectUnauthorized ?? true)}</div>
          <div class="checks">${checkbox("read_enabled", "Allow ChatGPT to read", m?.readEnabled ?? true)}${checkbox("send_enabled", "Allow this mailbox to send", m?.sendEnabled ?? false)}${checkbox("save_sent_copy", "Save an IMAP Sent copy", m?.saveSentCopy ?? true)}</div>
        </div>
        <div class="form-actions"><a class="button" href="/app">Cancel</a><button class="button primary" type="submit">${editing ? "Save changes" : "Add mailbox"}</button></div>
      </form>`,
  });
}

export function usersPage(input: { user: UserRecord; csrfToken: string; users: UserRecord[]; message?: PageMessage }): string {
  return shell({
    title: "Users",
    user: input.user,
    csrfToken: input.csrfToken,
    ...(input.message ? { message: input.message } : {}),
    active: "users",
    body: `
      <div class="page-head"><div><div class="eyebrow">Access separation</div><h1>Users</h1><p class="lede">Each user can connect and search only their own mailbox records, drafts, tokens, and audit history.</p></div></div>
      <section class="split">
        <div class="panel form-panel mini">
          <div class="section-title"><h2>Create a user</h2><p>There is no public registration. An administrator creates each account.</p></div>
          <form method="post" action="/app/users" class="stack">
            <input type="hidden" name="_csrf" value="${escapeAttr(input.csrfToken)}">
            ${field("Name", "name", "text", "", true, "name")}
            ${field("Email", "email", "email", "", true, "username")}
            ${field("Temporary password", "password", "password", "", true, "new-password", "At least 12 characters")}
            <label class="field"><span>Role</span><select name="role"><option value="user">User</option><option value="admin">Administrator</option></select></label>
            <button class="button primary" type="submit">Create user</button>
          </form>
        </div>
        <div class="panel">
          <div class="panel-head"><div><h2>Existing users</h2><p>Disabling a user also invalidates their sessions and MCP tokens.</p></div></div>
          <div class="user-list">${input.users.map((entry) => userCard(entry, input.user, input.csrfToken)).join("")}</div>
        </div>
      </section>`,
  });
}


export function docsPage(input: { publicBaseUrl: string; authMode: string; setupProtected: boolean }): string {
  return shell({
    title: "Connection guide",
    publicWide: true,
    body: `
      <section class="panel docs-panel">
        <div class="section-title"><div><div class="eyebrow">Deployment reference</div><h1>Mail MCP connection guide</h1><p>Use the web dashboard to create users and attach IMAP/SMTP mailboxes. ChatGPT talks only to the MCP endpoint; mailbox credentials remain encrypted on this server.</p></div></div>
        <div class="docs-content">
          <h2>Endpoints</h2>
          <dl class="endpoint-list"><dt>Dashboard</dt><dd><code>${escapeHtml(input.publicBaseUrl)}</code></dd><dt>MCP</dt><dd><code>${escapeHtml(input.publicBaseUrl)}/mcp</code></dd><dt>OAuth resource metadata</dt><dd><code>${escapeHtml(input.publicBaseUrl)}/.well-known/oauth-protected-resource</code></dd></dl>
          <h2>Current authentication mode</h2>
          <p><strong>${escapeHtml(input.authMode)}</strong></p>
          <ul>
            <li><strong>oauth</strong> is the multi-user ChatGPT mode. Configure an established OAuth 2.1 identity provider and issue tokens with <code>mail.read</code>, <code>mail.draft</code>, and <code>mail.send</code> scopes.</li>
            <li><strong>token</strong> accepts per-user personal bearer tokens for MCP Inspector and other clients. ChatGPT does not accept customer-provided API keys, so use OAuth for ChatGPT user linking.</li>
            <li><strong>none</strong> is single-user local development only and is rejected in production.</li>
          </ul>
          <h2>User isolation</h2>
          <p>Every mailbox, draft, token, approval, and audit query is resolved through the authenticated application user. A mailbox ID owned by another user is returned as not found.</p>
          <h2>First-run setup</h2>
          <p>${input.setupProtected ? "The first administrator form requires the server-side SETUP_TOKEN." : "No setup token is configured. Keep this development instance private until the first administrator exists."}</p>
          <p><a class="button primary" href="/">Open dashboard</a></p>
        </div>
      </section>`,
  });
}

export function securityPage(input: {
  user: UserRecord;
  csrfToken: string;
  tokens: ApiTokenRecord[];
  authMode: string;
  newToken?: string;
  message?: PageMessage;
}): string {
  return shell({
    title: "Security",
    user: input.user,
    csrfToken: input.csrfToken,
    ...(input.message ? { message: input.message } : {}),
    active: "security",
    body: `
      <div class="page-head"><div><div class="eyebrow">Authentication</div><h1>Security</h1><p class="lede">Create a separate MCP token for MCP Inspector or other bearer-token clients. ChatGPT user linking requires OAuth; every token remains restricted to this user’s mailbox rows.</p></div></div>
      ${input.newToken ? `<div class="secret-box"><strong>Copy this token now</strong><p>It is shown once and only its SHA-256 hash is stored.</p><code>${escapeHtml(input.newToken)}</code></div>` : ""}
      <section class="split">
        <div class="panel form-panel mini">
          <div class="section-title"><h2>Personal MCP token</h2><p>Current server mode: <strong>${escapeHtml(input.authMode)}</strong>. Personal tokens work when AUTH_MODE=token; ChatGPT does not accept customer-provided API keys, so use AUTH_MODE=oauth for ChatGPT.</p></div>
          <form method="post" action="/app/security/tokens" class="stack">
            <input type="hidden" name="_csrf" value="${escapeAttr(input.csrfToken)}">
            ${field("Token name", "name", "text", "ChatGPT", true, "off", "For example: Patrick’s ChatGPT")}
            <button class="button primary" type="submit">Create token</button>
          </form>
          <div class="token-list">${input.tokens.length ? input.tokens.map((token) => tokenCard(token, input.csrfToken)).join("") : `<p class="muted">No tokens yet.</p>`}</div>
        </div>
        <div class="panel form-panel mini">
          <div class="section-title"><h2>Change password</h2><p>Changing it signs out all browser sessions, including this one.</p></div>
          <form method="post" action="/app/security/password" class="stack">
            <input type="hidden" name="_csrf" value="${escapeAttr(input.csrfToken)}">
            ${field("Current password", "current_password", "password", "", true, "current-password")}
            ${field("New password", "new_password", "password", "", true, "new-password", "At least 12 characters")}
            <button class="button primary" type="submit">Change password</button>
          </form>
        </div>
      </section>`,
  });
}

function shell(options: ShellOptions): string {
  const authPage = !options.user;
  const navigation = options.user ? `
    <header class="topbar">
      <a class="brand" href="/app"><span class="brand-mark">M</span><span>Mail MCP</span></a>
      <nav>
        <a class="${options.active === "mailboxes" ? "active" : ""}" href="/app">Mailboxes</a>
        ${options.user.role === "admin" ? `<a class="${options.active === "users" ? "active" : ""}" href="/app/users">Users</a>` : ""}
        <a class="${options.active === "security" ? "active" : ""}" href="/app/security">Security</a>
      </nav>
      <div class="account"><span>${escapeHtml(options.user.name)}<small>${escapeHtml(options.user.email)}</small></span><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escapeAttr(options.csrfToken ?? "")}"><button class="button small" type="submit">Sign out</button></form></div>
    </header>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.title)} · Mail MCP</title><style>${styles}</style></head><body class="${authPage ? "auth-body" : ""}">${navigation}<main class="${authPage ? (options.publicWide ? "public-shell" : "auth-shell") : "shell"}">${alerts(options.message)}${options.body}</main></body></html>`;
}

function mailboxCard(mailbox: MailboxSummary, csrf: string): string {
  const label = mailbox.displayName || mailbox.emailAddress;
  const statusClass = mailbox.status === "connected" ? "success" : mailbox.status === "error" ? "danger" : "neutral";
  return `<article class="mailbox-card">
    <div class="mailbox-head"><div class="mail-icon">@</div><div><h2>${escapeHtml(label)}</h2><p>${escapeHtml(mailbox.emailAddress)}</p></div><span class="status ${statusClass}">${escapeHtml(mailbox.status)}</span></div>
    <div class="permissions"><span class="pill ${mailbox.readEnabled ? "on" : "off"}">Read ${mailbox.readEnabled ? "on" : "off"}</span><span class="pill ${mailbox.sendEnabled ? "on" : "off"}">Send ${mailbox.sendEnabled ? "on" : "off"}</span></div>
    ${mailbox.lastError ? `<p class="error-text">${escapeHtml(mailbox.lastError)}</p>` : `<p class="muted">${mailbox.lastCheckedAt ? `Last checked ${escapeHtml(formatDate(mailbox.lastCheckedAt))}` : "Connection has not been tested yet."}</p>`}
    <div class="card-actions"><a class="button" href="/app/mailboxes/${encodeURIComponent(mailbox.id)}/edit">Edit</a><form method="post" action="/app/mailboxes/${encodeURIComponent(mailbox.id)}/test"><input type="hidden" name="_csrf" value="${escapeAttr(csrf)}"><button class="button" type="submit">Test</button></form><form method="post" action="/app/mailboxes/${encodeURIComponent(mailbox.id)}/delete"><input type="hidden" name="_csrf" value="${escapeAttr(csrf)}"><button class="button danger-button" type="submit">Remove</button></form></div>
  </article>`;
}

function userCard(entry: UserRecord, current: UserRecord, csrf: string): string {
  return `<div class="user-card"><div><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(entry.email)}</span><small>${escapeHtml(entry.role)} · ${entry.disabled ? "disabled" : "active"}</small></div>${entry.id === current.id ? `<span class="chip">You</span>` : `<form method="post" action="/app/users/${encodeURIComponent(entry.id)}/toggle"><input type="hidden" name="_csrf" value="${escapeAttr(csrf)}"><button class="button small ${entry.disabled ? "" : "danger-button"}" type="submit">${entry.disabled ? "Enable" : "Disable"}</button></form>`}</div>`;
}

function tokenCard(token: ApiTokenRecord, csrf: string): string {
  return `<div class="token-card"><div><strong>${escapeHtml(token.name)}</strong><span>Created ${escapeHtml(formatDate(token.createdAt))}</span><small>${token.revokedAt ? `Revoked ${escapeHtml(formatDate(token.revokedAt))}` : token.lastUsedAt ? `Last used ${escapeHtml(formatDate(token.lastUsedAt))}` : "Not used yet"}</small></div>${token.revokedAt ? `<span class="chip">Revoked</span>` : `<form method="post" action="/app/security/tokens/${encodeURIComponent(token.id)}/revoke"><input type="hidden" name="_csrf" value="${escapeAttr(csrf)}"><button class="button small danger-button" type="submit">Revoke</button></form>`}</div>`;
}

function draftRow(draft: DraftRecord): string {
  return `<tr><td><strong>${escapeHtml(draft.mailboxDisplayName || draft.mailboxAddress)}</strong><small>${escapeHtml(draft.mailboxAddress)}</small></td><td>${escapeHtml(draft.kind)}</td><td>${escapeHtml(draft.subject)}</td><td><span class="status ${draft.status === "sent" ? "success" : "neutral"}">${escapeHtml(draft.status)}</span></td><td>${escapeHtml(formatDate(draft.updatedAt))}</td></tr>`;
}

function auditRow(record: AuditRecord): string {
  return `<tr><td>${escapeHtml(formatDate(record.timestamp))}</td><td>${escapeHtml(record.action.replaceAll("_", " "))}</td><td><span class="status ${record.status === "success" ? "success" : "danger"}">${escapeHtml(record.status)}</span></td><td>${escapeHtml(record.detail ?? "—")}</td></tr>`;
}

function field(label: string, name: string, type: string, value: string, required: boolean, autocomplete: string, placeholder = ""): string {
  return `<label class="field"><span>${escapeHtml(label)}</span><input type="${escapeAttr(type)}" name="${escapeAttr(name)}" value="${type === "password" ? "" : escapeAttr(value)}" ${required ? "required" : ""} autocomplete="${escapeAttr(autocomplete)}" placeholder="${escapeAttr(placeholder || value)}"></label>`;
}

function checkbox(name: string, label: string, checked: boolean): string {
  return `<label class="check"><input type="checkbox" name="${escapeAttr(name)}" value="1" ${checked ? "checked" : ""}><span>${escapeHtml(label)}</span></label>`;
}

function stat(label: string, value: number): string { return `<div class="stat"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`; }
function emptyState(title: string, text: string): string { return `<div class="empty"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></div>`; }
function alerts(message?: PageMessage): string { return `${message?.notice ? `<div class="alert success">${escapeHtml(message.notice)}</div>` : ""}${message?.error ? `<div class="alert failure">${escapeHtml(message.error)}</div>` : ""}`; }
function formatDate(value: string): string { try { return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); } catch { return value; } }
export function escapeHtml(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char); }
function escapeAttr(value: unknown): string { return escapeHtml(value); }

const styles = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18212b;background:#f5f7f9;line-height:1.45;font-synthesis:none}*{box-sizing:border-box}body{margin:0}a{color:inherit;text-decoration:none}button,input,select{font:inherit}.topbar{height:72px;background:#fff;border-bottom:1px solid #e1e6eb;display:flex;align-items:center;padding:0 28px;gap:34px;position:sticky;top:0;z-index:5}.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:-.02em}.brand-mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#17202a;color:#fff}.topbar nav{display:flex;gap:6px;height:100%;align-items:center}.topbar nav a{padding:9px 13px;border-radius:9px;color:#637080;font-weight:650;font-size:.9rem}.topbar nav a:hover,.topbar nav a.active{background:#eef2f6;color:#17202a}.account{margin-left:auto;display:flex;align-items:center;gap:14px}.account>span{display:flex;flex-direction:column;text-align:right;font-weight:700;font-size:.88rem}.account small{font-weight:450;color:#778290}.shell{max-width:1200px;margin:0 auto;padding:44px 28px 80px}.auth-body{min-height:100vh;background:radial-gradient(circle at 50% -10%,#fff 0,#eef2f6 58%,#e9edf1 100%);display:grid;place-items:center;padding:24px}.auth-shell{width:100%;max-width:480px}.public-shell{width:100%;max-width:920px;margin:0 auto;padding:40px 24px}.auth-card{background:#fff;border:1px solid #dfe5ea;border-radius:22px;padding:34px;box-shadow:0 24px 70px rgba(27,39,51,.1)}h1,h2,p{margin-top:0}.auth-card h1,.page-head h1{letter-spacing:-.045em;line-height:1.08}.auth-card h1{font-size:2rem;margin-bottom:10px}.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:26px}.page-head.compact{max-width:840px}.page-head h1{font-size:2.3rem;margin:4px 0 10px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:.71rem;font-weight:800;color:#687585}.lede{color:#687585;max-width:750px;margin-bottom:0}.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #ccd4dc;background:#fff;color:#24303c;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer;white-space:nowrap}.button:hover{background:#f5f7f9}.button.primary{background:#1e2935;border-color:#1e2935;color:#fff}.button.primary:hover{background:#0e1720}.button.small{padding:7px 10px;font-size:.82rem}.danger-button{color:#a22820;border-color:#e7b7b2;background:#fff9f8}.stack{display:grid;gap:16px}.field{display:flex;flex-direction:column;gap:7px;font-size:.86rem;font-weight:720}.field input,.field select{width:100%;border:1px solid #cdd5dd;border-radius:10px;padding:10px 11px;background:#fff;color:#17202a;outline:none}.field input:focus,.field select:focus{border-color:#3a66c7;box-shadow:0 0 0 3px rgba(58,102,199,.12)}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.stat{background:#fff;border:1px solid #e0e5ea;border-radius:15px;padding:18px 20px;display:flex;flex-direction:column}.stat strong{font-size:1.65rem;letter-spacing:-.04em}.stat span{color:#75808d;font-size:.82rem}.callout{border-radius:13px;padding:13px 16px;margin:0 0 20px;display:flex;gap:10px;align-items:center;font-size:.88rem}.callout span{color:#617080}.callout.safe{background:#edf8f1;border:1px solid #c5e7d0}.callout.warn{background:#fff8e8;border:1px solid #f1d89b}.mailbox-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:22px}.mailbox-card,.panel,.empty{background:#fff;border:1px solid #e0e5ea;border-radius:17px}.mailbox-card{padding:20px}.mailbox-head{display:flex;align-items:center;gap:12px}.mailbox-head h2{font-size:1.05rem;margin:0}.mailbox-head p{font-size:.82rem;color:#75808d;margin:2px 0 0}.mail-icon{width:39px;height:39px;display:grid;place-items:center;background:#eef2f6;border-radius:11px;font-weight:900}.mailbox-head>.status{margin-left:auto}.permissions{display:flex;gap:7px;margin:16px 0 12px}.pill,.chip,.status{display:inline-flex;border-radius:99px;padding:4px 8px;font-size:.71rem;font-weight:800;text-transform:capitalize}.pill.on,.status.success{background:#e7f6ed;color:#17683c}.pill.off,.status.neutral,.chip{background:#edf1f4;color:#5d6875}.status.danger{background:#ffebe8;color:#9c2b22}.error-text{color:#9c2b22;font-size:.82rem;background:#fff4f2;padding:9px;border-radius:9px}.muted{color:#75808d;font-size:.82rem}.card-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.card-actions form{display:inline-flex}.panel{margin-top:18px;overflow:hidden}.panel-head,.section-title{padding:20px 22px;border-bottom:1px solid #e7ebef;display:flex;align-items:center;justify-content:space-between;gap:12px}.panel-head h2,.section-title h2{font-size:1.05rem;margin:0}.panel-head p,.section-title p{font-size:.82rem;color:#75808d;margin:3px 0 0}.panel-empty{padding:20px 22px;color:#75808d}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:.82rem}th,td{text-align:left;padding:12px 16px;border-bottom:1px solid #edf0f3;vertical-align:top}th{color:#687585;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;background:#fafbfc}td small,td strong{display:block}.form-panel{max-width:880px}.form-panel.mini{max-width:none}.fields{display:grid;gap:17px;padding:22px}.fields.two{grid-template-columns:1fr 1fr}.checks{display:grid;gap:8px;align-content:start}.check{display:flex;align-items:center;gap:9px;background:#f7f9fa;border:1px solid #e2e7eb;padding:10px;border-radius:10px;font-size:.84rem;font-weight:650}.check input{width:17px;height:17px}.form-actions{padding:18px 22px;background:#fafbfc;border-top:1px solid #e7ebef;display:flex;justify-content:flex-end;gap:9px}.split{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:18px;align-items:start}.user-list,.token-list{display:grid}.user-card,.token-card{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:15px 20px;border-bottom:1px solid #edf0f3}.user-card div,.token-card div{display:flex;flex-direction:column}.user-card span,.token-card span,.user-card small,.token-card small{color:#75808d;font-size:.78rem}.secret-box{background:#16212b;color:#fff;border-radius:15px;padding:18px 20px;margin-bottom:18px}.secret-box p{color:#b9c4ce;margin:4px 0 12px}.secret-box code{display:block;padding:12px;background:#0e171f;border-radius:9px;overflow-wrap:anywhere}.alert{padding:12px 14px;border-radius:11px;margin:0 0 18px;font-size:.9rem}.alert.success{background:#eaf8ef;border:1px solid #bfe5cc;color:#17683c}.alert.failure{background:#fff0ee;border:1px solid #f1c3bd;color:#98291f}.empty{text-align:center;padding:44px;grid-column:1/-1}.docs-panel{margin:0}.docs-content{padding:24px}.docs-content h2{margin-top:28px}.docs-content li{margin:8px 0}.endpoint-list{display:grid;grid-template-columns:190px 1fr;gap:10px 16px}.endpoint-list dd{margin:0;overflow-wrap:anywhere}.endpoint-list code,.docs-content code{background:#eef2f6;border-radius:6px;padding:2px 6px}.empty h2{margin-bottom:6px}.empty p{color:#75808d;margin:0}@media(max-width:800px){.topbar{height:auto;padding:13px 16px;flex-wrap:wrap;gap:10px}.topbar nav{order:3;width:100%;overflow:auto}.account>span{display:none}.shell{padding:30px 17px 60px}.stats{grid-template-columns:repeat(2,1fr)}.mailbox-grid,.split,.fields.two{grid-template-columns:1fr}.page-head{flex-direction:column}.callout{align-items:flex-start;flex-direction:column}}
`;
