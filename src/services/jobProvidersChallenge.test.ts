import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../config/env.js';
import { fetchJobWithProviderFallback, isLikelyChallengeHtml, isLikelyChallengeJobPayload } from './jobProviders.js';

test('detects Cloudflare challenge html with Just a moment markers', () => {
  const html = `
    <html>
      <head><title>Just a moment...</title></head>
      <body>
        <h1>Checking if the site connection is secure</h1>
        <div data-ray="test">Ray ID: 1234abcd</div>
        <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
      </body>
    </html>
  `;

  assert.equal(isLikelyChallengeHtml(html), true);
});

test('does not detect normal vacancy html as challenge', () => {
  const html = `
    <html>
      <head><title>Software Engineer - Mercor | Glassdoor</title></head>
      <body>
        <h1>Software Engineer</h1>
        <p>Build APIs, collaborate with product, own delivery quality and observability.</p>
      </body>
    </html>
  `;

  assert.equal(isLikelyChallengeHtml(html), false);
});

test('detects cached normalized challenge payloads', () => {
  const payload = {
    title: 'Just a moment...',
    description:
      'Please wait while we verify you are human. Enable JavaScript and cookies to continue. cf-ray: 1234',
  };

  assert.equal(isLikelyChallengeJobPayload(payload), true);
});

test('detects Security | Glassdoor challenge-like payload title', () => {
  const payload = {
    title: 'Security | Glassdoor',
    description:
      'Security check in progress. Please enable JavaScript and cookies to continue while we validate your request.',
  };

  assert.equal(isLikelyChallengeJobPayload(payload), true);
});

test('does not mark a normal normalized vacancy payload as challenge', () => {
  const payload = {
    title: 'Senior Backend Engineer',
    description:
      'Design distributed services, improve reliability, and mentor peers across API platform teams.',
  };

  assert.equal(isLikelyChallengeJobPayload(payload), false);
});

test('does not treat challenge html as successful vacancy payload', async () => {
  const originalFetch = globalThis.fetch;
  const originalBrowserFallbackFlag = env.JOB_SCRAPER_ENABLE_BROWSER_FALLBACK;
  const challengeHtml = `
    <html>
      <head><title>Security | Glassdoor</title></head>
      <body>
        <h1>Checking if the site connection is secure</h1>
        <p>Please enable JavaScript and cookies to continue.</p>
        <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
      </body>
    </html>
  `;

  env.JOB_SCRAPER_ENABLE_BROWSER_FALLBACK = false;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => challengeHtml,
    }) as unknown as Response) as typeof fetch;

  try {
    const result = await fetchJobWithProviderFallback({
      canonical: {
        source: 'glassdoor',
        normalizedUrl: 'https://glassdoor.com/job-listing?jl=101',
        canonicalUrl: 'https://glassdoor.com/job-listing?jl=101',
        canonicalUrlHash: 'test-hash',
        host: 'glassdoor.com',
        sourceJobId: '101',
        routing: {
          primary: 'http_fetch',
          fallback: 'browser_fallback',
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts[0]?.ok, false);
    assert.equal(result.attempts[0]?.statusCode, 200);
    const responseClass = (result.attempts[0]?.meta as { responseClass?: string } | undefined)?.responseClass;
    assert.ok(responseClass === 'captcha' || responseClass === 'empty');
  } finally {
    globalThis.fetch = originalFetch;
    env.JOB_SCRAPER_ENABLE_BROWSER_FALLBACK = originalBrowserFallbackFlag;
  }
});
