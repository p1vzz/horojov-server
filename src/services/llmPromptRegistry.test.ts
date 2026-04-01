import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAiSynergyPromptConfig,
  getCareerInsightsPromptConfig,
  getFullNatalAnalysisPromptConfig,
  getInterviewStrategyPromptConfig,
  getJobScreenshotPromptConfig,
} from './llmPromptRegistry.js';

test('llm prompt registry returns stable service configs', () => {
  assert.equal(getCareerInsightsPromptConfig('free').feature, 'career insights');
  assert.equal(getCareerInsightsPromptConfig('premium').promptVersion.length > 0, true);
  assert.equal(getJobScreenshotPromptConfig().feature, 'screenshot parse');
  assert.equal(getInterviewStrategyPromptConfig().timeoutMs, 20_000);
  assert.equal(getFullNatalAnalysisPromptConfig().timeoutMs, 32_000);
  assert.equal(getAiSynergyPromptConfig().timeoutMs, 22_000);
});
