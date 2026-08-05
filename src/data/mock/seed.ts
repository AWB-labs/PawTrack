/**
 * Petal — demo seed.
 *
 * Everything here is generated *relative to `now`*, never against hard-coded
 * calendar dates. A demo that says "next appointment: 12 March 2025" is dead the
 * moment you open it; this one always has a visit in two days, a booster due
 * next month and a weight chart that ends today.
 *
 * The household is deliberately shaped to prove the brief's headline claim: the
 * demo user **owns three pets and simultaneously sits for a fourth**. Maya owns
 * Buddy, Mochi and Kiwi, and holds an active `dailyCare` membership on Sam's
 * Nala whose window spans today. Every caregiver state the management screen can
 * render — active, ended, pending, revoked — exists somewhere in the seed.
 *
 * The care history is generated with a seeded PRNG and *deliberate gaps*. Real
 * adherence is never 100%: a demo where every dose is ticked makes the adherence
 * ring meaningless and hides the whole "missed dose" design surface. We aim for
 * ~88%.
 */

import {
  addDays,
  addMinutes,
  differenceInCalendarDays,
  format,
  getDaysInMonth,
  parseISO,
  startOfDay,
  subDays,
  subHours,
  subMonths,
  subYears,
} from 'date-fns';

import type { Capability, Membership } from '../../rbac/permissions';
import { presetById, sanitizeGrants } from '../../rbac/permissions';
import type {
  ActivityAction,
  ActivityEvent,
  Appointment,
  Comment,
  DateOnly,
  FeedingLog,
  FeedingSchedule,
  Group,
  ID,
  Invite,
  Medicine,
  MedicineLog,
  Pet,
  PetDocument,
  Post,
  TimeOfDay,
  User,
  Vaccination,
  VetVisit,
  WeightEntry,
} from '../types';

/* ------------------------------------------------------------------ shapes */

/** Seed users' likes, kept relational so `likedByMe` is correct for any actor. */
export type PostLike = { postId: ID; userId: ID };
export type CommentLike = { commentId: ID; userId: ID };
export type GroupMember = { groupId: ID; userId: ID };

export type SeedData = {
  users: User[];
  pets: Pet[];
  memberships: Membership[];
  invites: Invite[];
  weights: WeightEntry[];
  vaccinations: Vaccination[];
  vetVisits: VetVisit[];
  documents: PetDocument[];
  feedingSchedules: FeedingSchedule[];
  feedingLogs: FeedingLog[];
  medicines: Medicine[];
  medicineLogs: MedicineLog[];
  appointments: Appointment[];
  activity: ActivityEvent[];
  groups: Group[];
  groupMembers: GroupMember[];
  posts: Post[];
  postLikes: PostLike[];
  comments: Comment[];
  commentLikes: CommentLike[];
};

/** Bump to invalidate persisted demo stores after a shape change. */
export const SEED_VERSION = 1;

/**
 * A persisted seed older than this is regenerated on next launch. "Today" data
 * is the whole point — a five-day-old store would show an appointment that
 * happened in the past and a sitting window that has quietly expired.
 */
export const SEED_FRESHNESS_DAYS = 5;

/* --------------------------------------------------------------------- ids */

export const SEED_USER_IDS = {
  maya: 'usr_maya',
  priya: 'usr_priya',
  sam: 'usr_sam',
  tom: 'usr_tom',
} as const;

export const SEED_PET_IDS = {
  buddy: 'pet_buddy',
  mochi: 'pet_mochi',
  kiwi: 'pet_kiwi',
  nala: 'pet_nala',
} as const;

export const SEED_EMAILS = {
  maya: 'maya@petal.app',
  priya: 'priya@petal.app',
  sam: 'sam@petal.app',
  tom: 'tom@petal.app',
} as const;

const MEDICINE_IDS = {
  buddyJoint: 'med_buddy_joint',
  buddyCarprofen: 'med_buddy_carprofen',
  mochiFlea: 'med_mochi_flea',
  kiwiVitamins: 'med_kiwi_vitamins',
  nalaWormer: 'med_nala_wormer',
} as const;

/** The invite the demo user can genuinely accept — Sam extending Maya's access. */
export const DEMO_INVITE_CODE = 'NALA-8VK3';
/** The outstanding invite on Maya's own pet, so her caregiver screen has a pending row. */
export const PENDING_INVITE_CODE = 'KIWI-3RM8';

/* ---------------------------------------------------------------- helpers */

const dateOnly = (d: Date): DateOnly => format(d, 'yyyy-MM-dd');
const iso = (d: Date) => d.toISOString();
const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * mulberry32 — tiny, fast, deterministic. Seeded per collection so regenerating
 * the store twice on the same day produces the same history, which keeps
 * screenshots and bug reports reproducible.
 */
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `"HH:mm"` anchored onto a specific calendar day, in local time. */
export function timeOnDay(day: Date, time: TimeOfDay): Date {
  const [h, m] = time.split(':');
  const d = startOfDay(day);
  d.setHours(Number(h), Number(m), 0, 0);
  return d;
}

const photo = (seed: string, w: number, h: number) =>
  `https://picsum.photos/seed/petal-${seed}/${w}/${h}`;
const avatar = (n: number) => `https://i.pravatar.cc/240?img=${n}`;

/** "his" / "her" / "their" — copy that names the pet should also gender it right. */
export function possessive(pet: Pick<Pet, 'sex'>): string {
  return pet.sex === 'male' ? 'his' : pet.sex === 'female' ? 'her' : 'their';
}

/* --------------------------------------------------- schedule expansion */

/**
 * Shared by the seed (to write believable logs) and by `MockAdapter.listCareTasks`
 * (to expand the same schedules into today's task stream). Keeping one
 * implementation is what guarantees a seeded log lands exactly on the slot the
 * Today screen renders, instead of a minute either side of it.
 */
export function feedingOccursOnDay(schedule: FeedingSchedule, day: Date): boolean {
  if (!schedule.active) return false;
  if (!schedule.daysOfWeek.includes(day.getDay())) return false;
  return startOfDay(day) >= startOfDay(new Date(schedule.createdAt));
}

export function feedingSlotForDay(schedule: FeedingSchedule, day: Date): Date {
  return timeOnDay(day, schedule.time);
}

export function medicineOccursOnDay(medicine: Medicine, day: Date): boolean {
  if (medicine.frequency === 'asNeeded') return false;
  // An inactive course with no end date is simply switched off, past or present.
  if (!medicine.active && !medicine.endsAt) return false;

  const target = startOfDay(day);
  const start = startOfDay(parseISO(medicine.startsAt));
  if (target < start) return false;
  if (medicine.endsAt && target > startOfDay(parseISO(medicine.endsAt))) return false;

  switch (medicine.frequency) {
    case 'everyOtherDay':
      return differenceInCalendarDays(target, start) % 2 === 0;
    case 'weekly':
      return target.getDay() === start.getDay();
    case 'monthly': {
      const dom = Math.min(start.getDate(), getDaysInMonth(target));
      return target.getDate() === dom;
    }
    default:
      return true;
  }
}

export function medicineSlotsForDay(medicine: Medicine, day: Date): Date[] {
  if (!medicineOccursOnDay(medicine, day)) return [];
  return medicine.timesOfDay.map((t) => timeOnDay(day, t)).sort((a, b) => a.getTime() - b.getTime());
}

/* --------------------------------------------------- caregiving windows */

/**
 * Window offsets in days from "now", shared between the membership rows and the
 * log generator so that "Priya logged this" only ever appears inside the dates
 * Priya actually had access.
 */
const WINDOWS = {
  /** Maya sitting for Sam's Nala — the dual-role headline. Spans today. */
  mayaOnNala: { from: -4, to: 10, startTime: '09:00', endTime: '18:00' },
  /** Priya sitting for Buddy right now. */
  priyaOnBuddy: { from: -2, to: 6, startTime: '08:00', endTime: '19:00' },
  /** Priya's *finished* sit on Kiwi — the "access ended" row. */
  priyaOnKiwi: { from: -38, to: -31, startTime: '09:00', endTime: '18:00' },
  /** Sam's not-yet-accepted invite for Kiwi — the "pending" row. */
  samOnKiwi: { from: 12, to: 19, startTime: '09:00', endTime: '18:00' },
} as const;

function windowBounds(now: Date, w: (typeof WINDOWS)[keyof typeof WINDOWS]) {
  return {
    startsAt: iso(timeOnDay(addDays(now, w.from), w.startTime)),
    endsAt: iso(timeOnDay(addDays(now, w.to), w.endTime)),
  };
}

function within(at: Date, startsAt: string, endsAt: string): boolean {
  const t = at.getTime();
  return t >= Date.parse(startsAt) && t <= Date.parse(endsAt);
}

/* ------------------------------------------------------------------ users */

function buildUsers(now: Date): User[] {
  return [
    {
      id: SEED_USER_IDS.maya,
      email: SEED_EMAILS.maya,
      displayName: 'Maya Ellison',
      avatarUrl: avatar(45),
      bio: 'One golden retriever with opinions, one very serious cat, and a budgie who thinks he runs the flat.',
      createdAt: iso(subMonths(now, 14)),
    },
    {
      id: SEED_USER_IDS.priya,
      email: SEED_EMAILS.priya,
      displayName: 'Priya Raghunathan',
      avatarUrl: avatar(32),
      bio: 'Pet sitter in Bow. Certified in canine first aid. Thirty-one houseguests this year and counting.',
      createdAt: iso(subMonths(now, 11)),
    },
    {
      id: SEED_USER_IDS.sam,
      email: SEED_EMAILS.sam,
      displayName: 'Sam Okonkwo',
      avatarUrl: avatar(12),
      bio: "Border collie dad. If Nala hasn't worked, nobody sleeps.",
      createdAt: iso(subMonths(now, 9)),
    },
    {
      id: SEED_USER_IDS.tom,
      email: SEED_EMAILS.tom,
      displayName: 'Tom Bergström',
      avatarUrl: avatar(60),
      bio: 'Two rescue cats and a great many opinions about litter.',
      createdAt: iso(subMonths(now, 6)),
    },
  ];
}

/* ------------------------------------------------------------------- pets */

