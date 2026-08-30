/**
 * Petal — domain model.
 *
 * Snake-case in the database, camelCase here; mapping lives in the Supabase
 * adapter so no screen ever sees a `created_at`.
 *
 * Two conventions worth knowing:
 *  - Weights are stored in **kilograms, always**. `weightUnit` is a display
 *    preference only. Storing the user's unit is how apps end up with a 6kg
 *    Great Dane after someone switches to pounds.
 *  - Times-of-day for recurring things are stored as `"HH:mm"` local strings,
 *    not timestamps. A 7am feed is 7am wherever you are; converting it to UTC
 *    means it drifts an hour when the owner flies to another timezone.
 */

import type { Capability, Membership, MembershipRole, PresetId } from '../rbac/permissions';
import type { SpeciesKey } from '../theme/tokens';

export type { Capability, Membership, MembershipRole, PresetId };

export type ID = string;
/** ISO-8601 timestamp. */
export type Timestamp = string;
/** `YYYY-MM-DD`. */
export type DateOnly = string;
/** `HH:mm`, 24-hour, local to the pet's household. */
export type TimeOfDay = string;

/* -------------------------------------------------------------------- user */

export type User = {
  id: ID;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /** Free-text — "Dog mum of two", shown on community posts. */
  bio: string | null
  /**
   * When this account last agreed to the terms, and to which version. Null
   * means they have not agreed to anything yet — the community is closed to
   * them until they do. See `TERMS_VERSION` in `@/features/legal/agreement`.
   */
  termsAcceptedAt: Timestamp | null;
  termsVersion: number | null;
  createdAt: Timestamp;
};

/* --------------------------------------------------------------------- pet */

export type Sex = 'male' | 'female' | 'unknown';

export type Pet = {
  id: ID;
  ownerId: ID;
  name: string;
  species: SpeciesKey;
  breed: string | null;
  /** Null when the owner genuinely doesn't know — common for rescues. */
  birthday: DateOnly | null;
  /** Set when only an approximate age is known; drives "about 3 years old". */
  approximateAgeMonths: number | null;
  sex: Sex;
  neutered: boolean | null;
  colorMarkings: string | null;
  photoUrl: string | null;
  microchipId: string | null;
  microchipRegistry: string | null;
  /** Denormalised latest weight so pet lists don't need a join. */
  currentWeightKg: number | null;
  /** Vet-advised target, used by the weight chart's guide band. */
  targetWeightKg: number | null;
  notes: string | null;
  /** Allergies and conditions surface as warning chips on every care screen. */
  allergies: string[];
  conditions: string[];
  archivedAt: Timestamp | null;
  createdAt: Timestamp;
};

export const SPECIES_META: Record<SpeciesKey, { label: string; emoji: string; icon: string }> = {
  dog: { label: 'Dog', emoji: '🐶', icon: 'paw' },
  cat: { label: 'Cat', emoji: '🐱', icon: 'paw' },
  bird: { label: 'Bird', emoji: '🐦', icon: 'egg-outline' },
  rabbit: { label: 'Rabbit', emoji: '🐰', icon: 'leaf-outline' },
  reptile: { label: 'Reptile', emoji: '🦎', icon: 'bug-outline' },
  fish: { label: 'Fish', emoji: '🐠', icon: 'water-outline' },
  smallPet: { label: 'Small pet', emoji: '🐹', icon: 'ellipse-outline' },
  other: { label: 'Other', emoji: '🐾', icon: 'paw-outline' },
};

/* ------------------------------------------------------------------ weight */

export type WeightEntry = {
  id: ID;
  petId: ID;
  kg: number;
  recordedAt: Timestamp;
  recordedBy: ID;
  note: string | null;
};

/* ------------------------------------------------------------ vaccination */

export type VaccinationStatus = 'upToDate' | 'dueSoon' | 'overdue' | 'scheduled' | 'unknown';

export type Vaccination = {
  id: ID;
  petId: ID;
  name: string;
  /** Core vs non-core matters clinically and drives badge weight in the UI. */
  core: boolean;
  administeredAt: DateOnly | null;
  /** Next dose due. Null for one-off vaccines. */
  dueAt: DateOnly | null;
  vetName: string | null;
  clinic: string | null;
  batchNumber: string | null;
  notes: string | null;
  documentIds: ID[];
  createdBy: ID;
  createdAt: Timestamp;
};

