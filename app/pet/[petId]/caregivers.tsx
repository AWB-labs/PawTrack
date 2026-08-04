/**
 * Caregiver management — the owner's view of who can touch this pet's record.
 *
 * `caregiver.view` sits outside `CAREGIVER_GRANTABLE`, so this screen is owner-
 * only *by construction*: no membership can ever be granted it. That makes the
 * non-owner branch a real, reachable state (a sitter follows a stale link, or an
 * owner transfers a pet mid-session) and it gets a designed explanation rather
 * than an empty list or a thrown permission error. The reads are gated too —
 * passing `null` for the pet id is what keeps the queries from firing at all.
 *
 * The list is bucketed the way an owner actually thinks about it:
 *
 *   · **Right now** — the people who can log something today.
 *   · **Waiting** — pending memberships and unused invite codes, together,
 *     because from the owner's side they're the same unfinished errand.
 *   · **Finished** — collapsed. Revoked and lapsed rows are kept (the activity
 *     trail has to stay attributable to a person) but they must not compete with
 *     the live ones for attention.
 *
 * Editing permissions and dates happens in sheets rather than on a sub-screen:
 * the answer to "can Sam still log meals tomorrow?" should never cost a
 * navigation you have to come back from.
 */

import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useInvites, usePetCaregivers, useRevokeInvite, useRevokeMembership, useUpdateMembership } from '@/data/queries/useCaregivers';
import { useUser } from '@/data/queries/useUsers';
import type { Invite, MembershipWithUser } from '@/data/types';
import { CaregiverRow } from '@/features/caregivers/CaregiverRow';
import { InviteCard } from '@/features/caregivers/InviteCard';
import { InviteQR } from '@/features/caregivers/InviteQR';
import { usePetScope } from '@/features/pets/PetScope';
import {
  endOfLocalDayISO,
  formatDay,
  fromDateOnly,
  relativeTime,
  startOfLocalDayISO,
  toDateOnly,
} from '@/lib/date';
import { buildInviteUrl, toHref } from '@/lib/deeplinks';
import { plural, possessive } from '@/lib/format';
import { CapabilityPicker } from '@/rbac/CapabilityPicker';
import { askOwnerForAccess } from '@/rbac/DenialSheet';
import {
  matchPreset,
  sanitizeGrants,
  windowState,
  type Capability,
  type PresetId,
} from '@/rbac/permissions';
import { useNow } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  AvatarStack,
  Button,
  Chip,
  Column,
  DateField,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Sheet,
  Surface,
  Text,
  toast,
  useSheet,
  type AvatarStackItem,
  type CalendarRange,
} from '@/ui';
import { EmptyCaregivers, PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { CaregiverRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ------------------------------------------------------------------ helpers */

/** A calendar range is whole days; a membership window is instants. */
function rangeToWindow(range: CalendarRange): { startsAt: string | null; endsAt: string | null } {
  const start = range.start ? fromDateOnly(range.start) : null;
  const end = range.end ? fromDateOnly(range.end) : null;
  return {
    startsAt: start ? startOfLocalDayISO(start) : null,
    // The last day has to be inclusive, or a sitter loses access at breakfast.
    endsAt: end ? endOfLocalDayISO(end) : null,
  };
}

function windowToRange(startsAt: string | null, endsAt: string | null): CalendarRange {
  return {
    start: startsAt ? toDateOnly(startsAt) : null,
    end: endsAt ? toDateOnly(endsAt) : null,
  };
}

/** Buckets, in the order the screen renders them. */
function bucket(rows: readonly MembershipWithUser[], now: Date) {
  const owners: MembershipWithUser[] = [];
  const current: MembershipWithUser[] = [];
  const waiting: MembershipWithUser[] = [];
  const finished: MembershipWithUser[] = [];

  for (const row of rows) {
    if (row.role === 'owner') {
      owners.push(row);
    } else if (row.status === 'pending') {
      waiting.push(row);
    } else if (row.status === 'revoked' || row.status === 'expired') {
      finished.push(row);
    } else if (windowState(row, now) === 'ended') {
      finished.push(row);
    } else {
      current.push(row);
    }
  }
  return { owners, current, waiting, finished };
}

/* ---------------------------------------------------------------- component */

export default function CaregiversScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const now = useNow();

  const petId = scope.petId;
  const pet = scope.pet;
  const petName = pet?.name ?? 'this pet';
  const owner = useUser(pet?.ownerId);

  /** Managing caregivers is owner-only forever, so the reads are gated on it. */
  const isOwner = scope.isOwner;
  const gatedId = isOwner ? petId : null;

  const caregiversQuery = usePetCaregivers(gatedId);
  const invitesQuery = useInvites(gatedId);

  const updateMembership = useUpdateMembership(petId);
  const revokeMembership = useRevokeMembership(petId);
  const revokeInvite = useRevokeInvite(petId);

  const permissionsSheet = useSheet();
  const datesSheet = useSheet();
  const qrSheet = useSheet();

  const [editing, setEditing] = useState<MembershipWithUser | null>(null);
  const [draftGrants, setDraftGrants] = useState<Capability[]>([]);
  const [draftPreset, setDraftPreset] = useState<PresetId>('custom');
  const [draftRange, setDraftRange] = useState<CalendarRange>({ start: null, end: null });
  const [qrInvite, setQrInvite] = useState<Invite | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo(() => caregiversQuery.data ?? [], [caregiversQuery.data]);
  const invites = useMemo(() => invitesQuery.data ?? [], [invitesQuery.data]);
  const groups = useMemo(() => bucket(rows, now), [rows, now]);

  const liveInvites = useMemo(
    () => invites.filter((row) => row.status === 'active' && Date.parse(row.expiresAt) > now.getTime()),
    [invites, now],
  );
  const spentInvites = useMemo(
    () => invites.filter((row) => !liveInvites.includes(row)),
    [invites, liveInvites],
  );

  const helperCount = groups.current.length;
  const waitingCount = groups.waiting.length + liveInvites.length;

  const avatars = useMemo<AvatarStackItem[]>(
    () =>
      [...groups.owners, ...groups.current].map((row) => ({
        id: row.id,
        name: row.user.displayName,
        uri: row.user.avatarUrl,
        ring: row.role === 'owner',
      })),
    [groups.current, groups.owners],
  );

  /* ---- actions ---------------------------------------------------------- */

  const openInviteFlow = useCallback(() => {
    router.push(toHref(`/pet/${petId}/invite`));
  }, [petId, router]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([caregiversQuery.refetch(), invitesQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [caregiversQuery, invitesQuery]);

  const openPermissions = useCallback(
    (membership: MembershipWithUser) => {
      setEditing(membership);
      const clean = sanitizeGrants(membership.grants);
      setDraftGrants(clean);
      setDraftPreset(matchPreset(clean));
      permissionsSheet.open();
    },
    [permissionsSheet],
  );

  const openDates = useCallback(
    (membership: MembershipWithUser) => {
      setEditing(membership);
      setDraftRange(windowToRange(membership.startsAt, membership.endsAt));
      datesSheet.open();
    },
    [datesSheet],
  );

  const savePermissions = useCallback(() => {
    if (!editing) return;
    updateMembership.mutate({
      membershipId: editing.id,
      patch: { grants: sanitizeGrants(draftGrants) },
    });
    permissionsSheet.close();
    toast.success(`${editing.user.displayName}'s access updated`, {
      description: `They'll see the change next time they open ${petName}.`,
    });
  }, [draftGrants, editing, permissionsSheet, petName, updateMembership]);

  const saveDates = useCallback(() => {
    if (!editing) return;
    const window = rangeToWindow(draftRange);
    updateMembership.mutate({
      membershipId: editing.id,
      patch: {
        ...window,
        // Re-opening a finished arrangement is the common case behind this
        // sheet, so a future end date puts the membership back in play.
        status: window.endsAt === null || Date.parse(window.endsAt) > now.getTime() ? 'active' : 'expired',
      },
    });
    datesSheet.close();
    toast.success('Sitting dates saved', {
      description: `${editing.user.displayName} is set for ${petName}.`,
    });
  }, [datesSheet, draftRange, editing, now, petName, updateMembership]);

  const handleRevokeMembership = useCallback(
    (membership: MembershipWithUser) => {
      revokeMembership.mutate(membership.id);
      toast.info(`${membership.user.displayName} can no longer help with ${petName}`, {
        description: 'Everything they logged stays in the activity log.',
      });
    },
    [petName, revokeMembership],
  );

  const handleRevokeInvite = useCallback(
    (invite: Invite) => {
      revokeInvite.mutate(invite.id);
      toast.info('Invite turned off', { description: `${invite.code} won't work any more.` });
    },
    [revokeInvite],
  );

  const showQR = useCallback(
    (invite: Invite) => {
      setQrInvite(invite);
      qrSheet.open();
    },
    [qrSheet],
  );

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(Math.min(index, 8) * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  /* ---- no membership at all --------------------------------------------- */

  // Distinct from "you're a sitter, not the owner": someone whose access ended
  // while they were inside the stack needs a different sentence entirely.
  if (scope.isForbidden) {
    return (
      <Screen header={<ScreenHeader title="Caregivers" large={false} />} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="This pet isn’t shared with you"
          body="Your access may have ended, or the invite was never accepted. The owner can send a fresh one whenever you need it."
          action={{
            label: 'Back to your pets',
            icon: 'arrow-back',
            onPress: () => router.replace(toHref('/pets')),
          }}
        />
      </Screen>
    );
  }

  /* ---- not the owner ---------------------------------------------------- */

  if (!scope.isLoading && !isOwner) {
    return (
      <Screen header={<ScreenHeader title="Caregivers" large={false} />} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="This list stays with the owner"
          body={`Who can help with ${petName} — and what they're allowed to do — is ${
            owner.data?.displayName ? `${possessive(owner.data.displayName)} call` : "the owner's call"
          }. You'll always see your own access on ${possessive(petName)} profile.`}
          action={{
            label: `Back to ${petName}`,
            icon: 'arrow-back',
            onPress: () => router.replace(toHref(`/pet/${petId}`)),
          }}
          secondaryAction={{
            label: 'Ask about your access',
            icon: 'paper-plane-outline',
            onPress: () => {
              void askOwnerForAccess({
                petName,
                ownerName: owner.data?.displayName ?? null,
                reason: 'owner-only',
              });
            },
          }}
        />
      </Screen>
    );
  }

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="Caregivers"
      subtitle={`Who can help with ${petName}, and exactly what they can do.`}
      actions={
        <IconButton
          icon="person-add-outline"
          accessibilityLabel="Invite someone to help"
          accessibilityHint={`Starts a new invite for ${petName}.`}
          variant="tonal"
          onPress={openInviteFlow}
        />
      }
    />
  );

  /* ---- loading ---------------------------------------------------------- */

  if (scope.isLoading || caregiversQuery.isPending) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label={`Loading who can help with ${petName}`} gap="lg">
          <CaregiverRowSkeleton count={3} />
        </SkeletonGroup>
      </Screen>
    );
  }

  /* ---- error ------------------------------------------------------------ */

  if (caregiversQuery.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={caregiversQuery.error}
          title="We couldn’t load the list"
          body={`Nobody's access has changed — the app just couldn't fetch ${possessive(petName)} caregivers this time.`}
          onRetry={() => caregiversQuery.refetch()}
        />
      </Screen>
    );
  }

  /* ---- empty ------------------------------------------------------------ */

  const nobodyElse = groups.current.length === 0 && groups.waiting.length === 0 && liveInvites.length === 0;

  if (nobodyElse && groups.finished.length === 0) {
    return (
      <Screen header={header} center>
        <EmptyState
          illustration={<EmptyCaregivers size={t.spacing.colossal * 3} />}
          headline={`Only you look after ${petName}`}
          body={`Add a sitter and they'll see exactly what's due — meals, medicine, the lot — while you see everything they log. You pick what they can do, and for how long.`}
          action={{
            label: 'Invite someone to help',
            icon: 'person-add-outline',
            onPress: openInviteFlow,
            accessibilityHint: 'Opens the invite flow.',
          }}
          footer={
            <Row gap="xs">
              <Icon name="lock-closed-outline" size="xs" color="textTertiary" />
              <Text variant="caption" color="textTertiary" align="center">
                Access ends on the date you choose. Nothing is permanent.
              </Text>
            </Row>
          }
        />
      </Screen>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  return (
    <Screen
      header={header}
      scroll
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      contentContainerStyle={{ paddingBottom: t.spacing.giant }}
      footer={
        <Button
          label="Invite someone to help"
          onPress={openInviteFlow}
          leftIcon="person-add-outline"
          size="lg"
          fullWidth
          hero
          haptic="commit"
          accessibilityHint={`Creates a new invite for ${petName}.`}
        />
      }
    >
      {/* --------------------------------------------------------- summary */}
      <Animated.View entering={enter(0)}>
        <Surface variant="surface" elevation={1} radius="xxl" padding="base" style={{ gap: t.spacing.md }}>
          <Row gap="md" align="start">
            <Column flex gap="hair">
              <Text variant="title3">
                {helperCount === 0
                  ? `Just you, for now`
                  : `${plural(helperCount, 'person', 'people')} can help with ${petName}`}
              </Text>
              <Text variant="footnote" color="textSecondary">
                {waitingCount > 0
                  ? `${plural(waitingCount, 'invite')} still waiting to be accepted.`
                  : `Everyone here has accepted and knows the routine.`}
              </Text>
            </Column>
            <Icon name="people-outline" size="lg" color="accentText" />
          </Row>

          {avatars.length > 0 ? (
            <AvatarStack
              items={avatars}
              size="sm"
              max={6}
              animate={false}
              label={`${possessive(petName)} people`}
            />
          ) : null}
        </Surface>
      </Animated.View>

      {/* ------------------------------------------------------ right now */}
      <SectionHeader
        title="Looking after them"
        subtitle={`Everyone here can open ${possessive(petName)} record right now.`}
        icon="sparkles-outline"
        iconColor="primaryText"
      />

      <Column gap="md">
        {[...groups.owners, ...groups.current].map((row, index) => (
          <CaregiverRow
            key={row.id}
            membership={row}
            petName={petName}
            isYou={row.userId === scope.membership?.userId}
            canManage={row.role !== 'owner'}
            index={index}
            onEditPermissions={openPermissions}
            onExtend={openDates}
            onRevoke={handleRevokeMembership}
          />
        ))}
      </Column>

      {/* -------------------------------------------------------- waiting */}
      {waitingCount > 0 ? (
        <>
          <SectionHeader
            title="Waiting to accept"
            subtitle="Share the code again if it's gone quiet."
            icon="hourglass-outline"
            iconColor="warning"
            count={waitingCount}
            countTone="warning"
          />

          <Column gap="md">
            {groups.waiting.map((row, index) => (
              <CaregiverRow
                key={row.id}
                membership={row}
                petName={petName}
                canManage
                index={index}
                onEditPermissions={openPermissions}
                onExtend={openDates}
                onRevoke={handleRevokeMembership}
              />
            ))}
            {liveInvites.map((invite, index) => (
              <InviteCard
                key={invite.id}
                invite={invite}
                petName={petName}
                canManage
                index={groups.waiting.length + index}
                onShowQR={showQR}
                onRevoke={handleRevokeInvite}
              />
            ))}
          </Column>
        </>
      ) : null}

      {/* ------------------------------------------------------- finished */}
      {groups.finished.length > 0 || spentInvites.length > 0 ? (
        <>
          <SectionHeader
            title="Past caregivers"
            subtitle={
              showFinished
                ? 'Kept so the activity log still says who did what.'
                : `${plural(groups.finished.length + spentInvites.length, 'person', 'people')} and codes that have finished.`
            }
            icon="archive-outline"
            iconColor="textTertiary"
            actionLabel={showFinished ? 'Hide' : 'Show'}
            actionIcon={showFinished ? 'chevron-up' : 'chevron-down'}
            onAction={() => setShowFinished((value) => !value)}
          />

          {showFinished ? (
            <Column gap="md">
              {groups.finished.map((row, index) => (
                <CaregiverRow
                  key={row.id}
                  membership={row}
                  petName={petName}
                  canManage={row.status !== 'revoked'}
                  index={index}
                  onEditPermissions={openPermissions}
                  onExtend={openDates}
                  onRevoke={handleRevokeMembership}
                />
              ))}
              {spentInvites.map((invite, index) => (
                <InviteCard
                  key={invite.id}
                  invite={invite}
                  petName={petName}
                  index={groups.finished.length + index}
                />
              ))}
            </Column>
          ) : null}
        </>
      ) : null}

      {/* -------------------------------------------------------- sheets */}
      <Sheet
        controller={permissionsSheet}
        size="tall"
        scrollable
        title={editing ? `What can ${editing.user.displayName} do?` : 'Permissions'}
        subtitle={`Changes apply to ${petName} straight away.`}
        footer={
          <Row gap="sm">
            <Button label="Cancel" variant="secondary" size="lg" onPress={permissionsSheet.close} />
            <View style={{ flex: 1 }} />
            <Button
              label="Save"
              variant="primary"
              size="lg"
              onPress={savePermissions}
              haptic="commit"
              accessibilityHint="Applies the new permissions."
            />
          </Row>
        }
      >
        <CapabilityPicker
          value={draftGrants}
          onChange={(grants, presetId) => {
            setDraftGrants(grants);
            setDraftPreset(presetId);
          }}
          petName={petName}
          personName={editing?.user.displayName ?? null}
        />
        <Text variant="caption" color="textFaint" style={{ marginTop: t.spacing.base }}>
          {draftPreset === 'custom' ? 'Custom set' : 'Preset'} · {draftGrants.length} permissions on
        </Text>
      </Sheet>

      <Sheet
        controller={datesSheet}
        size="half"
        scrollable
        title={editing ? `When can ${editing.user.displayName} help?` : 'Sitting dates'}
        subtitle="Access switches on and off on its own."
        footer={
          <Row gap="sm">
            <Button label="Cancel" variant="secondary" size="lg" onPress={datesSheet.close} />
            <View style={{ flex: 1 }} />
            <Button
              label="Save dates"
              variant="primary"
              size="lg"
              onPress={saveDates}
              haptic="commit"
              accessibilityHint="Applies the new sitting window."
            />
          </Row>
        }
      >
        <DateWindowEditor value={draftRange} onChange={setDraftRange} petName={petName} />
      </Sheet>

      <Sheet
        controller={qrSheet}
        title="Show them this"
        subtitle={qrInvite ? `Any camera will open ${possessive(petName)} invite.` : undefined}
        onDismiss={() => setQrInvite(null)}
      >
        {qrInvite ? (
          <InviteQR
            value={buildInviteUrl(qrInvite.code)}
            code={qrInvite.code}
            petName={petName}
            caption={`This link expires ${relativeTime(qrInvite.expiresAt, now)}`}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

/* ------------------------------------------------------- date window editor */

type DateWindowEditorProps = {
  value: CalendarRange;
  onChange: (range: CalendarRange) => void;
  petName: string;
};

/**
 * Quick presets first, calendar second. Sitting arrangements are overwhelmingly
 * "tonight", "the weekend" or "the week we're away", and making someone open a
 * month grid to say so is the difference between a feature used and a feature
 * abandoned.
 */
function DateWindowEditor({ value, onChange, petName }: DateWindowEditorProps) {
  const t = useTheme();
  const now = useNow();

  const presets = useMemo(() => buildQuickRanges(now), [now]);
  const today = toDateOnly(now);

  const summary = describeRange(value, petName);

  return (
    <Column gap="base">
      <Row gap="sm" wrap>
        {presets.map((preset) => (
          <Chip
            key={preset.id}
            label={preset.label}
            icon={preset.icon}
            selected={value.start === preset.range.start && value.end === preset.range.end}
            onPress={() => onChange(preset.range)}
            accessibilityHint={preset.hint}
          />
        ))}
        <Chip
          label="No end date"
          icon="infinite"
          selected={value.start !== null && value.end === null}
          onPress={() => onChange({ start: value.start ?? today, end: null })}
          accessibilityHint="Access carries on until you turn it off."
        />
      </Row>

      <DateField
        mode="range"
        range={value}
        onRangeChange={onChange}
        label="Sitting dates"
        placeholder="Pick the days"
        helper="The last day is included — access ends at midnight."
        clearable
      />

      <Row
        gap="sm"
        align="start"
        style={{
          padding: t.spacing.base,
          borderRadius: t.radius.lg,
          backgroundColor: t.color.primarySoft,
        }}
      >
        <Icon name="calendar-outline" size="sm" color="onPrimarySoft" />
        <Text variant="callout" color="onPrimarySoft" style={{ flex: 1 }}>
          {summary}
        </Text>
      </Row>
    </Column>
  );
}

/* ------------------------------------------------------------------ ranges */

type QuickRange = {
  id: string;
  label: string;
  icon: 'today-outline' | 'partly-sunny-outline' | 'calendar-number-outline';
  hint: string;
  range: CalendarRange;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Just today", "This weekend", "A week" — the three real-world shapes. */
function buildQuickRanges(now: Date): QuickRange[] {
  const today = toDateOnly(now);
  const day = now.getDay();
  // Sunday already *is* the weekend; any other day looks forward to Saturday.
  const toSaturday = day === 0 ? 0 : (6 - day) % 7;
  const saturday = new Date(now.getTime() + toSaturday * DAY_MS);
  const weekendEnd = day === 0 ? saturday : new Date(saturday.getTime() + DAY_MS);

  return [
    {
      id: 'today',
      label: 'Just today',
      icon: 'today-outline',
      hint: 'Access for the rest of today only.',
      range: { start: today, end: today },
    },
    {
      id: 'weekend',
      label: 'This weekend',
      icon: 'partly-sunny-outline',
      hint: 'Saturday and Sunday.',
      range: { start: toDateOnly(saturday), end: toDateOnly(weekendEnd) },
    },
    {
      id: 'week',
      label: 'A week',
      icon: 'calendar-number-outline',
      hint: 'Today plus the next six days.',
      range: { start: today, end: toDateOnly(new Date(now.getTime() + 6 * DAY_MS)) },
    },
  ];
}

/** One sentence describing whatever the range currently is. */
function describeRange(range: CalendarRange, petName: string): string {
  if (!range.start) return `Pick the days you'll be away and ${petName} is covered for exactly that long.`;
  const start = fromDateOnly(range.start);
  if (!range.end) {
    return `Access starts ${start ? friendlyRangeDay(start) : 'today'} and stays on until you turn it off.`;
  }
  const end = fromDateOnly(range.end);
  if (!start || !end) return `Pick the days you'll be away.`;
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1);
  return `${petName} is covered for ${plural(days, 'day')} — ${friendlyRangeDay(start)} to ${friendlyRangeDay(end)}.`;
}

function friendlyRangeDay(date: Date): string {
  return toDateOnly(date) === toDateOnly(new Date()) ? 'today' : formatDay(date);
}