function buildPets(now: Date): Pet[] {
  return [
    {
      id: SEED_PET_IDS.buddy,
      ownerId: SEED_USER_IDS.maya,
      name: 'Buddy',
      species: 'dog',
      breed: 'Golden Retriever',
      birthday: dateOnly(subDays(subYears(now, 4), 63)),
      approximateAgeMonths: null,
      sex: 'male',
      neutered: true,
      colorMarkings: 'Deep gold, white blaze on the chest, one grey eyebrow already',
      photoUrl: photo('buddy', 900, 900),
      microchipId: '941000024871903',
      microchipRegistry: 'Petlog',
      currentWeightKg: null,
      targetWeightKg: 32,
      notes: 'Bolts his food — always stir warm water through it. Terrified of the hoover, fine with fireworks.',
      allergies: ['Chicken'],
      conditions: ['Hip dysplasia (left, grade 1)'],
      archivedAt: null,
      createdAt: iso(subMonths(now, 14)),
    },
    {
      id: SEED_PET_IDS.mochi,
      ownerId: SEED_USER_IDS.maya,
      name: 'Mochi',
      species: 'cat',
      breed: 'Ragdoll',
      birthday: dateOnly(subDays(subYears(now, 2), 18)),
      approximateAgeMonths: null,
      sex: 'female',
      neutered: true,
      colorMarkings: 'Seal bicolour, white mitts, very blue eyes',
      photoUrl: photo('mochi', 900, 900),
      microchipId: '981020016745238',
      microchipRegistry: 'Identibase',
      currentWeightKg: null,
      targetWeightKg: 4.5,
      notes: 'Will only drink from the running tap. Hides in the airing cupboard when the doorbell goes.',
      allergies: [],
      conditions: ['Sensitive stomach'],
      archivedAt: null,
      createdAt: iso(subMonths(now, 14)),
    },
    {
      id: SEED_PET_IDS.kiwi,
      ownerId: SEED_USER_IDS.maya,
      name: 'Kiwi',
      species: 'bird',
      breed: 'Budgerigar',
      birthday: dateOnly(subDays(subYears(now, 1), 9)),
      approximateAgeMonths: null,
      sex: 'male',
      neutered: null,
      colorMarkings: 'Sky blue with a white cap and three throat spots',
      photoUrl: photo('kiwi', 900, 900),
      microchipId: null,
      microchipRegistry: null,
      currentWeightKg: null,
      targetWeightKg: 0.037,
      notes: 'No non-stick pans in the flat, ever. Out-of-cage time after 6pm once the windows are shut.',
      allergies: [],
      conditions: [],
      archivedAt: null,
      createdAt: iso(subMonths(now, 11)),
    },
    {
      id: SEED_PET_IDS.nala,
      ownerId: SEED_USER_IDS.sam,
      name: 'Nala',
      species: 'dog',
      breed: 'Border Collie',
      birthday: dateOnly(subDays(subYears(now, 3), 121)),
      approximateAgeMonths: null,
      sex: 'female',
      neutered: true,
      colorMarkings: 'Black and white, full collar, one blue eye',
      photoUrl: photo('nala', 900, 900),
      microchipId: '900182001874553',
      microchipRegistry: 'Petlog',
      currentWeightKg: null,
      targetWeightKg: 17.5,
      notes: 'Needs a job before she needs a walk. Ball goes away after twenty minutes or she will not stop.',
      allergies: ['Grass pollen'],
      conditions: [],
      archivedAt: null,
      createdAt: iso(subMonths(now, 9)),
    },
  ];
}

/* ------------------------------------------------------------ memberships */

function ownerMembership(petId: ID, userId: ID, createdAt: string): Membership {
  return {
    id: `mem_${petId.replace('pet_', '')}_owner`,
    petId,
    userId,
    role: 'owner',
    grants: [],
    startsAt: null,
    endsAt: null,
    status: 'active',
    invitedBy: null,
    createdAt,
  };
}

function buildMemberships(now: Date, pets: Pet[]): Membership[] {
  const petBy = (id: ID) => pets.find((p) => p.id === id)!;
  const grantsOf = (preset: Parameters<typeof presetById>[0]): Capability[] =>
    sanitizeGrants(presetById(preset).grants);

  const mayaNala = windowBounds(now, WINDOWS.mayaOnNala);
  const priyaBuddy = windowBounds(now, WINDOWS.priyaOnBuddy);
  const priyaKiwi = windowBounds(now, WINDOWS.priyaOnKiwi);
  const samKiwi = windowBounds(now, WINDOWS.samOnKiwi);

  return [
    ownerMembership(SEED_PET_IDS.buddy, SEED_USER_IDS.maya, petBy(SEED_PET_IDS.buddy).createdAt),
    ownerMembership(SEED_PET_IDS.mochi, SEED_USER_IDS.maya, petBy(SEED_PET_IDS.mochi).createdAt),
    ownerMembership(SEED_PET_IDS.kiwi, SEED_USER_IDS.maya, petBy(SEED_PET_IDS.kiwi).createdAt),
    ownerMembership(SEED_PET_IDS.nala, SEED_USER_IDS.sam, petBy(SEED_PET_IDS.nala).createdAt),

    // The headline: the demo user is a caregiver too, right now, on someone else's dog.
    {
      id: 'mem_nala_maya',
      petId: SEED_PET_IDS.nala,
      userId: SEED_USER_IDS.maya,
      role: 'caregiver',
      grants: grantsOf('dailyCare'),
      startsAt: mayaNala.startsAt,
      endsAt: mayaNala.endsAt,
      status: 'active',
      invitedBy: SEED_USER_IDS.sam,
      createdAt: iso(subDays(now, 6)),
    },
    {
      id: 'mem_buddy_priya',
      petId: SEED_PET_IDS.buddy,
      userId: SEED_USER_IDS.priya,
      role: 'caregiver',
      grants: grantsOf('fullSitter'),
      startsAt: priyaBuddy.startsAt,
      endsAt: priyaBuddy.endsAt,
      status: 'active',
      invitedBy: SEED_USER_IDS.maya,
      createdAt: iso(subDays(now, 5)),
    },
    // Sam feeds Mochi whenever Maya is away — open-ended, no window.
    {
      id: 'mem_mochi_sam',
      petId: SEED_PET_IDS.mochi,
      userId: SEED_USER_IDS.sam,
      role: 'caregiver',
      grants: grantsOf('dailyCare'),
      startsAt: null,
      endsAt: null,
      status: 'active',
      invitedBy: SEED_USER_IDS.maya,
      createdAt: iso(subMonths(now, 5)),
    },
    // Finished sit — renders the "access ended" state without anyone being revoked.
    {
      id: 'mem_kiwi_priya',
      petId: SEED_PET_IDS.kiwi,
      userId: SEED_USER_IDS.priya,
      role: 'caregiver',
      grants: grantsOf('dailyCare'),
      startsAt: priyaKiwi.startsAt,
      endsAt: priyaKiwi.endsAt,
      status: 'expired',
      invitedBy: SEED_USER_IDS.maya,
      createdAt: iso(subDays(now, 41)),
    },
    // Invited, not yet accepted, and the window hasn't opened either.
    {
      id: 'mem_kiwi_sam',
      petId: SEED_PET_IDS.kiwi,
      userId: SEED_USER_IDS.sam,
      role: 'caregiver',
      grants: grantsOf('viewOnly'),
      startsAt: samKiwi.startsAt,
      endsAt: samKiwi.endsAt,
      status: 'pending',
      invitedBy: SEED_USER_IDS.maya,
      createdAt: iso(subDays(now, 2)),
    },
  ];
}

/* --------------------------------------------------------------- invites */

function buildInvites(now: Date, memberships: Membership[]): Invite[] {
  const grantsOf = (preset: Parameters<typeof presetById>[0]): Capability[] =>
    sanitizeGrants(presetById(preset).grants);
  const samKiwi = memberships.find((m) => m.id === 'mem_kiwi_sam')!;

  return [
    // Sam extending Maya's Nala access — the one the demo user can actually accept.
    {
      id: 'inv_nala_maya',
      petId: SEED_PET_IDS.nala,
      code: DEMO_INVITE_CODE,
      createdBy: SEED_USER_IDS.sam,
      presetId: 'fullSitter',
      grants: grantsOf('fullSitter'),
      startsAt: iso(timeOnDay(addDays(now, 10), '18:00')),
      endsAt: iso(timeOnDay(addDays(now, 24), '18:00')),
      expiresAt: iso(addDays(now, 9)),
      maxUses: 1,
      uses: 0,
      status: 'active',
      inviteeName: 'Maya',
      inviteeEmail: SEED_EMAILS.maya,
      createdAt: iso(subDays(now, 1)),
    },
    // Outstanding invite on Maya's own pet — the pending row on her caregiver screen.
    {
      id: 'inv_kiwi_sam',
      petId: SEED_PET_IDS.kiwi,
      code: PENDING_INVITE_CODE,
      createdBy: SEED_USER_IDS.maya,
      presetId: 'viewOnly',
      grants: grantsOf('viewOnly'),
      startsAt: samKiwi.startsAt,
      endsAt: samKiwi.endsAt,
      expiresAt: iso(addDays(now, 5)),
      maxUses: 1,
      uses: 0,
      status: 'active',
      inviteeName: 'Sam Okonkwo',
      inviteeEmail: SEED_EMAILS.sam,
      createdAt: iso(subDays(now, 2)),
    },
    {
      id: 'inv_buddy_priya',
      petId: SEED_PET_IDS.buddy,
      code: 'BUDDY-4KQ2',
      createdBy: SEED_USER_IDS.maya,
      presetId: 'fullSitter',
      grants: grantsOf('fullSitter'),
      startsAt: memberships.find((m) => m.id === 'mem_buddy_priya')!.startsAt,
      endsAt: memberships.find((m) => m.id === 'mem_buddy_priya')!.endsAt,
      expiresAt: iso(subDays(now, 1)),
      maxUses: 1,
      uses: 1,
      status: 'accepted',
      inviteeName: 'Priya Raghunathan',
      inviteeEmail: SEED_EMAILS.priya,
      createdAt: iso(subDays(now, 5)),
    },
    {
      id: 'inv_buddy_lapsed',
      petId: SEED_PET_IDS.buddy,
      code: 'BUDDY-9WD1',
      createdBy: SEED_USER_IDS.maya,
      presetId: 'dailyCare',
      grants: grantsOf('dailyCare'),
      startsAt: null,
      endsAt: null,
      expiresAt: iso(subDays(now, 12)),
      maxUses: 1,
      uses: 0,
      status: 'expired',
      inviteeName: 'Dad',
      inviteeEmail: null,
      createdAt: iso(subDays(now, 19)),
    },
    {
      id: 'inv_mochi_revoked',
      petId: SEED_PET_IDS.mochi,
      code: 'MOCHI-2HT7',
      createdBy: SEED_USER_IDS.maya,
      presetId: 'dailyCare',
      grants: grantsOf('dailyCare'),
      startsAt: null,
      endsAt: null,
      expiresAt: iso(addDays(now, 3)),
      maxUses: 3,
      uses: 0,
      status: 'revoked',
      inviteeName: null,
      inviteeEmail: null,
      createdAt: iso(subDays(now, 8)),
    },
  ];
}

/* ---------------------------------------------------------------- weights */

type WeightPlan = {
  petId: ID;
  from: number;
  to: number;
  jitter: number;
  places: number;
  cadence: [number, number];
};

const WEIGHT_PLANS: WeightPlan[] = [
  // Slightly overweight and trending toward the 32 kg the vet asked for.
  { petId: SEED_PET_IDS.buddy, from: 36.1, to: 34.2, jitter: 0.16, places: 1, cadence: [3, 5] },
  { petId: SEED_PET_IDS.mochi, from: 4.42, to: 4.61, jitter: 0.05, places: 2, cadence: [4, 7] },
  { petId: SEED_PET_IDS.kiwi, from: 0.0354, to: 0.0381, jitter: 0.0009, places: 3, cadence: [4, 8] },
  { petId: SEED_PET_IDS.nala, from: 17.95, to: 17.62, jitter: 0.13, places: 2, cadence: [4, 7] },
];

