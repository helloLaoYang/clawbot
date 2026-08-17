import { z } from "zod";

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const schema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("./data/clawbot.sqlite"),
  OPENAI_BASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  ADMIN_TOKEN: z.string().min(8),
  WEBHOOK_TOKEN: z.string().min(8).optional(),
  APP_ENCRYPTION_KEY: z.string().min(1),
  CONTEXT_WINDOW_TOKENS: positiveInt(32_000),
  CONTEXT_COMPACT_RATIO: z.coerce.number().gt(0).lt(1).default(0.7),
  CONTEXT_KEEP_MESSAGES: positiveInt(20),
  CONTEXT_SUMMARY_MAX_TOKENS: positiveInt(1_500),
  CONTEXT_IMAGE_TOKENS: positiveInt(2_000),
  MAX_CONCURRENT_USERS: positiveInt(4),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const parsed = result.data;
  const key = Buffer.from(parsed.APP_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64");
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    openai: {
      baseURL: parsed.OPENAI_BASE_URL.replace(/\/$/, ""),
      apiKey: parsed.OPENAI_API_KEY,
      model: parsed.OPENAI_MODEL,
    },
    adminToken: parsed.ADMIN_TOKEN,
    webhookToken: parsed.WEBHOOK_TOKEN ?? parsed.ADMIN_TOKEN,
    encryptionKey: key,
    context: {
      windowTokens: parsed.CONTEXT_WINDOW_TOKENS,
      compactRatio: parsed.CONTEXT_COMPACT_RATIO,
      keepMessages: parsed.CONTEXT_KEEP_MESSAGES,
      summaryMaxTokens: parsed.CONTEXT_SUMMARY_MAX_TOKENS,
      imageTokens: parsed.CONTEXT_IMAGE_TOKENS,
    },
    maxConcurrentUsers: parsed.MAX_CONCURRENT_USERS,
  };
}
