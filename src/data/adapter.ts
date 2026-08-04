/**
 * Petal — data adapter contract.
 *
 * Everything above this line (React Query hooks, screens) talks only to this
 * interface. Two implementations satisfy it:
 *
 *   · `MockAdapter`      — seeded, offline, AsyncStorage-backed. Ships in the
 *                          repo so the app is fully explorable with zero setup.
 *   · `SupabaseAdapter`  — real Postgres + Storage + Auth.
 *
 * Which one loads is decided once, in `data/index.ts`, from
 * `EXPO_PUBLIC_SUPABASE_URL`. No screen knows or cares.
 *
 * **RBAC is enforced here, not only in the UI.** Every mutation takes the acting
 * user's membership context and runs `assertCan()` before touching a row, so a
 * screen that forgets to hide a button still cannot write. The Supabase adapter
 * additionally relies on RLS policies that mirror the same matrices — the client
 * check is for instant feedback, the RLS check is the actual boundary.
 */

import {
  evaluate,
  PermissionError,
  type Capability,
  type Membership,
} from '../rbac/permissions';
import type {
  ActivityEvent,
  AdherenceSummary,
  Appointment,
  CareTask,
  Comment,
  CommentWithAuthor,
  DateOnly,
  DaySummary,
  DoseStatus,
  FeedingLog,
  FeedingSchedule,
  Group,
  ID,
  Invite,
  Medicine,
  MedicineLog,
  MembershipWithUser,
  Pet,
  PetDocument,
  Post,
  PostWithAuthor,
  PresetId,
  Session,
  User,
  Vaccination,
  VetVisit,
  WeightEntry,
} from './types';

/* ------------------------------------------------------------------ context */

/**
 * Who is acting, and what they hold. Passed into every mutation so the adapter
 * can authorise without reaching into React state.
 */
export type ActorContext = {
  userId: ID;
  memberships: Membership[];
};

export function membershipFor(ctx: ActorContext, petId: ID): Membership | null {
  return ctx.memberships.find((m) => m.petId === petId && m.userId === ctx.userId) ?? null;
}

/**
 * The data-layer half of the RBAC boundary. Throws `PermissionError` — which the
 * query layer converts into a warm, explanatory toast rather than a raw error.
 */
export function assertCan(ctx: ActorContext, petId: ID, capability: Capability): Membership {
  const membership = membershipFor(ctx, petId);
  const verdict = evaluate(membership, capability);
  if (!verdict.allowed) {
    throw new PermissionError(capability, petId, verdict.reason);
  }
  return membership!;
}

/* ------------------------------------------------------------------ inputs */

export type SignUpInput = { email: string; password: string; displayName: string };
export type SignInInput = { email: string; password: string };
export type OAuthProvider = 'google' | 'apple';

export type PetInput = Omit<Pet, 'id' | 'ownerId' | 'createdAt' | 'currentWeightKg' | 'archivedAt'>;
export type PetPatch = Partial<Omit<Pet, 'id' | 'ownerId' | 'createdAt'>>;

export type WeightInput = { petId: ID; kg: number; recordedAt?: string; note?: string | null };
export type VaccinationInput = Omit<Vaccination, 'id' | 'createdAt' | 'createdBy'>;
export type VetVisitInput = Omit<VetVisit, 'id' | 'createdAt' | 'createdBy'>;
export type DocumentInput = Omit<PetDocument, 'id' | 'uploadedAt' | 'uploadedBy' | 'thumbnailUri'> & {
  thumbnailUri?: string | null;
};

export type FeedingScheduleInput = Omit<FeedingSchedule, 'id' | 'createdAt'>;
export type FeedingLogInput = {
  petId: ID;
  scheduleId?: ID | null;
  at?: string;
  foodName: string;
  portion: number;
  unit: FeedingSchedule['unit'];
  skipped?: boolean;
  note?: string | null;
};

export type MedicineInput = Omit<Medicine, 'id' | 'createdAt'>;
export type MedicineLogInput = {
  petId: ID;
  medicineId: ID;
  scheduledFor: string;
  status: DoseStatus;
  at?: string | null;
  dosage?: string | null;
  note?: string | null;
};

export type AppointmentInput = Omit<Appointment, 'id' | 'createdAt' | 'createdBy' | 'vetVisitId'>;

export type InviteInput = {
  petId: ID;
  presetId: PresetId;
  grants: Capability[];
  startsAt: string | null;
  endsAt: string | null;
  inviteeName?: string | null;
  inviteeEmail?: string | null;
  /** Days until the *link* expires (not the access window). */
  linkTtlDays?: number;
  maxUses?: number;
};

