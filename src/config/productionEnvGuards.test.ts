import assert from 'node:assert/strict';
import test from 'node:test';
import { getProductionEnvGuardIssues } from './productionEnvGuards.js';

test('production env guards reject release-breaking debug flags', () => {
  assert.deepEqual(
    getProductionEnvGuardIssues({
      NODE_ENV: 'production',
      DEV_FORCE_PREMIUM_FOR_ALL_USERS: true,
      JOB_USAGE_LIMITS_ENABLED: false,
      JOB_METRICS_ENDPOINTS_ENABLED: true,
      BURNOUT_ALERT_FORCE_SEVERITY: 'critical',
    }),
    [
      'DEV_FORCE_PREMIUM_FOR_ALL_USERS must not be true in production',
      'JOB_USAGE_LIMITS_ENABLED must not be false in production',
      'JOB_METRICS_ENDPOINTS_ENABLED must not be true in production',
      'BURNOUT_ALERT_FORCE_SEVERITY must not be set in production',
    ],
  );
});

test('production env guards allow unset safe-default gates', () => {
  assert.deepEqual(getProductionEnvGuardIssues({ NODE_ENV: 'production' }), []);
  assert.deepEqual(
    getProductionEnvGuardIssues({
      NODE_ENV: 'development',
      DEV_FORCE_PREMIUM_FOR_ALL_USERS: true,
      JOB_USAGE_LIMITS_ENABLED: false,
      JOB_METRICS_ENDPOINTS_ENABLED: true,
      BURNOUT_ALERT_FORCE_SEVERITY: 'critical',
    }),
    [],
  );
});
