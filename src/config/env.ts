import * as v from 'valibot';

const NumberFromString = v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1));

const EnvSchema = v.object({
  NODE_ENV: v.optional(v.picklist(['development', 'test', 'production']), 'development'),
  PORT: v.optional(NumberFromString, '3000'),
  LOG_LEVEL: v.optional(v.picklist(['debug', 'info', 'warn', 'error', 'silent']), 'info'),
  DATABASE_URL: v.pipe(v.string(), v.url()),
  PROVIDER_TIMEOUT_MS: v.optional(NumberFromString, '5000'),
  /** How clients reach this service. Used for the issuer and the MCP resource identifier. */
  PUBLIC_BASE_URL: v.optional(v.pipe(v.string(), v.url()), 'http://localhost:3000'),
  /** Defaults to PUBLIC_BASE_URL: OAuth discovery requires the issuer to be the server's URL. */
  JWT_ISSUER: v.optional(v.string()),
  JWT_AUDIENCE: v.optional(v.string(), 'payments-api'),
  TOKEN_TTL_SECONDS: v.optional(NumberFromString, '900'),
  /** Private JWK as JSON. Omit in dev to use an ephemeral key. */
  JWT_PRIVATE_JWK: v.optional(v.string()),
  /** Queue for payment events. Omit to keep events in the outbox without publishing them. */
  SQS_QUEUE_URL: v.optional(v.pipe(v.string(), v.url())),
  /** The AWS SDK also reads AWS_ENDPOINT_URL (LocalStack) and the AWS_* credentials on its own. */
  AWS_REGION: v.optional(v.string(), 'us-east-1'),
  OUTBOX_POLL_MS: v.optional(NumberFromString, '1000'),
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
