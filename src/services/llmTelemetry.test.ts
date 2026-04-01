import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLlmGatewayTelemetryDoc, estimateLlmCostUsd } from './llmTelemetry.js';

test('llm telemetry estimates cost when token rates are configured', () => {
  assert.deepEqual(
    estimateLlmCostUsd({
      usage: {
        promptTokens: 2_000,
        completionTokens: 500,
        totalTokens: 2_500,
      },
      inputUsdPer1MTokens: 0.15,
      outputUsdPer1MTokens: 0.6,
    }),
    {
      estimatedInputCostUsd: 0.0003,
      estimatedOutputCostUsd: 0.0003,
      estimatedTotalCostUsd: 0.0006,
    }
  );
});

test('llm telemetry returns null cost estimates when rates are not configured', () => {
  assert.deepEqual(
    estimateLlmCostUsd({
      usage: {
        promptTokens: 2_000,
        completionTokens: 500,
        totalTokens: 2_500,
      },
      inputUsdPer1MTokens: null,
      outputUsdPer1MTokens: null,
    }),
    {
      estimatedInputCostUsd: null,
      estimatedOutputCostUsd: null,
      estimatedTotalCostUsd: null,
    }
  );
});

test('llm telemetry builds success docs with usage and prompt metadata', () => {
  const doc = buildLlmGatewayTelemetryDoc(
    {
      event: 'llm_gateway_success',
      feature: 'career insights',
      schemaName: 'career_insights',
      model: 'gpt-4o-mini',
      promptVersion: 'v2',
      responseModel: 'gpt-4o-mini-2026-01-01',
      temperature: 0.4,
      maxTokens: 300,
      timeoutMs: 5000,
      messageCount: 2,
      attempts: 2,
      durationMs: 820,
      usage: {
        promptTokens: 800,
        completionTokens: 200,
        totalTokens: 1_000,
      },
    },
    new Date('2026-04-01T12:00:00.000Z')
  );

  assert.equal(doc.event, 'llm_gateway_success');
  assert.equal(doc.promptVersion, 'v2');
  assert.equal(doc.responseModel, 'gpt-4o-mini-2026-01-01');
  assert.equal(doc.attempts, 2);
  assert.equal(doc.failureStage, null);
  assert.equal(doc.usage.totalTokens, 1_000);
});

test('llm telemetry builds failure docs with null usage and failure details', () => {
  const doc = buildLlmGatewayTelemetryDoc(
    {
      event: 'llm_gateway_failure',
      feature: 'ai synergy',
      schemaName: 'ai_synergy_narrative',
      model: 'gpt-4o-mini',
      promptVersion: 'v2',
      temperature: 0.45,
      maxTokens: 420,
      timeoutMs: 5000,
      messageCount: 2,
      attempts: 3,
      durationMs: 1400,
      failureStage: 'upstream',
      upstreamStatus: 429,
      errorMessage: 'rate limited',
    },
    new Date('2026-04-01T12:00:00.000Z')
  );

  assert.equal(doc.event, 'llm_gateway_failure');
  assert.equal(doc.responseModel, null);
  assert.equal(doc.failureStage, 'upstream');
  assert.equal(doc.upstreamStatus, 429);
  assert.equal(doc.errorMessage, 'rate limited');
  assert.equal(doc.usage.totalTokens, null);
});
