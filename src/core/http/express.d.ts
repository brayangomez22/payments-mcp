import type { Logger } from '../logger.js';
import type { AuthContext } from '../auth/auth-context.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
      /** Verified caller. Not `auth`: the MCP SDK reserves req.auth for its own AuthInfo type. */
      caller?: AuthContext;
    }
  }
}

export {};
