export type RuntimeProcessRole = 'api' | 'worker' | 'all';

export type SchedulerRuntimePolicyInput = {
  nodeEnv: 'development' | 'test' | 'production';
  redisEnabled: boolean;
  redisUrl: string;
  schedulerLocksEnabled: boolean;
};

export function shouldStartApiListener(role: RuntimeProcessRole) {
  return role === 'api' || role === 'all';
}

export function shouldStartSchedulers(role: RuntimeProcessRole) {
  return role === 'worker' || role === 'all';
}

export function shouldAllowUnlockedSchedulers(input: SchedulerRuntimePolicyInput) {
  return input.nodeEnv !== 'production';
}

export function shouldAllowLocalSchedulerLockFallback(input: SchedulerRuntimePolicyInput) {
  return input.nodeEnv !== 'production';
}

export function getWorkerSchedulerRuntimeIssues(input: SchedulerRuntimePolicyInput) {
  if (input.nodeEnv !== 'production') {
    return [] as string[];
  }

  const issues: string[] = [];
  if (!input.schedulerLocksEnabled) {
    issues.push('SCHEDULER_LOCKS_ENABLED must be true in production worker runtime');
  }
  if (!input.redisEnabled) {
    issues.push('REDIS_ENABLED must be true in production worker runtime');
  }
  if (input.redisUrl.trim().length === 0) {
    issues.push('REDIS_URL must be set in production worker runtime');
  }

  return issues;
}
