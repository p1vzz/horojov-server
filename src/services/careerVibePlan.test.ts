import assert from 'node:assert/strict';
import test from 'node:test';
import type { DailyTransitVibeDoc } from '../db/mongo.js';
import {
  buildCareerVibePlanView,
  normalizeCareerVibePlanFromLlm,
  shouldReuseCachedCareerVibePlan,
  toMorningBriefingPlanSnapshot,
} from './careerVibePlan.js';

const transitVibe: DailyTransitVibeDoc = {
  algorithmVersion: 'daily-vibe-v2',
  title: 'Mercury in 10th House',
  modeLabel: 'High Execution Mode',
  summary: 'Transit Mercury in your 10th house favors focused career execution.',
  dominant: {
    planet: 'Mercury',
    sign: 'Virgo',
    house: 10,
    retrograde: false,
  },
  metrics: {
    energy: 82,
    focus: 79,
    luck: 71,
  },
  drivers: [
    'Mercury in 10th house amplifies high execution mode.',
    'Supportive aspects improve structured communication.',
  ],
  cautions: ['Maintain quality checkpoints so speed does not outrun validation.'],
  tags: [],
};

test('career vibe plan builder returns metrics without synthetic narrative copy', () => {
  const plan = buildCareerVibePlanView({
    dateKey: '2026-04-13',
    cached: false,
    tier: 'premium',
    generatedAt: new Date('2026-04-13T06:00:00.000Z'),
    staleAfter: new Date('2026-04-14T00:00:00.000Z'),
    transitVibe,
    aiSynergy: null,
    sources: {
      dailyTransitDateKey: '2026-04-13',
      aiSynergyDateKey: null,
      dailyVibeAlgorithmVersion: 'daily-vibe-v2',
      aiSynergyAlgorithmVersion: null,
    },
  });

  assert.equal(plan.schemaVersion, 'career-vibe-plan-v1');
  assert.equal(plan.narrativeSource, null);
  assert.equal(plan.narrativeStatus, 'pending');
  assert.equal(plan.plan, null);
  assert.equal(plan.metrics.opportunity, 71);
  assert.equal(plan.modeLabel, 'High Execution Mode');
  assert.equal(plan.explanation.metricNotes.length, 4);
});

test('career vibe plan normalizes valid llm payload and rejects sparse payloads', () => {
  const validPayload = {
    headline: 'Close the important loop',
    summary: 'Today works best when you turn one high-value priority into a finished, reviewed output before expanding your scope.',
    primaryAction: 'Finish one meaningful deliverable before opening a second workstream.',
    bestFor: ['Deep work', 'AI drafting', 'Stakeholder follow-up'],
    avoid: ['Accepting AI output without review', 'Letting pings break the main work block'],
    focusStrategy: 'Use the first protected block for the hardest output, then move admin work after the deliverable is closed.',
    communicationStrategy: 'Use the peak window for specific asks and follow-ups, especially where decisions need a clear next step.',
    aiWorkStrategy: 'Ask AI for structured drafts, alternatives, and review checklists, then run a final human approval pass.',
    riskGuardrail: 'Keep one review gate before external sharing so speed does not outrun accuracy.',
  };
  const valid = normalizeCareerVibePlanFromLlm(validPayload);

  assert.equal(valid?.headline, 'Close the important loop');
  assert.deepEqual(valid?.bestFor.slice(0, 2), ['Deep work', 'AI drafting']);

  assert.equal(normalizeCareerVibePlanFromLlm({ headline: 'Thin' }), null);
  assert.equal(normalizeCareerVibePlanFromLlm({ ...validPayload, summary: 'Too short for the dashboard card.' }), null);
  assert.equal(normalizeCareerVibePlanFromLlm({ ...validPayload, summary: 'A'.repeat(181) }), null);
});

test('career vibe plan snapshot keeps only widget-safe fields when narrative is ready', () => {
  const plan = buildCareerVibePlanView({
    dateKey: '2026-04-13',
    cached: false,
    tier: 'premium',
    generatedAt: new Date('2026-04-13T06:00:00.000Z'),
    staleAfter: new Date('2026-04-14T00:00:00.000Z'),
    transitVibe,
    aiSynergy: null,
    sources: {
      dailyTransitDateKey: '2026-04-13',
      aiSynergyDateKey: null,
      dailyVibeAlgorithmVersion: 'daily-vibe-v2',
      aiSynergyAlgorithmVersion: null,
    },
  });

  const readyPlan = {
    ...plan,
    narrativeSource: 'llm' as const,
    narrativeStatus: 'ready' as const,
    plan: {
      headline: 'Close the important loop',
      summary: 'Today works best when you turn one high-value priority into a finished output.',
      primaryAction: 'Finish one meaningful deliverable before opening a second workstream.',
      bestFor: ['Deep work', 'AI drafting'],
      avoid: ['Accepting output without review', 'Letting pings break the main block'],
      peakWindow: '10-12 PM',
      focusStrategy: 'Use the first protected block for the hardest output.',
      communicationStrategy: 'Use the peak window for specific asks and follow-ups.',
      aiWorkStrategy: 'Ask AI for structured drafts, alternatives, and review checklists.',
      riskGuardrail: 'Keep one review gate before external sharing.',
    },
  };

  const snapshot = toMorningBriefingPlanSnapshot(readyPlan);
  assert.ok(snapshot);
  assert.equal(snapshot.primaryAction, readyPlan.plan.primaryAction);
  assert.equal(snapshot.peakWindow, readyPlan.plan.peakWindow);
  assert.equal(Object.keys(snapshot).includes('bestFor'), false);
});

test('career vibe plan cache does not keep stale pending narrative forever', () => {
  const now = new Date('2026-04-13T10:01:30.000Z');

  assert.equal(
    shouldReuseCachedCareerVibePlan({
      doc: {
        narrativeStatus: 'pending',
        updatedAt: new Date('2026-04-13T10:01:00.000Z'),
      },
      llmAllowed: true,
      llmMode: 'background',
      now,
    }),
    true,
  );

  assert.equal(
    shouldReuseCachedCareerVibePlan({
      doc: {
        narrativeStatus: 'pending',
        updatedAt: new Date('2026-04-13T10:00:00.000Z'),
      },
      llmAllowed: true,
      llmMode: 'background',
      now,
    }),
    false,
  );

  assert.equal(
    shouldReuseCachedCareerVibePlan({
      doc: {
        narrativeStatus: 'pending',
        updatedAt: new Date('2026-04-13T10:01:00.000Z'),
      },
      llmAllowed: true,
      llmMode: 'sync',
      now,
    }),
    false,
  );

  assert.equal(
    shouldReuseCachedCareerVibePlan({
      doc: {
        narrativeStatus: 'failed',
        updatedAt: new Date('2026-04-13T10:00:00.000Z'),
      },
      llmAllowed: true,
      llmMode: 'background',
      now,
    }),
    true,
  );
});
