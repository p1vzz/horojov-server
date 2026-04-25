import { ObjectId } from 'mongodb';
import {
  getCollections,
  type BirthProfileDoc,
  type DiscoverRoleCurrentJobDoc,
} from '../../db/mongo.js';
import { resolveDiscoverRoleCatalogMatch } from '../discoverRoles.js';
import { normalizeCurrentJobTitle } from './astrologyShared.js';

export type DiscoverRoleCurrentJobPayload = {
  title: string;
  matchedRole: {
    slug: string;
    title: string;
    domain: string;
    source: {
      provider: 'onetonline' | 'manual';
      code: string | null;
      url: string | null;
    };
  } | null;
  updatedAt: string;
};

function toLegacyPayload(
  doc: Pick<
    DiscoverRoleCurrentJobDoc,
    | 'title'
    | 'matchedRoleSlug'
    | 'matchedRoleTitle'
    | 'matchedRoleDomain'
    | 'matchedRoleSource'
    | 'matchedRoleCode'
    | 'matchedRoleUrl'
    | 'updatedAt'
  >,
): DiscoverRoleCurrentJobPayload {
  return {
    title: doc.title,
    matchedRole:
      doc.matchedRoleSlug && doc.matchedRoleTitle && doc.matchedRoleDomain && doc.matchedRoleSource
        ? {
            slug: doc.matchedRoleSlug,
            title: doc.matchedRoleTitle,
            domain: doc.matchedRoleDomain,
            source: {
              provider: doc.matchedRoleSource,
              code: doc.matchedRoleCode,
              url: doc.matchedRoleUrl,
            },
          }
        : null,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

async function buildPayloadFromTitle(input: {
  title: string;
  updatedAt: Date | null | undefined;
}) {
  const matchedRole = await resolveDiscoverRoleCatalogMatch(input.title);
  const updatedAt =
    input.updatedAt instanceof Date && Number.isFinite(input.updatedAt.getTime()) ? input.updatedAt : new Date();

  return {
    title: input.title,
    matchedRole: matchedRole
      ? {
          slug: matchedRole.slug,
          title: matchedRole.title,
          domain: matchedRole.domain,
          source: {
            provider: matchedRole.source,
            code: matchedRole.onetCode ?? null,
            url: matchedRole.sourceUrl ?? null,
          },
        }
      : null,
    updatedAt: updatedAt.toISOString(),
  } satisfies DiscoverRoleCurrentJobPayload;
}

async function backfillLegacyCurrentJobToBirthProfile(input: {
  userId: ObjectId;
  legacyDoc: Pick<DiscoverRoleCurrentJobDoc, 'title' | 'updatedAt'>;
  birthProfile: Pick<BirthProfileDoc, '_id'> | null;
}) {
  if (!input.birthProfile) return;
  const collections = await getCollections();
  await collections.birthProfiles.updateOne(
    { _id: input.birthProfile._id },
    {
      $set: {
        currentJobTitle: input.legacyDoc.title,
        currentJobUpdatedAt: input.legacyDoc.updatedAt,
      },
    },
  );
}

export async function getDiscoverRoleCurrentJob(input: {
  userId: ObjectId;
}): Promise<DiscoverRoleCurrentJobPayload | null> {
  const collections = await getCollections();
  const birthProfile = await collections.birthProfiles.findOne(
    { userId: input.userId },
    {
      projection: {
        _id: 1,
        currentJobTitle: 1,
        currentJobUpdatedAt: 1,
        updatedAt: 1,
      },
    },
  );
  const currentJobTitle = normalizeCurrentJobTitle(birthProfile?.currentJobTitle);
  if (currentJobTitle) {
    return buildPayloadFromTitle({
      title: currentJobTitle,
      updatedAt: birthProfile?.currentJobUpdatedAt ?? birthProfile?.updatedAt ?? null,
    });
  }

  const doc = await collections.discoverRoleCurrentJobs.findOne({
    userId: input.userId,
  });
  if (!doc) return null;

  await backfillLegacyCurrentJobToBirthProfile({
    userId: input.userId,
    legacyDoc: doc,
    birthProfile,
  });
  return toLegacyPayload(doc);
}

export async function upsertDiscoverRoleCurrentJob(input: {
  userId: ObjectId;
  title: string;
}): Promise<DiscoverRoleCurrentJobPayload> {
  const collections = await getCollections();
  const now = new Date();
  const title = normalizeCurrentJobTitle(input.title);
  if (!title) {
    throw new Error('Invalid current job title');
  }

  const birthProfile = await collections.birthProfiles.findOne(
    { userId: input.userId },
    { projection: { _id: 1 } },
  );
  if (!birthProfile) {
    throw new Error('Birth profile is required before setting current job');
  }

  await collections.birthProfiles.updateOne(
    { _id: birthProfile._id },
    {
      $set: {
        currentJobTitle: title,
        currentJobUpdatedAt: now,
      },
    },
  );
  await collections.discoverRoleCurrentJobs.deleteOne({
    userId: input.userId,
  });

  return buildPayloadFromTitle({
    title,
    updatedAt: now,
  });
}

export async function clearDiscoverRoleCurrentJob(input: {
  userId: ObjectId;
}) {
  const collections = await getCollections();
  await Promise.all([
    collections.birthProfiles.updateOne(
      { userId: input.userId },
      {
        $set: {
          currentJobTitle: null,
          currentJobUpdatedAt: null,
        },
      },
    ),
    collections.discoverRoleCurrentJobs.deleteOne({
      userId: input.userId,
    }),
  ]);

  return {
    currentJob: null,
  };
}
