/**
 * Petal — Supabase implementation of `DataAdapter`.
 *
 * Everything in here exists to keep two promises the rest of the app relies on:
 *
 *  1. **No screen ever sees a `created_at`.** snake_case dies at this boundary.
 *     Mapping is explicit — a row type and a mapper per entity — rather than a
 *     clever recursive key-transformer, because a transformer silently renames
 *     the one field you got wrong and a mapper fails to compile.
 *
 *  2. **RBAC is checked twice.** `assertCan()` runs before the request leaves
 *     the device so the user gets an instant, explained denial instead of a
 *     round-trip and a raw 403. The policies in `supabase/migrations/0002_rls.sql`
 *     are the boundary that actually holds. Where the server wins anyway (a
 *     stale membership in the client's context, say), a 42501 is translated back
 *     into the same `PermissionError` the client check would have thrown, so the
 *     UI has one error shape to render.
 *
 * Errors are normalised into the small typed hierarchy at the top of this file.
 * PostgREST codes, GoTrue codes, storage failures and "the phone is on a train"
 * all arrive at the query layer as a `DataError` with a `kind`, a `retryable`
 * flag and copy that can be shown to a person without editing.
 */

import { makeRedirectUri } from 'expo-auth-session';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import * as WebBrowser from 'expo-web-browser';
import type {
  AuthError as GoTrueError,
  PostgrestError,
  Session as GoTrueSession,
  SupabaseClient,
} from '@supabase/supabase-js';

import {
  PermissionError,
  sanitizeGrants,
  type Capability,
  type Membership,
  type MembershipRole,
  type MembershipStatus,
  type PresetId,
} from '../rbac/permissions';
import type { SpeciesKey } from '../theme/tokens';
import {
  assertCan,
  membershipFor,
  type ActorContext,
  type AppointmentInput,
  type DataAdapter,
  type DocumentInput,
  type FeedScope,
  type FeedingLogInput,
  type FeedingScheduleInput,
  type InviteInput,
  type MedicineInput,
  type MedicineLogInput,
  type MembershipPatch,
  type OAuthProvider,
  type Page,
  type PetInput,
  type PetPatch,
  type PostInput,
  type SignInInput,
  type SignUpInput,
  type VaccinationInput,
  type VetVisitInput,
  type WeightInput,
} from './adapter';
import {
  getSupabase,
  MEDIA_BUCKET,
  OAUTH_REDIRECT_PATH,
  SIGNED_URL_TTL_SECONDS,
} from './supabase';
import type {
  ActivityAction,
  ActivityEvent,
  AdherenceSummary,
  Appointment,
  AppointmentStatus,
  AppointmentType,
  CareTask,
  Comment,
  CommentWithAuthor,
  DateOnly,
  DaySummary,
  DocumentKind,
  DoseStatus,
  FeedingLog,
  FeedingSchedule,
  Group,
  GroupKind,
  ID,
  Invite,
  InviteStatus,
  Medicine,
  MedicineForm,
  MedicineFrequency,
  MedicineLog,
  MembershipWithUser,
  Pet,
  PetDocument,
  PortionUnit,
  Post,
  PostWithAuthor,
  Session,
  Sex,
  TaskKind,
  TaskState,
  User,
  Vaccination,
  VetVisit,
  VetVisitType,
  WeightEntry,
} from './types';

/* ============================================================== typed errors */

export type DataErrorKind =
  | 'network'
  | 'auth'
  | 'permission'
  | 'not-found'
  | 'conflict'
  | 'invalid'
  | 'storage'
  | 'cancelled'
  | 'server';

/**
 * Base class for everything this adapter throws (except `PermissionError`,
 * which the RBAC module owns so the UI can reuse `DENIAL_COPY`).
 *
 * `message` is always safe to show a person. Anything technical goes in
 * `detail`, which the error state can reveal on a long-press in development.
 */
export class DataError extends Error {
  readonly kind: DataErrorKind;
  /** True when trying again — same input, no user change — could plausibly work. */
  readonly retryable: boolean;
  readonly detail: string | null;

  constructor(
    kind: DataErrorKind,
    message: string,
    options?: { retryable?: boolean; detail?: string | null; cause?: unknown },
  ) {
    super(message);
    this.name = 'DataError';
    this.kind = kind;
    this.retryable = options?.retryable ?? false;
    this.detail = options?.detail ?? null;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** No usable connection. The only error the query layer should auto-retry. */
export class NetworkError extends DataError {
  constructor(detail?: string | null, cause?: unknown) {
    super('network', "We couldn't reach Petal just now. Check your connection and try again.", {
      retryable: true,
      detail,
      cause,
    });
    this.name = 'NetworkError';
  }
}

/** Signed out, expired, or bad credentials. */
export class AuthenticationError extends DataError {
  constructor(message: string, detail?: string | null, cause?: unknown) {
    super('auth', message, { detail, cause });
    this.name = 'AuthenticationError';
  }
}

/** The row is gone — deleted elsewhere, or never existed. */
export class NotFoundError extends DataError {
  constructor(subject: string, detail?: string | null) {
    super('not-found', `We couldn't find that ${subject} any more.`, { detail });
    this.name = 'NotFoundError';
  }
}

/** Unique-constraint style clashes: duplicate invite code, already liked, … */
export class ConflictError extends DataError {
  constructor(message: string, detail?: string | null) {
    super('conflict', message, { detail });
    this.name = 'ConflictError';
  }
}

/** The database rejected the shape of the data — a bug or a bad form value. */
export class ValidationError extends DataError {
  constructor(message: string, detail?: string | null) {
    super('invalid', message, { detail });
    this.name = 'ValidationError';
  }
}

/** Upload or signed-URL failure. */
export class StorageError extends DataError {
  constructor(message: string, detail?: string | null, cause?: unknown) {
    super('storage', message, { retryable: true, detail, cause });
    this.name = 'StorageError';
  }
}

/**
 * The user closed the OAuth sheet. Not a failure — the sign-in screen should
 * simply return to rest, so this is its own class rather than a generic error.
 */
export class OAuthCancelledError extends DataError {
  constructor() {
    super('cancelled', 'Sign-in was cancelled.');
    this.name = 'OAuthCancelledError';
  }
}

/* ------------------------------------------------------------ error mapping */

type FailContext = {
  /** Noun for the copy: "pet", "meal", "vaccination". */
  subject: string;
  /** When present, an RLS rejection is re-thrown as a `PermissionError`. */
  capability?: Capability;
  petId?: ID;
};

const NETWORK_HINTS = ['network request failed', 'failed to fetch', 'timeout', 'aborted'];

function isNetworkFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
  return NETWORK_HINTS.some((hint) => message.includes(hint));
}

function mapPostgrestError(error: PostgrestError, ctx: FailContext): Error {
  const detail = [error.code, error.message, error.details, error.hint]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' · ');

  if (isNetworkFailure(error)) return new NetworkError(detail, error);

  switch (error.code) {
    // Row Level Security said no. The client check should have caught this
    // first; when it doesn't, the user still gets the explained denial sheet.
    case '42501':
      if (ctx.capability && ctx.petId) {
        return new PermissionError(ctx.capability, ctx.petId, 'not-granted');
      }
      return new DataError('permission', "You don't have access to do that.", { detail });

    // `.single()` matched zero rows, or a function raised no_data_found.
    case 'PGRST116':
    case 'P0002':
      return new NotFoundError(ctx.subject, detail);

    case '23505':
      return new ConflictError('That already exists — nothing to add.', detail);

    case '23503':
      return new ValidationError("That's linked to something that no longer exists.", detail);

    case '23502':
    case '23514':
    case '22P02':
    case '22007':
      return new ValidationError("Some of those details didn't look right. Give them another check.", detail);

    // JWT expired / missing. The auth client will refresh and the query retries.
    case 'PGRST301':
    case '401':
      return new AuthenticationError('Your session timed out. Sign in again to pick up where you left off.', detail);

    // Anything raised deliberately by our RPCs carries copy already written for
    // a person — pass it straight through.
    case 'P0001':
      return new ValidationError(error.message, detail);

    default:
      return new DataError('server', "Something went wrong on our side. Try that again in a moment.", {
        retryable: true,
        detail,
      });
  }
}

function mapAuthError(error: GoTrueError, fallback: string): Error {
  if (isNetworkFailure(error)) return new NetworkError(error.message, error);

  const message = error.message.toLowerCase();

  if (message.includes('invalid login credentials')) {
    return new AuthenticationError(
      "That email and password don't match. Try again, or reset your password and we'll email you a link.",
      error.message,
      error,
    );
  }
  if (message.includes('email not confirmed')) {
    return new AuthenticationError(
      'Tap the link in the email we sent you, then come back and sign in.',
      error.message,
      error,
    );
  }
  if (message.includes('already registered') || error.status === 422) {
    return new ConflictError('There’s already an account with that email. Sign in instead?', error.message);
  }
  // Distinguished from the generic rate-limit branch below: this specific
  // one means the *project's* shared email quota is exhausted, not that this
  // person is being throttled — "give it a minute" would be actively
  // misleading, since Supabase's default sender resets hourly, not by the
  // minute. The account still gets created; only the confirmation email
  // doesn't go out, so someone hitting this needs to know to try again later
  // rather than assume they mistyped something and keep retrying.
  if (message.includes('email rate limit') || message.includes('email_send_rate_limit')) {
    return new DataError(
      'server',
      "We couldn't send a confirmation email right now — try again in a little while.",
      { retryable: true, detail: error.message },
    );
  }
  if (message.includes('rate limit') || error.status === 429) {
    return new DataError('server', 'Too many attempts. Give it a minute and try again.', {
      retryable: true,
      detail: error.message,
    });
  }
  return new AuthenticationError(fallback, error.message, error);
}

function mapStorageError(error: { message: string }, action: string): Error {
  if (isNetworkFailure(error)) return new NetworkError(error.message, error);
  return new StorageError(`We couldn't ${action}. Try again in a moment.`, error.message, error);
}

/* ------------------------------------------------------------ result unwrap */

/**
 * PostgREST parses the `.select()` string against a generated `Database` type.
 * We deliberately don't ship one — the project's credentials arrive after this
 * code does, so `supabase gen types` can't have been run — which leaves `data`
 * unresolvable at the type level. The row shapes above are the contract instead,
 * checked against `supabase/migrations/0001_init.sql` by review rather than by
 * the compiler. These three helpers are the single place that assertion is made,
 * and every caller past them is fully typed.
 */
type RawResult = { data: unknown; error: PostgrestError | null };

function unwrapList<T>(result: RawResult, ctx: FailContext): T[] {
  if (result.error) throw mapPostgrestError(result.error, ctx);
  return (result.data ?? []) as T[];
}

function unwrapOne<T>(result: RawResult, ctx: FailContext): T {
  if (result.error) throw mapPostgrestError(result.error, ctx);
  if (result.data === null || result.data === undefined) throw new NotFoundError(ctx.subject);
  return result.data as T;
}

function unwrapMaybe<T>(result: RawResult, ctx: FailContext): T | null {
  if (result.error) throw mapPostgrestError(result.error, ctx);
  return (result.data ?? null) as T | null;
}