const WEIGHT_NOTES: Record<string, Record<number, string>> = {
  [SEED_PET_IDS.buddy]: {
    0: 'Vet scales at the hip recheck — down again.',
    3: 'Morning weigh-in before breakfast, as the vet asked.',
  },
  [SEED_PET_IDS.mochi]: { 2: 'Weighed in the carrier, minus 1.1 kg for the carrier.' },
  [SEED_PET_IDS.nala]: { 1: 'After the flyball weekend. Solid.' },
};

function buildWeights(now: Date, pets: Pet[]): WeightEntry[] {
  const entries: WeightEntry[] = [];

  for (const plan of WEIGHT_PLANS) {
    const pet = pets.find((p) => p.id === plan.petId)!;
    const rng = rngFrom(hash(plan.petId) ^ 0x51ed);
    const days: number[] = [];
    for (let d = 90; d > 0; ) {
      days.push(d);
      const [lo, hi] = plan.cadence;
      d -= lo + Math.floor(rng() * (hi - lo + 1));
    }
    days.push(0);

    days.forEach((daysAgo, index) => {
      const progress = 1 - daysAgo / 90;
      // Ease the trend so it reads as a real curve, not a ruler.
      const eased = progress * progress * (3 - 2 * progress);
      const drift = (rng() - 0.5) * 2 * plan.jitter;
      const kg = round(plan.from + (plan.to - plan.from) * eased + (daysAgo === 0 ? 0 : drift), plan.places);
      const at = timeOnDay(subDays(now, daysAgo), daysAgo === 0 ? '08:10' : '08:40');

      const fromEnd = days.length - 1 - index;
      const note = WEIGHT_NOTES[plan.petId]?.[fromEnd] ?? null;

      entries.push({
        id: `wgt_${plan.petId.replace('pet_', '')}_${daysAgo}`,
        petId: plan.petId,
        kg,
        recordedAt: iso(at),
        recordedBy: weightRecorder(plan.petId, at, pet.ownerId, now),
        note,
      });
    });
  }

  return entries.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
}

