import 'dotenv/config';
import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.string().min(1).optional()
);

const booleanTrueValues = new Set(['true', '1', 'yes', 'on']);
const booleanFalseValues = new Set(['false', '0', 'no', 'off']);

function parseEnvBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (booleanTrueValues.has(normalized)) return true;
  if (booleanFalseValues.has(normalized)) return false;
  return value;
}

const envBoolean = z.preprocess(parseEnvBoolean, z.boolean());

const optionalEnvBoolean = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return parseEnvBoolean(value);
}, z.boolean().optional());

const optionalEnvNumber = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.coerce.number().finite().nonnegative().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  APP_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_000_000).max(100_000_000).default(12_000_000),
  OPEN_METEO_BASE_URL: z.string().url().default('https://geocoding-api.open-meteo.com/v1'),
  CORS_ORIGINS: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.string().optional()
  ),
  ASTROLOGY_URL: z.string().url().default('https://json.astrologyapi.com/v1'),
  ASTROLOGY_USER_ID: optionalNonEmptyString,
  ASTROLOGY_API_KEY: optionalNonEmptyString,
  JOB_SCRAPER_HTTP_FIRST: envBoolean.default(true),
  JOB_SCRAPER_HTTP_TIMEOUT_MS: z.coerce.number().int().min(3000).max(120000).default(12000),
  JOB_SCRAPER_ENABLE_BROWSER_FALLBACK: envBoolean.default(true),
  JOB_SCRAPER_BROWSER_TIMEOUT_MS: z.coerce.number().int().min(5000).max(180000).default(30000),
  JOB_SCRAPER_BROWSER_MAX_CONCURRENCY_PER_SOURCE: z.coerce.number().int().min(1).max(8).default(2),
  JOB_SCRAPER_BROWSER_FALLBACK_SOURCES: z.string().default('glassdoor,indeed'),
  JOB_SCRAPER_LINKEDIN_PUBLIC_ONLY: envBoolean.default(true),
  JOB_SCRAPER_ENABLED_SOURCES: z.string().default('linkedin,wellfound,ziprecruiter,indeed,glassdoor'),
  JOB_SCRAPER_SOURCE_PRIORITY: z.string().default('linkedin,wellfound,ziprecruiter,indeed,glassdoor'),
  JOB_SCRAPER_STORE_RAW_HTML: envBoolean.default(true),
  JOB_SCRAPER_RAW_HTML_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  JOB_SCRAPER_NEGATIVE_TTL_BLOCKED_SECONDS: z.coerce.number().int().min(60).max(60 * 60 * 24 * 14).default(6 * 60 * 60),
  JOB_SCRAPER_NEGATIVE_TTL_LOGIN_WALL_SECONDS: z.coerce.number().int().min(60).max(60 * 60 * 24 * 14).default(6 * 60 * 60),
  JOB_SCRAPER_NEGATIVE_TTL_NOT_FOUND_SECONDS: z.coerce.number().int().min(60).max(60 * 60 * 24 * 30).default(24 * 60 * 60),
  JOB_SCREENSHOT_MAX_IMAGES: z.coerce.number().int().min(1).max(8).default(4),
  JOB_SCREENSHOT_MAX_IMAGE_BYTES: z.coerce.number().int().min(100_000).max(10_000_000).default(1_600_000),
  JOB_SCREENSHOT_MAX_TOTAL_BYTES: z.coerce.number().int().min(300_000).max(30_000_000).default(6_000_000),
  OPENAI_API_KEY: optionalNonEmptyString,
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  OPENAI_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(50).max(10_000).default(300),
  OPENAI_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(50).max(30_000).default(2_000),
  OPENAI_TELEMETRY_ENABLED: envBoolean.default(true),
  OPENAI_TELEMETRY_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(180),
  OPENAI_COST_INPUT_USD_PER_1M_TOKENS: optionalEnvNumber,
  OPENAI_COST_OUTPUT_USD_PER_1M_TOKENS: optionalEnvNumber,
  OPENAI_INSIGHTS_MODEL_FREE: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_INSIGHTS_MODEL_PREMIUM: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_INSIGHTS_PROMPT_VERSION: z.string().min(1).default('v2'),
  OPENAI_INSIGHTS_MAX_TOKENS_FREE: z.coerce.number().int().min(120).default(700),
  OPENAI_INSIGHTS_MAX_TOKENS_PREMIUM: z.coerce.number().int().min(180).default(1300),
  OPENAI_AI_SYNERGY_ENABLED: envBoolean.default(true),
  OPENAI_AI_SYNERGY_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_AI_SYNERGY_PROMPT_VERSION: z.string().min(1).default('v2'),
  OPENAI_AI_SYNERGY_MAX_TOKENS: z.coerce.number().int().min(120).default(420),
  OPENAI_AI_SYNERGY_TEMPERATURE: z.coerce.number().min(0).max(1.2).default(0.45),
  OPENAI_INTERVIEW_STRATEGY_ENABLED: envBoolean.default(true),
  OPENAI_INTERVIEW_STRATEGY_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_INTERVIEW_STRATEGY_PROMPT_VERSION: z.string().min(1).default('v1'),
  OPENAI_INTERVIEW_STRATEGY_MAX_TOKENS: z.coerce.number().int().min(80).default(260),
  OPENAI_INTERVIEW_STRATEGY_TEMPERATURE: z.coerce.number().min(0).max(1.2).default(0.55),
  OPENAI_FULL_NATAL_ANALYSIS_ENABLED: envBoolean.default(true),
  OPENAI_FULL_NATAL_ANALYSIS_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_FULL_NATAL_ANALYSIS_PROMPT_VERSION: z.string().min(1).default('v1'),
  OPENAI_FULL_NATAL_ANALYSIS_MAX_TOKENS: z.coerce.number().int().min(300).default(2200),
  OPENAI_FULL_NATAL_ANALYSIS_TEMPERATURE: z.coerce.number().min(0).max(1.2).default(0.45),
  OPENAI_JOB_SCREENSHOT_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_JOB_SCREENSHOT_PROMPT_VERSION: z.string().min(1).default('v1'),
  OPENAI_JOB_SCREENSHOT_MAX_TOKENS: z.coerce.number().int().min(150).default(900),
  JOB_CACHE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  JOB_USAGE_LIMITS_ENABLED: optionalEnvBoolean,
  REDIS_ENABLED: envBoolean.default(false),
  REDIS_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  REDIS_KEY_PREFIX: z.string().trim().min(1).max(120).default('horojob'),
  CACHE_JOB_METRICS_SNAPSHOT_ENABLED: envBoolean.default(true),
  CACHE_JOB_METRICS_SNAPSHOT_TTL_SECONDS: z.coerce.number().int().min(1).max(600).default(15),
  SCHEDULER_LOCKS_ENABLED: optionalEnvBoolean,
  SCHEDULER_LOCK_DAILY_TRANSIT_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(15 * 60),
  SCHEDULER_LOCK_JOB_METRICS_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(5 * 60),
  SCHEDULER_LOCK_BURNOUT_ALERTS_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(3 * 60),
  SCHEDULER_LOCK_INTERVIEW_STRATEGY_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(5 * 60),
  JOB_METRICS_ALERTS_ENABLED: envBoolean.default(true),
  JOB_METRICS_ALERT_WINDOW_HOURS: z.coerce.number().int().min(1).max(24 * 14).default(24),
  JOB_METRICS_ALERT_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(60 * 60).default(10 * 60),
  JOB_METRICS_ALERT_MIN_EVENTS: z.coerce.number().int().min(1).max(10_000).default(5),
  JOB_METRICS_ALERT_BLOCKED_RATE_PCT: z.coerce.number().min(0).max(100).default(20),
  JOB_METRICS_ALERT_BROWSER_FALLBACK_RATE_PCT: z.coerce.number().min(0).max(100).default(20),
  JOB_METRICS_ALERT_SUCCESS_RATE_MIN_PCT: z.coerce.number().min(0).max(100).default(60),
  BURNOUT_ALERTS_ENABLED: envBoolean.default(true),
  BURNOUT_ALERT_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(60 * 60).default(5 * 60),
  BURNOUT_ALERT_PLAN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  BURNOUT_ALERT_DISPATCH_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  BURNOUT_ALERT_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(55),
  BURNOUT_ALERT_SCHEDULE_DELAY_SECONDS: z.coerce.number().int().min(30).max(60 * 60 * 24).default(120),
  BURNOUT_ALERT_FORCE_SEVERITY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['warn', 'high', 'critical']).optional()
  ),
  INTERVIEW_STRATEGY_AUTOFILL_ENABLED: envBoolean.default(true),
  DAILY_TRANSIT_SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  INTERVIEW_STRATEGY_SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  INTERVIEW_STRATEGY_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(60 * 60 * 24).default(60 * 60 * 24),
  INTERVIEW_STRATEGY_INITIAL_HORIZON_DAYS: z.coerce.number().int().min(7).max(90).default(30),
  INTERVIEW_STRATEGY_REFILL_THRESHOLD_DAYS: z.coerce.number().int().min(1).max(45).default(14),
  INTERVIEW_STRATEGY_REFILL_DAYS: z.coerce.number().int().min(1).max(45).default(14),
  INTERVIEW_STRATEGY_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(55),
  INTERVIEW_STRATEGY_LLM_MAX_SLOTS: z.coerce.number().int().min(1).max(10).default(3),
  INTERVIEW_STRATEGY_LLM_MIN_GREEN_SLOTS: z.coerce.number().int().min(0).max(10).default(2),
  EXPO_PUSH_ACCESS_TOKEN: optionalNonEmptyString,
  EXPO_TOKEN: optionalNonEmptyString,
  MONGO_URI: optionalNonEmptyString,
  MONGODB_URI: optionalNonEmptyString,
  MONGO_DB_NAME: z.string().min(1).default('horojob'),
  DEV_FORCE_PREMIUM_FOR_ALL_USERS: optionalEnvBoolean,
  REVENUECAT_SECRET_API_KEY: optionalNonEmptyString,
  REVENUECAT_WEBHOOK_AUTH_TOKEN: optionalNonEmptyString,
  REVENUECAT_ENTITLEMENT_PREMIUM: z.string().min(1).default('premium'),
  REVENUECAT_API_BASE_URL: z.string().url().default('https://api.revenuecat.com/v1'),
  REVENUECAT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).default(60 * 60 * 24 * 180),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const issues = parsedEnv.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${issues}`);
}

const origins = (parsedEnv.data.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const toList = (input: string) =>
  input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

export const env = {
  ...parsedEnv.data,
  DEV_FORCE_PREMIUM_FOR_ALL_USERS:
    parsedEnv.data.DEV_FORCE_PREMIUM_FOR_ALL_USERS ?? parsedEnv.data.NODE_ENV === 'development',
  JOB_USAGE_LIMITS_ENABLED:
    parsedEnv.data.JOB_USAGE_LIMITS_ENABLED ?? parsedEnv.data.NODE_ENV !== 'development',
  SCHEDULER_LOCKS_ENABLED:
    parsedEnv.data.SCHEDULER_LOCKS_ENABLED ?? parsedEnv.data.NODE_ENV === 'production',
  EFFECTIVE_EXPO_PUSH_ACCESS_TOKEN: parsedEnv.data.EXPO_PUSH_ACCESS_TOKEN ?? parsedEnv.data.EXPO_TOKEN ?? '',
  EFFECTIVE_MONGO_URI: parsedEnv.data.MONGO_URI ?? parsedEnv.data.MONGODB_URI ?? '',
  CORS_ORIGINS_LIST: origins,
  JOB_SCRAPER_ENABLED_SOURCES_LIST: toList(parsedEnv.data.JOB_SCRAPER_ENABLED_SOURCES),
  JOB_SCRAPER_SOURCE_PRIORITY_LIST: toList(parsedEnv.data.JOB_SCRAPER_SOURCE_PRIORITY),
  JOB_SCRAPER_BROWSER_FALLBACK_SOURCES_LIST: toList(parsedEnv.data.JOB_SCRAPER_BROWSER_FALLBACK_SOURCES),
};
