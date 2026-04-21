import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeParseResult, JobScreenshotParseError } from './jobScreenshotParser.js';

function createPayload(overrides: Partial<Parameters<typeof finalizeParseResult>[0]> = {}) {
  return {
    status: 'ok' as const,
    reason: 'Visible job posting details are readable.',
    confidence: 0.86,
    sourceHint: 'linkedin' as const,
    job: {
      title: 'Product Manager',
      company: 'Example Labs',
      location: null,
      employmentType: null,
      seniority: null,
      description:
        'Lead product discovery, coordinate delivery with engineering, analyze customer needs, and define measurable launch outcomes.',
      highlights: [],
    },
    missingFields: [],
    ...overrides,
  };
}

test('screenshot parser finalization treats location, seniority and employment type as optional', () => {
  const finalized = finalizeParseResult(
    createPayload({
      status: 'incomplete',
      missingFields: ['location', 'seniority', 'employmentType'],
    }),
    3,
  );

  assert.equal(finalized.status, 'ok');
  assert.equal(finalized.job.title, 'Product Manager');
  assert.equal(finalized.job.company, 'Example Labs');
  assert.equal(finalized.job.location, null);
  assert.deepEqual(finalized.missingFields, []);
});

test('screenshot parser finalization blocks when core fields are missing', () => {
  assert.throws(
    () =>
      finalizeParseResult(
        createPayload({
          job: {
            ...createPayload().job,
            title: null,
            company: null,
            description: 'Too short',
          },
        }),
        2,
      ),
    (error) => {
      assert.equal(error instanceof JobScreenshotParseError, true);
      assert.equal((error as JobScreenshotParseError).code, 'screenshot_incomplete_info');
      assert.deepEqual((error as JobScreenshotParseError).details.missingFields, [
        'title',
        'company',
        'description',
      ]);
      return true;
    },
  );
});
