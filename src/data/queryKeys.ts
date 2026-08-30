/**
 * Petal — query key factory.
 *
 * Every cache key in the app is built here, and every key is a *path* rather
 * than a label. That shape is what makes invalidation surgical: logging Buddy's
 * dinner has to refresh his feeding logs and today's task stream, and must not
 * touch Mochi's medicine, the community feed or the groups list — all of which
 * are expensive to refetch and visually jarring to lose.
 *
 * The hierarchy reads left to right, narrowing as it goes:
 *
 *   ['petal', 'feeding']                                   → all feeding, all pets
 *   ['petal', 'feeding', petId]                            → one pet's feeding
 *   ['petal', 'feeding', petId, 'logs']                    → …just the logs
 *   ['petal', 'feeding', petId, 'logs', since, limit]      → …one filtered list
 *
 * React Query matches by prefix, so a mutation picks the *shallowest key that is
 * still correct* and everything below it refreshes. Keys are frozen tuples so a
 * typo is a compile error rather than a cache miss nobody notices.
 *
 * Filter values are normalised to `null` instead of being omitted — `[…, null]`
 * and `[…, undefined]` hash differently, and that difference is the classic
 * "why is this fetching twice?" bug.
 */

import type { QueryKey } from '@tanstack/react-query';

import type { FeedScope } from './adapter';
import type { DateOnly, ID } from './types';

/* ------------------------------------------------------------------ prefixes */

const ROOT = 'petal' as const;

const PETS = [ROOT, 'pets'] as const;
const HEALTH = [ROOT, 'health'] as const;
const FEEDING = [ROOT, 'feeding'] as const;
const MEDICINE = [ROOT, 'medicine'] as const;
const APPOINTMENTS = [ROOT, 'appointments'] as const;
const CARE = [ROOT, 'care'] as const;
const CAREGIVERS = [ROOT, 'caregivers'] as const;
const COMMUNITY = [ROOT, 'community'] as const;
const SAFETY = [ROOT, 'safety'] as const;
const USERS = [ROOT, 'users'] as const;
const SESSION = [ROOT, 'session'] as const;

/** `undefined` and `null` must not produce two different keys for "no filter". */
const nil = <T>(value: T | null | undefined): T | null => value ?? null;

/* ---------------------------------------------------------------------- keys */

