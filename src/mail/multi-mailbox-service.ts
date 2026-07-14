import type { AppConfig } from "../config.js";
import type {
  EmailDetail,
  EmailSummary,
  ForwardAttachment,
  MailboxRuntimeConfig,
  MultiMailboxSearchInput,
} from "../domain.js";
import type { AppLogger } from "../logger.js";
import { MessageIdCodec } from "../security/message-id-codec.js";
import type { MailboxService } from "../services/mailbox-service.js";
import type {
  EmailSearchResult,
  FolderListResult,
  MailboxOperationError,
  UserMailService,
} from "./user-mail-service.js";

export class MultiMailboxMailService implements UserMailService {
  constructor(
    private readonly config: AppConfig,
    private readonly mailboxService: MailboxService,
    private readonly codec: MessageIdCodec,
    private readonly logger: AppLogger,
  ) {}

  async listMailboxes(actorId: string) {
    return this.mailboxService.list(actorId);
  }

  async listFolders(actorId: string, mailboxIds?: string[]): Promise<FolderListResult> {
    const mailboxes = this.mailboxService.listRuntime(actorId, mailboxIds, "read");
    const results = await mapWithConcurrency(
      mailboxes,
      this.config.limits.maxParallelMailboxSearches,
      async (mailbox) => this.mailboxService.createMailService(mailbox).listFolders(),
    );
    const folders = results.flatMap((entry) => entry.ok ? entry.value : []);
    const errors = results.flatMap((entry, index) => entry.ok ? [] : [operationError(mailboxes[index], entry.error)]);
    return { folders, errors };
  }

  async searchEmails(actorId: string, input: MultiMailboxSearchInput): Promise<EmailSearchResult> {
    const mailboxes = this.mailboxService.listRuntime(actorId, input.mailboxIds, "read");
    const results = await mapWithConcurrency(
      mailboxes,
      this.config.limits.maxParallelMailboxSearches,
      async (mailbox) => this.mailboxService.createMailService(mailbox).searchEmails({
        folder: input.folder,
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.unread !== undefined ? { unread: input.unread } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.before ? { before: input.before } : {}),
      }),
    );
    const messages = results
      .flatMap((entry) => entry.ok ? entry.value : [])
      .sort((left, right) => (right.receivedAt ?? "").localeCompare(left.receivedAt ?? ""))
      .slice(0, input.limit);
    const errors = results.flatMap((entry, index) => entry.ok ? [] : [operationError(mailboxes[index], entry.error)]);
    return { messages, errors };
  }

  async getEmail(actorId: string, messageId: string): Promise<EmailDetail> {
    const mailbox = this.mailboxForMessage(actorId, messageId);
    return this.mailboxService.createMailService(mailbox).getEmail(messageId);
  }

  async getThread(actorId: string, messageId: string, limit: number): Promise<EmailDetail[]> {
    const mailbox = this.mailboxForMessage(actorId, messageId);
    return this.mailboxService.createMailService(mailbox).getThread(messageId, limit);
  }

  async loadForwardAttachments(actorId: string, messageId: string): Promise<ForwardAttachment[]> {
    const mailbox = this.mailboxForMessage(actorId, messageId);
    return this.mailboxService.createMailService(mailbox).loadForwardAttachments(messageId);
  }

  private mailboxForMessage(actorId: string, messageId: string): MailboxRuntimeConfig {
    const ref = this.codec.decode(messageId);
    return this.mailboxService.requireRuntime(actorId, ref.mailboxId, "read");
  }
}

interface Success<T> { ok: true; value: T }
interface Failure { ok: false; error: unknown }
type Settled<T> = Success<T> | Failure;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<Settled<R>[]> {
  const results: Settled<R>[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = { ok: true, value: await operation(item) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function operationError(mailbox: MailboxRuntimeConfig | undefined, error: unknown): MailboxOperationError {
  const message = error instanceof Error ? error.message : "Mailbox operation failed.";
  return {
    mailboxId: mailbox?.id ?? "unknown",
    mailboxAddress: mailbox?.emailAddress ?? "unknown",
    error: message.slice(0, 500),
  };
}
