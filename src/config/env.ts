import * as v from 'valibot';

const NumberFromString = v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1));

const EnvSchema = v.object({
  NODE_ENV: v.optional(v.picklist(['development', 'test', 'production']), 'development'),
  PORT: v.optional(NumberFromString, '3000'),
  LOG_LEVEL: v.optional(v.picklist(['debug', 'info', 'warn', 'error', 'silent']), 'info'),
  DATABASE_URL: v.pipe(v.string(), v.url()),
  PROVIDER_TIMEOUT_MS: v.optional(NumberFromString, '5000'),
});

export type Env = v.InferOutput<typeof EnvSchema>;

/** Fails fast at boot: a misconfigured pod should crash, not serve traffic. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = v.safeParse(EnvSchema, source);
  if (!result.success) {
    const issues = result.issues.map((i) => `${v.getDotPath(i) ?? '?'}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.output;
}
