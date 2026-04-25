import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerCityRoutes } from './routes/cities.js';
import { registerAstrologyRoutes } from './routes/astrology.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerMarketRoutes } from './routes/market.js';
import { registerPublicMarketRoutes } from './routes/publicMarket.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerNotificationRoutes } from './routes/notifications.js';

export function buildApp() {
  const app = Fastify({
    bodyLimit: env.APP_BODY_LIMIT_BYTES,
    logger:
      env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
              },
            },
          }
        : true,
  });

  app.register(cors, {
    origin:
      env.CORS_ORIGINS_LIST.length > 0
        ? env.CORS_ORIGINS_LIST
        : true,
  });

  app.register(registerHealthRoutes);
  app.register(registerAuthRoutes, { prefix: '/api/auth' });
  app.register(registerCityRoutes, { prefix: '/api/cities' });
  app.register(registerAstrologyRoutes, { prefix: '/api/astrology' });
  app.register(registerJobRoutes, { prefix: '/api/jobs' });
  app.register(registerMarketRoutes, { prefix: '/api/market' });
  app.register(registerPublicMarketRoutes, { prefix: '/api/public/market' });
  app.register(registerBillingRoutes, { prefix: '/api/billing' });
  app.register(registerNotificationRoutes, { prefix: '/api/notifications' });

  return app;
}
