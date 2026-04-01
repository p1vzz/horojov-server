import { env } from './config/env.js';
import { buildApp } from './app.js';
import {
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
    await ensureRuntimeDataReady();

    await app.listen({
      host: env.HOST,
      port: env.PORT,
    });

    app.log.warn(
      'Combined runtime ready; prefer dedicated apiServer.ts and worker.ts processes outside local development'
    );
    stopSchedulers = startAllSchedulers(app);
    const shutdown = createProcessShutdown({
      app,
      stopSchedulers,
    });
    registerTerminationSignals(shutdown);
  } catch (error) {
    app.log.error(error, 'Failed to start combined runtime');
    await closeProcessResources({ app, stopSchedulers }).catch(() => undefined);
    process.exit(1);
  }
}

void start();
