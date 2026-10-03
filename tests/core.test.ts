import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadEnv } from '../src/config/env.js';
import { fingerprint, stableStringify } from '../src/core/idempotency/idempotency.js';
import { decodeCursor, encodeCursor } from '../src/features/payments/cursor.js';

describe('loadEnv', () => {
  it('applies defaults and coerces numbers', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    assert.equal(env.PORT, 3000);
    assert.equal(env.PROVIDER_TIMEOUT_MS, 5000);
    assert.equal(env.LOG_LEVEL, 'info');
  });

  it('fails fast on invalid configuration', () => {
    assert.throws(() => loadEnv({ PORT: 'abc' }), /Invalid environment: .*DATABASE_URL/);
  });
});

describe('idempotency fingerprint', () => {
  it('ignores key order and undefined values', () => {
    assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] }), '{"a":[1,{"d":2}],"b":1}');
    assert.equal(fingerprint('op', { a: 1, b: 2 }), fingerprint('op', { b: 2, a: 1 }));
  });

  it('differs per operation', () => {
    assert.notEqual(fingerprint('create', { a: 1 }), fingerprint('refund', { a: 1 }));
  });
});

describe('cursor', () => {
  it('round-trips', () => {
    const cursor = { createdAt: new Date('2026-10-01T10:00:00.123Z'), id: 'abc' };
    assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  });
});
