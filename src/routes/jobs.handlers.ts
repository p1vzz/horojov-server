import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import { authenticateByAuthorizationHeader } from "../services/auth.js";
import {
  evaluateJobMetricsAlerts,
  collectJobMetrics,
} from "../services/jobMetrics.js";
import {
  getCurrentUsageLimitState,
  resolveUserUsagePlan,
} from "../services/jobUsageLimits.js";
import { handleJobAnalyze } from "../services/jobs/analyzeRouteHandler.js";
import { handleJobAnalyzeScreenshots } from "../services/jobs/analyzeScreenshotsRouteHandler.js";
import {
  createJobAlertsHandler,
  createJobLimitsHandler,
  createJobMetricsHandler,
  type JobsCoreRouteDependencies,
} from "../services/jobs/coreRouteHandlers.js";
import { handleJobPreflight } from "../services/jobs/preflightRouteHandler.js";

export type JobsRouteDependencies = JobsCoreRouteDependencies & {
  handleJobPreflight: RouteHandlerMethod;
  handleJobAnalyzeScreenshots: RouteHandlerMethod;
  handleJobAnalyze: RouteHandlerMethod;
};

export type RegisterJobRoutesOptions = {
  deps?: Partial<JobsRouteDependencies>;
};

const defaultDeps: JobsRouteDependencies = {
  authenticateByAuthorizationHeader,
  resolveUserUsagePlan,
  getCurrentUsageLimitState,
  collectJobMetrics,
  evaluateJobMetricsAlerts,
  handleJobPreflight,
  handleJobAnalyzeScreenshots,
  handleJobAnalyze,
};

export async function registerJobRoutes(
  app: FastifyInstance,
  options: RegisterJobRoutesOptions = {},
): Promise<void> {
  const deps: JobsRouteDependencies = {
    ...defaultDeps,
    ...(options.deps ?? {}),
  };

  app.get("/limits", createJobLimitsHandler(deps));
  app.get("/metrics", createJobMetricsHandler(deps));
  app.get("/alerts", createJobAlertsHandler(deps));
  app.post("/preflight", deps.handleJobPreflight);
  app.post("/analyze-screenshots", deps.handleJobAnalyzeScreenshots);
  app.post("/analyze", deps.handleJobAnalyze);
}
