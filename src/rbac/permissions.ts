/**
 * Petal — RBAC model.
 *
 * The brief's hard requirement: a user is **not** globally an owner or a
 * caregiver. They hold a *membership per pet*, so the same person can own Buddy
 * and sit for Mochi in the same session. Every authorisation question is
 * therefore `(user, pet, capability)` — never `(user, capability)`.
 *
 * Caregiver access is scoped three ways at once:
 *   1. **Capability** — an explicit grant list, intersected with the set of
 *      capabilities a caregiver may *ever* hold (so a bad server row can't
 *      hand out `pet.delete`).
 *   2. **Time** — an optional `[startsAt, endsAt]` window. Access outside the
 *      sitting dates is denied even if the grant is present.
 *   3. **Status** — pending / active / expired / revoked.
 *
 * `evaluate()` returns a *reason* on denial, not just `false`. That reason is
 * what lets the UI say "You can log meals, but Priya keeps vaccination records"
 * instead of greying a button out silently.
 *
 * This module is pure and dependency-free on purpose: the same matrices are
 * consumed by the UI (`usePermission`), asserted in the data adapter before any
 * mutation, and mirrored by the Supabase RLS policies in
 * `supabase/migrations/0001_init.sql`. Three enforcement points, one source of
 * truth.
 */

/* ------------------------------------------------------------ capabilities */