function unwrapVoid(result: { error: PostgrestError | null }, ctx: FailContext): void {
  if (result.error) throw mapPostgrestError(result.error, ctx);
}

/* ------------------------------------------------------------ scalar helpers */

/**
 * PostgREST serialises `numeric` as a JSON number, but `bigint` and some driver
 * paths hand back strings. Normalising here means no chart ever divides by "12".
 */
function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumberOr(value: number | string | null | undefined, fallback: number): number {
  return toNumber(value) ?? fallback;
}

/** Canonical `…Z` form, so timestamps sort and compare identically to the mock's. */
function iso(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function isoOrNull(value: string | null | undefined): string | null {
  return value ? iso(value) : null;
}

/** jsonb → the scalar-only `meta` map the domain types promise. */
function toMeta(value: unknown): Record<string, string | number | boolean | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    }
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((v) => toNumber(v as number | string)).filter((v): v is number => v !== null)
    : [];
}

/** The device's IANA zone. Recurring care is local-time by design — see 0003. */
function deviceTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length > 0 ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/* ================================================================ row shapes */

type ProfileRow = {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
};

type PetRow = {
  id: string;
  owner_id: string;
  name: string;
  species: SpeciesKey;
  breed: string | null;
  birthday: string | null;
  approximate_age_months: number | null;
  sex: Sex;
  neutered: boolean | null;
  color_markings: string | null;
  photo_url: string | null;
  microchip_id: string | null;
  microchip_registry: string | null;
  current_weight_kg: number | string | null;
  target_weight_kg: number | string | null;
  notes: string | null;
  allergies: string[] | null;
  conditions: string[] | null;
  archived_at: string | null;
  created_at: string;
};

type PetCardRow = {
  id: string;
  owner_id: string;
  name: string;
  species: SpeciesKey;
  breed: string | null;
  photo_url: string | null;
  created_at: string;
};

type MembershipRow = {
  id: string;
  pet_id: string;
  user_id: string;
  role: MembershipRole;
  grants: Capability[] | null;
  starts_at: string | null;
  ends_at: string | null;
  status: MembershipStatus;
  invited_by: string | null;
  created_at: string;
};

type MembershipWithUserRow = MembershipRow & { user: ProfileRow | null };

type InviteRow = {
  id: string;
  pet_id: string;
  code: string;
  created_by: string;
  preset_id: PresetId;
  grants: Capability[] | null;
  starts_at: string | null;
  ends_at: string | null;
  expires_at: string;
  max_uses: number;
  uses: number;
  status: InviteStatus;
  invitee_name: string | null;
  invitee_email: string | null;
  created_at: string;
};

type WeightRow = {
  id: string;
  pet_id: string;
  kg: number | string;
  recorded_at: string;
  recorded_by: string;
  note: string | null;
};

type VaccinationRow = {
  id: string;
  pet_id: string;
  name: string;
  core: boolean;
  administered_at: string | null;
  due_at: string | null;
  vet_name: string | null;
  clinic: string | null;
  batch_number: string | null;
  notes: string | null;
  document_ids: string[] | null;
  created_by: string;
  created_at: string;
};

type VetVisitRow = {
  id: string;
  pet_id: string;
  at: string;
  type: VetVisitType;
  reason: string;
  vet_name: string | null;
  clinic: string | null;
  diagnosis: string | null;
  treatment: string | null;
  weight_kg: number | string | null;
  cost_minor: number | string | null;
  currency: string;
  follow_up_at: string | null;
  notes: string | null;
  document_ids: string[] | null;
  created_by: string;
  created_at: string;
};

type DocumentRow = {
  id: string;
  pet_id: string;
  title: string;
  kind: DocumentKind;
  mime_type: string;
  storage_path: string;
  thumbnail_path: string | null;
  size_bytes: number | string | null;
  page_count: number | null;
  uploaded_by: string;
  uploaded_at: string;
};

type FeedingScheduleRow = {
  id: string;
  pet_id: string;
  label: string;
  time_of_day: string;
  food_name: string;
  portion: number | string;
  unit: PortionUnit;
  days_of_week: number[] | null;
  reminders_on: boolean;
  active: boolean;
  notes: string | null;
  created_at: string;
};

type FeedingLogRow = {
  id: string;
  pet_id: string;
  schedule_id: string | null;
  at: string;
  food_name: string;
  portion: number | string;
  unit: PortionUnit;
  skipped: boolean;
  logged_by: string;
  note: string | null;
};

type MedicineRow = {
  id: string;
  pet_id: string;
  name: string;
  form: MedicineForm;
  dosage: string;
  frequency: MedicineFrequency;
  times_of_day: string[] | null;
  starts_at: string;
  ends_at: string | null;
  remaining_doses: number | null;
  refill_at: string | null;
  prescribed_by: string | null;
  instructions: string | null;
  with_food: boolean;
  reminders_on: boolean;
  active: boolean;
  created_at: string;
};

type MedicineLogRow = {
  id: string;
  pet_id: string;
  medicine_id: string;
  scheduled_for: string;
  at: string | null;
  status: DoseStatus;
  dosage: string | null;
  logged_by: string;
  note: string | null;
};

type AppointmentRow = {
  id: string;
  pet_id: string;
  at: string;
  duration_min: number;
  type: AppointmentType;
  reason: string;
  clinic: string | null;
  clinic_phone: string | null;
  clinic_address: string | null;
  vet_name: string | null;
  status: AppointmentStatus;
  notes: string | null;
  reminder_offsets: number[] | null;
  linked_document_ids: string[] | null;
  linked_vaccination_ids: string[] | null;
  vet_visit_id: string | null;
  created_by: string;
  created_at: string;
};

type ActivityRow = {
  id: string;
  pet_id: string;
  actor_id: string;
  actor_role: MembershipRole;
  action: ActivityAction;
  summary: string;
  entity_id: string | null;
  at: string;
  meta: unknown;
};

type GroupRow = {
  id: string;
  name: string;
  slug: string;
  kind: GroupKind;
  description: string;
  member_count: number;
  post_count: number;
  accent: string;
};

type PostRow = {
  id: string;
  author_id: string;
  pet_id: string | null;
  group_id: string | null;
  body: string;
  image_urls: string[] | null;
  like_count: number;
  comment_count: number;
  posted_while_sitting: boolean;
  created_at: string;
  author: ProfileRow | null;
  group: GroupRow | null;
};

type CommentRow = {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
  like_count: number;
  created_at: string;
  author: ProfileRow | null;
};

type CareTaskRow = {
  id: string;
  kind: TaskKind;
  pet_id: string;
  at: string;
  title: string;
  subtitle: string;
  state: TaskState;
  source_id: string;
  requires: Capability;
  completed_by: string | null;
  completed_at: string | null;
  meta: unknown;
};

type DaySummaryRow = {
  date: string;
  total: number;
  done: number;
  overdue: number;
};

type AdherenceJson = {
  medicineId: string;
  windowDays: number;
  expected: number;
  given: number;
  skipped: number;
  missed: number;
  rate: number;
  streakDays: number;
  daily: { date: string; expected: number; given: number }[];
};

type PeekInviteJson = {
  invite: {
    id: string;
    petId: string;
    code: string;
    createdBy: string;
    presetId: PresetId;
    grants: Capability[] | null;
    startsAt: string | null;
    endsAt: string | null;
    expiresAt: string;
    maxUses: number;
    uses: number;
    status: InviteStatus;
    inviteeName: string | null;
    inviteeEmail: string | null;
    createdAt: string;
  };
  pet: {
    id: string;
    ownerId: string;
    name: string;
    species: SpeciesKey;
    breed: string | null;
    photoUrl: string | null;
    createdAt: string;
  };
  owner: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    bio: string | null;
    createdAt: string;
  };
};

/* ============================================================ column lists */

const PROFILE_COLUMNS = 'id, email, display_name, avatar_url, bio, created_at';

const PET_COLUMNS =
  'id, owner_id, name, species, breed, birthday, approximate_age_months, sex, neutered, ' +
  'color_markings, photo_url, microchip_id, microchip_registry, current_weight_kg, ' +
  'target_weight_kg, notes, allergies, conditions, archived_at, created_at';

const PET_CARD_COLUMNS = 'id, owner_id, name, species, breed, photo_url, created_at';

const MEMBERSHIP_COLUMNS =
  'id, pet_id, user_id, role, grants, starts_at, ends_at, status, invited_by, created_at';

const INVITE_COLUMNS =
  'id, pet_id, code, created_by, preset_id, grants, starts_at, ends_at, expires_at, ' +
  'max_uses, uses, status, invitee_name, invitee_email, created_at';

const WEIGHT_COLUMNS = 'id, pet_id, kg, recorded_at, recorded_by, note';

const VACCINATION_COLUMNS =
  'id, pet_id, name, core, administered_at, due_at, vet_name, clinic, batch_number, ' +
  'notes, document_ids, created_by, created_at';

const VET_VISIT_COLUMNS =
  'id, pet_id, at, type, reason, vet_name, clinic, diagnosis, treatment, weight_kg, ' +
  'cost_minor, currency, follow_up_at, notes, document_ids, created_by, created_at';

const DOCUMENT_COLUMNS =
  'id, pet_id, title, kind, mime_type, storage_path, thumbnail_path, size_bytes, ' +
  'page_count, uploaded_by, uploaded_at';

const FEEDING_SCHEDULE_COLUMNS =
  'id, pet_id, label, time_of_day, food_name, portion, unit, days_of_week, reminders_on, ' +
  'active, notes, created_at';

const FEEDING_LOG_COLUMNS =
  'id, pet_id, schedule_id, at, food_name, portion, unit, skipped, logged_by, note';

const MEDICINE_COLUMNS =
  'id, pet_id, name, form, dosage, frequency, times_of_day, starts_at, ends_at, ' +
  'remaining_doses, refill_at, prescribed_by, instructions, with_food, reminders_on, ' +
  'active, created_at';

const MEDICINE_LOG_COLUMNS =
  'id, pet_id, medicine_id, scheduled_for, at, status, dosage, logged_by, note';

const APPOINTMENT_COLUMNS =
  'id, pet_id, at, duration_min, type, reason, clinic, clinic_phone, clinic_address, ' +
  'vet_name, status, notes, reminder_offsets, linked_document_ids, linked_vaccination_ids, ' +
  'vet_visit_id, created_by, created_at';

const ACTIVITY_COLUMNS = 'id, pet_id, actor_id, actor_role, action, summary, entity_id, at, meta';

const GROUP_COLUMNS = 'id, name, slug, kind, description, member_count, post_count, accent';

const POST_COLUMNS =
  'id, author_id, pet_id, group_id, body, image_urls, like_count, comment_count, ' +
  `posted_while_sitting, created_at, author:profiles!posts_author_id_fkey(${PROFILE_COLUMNS}), ` +
  `group:groups!posts_group_id_fkey(${GROUP_COLUMNS})`;

