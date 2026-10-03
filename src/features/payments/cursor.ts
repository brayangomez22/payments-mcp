import { Errors } from '../../core/errors.js';
import type { Cursor } from './payment.types.js';

// Opaque to clients: they must not build or depend on its shape.
export function encodeCursor({ createdAt, id }: Cursor): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  const [iso, id, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || rest.length > 0 || Number.isNaN(createdAt.getTime())) throw Errors.invalidCursor();
  return { createdAt, id };
}