function weightRecorder(petId: ID, at: Date, ownerId: ID, now: Date): ID {
  if (petId === SEED_PET_IDS.buddy) {
    const w = windowBounds(now, WINDOWS.priyaOnBuddy);
    if (within(at, w.startsAt, w.endsAt)) return SEED_USER_IDS.priya;
  }
  if (petId === SEED_PET_IDS.nala) {
    const w = windowBounds(now, WINDOWS.mayaOnNala);
    if (within(at, w.startsAt, w.endsAt)) return SEED_USER_IDS.maya;
  }
  return ownerId;
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* --------------------------------------------------------- vaccinations */

function buildVaccinations(now: Date): Vaccination[] {
  const v = (
    id: string,
    petId: ID,
    name: string,
    core: boolean,
    administeredMonthsAgo: number | null,
    dueOffsetDays: number | null,
    extra: Partial<Vaccination> = {},
  ): Vaccination => ({
    id,
    petId,
    name,
    core,
    administeredAt: administeredMonthsAgo === null ? null : dateOnly(subMonths(now, administeredMonthsAgo)),
    dueAt: dueOffsetDays === null ? null : dateOnly(addDays(now, dueOffsetDays)),
    vetName: 'Dr. Aisling Farrell',
    clinic: 'Riverbank Veterinary',
    batchNumber: null,
    notes: null,
    documentIds: [],
    createdBy: SEED_USER_IDS.maya,
    createdAt: iso(subMonths(now, administeredMonthsAgo ?? 12)),
    ...extra,
  });

  return [
    // Buddy — one due soon, one overdue, one comfortably in date, one closed-out.
    v('vac_buddy_rabies', SEED_PET_IDS.buddy, 'Rabies', true, 13, 23, {
      batchNumber: 'RB-4471-C',
      notes: 'Needed for the pet passport — do not let this one lapse before September.',
    }),
    v('vac_buddy_dhpp', SEED_PET_IDS.buddy, 'DHPP (distemper, hepatitis, parvo, parainfluenza)', true, 7, 158, {
      batchNumber: 'DH-2209-A',
      documentIds: ['doc_buddy_record'],
    }),
    v('vac_buddy_lepto', SEED_PET_IDS.buddy, 'Leptospirosis L4', false, 16, -47, {
      notes: 'Missed the reminder while we were away. Book it with the hip recheck.',
    }),
    v('vac_buddy_kc', SEED_PET_IDS.buddy, 'Kennel cough (Bordetella)', false, 2, 306, {
      notes: 'Boarding kennels ask for this within twelve months.',
    }),
    v('vac_buddy_puppy', SEED_PET_IDS.buddy, 'Puppy primary course', true, 45, null, {
      clinic: 'Blythe Road Vets',
      vetName: 'Dr. Peter Nkemelu',
      notes: 'Completed before we adopted him. Certificate scanned.',
      documentIds: ['doc_buddy_record'],
    }),

    // Mochi — in date, plus one booked in so the UI can derive "scheduled".
    v('vac_mochi_fvrcp', SEED_PET_IDS.mochi, 'FVRCP (cat flu & enteritis)', true, 8, 122, {
      batchNumber: 'FV-8830-B',
    }),
    v('vac_mochi_rabies', SEED_PET_IDS.mochi, 'Rabies', true, 8, 122, {}),
    v('vac_mochi_felv', SEED_PET_IDS.mochi, 'Feline leukaemia (FeLV)', false, 14, 7, {
      notes: 'Booster booked for next week — she goes out on the balcony now.',
    }),

    // Kiwi — a single record, so the sparse case is designed for.
    v('vac_kiwi_polyoma', SEED_PET_IDS.kiwi, 'Avian polyomavirus', false, 10, 61, {
      vetName: 'Dr. Owen Beck',
      clinic: 'Hollybrook Exotics',
      createdBy: SEED_USER_IDS.maya,
    }),

    // Nala — Sam keeps her spotless.
    v('vac_nala_dhpp', SEED_PET_IDS.nala, 'DHPP (distemper, hepatitis, parvo, parainfluenza)', true, 5, 214, {
      vetName: 'Dr. Nadia Chowdhury',
      clinic: 'Fieldgate Veterinary Group',
      createdBy: SEED_USER_IDS.sam,
    }),
    v('vac_nala_rabies', SEED_PET_IDS.nala, 'Rabies', true, 5, 214, {
      vetName: 'Dr. Nadia Chowdhury',
      clinic: 'Fieldgate Veterinary Group',
      createdBy: SEED_USER_IDS.sam,
    }),
    v('vac_nala_lepto', SEED_PET_IDS.nala, 'Leptospirosis L4', false, 5, 214, {
      vetName: 'Dr. Nadia Chowdhury',
      clinic: 'Fieldgate Veterinary Group',
      createdBy: SEED_USER_IDS.sam,
    }),
  ];
}

/* ----------------------------------------------------------- vet visits */

function buildVetVisits(now: Date): VetVisit[] {
  const visit = (
    id: string,
    petId: ID,
    monthsAgo: number,
    type: VetVisit['type'],
    reason: string,
    fields: Partial<VetVisit>,
  ): VetVisit => ({
    id,
    petId,
    at: iso(timeOnDay(subMonths(now, monthsAgo), '11:20')),
    type,
    reason,
    vetName: 'Dr. Aisling Farrell',
    clinic: 'Riverbank Veterinary',
    diagnosis: null,
    treatment: null,
    weightKg: null,
    costMinor: null,
    currency: 'GBP',
    followUpAt: null,
    notes: null,
    documentIds: [],
    createdBy: SEED_USER_IDS.maya,
    createdAt: iso(timeOnDay(subMonths(now, monthsAgo), '19:05')),
    ...fields,
  });

  return [
    visit('vst_buddy_dental', SEED_PET_IDS.buddy, 14, 'dental', 'Dental scale and polish under sedation', {
      diagnosis: 'Moderate tartar on the upper premolars, no extractions needed.',
      treatment: 'Scale and polish. Started weekly enzymatic gel.',
      weightKg: 36.8,
      costMinor: 32000,
      notes: 'Home by 4pm, groggy but fine. Soft food for a day.',
    }),
    visit('vst_buddy_annual', SEED_PET_IDS.buddy, 8, 'checkup', 'Annual wellness exam', {
      diagnosis: 'Healthy overall. Body condition score 6/9 — carrying about 4 kg too much.',
      treatment: 'Weight plan agreed: 180 g breakfast, 160 g dinner, drop the midday feed. Target 32 kg.',
      weightKg: 36.9,
      costMinor: 8500,
      documentIds: ['doc_buddy_record'],
    }),
    visit('vst_buddy_hip', SEED_PET_IDS.buddy, 5, 'injury', 'Limping on the left hind leg after the park', {
      diagnosis: 'Hip dysplasia, left, grade 1. No arthritic change yet.',
      treatment: 'Daily joint supplement started. Lead-only for two weeks, then build back up.',
      weightKg: 35.9,
      costMinor: 24500,
      followUpAt: dateOnly(subMonths(now, 2)),
      documentIds: ['doc_buddy_xray', 'doc_buddy_invoice'],
      notes: 'Caught it early because he limped once and I panicked. Panicking was correct.',
    }),
    visit('vst_buddy_recheck', SEED_PET_IDS.buddy, 2, 'checkup', 'Hip recheck and weight review', {
      diagnosis: 'Range of motion noticeably improved. Down 1.4 kg since the last visit.',
      treatment: 'Continue joint supplement. Carprofen twice daily for six weeks to cover the flare-ups.',
      weightKg: 34.9,
      costMinor: 6500,
      documentIds: ['doc_buddy_rx'],
    }),
    visit('vst_mochi_kitten', SEED_PET_IDS.mochi, 20, 'vaccination', 'Kitten vaccination course', {
      diagnosis: 'Healthy kitten, 1.9 kg.',
      treatment: 'First and second FVRCP, microchip fitted.',
      weightKg: 1.9,
      costMinor: 11000,
    }),
    visit('vst_mochi_tummy', SEED_PET_IDS.mochi, 6, 'illness', 'Vomiting after meals for three days', {
      diagnosis: 'Dietary sensitivity. Abdomen soft, no obstruction on palpation.',
      treatment: 'Switched to a limited-ingredient wet food. Recheck if it recurs or she goes off food.',
      weightKg: 4.4,
      costMinor: 7200,
      documentIds: ['doc_mochi_record'],
    }),
    visit('vst_kiwi_new', SEED_PET_IDS.kiwi, 11, 'checkup', 'New bird health check', {
      vetName: 'Dr. Owen Beck',
      clinic: 'Hollybrook Exotics',
      diagnosis: 'Bright, alert, good weight. Beak, cere and flight feathers all healthy.',
      treatment: 'Polyomavirus vaccination given. Advised a calcium block and no non-stick cookware.',
      weightKg: 0.035,
      costMinor: 4500,
      documentIds: ['doc_kiwi_record'],
    }),
    visit('vst_nala_annual', SEED_PET_IDS.nala, 5, 'checkup', 'Annual wellness exam and boosters', {
      vetName: 'Dr. Nadia Chowdhury',
      clinic: 'Fieldgate Veterinary Group',
      diagnosis: 'Excellent condition. Mild seasonal pollen reaction noted on the paws.',
      treatment: 'Boosters given. Rinse paws after field work through the summer.',
      weightKg: 17.8,
      costMinor: 7900,
      createdBy: SEED_USER_IDS.sam,
      documentIds: ['doc_nala_record'],
    }),
  ];
}

/* ------------------------------------------------------------ documents */

function buildDocuments(now: Date): PetDocument[] {
  const doc = (
    id: string,
    petId: ID,
    title: string,
    kind: PetDocument['kind'],
    daysAgo: number,
    uploadedBy: ID,
    sizeBytes: number,
    seed: string,
  ): PetDocument => ({
    id,
    petId,
    title,
    kind,
    mimeType: 'image/jpeg',
    uri: photo(seed, 1240, 1754),
    thumbnailUri: photo(seed, 320, 452),
    sizeBytes,
    pageCount: 1,
    uploadedBy,
    uploadedAt: iso(subHours(subDays(now, daysAgo), 3)),
  });

  return [
    doc('doc_buddy_record', SEED_PET_IDS.buddy, 'Buddy — full medical history', 'record', 243, SEED_USER_IDS.maya, 1_884_210, 'doc-buddy-record'),
    doc('doc_buddy_xray', SEED_PET_IDS.buddy, 'Left hip x-ray — grade 1', 'xray', 152, SEED_USER_IDS.maya, 3_418_133, 'doc-buddy-xray'),
    doc('doc_buddy_invoice', SEED_PET_IDS.buddy, 'Riverbank Vet invoice — hip assessment', 'invoice', 152, SEED_USER_IDS.maya, 486_902, 'doc-buddy-invoice'),
    doc('doc_buddy_rx', SEED_PET_IDS.buddy, 'Prescription — Carprofen 50 mg', 'prescription', 61, SEED_USER_IDS.maya, 402_115, 'doc-buddy-rx'),
    doc('doc_buddy_insurance', SEED_PET_IDS.buddy, 'Pet insurance policy — renewal', 'insurance', 96, SEED_USER_IDS.maya, 1_209_884, 'doc-buddy-insurance'),
    // Uploaded by the sitter — proves the caregiver write path in the audit trail.
    doc('doc_buddy_photo', SEED_PET_IDS.buddy, 'Buddy at the canal — from Priya', 'photo', 1, SEED_USER_IDS.priya, 2_744_509, 'doc-buddy-photo'),
    doc('doc_mochi_record', SEED_PET_IDS.mochi, 'Mochi — vaccination card', 'record', 182, SEED_USER_IDS.maya, 968_440, 'doc-mochi-record'),
    doc('doc_kiwi_record', SEED_PET_IDS.kiwi, 'Kiwi — hatch certificate & first health check', 'record', 330, SEED_USER_IDS.maya, 742_318, 'doc-kiwi-record'),
    doc('doc_nala_record', SEED_PET_IDS.nala, 'Nala — vaccination record', 'record', 150, SEED_USER_IDS.sam, 1_055_002, 'doc-nala-record'),
  ];
}

/* -------------------------------------------------------------- feeding */

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

function buildFeedingSchedules(now: Date): FeedingSchedule[] {
  const s = (
    id: string,
    petId: ID,
    label: string,
    time: TimeOfDay,
    foodName: string,
    portion: number,
    unit: FeedingSchedule['unit'],
    fields: Partial<FeedingSchedule> = {},
  ): FeedingSchedule => ({
    id,
    petId,
    label,
    time,
    foodName,
    portion,
    unit,
    daysOfWeek: EVERY_DAY,
    remindersOn: true,
    active: true,
    notes: null,
    createdAt: iso(subDays(now, 240)),
    ...fields,
  });

  return [
    s('fsch_buddy_am', SEED_PET_IDS.buddy, 'Breakfast', '07:30', 'Harringtons Grain Free Salmon', 180, 'g', {
      notes: 'Stir warm water through it — he inhales it dry otherwise. No chicken, ever.',
    }),
    s('fsch_buddy_pm', SEED_PET_IDS.buddy, 'Dinner', '18:00', 'Harringtons Grain Free Salmon', 160, 'g', {
      notes: 'Portion dropped from 200 g when the weight plan started.',
    }),
    // Kept for history: the meal the vet asked us to drop.
    s('fsch_buddy_lunch', SEED_PET_IDS.buddy, 'Midday kibble', '12:30', 'Harringtons Grain Free Salmon', 90, 'g', {
      active: false,
      remindersOn: false,
      notes: 'Retired when we started the weight plan. Kept so the history still makes sense.',
    }),

    s('fsch_mochi_am', SEED_PET_IDS.mochi, 'Breakfast', '06:45', 'Royal Canin Sensitive dry', 25, 'g', {
      createdAt: iso(subDays(now, 300)),
    }),
    s('fsch_mochi_pm', SEED_PET_IDS.mochi, 'Supper', '18:30', "Lily's Kitchen Sensitive Turkey", 1, 'can', {
      createdAt: iso(subDays(now, 178)),
      notes: 'Half now, half back in the fridge if she walks off — she always comes back at 9.',
    }),

    s('fsch_kiwi_seed', SEED_PET_IDS.kiwi, 'Seed & pellets', '08:00', "Harrison's High Potency Fine", 2, 'scoop', {
      createdAt: iso(subDays(now, 320)),
    }),
    // Three days a week — the one schedule that exercises `daysOfWeek` properly.
    s('fsch_kiwi_veg', SEED_PET_IDS.kiwi, 'Fresh greens', '16:30', 'Chopped kale & red pepper', 1, 'piece', {
      daysOfWeek: [1, 3, 5],
      createdAt: iso(subDays(now, 320)),
      notes: 'Anything left after an hour comes straight out — it goes over fast.',
    }),

    s('fsch_nala_am', SEED_PET_IDS.nala, 'Breakfast', '07:00', "Barking Heads Chop Lickin' Lamb", 200, 'g', {
      createdAt: iso(subDays(now, 260)),
    }),
    s('fsch_nala_pm', SEED_PET_IDS.nala, 'Dinner', '17:30', "Barking Heads Chop Lickin' Lamb", 200, 'g', {
      createdAt: iso(subDays(now, 260)),
      notes: 'After the evening run, never before — she gets a stitch.',
    }),
  ];
}

/* ------------------------------------------------------------- medicine */

function buildMedicines(now: Date): Medicine[] {
  return [
    {
      id: MEDICINE_IDS.buddyJoint,
      petId: SEED_PET_IDS.buddy,
      name: 'YuMOVE Joint Care',
      form: 'chew',
      dosage: '1 chew',
      frequency: 'daily',
      timesOfDay: ['08:00'],
      startsAt: dateOnly(subDays(now, 150)),
      endsAt: null,
      remainingDoses: 22,
      refillAt: dateOnly(addDays(now, 20)),
      prescribedBy: 'Dr. Aisling Farrell',
      instructions: 'With breakfast. Takes a couple of months to show — keep going.',
      withFood: true,
      remindersOn: true,
      active: true,
      createdAt: iso(subDays(now, 150)),
    },
    {
      id: MEDICINE_IDS.buddyCarprofen,
      petId: SEED_PET_IDS.buddy,
      name: 'Carprofen 50 mg',
      form: 'tablet',
      dosage: '1 tablet (50 mg)',
      frequency: 'twiceDaily',
      timesOfDay: ['08:00', '20:00'],
      startsAt: dateOnly(subDays(now, 62)),
      endsAt: dateOnly(addDays(now, 18)),
      // Deliberately low so the refill nudge is on screen from the first run.
      remainingDoses: 9,
      refillAt: dateOnly(addDays(now, 4)),
      prescribedBy: 'Dr. Aisling Farrell',
      instructions: 'Always with food. Stop and ring the clinic if he goes off his food or seems flat.',
      withFood: true,
      remindersOn: true,
      active: true,
      createdAt: iso(subDays(now, 62)),
    },
    {
      id: MEDICINE_IDS.mochiFlea,
      petId: SEED_PET_IDS.mochi,
      name: 'Advocate spot-on (cat)',
      form: 'topical',
      dosage: '1 pipette',
      frequency: 'monthly',
      timesOfDay: ['09:00'],
      startsAt: dateOnly(subMonths(now, 8)),
      endsAt: null,
      remainingDoses: 2,
      refillAt: dateOnly(addDays(now, 38)),
      prescribedBy: 'Dr. Aisling Farrell',
      instructions: 'Part the fur at the back of the neck. No grooming or cuddles for an hour.',
      withFood: false,
      remindersOn: true,
      active: true,
      createdAt: iso(subMonths(now, 8)),
    },
    {
      id: MEDICINE_IDS.kiwiVitamins,
      petId: SEED_PET_IDS.kiwi,
      name: 'Avian multivitamin drops',
      form: 'drops',
      dosage: '2 drops in the water',
      frequency: 'weekly',
      timesOfDay: ['09:00'],
      startsAt: dateOnly(subDays(now, 120)),
      endsAt: dateOnly(subDays(now, 30)),
      remainingDoses: 0,
      refillAt: null,
      prescribedBy: 'Dr. Owen Beck',
      instructions: 'Twelve-week course after the moult. Finished — no need to reorder.',
      withFood: false,
      remindersOn: false,
      active: false,
      createdAt: iso(subDays(now, 120)),
    },
    {
      id: MEDICINE_IDS.nalaWormer,
      petId: SEED_PET_IDS.nala,
      name: 'Milbemax wormer',
      form: 'tablet',
      dosage: '1 tablet',
      frequency: 'monthly',
      timesOfDay: ['08:30'],
      startsAt: dateOnly(subMonths(now, 7)),
      endsAt: null,
      remainingDoses: 3,
      refillAt: dateOnly(addDays(now, 62)),
      prescribedBy: 'Dr. Nadia Chowdhury',
      instructions: 'Hidden in a lump of cheese. She has never once noticed.',
      withFood: true,
      remindersOn: true,
      active: true,
      createdAt: iso(subMonths(now, 7)),
    },
  ];
}

/* --------------------------------------------------------- appointments */

function buildAppointments(now: Date): Appointment[] {
  const apt = (
    id: string,
    petId: ID,
    at: Date,
    type: Appointment['type'],
    reason: string,
    status: Appointment['status'],
    fields: Partial<Appointment> = {},
  ): Appointment => ({
    id,
    petId,
    at: iso(at),
    durationMin: 20,
    type,
    reason,
    clinic: 'Riverbank Veterinary',
    clinicPhone: '+44 20 7946 0812',
    clinicAddress: '14 Riverbank Row, London E3 4NX',
    vetName: 'Dr. Aisling Farrell',
    status,
    notes: null,
    reminderOffsets: [1440, 60],
    linkedDocumentIds: [],
    linkedVaccinationIds: [],
    vetVisitId: null,
    createdBy: SEED_USER_IDS.maya,
    createdAt: iso(subDays(at, 12)),
    ...fields,
  });

  return [
    // The one the Today screen and home hero lead with.
    apt('apt_buddy_recheck', SEED_PET_IDS.buddy, timeOnDay(addDays(now, 2), '16:15'), 'checkup', 'Hip recheck and weigh-in', 'confirmed', {
      durationMin: 30,
      notes: 'Bring the weight chart. Ask about dropping carprofen to once a day.',
      linkedDocumentIds: ['doc_buddy_xray'],
    }),
    apt('apt_mochi_booster', SEED_PET_IDS.mochi, timeOnDay(addDays(now, 7), '10:30'), 'vaccination', 'FeLV booster', 'scheduled', {
      linkedVaccinationIds: ['vac_mochi_felv'],
      notes: 'Carrier out the night before or she vanishes.',
    }),
    apt('apt_nala_boosters', SEED_PET_IDS.nala, timeOnDay(addDays(now, 9), '09:00'), 'vaccination', 'Annual boosters', 'scheduled', {
      clinic: 'Fieldgate Veterinary Group',
      clinicPhone: '+44 20 7946 0355',
      clinicAddress: '2 Fieldgate Lane, London E1 1ES',
      vetName: 'Dr. Nadia Chowdhury',
      createdBy: SEED_USER_IDS.sam,
    }),
    apt('apt_buddy_groom', SEED_PET_IDS.buddy, timeOnDay(addDays(now, 12), '11:00'), 'grooming', 'Full groom and de-shed', 'scheduled', {
      durationMin: 90,
      clinic: 'Muddy Paws Grooming',
      clinicPhone: '+44 20 7946 0244',
      clinicAddress: '88 Roman Road, London E2 0RN',
      vetName: null,
      reminderOffsets: [1440],
    }),
    apt('apt_kiwi_trim', SEED_PET_IDS.kiwi, timeOnDay(addDays(now, 19), '15:45'), 'other', 'Beak and nail trim', 'scheduled', {
      durationMin: 15,
      clinic: 'Hollybrook Exotics',
      clinicPhone: '+44 20 7946 0197',
      clinicAddress: '5 Hollybrook Mews, London E9 6BT',
      vetName: 'Dr. Owen Beck',
    }),

    // Past — including one genuinely missed, so that badge has somewhere to live.
    apt('apt_buddy_nailtrim', SEED_PET_IDS.buddy, timeOnDay(subDays(now, 24), '14:00'), 'other', 'Nail trim', 'missed', {
      durationMin: 15,
      notes: 'Completely forgot. Rebook with the groom.',
      reminderOffsets: [60],
    }),
    apt('apt_buddy_recheck_past', SEED_PET_IDS.buddy, timeOnDay(subMonths(now, 2), '11:20'), 'followUp', 'Hip recheck and weight review', 'completed', {
      durationMin: 30,
      vetVisitId: 'vst_buddy_recheck',
    }),
    apt('apt_buddy_annual_past', SEED_PET_IDS.buddy, timeOnDay(subMonths(now, 8), '11:20'), 'checkup', 'Annual wellness exam', 'completed', {
      durationMin: 30,
      vetVisitId: 'vst_buddy_annual',
    }),
    apt('apt_mochi_tummy_past', SEED_PET_IDS.mochi, timeOnDay(subMonths(now, 6), '11:20'), 'checkup', 'Vomiting after meals', 'completed', {
      vetVisitId: 'vst_mochi_tummy',
    }),
    apt('apt_kiwi_new_past', SEED_PET_IDS.kiwi, timeOnDay(subMonths(now, 11), '11:20'), 'checkup', 'New bird health check', 'completed', {
      clinic: 'Hollybrook Exotics',
      vetName: 'Dr. Owen Beck',
      vetVisitId: 'vst_kiwi_new',
    }),
    apt('apt_nala_annual_past', SEED_PET_IDS.nala, timeOnDay(subMonths(now, 5), '11:20'), 'checkup', 'Annual wellness exam and boosters', 'completed', {
      clinic: 'Fieldgate Veterinary Group',
      vetName: 'Dr. Nadia Chowdhury',
      createdBy: SEED_USER_IDS.sam,
      vetVisitId: 'vst_nala_annual',
    }),
    apt('apt_buddy_dental_past', SEED_PET_IDS.buddy, timeOnDay(subMonths(now, 14), '08:30'), 'dental', 'Dental scale and polish', 'completed', {
      durationMin: 180,
      vetVisitId: 'vst_buddy_dental',
    }),
  ];
}

/* ------------------------------------------------------------ care logs */

/** How far back the generated care history runs. */
const HISTORY_DAYS = 68;

/**
 * Slots inside this window of "now" are left unlogged, so the Today screen
 * always opens with something genuinely actionable rather than a finished list.
 */
const OPEN_SLOT_HOURS = 3;

/** Buddy's joint chew is force-given for this many recent days, to seed a streak. */
const STREAK_DAYS = 6;

type LogBuild = { feedingLogs: FeedingLog[]; medicineLogs: MedicineLog[] };

/**
 * Who logged a given slot. Care logged by a sitter is what makes the owner's
 * activity feed worth building, so this resolves against the same windows the
 * memberships use — a caregiver never appears outside their own dates.
 */
function careActor(petId: ID, at: Date, ownerId: ID, now: Date, rng: () => number): ID {
  if (petId === SEED_PET_IDS.buddy) {
    const w = windowBounds(now, WINDOWS.priyaOnBuddy);
    if (within(at, w.startsAt, w.endsAt)) return rng() < 0.94 ? SEED_USER_IDS.priya : ownerId;
  }
  if (petId === SEED_PET_IDS.kiwi) {
    const w = windowBounds(now, WINDOWS.priyaOnKiwi);
    if (within(at, w.startsAt, w.endsAt)) return SEED_USER_IDS.priya;
  }
  if (petId === SEED_PET_IDS.nala) {
    const w = windowBounds(now, WINDOWS.mayaOnNala);
    if (within(at, w.startsAt, w.endsAt)) return rng() < 0.85 ? SEED_USER_IDS.maya : ownerId;
  }
  if (petId === SEED_PET_IDS.mochi) {
    // Sam has open-ended access and covers roughly one meal in seven.
    return rng() < 0.14 ? SEED_USER_IDS.sam : ownerId;
  }
  return ownerId;
}

const SKIP_NOTES = [
  'Wasn’t interested — left it down for half an hour and took it away.',
  'Too hot, went out for a walk instead and fed later.',
  'Ate half and wandered off.',
];

const DOSE_SKIP_NOTES = [
  'Wouldn’t take it — will try again with the next meal.',
  'Spat it out twice. Skipping rather than fighting him for it.',
  'Skipped on the vet’s advice while his stomach settled.',
];

function buildCareLogs(
  now: Date,
  pets: Pet[],
  schedules: FeedingSchedule[],
  medicines: Medicine[],
): LogBuild {
  const feedingLogs: FeedingLog[] = [];
  const medicineLogs: MedicineLog[] = [];
  const rng = rngFrom(0x9e3779b9);
  const openFrom = subHours(now, OPEN_SLOT_HOURS);
  const petOwner = new Map(pets.map((p) => [p.id, p.ownerId]));
  let leftSomethingOpen = false;
  const todaysLogTimes: { kind: 'feeding' | 'medicine'; id: ID; at: number }[] = [];

  for (let daysAgo = HISTORY_DAYS; daysAgo >= 0; daysAgo -= 1) {
    const day = startOfDay(subDays(now, daysAgo));
    const isToday = daysAgo === 0;

    for (const schedule of schedules) {
      if (!feedingOccursOnDay(schedule, day)) continue;
      const slot = feedingSlotForDay(schedule, day);
      if (slot > now) continue;
      if (isToday && slot > openFrom) {
        leftSomethingOpen = true;
        continue;
      }

      const roll = rng();
      if (roll >= 0.92) continue; // an honest gap: nobody wrote it down
      const skipped = roll >= 0.88;
      const at = addMinutes(slot, Math.round((rng() - 0.35) * 40));
      const ownerId = petOwner.get(schedule.petId)!;
      const id = `flog_${schedule.id.replace('fsch_', '')}_${daysAgo}`;

      feedingLogs.push({
        id,
        petId: schedule.petId,
        scheduleId: schedule.id,
        at: iso(at),
        foodName: schedule.foodName,
        portion: schedule.portion,
        unit: schedule.unit,
        skipped,
        loggedBy: careActor(schedule.petId, at, ownerId, now, rng),
        note: skipped ? SKIP_NOTES[Math.floor(rng() * SKIP_NOTES.length)]! : null,
      });
      if (isToday) todaysLogTimes.push({ kind: 'feeding', id, at: at.getTime() });
    }

    for (const medicine of medicines) {
      const slots = medicineSlotsForDay(medicine, day);
      slots.forEach((slot, slotIndex) => {
        if (slot > now) return;
        if (isToday && slot > openFrom) {
          leftSomethingOpen = true;
          return;
        }

        const forcedGiven =
          medicine.id === MEDICINE_IDS.buddyJoint && daysAgo <= STREAK_DAYS;
        const roll = forcedGiven ? 0 : rng();
        if (roll >= 0.955) return; // gap — counted as missed by the adherence maths
        const status: MedicineLog['status'] =
          roll < 0.885 ? 'given' : roll < 0.925 ? 'skipped' : 'missed';

        const at = status === 'given' ? addMinutes(slot, Math.round((rng() - 0.3) * 35)) : null;
        const ownerId = petOwner.get(medicine.petId)!;
        const id = `mlog_${medicine.id.replace('med_', '')}_${daysAgo}_${slotIndex}`;

        medicineLogs.push({
          id,
          petId: medicine.petId,
          medicineId: medicine.id,
          scheduledFor: iso(slot),
          at: at ? iso(at) : null,
          status,
          dosage: medicine.dosage,
          loggedBy: careActor(medicine.petId, at ?? slot, ownerId, now, rng),
          note: status === 'skipped' ? DOSE_SKIP_NOTES[Math.floor(rng() * DOSE_SKIP_NOTES.length)]! : null,
        });
        if (isToday && at) todaysLogTimes.push({ kind: 'medicine', id, at: at.getTime() });
      });
    }
  }

  // Late in the evening every slot may already be more than three hours old. Give
  // the most recent one back so "Today" is never a completed list on first open.
  if (!leftSomethingOpen && todaysLogTimes.length > 0) {
    const latest = todaysLogTimes.reduce((a, b) => (b.at > a.at ? b : a));
    if (latest.kind === 'feeding') {
      const i = feedingLogs.findIndex((l) => l.id === latest.id);
      if (i >= 0) feedingLogs.splice(i, 1);
    } else {
      const i = medicineLogs.findIndex((l) => l.id === latest.id);
      if (i >= 0) medicineLogs.splice(i, 1);
    }
  }

  feedingLogs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  medicineLogs.sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
  return { feedingLogs, medicineLogs };
}

/* -------------------------------------------------------- activity log */

/** Only the recent past is replayed into the audit trail — older logs stay in the logs. */
const ACTIVITY_DAYS = 10;

const firstName = (user: User) => user.displayName.split(' ')[0]!;

export function roleForActor(pet: Pet, actorId: ID): Membership['role'] {
  return pet.ownerId === actorId ? 'owner' : 'caregiver';
}

function buildActivity(
  now: Date,
  pets: Pet[],
  users: User[],
  schedules: FeedingSchedule[],
  medicines: Medicine[],
  feedingLogs: FeedingLog[],
  medicineLogs: MedicineLog[],
  weights: WeightEntry[],
): ActivityEvent[] {
  const petBy = new Map(pets.map((p) => [p.id, p]));
  const userBy = new Map(users.map((u) => [u.id, u]));
  const scheduleBy = new Map(schedules.map((s) => [s.id, s]));
  const medicineBy = new Map(medicines.map((m) => [m.id, m]));
  const since = subDays(now, ACTIVITY_DAYS).getTime();
  const events: ActivityEvent[] = [];

  const push = (
    id: string,
    petId: ID,
    actorId: ID,
    action: ActivityAction,
    summary: string,
    at: string,
    entityId: ID | null,
    meta: ActivityEvent['meta'] = {},
  ) => {
    const pet = petBy.get(petId);
    if (!pet) return;
    events.push({
      id,
      petId,
      actorId,
      actorRole: roleForActor(pet, actorId),
      action,
      summary,
      entityId,
      at,
      meta,
    });
  };

  for (const log of feedingLogs) {
    if (Date.parse(log.at) < since) continue;
    const pet = petBy.get(log.petId);
    const actor = userBy.get(log.loggedBy);
    if (!pet || !actor) continue;
    const label = (log.scheduleId ? scheduleBy.get(log.scheduleId)?.label : null) ?? 'meal';
    const meal = label.toLowerCase();
    const summary = log.skipped
      ? `${firstName(actor)} marked ${pet.name}'s ${meal} as skipped`
      : `${firstName(actor)} logged ${pet.name}'s ${meal} — ${log.portion} ${log.unit} ${log.foodName}`;
    push(`act_${log.id}`, log.petId, log.loggedBy, log.skipped ? 'feeding.skipped' : 'feeding.logged', summary, log.at, log.id, {
      portion: log.portion,
      unit: log.unit,
      foodName: log.foodName,
    });
  }

  for (const log of medicineLogs) {
    const when = log.at ?? log.scheduledFor;
    if (Date.parse(when) < since) continue;
    if (log.status === 'missed') continue; // a missed dose is a gap, not an action
    const pet = petBy.get(log.petId);
    const actor = userBy.get(log.loggedBy);
    const medicine = medicineBy.get(log.medicineId);
    if (!pet || !actor || !medicine) continue;
    const summary =
      log.status === 'given'
        ? `${firstName(actor)} gave ${pet.name} ${possessive(pet)} ${medicine.name}`
        : `${firstName(actor)} skipped ${pet.name}'s ${medicine.name}`;
    push(`act_${log.id}`, log.petId, log.loggedBy, log.status === 'given' ? 'medicine.given' : 'medicine.skipped', summary, when, log.id, {
      medicineId: medicine.id,
      dosage: log.dosage,
    });
  }

  for (const entry of weights) {
    if (Date.parse(entry.recordedAt) < since) continue;
    const pet = petBy.get(entry.petId);
    const actor = userBy.get(entry.recordedBy);
    if (!pet || !actor) continue;
    push(
      `act_${entry.id}`,
      entry.petId,
      entry.recordedBy,
      'weight.recorded',
      `${firstName(actor)} recorded ${pet.name} at ${entry.kg} kg`,
      entry.recordedAt,
      entry.id,
      { kg: entry.kg },
    );
  }

  /* Narrative events — the ones a generated log can never produce. */

  push(
    'act_invite_priya',
    SEED_PET_IDS.buddy,
    SEED_USER_IDS.maya,
    'caregiver.invited',
    'Maya invited Priya to help with Buddy as a full sitter',
    iso(timeOnDay(subDays(now, 5), '20:12')),
    'mem_buddy_priya',
    { presetId: 'fullSitter' },
  );
  push(
    'act_join_priya',
    SEED_PET_IDS.buddy,
    SEED_USER_IDS.priya,
    'caregiver.joined',
    'Priya accepted the invite and can now care for Buddy',
    iso(timeOnDay(subDays(now, 5), '21:40')),
    'mem_buddy_priya',
    { presetId: 'fullSitter' },
  );
  push(
    'act_join_maya_nala',
    SEED_PET_IDS.nala,
    SEED_USER_IDS.maya,
    'caregiver.joined',
    'Maya accepted Sam’s invite and is covering Nala’s daily care',
    iso(timeOnDay(subDays(now, 6), '18:05')),
    'mem_nala_maya',
    { presetId: 'dailyCare' },
  );
  push(
    'act_doc_priya',
    SEED_PET_IDS.buddy,
    SEED_USER_IDS.priya,
    'document.uploaded',
    'Priya added a photo — Buddy at the canal',
    iso(timeOnDay(subDays(now, 1), '16:24')),
    'doc_buddy_photo',
    { kind: 'photo' },
  );
  push(
    'act_denied_priya',
    SEED_PET_IDS.buddy,
    SEED_USER_IDS.priya,
    'permission.denied',
    'Priya tried to update Buddy’s rabies record — vaccinations aren’t part of her access',
    iso(timeOnDay(subDays(now, 1), '17:02')),
    'vac_buddy_rabies',
    { capability: 'vaccination.edit', reason: 'not-granted' },
  );
  push(
    'act_apt_recheck',
    SEED_PET_IDS.buddy,
    SEED_USER_IDS.maya,
    'appointment.created',
    'Maya booked Buddy’s hip recheck at Riverbank Veterinary',
    iso(timeOnDay(subDays(now, 9), '13:35')),
    'apt_buddy_recheck',
    { type: 'checkup' },
  );
  push(
    'act_apt_confirmed',
    SEED_PET_IDS.buddy,
    SEED_USER_IDS.maya,
    'appointment.updated',
    'Buddy’s hip recheck was confirmed by the clinic',
    iso(timeOnDay(subDays(now, 3), '09:18')),
    'apt_buddy_recheck',
    { status: 'confirmed' },
  );
  push(
    'act_apt_booster',
    SEED_PET_IDS.mochi,
    SEED_USER_IDS.maya,
    'appointment.created',
    'Maya booked Mochi’s FeLV booster',
    iso(timeOnDay(subDays(now, 4), '21:02')),
    'apt_mochi_booster',
    { type: 'vaccination' },
  );
  push(
    'act_vac_kc',
    SEED_PET_IDS.buddy,
    SEED_USER_IDS.maya,
    'vaccination.updated',
    'Maya recorded Buddy’s kennel cough vaccination',
    iso(timeOnDay(subDays(now, 8), '12:44')),
    'vac_buddy_kc',
    { name: 'Kennel cough (Bordetella)' },
  );
  push(
    'act_pet_notes',
    SEED_PET_IDS.buddy,
    SEED_USER_IDS.maya,
    'pet.updated',
    'Maya updated Buddy’s feeding notes before the sit',
    iso(timeOnDay(subDays(now, 5), '19:50')),
    SEED_PET_IDS.buddy,
    { field: 'notes' },
  );
  push(
    'act_invite_sam_kiwi',
    SEED_PET_IDS.kiwi,
    SEED_USER_IDS.maya,
    'caregiver.invited',
    'Maya invited Sam to look in on Kiwi later this month',
    iso(timeOnDay(subDays(now, 2), '22:11')),
    'mem_kiwi_sam',
    { presetId: 'viewOnly' },
  );
  push(
    'act_visit_recheck',
    SEED_PET_IDS.buddy,
    SEED_USER_IDS.maya,
    'vetvisit.created',
    'Maya wrote up Buddy’s hip recheck — range of motion improved',
    iso(timeOnDay(subMonths(now, 2), '19:05')),
    'vst_buddy_recheck',
    { type: 'checkup' },
  );

  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/* ------------------------------------------------------------ community */

const GROUP_IDS = {
  goldens: 'grp_goldens',
  ragdolls: 'grp_ragdolls',
  birds: 'grp_birds',
  joints: 'grp_joints',
  eastLondon: 'grp_east_london',
  sitters: 'grp_sitters',
} as const;

function buildGroups(): Group[] {
  return [
    {
      id: GROUP_IDS.goldens,
      name: 'Golden Retriever Club',
      slug: 'golden-retrievers',
      kind: 'breed',
      description: 'Shedding, swimming, and the specific joy of a dog who loves everyone equally.',
      memberCount: 12480,
      postCount: 3164,
      accent: '#C97B1F',
      joined: false,
    },
    {
      id: GROUP_IDS.ragdolls,
      name: 'Ragdoll Appreciation',
      slug: 'ragdolls',
      kind: 'breed',
      description: 'Floppy cats, blue eyes, and a great deal of fur on dark clothing.',
      memberCount: 6902,
      postCount: 1877,
      accent: '#8A5CC4',
      joined: false,
    },
    {
      id: GROUP_IDS.birds,
      name: 'Budgies & Small Birds',
      slug: 'small-birds',
      kind: 'species',
      description: 'Seed mixes, safe houseplants, and why your pan collection matters more than you think.',
      memberCount: 3341,
      postCount: 1092,
      accent: '#1E88A8',
      joined: false,
    },
    {
      id: GROUP_IDS.joints,
      name: 'Joint Care & Mobility',
      slug: 'joint-care',
      kind: 'topic',
      description: 'Dysplasia, arthritis and ageing well. Evidence welcome, miracle cures politely shown the door.',
      memberCount: 5218,
      postCount: 2410,
      accent: '#2A8F73',
      joined: false,
    },
    {
      id: GROUP_IDS.eastLondon,
      name: 'East London Dog Walks',
      slug: 'east-london-walks',
      kind: 'local',
      description: 'Towpaths, parks and the ongoing question of which cafés actually mean it about dogs.',
      memberCount: 1874,
      postCount: 964,
      accent: '#4F8149',
      joined: false,
    },
    {
      id: GROUP_IDS.sitters,
      name: 'Sitters & Swaps',
      slug: 'sitters-and-swaps',
      kind: 'topic',
      description: 'Trade weekends, find cover, and share handover notes that actually help.',
      memberCount: 2246,
      postCount: 803,
      accent: '#F2653A',
      joined: false,
    },
  ];
}

const GROUP_MEMBERSHIPS: GroupMember[] = [
  { groupId: GROUP_IDS.goldens, userId: SEED_USER_IDS.maya },
  { groupId: GROUP_IDS.ragdolls, userId: SEED_USER_IDS.maya },
  { groupId: GROUP_IDS.birds, userId: SEED_USER_IDS.maya },
  { groupId: GROUP_IDS.joints, userId: SEED_USER_IDS.maya },
  { groupId: GROUP_IDS.eastLondon, userId: SEED_USER_IDS.maya },
  { groupId: GROUP_IDS.sitters, userId: SEED_USER_IDS.priya },
  { groupId: GROUP_IDS.goldens, userId: SEED_USER_IDS.priya },
  { groupId: GROUP_IDS.eastLondon, userId: SEED_USER_IDS.priya },
  { groupId: GROUP_IDS.eastLondon, userId: SEED_USER_IDS.sam },
  { groupId: GROUP_IDS.joints, userId: SEED_USER_IDS.sam },
  { groupId: GROUP_IDS.sitters, userId: SEED_USER_IDS.sam },
  { groupId: GROUP_IDS.ragdolls, userId: SEED_USER_IDS.tom },
  { groupId: GROUP_IDS.joints, userId: SEED_USER_IDS.tom },
];

type PostSpec = {
  id: string;
  authorId: ID;
  petId: ID | null;
  groupId: ID | null;
  hoursAgo: number;
  body: string;
  images: string[];
  likeCount: number;
  likedBy: ID[];
  sitting?: boolean;
};

const POST_SPECS: PostSpec[] = [
  {
    id: 'pst_01',
    authorId: SEED_USER_IDS.maya,
    petId: SEED_PET_IDS.buddy,
    groupId: GROUP_IDS.goldens,
    hoursAgo: 5,
    body: "Six weeks into Buddy's weight plan and he's down 1.9 kg. He has not forgiven me for the smaller dinners — there is a very pointed sigh at 6pm every evening — but this morning he took the canal steps two at a time and waited at the top for me. Worth every sigh.",
    images: [photo('post-buddy-steps', 1200, 900)],
    likeCount: 47,
    likedBy: [SEED_USER_IDS.priya, SEED_USER_IDS.sam],
  },
  {
    id: 'pst_02',
    authorId: SEED_USER_IDS.priya,
    petId: null,
    groupId: GROUP_IDS.sitters,
    hoursAgo: 9,
    body: 'Sitter brains trust: what do you do when a dog has worked out where the tablet is? Cheese, pâté, and one deeply undignified peanut butter attempt — all returned to sender, tablet intact, dog smug.',
    images: [],
    likeCount: 23,
    likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.sam],
  },
  {
    id: 'pst_03',
    authorId: SEED_USER_IDS.sam,
    petId: SEED_PET_IDS.nala,
    groupId: GROUP_IDS.eastLondon,
    hoursAgo: 14,
    body: 'Victoria Park at 6:40 is the best-kept secret in London. Empty, low mist, and Nala gets to run her full herding routine on absolutely nobody. She has decided the geese count as livestock.',
    images: [photo('post-nala-park', 1200, 900)],
    likeCount: 68,
    likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.priya, SEED_USER_IDS.tom],
  },
  {
    id: 'pst_04',
    authorId: SEED_USER_IDS.priya,
    petId: SEED_PET_IDS.buddy,
    groupId: GROUP_IDS.goldens,
    hoursAgo: 20,
    body: 'Guest post from a sofa I am definitely not allowed on. Buddy and I did the long loop, then he supervised my lunch from eleven centimetres away. Meals and meds all logged, Maya — he has had a very good day.',
    images: [photo('post-buddy-sofa', 1200, 900)],
    likeCount: 39,
    likedBy: [SEED_USER_IDS.maya],
    sitting: true,
  },
  {
    id: 'pst_05',
    authorId: SEED_USER_IDS.maya,
    petId: SEED_PET_IDS.kiwi,
    groupId: GROUP_IDS.birds,
    hoursAgo: 27,
    body: 'Kiwi has learned the microwave beep and now performs it back at us, slightly wrong, at seven in the morning. He turns one this month. No notes, no regrets, no sleep.',
    images: [],
    likeCount: 91,
    likedBy: [SEED_USER_IDS.tom, SEED_USER_IDS.priya],
  },
  {
    id: 'pst_06',
    authorId: SEED_USER_IDS.tom,
    petId: null,
    groupId: GROUP_IDS.joints,
    hoursAgo: 32,
    body: 'Our fifteen-year-old, Sixten, stopped jumping onto the bed in November and we put it down to age. It was arthritis, and it was treatable. If your old cat has "just slowed down", please get the joints looked at. He is back on the bed. He is insufferable.',
    images: [],
    likeCount: 134,
    likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.sam],
  },
  {
    id: 'pst_07',
    authorId: SEED_USER_IDS.maya,
    petId: SEED_PET_IDS.mochi,
    groupId: GROUP_IDS.ragdolls,
    hoursAgo: 39,
    body: 'Mochi has claimed the one square of sun that crosses the hallway between two and three, and she will not be reasoned with about it.',
    images: [photo('post-mochi-sun', 1200, 900)],
    likeCount: 76,
    likedBy: [SEED_USER_IDS.tom],
  },
  {
    id: 'pst_08',
    authorId: SEED_USER_IDS.sam,
    petId: null,
    groupId: GROUP_IDS.sitters,
    hoursAgo: 48,
    body: "Swap offer, east London: I'll take your dog for a long weekend if you'll take Nala for one of mine in September. Crate-trained, brilliant with cats, and will do anything at all for a tennis ball she is not allowed to keep.",
    images: [],
    likeCount: 15,
    likedBy: [SEED_USER_IDS.priya],
  },
  {
    id: 'pst_09',
    authorId: SEED_USER_IDS.maya,
    petId: SEED_PET_IDS.buddy,
    groupId: GROUP_IDS.joints,
    hoursAgo: 54,
    body: "Four months of joint supplements for Buddy's hip, and here is the honest version: the first six weeks did nothing visible and I nearly stopped. Month three is when we got the stairs back. If you're two weeks in and losing faith, give it longer.",
    images: [],
    likeCount: 58,
    likedBy: [SEED_USER_IDS.sam, SEED_USER_IDS.tom],
  },
  {
    id: 'pst_10',
    authorId: SEED_USER_IDS.priya,
    petId: null,
    groupId: GROUP_IDS.goldens,
    hoursAgo: 72,
    body: 'Thirty-one dogs this year and I still write a card for every one at the end of a sit. Half the joy of this job is the handover note.',
    images: [],
    likeCount: 44,
    likedBy: [SEED_USER_IDS.maya],
  },
  {
    id: 'pst_11',
    authorId: SEED_USER_IDS.maya,
    petId: SEED_PET_IDS.kiwi,
    groupId: GROUP_IDS.birds,
    hoursAgo: 81,
    body: 'KIWI HERE. The tall one keeps putting the good millet on the high shelf. I have memorised the shelf. I have memorised the tall one. It is only a matter of time.',
    images: [],
    likeCount: 112,
    likedBy: [SEED_USER_IDS.priya, SEED_USER_IDS.sam, SEED_USER_IDS.tom],
  },
  {
    id: 'pst_12',
    authorId: SEED_USER_IDS.tom,
    petId: null,
    groupId: GROUP_IDS.ragdolls,
    hoursAgo: 96,
    body: 'Not a ragdoll owner, just here for the photographs, and I need you all to know it has completely destroyed my resolve to stop at two cats.',
    images: [],
    likeCount: 29,
    likedBy: [SEED_USER_IDS.maya],
  },
  {
    id: 'pst_13',
    authorId: SEED_USER_IDS.sam,
    petId: SEED_PET_IDS.nala,
    groupId: GROUP_IDS.eastLondon,
    hoursAgo: 107,
    body: 'NALA REPORTING. Rounded up four joggers, two pigeons and one scooter today. Nobody has thanked me. Standards around here are slipping.',
    images: [photo('post-nala-report', 1200, 900)],
    likeCount: 87,
    likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.priya],
  },
  {
    id: 'pst_14',
    authorId: SEED_USER_IDS.maya,
    petId: SEED_PET_IDS.buddy,
    groupId: GROUP_IDS.joints,
    hoursAgo: 120,
    body: "Hip x-ray came back grade 1 — mild, manageable, and caught early because he limped once on a Tuesday and I got paranoid. Getting paranoid was the right call. Don't wait for a second limp.",
    images: [photo('post-buddy-xray', 1200, 900)],
    likeCount: 63,
    likedBy: [SEED_USER_IDS.sam, SEED_USER_IDS.priya],
  },
  {
    id: 'pst_15',
    authorId: SEED_USER_IDS.priya,
    petId: null,
    groupId: GROUP_IDS.eastLondon,
    hoursAgo: 144,
    body: 'PSA for the Hertford Union towpath — broken glass by the second bridge along from Old Ford Lock. Reported it to the council, but boots on paws until someone clears it.',
    images: [],
    likeCount: 52,
    likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.sam],
  },
  {
    id: 'pst_16',
    authorId: SEED_USER_IDS.maya,
    petId: SEED_PET_IDS.mochi,
    groupId: null,
    hoursAgo: 158,
    body: 'Two years today since a very small, very loud cat arrived in a cardboard box that she still, for reasons known only to her, prefers to the seventy-pound bed.',
    images: [photo('post-mochi-box', 1200, 900)],
    likeCount: 81,
    likedBy: [SEED_USER_IDS.priya, SEED_USER_IDS.tom],
  },
  {
    id: 'pst_17',
    authorId: SEED_USER_IDS.sam,
    petId: SEED_PET_IDS.nala,
    groupId: GROUP_IDS.joints,
    hoursAgo: 168,
    body: 'Collie people: what age did you start joint support as a preventative? Nala is three, works hard on the field most weekends, and I would rather be early than sorry.',
    images: [],
    likeCount: 21,
    likedBy: [SEED_USER_IDS.maya],
  },
  {
    id: 'pst_18',
    authorId: SEED_USER_IDS.maya,
    petId: null,
    groupId: GROUP_IDS.birds,
    hoursAgo: 192,
    body: 'A reminder from someone who learned it the frightening way: non-stick pans and birds do not share a house. Overheated PTFE is fatal to them and there is no warning at all. We replaced every pan the week Kiwi arrived.',
    images: [],
    likeCount: 156,
    likedBy: [SEED_USER_IDS.tom, SEED_USER_IDS.priya, SEED_USER_IDS.sam],
  },
];

