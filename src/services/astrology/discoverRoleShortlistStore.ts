import { ObjectId } from 'mongodb';
import type { OccupationInsightResponse } from '../marketData/types.js';
import type { DiscoverRoleDetail } from '../discoverRoles.js';
import {
  getCollections,
  type DiscoverRoleShortlistEntryDoc,
} from '../../db/mongo.js';

export type DiscoverRoleShortlistEntryPayload = {
  slug: string;
  role: string;
  domain: string;
  scoreLabel: string | null;
  scoreValue: number | null;
  tags: string[];
  market: OccupationInsightResponse | null;
  detail: DiscoverRoleDetail | null;
  savedAt: string;
};

export type UpsertDiscoverRoleShortlistEntryInput = Omit<
  DiscoverRoleShortlistEntryPayload,
  'savedAt'
> & {
  userId: ObjectId;
  savedAt?: string | Date;
};

function normalizeSavedAt(input?: string | Date) {
  if (input instanceof Date && Number.isFinite(input.getTime())) {
    return input;
  }
  if (typeof input === 'string') {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) {
      return new Date(parsed);
    }
  }
  return new Date();
}

function toPayload(
  doc: Pick<
    DiscoverRoleShortlistEntryDoc,
    | 'slug'
    | 'role'
    | 'domain'
    | 'scoreLabel'
    | 'scoreValue'
    | 'tags'
    | 'market'
    | 'detail'
    | 'updatedAt'
  >,
): DiscoverRoleShortlistEntryPayload {
  return {
    slug: doc.slug,
    role: doc.role,
    domain: doc.domain,
    scoreLabel: doc.scoreLabel,
    scoreValue: doc.scoreValue,
    tags: doc.tags,
    market: doc.market,
    detail: doc.detail ?? null,
    savedAt: doc.updatedAt.toISOString(),
  };
}

export async function listDiscoverRoleShortlistEntries(input: {
  userId: ObjectId;
}): Promise<DiscoverRoleShortlistEntryPayload[]> {
  const collections = await getCollections();
  const docs = await collections.discoverRoleShortlistEntries
    .find({ userId: input.userId })
    .sort({ updatedAt: -1 })
    .limit(12)
    .toArray();

  return docs.map((doc) => toPayload(doc));
}

export async function upsertDiscoverRoleShortlistEntry(
  input: UpsertDiscoverRoleShortlistEntryInput,
): Promise<DiscoverRoleShortlistEntryPayload> {
  const collections = await getCollections();
  const savedAt = normalizeSavedAt(input.savedAt);
  const existing = await collections.discoverRoleShortlistEntries.findOne(
    {
      userId: input.userId,
      slug: input.slug,
    },
    { projection: { updatedAt: 1 } },
  );

  if (existing && existing.updatedAt.getTime() > savedAt.getTime()) {
    const current = await collections.discoverRoleShortlistEntries.findOne({
      userId: input.userId,
      slug: input.slug,
    });
    if (!current) {
      throw new Error('Shortlist entry disappeared during stale-write check');
    }
    return toPayload(current);
  }

  const persisted = await collections.discoverRoleShortlistEntries.findOneAndUpdate(
    {
      userId: input.userId,
      slug: input.slug,
    },
    {
      $set: {
        role: input.role,
        domain: input.domain,
        scoreLabel: input.scoreLabel,
        scoreValue: input.scoreValue,
        tags: input.tags.slice(0, 6),
        market: input.market,
        detail: input.detail,
        updatedAt: savedAt,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        userId: input.userId,
        slug: input.slug,
        createdAt: savedAt,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  if (!persisted) {
    throw new Error('Unable to persist discover role shortlist entry');
  }

  return toPayload(persisted);
}

export async function removeDiscoverRoleShortlistEntry(input: {
  userId: ObjectId;
  slug: string;
}) {
  const collections = await getCollections();
  const result = await collections.discoverRoleShortlistEntries.deleteOne({
    userId: input.userId,
    slug: input.slug,
  });

  return {
    deleted: result.deletedCount > 0,
    slug: input.slug,
  };
}