export const CAPABILITIES = [
  // Pet record
  'pet.view',
  'pet.edit',
  'pet.delete',
  'pet.transfer',
  // Weight
  'weight.view',
  'weight.log',
  // Vaccinations
  'vaccination.view',
  'vaccination.edit',
  // Vet visits
  'vetvisit.view',
  'vetvisit.edit',
  // Documents (records, x-rays)
  'document.view',
  'document.upload',
  'document.delete',
  // Feeding
  'feeding.view',
  'feeding.log',
  'feeding.schedule.edit',
  // Medicine
  'medicine.view',
  'medicine.log',
  'medicine.edit',
  // Appointments
  'appointment.view',
  'appointment.create',
  'appointment.edit',
  // Caregiver administration
  'caregiver.view',
  'caregiver.invite',
  'caregiver.revoke',
  // Audit trail
  'activity.view',
  // Community
  'community.post',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type MembershipRole = 'owner' | 'caregiver';
export type MembershipStatus = 'active' | 'pending' | 'expired' | 'revoked';

export type Membership = {
  id: string;
  petId: string;
  userId: string;
  role: MembershipRole;
  /** Explicit grants. Ignored for owners (who hold everything). */
  grants: Capability[];
  /** ISO date-time. Null means "from now". */
  startsAt: string | null;
  /** ISO date-time. Null means open-ended. */
  endsAt: string | null;
  status: MembershipStatus;
  /** Who invited this caregiver — surfaced in the activity log. */
  invitedBy?: string | null;
  createdAt: string;
};

/* ---------------------------------------------------------------- matrices */

/** Owners hold every capability, including the destructive ones. */
export const OWNER_CAPABILITIES: readonly Capability[] = CAPABILITIES;

/**
 * The ceiling for caregivers. Anything absent here can never be granted, no
 * matter what a membership row claims — deleting a pet, transferring ownership,
 * and managing other caregivers stay with the owner permanently.
 */
export const CAREGIVER_GRANTABLE: readonly Capability[] = [
  'pet.view',
  'weight.view',
  'weight.log',
  'vaccination.view',
  'vetvisit.view',
  'document.view',
  'document.upload',
  'feeding.view',
  'feeding.log',
  'feeding.schedule.edit',
  'medicine.view',
  'medicine.log',
  'appointment.view',
  'appointment.create',
  'appointment.edit',
  'vaccination.edit',
  'vetvisit.edit',
  'community.post',
];

/** Capabilities every accepted caregiver gets implicitly — without them the app is unusable. */
export const CAREGIVER_BASELINE: readonly Capability[] = ['pet.view', 'feeding.view', 'medicine.view'];

/** Owner-only capabilities, listed explicitly for the UI to explain. */
export const OWNER_ONLY: readonly Capability[] = CAPABILITIES.filter(
  (c) => !CAREGIVER_GRANTABLE.includes(c),
);

/* ----------------------------------------------------------------- presets */

/**
 * Preset bundles for the invite flow. Real sitting arrangements come in a few
 * recognisable shapes, so we offer those instead of a 27-checkbox wall — with a
 * "Custom" escape hatch.
 */
export type PresetId = 'viewOnly' | 'dailyCare' | 'fullSitter' | 'vetTrips' | 'custom';

export type CaregiverPreset = {
  id: PresetId;
  label: string;
  /** One line the owner reads to decide. Written in plain language. */
  summary: string;
  /** Shown on the caregiver's own "what can I do" card. */
  caregiverBlurb: string;
  icon: string;
  grants: Capability[];
};

export const CAREGIVER_PRESETS: CaregiverPreset[] = [
  {
    id: 'viewOnly',
    label: 'View only',
    summary: 'Can see profiles and schedules. Cannot log or change anything.',
    caregiverBlurb: "You can see everything you need, but logging is off — just look, don't touch.",
    icon: 'eye-outline',
    grants: ['pet.view', 'feeding.view', 'medicine.view', 'vaccination.view', 'appointment.view'],
  },
  {
    id: 'dailyCare',
    label: 'Daily care',
    summary: 'Can log meals and medicine. Cannot edit schedules or health records.',
    caregiverBlurb: 'You can log meals and medicine as you go. Schedules stay as the owner set them.',
    icon: 'restaurant-outline',
    grants: [
      'pet.view',
      'feeding.view',
      'feeding.log',
      'medicine.view',
      'medicine.log',
      'weight.view',
      'appointment.view',
    ],
  },
  {
    id: 'fullSitter',
    label: 'Full sitter',
    summary: 'Everything in Daily care, plus weight logs, health records and photos.',
    caregiverBlurb:
      'You can log meals, medicine and weight, see health records, and add photos. Vaccination history is read-only.',
    icon: 'home-outline',
    grants: [
      'pet.view',
      'feeding.view',
      'feeding.log',
      'feeding.schedule.edit',
      'medicine.view',
      'medicine.log',
      'weight.view',
      'weight.log',
      'vaccination.view',
      'vetvisit.view',
      'document.view',
      'document.upload',
      'appointment.view',
      'community.post',
    ],
  },
  {
    id: 'vetTrips',
    label: 'Vet trips',
    summary: 'Can book and update appointments and record what the vet said.',
    caregiverBlurb:
      'You can book appointments and write up visits. Handy if you are the one driving to the clinic.',
    icon: 'medkit-outline',
    grants: [
      'pet.view',
      'feeding.view',
      'medicine.view',
      'medicine.log',
      'vaccination.view',
      'vaccination.edit',
      'vetvisit.view',
      'vetvisit.edit',
      'document.view',
      'document.upload',
      'appointment.view',
      'appointment.create',
      'appointment.edit',
      'weight.view',
      'weight.log',
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    summary: 'Pick exactly what this person can do.',
    caregiverBlurb: 'The owner picked a custom set of permissions for you.',
    icon: 'options-outline',
    grants: [],
  },
];

export const presetById = (id: PresetId) =>
  CAREGIVER_PRESETS.find((p) => p.id === id) ?? CAREGIVER_PRESETS[0]!;

/**
 * Reverse-match a grant list to a preset so the UI can label an existing
 * caregiver "Full sitter" rather than "14 permissions".
 */
export function matchPreset(grants: Capability[]): PresetId {
  const sorted = [...new Set(grants)].sort().join('|');
  for (const preset of CAREGIVER_PRESETS) {
    if (preset.id === 'custom') continue;
    if ([...new Set(preset.grants)].sort().join('|') === sorted) return preset.id;
  }
  return 'custom';
}

/* -------------------------------------------------------------- evaluation */

export type DenialReason =
  | 'no-membership'
  | 'owner-only'
  | 'not-granted'
  | 'window-not-started'
  | 'window-expired'
  | 'invite-pending'
  | 'revoked';

export type PermissionVerdict =
  | { allowed: true; role: MembershipRole }
  | { allowed: false; reason: DenialReason; role: MembershipRole | null };

/** Human copy for each denial, written to be shown directly in the UI. */
export const DENIAL_COPY: Record<DenialReason, { title: string; body: string }> = {
  'no-membership': {
    title: 'No access to this pet',
    body: "You're not linked to this pet. Ask the owner to send you an invite.",
  },
  'owner-only': {
    title: 'Owner only',
    body: 'Only the pet’s owner can do this — it stays with them even for full sitters.',
  },
  'not-granted': {
    title: 'Not part of your access',
    body: 'The owner didn’t include this in your permissions. You can ask them to add it.',
  },
  'window-not-started': {
    title: 'Access hasn’t started yet',
    body: 'Your sitting dates begin later. Everything unlocks automatically on day one.',
  },
  'window-expired': {
    title: 'Access has ended',
    body: 'Your sitting dates have finished. Ask the owner to extend if you’re still helping out.',
  },
  'invite-pending': {
    title: 'Invite not accepted',
    body: 'Accept the owner’s invite to start logging care.',
  },
  revoked: {
    title: 'Access was removed',
    body: 'The owner turned off your access to this pet.',
  },
};

const ALLOW = (role: MembershipRole): PermissionVerdict => ({ allowed: true, role });
const DENY = (reason: DenialReason, role: MembershipRole | null = null): PermissionVerdict => ({
  allowed: false,
  reason,
  role,
});

/**
 * The single authorisation function. `now` is injected so the time-window
 * branches are testable and so a screen can preview "what will this caregiver
 * be able to do next Tuesday".
 */
export function evaluate(
  membership: Membership | null | undefined,
  capability: Capability,
  now: Date = new Date(),
): PermissionVerdict {
  if (!membership) return DENY('no-membership');

  if (membership.role === 'owner') {
    // Owners are never time-scoped or revoked; ownership is the root grant.
    return ALLOW('owner');
  }

  switch (membership.status) {
    case 'revoked':
      return DENY('revoked', 'caregiver');
    case 'pending':
      return DENY('invite-pending', 'caregiver');
    case 'expired':
      return DENY('window-expired', 'caregiver');
    default:
      break;
  }

  const t = now.getTime();
  if (membership.startsAt && t < Date.parse(membership.startsAt)) {
    return DENY('window-not-started', 'caregiver');
  }
  if (membership.endsAt && t > Date.parse(membership.endsAt)) {
    return DENY('window-expired', 'caregiver');
  }

  if (!CAREGIVER_GRANTABLE.includes(capability)) {
    return DENY('owner-only', 'caregiver');
  }

  const effective = new Set<Capability>([...CAREGIVER_BASELINE, ...membership.grants]);
  if (!effective.has(capability)) {
    return DENY('not-granted', 'caregiver');
  }

  return ALLOW('caregiver');
}

/** Convenience boolean form. */
export function can(
  membership: Membership | null | undefined,
  capability: Capability,
  now?: Date,
): boolean {
  return evaluate(membership, capability, now).allowed;
}

/** Full effective capability set — used to render the caregiver's access card. */
export function effectiveCapabilities(
  membership: Membership | null | undefined,
  now: Date = new Date(),
): Capability[] {
  if (!membership) return [];
  if (membership.role === 'owner') return [...OWNER_CAPABILITIES];
  return CAPABILITIES.filter((c) => can(membership, c, now));
}

/** Clamp an arbitrary grant list to what a caregiver may legally hold. */
export function sanitizeGrants(grants: Capability[]): Capability[] {
  const allowed = new Set(CAREGIVER_GRANTABLE);
  return [...new Set(grants)].filter((g) => allowed.has(g));
}

/* ------------------------------------------------------- window helpers */

export type WindowState = 'upcoming' | 'active' | 'ended' | 'open-ended';

export function windowState(membership: Membership, now: Date = new Date()): WindowState {
  const t = now.getTime();
  if (membership.startsAt && t < Date.parse(membership.startsAt)) return 'upcoming';
  if (membership.endsAt && t > Date.parse(membership.endsAt)) return 'ended';
  if (!membership.endsAt) return 'open-ended';
  return 'active';
}

/* -------------------------------------------------- capability metadata */

/**
 * Grouped, human-labelled capability list for the permission editor. Grouping
 * matters: an owner scanning "Feeding / Medicine / Health records" makes a
 * decision in seconds; a flat list of 27 checkboxes makes them give up and
 * grant everything.
 */
export type CapabilityGroup = {
  id: string;
  label: string;
  icon: string;
  items: { capability: Capability; label: string; hint?: string }[];
};

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    id: 'feeding',
    label: 'Feeding',
    icon: 'restaurant-outline',
    items: [
      { capability: 'feeding.view', label: 'See feeding schedule' },
      { capability: 'feeding.log', label: 'Log meals' },
      {
        capability: 'feeding.schedule.edit',
        label: 'Change the schedule',
        hint: 'Lets them adjust times and portions, not just tick meals off.',
      },
    ],
  },
  {
    id: 'medicine',
    label: 'Medicine',
    icon: 'medical-outline',
    items: [
      { capability: 'medicine.view', label: 'See medicines & doses' },
      { capability: 'medicine.log', label: 'Log doses given' },
    ],
  },
  {
    id: 'health',
    label: 'Health records',
    icon: 'heart-outline',
    items: [
      { capability: 'weight.view', label: 'See weight history' },
      { capability: 'weight.log', label: 'Record a weight' },
      { capability: 'vaccination.view', label: 'See vaccinations' },
      {
        capability: 'vaccination.edit',
        label: 'Update vaccinations',
        hint: 'Usually only needed if they take your pet to the vet.',
      },
      { capability: 'vetvisit.view', label: 'See vet visit history' },
      { capability: 'vetvisit.edit', label: 'Write up a vet visit' },
    ],
  },
  {
    id: 'documents',
    label: 'Documents',
    icon: 'document-attach-outline',
    items: [
      { capability: 'document.view', label: 'Open records & x-rays' },
      { capability: 'document.upload', label: 'Add documents & photos' },
    ],
  },
  {
    id: 'appointments',
    label: 'Appointments',
    icon: 'calendar-outline',
    items: [
      { capability: 'appointment.view', label: 'See appointments' },
      { capability: 'appointment.create', label: 'Book appointments' },
      { capability: 'appointment.edit', label: 'Reschedule or edit' },
    ],
  },
  {
    id: 'community',
    label: 'Community',
    icon: 'chatbubbles-outline',
    items: [
      {
        capability: 'community.post',
        label: 'Post about this pet',
        hint: 'Posts are attributed to them, and show they’re sitting.',
      },
    ],
  },
];

