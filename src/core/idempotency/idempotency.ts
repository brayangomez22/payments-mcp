import { createHash } from 'node:crypto';
import { Errors } from '../errors.js';

export interface IdempotencyScope {
  merchantId: string;
  key: string;
  /** Hash of operation + input: same key with a different request must be rejected. */
  fingerprint: string;
}

export type BeginResult =
  | { state: 'new' }
  | { state: 'replay'; response: unknown }
  | { state: 'in_progress' }
  | { state: 'mismatch' };

/** Port. Postgres today; DynamoDB with TTL is a drop-in alternative. */
export interface IdempotencyStore {
  begin(scope: IdempotencyScope): Promise<BeginResult>;
  complete(scope: IdempotencyScope, response: unknown): Promise<void>;
  release(scope: IdempotencyScope): Promise<void>;
}

export function fingerprint(operation: string, input: unknown): string {
  return createHash('sha256').update(stableStringify({ operation, input })).digest('hex');
}

/**
 * Runs `operation` at most once per (merchant, key). The stored response must be JSON-safe,
 * which is why services return views rather than domain objects.
 */
export async function runIdempotent<T>(
  store: IdempotencyStore,
  scope: IdempotencyScope,
  operation: () => Promise<T>,
): Promise<T> {
  const begun = await store.begin(scope);
  switch (begun.state) {
    case 'replay':
      return begun.response as T;
    case 'in_progress':
      throw Errors.requestInProgress();
    case 'mismatch':
      throw Errors.idempotencyKeyReused();
    case 'new':
      break;
  }

  let result: T;
  try {
    result = await operation();
  } catch (err) {
    // Nothing durable happened (or it was rolled back): let the client retry with the same key.
    await store.release(scope).catch(() => undefined);
    throw err;
  }
  await store.complete(scope, result);
  return result;
}

/** JSON.stringify with sorted keys, so {a,b} and {b,a} hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
