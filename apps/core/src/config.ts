import { z } from 'zod';

/** docker compose interpolates unset vars to '' — treat that as absent. */
const blankAsAbsent = (value: unknown): unknown => (value === '' ? undefined : value);

/**
 * A boolean from env, tolerant of common spellings, defaulting when absent.
 * Deliberately NOT z.coerce.boolean(), which treats the string "false" as true.
 */
const envBool = (def: boolean) =>
  z
    .preprocess(
      (v) => {
        if (v === '' || v === undefined) return undefined;
        return typeof v === 'string' ? v.toLowerCase() : v;
      },
      z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional(),
    )
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1' || v === 'yes'));

/** All config from env, Zod-validated (§5). Secrets never come from code. */
const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://tremurex:tremurex@localhost:5432/tremurex'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SCHEMA_ENGINE_URL: z.string().default('http://localhost:8000'),
  CORE_PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.string().default('info'),
  /** Default alert threshold for new dependencies; per-dependency overrides. */
  ALERT_THRESHOLD: z.enum(['BREAKING', 'WARNING', 'INFO']).default('WARNING'),
  /** Alert destinations — user-configured only (§7.1). Absent = channel off. */
  ALERT_WEBHOOK_URL: z.preprocess(blankAsAbsent, z.url().optional()),
  SLACK_BOT_TOKEN: z.preprocess(blankAsAbsent, z.string().optional()),
  SLACK_CHANNEL: z.preprocess(blankAsAbsent, z.string().optional()),
  /**
   * SMTP email alerts. The channel is active only when SMTP_HOST,
   * ALERT_EMAIL_FROM, and ALERT_EMAIL_TO are all set. User/pass are optional
   * (some relays accept unauthenticated mail); secure=true for port 465.
   */
  SMTP_HOST: z.preprocess(blankAsAbsent, z.string().optional()),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: envBool(false),
  SMTP_USER: z.preprocess(blankAsAbsent, z.string().optional()),
  SMTP_PASS: z.preprocess(blankAsAbsent, z.string().optional()),
  ALERT_EMAIL_FROM: z.preprocess(blankAsAbsent, z.string().optional()),
  /** One or more recipients; a comma-separated list is allowed. */
  ALERT_EMAIL_TO: z.preprocess(blankAsAbsent, z.string().optional()),
  /**
   * Optional bearer token gating the REST API. Absent = no auth (the documented
   * zero-config default). Min length keeps a token from being trivially guessable.
   */
  TREMUREX_API_TOKEN: z.preprocess(blankAsAbsent, z.string().min(16).optional()),
  /**
   * Comma-separated CORS allow-list for the browser UI. Absent = the local web
   * UI defaults (see index.ts). A bare '*' restores reflect-any (not advised).
   */
  TREMUREX_ALLOWED_ORIGINS: z.preprocess(blankAsAbsent, z.string().optional()),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}
