import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { getCollections } from "../../db/mongo.js";
import {
  buildGeoQueryCandidates,
  callAstrologyApi,
  geoDetailsSchema,
  HOUSE_TYPE,
  normalizeCoordinate,
  parseBirthDate,
  parseBirthTime,
  resolveAstrologyAuthHeaders,
  resolveNatalInputForUser,
  timezoneSchema,
  toFloat,
  westernChartSchema,
} from "./astrologyShared.js";
import { requireAstrologyAuth } from "./astrologyRouteGuards.js";
import type { AstrologyRouteDependencies } from "./astrologyRouteTypes.js";

export function registerAstrologyNatalChartRoutes(
  app: FastifyInstance,
  deps: AstrologyRouteDependencies,
) {
  app.post("/natal-chart", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const resolvedInput = await resolveNatalInputForUser(
      auth.user._id,
      request.body,
    );
    if (!resolvedInput.ok) {
      if (resolvedInput.code === 404) {
        return reply.code(404).send({
          error: "Birth profile not found. Submit onboarding details first.",
        });
      }
      return reply.code(400).send({
        error: "Invalid request payload",
        details: resolvedInput.details,
      });
    }

    const payload = resolvedInput.input;
    const profileHash = resolvedInput.profileHash;
    const collections = await getCollections();
    const cachedChart = await collections.natalCharts.findOne({
      userId: auth.user._id,
      profileHash,
    });

    if (cachedChart) {
      const cachedMeta =
        cachedChart.meta && typeof cachedChart.meta === "object"
          ? (cachedChart.meta as Record<string, unknown>)
          : {};

      return {
        chart: cachedChart.chart,
        meta: {
          ...cachedMeta,
          cache: {
            hit: true,
            savedAt: cachedChart.updatedAt.toISOString(),
          },
        },
      };
    }

    const birthDate = parseBirthDate(payload.birthDate);
    const birthTime = parseBirthTime(payload.birthTime, payload.unknownTime);

    if (!birthDate || !birthTime) {
      return reply.code(400).send({
        error: "Invalid birth date or time format",
      });
    }

    try {
      if (!resolveAstrologyAuthHeaders()) {
        return reply.code(500).send({
          error: "Astrology API credentials are not configured",
        });
      }

      const inputLatitude = normalizeCoordinate(payload.latitude ?? null);
      const inputLongitude = normalizeCoordinate(payload.longitude ?? null);
      let lat: number | null = null;
      let lon: number | null = null;
      let placeName = payload.city;
      let timezoneId: string | null = null;
      let locationSource: "client_coordinates" | "astrology_geo" =
        "astrology_geo";

      if (inputLatitude !== null && inputLongitude !== null) {
        lat = inputLatitude;
        lon = inputLongitude;
        locationSource = "client_coordinates";
      } else {
        const geoCandidates = buildGeoQueryCandidates(payload.city);
        let location:
          | z.infer<typeof geoDetailsSchema>["geonames"][number]
          | undefined;

        for (const candidate of geoCandidates) {
          const geoResponse = await callAstrologyApi<unknown>("geo_details", {
            place: candidate,
            maxRows: 1,
          });

          if (geoResponse.status !== 200 || !geoResponse.data) {
            request.log.warn(
              {
                candidate,
                status: geoResponse.status,
                body: geoResponse.text.slice(0, 180),
              },
              "geo_details candidate failed",
            );
            continue;
          }

          const geoParsed = geoDetailsSchema.safeParse(geoResponse.data);
          if (!geoParsed.success) {
            request.log.warn(
              { candidate, issues: geoParsed.error.issues },
              "geo_details validation failed",
            );
            continue;
          }

          if (geoParsed.data.geonames.length > 0) {
            location = geoParsed.data.geonames[0];
            break;
          }
        }

        if (!location) {
          return reply.code(422).send({
            error: "Birth city was not found by astrology provider",
            city: payload.city,
          });
        }

        lat = toFloat(location.latitude);
        lon = toFloat(location.longitude);
        placeName = location.place_name ?? payload.city;
        timezoneId = location.timezone_id ?? null;
      }

      if (lat === null || lon === null) {
        return reply
          .code(502)
          .send({ error: "Invalid location coordinates received" });
      }

      const timezoneResponse = await callAstrologyApi<unknown>(
        "timezone_with_dst",
        {
          latitude: lat,
          longitude: lon,
          date: `${String(birthDate.month).padStart(2, "0")}-${String(birthDate.day).padStart(2, "0")}-${birthDate.year}`,
        },
      );

      if (timezoneResponse.status !== 200 || !timezoneResponse.data) {
        request.log.error(
          {
            status: timezoneResponse.status,
            body: timezoneResponse.text.slice(0, 500),
          },
          "timezone_with_dst failed",
        );
        return reply
          .code(502)
          .send({ error: "Unable to resolve timezone for birth location" });
      }

      const timezoneParsed = timezoneSchema.safeParse(timezoneResponse.data);
      if (!timezoneParsed.success) {
        request.log.error(
          { issues: timezoneParsed.error.issues },
          "timezone response validation failed",
        );
        return reply
          .code(502)
          .send({ error: "Unexpected timezone response payload" });
      }

      const chartResponse = await callAstrologyApi<unknown>(
        "western_chart_data",
        {
          day: birthDate.day,
          month: birthDate.month,
          year: birthDate.year,
          hour: birthTime.hour,
          min: birthTime.min,
          lat,
          lon,
          tzone: timezoneParsed.data.timezone,
          house_type: HOUSE_TYPE,
        },
      );

      if (chartResponse.status !== 200 || !chartResponse.data) {
        request.log.error(
          {
            status: chartResponse.status,
            body: chartResponse.text.slice(0, 500),
          },
          "western_chart_data failed",
        );
        return reply
          .code(502)
          .send({ error: "Unable to generate natal chart" });
      }

      const chartParsed = westernChartSchema.safeParse(chartResponse.data);
      if (!chartParsed.success) {
        request.log.error(
          { issues: chartParsed.error.issues },
          "western_chart_data validation failed",
        );
        return reply
          .code(502)
          .send({ error: "Unexpected chart response payload" });
      }

      const responseMeta = {
        birthDate,
        birthTime: {
          hour: birthTime.hour,
          min: birthTime.min,
          isApproximate: birthTime.isApproximate,
        },
        location: {
          cityInput: payload.city,
          placeName,
          latitude: lat,
          longitude: lon,
          timezone: timezoneParsed.data.timezone,
          timezoneId,
          source: locationSource,
          country: payload.country ?? null,
          admin1: payload.admin1 ?? null,
        },
        cache: {
          hit: false,
          savedAt: new Date().toISOString(),
        },
      };

      const now = new Date();
      await collections.natalCharts.updateOne(
        { userId: auth.user._id, profileHash },
        {
          $set: {
            profileHash,
            houseType: HOUSE_TYPE,
            provider: "astrologyapi",
            chart: chartParsed.data,
            meta: responseMeta,
            updatedAt: now,
          },
          $setOnInsert: {
            _id: new ObjectId(),
            userId: auth.user._id,
            createdAt: now,
          },
        },
        { upsert: true },
      );

      return {
        chart: chartParsed.data,
        meta: responseMeta,
      };
    } catch (error) {
      request.log.error({ error }, "natal chart generation failed");
      return reply
        .code(502)
        .send({ error: "Unable to complete natal chart request" });
    }
  });
}
