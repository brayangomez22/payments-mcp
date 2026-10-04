import * as v from 'valibot';
import { Errors } from './errors.js';

/** `field` names the value in errors when it is not an object (a header, a path param). */
export function parseOrThrow<const S extends v.GenericSchema>(
  schema: S,
  input: unknown,
  field?: string,
): v.InferOutput<S> {
  const result = v.safeParse(schema, input);
  if (!result.success) {
    throw Errors.validation(
      result.issues.map((i) => ({ path: v.getDotPath(i) ?? field ?? null, message: i.message })),
    );
  }
  return result.output;
}
