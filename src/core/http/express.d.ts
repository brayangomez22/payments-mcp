import type { Logger } from '../logger.js';
import type { AuthContext } from '../auth/auth-context.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
      auth?: AuthContext;
    }
  }
}

export {};
