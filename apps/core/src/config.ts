import { z } from 'zod';

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
  ALERT_WEBHOOK_URL: z.url().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_CHANNEL: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}