const COMMENT_COLUMNS =
  'id, post_id, author_id, body, like_count, created_at, ' +
  `author:profiles!comments_author_id_fkey(${PROFILE_COLUMNS})`;

/* ================================================================== mappers */

function mapUser(row: ProfileRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    createdAt: iso(row.created_at),
  };
}

function mapPet(row: PetRow): Pet {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    species: row.species,
    breed: row.breed,
    birthday: row.birthday,
    approximateAgeMonths: row.approximate_age_months,
    sex: row.sex,
    neutered: row.neutered,
    colorMarkings: row.color_markings,
    photoUrl: row.photo_url,
    microchipId: row.microchip_id,
    microchipRegistry: row.microchip_registry,
    currentWeightKg: toNumber(row.current_weight_kg),
    targetWeightKg: toNumber(row.target_weight_kg),
    notes: row.notes,
    allergies: toStringArray(row.allergies),
    conditions: toStringArray(row.conditions),
    archivedAt: isoOrNull(row.archived_at),
    createdAt: iso(row.created_at),
  };
}

/**
 * The community feed can show a pet you have no membership on. `pet_cards`
 * exposes identity only (see 0001_init.sql), so the private half of `Pet` is
 * filled with the same nulls an unknown value would carry — the feed never
 * reads them, and nothing downstream has to special-case a partial pet.
 */
function mapPetCard(row: PetCardRow): Pet {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    species: row.species,
    breed: row.breed,
    birthday: null,
    approximateAgeMonths: null,
    sex: 'unknown',
    neutered: null,
    colorMarkings: null,
    photoUrl: row.photo_url,
    microchipId: null,
    microchipRegistry: null,
    currentWeightKg: null,
    targetWeightKg: null,
    notes: null,
    allergies: [],
    conditions: [],
    archivedAt: null,
    createdAt: iso(row.created_at),
  };
}

function mapMembership(row: MembershipRow): Membership {
  return {
    id: row.id,
    petId: row.pet_id,
    userId: row.user_id,
    role: row.role,
    grants: row.grants ?? [],
    startsAt: isoOrNull(row.starts_at),
    endsAt: isoOrNull(row.ends_at),
    status: row.status,
    invitedBy: row.invited_by,
    createdAt: iso(row.created_at),
  };
}

function mapInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    petId: row.pet_id,
    code: row.code,
    createdBy: row.created_by,
    presetId: row.preset_id,
    grants: row.grants ?? [],
    startsAt: isoOrNull(row.starts_at),
    endsAt: isoOrNull(row.ends_at),
    expiresAt: iso(row.expires_at),
    maxUses: row.max_uses,
    uses: row.uses,
    status: row.status,
    inviteeName: row.invitee_name,
    inviteeEmail: row.invitee_email,
    createdAt: iso(row.created_at),
  };
}

function mapWeight(row: WeightRow): WeightEntry {
  return {
    id: row.id,
    petId: row.pet_id,
    kg: toNumberOr(row.kg, 0),
    recordedAt: iso(row.recorded_at),
    recordedBy: row.recorded_by,
    note: row.note,
  };
}

