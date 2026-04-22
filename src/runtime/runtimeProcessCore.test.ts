import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getWorkerSchedulerRuntimeIssues,
  resolveProductionOnlyLockEnabled,
  shouldAllowLocalSchedulerLockFallback,
  shouldAllowUnlockedSchedulers,
  shouldStartApiListener,
  shouldStartSchedulers,
} from './runtimeProcessCore.js';

test('runtime process core resolves api and worker roles', () => {
  assert.equal(shouldStartApiListener('api'), true);
  assert.equal(shouldStartSchedulers('api'), false);
  assert.equal(shouldStartApiListener('worker'), false);
  assert.equal(shouldStartSchedulers('worker'), true);
  assert.equal(shouldStartApiListener('all'), true);
  assert.equal(shouldStartSchedulers('all'), true);
});

test('runtime process core only enables lock env gates in production', () => {
  assert.equal(resolveProductionOnlyLockEnabled({ nodeEnv: 'development', configured: true }), false);
  assert.equal(resolveProductionOnlyLockEnabled({ nodeEnv: 'test', configured: true }), false);
  assert.equal(resolveProductionOnlyLockEnabled({ nodeEnv: 'production', configured: undefined }), true);
  assert.equal(resolveProductionOnlyLockEnabled({ nodeEnv: 'production', configured: true }), true);
  assert.equal(resolveProductionOnlyLockEnabled({ nodeEnv: 'production', configured: false }), false);
});

test('runtime process core only requires redis-backed scheduler config in production', () => {
  assert.deepEqual(
    getWorkerSchedulerRuntimeIssues({
      nodeEnv: 'development',
      redisEnabled: false,
      redisUrl: '',
      schedulerLocksEnabled: false,
    }),
    []
  );

  assert.deepEqual(
    getWorkerSchedulerRuntimeIssues({
      nodeEnv: 'production',
      redisEnabled: false,
      redisUrl: '',
      schedulerLocksEnabled: false,
    }),
    [
      'SCHEDULER_LOCKS_ENABLED must be true in production worker runtime',
      'REDIS_ENABLED must be true in production worker runtime',
      'REDIS_URL must be set in production worker runtime',
    ]
  );
});

test('runtime process core only allows unlocked schedulers and local lock fallback outside production', () => {
  assert.equal(
    shouldAllowUnlockedSchedulers({
      nodeEnv: 'development',
      redisEnabled: false,
      redisUrl: '',
      schedulerLocksEnabled: false,
    }),
    true
  );
  assert.equal(
    shouldAllowUnlockedSchedulers({
      nodeEnv: 'production',
      redisEnabled: true,
      redisUrl: 'redis://localhost:6379',
      schedulerLocksEnabled: false,
    }),
    false
  );
  assert.equal(
    shouldAllowLocalSchedulerLockFallback({
      nodeEnv: 'test',
      redisEnabled: false,
      redisUrl: '',
      schedulerLocksEnabled: true,
    }),
    true
  );
  assert.equal(
    shouldAllowLocalSchedulerLockFallback({
      nodeEnv: 'production',
      redisEnabled: true,
      redisUrl: 'redis://localhost:6379',
      schedulerLocksEnabled: true,
    }),
    false
  );
});
