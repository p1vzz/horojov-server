import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import type { LunarProductivitySettingsDoc } from '../db/mongo.js';
import {
  LUNAR_PRODUCTIVITY_SAMPLE_LOCAL_HOURS,
  computeLunarScheduleFromPredictedEventMinute,
  computeLunarScheduleFromPredictedDipMinute,
  resolveLunarPredictedWindowLocalMinute,
  resolveLunarPredictedDipLocalMinute,
  shouldStartLunarProductivityScheduler,
} from './lunarProductivityScheduler.js';
import {
  resolveLunarProductivityImpactDirection,
  type LunarProductivityTimingSignals,
} from './lunarProductivity.js';

function createSettings(overrides?: Partial<LunarProductivitySettingsDoc>): LunarProductivitySettingsDoc {
  const now = new Date('2026-04-10T00:00:00.000Z');
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    enabled: true,
    timezoneIana: 'UTC',
    workdayStartMinute: 540,
    workdayEndMinute: 1080,
    quietHoursStartMinute: 1290,
    quietHoursEndMinute: 480,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTimingSignals(overrides?: Partial<LunarProductivityTimingSignals>): LunarProductivityTimingSignals {
  return {
    moonPhase: 'full_moon',
    illuminationPercent: 96,
    moonHouse: 10,
    moonHardCount: 2.4,
    moonSaturnHard: 0.8,
    moonMercuryHard: 0.5,
    supportiveAspectStrength: 12,
    momentum: {
      energy: 8,
      focus: -4,
    },
    ...overrides,
  };
}

test('resolveLunarPredictedDipLocalMinute picks one sampled hour and adds a 20 minute dip offset', () => {
  const result = resolveLunarPredictedDipLocalMinute({
    riskScore: 78,
    settings: createSettings(),
    timingSignals: createTimingSignals(),
  });

  assert.ok(LUNAR_PRODUCTIVITY_SAMPLE_LOCAL_HOURS.some((hour) => hour === result.dipHour));
  assert.equal(result.predictedDipMinute, result.dipHour * 60 + 20);
  assert.equal(result.hourlyScores.length, LUNAR_PRODUCTIVITY_SAMPLE_LOCAL_HOURS.length);
});

test('resolveLunarProductivityImpactDirection triggers only on extreme low and high scores', () => {
  assert.equal(resolveLunarProductivityImpactDirection(25), 'supportive');
  assert.equal(resolveLunarProductivityImpactDirection(26), null);
  assert.equal(resolveLunarProductivityImpactDirection(79), null);
  assert.equal(resolveLunarProductivityImpactDirection(80), 'disruptive');
});

test('resolveLunarPredictedWindowLocalMinute uses the calmest slot for supportive windows', () => {
  const result = resolveLunarPredictedWindowLocalMinute({
    riskScore: 18,
    settings: createSettings(),
    timingSignals: createTimingSignals(),
    impactDirection: 'supportive',
  });

  const selectedScore = result.hourlyScores.find((candidate) => candidate.hour === result.hour)?.score;
  const minimumScore = Math.min(...result.hourlyScores.map((candidate) => candidate.score));

  assert.equal(selectedScore, minimumScore);
  assert.equal(result.predictedEventMinute, result.hour * 60 + 20);
});

test('computeLunarScheduleFromPredictedDipMinute clamps early candidates up to the workday start', () => {
  const result = computeLunarScheduleFromPredictedEventMinute({
    now: new Date('2026-04-10T06:00:00.000Z'),
    settings: createSettings(),
    severity: 'warn',
    predictedEventMinute: 9 * 60 + 20,
  });

  assert.equal(result.status, 'planned');
  assert.equal(result.dateKey, '2026-04-10');
  if (result.status === 'planned') {
    assert.equal(result.scheduledAt.toISOString(), '2026-04-10T09:00:00.000Z');
    assert.equal(result.predictedDipAt.toISOString(), '2026-04-10T09:20:00.000Z');
  }
});

test('computeLunarScheduleFromPredictedDipMinute moves candidates out of quiet hours before scheduling', () => {
  const result = computeLunarScheduleFromPredictedEventMinute({
    now: new Date('2026-04-10T10:00:00.000Z'),
    settings: createSettings({
      quietHoursStartMinute: 14 * 60,
      quietHoursEndMinute: 14 * 60 + 30,
    }),
    severity: 'high',
    predictedEventMinute: 15 * 60 + 20,
  });

  assert.equal(result.status, 'planned');
  if (result.status === 'planned') {
    assert.equal(result.scheduledAt.toISOString(), '2026-04-10T14:45:00.000Z');
    assert.equal(result.predictedDipAt.toISOString(), '2026-04-10T15:20:00.000Z');
  }
});

test('computeLunarScheduleFromPredictedDipMinute skips when the minimum lead window is already gone', () => {
  const result = computeLunarScheduleFromPredictedEventMinute({
    now: new Date('2026-04-10T11:12:00.000Z'),
    settings: createSettings(),
    severity: 'high',
    predictedEventMinute: 11 * 60 + 20,
  });

  assert.equal(result.status, 'skip');
  if (result.status === 'skip') {
    assert.equal(result.reason, 'minimum schedule window is later than allowed lead');
    assert.equal(result.predictedDipAt.toISOString(), '2026-04-10T11:20:00.000Z');
  }
});

test('computeLunarScheduleFromPredictedDipMinute remains backward-compatible for dip callers', () => {
  const result = computeLunarScheduleFromPredictedDipMinute({
    now: new Date('2026-04-10T06:00:00.000Z'),
    settings: createSettings(),
    severity: 'warn',
    predictedDipMinute: 9 * 60 + 20,
  });

  assert.equal(result.status, 'planned');
});

test('computeLunarScheduleFromPredictedEventMinute keeps Warsaw scheduling anchored to the local day', () => {
  const result = computeLunarScheduleFromPredictedEventMinute({
    now: new Date('2026-04-10T08:00:00.000Z'),
    settings: createSettings({
      timezoneIana: 'Europe/Warsaw',
    }),
    severity: 'warn',
    predictedEventMinute: 15 * 60 + 20,
  });

  assert.equal(result.status, 'planned');
  assert.equal(result.dateKey, '2026-04-10');
  if (result.status === 'planned') {
    assert.equal(result.scheduledAt.toISOString(), '2026-04-10T12:50:00.000Z');
    assert.equal(result.predictedDipAt.toISOString(), '2026-04-10T13:20:00.000Z');
  }
});

test('computeLunarScheduleFromPredictedEventMinute keeps New York scheduling anchored to the local day', () => {
  const result = computeLunarScheduleFromPredictedEventMinute({
    now: new Date('2026-04-10T08:00:00.000Z'),
    settings: createSettings({
      timezoneIana: 'America/New_York',
    }),
    severity: 'warn',
    predictedEventMinute: 11 * 60 + 20,
  });

  assert.equal(result.status, 'planned');
  assert.equal(result.dateKey, '2026-04-10');
  if (result.status === 'planned') {
    assert.equal(result.scheduledAt.toISOString(), '2026-04-10T14:50:00.000Z');
    assert.equal(result.predictedDipAt.toISOString(), '2026-04-10T15:20:00.000Z');
  }
});

test('shouldStartLunarProductivityScheduler requires enabled config and Expo push token', () => {
  assert.equal(shouldStartLunarProductivityScheduler({ enabled: false, expoPushAccessToken: 'token' }), false);
  assert.equal(shouldStartLunarProductivityScheduler({ enabled: true, expoPushAccessToken: '' }), false);
  assert.equal(shouldStartLunarProductivityScheduler({ enabled: true, expoPushAccessToken: '   ' }), false);
  assert.equal(shouldStartLunarProductivityScheduler({ enabled: true, expoPushAccessToken: 'token' }), true);
});
