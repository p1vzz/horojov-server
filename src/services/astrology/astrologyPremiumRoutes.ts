import type { FastifyInstance } from 'fastify';
import { registerAstrologyCareerInsightsRoutes } from './astrologyCareerInsightsRoutes.js';
import { registerAstrologyDiscoverRolesRoutes } from './astrologyDiscoverRolesRoutes.js';
import { registerAstrologyPremiumAnalysisRoutes } from './astrologyPremiumAnalysisRoutes.js';
import type { AstrologyRouteDependencies } from './astrologyRouteTypes.js';

export function registerAstrologyPremiumRoutes(
  app: FastifyInstance,
  deps: AstrologyRouteDependencies,
) {
  registerAstrologyPremiumAnalysisRoutes(app, deps);
  registerAstrologyCareerInsightsRoutes(app, deps);
  registerAstrologyDiscoverRolesRoutes(app, deps);
}
