import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndCanonicalizeJobUrl } from './jobUrl.js';

test('job url canonicalizes LinkedIn collection links with currentJobId', () => {
  const result = validateAndCanonicalizeJobUrl(
    'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4401382836'
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.source, 'linkedin');
  assert.equal(result.data.host, 'linkedin.com');
  assert.equal(result.data.sourceJobId, '4401382836');
  assert.equal(result.data.canonicalUrl, 'https://linkedin.com/jobs/view/4401382836');
});

test('job url canonicalizes LinkedIn jobs surfaces with currentJobId regardless of query order', () => {
  const result = validateAndCanonicalizeJobUrl(
    'https://linkedin.com/jobs/search/?keywords=designer&trk=public_jobs&currentJobId=4401382836'
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.data.sourceJobId, '4401382836');
  assert.equal(result.data.canonicalUrl, 'https://linkedin.com/jobs/view/4401382836');
});

test('job url rejects LinkedIn jobs surfaces without a concrete job id', () => {
  const result = validateAndCanonicalizeJobUrl('https://www.linkedin.com/jobs/collections/recommended/');

  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.code, 'unsupported_path');
});

test('job url rejects malformed LinkedIn currentJobId values', () => {
  const result = validateAndCanonicalizeJobUrl(
    'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=not-a-job'
  );

  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.code, 'unsupported_path');
});
