type ProductionEnvGuardInput = {
  NODE_ENV: 'development' | 'test' | 'production';
  DEV_FORCE_PREMIUM_FOR_ALL_USERS?: boolean;
  JOB_USAGE_LIMITS_ENABLED?: boolean;
  JOB_METRICS_ENDPOINTS_ENABLED?: boolean;
  BURNOUT_ALERT_FORCE_SEVERITY?: string;
};

export function getProductionEnvGuardIssues(input: ProductionEnvGuardInput) {
  if (input.NODE_ENV !== 'production') {
    return [];
  }

  const issues: string[] = [];
  if (input.DEV_FORCE_PREMIUM_FOR_ALL_USERS === true) {
    issues.push('DEV_FORCE_PREMIUM_FOR_ALL_USERS must not be true in production');
  }
  if (input.JOB_USAGE_LIMITS_ENABLED === false) {
    issues.push('JOB_USAGE_LIMITS_ENABLED must not be false in production');
  }
  if (input.JOB_METRICS_ENDPOINTS_ENABLED === true) {
    issues.push('JOB_METRICS_ENDPOINTS_ENABLED must not be true in production');
  }
  if (input.BURNOUT_ALERT_FORCE_SEVERITY) {
    issues.push('BURNOUT_ALERT_FORCE_SEVERITY must not be set in production');
  }

  return issues;
}
