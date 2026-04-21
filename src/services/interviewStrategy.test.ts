import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveInterviewStrategySlotTarget,
  selectInterviewStrategySlotsForRange,
  type GeneratedInterviewSlot,
} from './interviewStrategy.js';

function createSlot(dateKey: string, score: number): GeneratedInterviewSlot {
  const startAt = new Date(`${dateKey}T10:00:00.000Z`);
  return {
    slotId: `${dateKey}:0600:120`,
    dateKey,
    startAt,
    endAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
    timezoneIana: 'UTC',
    score,
    explanation: 'Mercury support favors concise answers and clear professional presence.',
    explanationSource: 'deterministic',
    calendarNote: 'Mercury support favors concise answers.',
    breakdown: {
      dailyCareerScore: score,
      aiSynergyScore: score,
      weekdayWeight: 78,
      hourWeight: 82,
      conflictPenalty: 0,
      natalCommunicationScore: score,
      transitNatalScore: score,
      careerHouseScore: score,
      rangeQualityScore: 90,
    },
  };
}

test('interview strategy monthly target caps slot volume', () => {
  assert.equal(resolveInterviewStrategySlotTarget(1), 1);
  assert.equal(resolveInterviewStrategySlotTarget(14), 2);
  assert.equal(resolveInterviewStrategySlotTarget(30), 5);
  assert.equal(resolveInterviewStrategySlotTarget(90), 5);
});

test('interview strategy selection keeps sparse monthly windows', () => {
  const candidates = [
    createSlot('2026-05-01', 92),
    createSlot('2026-05-02', 91),
    createSlot('2026-05-04', 90),
    createSlot('2026-05-09', 89),
    createSlot('2026-05-14', 88),
    createSlot('2026-05-20', 87),
    createSlot('2026-05-26', 86),
  ];

  const selected = selectInterviewStrategySlotsForRange({
    candidates,
    rangeDays: 30,
    minScore: 70,
  });

  assert.equal(selected.length, 5);
  assert.deepEqual(
    selected.map((slot) => slot.dateKey),
    ['2026-05-01', '2026-05-04', '2026-05-09', '2026-05-14', '2026-05-20']
  );
});

test('interview strategy selection does not backfill below threshold', () => {
  const selected = selectInterviewStrategySlotsForRange({
    candidates: [
      createSlot('2026-05-01', 92),
      createSlot('2026-05-07', 64),
      createSlot('2026-05-14', 61),
    ],
    rangeDays: 30,
    minScore: 70,
  });

  assert.deepEqual(
    selected.map((slot) => slot.dateKey),
    ['2026-05-01']
  );
});

test('interview strategy selection uses temporary safety floor only for zero-result ranges', () => {
  const selected = selectInterviewStrategySlotsForRange({
    candidates: [
      createSlot('2026-05-01', 67),
      createSlot('2026-05-07', 63),
      createSlot('2026-05-14', 59),
    ],
    rangeDays: 30,
    minScore: 70,
    zeroResultSafetyMinScore: 62,
  });

  assert.deepEqual(
    selected.map((slot) => slot.dateKey),
    ['2026-05-01']
  );

  const tooWeak = selectInterviewStrategySlotsForRange({
    candidates: [
      createSlot('2026-05-01', 61),
      createSlot('2026-05-07', 59),
    ],
    rangeDays: 30,
    minScore: 70,
    zeroResultSafetyMinScore: 62,
  });

  assert.deepEqual(tooWeak, []);
});