export const queryKeys = {
  /** Nuclear option — only for sign-out, where the cache belongs to nobody. */
  root: [ROOT] as const,

  session: {
    root: SESSION,
    current: () => [...SESSION, 'current'] as const,
  },

  users: {
    root: USERS,
    detail: (userId: ID) => [...USERS, userId] as const,
  },

  /* ------------------------------------------------------------------ pets */

  pets: {
    root: PETS,
    lists: () => [...PETS, 'list'] as const,
    /** Scoped by viewer: two accounts on one device never share a pet list. */
    list: (userId: ID) => [...PETS, 'list', userId] as const,
    details: () => [...PETS, 'detail'] as const,
    detail: (petId: ID) => [...PETS, 'detail', petId] as const,
  },

  /* ---------------------------------------------------------------- health */

  /** Prefix for everything on the health tab — used when a pet is deleted. */
  health: {
    root: HEALTH,
    forPet: (petId: ID) => [...HEALTH, petId] as const,
  },

  weights: {
    root: HEALTH,
    forPet: (petId: ID) => [...HEALTH, petId, 'weights'] as const,
  },

  vaccinations: {
    root: HEALTH,
    forPet: (petId: ID) => [...HEALTH, petId, 'vaccinations'] as const,
  },

  vetVisits: {
    root: HEALTH,
    forPet: (petId: ID) => [...HEALTH, petId, 'vetVisits'] as const,
  },

  documents: {
    root: HEALTH,
    forPet: (petId: ID) => [...HEALTH, petId, 'documents'] as const,
    /** Signed URLs live under the document list so a delete drops them too. */
    url: (petId: ID, documentId: ID) => [...HEALTH, petId, 'documents', 'url', documentId] as const,
  },

  /* --------------------------------------------------------------- feeding */

  feeding: {
    root: FEEDING,
    /** Both schedules and logs for one pet — the usual invalidation target. */
    forPet: (petId: ID) => [...FEEDING, petId] as const,
  },

  feedingSchedules: {
    root: FEEDING,
    forPet: (petId: ID) => [...FEEDING, petId, 'schedules'] as const,
  },

  feedingLogs: {
    root: FEEDING,
    forPet: (petId: ID) => [...FEEDING, petId, 'logs'] as const,
    list: (petId: ID, opts?: { since?: string; limit?: number }) =>
      [...FEEDING, petId, 'logs', nil(opts?.since), nil(opts?.limit)] as const,
  },

  /* -------------------------------------------------------------- medicine */

  medicine: {
    root: MEDICINE,
    forPet: (petId: ID) => [...MEDICINE, petId] as const,
  },

  medicines: {
    root: MEDICINE,
    forPet: (petId: ID) => [...MEDICINE, petId, 'list'] as const,
  },

  medicineLogs: {
    root: MEDICINE,
    forPet: (petId: ID) => [...MEDICINE, petId, 'logs'] as const,
    list: (petId: ID, opts?: { since?: string; limit?: number }) =>
      [...MEDICINE, petId, 'logs', nil(opts?.since), nil(opts?.limit)] as const,
  },

  adherence: {
    root: MEDICINE,
    forPet: (petId: ID) => [...MEDICINE, petId, 'adherence'] as const,
    forMedicine: (petId: ID, medicineId: ID, windowDays: number) =>
      [...MEDICINE, petId, 'adherence', medicineId, windowDays] as const,
  },

  /* ---------------------------------------------------------- appointments */

  appointments: {
    root: APPOINTMENTS,
    forPet: (petId: ID) => [...APPOINTMENTS, petId] as const,
    list: (petId: ID, opts?: { from?: string; to?: string }) =>
      [...APPOINTMENTS, petId, 'list', nil(opts?.from), nil(opts?.to)] as const,
    /** Cross-pet agenda for the Today screen and the home header. */
    upcoming: (limit?: number) => [...APPOINTMENTS, 'upcoming', nil(limit)] as const,
  },

  /* ------------------------------------------------------------ care (Today) */

  /** Derived stream: any feeding/medicine/appointment write invalidates it. */
  care: {
    root: CARE,
  },

  careTasks: {
    root: [...CARE, 'tasks'] as const,
    forDay: (date: DateOnly, petId?: ID | null) => [...CARE, 'tasks', date, nil(petId)] as const,
  },

  daySummaries: {
    root: [...CARE, 'summaries'] as const,
    forRange: (from: DateOnly, to: DateOnly, petId?: ID | null) =>
      [...CARE, 'summaries', from, to, nil(petId)] as const,
  },

  /* ------------------------------------------------------------ caregivers */

  caregivers: {
    root: CAREGIVERS,
    forPet: (petId: ID) => [...CAREGIVERS, petId] as const,
  },

  memberships: {
    root: CAREGIVERS,
    forPet: (petId: ID) => [...CAREGIVERS, petId, 'memberships'] as const,
  },

  myMemberships: {
    root: CAREGIVERS,
    forUser: (userId: ID) => [...CAREGIVERS, 'mine', userId] as const,
  },

  invites: {
    root: CAREGIVERS,
    forPet: (petId: ID) => [...CAREGIVERS, petId, 'invites'] as const,
    /** Invite previews are keyed by code and readable while signed out. */
    byCode: (code: string) => [...CAREGIVERS, 'invite', code.trim().toUpperCase()] as const,
  },

  activity: {
    root: [...CAREGIVERS, 'activity'] as const,
    forPet: (petId: ID) => [...CAREGIVERS, 'activity', petId] as const,
    /** Everything caregivers did across the pets this user owns. */
    byCaregivers: (userId: ID, limit?: number) =>
      [...CAREGIVERS, 'activity', 'byCaregivers', userId, nil(limit)] as const,
  },

  /* -------------------------------------------------------------- community */

  community: {
    root: COMMUNITY,
  },

  /**
   * Feed scope is flattened into three slots rather than kept as an object:
   * a stable tuple keeps the key readable in devtools and immune to key-order
   * differences between two callers building the same scope.
   */
  feed: {
    root: [...COMMUNITY, 'feed'] as const,
    scoped: (scope?: FeedScope) =>
      [...COMMUNITY, 'feed', nil(scope?.groupId), nil(scope?.petId), nil(scope?.authorId)] as const,
  },

  post: {
    root: [...COMMUNITY, 'post'] as const,
    detail: (postId: ID) => [...COMMUNITY, 'post', postId] as const,
  },

  comments: {
    root: [...COMMUNITY, 'comments'] as const,
    forPost: (postId: ID) => [...COMMUNITY, 'comments', postId] as const,
  },

  groups: {
    root: [...COMMUNITY, 'groups'] as const,
    list: () => [...COMMUNITY, 'groups', 'list'] as const,
    detail: (groupId: ID) => [...COMMUNITY, 'groups', groupId] as const,
  },

  /* --------------------------------------------------------------- safety */

  /**
   * Blocks and reports sit under their own prefix rather than beneath
   * `community`, because blocking has to invalidate the entire feed — and a key
   * that lives *inside* the thing it invalidates is how you end up refetching
   * the block list every time somebody likes a photo.
   */
  safety: {
    root: SAFETY,
  },

  blocks: {
    root: [...SAFETY, 'blocks'] as const,
    forUser: (userId: ID) => [...SAFETY, 'blocks', userId] as const,
  },

  reports: {
    root: [...SAFETY, 'reports'] as const,
    forUser: (userId: ID) => [...SAFETY, 'reports', userId] as const,
  },
} as const;

/* ----------------------------------------------------------- key bundles */

/**
 * Every prefix holding data that belongs to one pet. Used when a pet is deleted
 * or ownership is transferred — the one case where "invalidate a lot" is right.
 * The Today stream and day summaries are listed whole because a pet id sits in
 * their *filter* slot, not their prefix.
 */
export function petScopedKeys(petId: ID): readonly QueryKey[] {
  return [
    queryKeys.pets.detail(petId),
    queryKeys.pets.lists(),
    queryKeys.health.forPet(petId),
    queryKeys.feeding.forPet(petId),
    queryKeys.medicine.forPet(petId),
    queryKeys.appointments.forPet(petId),
    queryKeys.appointments.upcoming(),
    queryKeys.caregivers.forPet(petId),
    queryKeys.activity.forPet(petId),
    queryKeys.care.root,
  ];
}

/**
 * What any *care* write (a meal, a dose, an appointment change) has to refresh
 * beyond its own list: the unified task stream, the calendar strip's counts and
 * the pet's audit trail.
 */
export function careDerivedKeys(petId: ID): readonly QueryKey[] {
  return [queryKeys.care.root, queryKeys.activity.forPet(petId)];
}

export default queryKeys;