export type MembershipPatch = {
  grants?: Capability[];
  startsAt?: string | null;
  endsAt?: string | null;
  status?: Membership['status'];
};

export type PostInput = {
  petId: ID | null;
  groupId: ID | null;
  body: string;
  imageUrls: string[];
};

export type FeedScope = { groupId?: ID | null; authorId?: ID | null; petId?: ID | null };
export type Page<T> = { items: T[]; nextCursor: string | null };

/* ----------------------------------------------------------------- adapter */

export interface DataAdapter {
  readonly kind: 'mock' | 'supabase';

  /* ---- auth ------------------------------------------------------------ */
  getSession(): Promise<Session | null>;
  signIn(input: SignInInput): Promise<Session>;
  signUp(input: SignUpInput): Promise<Session>;
  signInWithOAuth(provider: OAuthProvider): Promise<Session>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  updateProfile(ctx: ActorContext, patch: Partial<Pick<User, 'displayName' | 'avatarUrl' | 'bio'>>): Promise<User>;
  /** Fires when auth state changes out-of-band (token refresh, sign-out elsewhere). */
  onSessionChange(listener: (session: Session | null) => void): () => void;

  /* ---- pets ------------------------------------------------------------ */
  listPets(ctx: ActorContext): Promise<Pet[]>;
  getPet(ctx: ActorContext, petId: ID): Promise<Pet | null>;
  createPet(ctx: ActorContext, input: PetInput): Promise<Pet>;
  updatePet(ctx: ActorContext, petId: ID, patch: PetPatch): Promise<Pet>;
  deletePet(ctx: ActorContext, petId: ID): Promise<void>;

  /* ---- weight ---------------------------------------------------------- */
  listWeights(ctx: ActorContext, petId: ID): Promise<WeightEntry[]>;
  addWeight(ctx: ActorContext, input: WeightInput): Promise<WeightEntry>;
  deleteWeight(ctx: ActorContext, petId: ID, entryId: ID): Promise<void>;

  /* ---- vaccinations ---------------------------------------------------- */
  listVaccinations(ctx: ActorContext, petId: ID): Promise<Vaccination[]>;
  upsertVaccination(ctx: ActorContext, input: VaccinationInput & { id?: ID }): Promise<Vaccination>;
  deleteVaccination(ctx: ActorContext, petId: ID, id: ID): Promise<void>;

  /* ---- vet visits ------------------------------------------------------ */
  listVetVisits(ctx: ActorContext, petId: ID): Promise<VetVisit[]>;
  upsertVetVisit(ctx: ActorContext, input: VetVisitInput & { id?: ID }): Promise<VetVisit>;
  deleteVetVisit(ctx: ActorContext, petId: ID, id: ID): Promise<void>;

  /* ---- documents ------------------------------------------------------- */
  listDocuments(ctx: ActorContext, petId: ID): Promise<PetDocument[]>;
  uploadDocument(ctx: ActorContext, input: DocumentInput): Promise<PetDocument>;
  deleteDocument(ctx: ActorContext, petId: ID, id: ID): Promise<void>;
  /** Signed, short-lived URL for viewing. Mock returns the local URI unchanged. */
  resolveDocumentUrl(ctx: ActorContext, petId: ID, id: ID): Promise<string>;

  /* ---- feeding --------------------------------------------------------- */
  listFeedingSchedules(ctx: ActorContext, petId: ID): Promise<FeedingSchedule[]>;
  upsertFeedingSchedule(ctx: ActorContext, input: FeedingScheduleInput & { id?: ID }): Promise<FeedingSchedule>;
  deleteFeedingSchedule(ctx: ActorContext, petId: ID, id: ID): Promise<void>;
  listFeedingLogs(ctx: ActorContext, petId: ID, opts?: { since?: string; limit?: number }): Promise<FeedingLog[]>;
  logFeeding(ctx: ActorContext, input: FeedingLogInput): Promise<FeedingLog>;
  undoFeedingLog(ctx: ActorContext, petId: ID, logId: ID): Promise<void>;

