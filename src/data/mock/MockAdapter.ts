/**
 * Petal — offline mock adapter.
 *
 * A real, complete implementation of `DataAdapter` backed by an in-memory store
 * that hydrates from and persists to AsyncStorage. It exists so the entire app
 * is explorable — every screen, every state, every permission boundary — before
 * a single Supabase credential exists.
 *
 * Three things it does deliberately, which a naive mock would not:
 *
 *  1. **It enforces RBAC for real.** `assertCan()` runs before every mutation
 *     *and* before the reads that a caregiver may legitimately be denied, and it
 *     throws `PermissionError`. A screen that forgets to hide a button still
 *     cannot write. This is the data-layer half of the boundary described in
 *     `docs/BUILD_CONTRACT.md`.
 *  2. **It is slow on purpose.** Every call settles after 180–420 ms of jitter,
 *     so skeletons are genuinely visible and the app feels networked rather than
 *     instantaneous-and-fake. Failure injection (off by default) lets the error
 *     states be demoed on demand.
 *  3. **It derives instead of storing.** `listCareTasks` expands feeding
 *     schedules, medicine times-of-day and appointments into one task stream and
 *     resolves each slot against the logs and the wall clock; `getAdherence`
 *     counts real slots and real gaps. Nothing is pre-baked, so a dose the user
 *     logs in the demo genuinely moves the ring.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { addDays, differenceInCalendarDays, format, parseISO, startOfDay, subDays } from 'date-fns';

import {
  evaluate,
  matchPreset,
  presetById,
  sanitizeGrants,
  type Membership,
} from '../../rbac/permissions';
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
} from '../adapter';
import type {
  ActivityAction,
  ActivityEvent,
  AdherenceSummary,
  Appointment,
  CareTask,
  Comment,
  CommentWithAuthor,
  DateOnly,
  DaySummary,
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
  Session,
  TaskState,
  User,
  Vaccination,
  VetVisit,
  WeightEntry,
} from '../types';
import {
  buildSeed,
  feedingOccursOnDay,
  feedingSlotForDay,
  medicineSlotsForDay,
  possessive,
  roleForActor,
  SEED_EMAILS,
  SEED_FRESHNESS_DAYS,
  SEED_VERSION,
  type CommentLike,
  type GroupMember,
  type PostLike,
  type SeedData,
} from './seed';

export { DEMO_INVITE_CODE, PENDING_INVITE_CODE } from './seed';

/* ------------------------------------------------------------- constants */

export const MOCK_STORAGE_KEY = 'petal.mock.v1';

/** Any password works in the demo; this is the one we print on the sign-in screen. */
export const DEMO_PASSWORD = 'petal-demo';

export const DEMO_CREDENTIALS = { email: SEED_EMAILS.maya, password: DEMO_PASSWORD } as const;

/**
 * The four seeded accounts, so the sign-in screen can offer "try another role"
 * chips. Signing in as Priya or Sam is the fastest way to see the RBAC work.
 */
export const DEMO_ACCOUNTS = [
  {
    email: SEED_EMAILS.maya,
    password: DEMO_PASSWORD,
    name: 'Maya Ellison',
    role: 'Owner & sitter',
    blurb: 'Owns Buddy, Mochi and Kiwi — and is currently sitting for Sam’s Nala.',
  },
  {
    email: SEED_EMAILS.priya,
    password: DEMO_PASSWORD,
    name: 'Priya Raghunathan',
    role: 'Full sitter',
    blurb: 'Mid-sit on Buddy. Can log everything except vaccination records.',
  },
  {
    email: SEED_EMAILS.sam,
    password: DEMO_PASSWORD,
    name: 'Sam Okonkwo',
    role: 'Owner & caregiver',
    blurb: 'Owns Nala, helps with Mochi, and has an unaccepted invite for Kiwi.',
  },
  {
    email: SEED_EMAILS.tom,
    password: DEMO_PASSWORD,
    name: 'Tom Bergström',
    role: 'Community only',
    blurb: 'No pets linked — the designed empty states, exactly as a new user sees them.',
  },
] as const;

/** A slot stays "due" rather than "overdue" for this long after its time. */
const GRACE_MINUTES = 90;

const LATENCY_MIN_MS = 180;
const LATENCY_MAX_MS = 420;

/* ---------------------------------------------------------------- errors */

export type MockErrorCode =
  | 'network'
  | 'not-found'
  | 'not-yours'
  | 'invalid-credentials'
  | 'invite-not-found'
  | 'invite-expired'
  | 'invite-used'
  | 'invite-revoked'
  | 'already-owner';

/**
 * Non-permission failures. Carries a code so the query layer can pick warm copy
 * instead of surfacing a raw message, and a `message` that is already warm in
 * case it doesn't.
 */
export class MockDataError extends Error {
  readonly code: MockErrorCode;

  constructor(code: MockErrorCode, message: string) {
    super(message);
    this.name = 'MockDataError';
    this.code = code;
  }
}

/* ----------------------------------------------------- failure injection */

export type FailureScope = 'all' | 'reads' | 'writes';

export type FailureInjection = {
  /** Off by default — nothing fails unless a developer asks for it. */
  enabled: boolean;
  /** 0–1. 1 means every eligible call fails. */
  rate: number;
  scope: FailureScope;
  message: string;
};

let failure: FailureInjection = {
  enabled: false,
  rate: 1,
  scope: 'all',
  message: 'We couldn’t reach Petal just then. Check your connection and try again.',
};

/** Flip the mock into failing mode so error states can be demoed on a real device. */
export function setMockFailure(patch: Partial<FailureInjection>): FailureInjection {
  failure = { ...failure, ...patch };
  return { ...failure };
}

export function getMockFailure(): FailureInjection {
  return { ...failure };
}

/* --------------------------------------------------------------- helpers */

type MockSession = { userId: ID; accessToken: string };