function mapVaccination(row: VaccinationRow): Vaccination {
  return {
    id: row.id,
    petId: row.pet_id,
    name: row.name,
    core: row.core,
    administeredAt: row.administered_at,
    dueAt: row.due_at,
    vetName: row.vet_name,
    clinic: row.clinic,
    batchNumber: row.batch_number,
    notes: row.notes,
    documentIds: toStringArray(row.document_ids),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function mapVetVisit(row: VetVisitRow): VetVisit {
  return {
    id: row.id,
    petId: row.pet_id,
    at: iso(row.at),
    type: row.type,
    reason: row.reason,
    vetName: row.vet_name,
    clinic: row.clinic,
    diagnosis: row.diagnosis,
    treatment: row.treatment,
    weightKg: toNumber(row.weight_kg),
    costMinor: toNumber(row.cost_minor),
    currency: row.currency,
    followUpAt: row.follow_up_at,
    notes: row.notes,
    documentIds: toStringArray(row.document_ids),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function mapDocument(row: DocumentRow): PetDocument {
  return {
    id: row.id,
    petId: row.pet_id,
    title: row.title,
    kind: row.kind,
    mimeType: row.mime_type,
    // Storage object key, not a URL — call `resolveDocumentUrl()` to view it.
    uri: row.storage_path,
    thumbnailUri: row.thumbnail_path,
    sizeBytes: toNumber(row.size_bytes),
    pageCount: row.page_count,
    uploadedBy: row.uploaded_by,
    uploadedAt: iso(row.uploaded_at),
  };
}

function mapFeedingSchedule(row: FeedingScheduleRow): FeedingSchedule {
  return {
    id: row.id,
    petId: row.pet_id,
    label: row.label,
    time: row.time_of_day,
    foodName: row.food_name,
    portion: toNumberOr(row.portion, 0),
    unit: row.unit,
    daysOfWeek: toNumberArray(row.days_of_week),
    remindersOn: row.reminders_on,
    active: row.active,
    notes: row.notes,
    createdAt: iso(row.created_at),
  };
}

function mapFeedingLog(row: FeedingLogRow): FeedingLog {
  return {
    id: row.id,
    petId: row.pet_id,
    scheduleId: row.schedule_id,
    at: iso(row.at),
    foodName: row.food_name,
    portion: toNumberOr(row.portion, 0),
    unit: row.unit,
    skipped: row.skipped,
    loggedBy: row.logged_by,
    note: row.note,
  };
}

function mapMedicine(row: MedicineRow): Medicine {
  return {
    id: row.id,
    petId: row.pet_id,
    name: row.name,
    form: row.form,
    dosage: row.dosage,
    frequency: row.frequency,
    timesOfDay: toStringArray(row.times_of_day),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    remainingDoses: row.remaining_doses,
    refillAt: row.refill_at,
    prescribedBy: row.prescribed_by,
    instructions: row.instructions,
    withFood: row.with_food,
    remindersOn: row.reminders_on,
    active: row.active,
    createdAt: iso(row.created_at),
  };
}

function mapMedicineLog(row: MedicineLogRow): MedicineLog {
  return {
    id: row.id,
    petId: row.pet_id,
    medicineId: row.medicine_id,
    scheduledFor: iso(row.scheduled_for),
    at: isoOrNull(row.at),
    status: row.status,
    dosage: row.dosage,
    loggedBy: row.logged_by,
    note: row.note,
  };
}

function mapAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    petId: row.pet_id,
    at: iso(row.at),
    durationMin: row.duration_min,
    type: row.type,
    reason: row.reason,
    clinic: row.clinic,
    clinicPhone: row.clinic_phone,
    clinicAddress: row.clinic_address,
    vetName: row.vet_name,
    status: row.status,
    notes: row.notes,
    reminderOffsets: toNumberArray(row.reminder_offsets),
    linkedDocumentIds: toStringArray(row.linked_document_ids),
    linkedVaccinationIds: toStringArray(row.linked_vaccination_ids),
    vetVisitId: row.vet_visit_id,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function mapActivity(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    petId: row.pet_id,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    action: row.action,
    summary: row.summary,
    entityId: row.entity_id,
    at: iso(row.at),
    meta: toMeta(row.meta),
  };
}

function mapGroup(row: GroupRow, joined: boolean): Group {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    description: row.description,
    memberCount: row.member_count,
    postCount: row.post_count,
    accent: row.accent,
    joined,
  };
}

function mapPost(row: PostRow, likedByMe: boolean): Post {
  return {
    id: row.id,
    authorId: row.author_id,
    petId: row.pet_id,
    groupId: row.group_id,
    body: row.body,
    imageUrls: toStringArray(row.image_urls),
    likeCount: row.like_count,
    commentCount: row.comment_count,
    likedByMe,
    postedWhileSitting: row.posted_while_sitting,
    createdAt: iso(row.created_at),
  };
}

function mapComment(row: CommentRow, likedByMe: boolean): Comment {
  return {
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    body: row.body,
    likeCount: row.like_count,
    likedByMe,
    createdAt: iso(row.created_at),
  };
}

/** Profile rows can only be missing if a row was deleted mid-flight. */
const DELETED_USER: Omit<User, 'id'> = {
  email: '',
  displayName: 'Someone',
  avatarUrl: null,
  bio: null,
  createdAt: new Date(0).toISOString(),
};

function mapAuthorOr(row: ProfileRow | null, fallbackId: string): User {
  return row ? mapUser(row) : { id: fallbackId, ...DELETED_USER };
}

const CARE_GRACE_MS = 30 * 60 * 1000;

/**
 * The server computes `state` against its own clock; anything still open is
 * re-derived here so a task never reads "upcoming" while the phone shows a
 * later time (different clock skew, or the screen has been open a while).
 */
function localiseTaskState(at: string, serverState: TaskState): TaskState {
  if (serverState === 'done' || serverState === 'skipped') return serverState;
  const slot = Date.parse(at);
  if (Number.isNaN(slot)) return serverState;
  const now = Date.now();
  if (slot < now - CARE_GRACE_MS) return 'overdue';
  if (slot <= now + CARE_GRACE_MS) return 'due';
  return 'upcoming';
}

function mapCareTask(row: CareTaskRow): CareTask {
  const at = iso(row.at);
  return {
    id: row.id,
    kind: row.kind,
    petId: row.pet_id,
    at,
    title: row.title,
    subtitle: row.subtitle,
    state: localiseTaskState(at, row.state),
    sourceId: row.source_id,
    requires: row.requires,
    completedBy: row.completed_by,
    completedAt: isoOrNull(row.completed_at),
    meta: toMeta(row.meta),
  };
}

/* ------------------------------------------------------------ write shapes */

/** Only defined keys are sent, so a patch never nulls a field it didn't mention. */
function compact(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function petRowFromPatch(patch: PetPatch): Record<string, unknown> {
  return compact({
    name: patch.name,
    species: patch.species,
    breed: patch.breed,
    birthday: patch.birthday,
    approximate_age_months: patch.approximateAgeMonths,
    sex: patch.sex,
    neutered: patch.neutered,
    color_markings: patch.colorMarkings,
    photo_url: patch.photoUrl,
    microchip_id: patch.microchipId,
    microchip_registry: patch.microchipRegistry,
    current_weight_kg: patch.currentWeightKg,
    target_weight_kg: patch.targetWeightKg,
    notes: patch.notes,
    allergies: patch.allergies,
    conditions: patch.conditions,
    archived_at: patch.archivedAt,
  });
}

function vaccinationRow(input: VaccinationInput): Record<string, unknown> {
  return {
    pet_id: input.petId,
    name: input.name,
    core: input.core,
    administered_at: input.administeredAt,
    due_at: input.dueAt,
    vet_name: input.vetName,
    clinic: input.clinic,
    batch_number: input.batchNumber,
    notes: input.notes,
    document_ids: input.documentIds,
  };
}

function vetVisitRow(input: VetVisitInput): Record<string, unknown> {
  return {
    pet_id: input.petId,
    at: input.at,
    type: input.type,
    reason: input.reason,
    vet_name: input.vetName,
    clinic: input.clinic,
    diagnosis: input.diagnosis,
    treatment: input.treatment,
    weight_kg: input.weightKg,
    cost_minor: input.costMinor,
    currency: input.currency,
    follow_up_at: input.followUpAt,
    notes: input.notes,
    document_ids: input.documentIds,
  };
}

function feedingScheduleRow(input: FeedingScheduleInput): Record<string, unknown> {
  return {
    pet_id: input.petId,
    label: input.label,
    time_of_day: input.time,
    food_name: input.foodName,
    portion: input.portion,
    unit: input.unit,
    days_of_week: input.daysOfWeek,
    reminders_on: input.remindersOn,
    active: input.active,
    notes: input.notes,
  };
}

function medicineRow(input: MedicineInput): Record<string, unknown> {
  return {
    pet_id: input.petId,
    name: input.name,
    form: input.form,
    dosage: input.dosage,
    frequency: input.frequency,
    times_of_day: input.timesOfDay,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    remaining_doses: input.remainingDoses,
    refill_at: input.refillAt,
    prescribed_by: input.prescribedBy,
    instructions: input.instructions,
    with_food: input.withFood,
    reminders_on: input.remindersOn,
    active: input.active,
  };
}

function appointmentRow(input: AppointmentInput): Record<string, unknown> {
  return {
    pet_id: input.petId,
    at: input.at,
    duration_min: input.durationMin,
    type: input.type,
    reason: input.reason,
    clinic: input.clinic,
    clinic_phone: input.clinicPhone,
    clinic_address: input.clinicAddress,
    vet_name: input.vetName,
    status: input.status,
    notes: input.notes,
    reminder_offsets: input.reminderOffsets,
    linked_document_ids: input.linkedDocumentIds,
    linked_vaccination_ids: input.linkedVaccinationIds,
  };
}

/* --------------------------------------------------------- storage helpers */

/**
 * Document pickers hand back `file://` on both platforms once the file is
 * copied to the cache, which `expo-file-system`'s `File` reads directly. The
 * `fetch` branch covers the odd `content://` or remote URI without pulling in a
 * base64 round-trip for the common case.
 */
async function readLocalBytes(uri: string): Promise<Uint8Array> {
  if (uri.startsWith('file://')) {
    return await new File(uri).bytes();
  }
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/webp': '.webp',
  'text/plain': '.txt',
};

function extensionFor(uri: string, mimeType: string): string {
  const fromMime = EXTENSION_BY_MIME[mimeType.toLowerCase()];
  if (fromMime) return fromMime;
  const match = /\.([a-z0-9]{1,5})(?:\?|#|$)/i.exec(uri);
  return match ? `.${match[1]!.toLowerCase()}` : '';
}

/* ------------------------------------------------------------ invite codes */

/** No O/0/I/1 — these codes get read aloud and typed in by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function inviteCodeFor(petName: string): string {
  const stem =
    petName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8) || 'PETAL';
  let suffix = '';
  for (let i = 0; i < 4; i += 1) {
    suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `${stem}-${suffix}`;
}

/* ================================================================= adapter */

export class SupabaseAdapter implements DataAdapter {
  readonly kind = 'supabase' as const;

  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient = getSupabase()) {
    this.client = client;
  }

  private get sb(): SupabaseClient {
    return this.client;
  }

  /* ---------------------------------------------------------------- auth */

  async getSession(): Promise<Session | null> {
    const { data, error } = await this.sb.auth.getSession();
    if (error) throw mapAuthError(error, "We couldn't restore your session.");
    if (!data.session) return null;
    return this.hydrateSession(data.session);
  }

  async signIn(input: SignInInput): Promise<Session> {
    const { data, error } = await this.sb.auth.signInWithPassword({
      email: input.email.trim(),
      password: input.password,
    });
    if (error) throw mapAuthError(error, "We couldn't sign you in.");
    if (!data.session) {
      throw new AuthenticationError("We couldn't sign you in. Give it another go.");
    }
    return this.hydrateSession(data.session);
  }

  async signUp(input: SignUpInput): Promise<Session> {
    const { data, error } = await this.sb.auth.signUp({
      email: input.email.trim(),
      password: input.password,
      // Read by the profiles trigger in 0001_init.sql.
      options: { data: { display_name: input.displayName.trim() } },
    });
    if (error) throw mapAuthError(error, "We couldn't create your account.");
    if (!data.session) {
      // Email confirmation is on for this project — the account exists, but
      // there's no session until the link is tapped.
      throw new AuthenticationError(
        'Almost there — tap the link in the email we just sent to finish setting up your account.',
      );
    }
    return this.hydrateSession(data.session);
  }

  async signInWithOAuth(provider: OAuthProvider): Promise<Session> {
    const redirectTo = makeRedirectUri({ scheme: 'petal', path: OAUTH_REDIRECT_PATH });

    const { data, error } = await this.sb.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        // We drive the browser ourselves so the sheet closes on our terms.
        skipBrowserRedirect: true,
        ...(provider === 'google' ? { queryParams: { prompt: 'select_account' } } : null),
      },
    });
    if (error) throw mapAuthError(error, "We couldn't start that sign-in.");
    if (!data.url) throw new AuthenticationError("We couldn't start that sign-in.");

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success') throw new OAuthCancelledError();

    const callback = new URL(result.url);
    const denied = callback.searchParams.get('error_description') ?? callback.searchParams.get('error');
    if (denied) throw new AuthenticationError('That sign-in was turned down.', denied);

    const code = callback.searchParams.get('code');
    if (code) {
      const exchange = await this.sb.auth.exchangeCodeForSession(code);
      if (exchange.error) throw mapAuthError(exchange.error, "We couldn't finish that sign-in.");
      if (!exchange.data.session) throw new AuthenticationError("We couldn't finish that sign-in.");
      return this.hydrateSession(exchange.data.session);
    }

    // Implicit-grant fallback: some providers still return tokens in the
    // fragment when the project isn't on PKCE.
    const fragment = new URLSearchParams(callback.hash.replace(/^#/, ''));
    const accessToken = fragment.get('access_token');
    const refreshToken = fragment.get('refresh_token');
    if (accessToken && refreshToken) {
      const restored = await this.sb.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (restored.error) throw mapAuthError(restored.error, "We couldn't finish that sign-in.");
      if (restored.data.session) return this.hydrateSession(restored.data.session);
    }

    throw new AuthenticationError("That sign-in didn't come back with everything we needed.");
  }

  async signOut(): Promise<void> {
    const { error } = await this.sb.auth.signOut();
    if (error) throw mapAuthError(error, "We couldn't sign you out.");
  }

  async requestPasswordReset(email: string): Promise<void> {
    const redirectTo = makeRedirectUri({ scheme: 'petal', path: 'auth/reset' });
    const { error } = await this.sb.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    if (error) throw mapAuthError(error, "We couldn't send that reset email.");
  }

  async updateProfile(
    ctx: ActorContext,
    patch: Partial<Pick<User, 'displayName' | 'avatarUrl' | 'bio'>>,
  ): Promise<User> {
    const row = compact({
      display_name: patch.displayName,
      avatar_url: patch.avatarUrl,
      bio: patch.bio,
    });

    const result = await this.sb
      .from('profiles')
      .update(row)
      .eq('id', ctx.userId)
      .select(PROFILE_COLUMNS)
      .single();

    return mapUser(unwrapOne<ProfileRow>(result, { subject: 'profile' }));
  }

  onSessionChange(listener: (session: Session | null) => void): () => void {
    const { data } = this.sb.auth.onAuthStateChange((event, session) => {
      // Supabase holds an internal lock while this callback runs, so any further
      // auth or PostgREST call from inside it can deadlock. Defer to the next
      // tick and do the profile/membership fetch there.
      setTimeout(() => {
        if (event === 'SIGNED_OUT' || !session) {
          listener(null);
          return;
        }
        this.hydrateSession(session)
          .then(listener)
          .catch(() => listener(null));
      }, 0);
    });

    return () => data.subscription.unsubscribe();
  }

  /**
   * Turns a GoTrue session into Petal's `Session`: the profile row plus every
   * membership the user holds, which is what makes the dual owner/caregiver role
   * work without a second round-trip on every screen.
   */
  private async hydrateSession(authSession: GoTrueSession): Promise<Session> {
    const userId = authSession.user.id;

    const [profile, memberships] = await Promise.all([
      this.ensureProfile(userId, authSession),
      this.sb
        .from('memberships')
        .select(MEMBERSHIP_COLUMNS)
        .eq('user_id', userId)
        .order('created_at', { ascending: true }),
    ]);

    return {
      user: profile,
      memberships: unwrapList<MembershipRow>(memberships, { subject: 'membership' }).map(mapMembership),
      accessToken: authSession.access_token,
    };
  }

  /**
   * The `on_auth_user_created` trigger writes the profile, but a first sign-in
   * can beat its own transaction to the read. Rather than surface an empty
   * account, write the row we already have from the token.
   */
  private async ensureProfile(userId: ID, authSession: GoTrueSession): Promise<User> {
    const existing = await this.sb
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', userId)
      .maybeSingle();

    const row = unwrapMaybe<ProfileRow>(existing, { subject: 'profile' });
    if (row) return mapUser(row);

    const metadata = authSession.user.user_metadata as Record<string, unknown>;
    const metaString = (key: string): string | null => {
      const value = metadata[key];
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    };
    const email = authSession.user.email ?? '';

    const created = await this.sb
      .from('profiles')
      .insert({
        id: userId,
        email,
        display_name:
          metaString('display_name') ??
          metaString('full_name') ??
          metaString('name') ??
          (email.split('@')[0] || 'Pet person'),
        avatar_url: metaString('avatar_url') ?? metaString('picture'),
      })
      .select(PROFILE_COLUMNS)
      .single();

    return mapUser(unwrapOne<ProfileRow>(created, { subject: 'profile' }));
  }

  /* ---------------------------------------------------------------- pets */

  async listPets(ctx: ActorContext): Promise<Pet[]> {
    void ctx;
    const result = await this.sb
      .from('pets')
      .select(PET_COLUMNS)
      .order('created_at', { ascending: true });

    return unwrapList<PetRow>(result, { subject: 'pet' }).map(mapPet);
  }

  async getPet(ctx: ActorContext, petId: ID): Promise<Pet | null> {
    void ctx;
    const result = await this.sb.from('pets').select(PET_COLUMNS).eq('id', petId).maybeSingle();
    const row = unwrapMaybe<PetRow>(result, { subject: 'pet' });
    return row ? mapPet(row) : null;
  }

  async createPet(ctx: ActorContext, input: PetInput): Promise<Pet> {
    const result = await this.sb
      .from('pets')
      .insert({
        owner_id: ctx.userId,
        name: input.name,
        species: input.species,
        breed: input.breed,
        birthday: input.birthday,
        approximate_age_months: input.approximateAgeMonths,
        sex: input.sex,
        neutered: input.neutered,
        color_markings: input.colorMarkings,
        photo_url: input.photoUrl,
        microchip_id: input.microchipId,
        microchip_registry: input.microchipRegistry,
        target_weight_kg: input.targetWeightKg,
        notes: input.notes,
        allergies: input.allergies,
        conditions: input.conditions,
      })
      .select(PET_COLUMNS)
      .single();

    // The owner membership row is created by the `pets_owner_membership`
    // trigger, so the caller's context is stale by exactly one row until the
    // session refetches — which `createPet`'s mutation does.
    return mapPet(unwrapOne<PetRow>(result, { subject: 'pet' }));
  }

  async updatePet(ctx: ActorContext, petId: ID, patch: PetPatch): Promise<Pet> {
    assertCan(ctx, petId, 'pet.edit');

    const result = await this.sb
      .from('pets')
      .update(petRowFromPatch(patch))
      .eq('id', petId)
      .select(PET_COLUMNS)
      .single();

    const pet = mapPet(unwrapOne<PetRow>(result, { subject: 'pet', capability: 'pet.edit', petId }));
    await this.recordActivity(ctx, petId, 'pet.updated', `${pet.name}'s profile was updated`, pet.id);
    return pet;
  }

  async deletePet(ctx: ActorContext, petId: ID): Promise<void> {
    assertCan(ctx, petId, 'pet.delete');
    const result = await this.sb.from('pets').delete().eq('id', petId);
    unwrapVoid(result, { subject: 'pet', capability: 'pet.delete', petId });
  }

  /* -------------------------------------------------------------- weight */

  async listWeights(ctx: ActorContext, petId: ID): Promise<WeightEntry[]> {
    assertCan(ctx, petId, 'weight.view');
    const result = await this.sb
      .from('weight_entries')
      .select(WEIGHT_COLUMNS)
      .eq('pet_id', petId)
      .order('recorded_at', { ascending: false });

    return unwrapList<WeightRow>(result, { subject: 'weight entry', capability: 'weight.view', petId }).map(
      mapWeight,
    );
  }

  async addWeight(ctx: ActorContext, input: WeightInput): Promise<WeightEntry> {
    assertCan(ctx, input.petId, 'weight.log');

    const result = await this.sb
      .from('weight_entries')
      .insert({
        pet_id: input.petId,
        kg: input.kg,
        recorded_at: input.recordedAt ?? new Date().toISOString(),
        recorded_by: ctx.userId,
        note: input.note ?? null,
      })
      .select(WEIGHT_COLUMNS)
      .single();

    const entry = mapWeight(
      unwrapOne<WeightRow>(result, { subject: 'weight entry', capability: 'weight.log', petId: input.petId }),
    );

    await this.recordActivity(
      ctx,
      input.petId,
      'weight.recorded',
      `Weight recorded — ${entry.kg} kg`,
      entry.id,
      { kg: entry.kg },
    );
    return entry;
  }

  async deleteWeight(ctx: ActorContext, petId: ID, entryId: ID): Promise<void> {
    assertCan(ctx, petId, 'weight.log');
    const result = await this.sb.from('weight_entries').delete().eq('id', entryId).eq('pet_id', petId);
    unwrapVoid(result, { subject: 'weight entry', capability: 'weight.log', petId });
  }

  /* -------------------------------------------------------- vaccinations */

  async listVaccinations(ctx: ActorContext, petId: ID): Promise<Vaccination[]> {
    assertCan(ctx, petId, 'vaccination.view');
    const result = await this.sb
      .from('vaccinations')
      .select(VACCINATION_COLUMNS)
      .eq('pet_id', petId)
      .order('due_at', { ascending: true, nullsFirst: false });

    return unwrapList<VaccinationRow>(result, {
      subject: 'vaccination',
      capability: 'vaccination.view',
      petId,
    }).map(mapVaccination);
  }

  async upsertVaccination(ctx: ActorContext, input: VaccinationInput & { id?: ID }): Promise<Vaccination> {
    assertCan(ctx, input.petId, 'vaccination.edit');

    const base = vaccinationRow(input);
    const result = input.id
      ? await this.sb
          .from('vaccinations')
          .update(base)
          .eq('id', input.id)
          .eq('pet_id', input.petId)
          .select(VACCINATION_COLUMNS)
          .single()
      : await this.sb
          .from('vaccinations')
          .insert({ ...base, created_by: ctx.userId })
          .select(VACCINATION_COLUMNS)
          .single();

    const vaccination = mapVaccination(
      unwrapOne<VaccinationRow>(result, {
        subject: 'vaccination',
        capability: 'vaccination.edit',
        petId: input.petId,
      }),
    );

    await this.recordActivity(
      ctx,
      input.petId,
      'vaccination.updated',
      `${vaccination.name} vaccination ${input.id ? 'updated' : 'added'}`,
      vaccination.id,
    );
    return vaccination;
  }

  async deleteVaccination(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    assertCan(ctx, petId, 'vaccination.edit');
    const result = await this.sb.from('vaccinations').delete().eq('id', id).eq('pet_id', petId);
    unwrapVoid(result, { subject: 'vaccination', capability: 'vaccination.edit', petId });
  }

  /* ----------------------------------------------------------- vet visits */

  async listVetVisits(ctx: ActorContext, petId: ID): Promise<VetVisit[]> {
    assertCan(ctx, petId, 'vetvisit.view');
    const result = await this.sb
      .from('vet_visits')
      .select(VET_VISIT_COLUMNS)
      .eq('pet_id', petId)
      .order('at', { ascending: false });

    return unwrapList<VetVisitRow>(result, {
      subject: 'vet visit',
      capability: 'vetvisit.view',
      petId,
    }).map(mapVetVisit);
  }

  async upsertVetVisit(ctx: ActorContext, input: VetVisitInput & { id?: ID }): Promise<VetVisit> {
    assertCan(ctx, input.petId, 'vetvisit.edit');

    const base = vetVisitRow(input);
    const result = input.id
      ? await this.sb
          .from('vet_visits')
          .update(base)
          .eq('id', input.id)
          .eq('pet_id', input.petId)
          .select(VET_VISIT_COLUMNS)
          .single()
      : await this.sb
          .from('vet_visits')
          .insert({ ...base, created_by: ctx.userId })
          .select(VET_VISIT_COLUMNS)
          .single();

    const visit = mapVetVisit(
      unwrapOne<VetVisitRow>(result, { subject: 'vet visit', capability: 'vetvisit.edit', petId: input.petId }),
    );

    if (!input.id) {
      await this.recordActivity(
        ctx,
        input.petId,
        'vetvisit.created',
        `Vet visit written up — ${visit.reason}`,
        visit.id,
      );
    }
    return visit;
  }

  async deleteVetVisit(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    assertCan(ctx, petId, 'vetvisit.edit');
    const result = await this.sb.from('vet_visits').delete().eq('id', id).eq('pet_id', petId);
    unwrapVoid(result, { subject: 'vet visit', capability: 'vetvisit.edit', petId });
  }

  /* ----------------------------------------------------------- documents */

  async listDocuments(ctx: ActorContext, petId: ID): Promise<PetDocument[]> {
    assertCan(ctx, petId, 'document.view');
    const result = await this.sb
      .from('documents')
      .select(DOCUMENT_COLUMNS)
      .eq('pet_id', petId)
      .order('uploaded_at', { ascending: false });

    return unwrapList<DocumentRow>(result, {
      subject: 'document',
      capability: 'document.view',
      petId,
    }).map(mapDocument);
  }

  async uploadDocument(ctx: ActorContext, input: DocumentInput): Promise<PetDocument> {
    assertCan(ctx, input.petId, 'document.upload');

    // The id is minted here so the object key and the row agree, which is what
    // lets the storage policies check ownership from the path alone.
    const id = randomUUID();
    const objectPath = `pets/${input.petId}/documents/${id}${extensionFor(input.uri, input.mimeType)}`;

    const bytes = await readLocalBytes(input.uri);
    const uploaded = await this.sb.storage
      .from(MEDIA_BUCKET)
      .upload(objectPath, bytes, { contentType: input.mimeType, upsert: false });
    if (uploaded.error) throw mapStorageError(uploaded.error, 'upload that document');

    let thumbnailPath: string | null = null;
    if (input.thumbnailUri) {
      const thumbPath = `pets/${input.petId}/thumbnails/${id}.jpg`;
      const thumbBytes = await readLocalBytes(input.thumbnailUri);
      const thumb = await this.sb.storage
        .from(MEDIA_BUCKET)
        .upload(thumbPath, thumbBytes, { contentType: 'image/jpeg', upsert: true });
      // A missing thumbnail is a cosmetic loss; the document itself is safe.
      if (!thumb.error) thumbnailPath = thumbPath;
    }

    const inserted = await this.sb
      .from('documents')
      .insert({
        id,
        pet_id: input.petId,
        title: input.title,
        kind: input.kind,
        mime_type: input.mimeType,
        storage_path: objectPath,
        thumbnail_path: thumbnailPath,
        size_bytes: input.sizeBytes ?? bytes.byteLength,
        page_count: input.pageCount,
        uploaded_by: ctx.userId,
      })
      .select(DOCUMENT_COLUMNS)
      .single();

    if (inserted.error) {
      // Don't leave an orphaned object behind paying for storage forever.
      await this.sb.storage.from(MEDIA_BUCKET).remove([objectPath]);
      throw mapPostgrestError(inserted.error, {
        subject: 'document',
        capability: 'document.upload',
        petId: input.petId,
      });
    }

    const document = mapDocument(unwrapOne<DocumentRow>(inserted, { subject: 'document' }));
    await this.recordActivity(
      ctx,
      input.petId,
      'document.uploaded',
      `${document.title} added to the records`,
      document.id,
    );
    return document;
  }

  async deleteDocument(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    // Owner-only, permanently: an x-ray deleted by a sitter isn't recoverable.
    assertCan(ctx, petId, 'document.delete');

    const existing = await this.sb
      .from('documents')
      .select('storage_path, thumbnail_path')
      .eq('id', id)
      .eq('pet_id', petId)
      .maybeSingle();

    const row = unwrapMaybe<Pick<DocumentRow, 'storage_path' | 'thumbnail_path'>>(existing, {
      subject: 'document',
      capability: 'document.delete',
      petId,
    });

    const deleted = await this.sb.from('documents').delete().eq('id', id).eq('pet_id', petId);
    unwrapVoid(deleted, { subject: 'document', capability: 'document.delete', petId });

    if (row) {
      const paths = [row.storage_path, row.thumbnail_path].filter((p): p is string => Boolean(p));
      if (paths.length > 0) await this.sb.storage.from(MEDIA_BUCKET).remove(paths);
    }
  }

  async resolveDocumentUrl(ctx: ActorContext, petId: ID, id: ID): Promise<string> {
    assertCan(ctx, petId, 'document.view');

    const result = await this.sb
      .from('documents')
      .select('storage_path')
      .eq('id', id)
      .eq('pet_id', petId)
      .single();

    const row = unwrapOne<Pick<DocumentRow, 'storage_path'>>(result, {
      subject: 'document',
      capability: 'document.view',
      petId,
    });

    const signed = await this.sb.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    if (signed.error) throw mapStorageError(signed.error, 'open that document');

    return signed.data.signedUrl;
  }

  /* ------------------------------------------------------------- feeding */

  async listFeedingSchedules(ctx: ActorContext, petId: ID): Promise<FeedingSchedule[]> {
    assertCan(ctx, petId, 'feeding.view');
    const result = await this.sb
      .from('feeding_schedules')
      .select(FEEDING_SCHEDULE_COLUMNS)
      .eq('pet_id', petId)
      .order('time_of_day', { ascending: true });

    return unwrapList<FeedingScheduleRow>(result, {
      subject: 'feeding schedule',
      capability: 'feeding.view',
      petId,
    }).map(mapFeedingSchedule);
  }

  async upsertFeedingSchedule(
    ctx: ActorContext,
    input: FeedingScheduleInput & { id?: ID },
  ): Promise<FeedingSchedule> {
    assertCan(ctx, input.petId, 'feeding.schedule.edit');

    const base = feedingScheduleRow(input);
    const result = input.id
      ? await this.sb
          .from('feeding_schedules')
          .update(base)
          .eq('id', input.id)
          .eq('pet_id', input.petId)
          .select(FEEDING_SCHEDULE_COLUMNS)
          .single()
      : await this.sb.from('feeding_schedules').insert(base).select(FEEDING_SCHEDULE_COLUMNS).single();

    return mapFeedingSchedule(
      unwrapOne<FeedingScheduleRow>(result, {
        subject: 'feeding schedule',
        capability: 'feeding.schedule.edit',
        petId: input.petId,
      }),
    );
  }

  async deleteFeedingSchedule(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    assertCan(ctx, petId, 'feeding.schedule.edit');
    const result = await this.sb.from('feeding_schedules').delete().eq('id', id).eq('pet_id', petId);
    unwrapVoid(result, { subject: 'feeding schedule', capability: 'feeding.schedule.edit', petId });
  }

  async listFeedingLogs(
    ctx: ActorContext,
    petId: ID,
    opts?: { since?: string; limit?: number },
  ): Promise<FeedingLog[]> {
    assertCan(ctx, petId, 'feeding.view');

    let query = this.sb
      .from('feeding_logs')
      .select(FEEDING_LOG_COLUMNS)
      .eq('pet_id', petId)
      .order('at', { ascending: false });

    if (opts?.since) query = query.gte('at', opts.since);
    if (opts?.limit) query = query.limit(opts.limit);

    return unwrapList<FeedingLogRow>(await query, {
      subject: 'meal',
      capability: 'feeding.view',
      petId,
    }).map(mapFeedingLog);
  }

  async logFeeding(ctx: ActorContext, input: FeedingLogInput): Promise<FeedingLog> {
    assertCan(ctx, input.petId, 'feeding.log');

    const result = await this.sb
      .from('feeding_logs')
      .insert({
        pet_id: input.petId,
        schedule_id: input.scheduleId ?? null,
        at: input.at ?? new Date().toISOString(),
        food_name: input.foodName,
        portion: input.portion,
        unit: input.unit,
        skipped: input.skipped ?? false,
        logged_by: ctx.userId,
        note: input.note ?? null,
      })
      .select(FEEDING_LOG_COLUMNS)
      .single();

    const log = mapFeedingLog(
      unwrapOne<FeedingLogRow>(result, { subject: 'meal', capability: 'feeding.log', petId: input.petId }),
    );

    await this.recordActivity(
      ctx,
      input.petId,
      log.skipped ? 'feeding.skipped' : 'feeding.logged',
      log.skipped
        ? `${log.foodName} was skipped`
        : `${log.foodName} logged — ${log.portion} ${log.unit}`,
      log.id,
      { portion: log.portion, unit: log.unit },
    );
    return log;
  }

  async undoFeedingLog(ctx: ActorContext, petId: ID, logId: ID): Promise<void> {
    assertCan(ctx, petId, 'feeding.log');
    const result = await this.sb.from('feeding_logs').delete().eq('id', logId).eq('pet_id', petId);
    unwrapVoid(result, { subject: 'meal', capability: 'feeding.log', petId });
  }

  /* ------------------------------------------------------------ medicine */

  async listMedicines(ctx: ActorContext, petId: ID): Promise<Medicine[]> {
    assertCan(ctx, petId, 'medicine.view');
    const result = await this.sb
      .from('medicines')
      .select(MEDICINE_COLUMNS)
      .eq('pet_id', petId)
      .order('active', { ascending: false })
      .order('name', { ascending: true });

    return unwrapList<MedicineRow>(result, {
      subject: 'medicine',
      capability: 'medicine.view',
      petId,
    }).map(mapMedicine);
  }

  async upsertMedicine(ctx: ActorContext, input: MedicineInput & { id?: ID }): Promise<Medicine> {
    // medicine.edit is owner-only — a sitter logs doses, never the prescription.
    assertCan(ctx, input.petId, 'medicine.edit');

    const base = medicineRow(input);
    const result = input.id
      ? await this.sb
          .from('medicines')
          .update(base)
          .eq('id', input.id)
          .eq('pet_id', input.petId)
          .select(MEDICINE_COLUMNS)
          .single()
      : await this.sb.from('medicines').insert(base).select(MEDICINE_COLUMNS).single();

    return mapMedicine(
      unwrapOne<MedicineRow>(result, {
        subject: 'medicine',
        capability: 'medicine.edit',
        petId: input.petId,
      }),
    );
  }

  async deleteMedicine(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    assertCan(ctx, petId, 'medicine.edit');
    const result = await this.sb.from('medicines').delete().eq('id', id).eq('pet_id', petId);
    unwrapVoid(result, { subject: 'medicine', capability: 'medicine.edit', petId });
  }

  async listMedicineLogs(
    ctx: ActorContext,
    petId: ID,
    opts?: { since?: string; limit?: number },
  ): Promise<MedicineLog[]> {
    assertCan(ctx, petId, 'medicine.view');

    let query = this.sb
      .from('medicine_logs')
      .select(MEDICINE_LOG_COLUMNS)
      .eq('pet_id', petId)
      .order('scheduled_for', { ascending: false });

    if (opts?.since) query = query.gte('scheduled_for', opts.since);
    if (opts?.limit) query = query.limit(opts.limit);

    return unwrapList<MedicineLogRow>(await query, {
      subject: 'dose',
      capability: 'medicine.view',
      petId,
    }).map(mapMedicineLog);
  }

  async logDose(ctx: ActorContext, input: MedicineLogInput): Promise<MedicineLog> {
    assertCan(ctx, input.petId, 'medicine.log');

    // One row per slot: tapping "given" after "skipped" corrects the record
    // rather than counting the dose twice. The pack count follows via trigger.
    const result = await this.sb
      .from('medicine_logs')
      .upsert(
        {
          pet_id: input.petId,
          medicine_id: input.medicineId,
          scheduled_for: input.scheduledFor,
          at: input.at ?? (input.status === 'given' ? new Date().toISOString() : null),
          status: input.status,
          dosage: input.dosage ?? null,
          logged_by: ctx.userId,
          note: input.note ?? null,
        },
        { onConflict: 'medicine_id,scheduled_for' },
      )
      .select(MEDICINE_LOG_COLUMNS)
      .single();

    const log = mapMedicineLog(
      unwrapOne<MedicineLogRow>(result, {
        subject: 'dose',
        capability: 'medicine.log',
        petId: input.petId,
      }),
    );

    if (log.status !== 'missed') {
      await this.recordActivity(
        ctx,
        input.petId,
        log.status === 'given' ? 'medicine.given' : 'medicine.skipped',
        log.status === 'given' ? 'Dose given' : 'Dose skipped',
        log.id,
        { medicineId: log.medicineId },
      );
    }
    return log;
  }

  async undoDose(ctx: ActorContext, petId: ID, logId: ID): Promise<void> {
    assertCan(ctx, petId, 'medicine.log');
    const result = await this.sb.from('medicine_logs').delete().eq('id', logId).eq('pet_id', petId);
    unwrapVoid(result, { subject: 'dose', capability: 'medicine.log', petId });
  }

  async getAdherence(
    ctx: ActorContext,
    petId: ID,
    medicineId: ID,
    windowDays: number,
  ): Promise<AdherenceSummary> {
    assertCan(ctx, petId, 'medicine.view');

    const result = await this.sb.rpc('adherence_summary', {
      p_medicine: medicineId,
      p_days: windowDays,
      p_tz: deviceTimeZone(),
    });

    const json = unwrapOne<AdherenceJson>(result, {
      subject: 'medicine',
      capability: 'medicine.view',
      petId,
    });

    return {
      medicineId: json.medicineId,
      windowDays: json.windowDays,
      expected: json.expected,
      given: json.given,
      skipped: json.skipped,
      missed: json.missed,
      rate: toNumberOr(json.rate, 0),
      streakDays: json.streakDays,
      daily: (json.daily ?? []).map((day) => ({
        date: day.date,
        expected: day.expected,
        given: day.given,
      })),
    };
  }

  async recordRefill(
    ctx: ActorContext,
    petId: ID,
    medicineId: ID,
    doses: number,
    refillAt: DateOnly | null,
  ): Promise<Medicine> {
    assertCan(ctx, petId, 'medicine.edit');

    const result = await this.sb
      .from('medicines')
      .update({ remaining_doses: doses, refill_at: refillAt })
      .eq('id', medicineId)
      .eq('pet_id', petId)
      .select(MEDICINE_COLUMNS)
      .single();

    return mapMedicine(
      unwrapOne<MedicineRow>(result, { subject: 'medicine', capability: 'medicine.edit', petId }),
    );
  }

  /* -------------------------------------------------------- appointments */

  async listAppointments(
    ctx: ActorContext,
    petId: ID,
    opts?: { from?: string; to?: string },
  ): Promise<Appointment[]> {
    assertCan(ctx, petId, 'appointment.view');

    let query = this.sb
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('pet_id', petId)
      .order('at', { ascending: true });

    if (opts?.from) query = query.gte('at', opts.from);
    if (opts?.to) query = query.lte('at', opts.to);

    return unwrapList<AppointmentRow>(await query, {
      subject: 'appointment',
      capability: 'appointment.view',
      petId,
    }).map(mapAppointment);
  }

  async listUpcomingAppointments(ctx: ActorContext, opts?: { limit?: number }): Promise<Appointment[]> {
    void ctx;
    const result = await this.sb
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .gte('at', new Date().toISOString())
      .in('status', ['scheduled', 'confirmed'])
      .order('at', { ascending: true })
      .limit(opts?.limit ?? 10);

    return unwrapList<AppointmentRow>(result, { subject: 'appointment' }).map(mapAppointment);
  }

  async upsertAppointment(
    ctx: ActorContext,
    input: AppointmentInput & { id?: ID },
  ): Promise<Appointment> {
    assertCan(ctx, input.petId, input.id ? 'appointment.edit' : 'appointment.create');

    const base = appointmentRow(input);
    const result = input.id
      ? await this.sb
          .from('appointments')
          .update(base)
          .eq('id', input.id)
          .eq('pet_id', input.petId)
          .select(APPOINTMENT_COLUMNS)
          .single()
      : await this.sb
          .from('appointments')
          .insert({ ...base, created_by: ctx.userId })
          .select(APPOINTMENT_COLUMNS)
          .single();

    const appointment = mapAppointment(
      unwrapOne<AppointmentRow>(result, {
        subject: 'appointment',
        capability: input.id ? 'appointment.edit' : 'appointment.create',
        petId: input.petId,
      }),
    );

    await this.recordActivity(
      ctx,
      input.petId,
      input.id ? 'appointment.updated' : 'appointment.created',
      `${appointment.reason} ${input.id ? 'updated' : 'booked'}`,
      appointment.id,
    );
    return appointment;
  }

  async deleteAppointment(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    assertCan(ctx, petId, 'appointment.edit');
    const result = await this.sb.from('appointments').delete().eq('id', id).eq('pet_id', petId);
    unwrapVoid(result, { subject: 'appointment', capability: 'appointment.edit', petId });
  }

  /* ----------------------------------------------------------- care tasks */

  async listCareTasks(ctx: ActorContext, date: DateOnly, opts?: { petId?: ID }): Promise<CareTask[]> {
    const petIds = await this.resolvePetIds(ctx, opts?.petId, 'pet.view');
    if (petIds.length === 0) return [];

    const timeZone = deviceTimeZone();
    const batches = await Promise.all(
      petIds.map((petId) =>
        this.sb.rpc('care_tasks_for_day', { p_pet: petId, p_date: date, p_tz: timeZone }),
      ),
    );

    const tasks = batches.flatMap((batch) =>
      unwrapList<CareTaskRow>(batch, { subject: 'task' }).map(mapCareTask),
    );

    return tasks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.title.localeCompare(b.title));
  }

  async getDaySummaries(
    ctx: ActorContext,
    from: DateOnly,
    to: DateOnly,
    opts?: { petId?: ID },
  ): Promise<DaySummary[]> {
    const petIds = await this.resolvePetIds(ctx, opts?.petId, 'pet.view');
    if (petIds.length === 0) return [];

    const timeZone = deviceTimeZone();
    const batches = await Promise.all(
      petIds.map((petId) =>
        this.sb.rpc('care_day_summaries', {
          p_pet: petId,
          p_from: from,
          p_to: to,
          p_tz: timeZone,
        }),
      ),
    );

    // One pet per call, so multi-pet days are merged here rather than in SQL.
    const merged = new Map<DateOnly, DaySummary>();
    for (const batch of batches) {
      for (const row of unwrapList<DaySummaryRow>(batch, { subject: 'day' })) {
        const existing = merged.get(row.date);
        if (existing) {
          existing.total += row.total;
          existing.done += row.done;
          existing.overdue += row.overdue;
        } else {
          merged.set(row.date, {
            date: row.date,
            total: row.total,
            done: row.done,
            overdue: row.overdue,
          });
        }
      }
    }

    return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * One pet, or every pet the actor may see. Memberships come from the actor
   * context so the common case costs nothing; the fetch is the fallback for a
   * context that hasn't caught up with a just-created pet.
   */
  private async resolvePetIds(
    ctx: ActorContext,
    petId: ID | undefined,
    capability: Capability,
  ): Promise<ID[]> {
    if (petId) {
      assertCan(ctx, petId, capability);
      return [petId];
    }

    const fromContext = ctx.memberships
      .filter((m) => m.userId === ctx.userId)
      .map((m) => m.petId)
      .filter((id, index, all) => all.indexOf(id) === index);

    if (fromContext.length > 0) return fromContext;

    const pets = await this.listPets(ctx);
    return pets.map((pet) => pet.id);
  }

  /* ---------------------------------------------------------- caregivers */

  async listMemberships(ctx: ActorContext, petId: ID): Promise<MembershipWithUser[]> {
    assertCan(ctx, petId, 'caregiver.view');

    const result = await this.sb
      .from('memberships')
      .select(`${MEMBERSHIP_COLUMNS}, user:profiles!memberships_user_id_fkey(${PROFILE_COLUMNS})`)
      .eq('pet_id', petId)
      .order('created_at', { ascending: true });

    return unwrapList<MembershipWithUserRow>(result, {
      subject: 'caregiver',
      capability: 'caregiver.view',
      petId,
    }).map((row) => ({ ...mapMembership(row), user: mapAuthorOr(row.user, row.user_id) }));
  }

  async listMyMemberships(ctx: ActorContext): Promise<Membership[]> {
    const result = await this.sb
      .from('memberships')
      .select(MEMBERSHIP_COLUMNS)
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: true });

    return unwrapList<MembershipRow>(result, { subject: 'membership' }).map(mapMembership);
  }

  async createInvite(ctx: ActorContext, input: InviteInput): Promise<Invite> {
    assertCan(ctx, input.petId, 'caregiver.invite');

    const pet = await this.getPet(ctx, input.petId);
    if (!pet) throw new NotFoundError('pet');

    const ttlDays = input.linkTtlDays ?? 7;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    // Clamped here as well as in accept_invite(): a grant that can never be
    // honoured shouldn't be shown to the owner as if it had been given.
    const grants = sanitizeGrants(input.grants);

    // Codes are short and human-typeable, so collisions are rare but real.
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await this.sb
        .from('invites')
        .insert({
          pet_id: input.petId,
          code: inviteCodeFor(pet.name),
          created_by: ctx.userId,
          preset_id: input.presetId,
          grants,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
          expires_at: expiresAt,
          max_uses: input.maxUses ?? 1,
          invitee_name: input.inviteeName ?? null,
          invitee_email: input.inviteeEmail ?? null,
        })
        .select(INVITE_COLUMNS)
        .single();

      if (!result.error) {
        const invite = mapInvite(unwrapOne<InviteRow>(result, { subject: 'invite' }));
        await this.recordActivity(
          ctx,
          input.petId,
          'caregiver.invited',
          `${input.inviteeName ?? 'A caregiver'} was invited to help with ${pet.name}`,
          invite.id,
          { presetId: invite.presetId },
        );
        return invite;
      }

      lastError = mapPostgrestError(result.error, {
        subject: 'invite',
        capability: 'caregiver.invite',
        petId: input.petId,
      });
      if (!(lastError instanceof ConflictError)) throw lastError;
    }

    throw lastError ?? new DataError('server', "We couldn't create that invite. Try again.");
  }

  async listInvites(ctx: ActorContext, petId: ID): Promise<Invite[]> {
    assertCan(ctx, petId, 'caregiver.view');

    const result = await this.sb
      .from('invites')
      .select(INVITE_COLUMNS)
      .eq('pet_id', petId)
      .order('created_at', { ascending: false });

    return unwrapList<InviteRow>(result, {
      subject: 'invite',
      capability: 'caregiver.view',
      petId,
    }).map(mapInvite);
  }

  async revokeInvite(ctx: ActorContext, petId: ID, inviteId: ID): Promise<void> {
    assertCan(ctx, petId, 'caregiver.revoke');
    const result = await this.sb
      .from('invites')
      .update({ status: 'revoked' })
      .eq('id', inviteId)
      .eq('pet_id', petId);
    unwrapVoid(result, { subject: 'invite', capability: 'caregiver.revoke', petId });
  }

  async peekInvite(code: string): Promise<{ invite: Invite; pet: Pet; owner: User } | null> {
    const result = await this.sb.rpc('peek_invite', { code: code.trim() });
    const json = unwrapMaybe<PeekInviteJson>(result, { subject: 'invite' });
    if (!json) return null;

    return {
      invite: {
        id: json.invite.id,
        petId: json.invite.petId,
        code: json.invite.code,
        createdBy: json.invite.createdBy,
        presetId: json.invite.presetId,
        grants: json.invite.grants ?? [],
        startsAt: isoOrNull(json.invite.startsAt),
        endsAt: isoOrNull(json.invite.endsAt),
        expiresAt: iso(json.invite.expiresAt),
        maxUses: json.invite.maxUses,
        uses: json.invite.uses,
        status: json.invite.status,
        inviteeName: json.invite.inviteeName,
        inviteeEmail: json.invite.inviteeEmail,
        createdAt: iso(json.invite.createdAt),
      },
      // Identity only — see peek_invite() in 0003_functions.sql for why.
      pet: mapPetCard({
        id: json.pet.id,
        owner_id: json.pet.ownerId,
        name: json.pet.name,
        species: json.pet.species,
        breed: json.pet.breed,
        photo_url: json.pet.photoUrl,
        created_at: json.pet.createdAt,
      }),
      owner: {
        id: json.owner.id,
        email: '',
        displayName: json.owner.displayName,
        avatarUrl: json.owner.avatarUrl,
        bio: json.owner.bio,
        createdAt: iso(json.owner.createdAt),
      },
    };
  }

  async acceptInvite(ctx: ActorContext, code: string): Promise<Membership> {
    void ctx;
    const result = await this.sb.rpc('accept_invite', { code: code.trim() });
    const row = unwrapOne<MembershipRow>(result, { subject: 'invite' });
    return mapMembership(row);
  }

  async updateMembership(
    ctx: ActorContext,
    petId: ID,
    membershipId: ID,
    patch: MembershipPatch,
  ): Promise<Membership> {
    assertCan(ctx, petId, 'caregiver.invite');

    const row = compact({
      grants: patch.grants ? sanitizeGrants(patch.grants) : undefined,
      starts_at: patch.startsAt,
      ends_at: patch.endsAt,
      status: patch.status,
    });

    const result = await this.sb
      .from('memberships')
      .update(row)
      .eq('id', membershipId)
      .eq('pet_id', petId)
      .select(MEMBERSHIP_COLUMNS)
      .single();

    return mapMembership(
      unwrapOne<MembershipRow>(result, {
        subject: 'caregiver',
        capability: 'caregiver.invite',
        petId,
      }),
    );
  }

  async revokeMembership(ctx: ActorContext, petId: ID, membershipId: ID): Promise<void> {
    assertCan(ctx, petId, 'caregiver.revoke');

    // Revoked, not deleted: the activity log still has to explain who did what
    // while they had access.
    const result = await this.sb
      .from('memberships')
      .update({ status: 'revoked' })
      .eq('id', membershipId)
      .eq('pet_id', petId)
      .select(MEMBERSHIP_COLUMNS)
      .maybeSingle();

    const row = unwrapMaybe<MembershipRow>(result, {
      subject: 'caregiver',
      capability: 'caregiver.revoke',
      petId,
    });

    if (row) {
      await this.recordActivity(ctx, petId, 'caregiver.revoked', 'Caregiver access was removed', row.id);
    }
  }

  /* ------------------------------------------------------------- activity */

  async listActivity(
    ctx: ActorContext,
    petId: ID,
    opts?: { limit?: number; cursor?: string },
  ): Promise<Page<ActivityEvent>> {
    assertCan(ctx, petId, 'activity.view');

    const limit = opts?.limit ?? 30;
    let query = this.sb
      .from('activity_events')
      .select(ACTIVITY_COLUMNS)
      .eq('pet_id', petId)
      .order('at', { ascending: false })
      .limit(limit + 1);

    if (opts?.cursor) query = query.lt('at', opts.cursor);

    const rows = unwrapList<ActivityRow>(await query, {
      subject: 'activity',
      capability: 'activity.view',
      petId,
    });

    // One extra row is fetched purely to answer "is there another page?".
    const items = rows.slice(0, limit).map(mapActivity);
    const nextCursor = rows.length > limit ? (items[items.length - 1]?.at ?? null) : null;
    return { items, nextCursor };
  }

  async listCaregiverActivity(ctx: ActorContext, opts?: { limit?: number }): Promise<ActivityEvent[]> {
    const ownedPetIds = ctx.memberships
      .filter((m) => m.userId === ctx.userId && m.role === 'owner')
      .map((m) => m.petId);

    if (ownedPetIds.length === 0) return [];

    const result = await this.sb
      .from('activity_events')
      .select(ACTIVITY_COLUMNS)
      .in('pet_id', ownedPetIds)
      .neq('actor_id', ctx.userId)
      .order('at', { ascending: false })
      .limit(opts?.limit ?? 25);

    return unwrapList<ActivityRow>(result, { subject: 'activity' }).map(mapActivity);
  }

  /**
   * Best-effort audit line. A failed insert here must never fail the care
   * action that caused it — a meal that was logged but not narrated is far
   * better than a meal that wasn't logged.
   */
  private async recordActivity(
    ctx: ActorContext,
    petId: ID,
    action: ActivityAction,
    summary: string,
    entityId: ID | null,
    meta: Record<string, string | number | boolean | null> = {},
  ): Promise<void> {
    const membership = membershipFor(ctx, petId);
    const { error } = await this.sb.from('activity_events').insert({
      pet_id: petId,
      actor_id: ctx.userId,
      actor_role: membership?.role ?? 'caregiver',
      action,
      summary,
      entity_id: entityId,
      meta,
    });

    if (error && __DEV__) {
      console.warn(`[petal] activity "${action}" not recorded: ${error.message}`);
    }
  }

  /* ------------------------------------------------------------ community */

  async listFeed(
    ctx: ActorContext,
    opts?: { cursor?: string; limit?: number; scope?: FeedScope },
  ): Promise<Page<PostWithAuthor>> {
    const limit = opts?.limit ?? 20;

    let query = this.sb
      .from('posts')
      .select(POST_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    const scope: FeedScope = opts?.scope ?? {};
    if (scope.groupId) query = query.eq('group_id', scope.groupId);
    if (scope.authorId) query = query.eq('author_id', scope.authorId);
    if (scope.petId) query = query.eq('pet_id', scope.petId);
    if (opts?.cursor) query = query.lt('created_at', opts.cursor);

    const rows = unwrapList<PostRow>(await query, { subject: 'post' });
    const page = rows.slice(0, limit);
    const items = await this.decoratePosts(ctx, page);
    const nextCursor = rows.length > limit ? (items[items.length - 1]?.createdAt ?? null) : null;

    return { items, nextCursor };
  }

  async getPost(ctx: ActorContext, postId: ID): Promise<PostWithAuthor | null> {
    const result = await this.sb.from('posts').select(POST_COLUMNS).eq('id', postId).maybeSingle();
    const row = unwrapMaybe<PostRow>(result, { subject: 'post' });
    if (!row) return null;
    const [post] = await this.decoratePosts(ctx, [row]);
    return post ?? null;
  }

  /**
   * Fills in the three things a post row can't carry on its own: whether *you*
   * liked it, the pet card (which lives behind its own view — see 0001), and
   * whether you're in the group it was posted to.
   */
  private async decoratePosts(ctx: ActorContext, rows: PostRow[]): Promise<PostWithAuthor[]> {
    if (rows.length === 0) return [];

    const postIds = rows.map((row) => row.id);
    const petIds = [...new Set(rows.map((row) => row.pet_id).filter((id): id is string => Boolean(id)))];
    const groupIds = [...new Set(rows.map((row) => row.group_id).filter((id): id is string => Boolean(id)))];

    const [likes, pets, joinedGroups] = await Promise.all([
      this.sb.from('post_likes').select('post_id').eq('user_id', ctx.userId).in('post_id', postIds),
      petIds.length > 0
        ? this.sb.from('pet_cards').select(PET_CARD_COLUMNS).in('id', petIds)
        : Promise.resolve({ data: [] as PetCardRow[], error: null }),
      groupIds.length > 0
        ? this.sb.from('group_members').select('group_id').eq('user_id', ctx.userId).in('group_id', groupIds)
        : Promise.resolve({ data: [] as { group_id: string }[], error: null }),
    ]);

    const likedIds = new Set(
      unwrapList<{ post_id: string }>(likes, { subject: 'post' }).map((row) => row.post_id),
    );
    const petById = new Map(
      unwrapList<PetCardRow>(pets, { subject: 'pet' }).map((row) => [row.id, mapPetCard(row)]),
    );
    const joinedIds = new Set(
      unwrapList<{ group_id: string }>(joinedGroups, { subject: 'group' }).map((row) => row.group_id),
    );

    return rows.map((row) => ({
      ...mapPost(row, likedIds.has(row.id)),
      author: mapAuthorOr(row.author, row.author_id),
      pet: row.pet_id ? (petById.get(row.pet_id) ?? null) : null,
      group: row.group ? mapGroup(row.group, joinedIds.has(row.group.id)) : null,
    }));
  }

  async createPost(ctx: ActorContext, input: PostInput): Promise<Post> {
    if (input.petId) assertCan(ctx, input.petId, 'community.post');

    const result = await this.sb
      .from('posts')
      .insert({
        author_id: ctx.userId,
        pet_id: input.petId,
        group_id: input.groupId,
        body: input.body,
        image_urls: input.imageUrls,
      })
      .select(POST_COLUMNS)
      .single();

    const row = unwrapOne<PostRow>(result, {
      subject: 'post',
      ...(input.petId ? { capability: 'community.post' as const, petId: input.petId } : null),
    });
    return mapPost(row, false);
  }

  async deletePost(ctx: ActorContext, postId: ID): Promise<void> {
    const result = await this.sb.from('posts').delete().eq('id', postId).eq('author_id', ctx.userId);
    unwrapVoid(result, { subject: 'post' });
  }

  async toggleLike(ctx: ActorContext, postId: ID, liked: boolean): Promise<Post> {
    if (liked) {
      const result = await this.sb
        .from('post_likes')
        .upsert({ post_id: postId, user_id: ctx.userId }, { onConflict: 'post_id,user_id' });
      unwrapVoid(result, { subject: 'post' });
    } else {
      const result = await this.sb
        .from('post_likes')
        .delete()
        .eq('post_id', postId)
        .eq('user_id', ctx.userId);
      unwrapVoid(result, { subject: 'post' });
    }

    // Re-read so the returned count is the server's, not an optimistic guess.
    const refreshed = await this.sb.from('posts').select(POST_COLUMNS).eq('id', postId).single();
    return mapPost(unwrapOne<PostRow>(refreshed, { subject: 'post' }), liked);
  }

  async listComments(ctx: ActorContext, postId: ID): Promise<CommentWithAuthor[]> {
    const comments = await this.sb
      .from('comments')
      .select(COMMENT_COLUMNS)
      .eq('post_id', postId)
      .order('created_at', { ascending: true });

    const rows = unwrapList<CommentRow>(comments, { subject: 'comment' });
    if (rows.length === 0) return [];

    // Scoped to this thread's ids — the like table grows with the whole app.
    const likes = await this.sb
      .from('comment_likes')
      .select('comment_id')
      .eq('user_id', ctx.userId)
      .in(
        'comment_id',
        rows.map((row) => row.id),
      );

    const likedIds = new Set(
      unwrapList<{ comment_id: string }>(likes, { subject: 'comment' }).map((row) => row.comment_id),
    );

    return rows.map((row) => ({
      ...mapComment(row, likedIds.has(row.id)),
      author: mapAuthorOr(row.author, row.author_id),
    }));
  }

  async addComment(ctx: ActorContext, postId: ID, body: string): Promise<Comment> {
    const result = await this.sb
      .from('comments')
      .insert({ post_id: postId, author_id: ctx.userId, body })
      .select(COMMENT_COLUMNS)
      .single();

    return mapComment(unwrapOne<CommentRow>(result, { subject: 'comment' }), false);
  }

  async deleteComment(ctx: ActorContext, postId: ID, commentId: ID): Promise<void> {
    void ctx;
    const result = await this.sb.from('comments').delete().eq('id', commentId).eq('post_id', postId);
    unwrapVoid(result, { subject: 'comment' });
  }

  async listGroups(ctx: ActorContext): Promise<Group[]> {
    const [groups, memberships] = await Promise.all([
      this.sb.from('groups').select(GROUP_COLUMNS).order('member_count', { ascending: false }),
      this.sb.from('group_members').select('group_id').eq('user_id', ctx.userId),
    ]);

    const joinedIds = new Set(
      unwrapList<{ group_id: string }>(memberships, { subject: 'group' }).map((row) => row.group_id),
    );

    return unwrapList<GroupRow>(groups, { subject: 'group' }).map((row) =>
      mapGroup(row, joinedIds.has(row.id)),
    );
  }

  async getGroup(ctx: ActorContext, groupId: ID): Promise<Group | null> {
    const [group, membership] = await Promise.all([
      this.sb.from('groups').select(GROUP_COLUMNS).eq('id', groupId).maybeSingle(),
      this.sb
        .from('group_members')
        .select('group_id')
        .eq('user_id', ctx.userId)
        .eq('group_id', groupId)
        .maybeSingle(),
    ]);

    const row = unwrapMaybe<GroupRow>(group, { subject: 'group' });
    if (!row) return null;

    const joined = unwrapMaybe<{ group_id: string }>(membership, { subject: 'group' }) !== null;
    return mapGroup(row, joined);
  }

  async toggleGroupMembership(ctx: ActorContext, groupId: ID, joined: boolean): Promise<Group> {
    if (joined) {
      const result = await this.sb
        .from('group_members')
        .upsert({ group_id: groupId, user_id: ctx.userId }, { onConflict: 'group_id,user_id' });
      unwrapVoid(result, { subject: 'group' });
    } else {
      const result = await this.sb
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', ctx.userId);
      unwrapVoid(result, { subject: 'group' });
    }

    const refreshed = await this.sb.from('groups').select(GROUP_COLUMNS).eq('id', groupId).single();
    return mapGroup(unwrapOne<GroupRow>(refreshed, { subject: 'group' }), joined);
  }

  /* ---------------------------------------------------------------- users */

  async getUser(ctx: ActorContext, userId: ID): Promise<User | null> {
    void ctx;
    const result = await this.sb.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle();
    const row = unwrapMaybe<ProfileRow>(result, { subject: 'profile' });
    return row ? mapUser(row) : null;
  }

  /* ------------------------------------------------------------------ dev */

  async resetDemoData(): Promise<void> {
    throw new DataError(
      'invalid',
      'Demo data only exists in the offline build — this app is talking to the live database.',
    );
  }
}

export default SupabaseAdapter;
