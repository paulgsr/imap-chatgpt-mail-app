import type { SessionRecord, UserRecord } from "../domain.js";

declare global {
  namespace Express {
    interface Request {
      webSession?: SessionRecord;
      webUser?: UserRecord;
    }
  }
}

export {};
