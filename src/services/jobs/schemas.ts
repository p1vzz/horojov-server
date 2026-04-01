import { z } from 'zod';
import { env } from '../../config/env.js';

export const preflightSchema = z.object({
  url: z.string().trim().min(8).max(2048),
});

export const analyzeSchema = z.object({
  url: z.string().trim().min(8).max(2048),
  regenerate: z.coerce.boolean().default(false),
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