/** Flat label lookup for toasts, activity log lines and denial sheets. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  'pet.view': 'View pet',
  'pet.edit': 'Edit pet profile',
  'pet.delete': 'Delete pet',
  'pet.transfer': 'Transfer ownership',
  'weight.view': 'View weight history',
  'weight.log': 'Record weight',
  'vaccination.view': 'View vaccinations',
  'vaccination.edit': 'Update vaccinations',
  'vetvisit.view': 'View vet visits',
  'vetvisit.edit': 'Write up vet visits',
  'document.view': 'View documents',
  'document.upload': 'Add documents',
  'document.delete': 'Delete documents',
  'feeding.view': 'View feeding schedule',
  'feeding.log': 'Log meals',
  'feeding.schedule.edit': 'Edit feeding schedule',
  'medicine.view': 'View medicines',
  'medicine.log': 'Log doses',
  'medicine.edit': 'Edit medicines',
  'appointment.view': 'View appointments',
  'appointment.create': 'Book appointments',
  'appointment.edit': 'Edit appointments',
  'caregiver.view': 'View caregivers',
  'caregiver.invite': 'Invite caregivers',
  'caregiver.revoke': 'Remove caregivers',
  'activity.view': 'View activity log',
  'community.post': 'Post to community',
};

/** Thrown by the data layer when a mutation fails authorisation. */
export class PermissionError extends Error {
  readonly reason: DenialReason;
  readonly capability: Capability;
  readonly petId: string;

  constructor(capability: Capability, petId: string, reason: DenialReason) {
    super(`Permission denied: ${capability} on pet ${petId} (${reason})`);
    this.name = 'PermissionError';
    this.capability = capability;
    this.petId = petId;
    this.reason = reason;
  }
}
