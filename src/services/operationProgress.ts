export type OperationProgressStatus = 'idle' | 'running' | 'completed' | 'failed';
export type OperationProgressStageState = 'pending' | 'active' | 'complete' | 'failed';

export type OperationProgressStageDefinition = {
  key: string;
  title: string;
  detail: string;
};

export type OperationProgressDefinition = {
  operation: string;
  title: string;
  subtitle: string;
  stages: OperationProgressStageDefinition[];
};

export type OperationProgressStageSnapshot = OperationProgressStageDefinition & {
  state: OperationProgressStageState;
};

export type OperationProgressSnapshot = {
  operation: string;
  status: OperationProgressStatus;
  title: string;
  subtitle: string;
  activeStageKey: string | null;
  stages: OperationProgressStageSnapshot[];
  updatedAt: string | null;
  expiresAt: string | null;
};

type OperationProgressRecord = {
  definition: OperationProgressDefinition;
  status: Exclude<OperationProgressStatus, 'idle'>;
  activeStageKey: string | null;
  updatedAtMs: number;
  expiresAtMs: number;
};

const DEFAULT_OPERATION_PROGRESS_TTL_MS = 10 * 60 * 1000;
const operationProgressStore = new Map<string, OperationProgressRecord>();

function buildOperationProgressStoreKey(operation: string, subjectKey: string) {
  return `${operation}:${subjectKey}`;
}

function resolveStageStates(
  stages: OperationProgressStageDefinition[],
  status: OperationProgressStatus,
  activeStageKey: string | null,
): OperationProgressStageSnapshot[] {
  if (status === 'idle') {
    return stages.map((stage) => ({ ...stage, state: 'pending' }));
  }

  if (status === 'completed') {
    return stages.map((stage) => ({ ...stage, state: 'complete' }));
  }

  const activeIndex = Math.max(0, stages.findIndex((stage) => stage.key === activeStageKey));
  return stages.map((stage, index) => {
    if (index < activeIndex) return { ...stage, state: 'complete' };
    if (index === activeIndex) {
      return { ...stage, state: status === 'failed' ? 'failed' : 'active' };
    }
    return { ...stage, state: 'pending' };
  });
}

function toSnapshot(
  definition: OperationProgressDefinition,
  record: OperationProgressRecord | null,
): OperationProgressSnapshot {
  const status = record?.status ?? 'idle';
  return {
    operation: definition.operation,
    status,
    title: definition.title,
    subtitle: definition.subtitle,
    activeStageKey: record?.activeStageKey ?? null,
    stages: resolveStageStates(definition.stages, status, record?.activeStageKey ?? null),
    updatedAt: record ? new Date(record.updatedAtMs).toISOString() : null,
    expiresAt: record ? new Date(record.expiresAtMs).toISOString() : null,
  };
}

export function getOperationProgressSnapshot(
  definition: OperationProgressDefinition,
  subjectKey: string,
  nowMs = Date.now(),
): OperationProgressSnapshot {
  const storeKey = buildOperationProgressStoreKey(definition.operation, subjectKey);
  const record = operationProgressStore.get(storeKey) ?? null;
  if (!record) return toSnapshot(definition, null);

  if (record.expiresAtMs <= nowMs) {
    operationProgressStore.delete(storeKey);
    return toSnapshot(definition, null);
  }

  return toSnapshot(definition, record);
}

export function startOperationProgress(
  definition: OperationProgressDefinition,
  subjectKey: string,
  options?: {
    ttlMs?: number;
    nowMs?: number;
  },
) {
  const ttlMs = options?.ttlMs ?? DEFAULT_OPERATION_PROGRESS_TTL_MS;
  const storeKey = buildOperationProgressStoreKey(definition.operation, subjectKey);
  const nowMs = options?.nowMs ?? Date.now();
  const firstStageKey = definition.stages[0]?.key ?? null;

  const write = (input: {
    status: Exclude<OperationProgressStatus, 'idle'>;
    activeStageKey: string | null;
    nowMs?: number;
  }) => {
    const updatedAtMs = input.nowMs ?? Date.now();
    operationProgressStore.set(storeKey, {
      definition,
      status: input.status,
      activeStageKey: input.activeStageKey,
      updatedAtMs,
      expiresAtMs: updatedAtMs + ttlMs,
    });
  };

  write({ status: 'running', activeStageKey: firstStageKey, nowMs });

  return {
    setStage(stageKey: string, stageNowMs?: number) {
      const hasStage = definition.stages.some((stage) => stage.key === stageKey);
      if (!hasStage) return;
      write({ status: 'running', activeStageKey: stageKey, nowMs: stageNowMs });
    },
    complete(completeNowMs?: number) {
      write({
        status: 'completed',
        activeStageKey: definition.stages.at(-1)?.key ?? firstStageKey,
        nowMs: completeNowMs,
      });
    },
    fail(failedStageKey?: string, failNowMs?: number) {
      const activeStageKey =
        failedStageKey && definition.stages.some((stage) => stage.key === failedStageKey)
          ? failedStageKey
          : operationProgressStore.get(storeKey)?.activeStageKey ?? firstStageKey;
      write({ status: 'failed', activeStageKey, nowMs: failNowMs });
    },
    snapshot(snapshotNowMs?: number) {
      return getOperationProgressSnapshot(definition, subjectKey, snapshotNowMs);
    },
  };
}

export function clearOperationProgressForTest() {
  operationProgressStore.clear();
}
