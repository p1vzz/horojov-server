import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearOperationProgressForTest,
  getOperationProgressSnapshot,
  startOperationProgress,
  type OperationProgressDefinition,
} from './operationProgress.js';

const definition: OperationProgressDefinition = {
  operation: 'test_operation',
  title: 'Preparing your report',
  subtitle: 'This can take a moment.',
  stages: [
    { key: 'first', title: 'First step', detail: 'Starting.' },
    { key: 'second', title: 'Second step', detail: 'Working.' },
    { key: 'third', title: 'Third step', detail: 'Finishing.' },
  ],
};

test('operation progress returns idle snapshot before work starts', () => {
  clearOperationProgressForTest();

  const snapshot = getOperationProgressSnapshot(definition, 'subject');

  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.activeStageKey, null);
  assert.deepEqual(
    snapshot.stages.map((stage) => stage.state),
    ['pending', 'pending', 'pending'],
  );
});

test('operation progress marks previous stages complete and active stage active', () => {
  clearOperationProgressForTest();

  const progress = startOperationProgress(definition, 'subject', { nowMs: 1000, ttlMs: 10_000 });
  progress.setStage('second', 1500);
  const snapshot = progress.snapshot(1600);

  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.activeStageKey, 'second');
  assert.deepEqual(
    snapshot.stages.map((stage) => stage.state),
    ['complete', 'active', 'pending'],
  );
  assert.equal(snapshot.updatedAt, new Date(1500).toISOString());
});

test('operation progress exposes completed and failed terminal states until expiry', () => {
  clearOperationProgressForTest();

  const completed = startOperationProgress(definition, 'completed', { nowMs: 1000, ttlMs: 10_000 });
  completed.complete(2000);
  assert.deepEqual(
    completed.snapshot(2100).stages.map((stage) => stage.state),
    ['complete', 'complete', 'complete'],
  );

  const failed = startOperationProgress(definition, 'failed', { nowMs: 1000, ttlMs: 10_000 });
  failed.setStage('second', 1500);
  failed.fail(undefined, 2000);
  assert.deepEqual(
    failed.snapshot(2100).stages.map((stage) => stage.state),
    ['complete', 'failed', 'pending'],
  );
});

test('operation progress expires old records', () => {
  clearOperationProgressForTest();

  startOperationProgress(definition, 'subject', { nowMs: 1000, ttlMs: 1000 });
  const snapshot = getOperationProgressSnapshot(definition, 'subject', 2500);

  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.updatedAt, null);
});
