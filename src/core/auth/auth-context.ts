export type Scope = 'payments:read' | 'payments:write' | 'payments:refund';

/** Who is calling. merchantId always comes from here, never from the request body or an LLM. */
export interface AuthContext {
  clientId: string;
  merchantId: string;
  scopes: ReadonlySet<Scope>;
}
