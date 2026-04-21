import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../config/env.js';
import { analyzeScreenshotsSchema } from './jobs/schemas.js';

function createScreenshots(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    dataUrl: `data:image/png;base64,${'a'.repeat(80 + index)}`,
  }));
}

test('job screenshot upload contract accepts six images and rejects one above the configured cap', () => {
  assert.equal(env.JOB_SCREENSHOT_MAX_IMAGES >= 6, true);

  const sixScreenshots = analyzeScreenshotsSchema.safeParse({
    screenshots: createScreenshots(6),
  });
  assert.equal(sixScreenshots.success, true);

  const aboveConfiguredCap = analyzeScreenshotsSchema.safeParse({
    screenshots: createScreenshots(env.JOB_SCREENSHOT_MAX_IMAGES + 1),
  });
  assert.equal(aboveConfiguredCap.success, false);
});
