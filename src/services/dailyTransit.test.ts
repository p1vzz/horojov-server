import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDailyTransitAiSynergyMode } from './dailyTransit.js';

test('daily transit ai synergy mode preserves legacy sync default', () => {
  assert.equal(resolveDailyTransitAiSynergyMode(), 'sync');
  assert.equal(resolveDailyTransitAiSynergyMode({ includeAiSynergy: true }), 'sync');
});

test('daily transit ai synergy mode supports explicit runtime cache-only and none modes', () => {
  assert.equal(resolveDailyTransitAiSynergyMode({ includeAiSynergy: false }), 'none');
  assert.equal(resolveDailyTransitAiSynergyMode({ aiSynergyMode: 'cache-only' }), 'cache-only');
  assert.equal(resolveDailyTransitAiSynergyMode({ aiSynergyMode: 'none', includeAiSynergy: true }), 'none');
});
