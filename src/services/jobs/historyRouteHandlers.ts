import type { RouteHandlerMethod } from 'fastify';
import type { JobsCoreRouteDependencies } from './coreRouteHandlers.js';
import { historyImportSchema, historyQuerySchema } from './schemas.js';

export function createJobHistoryHandler(
  deps: JobsCoreRouteDependencies,
): RouteHandlerMethod {
  return async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(
      request.headers.authorization,
    );
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parse = historyQuerySchema.safeParse(request.query ?? {});
    if (!parse.success) {
      return reply.code(400).send({
        error: 'Invalid history query',
        details: parse.error.flatten().fieldErrors,
      });
    }

    return deps.listJobScanHistory({
      userId: auth.user._id,
      limit: parse.data.limit,
    });
  };
}

export function createJobHistoryImportHandler(
  deps: JobsCoreRouteDependencies,
): RouteHandlerMethod {
  return async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(
      request.headers.authorization,
    );
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parse = historyImportSchema.safeParse(request.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({
        error: 'Invalid history import payload',
        details: parse.error.flatten().fieldErrors,
      });
    }

    return deps.syncJobScanHistoryEntries({
      userId: auth.user._id,
      entries: parse.data.entries,
    });
  };
}
