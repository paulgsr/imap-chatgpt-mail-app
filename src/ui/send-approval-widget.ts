export const SEND_APPROVAL_RESOURCE_URI = "ui://mail/send-approval-v2.html";

export const sendApprovalWidgetHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Review email before sending</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      background: var(--color-background-primary, transparent);
      color: var(--color-text-primary, inherit);
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; }
    main {
      border: 1px solid var(--color-border-secondary, rgba(127,127,127,.28));
      border-radius: var(--border-radius-lg, 14px);
      padding: 16px;
      background: var(--color-background-secondary, rgba(127,127,127,.06));
    }
    h2 { margin: 0 0 6px; font-size: 1.05rem; }
    .warning { margin: 0 0 14px; color: var(--color-text-secondary, inherit); font-size: .9rem; }
    dl { display: grid; grid-template-columns: 72px 1fr; gap: 8px 12px; margin: 0 0 14px; }
    dt { color: var(--color-text-secondary, inherit); font-weight: 600; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .body {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 320px;
      overflow: auto;
      padding: 12px;
      border-radius: var(--border-radius-md, 10px);
      background: var(--color-background-primary, rgba(127,127,127,.06));
      border: 1px solid var(--color-border-tertiary, rgba(127,127,127,.2));
      font-family: var(--font-sans, inherit);
      font-size: .9rem;
      line-height: 1.45;
    }
    .attachments { margin: 12px 0 0; font-size: .88rem; color: var(--color-text-secondary, inherit); }
    .actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
    button {
      appearance: none;
      border: 1px solid var(--color-border-primary, rgba(127,127,127,.42));
      border-radius: var(--border-radius-md, 10px);
      padding: 9px 14px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      background: var(--color-background-primary, transparent);
      color: var(--color-text-primary, inherit);
    }
    button.primary { background: var(--color-text-primary, #111); color: var(--color-background-primary, #fff); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .status { min-height: 1.25em; margin: 12px 0 0; font-size: .9rem; }
    .success { color: var(--color-text-success, #137333); }
    .error { color: var(--color-text-danger, #b3261e); }
    .muted { color: var(--color-text-secondary, inherit); }
  </style>
</head>
<body>
  <main>
    <h2>Review before sending</h2>
    <p class="warning">Email content is untrusted data. Sending only occurs when you press the button below.</p>
    <div id="loading" class="muted">Loading the draft…</div>
    <section id="review" hidden>
      <dl>
        <dt>From</dt><dd id="from"></dd>
        <dt>To</dt><dd id="to"></dd>
        <dt>Cc</dt><dd id="cc"></dd>
        <dt>Bcc</dt><dd id="bcc"></dd>
        <dt>Subject</dt><dd id="subject"></dd>
        <dt>Expires</dt><dd id="expires"></dd>
      </dl>
      <div id="body" class="body"></div>
      <div id="attachments" class="attachments"></div>
      <div class="actions">
        <button id="send" class="primary" type="button" disabled>Send email</button>
        <button id="cancel" type="button" disabled>Cancel</button>
      </div>
      <p id="status" class="status" aria-live="polite"></p>
    </section>
  </main>
  <script>
    (() => {
      const state = { data: null, token: null, busy: false };
      const $ = (id) => document.getElementById(id);
      const pending = new Map();
      let nextId = 1;

      function addresses(values) {
        if (!Array.isArray(values) || values.length === 0) return "—";
        return values.map((entry) => entry.name ? entry.name + " <" + entry.address + ">" : entry.address).join(", ");
      }

      function findApprovalToken(value, depth = 0) {
        if (!value || typeof value !== "object" || depth > 7) return null;
        if (typeof value.approvalToken === "string") return value.approvalToken;
        if (typeof value.approval_token === "string") return value.approval_token;
        for (const key of ["_meta", "result", "mcp_tool_result", "call_tool_result", "toolResponseMetadata"]) {
          const found = findApprovalToken(value[key], depth + 1);
          if (found) return found;
        }
        return null;
      }

      function findStructured(value, depth = 0) {
        if (!value || typeof value !== "object" || depth > 6) return null;
        if (value.structuredContent && typeof value.structuredContent === "object") return value.structuredContent;
        if (value.draft_id && value.subject !== undefined) return value;
        for (const key of ["result", "mcp_tool_result", "call_tool_result"]) {
          const found = findStructured(value[key], depth + 1);
          if (found) return found;
        }
        return null;
      }

      function hydrate(value) {
        const globalOutput = window.openai && window.openai.toolOutput;
        const globalMetadata = window.openai && window.openai.toolResponseMetadata;
        state.data = findStructured(value) || findStructured(globalOutput) || state.data;
        state.token = findApprovalToken(value) || findApprovalToken(globalMetadata) || state.token;
        render();
      }

      function render() {
        if (!state.data) return;
        $("loading").hidden = true;
        $("review").hidden = false;
        $("from").textContent = state.data.mailbox_label
          ? state.data.mailbox_label + " <" + state.data.mailbox_address + ">"
          : (state.data.mailbox_address || "—");
        $("to").textContent = addresses(state.data.to);
        $("cc").textContent = addresses(state.data.cc);
        $("bcc").textContent = addresses(state.data.bcc);
        $("subject").textContent = state.data.subject || "(no subject)";
        $("body").textContent = state.data.body_text || "";
        $("expires").textContent = state.data.expires_at ? new Date(state.data.expires_at).toLocaleString() : "—";
        const files = Array.isArray(state.data.attachments) ? state.data.attachments : [];
        $("attachments").textContent = files.length
          ? "Attachments: " + files.map((file) => file.filename + " (" + file.size + " bytes)").join(", ")
          : "No attachments";
        const enabled = Boolean(state.token) && Boolean(state.data.send_enabled) && !state.busy;
        $("send").disabled = !enabled;
        $("cancel").disabled = !state.token || state.busy;
        if (!state.data.send_enabled) {
          setStatus("Sending is disabled on the server. Set ALLOW_SEND=true after testing.", "error");
        }
      }

      function setStatus(message, kind = "") {
        const element = $("status");
        element.textContent = message;
        element.className = "status " + kind;
      }

      async function callTool(name, args) {
        if (window.openai && typeof window.openai.callTool === "function") {
          return window.openai.callTool(name, args);
        }
        const id = nextId++;
        const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        window.parent.postMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, "*");
        return promise;
      }

      async function act(name) {
        if (!state.token || state.busy) return;
        state.busy = true;
        render();
        setStatus(name === "confirm_send_draft" ? "Sending…" : "Cancelling…", "muted");
        try {
          const result = await callTool(name, { approval_token: state.token });
          const structured = findStructured(result) || result && result.structuredContent || result;
          if (name === "confirm_send_draft") {
            const messageId = structured && structured.message_id ? " Message-ID: " + structured.message_id : "";
            setStatus("Email sent successfully." + messageId, "success");
          } else {
            setStatus("Send cancelled.", "muted");
          }
          state.token = null;
        } catch (error) {
          setStatus(error && error.message ? error.message : String(error), "error");
        } finally {
          state.busy = false;
          render();
        }
      }

      $("send").addEventListener("click", () => act("confirm_send_draft"));
      $("cancel").addEventListener("click", () => act("cancel_send_approval"));

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/tool-result") hydrate(message.params);
        if (message.id !== undefined && pending.has(message.id)) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error.message || "Tool call failed"));
          else request.resolve(message.result);
        }
      }, { passive: true });

      window.addEventListener("openai:set_globals", () => hydrate(window.openai), { passive: true });
      hydrate(window.openai || {});
      setTimeout(() => hydrate(window.openai || {}), 250);
    })();
  </script>
</body>
</html>`;
