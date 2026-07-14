import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { CredentialCipher } from "../security/credential-cipher.js";
import { MessageIdCodec } from "../security/message-id-codec.js";
import { MailboxService } from "../services/mailbox-service.js";
import { SqliteStore } from "../storage/sqlite-store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const store = new SqliteStore(config.databasePath);
  store.initialize();
  try {
    const email = process.argv[2]?.trim().toLowerCase();
    const user = email ? store.findUserByEmail(email) : store.getFirstActiveUser();
    if (!user) throw new Error("No active user was found. Pass a user email after -- or create an account in the web interface.");
    const service = new MailboxService(
      config,
      store,
      new CredentialCipher(config.credentialEncryptionKey),
      new MessageIdCodec(config.idSigningSecret),
      logger,
    );
    const mailboxes = service.list(user.id);
    if (!mailboxes.length) throw new Error(`No mailboxes are configured for ${user.email}.`);
    let failures = 0;
    for (const mailbox of mailboxes) {
      try {
        await service.testConnections(user.id, mailbox.id);
        console.log(`OK   ${mailbox.emailAddress} (IMAP and SMTP)`);
      } catch (error) {
        failures += 1;
        console.error(`FAIL ${mailbox.emailAddress}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures) process.exitCode = 1;
  } finally {
    store.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
