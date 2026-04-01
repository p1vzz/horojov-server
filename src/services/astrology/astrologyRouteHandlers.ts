import type { FastifyInstance } from "fastify";
import { authenticateByAuthorizationHeader } from "../auth.js";
import { registerAstrologyNatalChartRoutes } from "./astrologyNatalChartRoutes.js";
import { registerAstrologyPremiumRoutes } from "./astrologyPremiumRoutes.js";
import { registerAstrologyProfileRoutes } from "./astrologyProfileRoutes.js";
import type {
  AstrologyRouteDependencies,
  RegisterAstrologyRoutesOptions,
} from "./astrologyRouteTypes.js";

export type {
  AstrologyRouteDependencies,
  RegisterAstrologyRoutesOptions,
} from "./astrologyRouteTypes.js";

const defaultDeps: AstrologyRouteDependencies = {
  authenticateByAuthorizationHeader,
};

export async function registerAstrologyRoutes(
  app: FastifyInstance,
  options: RegisterAstrologyRoutesOptions = {},
): Promise<void> {
  const deps: AstrologyRouteDependencies = {
    ...defaultDeps,
    ...(options.deps ?? {}),
  };

  registerAstrologyProfileRoutes(app, deps);
  registerAstrologyPremiumRoutes(app, deps);
  registerAstrologyNatalChartRoutes(app, deps);
}