/* ------------------------------------------------------------- vet visits */

export type VetVisitType = 'checkup' | 'illness' | 'injury' | 'dental' | 'surgery' | 'vaccination' | 'other';

export type VetVisit = {
  id: ID;
  petId: ID;
  at: Timestamp;
  type: VetVisitType;
  reason: string;
  vetName: string | null;
  clinic: string | null;
  diagnosis: string | null;
  treatment: string | null
  weightKg: number | null;
  costMinor: number | null;
  currency: string;
  followUpAt: DateOnly | null;
  notes: string | null;
  documentIds: ID[];
  createdBy: ID;
  createdAt: Timestamp;
};

/* -------------------------------------------------------------- documents */

export type DocumentKind = 'record' | 'xray' | 'photo' | 'invoice' | 'prescription' | 'insurance' | 'other';

export type PetDocument = {
  id: ID;
  petId: ID;
  title: string;
  kind: DocumentKind;
  mimeType: string;
  /** Local file URI or Supabase Storage path depending on the active adapter. */
  uri: string;
  thumbnailUri: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  uploadedBy: ID;
  uploadedAt: Timestamp;
};

/* ---------------------------------------------------------------- feeding */

export type PortionUnit = 'g' | 'ml' | 'cup' | 'scoop' | 'can' | 'piece';

export type FeedingSchedule = {
  id: ID;
  petId: ID;
  label: string;
  time: TimeOfDay;
  foodName: string;
  portion: number;
  unit: PortionUnit;
  /** 0=Sunday … 6=Saturday. All seven for a daily schedule. */
  daysOfWeek: number[];
  remindersOn: boolean;
  active: boolean;
  notes: string | null;
  createdAt: Timestamp;
};

export type FeedingLog = {
  id: ID;
  petId: ID;
  scheduleId: ID | null;
  at: Timestamp;
  foodName: string;
  portion: number;
  unit: PortionUnit;
  /** A skipped meal is data, not an absence — vets ask about appetite. */
  skipped: boolean;
  loggedBy: ID;
  note: string | null;
};

/* --------------------------------------------------------------- medicine */

export type MedicineForm = 'tablet' | 'capsule' | 'liquid' | 'injection' | 'topical' | 'drops' | 'chew' | 'inhaler';
export type MedicineFrequency = 'daily' | 'twiceDaily' | 'threeTimesDaily' | 'everyOtherDay' | 'weekly' | 'monthly' | 'asNeeded';

export type Medicine = {
  id: ID;
  petId: ID;
  name: string;
  form: MedicineForm;
  dosage: string;
  frequency: MedicineFrequency;
  timesOfDay: TimeOfDay[];
  startsAt: DateOnly;
  /** Null for ongoing/lifelong medication. */
  endsAt: DateOnly | null;
  /** Doses left in the current pack — drives the refill nudge. */
  remainingDoses: number | null;
  refillAt: DateOnly | null;
  prescribedBy: string | null;
  instructions: string | null;
  /** e.g. "Give with food" — shown on the log button itself, not buried. */
  withFood: boolean;
  remindersOn: boolean;
  active: boolean;
  createdAt: Timestamp;
};

export type DoseStatus = 'given' | 'skipped' | 'missed';

export type MedicineLog = {
  id: ID;
  petId: ID;
  medicineId: ID;
  /** The slot this dose belongs to, so adherence maths can find gaps. */
  scheduledFor: Timestamp;
  at: Timestamp | null;
  status: DoseStatus;
  dosage: string | null;
  loggedBy: ID;
  note: string | null;
};

/* ----------------------------------------------------------- appointments */

export type AppointmentType = 'checkup' | 'vaccination' | 'dental' | 'grooming' | 'surgery' | 'followUp' | 'other';
export type AppointmentStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'missed';

export type Appointment = {
  id: ID;
  petId: ID;
  at: Timestamp;
  durationMin: number;
  type: AppointmentType;
  reason: string;
  clinic: string | null;
  clinicPhone: string | null;
  clinicAddress: string | null;
  vetName: string | null;
  status: AppointmentStatus;
  notes: string | null;
  /** Minutes before `at` to fire reminders. Multiple allowed (1 day + 1 hour). */
  reminderOffsets: number[];
  /** Cross-links so a visit's paperwork is one tap from the appointment. */
  linkedDocumentIds: ID[];
  linkedVaccinationIds: ID[];
  /** Set once the visit is written up. */
  vetVisitId: ID | null;
  createdBy: ID;
  createdAt: Timestamp;
};

