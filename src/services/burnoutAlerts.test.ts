import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import {
  buildBurnoutAlertEventDoc,
  isBurnoutAlertJobCurrentForTransit,
  resolveBurnoutPushSeverity,
  resolveBurnoutSeverity,
} from './burnoutAlerts.js';

test('resolveBurnoutSeverity keeps expected thresholds', () => {
  assert.equal(resolveBurnoutSeverity(0), 'none');
  assert.equal(resolveBurnoutSeverity(54), 'none');
  assert.equal(resolveBurnoutSeverity(55), 'warn');
  assert.equal(resolveBurnoutSeverity(69), 'warn');
  assert.equal(resolveBurnoutSeverity(70), 'high');
  assert.equal(resolveBurnoutSeverity(84), 'high');
  assert.equal(resolveBurnoutSeverity(85), 'critical');
});

test('resolveBurnoutPushSeverity only returns push severity above threshold', () => {
  assert.equal(resolveBurnoutPushSeverity({ riskScore: 54, riskSeverity: 'none' }), null);
  assert.equal(resolveBurnoutPushSeverity({ riskScore: 55, riskSeverity: 'warn' }), 'warn');
  assert.equal(resolveBurnoutPushSeverity({ riskScore: 70, riskSeverity: 'high' }), 'high');
  assert.equal(resolveBurnoutPushSeverity({ riskScore: 85, riskSeverity: 'critical' }), 'critical');
});

test('isBurnoutAlertJobCurrentForTransit matches explicit profile hashes', () => {
  const transit = {
    profileHash: 'profile-new',
    generatedAt: new Date('2026-04-12T10:00:00.000Z'),
  };

  assert.equal(
    isBurnoutAlertJobCurrentForTransit(
      {
        profileHash: 'profile-new',
        updatedAt: new Date('2026-04-12T09:00:00.000Z'),
      },
      transit,
    ),
    true,
  );
  assert.equal(
    isBurnoutAlertJobCurrentForTransit(
      {
        profileHash: 'profile-old',
        updatedAt: new Date('2026-04-12T11:00:00.000Z'),
      },
      transit,
    ),
    false,
  );
});

test('isBurnoutAlertJobCurrentForTransit handles legacy jobs by write time', () => {
  const transit = {
    profileHash: 'profile-new',
    generatedAt: new Date('2026-04-12T10:00:00.000Z'),
  };

  assert.equal(
    isBurnoutAlertJobCurrentForTransit(
      {
        updatedAt: new Date('2026-04-12T10:01:00.000Z'),
      },
      transit,
    ),
    true,
  );
  assert.equal(
    isBurnoutAlertJobCurrentForTransit(
      {
        updatedAt: new Date('2026-04-12T09:59:00.000Z'),
      },
      transit,
    ),
    false,
  );
});

test('buildBurnoutAlertEventDoc creates durable audit payload with safe null defaults', () => {
  const userId = new ObjectId();
  const jobId = new ObjectId();
  const now = new Date('2026-04-13T10:00:00.000Z');

  const event = buildBurnoutAlertEventDoc({
    userId,
    jobId,
    profileHash: 'profile-1',
    dateKey: '2026-04-13',
    type: 'sent',
    severity: 'high',
    riskScore: 81,
    providerMessageId: 'expo-id',
    metadata: { dispatchAttempt: 1 },
    now,
  });

  assert.ok(event._id instanceof ObjectId);
  assert.equal(event.userId, userId);
  assert.equal(event.jobId, jobId);
  assert.equal(event.profileHash, 'profile-1');
  assert.equal(event.dateKey, '2026-04-13');
  assert.equal(event.type, 'sent');
  assert.equal(event.severity, 'high');
  assert.equal(event.riskScore, 81);
  assert.equal(event.reason, null);
  assert.equal(event.providerMessageId, 'expo-id');
  assert.deepEqual(event.metadata, { dispatchAttempt: 1 });
  assert.equal(event.createdAt, now);

  const minimalEvent = buildBurnoutAlertEventDoc({
    userId,
    type: 'skipped',
  });
  assert.equal(minimalEvent.jobId, null);
  assert.equal(minimalEvent.profileHash, null);
  assert.equal(minimalEvent.dateKey, null);
  assert.equal(minimalEvent.severity, null);
  assert.equal(minimalEvent.riskScore, null);
  assert.equal(minimalEvent.reason, null);
  assert.equal(minimalEvent.providerMessageId, null);
  assert.equal(minimalEvent.metadata, null);
});
