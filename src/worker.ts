import { buildApp } from './app.js';
import {
  assertWorkerRuntimeConfig,
  closeProcessResources,
  createProcessShutdown,
  ensureRuntimeDataReady,
  registerTerminationSignals,
  startAllSchedulers,
} from './runtime/processLifecycle.js';

async function start() {
  const app = buildApp();
  let stopSchedulers: (() => void) | null = null;

  try {
    assertWorkerRuntimeConfig();
    await ensureRuntimeDataReady();
    stopSchedulers = startAllSchedulers(app);
    app.log.info('Worker runtime ready');

    const shutdown = createProcessShutdown({
      app,
      stopSchedulers,
    });
    registerTerminationSignals(shutdown);
  } catch (error) {
    app.log.error(error, 'Failed to start worker runtime');
    await closeProcessResources({ app, stopSchedulers }).catch(() => undefined);
    process.exit(1);
  }
}

void start();