type CommentSpec = {
  id: string;
  postId: string;
  authorId: ID;
  minutesAfter: number;
  body: string;
  likeCount: number;
  likedBy: ID[];
};

const COMMENT_SPECS: CommentSpec[] = [
  { id: 'cmt_01', postId: 'pst_01', authorId: SEED_USER_IDS.priya, minutesAfter: 41, body: 'He did the steps for me too yesterday. Genuinely bouncing at the top.', likeCount: 6, likedBy: [SEED_USER_IDS.maya] },
  { id: 'cmt_02', postId: 'pst_01', authorId: SEED_USER_IDS.sam, minutesAfter: 96, body: '1.9 kg is a serious result. What did you actually cut in the end?', likeCount: 2, likedBy: [] },
  { id: 'cmt_03', postId: 'pst_01', authorId: SEED_USER_IDS.maya, minutesAfter: 121, body: 'The midday feed, entirely. Breakfast 180 g, dinner 160 g, and treats come out of the daily total now.', likeCount: 9, likedBy: [SEED_USER_IDS.sam, SEED_USER_IDS.tom] },
  { id: 'cmt_04', postId: 'pst_02', authorId: SEED_USER_IDS.sam, minutesAfter: 22, body: 'Two bits of cheese. He gets the first one clean, tablet goes in the second, third one is already coming. Never fails.', likeCount: 14, likedBy: [SEED_USER_IDS.priya, SEED_USER_IDS.maya] },
  { id: 'cmt_05', postId: 'pst_02', authorId: SEED_USER_IDS.maya, minutesAfter: 55, body: 'Sam is right, it is entirely about the rhythm. Also worth asking the vet about the flavoured version — it exists.', likeCount: 5, likedBy: [SEED_USER_IDS.priya] },
  { id: 'cmt_06', postId: 'pst_02', authorId: SEED_USER_IDS.tom, minutesAfter: 140, body: 'Cats: wrap in butter. Chaotic, effective, everyone needs a bath afterwards.', likeCount: 11, likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.sam] },
  { id: 'cmt_07', postId: 'pst_03', authorId: SEED_USER_IDS.maya, minutesAfter: 63, body: 'The geese have never once been informed of this arrangement.', likeCount: 17, likedBy: [SEED_USER_IDS.sam, SEED_USER_IDS.priya] },
  { id: 'cmt_08', postId: 'pst_03', authorId: SEED_USER_IDS.priya, minutesAfter: 210, body: 'Noted for the September swap. Nala and Buddy on the same towpath is a film I want to see.', likeCount: 4, likedBy: [] },
  { id: 'cmt_09', postId: 'pst_04', authorId: SEED_USER_IDS.maya, minutesAfter: 34, body: 'This is the best possible thing to wake up to. Thank you Priya — and yes, the sofa is a lie he tells everyone.', likeCount: 12, likedBy: [SEED_USER_IDS.priya, SEED_USER_IDS.sam] },
  { id: 'cmt_10', postId: 'pst_04', authorId: SEED_USER_IDS.sam, minutesAfter: 88, body: 'Eleven centimetres is generous. Nala supervises from about four.', likeCount: 8, likedBy: [SEED_USER_IDS.maya] },
  { id: 'cmt_11', postId: 'pst_05', authorId: SEED_USER_IDS.tom, minutesAfter: 47, body: 'Ours learned the smoke alarm. I would take the microwave every time.', likeCount: 22, likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.priya] },
  { id: 'cmt_12', postId: 'pst_05', authorId: SEED_USER_IDS.priya, minutesAfter: 130, body: 'Happy nearly-birthday Kiwi. Still the loudest thirty-eight grams in London.', likeCount: 9, likedBy: [SEED_USER_IDS.maya] },
  { id: 'cmt_13', postId: 'pst_06', authorId: SEED_USER_IDS.maya, minutesAfter: 58, body: 'This is such an important one. We assumed the same about Buddy slowing down and it turned out to be his hip.', likeCount: 19, likedBy: [SEED_USER_IDS.tom, SEED_USER_IDS.sam] },
  { id: 'cmt_14', postId: 'pst_06', authorId: SEED_USER_IDS.sam, minutesAfter: 190, body: 'Booking our old boy in this week off the back of this. Thank you for posting it.', likeCount: 15, likedBy: [SEED_USER_IDS.tom] },
  { id: 'cmt_15', postId: 'pst_06', authorId: SEED_USER_IDS.tom, minutesAfter: 320, body: 'Please do. The change in him after three weeks was not subtle.', likeCount: 7, likedBy: [SEED_USER_IDS.sam] },
  { id: 'cmt_16', postId: 'pst_07', authorId: SEED_USER_IDS.tom, minutesAfter: 76, body: 'The sun square is non-negotiable and you knew that when you signed up.', likeCount: 13, likedBy: [SEED_USER_IDS.maya] },
  { id: 'cmt_17', postId: 'pst_07', authorId: SEED_USER_IDS.priya, minutesAfter: 150, body: 'She did exactly this the whole week I sat for her. Followed it across the floor like a very slow clock.', likeCount: 10, likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.tom] },
  { id: 'cmt_18', postId: 'pst_08', authorId: SEED_USER_IDS.priya, minutesAfter: 95, body: 'If nobody takes this I have a free weekend on the 12th. Nala and I already get on.', likeCount: 6, likedBy: [SEED_USER_IDS.sam] },
  { id: 'cmt_19', postId: 'pst_08', authorId: SEED_USER_IDS.maya, minutesAfter: 260, body: 'Tempted, though I suspect Buddy would just watch her work and take notes.', likeCount: 5, likedBy: [SEED_USER_IDS.sam] },
  { id: 'cmt_20', postId: 'pst_09', authorId: SEED_USER_IDS.sam, minutesAfter: 70, body: 'This is exactly what I needed to read — we are three weeks in with Nala and I was starting to wonder.', likeCount: 11, likedBy: [SEED_USER_IDS.maya] },
  { id: 'cmt_21', postId: 'pst_09', authorId: SEED_USER_IDS.tom, minutesAfter: 205, body: 'Same curve with our cat. Nothing, nothing, nothing, then suddenly he was on the windowsill again.', likeCount: 8, likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.sam] },
  { id: 'cmt_22', postId: 'pst_09', authorId: SEED_USER_IDS.maya, minutesAfter: 300, body: 'That is the pattern everyone describes and nobody warns you about. Six weeks is the wall.', likeCount: 6, likedBy: [] },
  { id: 'cmt_23', postId: 'pst_10', authorId: SEED_USER_IDS.maya, minutesAfter: 110, body: 'Can confirm. Ours is on the fridge and I am not taking it down.', likeCount: 16, likedBy: [SEED_USER_IDS.priya] },
  { id: 'cmt_24', postId: 'pst_11', authorId: SEED_USER_IDS.sam, minutesAfter: 66, body: 'The shelf has been memorised. Nobody is safe.', likeCount: 21, likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.tom] },
  { id: 'cmt_25', postId: 'pst_11', authorId: SEED_USER_IDS.tom, minutesAfter: 180, body: 'Genuinely the best thing on this app today.', likeCount: 14, likedBy: [SEED_USER_IDS.maya] },
  { id: 'cmt_26', postId: 'pst_12', authorId: SEED_USER_IDS.maya, minutesAfter: 88, body: 'This is how it starts, Tom. This is exactly how it starts.', likeCount: 18, likedBy: [SEED_USER_IDS.tom, SEED_USER_IDS.priya] },
  { id: 'cmt_27', postId: 'pst_13', authorId: SEED_USER_IDS.priya, minutesAfter: 52, body: 'Four joggers is a strong day. The scooter is the real achievement.', likeCount: 12, likedBy: [SEED_USER_IDS.sam] },
  { id: 'cmt_28', postId: 'pst_13', authorId: SEED_USER_IDS.maya, minutesAfter: 240, body: 'Buddy contributed nothing to the effort and slept for eleven hours. Different management styles.', likeCount: 20, likedBy: [SEED_USER_IDS.sam, SEED_USER_IDS.priya] },
  { id: 'cmt_29', postId: 'pst_14', authorId: SEED_USER_IDS.sam, minutesAfter: 130, body: 'Grade 1 caught this early is genuinely good news. How is he on the stairs now?', likeCount: 4, likedBy: [] },
  { id: 'cmt_30', postId: 'pst_14', authorId: SEED_USER_IDS.maya, minutesAfter: 175, body: 'Much better since month three of the supplement. Recheck is on Thursday and I am cautiously hopeful.', likeCount: 9, likedBy: [SEED_USER_IDS.sam, SEED_USER_IDS.priya] },
  { id: 'cmt_31', postId: 'pst_15', authorId: SEED_USER_IDS.sam, minutesAfter: 61, body: 'Thanks for flagging. Took the long way round this morning because of this post.', likeCount: 10, likedBy: [SEED_USER_IDS.priya] },
  { id: 'cmt_32', postId: 'pst_16', authorId: SEED_USER_IDS.tom, minutesAfter: 99, body: 'Two years of the box. The box has won and everyone should accept it.', likeCount: 15, likedBy: [SEED_USER_IDS.maya] },
  { id: 'cmt_33', postId: 'pst_17', authorId: SEED_USER_IDS.maya, minutesAfter: 143, body: 'Our vet said from two for working dogs, earlier if there is any family history. Worth asking Nadia directly.', likeCount: 7, likedBy: [SEED_USER_IDS.sam] },
  { id: 'cmt_34', postId: 'pst_18', authorId: SEED_USER_IDS.tom, minutesAfter: 210, body: 'Did not know this and we have a bird visiting next month. Replacing the frying pan tonight.', likeCount: 24, likedBy: [SEED_USER_IDS.maya, SEED_USER_IDS.priya, SEED_USER_IDS.sam] },
];

