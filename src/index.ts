import { loadConfig } from "./config.js";
import { createHttpApp } from "./http/app.js";
import { createLogger } from "./logger.js";
import { MultiMailboxMailService } from "./mail/multi-mailbox-service.js";
import { ApprovalService } from "./security/approval-service.js";
import { CredentialCipher } from "./security/credential-cipher.js";
import { MessageIdCodec } from "./security/message-id-codec.js";
import { DraftServiceImpl } from "./services/draft-service-impl.js";
import { MailboxService } from "./services/mailbox-service.js";
import { SqliteStore } from "./storage/sqlite-store.js";
import { WebSessionAuth } from "./web/session-auth.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const store = new SqliteStore(config.databasePath);
  store.initialize();

  const codec = new MessageIdCodec(config.idSigningSecret);
  const cipher = new CredentialCipher(config.credentialEncryptionKey);
  const mailboxService = new MailboxService(config, store, cipher, codec, logger);
  const mailService = new MultiMailboxMailService(config, mailboxService, codec, logger);
  const approvals = new ApprovalService(store, config);
  const draftService = new DraftServiceImpl(
    config,
    store,
    mailboxService,
    mailService,
    codec,
    approvals,
    logger,
  );
  const sessions = new WebSessionAuth(config, store);
  const app = createHttpApp({ config, logger, store, mailboxService, sessions, mailService, draftService });

  const httpServer = app.listen(config.port, config.bindHost, () => {
    logger.info({
      bindHost: config.bindHost,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      authMode: config.auth.mode,
      sendingEnabled: config.allowSend,
      users: store.countUsers(),
      databasePath: config.databasePath,
    }, "IMAP ChatGPT multi-user mail app is listening");
    if (store.countUsers() === 0) {
      logger.warn({ setupUrl: `${config.publicBaseUrl}/setup` }, "No users exist. Create the first administrator account");
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    httpServer.close((error) => {
      if (error) {
        logger.error({ error }, "HTTP shutdown failed");
        process.exitCode = 1;
      }
      store.close();
    });
    setTimeout(() => {
      logger.warn("Forcing process exit after shutdown grace period");
      process.exit(1);
    }, 10_000).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
