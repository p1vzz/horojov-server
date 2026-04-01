import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateLunarProductivityRisk, resolveLunarProductivitySeverity } from './lunarProductivity.js';

test('resolveLunarProductivitySeverity keeps expected thresholds', () => {
  assert.equal(resolveLunarProductivitySeverity(0), 'none');
  assert.equal(resolveLunarProductivitySeverity(54), 'none');
  assert.equal(resolveLunarProductivitySeverity(55), 'warn');
  assert.equal(resolveLunarProductivitySeverity(69), 'warn');
  assert.equal(resolveLunarProductivitySeverity(70), 'high');
  assert.equal(resolveLunarProductivitySeverity(84), 'high');
  assert.equal(resolveLunarProductivitySeverity(85), 'critical');
});

test('calculateLunarProductivityRisk returns contract-safe payload fields', () => {
  const risk = calculateLunarProductivityRisk({
    dateKey: '2026-03-30',
    chart: {
      houses: [
        {
          house_id: 6,
          planets: [{ name: 'Moon' }],
        },
      ],
      aspects: [
        {
          aspecting_planet: 'Moon',
          aspected_planet: 'Saturn',
          type: 'square',
          orb: 1.2,
        },
        {
          aspecting_planet: 'Moon',
          aspected_planet: 'Mercury',
          type: 'opposition',
          orb: 2.0,
        },
      ],
    },
    vibe: {
      algorithmVersion: 'daily-transit-v1',
      dominant: {
        planet: 'moon',
        sign: 'capricorn',
        house: 6,
        retrograde: false,
      },
      metrics: {
        energy: 68,
        focus: 44,
        luck: 51,
      },
      signals: {
        positiveAspects: 2,
        hardAspects: 3,
        positiveAspectStrength: 22,
        hardAspectStrength: 41,
        dominantScore: 71,
        secondaryHouse: 10,
        secondaryHouseDensity: 0.2,
        dignityBalance: 0.1,
        momentum: {
          energy: 12,
          focus: -8,
          luck: 3,
        },
      },
      tags: [
        {
          group: 'risk',
          label: 'context_switch',
          score: 70,
          reason: 'high handoff count',
        },
        {
          group: 'risk',
          label: 'rush_bias',
          score: 55,
          reason: 'tight day windows',
        },
      ],
      title: 'Focused but unstable',
      modeLabel: 'volatile',
      summary: 'test',
    },
  });

  assert.equal(risk.algorithmVersion, 'lunar-productivity-risk-v1');
  assert.ok(risk.riskScore >= 0 && risk.riskScore <= 100);
  assert.ok(['none', 'warn', 'high', 'critical'].includes(risk.severity));
  assert.ok(risk.components.moonPhaseLoad >= 0);
  assert.ok(risk.components.emotionalTide >= 0);
  assert.ok(risk.components.focusResonance >= 0);
  assert.ok(risk.components.circadianAlignment >= 0);
  assert.ok(risk.components.recoveryBuffer >= 0);
  assert.ok(
    [
      'new_moon',
      'waxing_crescent',
      'first_quarter',
      'waxing_gibbous',
      'full_moon',
      'waning_gibbous',
      'last_quarter',
      'waning_crescent',
    ].includes(risk.signals.moonPhase),
  );
  assert.ok(risk.signals.illuminationPercent >= 0 && risk.signals.illuminationPercent <= 100);
  assert.ok(typeof risk.signals.moonHouse === 'number' || risk.signals.moonHouse === null);
  assert.ok(risk.signals.hardAspectCount >= 0);
  assert.ok(risk.signals.supportiveAspectStrength >= 0);
});