  /* ---- medicine -------------------------------------------------------- */
  listMedicines(ctx: ActorContext, petId: ID): Promise<Medicine[]>;
  upsertMedicine(ctx: ActorContext, input: MedicineInput & { id?: ID }): Promise<Medicine>;
  deleteMedicine(ctx: ActorContext, petId: ID, id: ID): Promise<void>;
  listMedicineLogs(ctx: ActorContext, petId: ID, opts?: { since?: string; limit?: number }): Promise<MedicineLog[]>;
  logDose(ctx: ActorContext, input: MedicineLogInput): Promise<MedicineLog>;
  undoDose(ctx: ActorContext, petId: ID, logId: ID): Promise<void>;
  getAdherence(ctx: ActorContext, petId: ID, medicineId: ID, windowDays: number): Promise<AdherenceSummary>;
  /** Decrement the pack count and reset the refill nudge. */
  recordRefill(ctx: ActorContext, petId: ID, medicineId: ID, doses: number, refillAt: DateOnly | null): Promise<Medicine>;

  /* ---- appointments ---------------------------------------------------- */
  listAppointments(ctx: ActorContext, petId: ID, opts?: { from?: string; to?: string }): Promise<Appointment[]>;
  listUpcomingAppointments(ctx: ActorContext, opts?: { limit?: number }): Promise<Appointment[]>;
  upsertAppointment(ctx: ActorContext, input: AppointmentInput & { id?: ID }): Promise<Appointment>;
  deleteAppointment(ctx: ActorContext, petId: ID, id: ID): Promise<void>;

  /* ---- care tasks (Today) ---------------------------------------------- */
  /** Unified feeding + medicine + appointment stream for one day. */
  listCareTasks(ctx: ActorContext, date: DateOnly, opts?: { petId?: ID }): Promise<CareTask[]>;
  getDaySummaries(ctx: ActorContext, from: DateOnly, to: DateOnly, opts?: { petId?: ID }): Promise<DaySummary[]>;

  /* ---- caregivers ------------------------------------------------------ */
  listMemberships(ctx: ActorContext, petId: ID): Promise<MembershipWithUser[]>;
  /** Every membership the acting user holds — the dual-role source of truth. */
  listMyMemberships(ctx: ActorContext): Promise<Membership[]>;
  createInvite(ctx: ActorContext, input: InviteInput): Promise<Invite>;
  listInvites(ctx: ActorContext, petId: ID): Promise<Invite[]>;
  revokeInvite(ctx: ActorContext, petId: ID, inviteId: ID): Promise<void>;
  /** Look up an invite by code *before* accepting, to render the preview screen. */
  peekInvite(code: string): Promise<{ invite: Invite; pet: Pet; owner: User } | null>;
  acceptInvite(ctx: ActorContext, code: string): Promise<Membership>;
  updateMembership(ctx: ActorContext, petId: ID, membershipId: ID, patch: MembershipPatch): Promise<Membership>;
  revokeMembership(ctx: ActorContext, petId: ID, membershipId: ID): Promise<void>;

  /* ---- activity log ---------------------------------------------------- */
  listActivity(ctx: ActorContext, petId: ID, opts?: { limit?: number; cursor?: string }): Promise<Page<ActivityEvent>>;
  /** Everything caregivers did across all the user's owned pets. */
  listCaregiverActivity(ctx: ActorContext, opts?: { limit?: number }): Promise<ActivityEvent[]>;

  /* ---- community ------------------------------------------------------- */
  listFeed(ctx: ActorContext, opts?: { cursor?: string; limit?: number; scope?: FeedScope }): Promise<Page<PostWithAuthor>>;
  getPost(ctx: ActorContext, postId: ID): Promise<PostWithAuthor | null>;
  createPost(ctx: ActorContext, input: PostInput): Promise<Post>;
  deletePost(ctx: ActorContext, postId: ID): Promise<void>;
  toggleLike(ctx: ActorContext, postId: ID, liked: boolean): Promise<Post>;
  listComments(ctx: ActorContext, postId: ID): Promise<CommentWithAuthor[]>;
  addComment(ctx: ActorContext, postId: ID, body: string): Promise<Comment>;
  deleteComment(ctx: ActorContext, postId: ID, commentId: ID): Promise<void>;
  listGroups(ctx: ActorContext): Promise<Group[]>;
  getGroup(ctx: ActorContext, groupId: ID): Promise<Group | null>;
  toggleGroupMembership(ctx: ActorContext, groupId: ID, joined: boolean): Promise<Group>;

  /* ---- users ----------------------------------------------------------- */
  getUser(ctx: ActorContext, userId: ID): Promise<User | null>;

  /* ---- dev ------------------------------------------------------------- */
  /** Mock only: wipe and reseed. Supabase throws. */
  resetDemoData?(): Promise<void>;
}
