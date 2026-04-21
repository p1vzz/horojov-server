import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import type { BurnoutAlertSettingsDoc } from '../db/mongo.js';
import {
  BURNOUT_SAMPLE_LOCAL_HOURS,
  computeBurnoutScheduleFromPredictedPeakMinute,
  resolveBurnoutPredictedPeakLocalMinute,
  shouldStartBurnoutAlertScheduler,
} from './burnoutAlertScheduler.js';

function createSettings(overrides?: Partial<BurnoutAlertSettingsDoc>): BurnoutAlertSettingsDoc {
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

function createRisk() {
  return {
    algorithmVersion: 'burnout-risk-v1',
    riskScore: 88,
    severity: 'critical' as const,
    components: {
      saturnLoad: 30.2,
      moonLoad: 19.4,
      workloadMismatch: 8.2,
      tagPressure: 15.7,
      recoveryBuffer: 9.5,
    },
    signals: {
      saturnHardCount: 2.2,
      moonHardCount: 2.8,
      saturnMoonHard: 0.9,
      riskTagContextSwitch: 80,
      riskTagRushBias: 65,
      positiveAspectStrength: 4.1,
      momentum: {
        energy: 12.4,
        focus: -7.2,
      },
      saturn: {
        house: 10,
        retrograde: true,
      },
      moon: {
        house: 8,
      },
    },
  };
}

test('resolveBurnoutPredictedPeakLocalMinute picks one sampled hour and adds a 30 minute peak offset', () => {
  const result = resolveBurnoutPredictedPeakLocalMinute({
    riskScore: 88,
    settings: createSettings(),
    risk: createRisk(),
  });

  assert.ok(BURNOUT_SAMPLE_LOCAL_HOURS.some((hour) => hour === result.hour));
  assert.equal(result.predictedPeakMinute, result.hour * 60 + 30);
  assert.equal(result.hourlyScores.length, BURNOUT_SAMPLE_LOCAL_HOURS.length);

  const selectedScore = result.hourlyScores.find((candidate) => candidate.hour === result.hour)?.score;
  const maximumScore = Math.max(...result.hourlyScores.map((candidate) => candidate.score));
  assert.equal(selectedScore, maximumScore);
});

test('computeBurnoutScheduleFromPredictedPeakMinute clamps early candidates up to the workday start', () => {
  const result = computeBurnoutScheduleFromPredictedPeakMinute({
    now: new Date('2026-04-10T06:00:00.000Z'),
    settings: createSettings(),
    severity: 'warn',
    predictedPeakMinute: 9 * 60 + 30,
  });

  assert.equal(result.status, 'planned');
  assert.equal(result.dateKey, '2026-04-10');
  if (result.status === 'planned') {
    assert.equal(result.scheduledAt.toISOString(), '2026-04-10T09:00:00.000Z');
    assert.equal(result.predictedPeakAt.toISOString(), '2026-04-10T09:30:00.000Z');
  }
});

test('computeBurnoutScheduleFromPredictedPeakMinute moves candidates out of quiet hours before scheduling', () => {
  const result = computeBurnoutScheduleFromPredictedPeakMinute({
    now: new Date('2026-04-10T10:00:00.000Z'),
    settings: createSettings({
      quietHoursStartMinute: 14 * 60,
      quietHoursEndMinute: 14 * 60 + 30,
    }),
    severity: 'high',
    predictedPeakMinute: 15 * 60 + 20,
  });

  assert.equal(result.status, 'planned');
  if (result.status === 'planned') {
    assert.equal(result.scheduledAt.toISOString(), '2026-04-10T14:45:00.000Z');
    assert.equal(result.predictedPeakAt.toISOString(), '2026-04-10T15:20:00.000Z');
  }
});

test('computeBurnoutScheduleFromPredictedPeakMinute skips when the minimum lead window is already gone', () => {
  const result = computeBurnoutScheduleFromPredictedPeakMinute({
    now: new Date('2026-04-10T11:22:00.000Z'),
    settings: createSettings(),
    severity: 'high',
    predictedPeakMinute: 11 * 60 + 30,
  });

  assert.equal(result.status, 'skip');
  if (result.status === 'skip') {
    assert.equal(result.reason, 'minimum schedule window is later than allowed lead');
    assert.equal(result.predictedPeakAt.toISOString(), '2026-04-10T11:30:00.000Z');
  }
});

test('computeBurnoutScheduleFromPredictedPeakMinute keeps Warsaw scheduling anchored to the local day', () => {
  const result = computeBurnoutScheduleFromPredictedPeakMinute({
    now: new Date('2026-04-10T08:00:00.000Z'),
    settings: createSettings({
      timezoneIana: 'Europe/Warsaw',
    }),
    severity: 'warn',
    predictedPeakMinute: 15 * 60 + 30,
  });

  assert.equal(result.status, 'planned');
  assert.equal(result.dateKey, '2026-04-10');
  if (result.status === 'planned') {
    assert.equal(result.scheduledAt.toISOString(), '2026-04-10T12:55:00.000Z');
    assert.equal(result.predictedPeakAt.toISOString(), '2026-04-10T13:30:00.000Z');
  }
});

test('shouldStartBurnoutAlertScheduler requires enabled config and Expo push token', () => {
  assert.equal(shouldStartBurnoutAlertScheduler({ enabled: false, expoPushAccessToken: 'token' }), false);
  assert.equal(shouldStartBurnoutAlertScheduler({ enabled: true, expoPushAccessToken: '' }), false);
  assert.equal(shouldStartBurnoutAlertScheduler({ enabled: true, expoPushAccessToken: '   ' }), false);
  assert.equal(shouldStartBurnoutAlertScheduler({ enabled: true, expoPushAccessToken: 'token' }), true);
});
