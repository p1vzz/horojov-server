import type { FastifyBaseLogger } from 'fastify';
import type { Browser, BrowserContext } from 'playwright';
import { env } from '../config/env.js';
import type { SupportedJobSource } from './jobUrl.js';

type ContextEntry = {
  context: BrowserContext;
  createdAt: number;
  lastUsedAt: number;
};

const CONTEXT_TTL_MS = 15 * 60 * 1000;
const CONTEXT_POOL = new Map<SupportedJobSource, ContextEntry>();
const SOURCE_CONCURRENCY = new Map<SupportedJobSource, { active: number; waiters: Array<() => void> }>();

let browserPromise: Promise<Browser> | null = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      return chromium.launch({
        headless: true,
      });
    })();
  }
  return browserPromise;
}

async function runWithSourceConcurrency<T>(source: SupportedJobSource, task: () => Promise<T>): Promise<T> {
  const limit = env.JOB_SCRAPER_BROWSER_MAX_CONCURRENCY_PER_SOURCE;
  const entry = SOURCE_CONCURRENCY.get(source) ?? { active: 0, waiters: [] };
  SOURCE_CONCURRENCY.set(source, entry);

  if (entry.active >= limit) {
    await new Promise<void>((resolve) => {
      entry.waiters.push(resolve);
    });
  }
  entry.active += 1;
  try {
    return await task();
  } finally {
    entry.active = Math.max(0, entry.active - 1);
    const next = entry.waiters.shift();
    if (next) {
      next();
    } else if (entry.active === 0) {
      SOURCE_CONCURRENCY.delete(source);
    }
  }
}

async function getOrCreateContext(source: SupportedJobSource) {
  const browser = await getBrowser();
  const now = Date.now();
  const existing = CONTEXT_POOL.get(source);

  if (existing && now - existing.createdAt < CONTEXT_TTL_MS) {
    existing.lastUsedAt = now;
    return existing.context;
  }

  if (existing) {
    try {
      await existing.context.close();
    } catch {
      // ignore stale context close errors
    }
    CONTEXT_POOL.delete(source);
  }

  const context = await browser.newContext({
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });

  CONTEXT_POOL.set(source, {
    context,
    createdAt: now,
    lastUsedAt: now,
  });

  return context;
}

async function sourceSpecificWait(source: SupportedJobSource, page: import('playwright').Page) {
  switch (source) {
    case 'glassdoor':
      await page.waitForTimeout(2500);
      break;
    case 'indeed':
      await page.waitForTimeout(1400);
      break;
    case 'wellfound':
      await page.waitForTimeout(1200);
      break;
    default:
      await page.waitForTimeout(900);
      break;
  }
}

export async function fetchRenderedHtml(input: {
  source: SupportedJobSource;
  url: string;
  timeoutMs: number;
  log?: FastifyBaseLogger;
}) {
  try {
    return await runWithSourceConcurrency(input.source, async () => {
      const context = await getOrCreateContext(input.source);
      const page = await context.newPage();
      const startedAt = Date.now();

      try {
        const response = await page.goto(input.url, {
          waitUntil: 'domcontentloaded',
          timeout: input.timeoutMs,
        });

        await sourceSpecificWait(input.source, page);
        const html = await page.content();
        const title = await page.title();

        return {
          ok: true as const,
          html,
          statusCode: response?.status() ?? null,
          finalUrl: page.url(),
          title,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        await page.close();
      }
    });
  } catch (error) {
    input.log?.debug({ error, source: input.source }, 'browser fallback fetch failed');
    return {
      ok: false as const,
      statusCode: null,
      reason: error instanceof Error ? error.message : 'browser_fallback_failed',
    };
  }
}

export async function closeBrowserFallback() {
  for (const entry of CONTEXT_POOL.values()) {
    try {
      await entry.context.close();
    } catch {
      // ignore shutdown context close errors
    }
  }
  CONTEXT_POOL.clear();
  SOURCE_CONCURRENCY.clear();

  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    // ignore shutdown browser close errors
  } finally {
    browserPromise = null;
  }
}