/* -------------------------------------------------------------- caregiving */

export type InviteStatus = 'active' | 'accepted' | 'expired' | 'revoked';

export type Invite = {
  id: ID;
  petId: ID;
  /** Short human-typeable code (e.g. "BUDDY-4KQ2"). Also encoded in the QR. */
  code: string;
  createdBy: ID;
  presetId: PresetId;
  grants: Capability[];
  startsAt: Timestamp | null;
  endsAt: Timestamp | null;
  /** The invite link itself expires, separately from the access window. */
  expiresAt: Timestamp;
  maxUses: number;
  uses: number;
  status: InviteStatus;
  /** Optional pre-fill so the owner can say who it's for. */
  inviteeName: string | null;
  inviteeEmail: string | null;
  createdAt: Timestamp;
};

/** Membership joined with its user, for caregiver lists. */
export type MembershipWithUser = Membership & { user: User };

/* --------------------------------------------------------- activity log */

export type ActivityAction =
  | 'feeding.logged'
  | 'feeding.skipped'
  | 'medicine.given'
  | 'medicine.skipped'
  | 'weight.recorded'
  | 'vaccination.updated'
  | 'vetvisit.created'
  | 'document.uploaded'
  | 'appointment.created'
  | 'appointment.updated'
  | 'pet.updated'
  | 'caregiver.invited'
  | 'caregiver.joined'
  | 'caregiver.revoked'
  | 'permission.denied';

export type ActivityEvent = {
  id: ID;
  petId: ID;
  actorId: ID;
  actorRole: MembershipRole;
  action: ActivityAction;
  /** Pre-rendered sentence — "Priya logged Buddy's dinner (120g kibble)". */
  summary: string;
  entityId: ID | null;
  at: Timestamp;
  meta: Record<string, string | number | boolean | null>;
};

/* -------------------------------------------------------------- community */

export type GroupKind = 'breed' | 'species' | 'topic' | 'local';

export type Group = {
  id: ID;
  name: string;
  slug: string;
  kind: GroupKind;
  description: string;
  memberCount: number;
  postCount: number;
  /** Deterministic cover tint so group cards feel authored, not random. */
  accent: string;
  joined: boolean;
};

export type Post = {
  id: ID;
  authorId: ID;
  /** Posts can be "as" a pet — that's the whole charm of a pet community. */
  petId: ID | null;
  groupId: ID | null;
  body: string;
  imageUrls: string[];
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  /** True when a caregiver posted while sitting — shown as a subtle badge. */
  postedWhileSitting: boolean;
  /**
   * Set when moderation has taken this down. Nobody but the author can see a
   * hidden post at all, and the author sees it badged rather than vanished —
   * content that disappears without a word reads as a bug, not a consequence.
   */
  hiddenAt: Timestamp | null;
  createdAt: Timestamp;
};

export type PostWithAuthor = Post & { author: User; pet: Pet | null; group: Group | null };

export type Comment = {
  id: ID;
  postId: ID;
  authorId: ID;
  body: string;
  likeCount: number;
  likedByMe: boolean;
  /** As on `Post` — taken down, and visible only to whoever wrote it. */
  hiddenAt: Timestamp | null;
  createdAt: Timestamp;
};

export type CommentWithAuthor = Comment & { author: User };

/* ------------------------------------------------------------- moderation */

/**
 * Why somebody flagged something. The order is the order the sheet offers them
 * in, which is roughly "most reported first" rather than alphabetical — the
 * common cases should be reachable without reading the whole list.
 */
export type ReportReason =
  | 'harassment'
  | 'hate'
  | 'sexual'
  | 'violence'
  | 'animalCruelty'
  | 'spam'
  | 'impersonation'
  | 'selfHarm'
  | 'other';

export type ReportTargetKind = 'post' | 'comment' | 'user';