type MockStore = SeedData & {
  version: number;
  seededAt: string;
  session: MockSession | null;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const dateKey = (d: Date): DateOnly => format(d, 'yyyy-MM-dd');

let idCounter = 0;
function newId(prefix: string): ID {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function inviteCode(petName: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  const stem = petName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'PETAL';
  return `${stem}-${suffix}`;
}

const byNewest = (a: { createdAt: string }, b: { createdAt: string }) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);

/** Cursor format is opaque to callers: `<sortKey>|<id>`. */
const encodeCursor = (sortKey: string, id: ID) => `${sortKey}|${id}`;

function sliceAfterCursor<T extends { id: ID }>(items: T[], cursor: string | undefined): T[] {
  if (!cursor) return items;
  const [, id] = cursor.split('|');
  const index = items.findIndex((item) => item.id === id);
  return index >= 0 ? items.slice(index + 1) : items;
}

/* ----------------------------------------------------------- the adapter */

export class MockAdapter implements DataAdapter {
  readonly kind = 'mock' as const;

  private store: MockStore | null = null;
  private hydrating: Promise<MockStore> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(session: Session | null) => void>();

  /* ---------------------------------------------------------- lifecycle */

  private freshStore(): MockStore {
    const now = new Date();
    return { ...buildSeed(now), version: SEED_VERSION, seededAt: now.toISOString(), session: null };
  }

  private async hydrate(): Promise<MockStore> {
    if (this.store) return this.store;
    if (this.hydrating) return this.hydrating;

    this.hydrating = (async () => {
      let next: MockStore | null = null;
      try {
        const raw = await AsyncStorage.getItem(MOCK_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as MockStore;
          const ageDays = differenceInCalendarDays(new Date(), new Date(parsed.seededAt));
          // A stale store shows an appointment that already happened and a
          // sitting window that quietly expired. Regenerate rather than lie.
          if (parsed.version === SEED_VERSION && ageDays <= SEED_FRESHNESS_DAYS) {
            next = parsed;
          } else {
            next = { ...this.freshStore(), session: parsed.session };
          }
        }
      } catch {
        next = null;
      }

      this.store = next ?? this.freshStore();
      if (!next) this.schedulePersist();
      return this.store;
    })();

    return this.hydrating;
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    // Coalesce bursts of writes (ticking four meals off in a row) into one save.
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 160);
  }

  private async flush(): Promise<void> {
    if (!this.store) return;
    try {
      await AsyncStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(this.store));
    } catch {
      // A full disk shouldn't take the demo down; the in-memory store still works.
    }
  }

  /* ------------------------------------------------------- call plumbing */

  private async settle(scope: Exclude<FailureScope, 'all'>): Promise<void> {
    const wait = LATENCY_MIN_MS + Math.random() * (LATENCY_MAX_MS - LATENCY_MIN_MS);
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (!failure.enabled) return;
    if (failure.scope !== 'all' && failure.scope !== scope) return;
    if (Math.random() > failure.rate) return;
    throw new MockDataError('network', failure.message);
  }

  /** Read path: latency, optional failure, then a detached copy of the result. */
  private async read<T>(project: (store: MockStore) => T): Promise<T> {
    const store = await this.hydrate();
    await this.settle('reads');
    return clone(project(store));
  }

  /** Write path: same, plus a debounced persist. */
  private async write<T>(mutate: (store: MockStore) => T): Promise<T> {
    const store = await this.hydrate();
    await this.settle('writes');
    const result = mutate(store);
    this.schedulePersist();
    return clone(result);
  }

  /* ------------------------------------------------------ store helpers */

  private petOrThrow(store: MockStore, petId: ID): Pet {
    const pet = store.pets.find((p) => p.id === petId);
    if (!pet) throw new MockDataError('not-found', 'We couldn’t find that pet any more.');
    return pet;
  }

  private userOrThrow(store: MockStore, userId: ID): User {
    const user = store.users.find((u) => u.id === userId);
    if (!user) throw new MockDataError('not-found', 'We couldn’t find that profile.');
    return user;
  }

  /** Pets the actor can actually open right now — expired sitters see nothing. */
  private viewablePets(store: MockStore, ctx: ActorContext): Pet[] {
    const now = new Date();
    return store.pets
      .filter((pet) => {
        const membership = membershipFor(ctx, pet.id);
        return evaluate(membership, 'pet.view', now).allowed;
      })
      .sort((a, b) => {
        const aOwned = a.ownerId === ctx.userId ? 0 : 1;
        const bOwned = b.ownerId === ctx.userId ? 0 : 1;
        if (aOwned !== bOwned) return aOwned - bOwned;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });
  }

  private sessionFor(store: MockStore, userId: ID, accessToken: string): Session {
    return {
      user: this.userOrThrow(store, userId),
      memberships: store.memberships.filter((m) => m.userId === userId),
      accessToken,
    };
  }

  private emitSession(session: Session | null): void {
    for (const listener of this.listeners) listener(session ? clone(session) : null);
  }

  /** Append to the audit trail. Every mutation that a caregiver could perform logs. */
  private record(
    store: MockStore,
    petId: ID,
    actorId: ID,
    action: ActivityAction,
    summary: string,
    entityId: ID | null,
    meta: ActivityEvent['meta'] = {},
  ): void {
    const pet = store.pets.find((p) => p.id === petId);
    if (!pet) return;
    store.activity.unshift({
      id: newId('act'),
      petId,
      actorId,
      actorRole: roleForActor(pet, actorId),
      action,
      summary,
      entityId,
      at: new Date().toISOString(),
      meta,
    });
  }

  private actorName(store: MockStore, userId: ID): string {
    const user = store.users.find((u) => u.id === userId);
    return user ? user.displayName.split(' ')[0]! : 'Someone';
  }

  /* ------------------------------------------------------------------ auth */

  /**
   * Deliberately exempt from failure injection: turning failures on in the dev
   * menu should not sign you out of the demo you're standing in.
   */
  async getSession(): Promise<Session | null> {
    const store = await this.hydrate();
    if (!store.session) return null;
    const exists = store.users.some((u) => u.id === store.session!.userId);
    if (!exists) return null;
    return clone(this.sessionFor(store, store.session.userId, store.session.accessToken));
  }

  /**
   * Any email and password are accepted — this is a demo, not an auth service.
   * A seeded email resolves to that user so the role differences can be shown;
   * anything else lands on Maya, who has the fullest household.
   */
  async signIn(input: SignInInput): Promise<Session> {
    const email = input.email.trim().toLowerCase();
    if (!email || !input.password) {
      throw new MockDataError('invalid-credentials', 'Pop in an email and password and we’ll take it from there.');
    }
    return this.write((store) => {
      const match = store.users.find((u) => u.email.toLowerCase() === email);
      const user = match ?? this.userOrThrow(store, store.users[0]!.id);
      store.session = { userId: user.id, accessToken: newId('tok') };
      const session = this.sessionFor(store, user.id, store.session.accessToken);
      this.emitSession(session);
      return session;
    });
  }

  /**
   * Creates a genuine new account with no pets, so the designed empty states are
   * reachable. The seeded invite code still works, which is the intended path
   * out of the empty state.
   */
  async signUp(input: SignUpInput): Promise<Session> {
    const email = input.email.trim().toLowerCase();
    return this.write((store) => {
      const existing = store.users.find((u) => u.email.toLowerCase() === email);
      const user: User = existing ?? {
        id: newId('usr'),
        email: input.email.trim(),
        displayName: input.displayName.trim() || 'New member',
        avatarUrl: null,
        bio: null,
        createdAt: new Date().toISOString(),
      };
      if (!existing) store.users.push(user);
      store.session = { userId: user.id, accessToken: newId('tok') };
      const session = this.sessionFor(store, user.id, store.session.accessToken);
      this.emitSession(session);
      return session;
    });
  }

  async signInWithOAuth(_provider: OAuthProvider): Promise<Session> {
    return this.write((store) => {
      const user = this.userOrThrow(store, store.users[0]!.id);
      store.session = { userId: user.id, accessToken: newId('tok') };
      const session = this.sessionFor(store, user.id, store.session.accessToken);
      this.emitSession(session);
      return session;
    });
  }

  async signOut(): Promise<void> {
    const store = await this.hydrate();
    store.session = null;
    this.schedulePersist();
    this.emitSession(null);
  }

  async requestPasswordReset(_email: string): Promise<void> {
    // Never reveals whether an address is registered — same response either way.
    await this.settle('writes');
  }

  async updateProfile(
    ctx: ActorContext,
    patch: Partial<Pick<User, 'displayName' | 'avatarUrl' | 'bio'>>,
  ): Promise<User> {
    return this.write((store) => {
      const user = this.userOrThrow(store, ctx.userId);
      Object.assign(user, patch);
      const session = store.session ? this.sessionFor(store, user.id, store.session.accessToken) : null;
      if (session) this.emitSession(session);
      return user;
    });
  }

  onSessionChange(listener: (session: Session | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ------------------------------------------------------------------ pets */

  async listPets(ctx: ActorContext): Promise<Pet[]> {
    return this.read((store) => this.viewablePets(store, ctx));
  }

  async getPet(ctx: ActorContext, petId: ID): Promise<Pet | null> {
    return this.read((store) => {
      const membership = membershipFor(ctx, petId);
      if (!evaluate(membership, 'pet.view').allowed) return null;
      return store.pets.find((p) => p.id === petId) ?? null;
    });
  }

  async createPet(ctx: ActorContext, input: PetInput): Promise<Pet> {
    return this.write((store) => {
      const now = new Date().toISOString();
      const pet: Pet = {
        ...input,
        id: newId('pet'),
        ownerId: ctx.userId,
        currentWeightKg: null,
        archivedAt: null,
        createdAt: now,
      };
      store.pets.push(pet);
      store.memberships.push({
        id: newId('mem'),
        petId: pet.id,
        userId: ctx.userId,
        role: 'owner',
        grants: [],
        startsAt: null,
        endsAt: null,
        status: 'active',
        invitedBy: null,
        createdAt: now,
      });
      this.record(store, pet.id, ctx.userId, 'pet.updated', `${this.actorName(store, ctx.userId)} added ${pet.name}`, pet.id, {
        species: pet.species,
      });
      return pet;
    });
  }

  async updatePet(ctx: ActorContext, petId: ID, patch: PetPatch): Promise<Pet> {
    return this.write((store) => {
      assertCan(ctx, petId, 'pet.edit');
      const pet = this.petOrThrow(store, petId);
      Object.assign(pet, patch);
      this.record(
        store,
        petId,
        ctx.userId,
        'pet.updated',
        `${this.actorName(store, ctx.userId)} updated ${pet.name}’s profile`,
        pet.id,
        { fields: Object.keys(patch).join(', ') },
      );
      return pet;
    });
  }

  async deletePet(ctx: ActorContext, petId: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'pet.delete');
      store.pets = store.pets.filter((p) => p.id !== petId);
      store.memberships = store.memberships.filter((m) => m.petId !== petId);
      store.invites = store.invites.filter((i) => i.petId !== petId);
      store.weights = store.weights.filter((w) => w.petId !== petId);
      store.vaccinations = store.vaccinations.filter((v) => v.petId !== petId);
      store.vetVisits = store.vetVisits.filter((v) => v.petId !== petId);
      store.documents = store.documents.filter((d) => d.petId !== petId);
      store.feedingSchedules = store.feedingSchedules.filter((s) => s.petId !== petId);
      store.feedingLogs = store.feedingLogs.filter((l) => l.petId !== petId);
      store.medicines = store.medicines.filter((m) => m.petId !== petId);
      store.medicineLogs = store.medicineLogs.filter((l) => l.petId !== petId);
      store.appointments = store.appointments.filter((a) => a.petId !== petId);
      store.activity = store.activity.filter((e) => e.petId !== petId);
      store.posts = store.posts.map((p) => (p.petId === petId ? { ...p, petId: null } : p));
    });
  }

  /* ---------------------------------------------------------------- weight */

  async listWeights(ctx: ActorContext, petId: ID): Promise<WeightEntry[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'weight.view');
      return store.weights
        .filter((w) => w.petId === petId)
        .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
    });
  }

  async addWeight(ctx: ActorContext, input: WeightInput): Promise<WeightEntry> {
    return this.write((store) => {
      assertCan(ctx, input.petId, 'weight.log');
      const pet = this.petOrThrow(store, input.petId);
      const entry: WeightEntry = {
        id: newId('wgt'),
        petId: input.petId,
        kg: input.kg,
        recordedAt: input.recordedAt ?? new Date().toISOString(),
        recordedBy: ctx.userId,
        note: input.note ?? null,
      };
      store.weights.push(entry);
      store.weights.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
      const latest = store.weights.filter((w) => w.petId === input.petId).at(-1);
      pet.currentWeightKg = latest ? latest.kg : null;
      this.record(
        store,
        input.petId,
        ctx.userId,
        'weight.recorded',
        `${this.actorName(store, ctx.userId)} recorded ${pet.name} at ${input.kg} kg`,
        entry.id,
        { kg: input.kg },
      );
      return entry;
    });
  }

  async deleteWeight(ctx: ActorContext, petId: ID, entryId: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'weight.log');
      store.weights = store.weights.filter((w) => w.id !== entryId);
      const pet = this.petOrThrow(store, petId);
      const latest = store.weights.filter((w) => w.petId === petId).at(-1);
      pet.currentWeightKg = latest ? latest.kg : null;
    });
  }

  /* --------------------------------------------------------- vaccinations */

  async listVaccinations(ctx: ActorContext, petId: ID): Promise<Vaccination[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'vaccination.view');
      return store.vaccinations
        .filter((v) => v.petId === petId)
        .sort((a, b) => (b.dueAt ?? b.administeredAt ?? '').localeCompare(a.dueAt ?? a.administeredAt ?? ''));
    });
  }

  async upsertVaccination(ctx: ActorContext, input: VaccinationInput & { id?: ID }): Promise<Vaccination> {
    return this.write((store) => {
      assertCan(ctx, input.petId, 'vaccination.edit');
      const pet = this.petOrThrow(store, input.petId);
      const existing = input.id ? store.vaccinations.find((v) => v.id === input.id) : undefined;
      if (existing) {
        Object.assign(existing, input);
        this.record(store, pet.id, ctx.userId, 'vaccination.updated', `${this.actorName(store, ctx.userId)} updated ${pet.name}’s ${existing.name} record`, existing.id, { name: existing.name });
        return existing;
      }
      const record: Vaccination = {
        ...input,
        id: newId('vac'),
        createdBy: ctx.userId,
        createdAt: new Date().toISOString(),
      };
      store.vaccinations.push(record);
      this.record(store, pet.id, ctx.userId, 'vaccination.updated', `${this.actorName(store, ctx.userId)} recorded ${pet.name}’s ${record.name} vaccination`, record.id, { name: record.name });
      return record;
    });
  }

  async deleteVaccination(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'vaccination.edit');
      store.vaccinations = store.vaccinations.filter((v) => v.id !== id);
    });
  }

  /* ----------------------------------------------------------- vet visits */

  async listVetVisits(ctx: ActorContext, petId: ID): Promise<VetVisit[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'vetvisit.view');
      return store.vetVisits
        .filter((v) => v.petId === petId)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    });
  }

  async upsertVetVisit(ctx: ActorContext, input: VetVisitInput & { id?: ID }): Promise<VetVisit> {
    return this.write((store) => {
      assertCan(ctx, input.petId, 'vetvisit.edit');
      const pet = this.petOrThrow(store, input.petId);
      const existing = input.id ? store.vetVisits.find((v) => v.id === input.id) : undefined;
      if (existing) {
        Object.assign(existing, input);
        return existing;
      }
      const visit: VetVisit = {
        ...input,
        id: newId('vst'),
        createdBy: ctx.userId,
        createdAt: new Date().toISOString(),
      };
      store.vetVisits.push(visit);
      this.record(
        store,
        pet.id,
        ctx.userId,
        'vetvisit.created',
        `${this.actorName(store, ctx.userId)} wrote up ${pet.name}’s visit — ${visit.reason}`,
        visit.id,
        { type: visit.type },
      );
      return visit;
    });
  }

  async deleteVetVisit(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'vetvisit.edit');
      store.vetVisits = store.vetVisits.filter((v) => v.id !== id);
    });
  }

  /* ------------------------------------------------------------ documents */

  async listDocuments(ctx: ActorContext, petId: ID): Promise<PetDocument[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'document.view');
      return store.documents
        .filter((d) => d.petId === petId)
        .sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
    });
  }

  async uploadDocument(ctx: ActorContext, input: DocumentInput): Promise<PetDocument> {
    return this.write((store) => {
      assertCan(ctx, input.petId, 'document.upload');
      const pet = this.petOrThrow(store, input.petId);
      const document: PetDocument = {
        ...input,
        thumbnailUri: input.thumbnailUri ?? null,
        id: newId('doc'),
        uploadedBy: ctx.userId,
        uploadedAt: new Date().toISOString(),
      };
      store.documents.push(document);
      this.record(
        store,
        pet.id,
        ctx.userId,
        'document.uploaded',
        `${this.actorName(store, ctx.userId)} added “${document.title}” to ${pet.name}’s records`,
        document.id,
        { kind: document.kind },
      );
      return document;
    });
  }

  async deleteDocument(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'document.delete');
      store.documents = store.documents.filter((d) => d.id !== id);
    });
  }

  async resolveDocumentUrl(ctx: ActorContext, petId: ID, id: ID): Promise<string> {
    return this.read((store) => {
      assertCan(ctx, petId, 'document.view');
      const document = store.documents.find((d) => d.id === id);
      if (!document) throw new MockDataError('not-found', 'That document isn’t there any more.');
      return document.uri;
    });
  }

  /* -------------------------------------------------------------- feeding */

  async listFeedingSchedules(ctx: ActorContext, petId: ID): Promise<FeedingSchedule[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'feeding.view');
      return store.feedingSchedules
        .filter((s) => s.petId === petId)
        .sort((a, b) => a.time.localeCompare(b.time));
    });
  }

  async upsertFeedingSchedule(
    ctx: ActorContext,
    input: FeedingScheduleInput & { id?: ID },
  ): Promise<FeedingSchedule> {
    return this.write((store) => {
      assertCan(ctx, input.petId, 'feeding.schedule.edit');
      const existing = input.id ? store.feedingSchedules.find((s) => s.id === input.id) : undefined;
      if (existing) {
        Object.assign(existing, input);
        return existing;
      }
      const schedule: FeedingSchedule = { ...input, id: newId('fsch'), createdAt: new Date().toISOString() };
      store.feedingSchedules.push(schedule);
      return schedule;
    });
  }

  async deleteFeedingSchedule(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'feeding.schedule.edit');
      store.feedingSchedules = store.feedingSchedules.filter((s) => s.id !== id);
    });
  }

  async listFeedingLogs(
    ctx: ActorContext,
    petId: ID,
    opts?: { since?: string; limit?: number },
  ): Promise<FeedingLog[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'feeding.view');
      const since = opts?.since ? Date.parse(opts.since) : null;
      const rows = store.feedingLogs
        .filter((l) => l.petId === petId && (since === null || Date.parse(l.at) >= since))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return opts?.limit ? rows.slice(0, opts.limit) : rows;
    });
  }

  async logFeeding(ctx: ActorContext, input: FeedingLogInput): Promise<FeedingLog> {
    return this.write((store) => {
      assertCan(ctx, input.petId, 'feeding.log');
      const pet = this.petOrThrow(store, input.petId);
      const log: FeedingLog = {
        id: newId('flog'),
        petId: input.petId,
        scheduleId: input.scheduleId ?? null,
        at: input.at ?? new Date().toISOString(),
        foodName: input.foodName,
        portion: input.portion,
        unit: input.unit,
        skipped: input.skipped === true,
        loggedBy: ctx.userId,
        note: input.note ?? null,
      };
      store.feedingLogs.push(log);
      store.feedingLogs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

      const label =
        (log.scheduleId ? store.feedingSchedules.find((s) => s.id === log.scheduleId)?.label : null) ?? 'meal';
      const who = this.actorName(store, ctx.userId);
      this.record(
        store,
        pet.id,
        ctx.userId,
        log.skipped ? 'feeding.skipped' : 'feeding.logged',
        log.skipped
          ? `${who} marked ${pet.name}'s ${label.toLowerCase()} as skipped`
          : `${who} logged ${pet.name}'s ${label.toLowerCase()} — ${log.portion} ${log.unit} ${log.foodName}`,
        log.id,
        { portion: log.portion, unit: log.unit, foodName: log.foodName },
      );
      return log;
    });
  }

  async undoFeedingLog(ctx: ActorContext, petId: ID, logId: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'feeding.log');
      store.feedingLogs = store.feedingLogs.filter((l) => l.id !== logId);
      // The audit trail follows the undo — a log that never happened shouldn't linger.
      store.activity = store.activity.filter((e) => e.entityId !== logId);
    });
  }

  /* ------------------------------------------------------------- medicine */

  async listMedicines(ctx: ActorContext, petId: ID): Promise<Medicine[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'medicine.view');
      return store.medicines
        .filter((m) => m.petId === petId)
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    });
  }

  async upsertMedicine(ctx: ActorContext, input: MedicineInput & { id?: ID }): Promise<Medicine> {
    return this.write((store) => {
      assertCan(ctx, input.petId, 'medicine.edit');
      const existing = input.id ? store.medicines.find((m) => m.id === input.id) : undefined;
      if (existing) {
        Object.assign(existing, input);
        return existing;
      }
      const medicine: Medicine = { ...input, id: newId('med'), createdAt: new Date().toISOString() };
      store.medicines.push(medicine);
      return medicine;
    });
  }

  async deleteMedicine(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'medicine.edit');
      store.medicines = store.medicines.filter((m) => m.id !== id);
      store.medicineLogs = store.medicineLogs.filter((l) => l.medicineId !== id);
    });
  }

  async listMedicineLogs(
    ctx: ActorContext,
    petId: ID,
    opts?: { since?: string; limit?: number },
  ): Promise<MedicineLog[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'medicine.view');
      const since = opts?.since ? Date.parse(opts.since) : null;
      const rows = store.medicineLogs
        .filter((l) => l.petId === petId && (since === null || Date.parse(l.scheduledFor) >= since))
        .sort((a, b) => Date.parse(b.scheduledFor) - Date.parse(a.scheduledFor));
      return opts?.limit ? rows.slice(0, opts.limit) : rows;
    });
  }

  async logDose(ctx: ActorContext, input: MedicineLogInput): Promise<MedicineLog> {
    return this.write((store) => {
      assertCan(ctx, input.petId, 'medicine.log');
      const pet = this.petOrThrow(store, input.petId);
      const medicine = store.medicines.find((m) => m.id === input.medicineId);
      if (!medicine) throw new MockDataError('not-found', 'That medicine isn’t on the list any more.');

      const log: MedicineLog = {
        id: newId('mlog'),
        petId: input.petId,
        medicineId: input.medicineId,
        scheduledFor: input.scheduledFor,
        at: input.status === 'given' ? (input.at ?? new Date().toISOString()) : (input.at ?? null),
        status: input.status,
        dosage: input.dosage ?? medicine.dosage,
        loggedBy: ctx.userId,
        note: input.note ?? null,
      };
      store.medicineLogs.push(log);
      store.medicineLogs.sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));

      // A dose given comes out of the pack — this is what drives the refill nudge.
      if (log.status === 'given' && medicine.remainingDoses !== null) {
        medicine.remainingDoses = Math.max(0, medicine.remainingDoses - 1);
      }

      if (log.status !== 'missed') {
        const who = this.actorName(store, ctx.userId);
        this.record(
          store,
          pet.id,
          ctx.userId,
          log.status === 'given' ? 'medicine.given' : 'medicine.skipped',
          log.status === 'given'
            ? `${who} gave ${pet.name} ${possessive(pet)} ${medicine.name}`
            : `${who} skipped ${pet.name}'s ${medicine.name}`,
          log.id,
          { medicineId: medicine.id, dosage: log.dosage },
        );
      }
      return log;
    });
  }

  async undoDose(ctx: ActorContext, petId: ID, logId: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'medicine.log');
      const log = store.medicineLogs.find((l) => l.id === logId);
      if (log?.status === 'given') {
        const medicine = store.medicines.find((m) => m.id === log.medicineId);
        if (medicine && medicine.remainingDoses !== null) medicine.remainingDoses += 1;
      }
      store.medicineLogs = store.medicineLogs.filter((l) => l.id !== logId);
      store.activity = store.activity.filter((e) => e.entityId !== logId);
    });
  }

  /**
   * Real adherence: every slot the schedule *should* have produced in the window
   * is counted, and a slot with no log at all counts as missed. That's the whole
   * point — a gap in the record is exactly as informative as an explicit miss.
   */
  async getAdherence(
    ctx: ActorContext,
    petId: ID,
    medicineId: ID,
    windowDays: number,
  ): Promise<AdherenceSummary> {
    return this.read((store) => {
      assertCan(ctx, petId, 'medicine.view');
      const medicine = store.medicines.find((m) => m.id === medicineId && m.petId === petId);
      if (!medicine) throw new MockDataError('not-found', 'That medicine isn’t on the list any more.');

      const now = new Date();
      const logs = store.medicineLogs.filter((l) => l.medicineId === medicineId);
      const daily: AdherenceSummary['daily'] = [];
      let expected = 0;
      let given = 0;
      let skipped = 0;
      let missed = 0;

      for (let i = windowDays - 1; i >= 0; i -= 1) {
        const day = startOfDay(subDays(now, i));
        const slots = medicineSlotsForDay(medicine, day).filter((slot) => slot <= now);
        let dayGiven = 0;

        for (const slot of slots) {
          expected += 1;
          const log = this.matchDoseLog(logs, slot);
          if (!log) {
            missed += 1;
          } else if (log.status === 'given') {
            given += 1;
            dayGiven += 1;
          } else if (log.status === 'skipped') {
            skipped += 1;
          } else {
            missed += 1;
          }
        }

        daily.push({ date: dateKey(day), expected: slots.length, given: dayGiven });
      }

      return {
        medicineId,
        windowDays,
        expected,
        given,
        skipped,
        missed,
        rate: expected === 0 ? 0 : given / expected,
        streakDays: this.streakFor(daily),
        daily,
      };
    });
  }

  /** Nearest log to a slot, within an hour — hand-logged doses are never exact. */
  private matchDoseLog(logs: MedicineLog[], slot: Date): MedicineLog | undefined {
    const target = slot.getTime();
    let best: MedicineLog | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const log of logs) {
      const delta = Math.abs(Date.parse(log.scheduledFor) - target);
      if (delta <= 60 * 60 * 1000 && delta < bestDelta) {
        best = log;
        bestDelta = delta;
      }
    }
    return best;
  }

  /**
   * Consecutive complete days, newest first. Today only counts once every slot
   * it has produced so far is given — otherwise a 7am dose would "break" a
   * streak at 7:01am, which is both wrong and demoralising.
   */
  private streakFor(daily: AdherenceSummary['daily']): number {
    let streak = 0;
    for (let i = daily.length - 1; i >= 0; i -= 1) {
      const bucket = daily[i]!;
      if (bucket.expected === 0) continue; // a rest day doesn't break anything
      if (bucket.given < bucket.expected) {
        if (i === daily.length - 1 && bucket.given === 0) continue; // today hasn't started
        break;
      }
      streak += 1;
    }
    return streak;
  }

  async recordRefill(
    ctx: ActorContext,
    petId: ID,
    medicineId: ID,
    doses: number,
    refillAt: DateOnly | null,
  ): Promise<Medicine> {
    return this.write((store) => {
      assertCan(ctx, petId, 'medicine.edit');
      const medicine = store.medicines.find((m) => m.id === medicineId && m.petId === petId);
      if (!medicine) throw new MockDataError('not-found', 'That medicine isn’t on the list any more.');
      // A refill replaces the pack, it doesn't add to the old one.
      medicine.remainingDoses = doses;
      medicine.refillAt = refillAt;
      return medicine;
    });
  }

  /* --------------------------------------------------------- appointments */

  async listAppointments(
    ctx: ActorContext,
    petId: ID,
    opts?: { from?: string; to?: string },
  ): Promise<Appointment[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'appointment.view');
      const from = opts?.from ? Date.parse(opts.from) : null;
      const to = opts?.to ? Date.parse(opts.to) : null;
      return store.appointments
        .filter((a) => a.petId === petId)
        .filter((a) => {
          const at = Date.parse(a.at);
          return (from === null || at >= from) && (to === null || at <= to);
        })
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    });
  }

  async listUpcomingAppointments(ctx: ActorContext, opts?: { limit?: number }): Promise<Appointment[]> {
    return this.read((store) => {
      const now = Date.now();
      const visible = new Set(
        this.viewablePets(store, ctx)
          .filter((pet) => evaluate(membershipFor(ctx, pet.id), 'appointment.view').allowed)
          .map((pet) => pet.id),
      );
      const rows = store.appointments
        .filter((a) => visible.has(a.petId))
        .filter((a) => Date.parse(a.at) >= now && a.status !== 'cancelled' && a.status !== 'completed')
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      return opts?.limit ? rows.slice(0, opts.limit) : rows;
    });
  }

  async upsertAppointment(
    ctx: ActorContext,
    input: AppointmentInput & { id?: ID },
  ): Promise<Appointment> {
    return this.write((store) => {
      assertCan(ctx, input.petId, input.id ? 'appointment.edit' : 'appointment.create');
      const pet = this.petOrThrow(store, input.petId);
      const existing = input.id ? store.appointments.find((a) => a.id === input.id) : undefined;
      const who = this.actorName(store, ctx.userId);

      if (existing) {
        Object.assign(existing, input);
        this.record(
          store,
          pet.id,
          ctx.userId,
          'appointment.updated',
          `${who} updated ${pet.name}’s appointment — ${existing.reason}`,
          existing.id,
          { status: existing.status },
        );
        return existing;
      }

      const appointment: Appointment = {
        ...input,
        id: newId('apt'),
        vetVisitId: null,
        createdBy: ctx.userId,
        createdAt: new Date().toISOString(),
      };
      store.appointments.push(appointment);
      this.record(
        store,
        pet.id,
        ctx.userId,
        'appointment.created',
        `${who} booked ${pet.name}’s ${appointment.reason.toLowerCase()}`,
        appointment.id,
        { type: appointment.type },
      );
      return appointment;
    });
  }

  async deleteAppointment(ctx: ActorContext, petId: ID, id: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'appointment.edit');
      store.appointments = store.appointments.filter((a) => a.id !== id);
    });
  }

  /* ----------------------------------------------------------- care tasks */

  /**
   * The unified Today stream. Feeding schedules, medicine times-of-day and
   * appointments are expanded into slots for the requested date, then each slot
   * is resolved against the logs and the clock. Nothing here is stored — which
   * is why ticking a meal off immediately changes the count.
   */
  async listCareTasks(ctx: ActorContext, date: DateOnly, opts?: { petId?: ID }): Promise<CareTask[]> {
    return this.read((store) => this.expandTasks(store, ctx, parseISO(date), opts?.petId));
  }

  async getDaySummaries(
    ctx: ActorContext,
    from: DateOnly,
    to: DateOnly,
    opts?: { petId?: ID },
  ): Promise<DaySummary[]> {
    return this.read((store) => {
      const start = startOfDay(parseISO(from));
      const end = startOfDay(parseISO(to));
      const days = Math.max(0, differenceInCalendarDays(end, start));
      const summaries: DaySummary[] = [];
      for (let i = 0; i <= days; i += 1) {
        const day = addDays(start, i);
        const tasks = this.expandTasks(store, ctx, day, opts?.petId);
        summaries.push({
          date: dateKey(day),
          total: tasks.length,
          done: tasks.filter((t) => t.state === 'done' || t.state === 'skipped').length,
          overdue: tasks.filter((t) => t.state === 'overdue').length,
        });
      }
      return summaries;
    });
  }

  private expandTasks(store: MockStore, ctx: ActorContext, date: Date, petId?: ID): CareTask[] {
    const now = new Date();
    const day = startOfDay(date);
    const key = dateKey(day);
    const pets = this.viewablePets(store, ctx).filter((pet) => !petId || pet.id === petId);
    const tasks: CareTask[] = [];

    for (const pet of pets) {
      const membership = membershipFor(ctx, pet.id);

      if (evaluate(membership, 'feeding.view').allowed) {
        const schedules = store.feedingSchedules.filter((s) => s.petId === pet.id);
        const consumed = new Set<ID>();
        for (const schedule of schedules) {
          if (!feedingOccursOnDay(schedule, day)) continue;
          const slot = feedingSlotForDay(schedule, day);
          const log = this.matchFeedingLog(store, schedule.id, day, consumed);
          if (log) consumed.add(log.id);
          tasks.push({
            id: `task_feeding_${schedule.id}_${key}`,
            kind: 'feeding',
            petId: pet.id,
            at: slot.toISOString(),
            title: `${pet.name}'s ${schedule.label.toLowerCase()}`,
            subtitle: `${schedule.portion} ${schedule.unit} · ${schedule.foodName}`,
            state: log ? (log.skipped ? 'skipped' : 'done') : this.stateForSlot(slot, now),
            sourceId: schedule.id,
            requires: 'feeding.log',
            completedBy: log?.loggedBy ?? null,
            completedAt: log?.at ?? null,
            meta: {
              scheduleId: schedule.id,
              label: schedule.label,
              foodName: schedule.foodName,
              portion: schedule.portion,
              unit: schedule.unit,
              notes: schedule.notes,
            },
          });
        }
      }

      if (evaluate(membership, 'medicine.view').allowed) {
        const medicines = store.medicines.filter((m) => m.petId === pet.id);
        for (const medicine of medicines) {
          const logs = store.medicineLogs.filter((l) => l.medicineId === medicine.id);
          for (const slot of medicineSlotsForDay(medicine, day)) {
            const log = this.matchDoseLog(logs, slot);
            const state: TaskState = log
              ? log.status === 'given'
                ? 'done'
                : log.status === 'skipped'
                  ? 'skipped'
                  : 'overdue'
              : this.stateForSlot(slot, now);
            tasks.push({
              id: `task_medicine_${medicine.id}_${slot.toISOString()}`,
              kind: 'medicine',
              petId: pet.id,
              at: slot.toISOString(),
              title: `${pet.name}'s ${medicine.name}`,
              subtitle: medicine.withFood
                ? `${medicine.dosage} · with food`
                : medicine.dosage,
              state,
              sourceId: medicine.id,
              requires: 'medicine.log',
              completedBy: log?.loggedBy ?? null,
              completedAt: log?.at ?? null,
              meta: {
                medicineId: medicine.id,
                dosage: medicine.dosage,
                form: medicine.form,
                withFood: medicine.withFood,
                remainingDoses: medicine.remainingDoses,
                instructions: medicine.instructions,
              },
            });
          }
        }
      }

      if (evaluate(membership, 'appointment.view').allowed) {
        const appointments = store.appointments.filter(
          (a) => a.petId === pet.id && dateKey(new Date(a.at)) === key && a.status !== 'cancelled',
        );
        for (const appointment of appointments) {
          const at = new Date(appointment.at);
          const state: TaskState =
            appointment.status === 'completed'
              ? 'done'
              : appointment.status === 'missed'
                ? 'overdue'
                : this.stateForSlot(at, now, appointment.durationMin);
          tasks.push({
            id: `task_appointment_${appointment.id}`,
            kind: 'appointment',
            petId: pet.id,
            at: appointment.at,
            title: appointment.reason,
            subtitle: [pet.name, appointment.clinic].filter(Boolean).join(' · '),
            state,
            sourceId: appointment.id,
            requires: 'appointment.edit',
            completedBy: appointment.status === 'completed' ? appointment.createdBy : null,
            completedAt: appointment.status === 'completed' ? appointment.at : null,
            meta: {
              appointmentId: appointment.id,
              type: appointment.type,
              status: appointment.status,
              clinic: appointment.clinic,
              durationMin: appointment.durationMin,
            },
          });
        }
      }
    }

    const kindOrder: Record<CareTask['kind'], number> = { appointment: 0, medicine: 1, feeding: 2 };
    return tasks.sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || kindOrder[a.kind] - kindOrder[b.kind],
    );
  }

  /** Unlogged slots: still to come, live now, or genuinely late. */
  private stateForSlot(slot: Date, now: Date, graceMinutes = GRACE_MINUTES): TaskState {
    if (slot.getTime() > now.getTime()) return 'upcoming';
    return now.getTime() - slot.getTime() <= graceMinutes * 60 * 1000 ? 'due' : 'overdue';
  }

  private matchFeedingLog(
    store: MockStore,
    scheduleId: ID,
    day: Date,
    consumed: Set<ID>,
  ): FeedingLog | undefined {
    const key = dateKey(day);
    return store.feedingLogs.find(
      (l) => l.scheduleId === scheduleId && !consumed.has(l.id) && dateKey(new Date(l.at)) === key,
    );
  }

  /* ----------------------------------------------------------- caregivers */

  async listMemberships(ctx: ActorContext, petId: ID): Promise<MembershipWithUser[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'caregiver.view');
      const now = new Date();
      return store.memberships
        .filter((m) => m.petId === petId)
        .map((m) => ({ ...m, ...this.lapse(m, now), user: this.userOrThrow(store, m.userId) }))
        .sort((a, b) => {
          const rank = (m: Membership) => (m.role === 'owner' ? 0 : m.status === 'active' ? 1 : m.status === 'pending' ? 2 : 3);
          return rank(a) - rank(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt);
        });
    });
  }

  /**
   * Every membership the actor holds, in every state — owned, sitting, pending,
   * finished. This is the dual-role source of truth the home screen reads to say
   * "3 pets · sitting for Nala".
   */
  async listMyMemberships(ctx: ActorContext): Promise<Membership[]> {
    return this.read((store) => {
      const now = new Date();
      return store.memberships
        .filter((m) => m.userId === ctx.userId)
        .map((m) => ({ ...m, ...this.lapse(m, now) }))
        .sort((a, b) => (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1));
    });
  }

  /** A window that has closed reads as `expired` even if nobody wrote the row back. */
  private lapse(membership: Membership, now: Date): Pick<Membership, 'status'> {
    if (membership.role === 'owner' || membership.status !== 'active') return { status: membership.status };
    if (membership.endsAt && now.getTime() > Date.parse(membership.endsAt)) return { status: 'expired' };
    return { status: membership.status };
  }

  async createInvite(ctx: ActorContext, input: InviteInput): Promise<Invite> {
    return this.write((store) => {
      assertCan(ctx, input.petId, 'caregiver.invite');
      const pet = this.petOrThrow(store, input.petId);
      const grants = sanitizeGrants(
        input.presetId === 'custom' ? input.grants : presetById(input.presetId).grants,
      );
      const invite: Invite = {
        id: newId('inv'),
        petId: input.petId,
        code: inviteCode(pet.name),
        createdBy: ctx.userId,
        presetId: input.presetId,
        grants,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        expiresAt: addDays(new Date(), input.linkTtlDays ?? 7).toISOString(),
        maxUses: input.maxUses ?? 1,
        uses: 0,
        status: 'active',
        inviteeName: input.inviteeName ?? null,
        inviteeEmail: input.inviteeEmail ?? null,
        createdAt: new Date().toISOString(),
      };
      store.invites.push(invite);
      this.record(
        store,
        pet.id,
        ctx.userId,
        'caregiver.invited',
        `${this.actorName(store, ctx.userId)} invited ${invite.inviteeName ?? 'someone'} to help with ${pet.name}`,
        invite.id,
        { presetId: invite.presetId, code: invite.code },
      );
      return invite;
    });
  }

  async listInvites(ctx: ActorContext, petId: ID): Promise<Invite[]> {
    return this.read((store) => {
      assertCan(ctx, petId, 'caregiver.view');
      const now = Date.now();
      return store.invites
        .filter((i) => i.petId === petId)
        .map((i) => (i.status === 'active' && Date.parse(i.expiresAt) < now ? { ...i, status: 'expired' as const } : i))
        .sort(byNewest);
    });
  }

  async revokeInvite(ctx: ActorContext, petId: ID, inviteId: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'caregiver.revoke');
      const invite = store.invites.find((i) => i.id === inviteId);
      if (invite) invite.status = 'revoked';
    });
  }

  async peekInvite(code: string): Promise<{ invite: Invite; pet: Pet; owner: User } | null> {
    return this.read((store) => {
      const normalised = code.trim().toUpperCase();
      const found = store.invites.find((i) => i.code.toUpperCase() === normalised);
      if (!found) return null;
      const pet = store.pets.find((p) => p.id === found.petId);
      if (!pet) return null;
      const owner = store.users.find((u) => u.id === pet.ownerId);
      if (!owner) return null;
      const invite =
        found.status === 'active' && Date.parse(found.expiresAt) < Date.now()
          ? { ...found, status: 'expired' as const }
          : found;
      return { invite, pet, owner };
    });
  }

  async acceptInvite(ctx: ActorContext, code: string): Promise<Membership> {
    return this.write((store) => {
      const normalised = code.trim().toUpperCase();
      const invite = store.invites.find((i) => i.code.toUpperCase() === normalised);
      if (!invite) {
        throw new MockDataError('invite-not-found', 'We couldn’t find that code. Check it and try again.');
      }
      if (invite.status === 'revoked') {
        throw new MockDataError('invite-revoked', 'That invite was turned off by the owner.');
      }
      if (invite.status === 'expired' || Date.parse(invite.expiresAt) < Date.now()) {
        throw new MockDataError('invite-expired', 'That invite link has expired. Ask the owner for a fresh one.');
      }
      if (invite.uses >= invite.maxUses) {
        throw new MockDataError('invite-used', 'That invite has already been used.');
      }

      const pet = this.petOrThrow(store, invite.petId);
      if (pet.ownerId === ctx.userId) {
        throw new MockDataError('already-owner', `You already own ${pet.name} — no invite needed.`);
      }

      const grants = sanitizeGrants(invite.grants);
      const existing = store.memberships.find((m) => m.petId === invite.petId && m.userId === ctx.userId);

      // Re-inviting an existing caregiver upgrades their access rather than
      // stacking a second membership row — the same thing the real backend does.
      const membership: Membership = existing ?? {
        id: newId('mem'),
        petId: invite.petId,
        userId: ctx.userId,
        role: 'caregiver',
        grants,
        startsAt: invite.startsAt,
        endsAt: invite.endsAt,
        status: 'active',
        invitedBy: invite.createdBy,
        createdAt: new Date().toISOString(),
      };
      if (existing) {
        existing.grants = grants;
        existing.startsAt = invite.startsAt;
        existing.endsAt = invite.endsAt;
        existing.status = 'active';
        existing.invitedBy = invite.createdBy;
      } else {
        store.memberships.push(membership);
      }

      invite.uses += 1;
      if (invite.uses >= invite.maxUses) invite.status = 'accepted';

      this.record(
        store,
        pet.id,
        ctx.userId,
        'caregiver.joined',
        `${this.actorName(store, ctx.userId)} accepted the invite and can now care for ${pet.name}`,
        membership.id,
        { presetId: matchPreset(grants) },
      );

      if (store.session?.userId === ctx.userId) {
        this.emitSession(this.sessionFor(store, ctx.userId, store.session.accessToken));
      }
      return membership;
    });
  }

  async updateMembership(
    ctx: ActorContext,
    petId: ID,
    membershipId: ID,
    patch: MembershipPatch,
  ): Promise<Membership> {
    return this.write((store) => {
      assertCan(ctx, petId, 'caregiver.invite');
      const membership = store.memberships.find((m) => m.id === membershipId && m.petId === petId);
      if (!membership) throw new MockDataError('not-found', 'That caregiver isn’t linked to this pet any more.');
      if (patch.grants) membership.grants = sanitizeGrants(patch.grants);
      if (patch.startsAt !== undefined) membership.startsAt = patch.startsAt;
      if (patch.endsAt !== undefined) membership.endsAt = patch.endsAt;
      if (patch.status) membership.status = patch.status;
      return membership;
    });
  }

  async revokeMembership(ctx: ActorContext, petId: ID, membershipId: ID): Promise<void> {
    await this.write((store) => {
      assertCan(ctx, petId, 'caregiver.revoke');
      const membership = store.memberships.find((m) => m.id === membershipId && m.petId === petId);
      if (!membership) return;
      // Kept, not deleted: the activity trail has to stay attributable.
      membership.status = 'revoked';
      const pet = this.petOrThrow(store, petId);
      this.record(
        store,
        petId,
        ctx.userId,
        'caregiver.revoked',
        `${this.actorName(store, ctx.userId)} removed ${this.actorName(store, membership.userId)}’s access to ${pet.name}`,
        membership.id,
        {},
      );
    });
  }

  /* ------------------------------------------------------------- activity */

  async listActivity(
    ctx: ActorContext,
    petId: ID,
    opts?: { limit?: number; cursor?: string },
  ): Promise<Page<ActivityEvent>> {
    return this.read((store) => {
      assertCan(ctx, petId, 'activity.view');
      const limit = opts?.limit ?? 30;
      const all = store.activity
        .filter((e) => e.petId === petId)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const rest = sliceAfterCursor(all, opts?.cursor);
      const items = rest.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rest.length > limit && last ? encodeCursor(last.at, last.id) : null,
      };
    });
  }

  /** Everything *someone else* did across the pets this user owns. */
  async listCaregiverActivity(ctx: ActorContext, opts?: { limit?: number }): Promise<ActivityEvent[]> {
    return this.read((store) => {
      const owned = new Set(store.pets.filter((p) => p.ownerId === ctx.userId).map((p) => p.id));
      return store.activity
        .filter((e) => owned.has(e.petId) && e.actorId !== ctx.userId)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, opts?.limit ?? 40);
    });
  }

  /* ------------------------------------------------------------ community */

  private hydratePost(store: MockStore, post: Post, viewerId: ID): PostWithAuthor {
    return {
      ...post,
      likedByMe: store.postLikes.some((l) => l.postId === post.id && l.userId === viewerId),
      commentCount: store.comments.filter((c) => c.postId === post.id).length,
      author: this.userOrThrow(store, post.authorId),
      pet: post.petId ? (store.pets.find((p) => p.id === post.petId) ?? null) : null,
      group: post.groupId ? (store.groups.find((g) => g.id === post.groupId) ?? null) : null,
    };
  }

  private hydrateGroup(store: MockStore, group: Group, viewerId: ID): Group {
    return {
      ...group,
      joined: store.groupMembers.some((m) => m.groupId === group.id && m.userId === viewerId),
    };
  }

  async listFeed(
    ctx: ActorContext,
    opts?: { cursor?: string; limit?: number; scope?: FeedScope },
  ): Promise<Page<PostWithAuthor>> {
    return this.read((store) => {
      const limit = opts?.limit ?? 10;
      const scope: FeedScope = opts?.scope ?? {};
      const all = store.posts
        .filter((p) => (scope.groupId ? p.groupId === scope.groupId : true))
        .filter((p) => (scope.authorId ? p.authorId === scope.authorId : true))
        .filter((p) => (scope.petId ? p.petId === scope.petId : true))
        .sort(byNewest);

      const rest = sliceAfterCursor(all, opts?.cursor);
      const page = rest.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((post) => this.hydratePost(store, post, ctx.userId)),
        nextCursor: rest.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }

  async getPost(ctx: ActorContext, postId: ID): Promise<PostWithAuthor | null> {
    return this.read((store) => {
      const post = store.posts.find((p) => p.id === postId);
      return post ? this.hydratePost(store, post, ctx.userId) : null;
    });
  }

  async createPost(ctx: ActorContext, input: PostInput): Promise<Post> {
    return this.write((store) => {
      // Posting *about* a pet is a granted capability — a sitter can only do it
      // if the owner allowed it, and the post is badged as posted while sitting.
      const membership = input.petId ? membershipFor(ctx, input.petId) : null;
      if (input.petId) assertCan(ctx, input.petId, 'community.post');

      const post: Post = {
        id: newId('pst'),
        authorId: ctx.userId,
        petId: input.petId,
        groupId: input.groupId,
        body: input.body,
        imageUrls: input.imageUrls,
        likeCount: 0,
        commentCount: 0,
        likedByMe: false,
        postedWhileSitting: membership?.role === 'caregiver',
        createdAt: new Date().toISOString(),
      };
      store.posts.unshift(post);
      const group = input.groupId ? store.groups.find((g) => g.id === input.groupId) : undefined;
      if (group) group.postCount += 1;
      return post;
    });
  }

  async deletePost(ctx: ActorContext, postId: ID): Promise<void> {
    await this.write((store) => {
      const post = store.posts.find((p) => p.id === postId);
      if (!post) return;
      if (post.authorId !== ctx.userId) {
        throw new MockDataError('not-yours', 'You can only take down your own posts.');
      }
      store.posts = store.posts.filter((p) => p.id !== postId);
      store.comments = store.comments.filter((c) => c.postId !== postId);
      store.postLikes = store.postLikes.filter((l) => l.postId !== postId);
      const group = post.groupId ? store.groups.find((g) => g.id === post.groupId) : undefined;
      if (group) group.postCount = Math.max(0, group.postCount - 1);
    });
  }

  async toggleLike(ctx: ActorContext, postId: ID, liked: boolean): Promise<Post> {
    return this.write((store) => {
      const post = store.posts.find((p) => p.id === postId);
      if (!post) throw new MockDataError('not-found', 'That post has already gone.');
      const already = store.postLikes.some((l) => l.postId === postId && l.userId === ctx.userId);

      if (liked && !already) {
        store.postLikes.push({ postId, userId: ctx.userId } satisfies PostLike);
        post.likeCount += 1;
      } else if (!liked && already) {
        store.postLikes = store.postLikes.filter((l) => !(l.postId === postId && l.userId === ctx.userId));
        post.likeCount = Math.max(0, post.likeCount - 1);
      }
      return { ...post, likedByMe: liked };
    });
  }

  async listComments(ctx: ActorContext, postId: ID): Promise<CommentWithAuthor[]> {
    return this.read((store) =>
      store.comments
        .filter((c) => c.postId === postId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map((comment) => ({
          ...comment,
          likedByMe: store.commentLikes.some(
            (l) => l.commentId === comment.id && l.userId === ctx.userId,
          ),
          author: this.userOrThrow(store, comment.authorId),
        })),
    );
  }

  async addComment(ctx: ActorContext, postId: ID, body: string): Promise<Comment> {
    return this.write((store) => {
      const post = store.posts.find((p) => p.id === postId);
      if (!post) throw new MockDataError('not-found', 'That post has already gone.');
      const comment: Comment = {
        id: newId('cmt'),
        postId,
        authorId: ctx.userId,
        body: body.trim(),
        likeCount: 0,
        likedByMe: false,
        createdAt: new Date().toISOString(),
      };
      store.comments.push(comment);
      post.commentCount = store.comments.filter((c) => c.postId === postId).length;
      return comment;
    });
  }

  async deleteComment(ctx: ActorContext, postId: ID, commentId: ID): Promise<void> {
    await this.write((store) => {
      const comment = store.comments.find((c) => c.id === commentId);
      if (!comment) return;
      const post = store.posts.find((p) => p.id === postId);
      // Your own comment, or anyone's on your own post — the usual rule.
      if (comment.authorId !== ctx.userId && post?.authorId !== ctx.userId) {
        throw new MockDataError('not-yours', 'You can only remove your own comments.');
      }
      store.comments = store.comments.filter((c) => c.id !== commentId);
      store.commentLikes = store.commentLikes.filter(
        (l) => l.commentId !== commentId,
      ) satisfies CommentLike[];
      if (post) post.commentCount = store.comments.filter((c) => c.postId === postId).length;
    });
  }

  async listGroups(ctx: ActorContext): Promise<Group[]> {
    return this.read((store) =>
      store.groups
        .map((group) => this.hydrateGroup(store, group, ctx.userId))
        .sort((a, b) => Number(b.joined) - Number(a.joined) || b.memberCount - a.memberCount),
    );
  }

  async getGroup(ctx: ActorContext, groupId: ID): Promise<Group | null> {
    return this.read((store) => {
      const group = store.groups.find((g) => g.id === groupId);
      return group ? this.hydrateGroup(store, group, ctx.userId) : null;
    });
  }

  async toggleGroupMembership(ctx: ActorContext, groupId: ID, joined: boolean): Promise<Group> {
    return this.write((store) => {
      const group = store.groups.find((g) => g.id === groupId);
      if (!group) throw new MockDataError('not-found', 'That group isn’t around any more.');
      const already = store.groupMembers.some((m) => m.groupId === groupId && m.userId === ctx.userId);

      if (joined && !already) {
        store.groupMembers.push({ groupId, userId: ctx.userId } satisfies GroupMember);
        group.memberCount += 1;
      } else if (!joined && already) {
        store.groupMembers = store.groupMembers.filter(
          (m) => !(m.groupId === groupId && m.userId === ctx.userId),
        );
        group.memberCount = Math.max(0, group.memberCount - 1);
      }
      return { ...group, joined };
    });
  }

  /* ----------------------------------------------------------------- users */

  async getUser(_ctx: ActorContext, userId: ID): Promise<User | null> {
    return this.read((store) => store.users.find((u) => u.id === userId) ?? null);
  }

  /* ------------------------------------------------------------------- dev */

  /** Wipe and reseed, keeping whoever is signed in so the demo doesn't bounce. */
  async resetDemoData(): Promise<void> {
    const previous = this.store?.session ?? null;
    this.store = { ...this.freshStore(), session: previous };
    this.hydrating = Promise.resolve(this.store);
    await this.flush();
    const session = previous ? this.sessionFor(this.store, previous.userId, previous.accessToken) : null;
    this.emitSession(session);
  }
}

export default MockAdapter;
