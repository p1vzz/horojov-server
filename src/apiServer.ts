import { env } from './config/env.js';
import { buildApp } from './app.js';
import {
  closeProcessResources,
  createProcessShutdown,
  ensureRuntimeDataReady,
  registerTerminationSignals,
} from './runtime/processLifecycle.js';

async function start() {
  const app = buildApp();

  try {
    await ensureRuntimeDataReady();
    await app.listen({
      host: env.HOST,
      port: env.PORT,
    });

    app.log.info(`API runtime ready on http://${env.HOST}:${env.PORT}`);
    const shutdown = createProcessShutdown({
      app,
    });
    registerTerminationSignals(shutdown);
  } catch (error) {
    app.log.error(error, 'Failed to start API runtime');
    await closeProcessResources({ app }).catch(() => undefined);
    process.exit(1);
  }
}

void start();