/**
 * `open` is the queue. `actioned` means the content came down and, where the
 * account was at fault, the account went with it. `dismissed` means a human
 * looked and there was nothing to answer — which is still a decision, and still
 * has to happen inside the same day.
 */
export type ReportStatus = 'open' | 'actioned' | 'dismissed';

export type ContentReport = {
  id: ID;
  reporterId: ID;
  targetKind: ReportTargetKind;
  targetId: ID;
  /** Whose content it was — the account a moderator may end up ejecting. */
  targetAuthorId: ID | null;
  reason: ReportReason;
  /** The reporter's own words. Optional, and usually the most useful field. */
  details: string | null;
  /** Copy of the reported text, kept so a deleted post is still reviewable. */
  snapshot: string | null;
  status: ReportStatus;
  createdAt: Timestamp;
  resolvedAt: Timestamp | null;
};

/** One account this user has blocked, joined with enough to render the row. */
export type BlockedAccount = {
  userId: ID;
  displayName: string;
  avatarUrl: string | null;
  blockedAt: Timestamp;
};

export const REPORT_REASON_META: Record<
  ReportReason,
  { label: string; description: string; icon: string }
> = {
  harassment: {
    label: 'Harassment or bullying',
    description: 'Aimed at a person — insults, pile-ons, unwanted contact.',
    icon: 'person-remove-outline',
  },
  hate: {
    label: 'Hate speech',
    description: 'Attacks someone for who they are.',
    icon: 'ban-outline',
  },
  sexual: {
    label: 'Sexual or adult content',
    description: 'Nudity, sexual content, or anything soliciting it.',
    icon: 'eye-off-outline',
  },
  violence: {
    label: 'Violence or threats',
    description: 'Threatens harm to a person.',
    icon: 'warning-outline',
  },
  animalCruelty: {
    label: 'Animal cruelty',
    description: 'Shows or encourages harming an animal.',
    icon: 'paw-outline',
  },
  spam: {
    label: 'Spam or a scam',
    description: 'Selling, promoting, or trying to take someone in.',
    icon: 'mail-unread-outline',
  },
  impersonation: {
    label: 'Impersonation',
    description: 'Pretending to be someone else, or a pet that isn’t theirs.',
    icon: 'people-outline',
  },
  selfHarm: {
    label: 'Self-harm',
    description: 'Someone may be at risk. We look at these first.',
    icon: 'heart-dislike-outline',
  },
  other: {
    label: 'Something else',
    description: 'Tell us what’s wrong and we’ll look.',
    icon: 'ellipsis-horizontal-outline',
  },
};

/* ---------------------------------------------------------- derived views */

/**
 * The Today screen shows feeding, medicine and appointments in one timeline.
 * Rather than three lists stapled together, the adapter returns a single
 * normalised task stream — which is also what makes "3 of 7 done" honest.
 */
export type TaskKind = 'feeding' | 'medicine' | 'appointment';
export type TaskState = 'due' | 'upcoming' | 'done' | 'skipped' | 'overdue';

export type CareTask = {
  id: ID;
  kind: TaskKind;
  petId: ID;
  /** Slot time this task belongs to. */
  at: Timestamp;
  title: string;
  subtitle: string;
  state: TaskState;
  /** Source row, so tapping through goes to the right detail screen. */
  sourceId: ID;
  /** Which capability is needed to complete it — drives the disabled state. */
  requires: Capability;
  /** Who completed it, for the "logged by Priya" line. */
  completedBy: ID | null;
  completedAt: Timestamp | null;
  meta: Record<string, string | number | boolean | null>;
};

export type DaySummary = {
  date: DateOnly;
  total: number;
  done: number;
  overdue: number;
};

/** Adherence over a window, for the medicine screen's ring + sparkline. */
export type AdherenceSummary = {
  medicineId: ID;
  windowDays: number;
  expected: number;
  given: number;
  skipped: number;
  missed: number;
  /** 0–1. */
  rate: number;
  /** Consecutive days with every dose given. */
  streakDays: number;
  /** One bucket per day, oldest first — feeds the sparkline. */
  daily: { date: DateOnly; expected: number; given: number }[];
};

/* ------------------------------------------------------------- session */

export type Session = {
  user: User;
  /** Every membership this user holds, across all pets. Drives the dual role. */
  memberships: Membership[];
  accessToken: string | null;
};
