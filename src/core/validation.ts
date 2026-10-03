import * as v from 'valibot';
import { Errors } from './errors.js';

export function parseOrThrow<const S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> {
  const result = v.safeParse(schema, input);
  if (!result.success) {
    throw Errors.validation(result.issues.map((i) => ({ path: v.getDotPath(i), message: i.message })));
  }
  return result.output;
}