function buildCommunity(now: Date): {
  groups: Group[];
  groupMembers: GroupMember[];
  posts: Post[];
  postLikes: PostLike[];
  comments: Comment[];
  commentLikes: CommentLike[];
} {
  const comments: Comment[] = [];
  const commentLikes: CommentLike[] = [];
  const postLikes: PostLike[] = [];

  const postAt = new Map(POST_SPECS.map((p) => [p.id, subHours(now, p.hoursAgo)]));

  for (const spec of COMMENT_SPECS) {
    const base = postAt.get(spec.postId);
    if (!base) continue;
    comments.push({
      id: spec.id,
      postId: spec.postId,
      authorId: spec.authorId,
      body: spec.body,
      likeCount: spec.likeCount,
      likedByMe: false,
      createdAt: iso(addMinutes(base, spec.minutesAfter)),
    });
    for (const userId of spec.likedBy) commentLikes.push({ commentId: spec.id, userId });
  }

  const posts: Post[] = POST_SPECS.map((spec) => {
    const count = comments.filter((c) => c.postId === spec.id).length;
    for (const userId of spec.likedBy) postLikes.push({ postId: spec.id, userId });
    return {
      id: spec.id,
      authorId: spec.authorId,
      petId: spec.petId,
      groupId: spec.groupId,
      body: spec.body,
      imageUrls: spec.images,
      likeCount: spec.likeCount,
      commentCount: count,
      // Resolved per-viewer by the adapter; the stored value is never trusted.
      likedByMe: false,
      postedWhileSitting: spec.sitting === true,
      createdAt: iso(postAt.get(spec.id)!),
    };
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return {
    groups: buildGroups(),
    groupMembers: [...GROUP_MEMBERSHIPS],
    posts,
    postLikes,
    comments: comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    commentLikes,
  };
}

/* ------------------------------------------------------------------ build */

/**
 * Compose the whole household. Called once on first launch, and again whenever
 * the persisted store goes stale (see `SEED_FRESHNESS_DAYS`).
 */
export function buildSeed(now: Date = new Date()): SeedData {
  const users = buildUsers(now);
  const pets = buildPets(now);
  const memberships = buildMemberships(now, pets);
  const invites = buildInvites(now, memberships);
  const weights = buildWeights(now, pets);
  const vaccinations = buildVaccinations(now);
  const vetVisits = buildVetVisits(now);
  const documents = buildDocuments(now);
  const feedingSchedules = buildFeedingSchedules(now);
  const medicines = buildMedicines(now);
  const appointments = buildAppointments(now);
  const { feedingLogs, medicineLogs } = buildCareLogs(now, pets, feedingSchedules, medicines);
  const activity = buildActivity(now, pets, users, feedingSchedules, medicines, feedingLogs, medicineLogs, weights);
  const community = buildCommunity(now);

  // Denormalised latest weight, so a pet card never has to join the history.
  for (const pet of pets) {
    const latest = weights.filter((w) => w.petId === pet.id).at(-1);
    pet.currentWeightKg = latest ? latest.kg : null;
  }

  return {
    users,
    pets,
    memberships,
    invites,
    weights,
    vaccinations,
    vetVisits,
    documents,
    feedingSchedules,
    feedingLogs,
    medicines,
    medicineLogs,
    appointments,
    activity,
    ...community,
  };
}

export { hash as hashString, rngFrom as seededRandom };
