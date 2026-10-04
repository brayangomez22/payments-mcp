import type { Scope } from '../../core/auth/auth-context.js';

export interface OAuthClient {
  clientId: string;
  /** Output of hashSecret(); the plain secret is never stored. */
  secretHash: string;
  merchantId: string;
  allowedScopes: readonly Scope[];
}

/** Port. In production: a database table or a secrets manager, not source code. */
export interface ClientRegistry {
  find(clientId: string): Promise<OAuthClient | null>;
}

export class InMemoryClientRegistry implements ClientRegistry {
  private readonly clients: Map<string, OAuthClient>;

  constructor(clients: readonly OAuthClient[]) {
    this.clients = new Map(clients.map((c) => [c.clientId, c]));
  }

  async find(clientId: string): Promise<OAuthClient | null> {
    return this.clients.get(clientId) ?? null;
  }
}

/**
 * DEVELOPMENT ONLY. Plain secrets (for api.http and tests):
 *   tienda-a-backend → dev-secret-tienda-a
 *   tienda-a-agent   → dev-secret-agent-a
 *   tienda-b-backend → dev-secret-tienda-b
 */
export const DEV_CLIENTS: readonly OAuthClient[] = [
  {
    clientId: 'tienda-a-backend',
    secretHash: 'scrypt$Rm_0esEjGuCKwuutVohe8Q$0NsS_3bHgUFrgj8gFMiW0nkU7JVQ42oGnqZDrNENj1Q',
    merchantId: 'tienda_A',
    allowedScopes: ['payments:read', 'payments:write', 'payments:refund'],
  },
  {
    // An AI agent: can charge and look up payments, but cannot move money back.
    clientId: 'tienda-a-agent',
    secretHash: 'scrypt$-IXCcak3cxEO9Kd6ODpzGQ$5wUZEGux4_cmepW9605rrR1j2I9jlVxGfpuSBe29Biw',
    merchantId: 'tienda_A',
    allowedScopes: ['payments:read', 'payments:write'],
  },
  {
    clientId: 'tienda-b-backend',
    secretHash: 'scrypt$CbdvsqOMW81Npy4gsIT4ZQ$cqWM_NV-vbfM_ak6u8zaQC-whQjYQffidibS5VeNa4k',
    merchantId: 'tienda_B',
    allowedScopes: ['payments:read', 'payments:write', 'payments:refund'],
  },
];
