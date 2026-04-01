import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { AuthContext } from '../auth.js';
import type {
  JobMetricsAlertsReport,
  JobMetricsReport,
} from '../jobMetrics.js';
import type { UsageLimitState, UsagePlan } from '../jobUsageLimits.js';
import { metricsQuerySchema } from './schemas.js';

export type JobsCoreRouteDependencies = {
  authenticateByAuthorizationHeader: (
    authorization?: string,
  ) => Promise<AuthContext | null>;
  resolveUserUsagePlan: (user: AuthContext["user"]) => UsagePlan;
  getCurrentUsageLimitState: (input: {
    userId: AuthContext["user"]["_id"];
    plan: UsagePlan;
    now?: Date;
  }) => Promise<UsageLimitState>;
  collectJobMetrics: (windowHoursInput?: number) => Promise<JobMetricsReport>;
  evaluateJobMetricsAlerts: (
    metrics: JobMetricsReport,
  ) => JobMetricsAlertsReport;
};

async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: JobsCoreRouteDependencies,
) {
  const auth = await deps.authenticateByAuthorizationHeader(
    request.headers.authorization,
  );
  if (!auth) {
    await reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return auth;
}

export function createJobLimitsHandler(
  deps: JobsCoreRouteDependencies,
): RouteHandlerMethod {
  return async (request, reply) => {
    const auth = await requireAuth(request, reply, deps);
    if (!auth) return;

    const plan = deps.resolveUserUsagePlan(auth.user);
    const limit = await deps.getCurrentUsageLimitState({
      userId: auth.user._id,
      plan,
    });
    return { plan, limit };
  };
}

export function createJobMetricsHandler(
  deps: JobsCoreRouteDependencies,
): RouteHandlerMethod {
  return async (request, reply) => {
    const auth = await requireAuth(request, reply, deps);
    if (!auth) return;

    const parse = metricsQuerySchema.safeParse(request.query ?? {});
    if (!parse.success) {
      return reply.code(400).send({
        error: "Invalid metrics query",
        details: parse.error.flatten().fieldErrors,
      });
    }

    return deps.collectJobMetrics(parse.data.windowHours);
  };
}

export function createJobAlertsHandler(
  deps: JobsCoreRouteDependencies,
): RouteHandlerMethod {
  return async (request, reply) => {
    const auth = await requireAuth(request, reply, deps);
    if (!auth) return;

    const parse = metricsQuerySchema.safeParse(request.query ?? {});
    if (!parse.success) {
      return reply.code(400).send({
        error: "Invalid alerts query",
        details: parse.error.flatten().fieldErrors,
      });
    }

    const metrics = await deps.collectJobMetrics(parse.data.windowHours);
    return deps.evaluateJobMetricsAlerts(metrics);
  };
}
