import { z } from 'zod';
import { env } from '../../config/env.js';

export const preflightSchema = z.object({
  url: z.string().trim().min(8).max(2048),
});

export const analyzeSchema = z.object({
  url: z.string().trim().min(8).max(2048),
  regenerate: z.coerce.boolean().default(false),
  scanDepth: z.enum(['auto', 'lite', 'full']).default('auto'),
});

export const analyzeScreenshotsSchema = z.object({
  screenshots: z
    .array(
      z.object({
        dataUrl: z.string().trim().min(64).max(12_000_000),
      }),
    )
    .min(1)
    .max(env.JOB_SCREENSHOT_MAX_IMAGES),
  regenerate: z.coerce.boolean().default(false),
});

export const metricsQuerySchema = z.object({
  windowHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .default(24),
});

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

const historyEntrySchema = z.object({
  url: z.string().trim().min(1).max(2048),
  analysis: z.record(z.string(), z.unknown()),
  meta: z.object({
    source: z.string().trim().min(1).max(64),
    cached: z.coerce.boolean().default(false),
    provider: z.string().trim().min(1).max(64).nullable().default(null),
  }),
  savedAt: z.string().trim().max(64).optional(),
});

export const historyImportSchema = z.object({
  entries: z.array(historyEntrySchema).min(1).max(16),
});
