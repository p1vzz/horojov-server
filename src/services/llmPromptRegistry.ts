import { env } from '../config/env.js';
import type { InsightTier } from './careerInsights.js';

export type LlmPromptConfig = {
  feature: string;
  model: string;
  promptVersion: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
};

export function getCareerInsightsPromptConfig(tier: InsightTier): LlmPromptConfig {
  return {
    feature: 'career insights',
    model: tier === 'premium' ? env.OPENAI_INSIGHTS_MODEL_PREMIUM : env.OPENAI_INSIGHTS_MODEL_FREE,
    promptVersion: env.OPENAI_INSIGHTS_PROMPT_VERSION,
    temperature: tier === 'premium' ? 0.55 : 0.4,
    maxTokens:
      tier === 'premium' ? env.OPENAI_INSIGHTS_MAX_TOKENS_PREMIUM : env.OPENAI_INSIGHTS_MAX_TOKENS_FREE,
    timeoutMs: 25_000,
  };
}

export function getJobScreenshotPromptConfig(): LlmPromptConfig {
  return {
    feature: 'screenshot parse',
    model: env.OPENAI_JOB_SCREENSHOT_MODEL,
    promptVersion: env.OPENAI_JOB_SCREENSHOT_PROMPT_VERSION,
    temperature: 0.1,
    maxTokens: env.OPENAI_JOB_SCREENSHOT_MAX_TOKENS,
    timeoutMs: 40_000,
  };
}

export function getInterviewStrategyPromptConfig(): LlmPromptConfig {
  return {
    feature: 'interview strategy',
    model: env.OPENAI_INTERVIEW_STRATEGY_MODEL,
    promptVersion: env.OPENAI_INTERVIEW_STRATEGY_PROMPT_VERSION,
    temperature: env.OPENAI_INTERVIEW_STRATEGY_TEMPERATURE,
    maxTokens: env.OPENAI_INTERVIEW_STRATEGY_MAX_TOKENS,
    timeoutMs: 20_000,
  };
}

export function getFullNatalAnalysisPromptConfig(): LlmPromptConfig {
  return {
    feature: 'full natal analysis',
    model: env.OPENAI_FULL_NATAL_ANALYSIS_MODEL,
    promptVersion: env.OPENAI_FULL_NATAL_ANALYSIS_PROMPT_VERSION,
    temperature: env.OPENAI_FULL_NATAL_ANALYSIS_TEMPERATURE,
    maxTokens: env.OPENAI_FULL_NATAL_ANALYSIS_MAX_TOKENS,
    timeoutMs: 32_000,
  };
}

export function getAiSynergyPromptConfig(): LlmPromptConfig {
  return {
    feature: 'ai synergy',
    model: env.OPENAI_AI_SYNERGY_MODEL,
    promptVersion: env.OPENAI_AI_SYNERGY_PROMPT_VERSION,
    temperature: env.OPENAI_AI_SYNERGY_TEMPERATURE,
    maxTokens: env.OPENAI_AI_SYNERGY_MAX_TOKENS,
    timeoutMs: 22_000,
  };
}
