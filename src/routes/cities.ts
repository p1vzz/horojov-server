import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';

const citySearchQuerySchema = z.object({
  query: z.string().trim().min(2).max(120),
  count: z.coerce.number().int().min(1).max(20).default(6),
  language: z.string().trim().min(2).max(10).default('en'),
});

const openMeteoCitySchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  country: z.string().optional(),
  admin1: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const openMeteoResponseSchema = z.object({
  results: z.array(openMeteoCitySchema).optional(),
});

export async function registerCityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/search', async (request, reply) => {
    const queryParse = citySearchQuerySchema.safeParse(request.query);

    if (!queryParse.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        details: queryParse.error.flatten().fieldErrors,
      });
    }

    const { query, count, language } = queryParse.data;
    const url = new URL('search', `${env.OPEN_METEO_BASE_URL.replace(/\/+$/, '')}/`);
    url.searchParams.set('name', query);
    url.searchParams.set('count', String(count));
    url.searchParams.set('language', language);
    url.searchParams.set('format', 'json');

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
      });

      if (!response.ok) {
        request.log.error({ status: response.status }, 'Open-Meteo request failed');
        return reply.code(502).send({ error: 'Failed to fetch cities from upstream provider' });
      }

      const raw = await response.json();
      const parsed = openMeteoResponseSchema.safeParse(raw);

      if (!parsed.success) {
        request.log.error({ issues: parsed.error.issues }, 'Open-Meteo response validation failed');
        return reply.code(502).send({ error: 'Unexpected upstream payload' });
      }

      const items = (parsed.data.results ?? []).map((city, index) => {
        const parts = [city.name, city.admin1, city.country].filter(Boolean);
        const fallbackId = `${city.name}-${city.latitude ?? ''}-${city.longitude ?? ''}-${index}`;

        return {
          id: String(city.id ?? fallbackId),
          name: city.name,
          label: parts.join(', '),
          latitude: city.latitude ?? null,
          longitude: city.longitude ?? null,
          country: city.country ?? null,
          admin1: city.admin1 ?? null,
        };
      });

      return { items };
    } catch (error) {
      request.log.error({ error }, 'City search request failed');
      return reply.code(502).send({ error: 'Unable to complete city search request' });
    }
  });
}

