import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../config/env.js';
import {
  LlmStructuredCompletionError,
  requestStructuredCompletionWithFallback,
  resolveBackupModel,
} from './llmStructuredFallback.js';

const request = {
  feature: 'test feature',
  model: 'primary-model',
  promptVersion: 'v1',
  temperature: 0.2,
  maxTokens: 100,
  timeoutMs: 1000,
  jsonSchema: {
    name: 'test_schema',
    strict: true,
    schema: { type: 'object' },
  },
  messages: [{ role: 'user' as const, content: 'Generate JSON.' }],
};

test('structured fallback uses injected primary requester without requiring env API key', async () => {
  const result = await requestStructuredCompletionWithFallback({
    request,
    primaryEnabled: true,
    primaryRequester: async () => ({
      content: '{}',
      parsedContent: { ok: true },
      responseModel: 'primary-model',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    }),
  });

  assert.equal(result.provider, 'primary');
  assert.equal(result.model, 'primary-model');
  assert.deepEqual(result.completion.parsedContent, { ok: true });
});

test('structured fallback switches to backup requester when primary fails', async () => {
  let backupRouteCount = 0;

  const result = await requestStructuredCompletionWithFallback({
    request,
    primaryEnabled: true,
    primaryRequester: async () => {
      throw new Error('primary unavailable');
    },
    backupModel: 'backup-model',
    backupRequester: async (backupRequest) => ({
      content: '{}',
      parsedContent: { model: backupRequest.model },
      responseModel: 'backup-model',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    }),
    onBackupRoute: () => {
      backupRouteCount += 1;
    },
  });

  assert.equal(result.provider, 'backup');
  assert.equal(result.model, 'backup-model');
  assert.equal(result.usedBackup, true);
  assert.equal(backupRouteCount, 1);
  assert.deepEqual(result.completion.parsedContent, { model: 'backup-model' });
});

test('structured fallback fails explicitly when no provider is available', async () => {
  await assert.rejects(
    () =>
      requestStructuredCompletionWithFallback({
        request,
        primaryEnabled: false,
      }),
    (error: unknown) =>
      error instanceof LlmStructuredCompletionError &&
      error.code === 'llm_unavailable',
  );
});

test('structured fallback resolves feature-specific backup model overrides', () => {
  const originalDefault = env.LLM_BACKUP_MODEL;
  const originalCareerInsights = env.LLM_BACKUP_CAREER_INSIGHTS_MODEL;
  const originalScreenshot = env.LLM_BACKUP_JOB_SCREENSHOT_MODEL;

  try {
    env.LLM_BACKUP_MODEL = 'backup-default-model';
    env.LLM_BACKUP_CAREER_INSIGHTS_MODEL = 'backup-career-insights-model';
    env.LLM_BACKUP_JOB_SCREENSHOT_MODEL = undefined;

    assert.equal(resolveBackupModel('career_insights'), 'backup-career-insights-model');
    assert.equal(resolveBackupModel('job_screenshot'), 'backup-default-model');
  } finally {
    env.LLM_BACKUP_MODEL = originalDefault;
    env.LLM_BACKUP_CAREER_INSIGHTS_MODEL = originalCareerInsights;
    env.LLM_BACKUP_JOB_SCREENSHOT_MODEL = originalScreenshot;
  }
});
