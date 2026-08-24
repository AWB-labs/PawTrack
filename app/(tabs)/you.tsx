/**
 * You — the profile hub.
 *
 * This tab exists to make the app's central idea visible: a person is not an
 * *owner* or a *caregiver*, they are both at once. So the screen is built in
 * two halves that mirror each other — the pets you're responsible for, and the
 * pets someone else trusted you with — with the numbers that only make sense
 * across both sitting between them.
 *
 * Three things it refuses to be:
 *
 *   · **A settings menu with a photo on top.** The settings entry is the last
 *     thing on the screen, not the first, and everything above it is about the
 *     household rather than the app.
 *   · **Vanity metrics.** "Days logged" and "streak" are computed from real day
 *     summaries — days where care was actually completed — not from a counter
 *     that only ever goes up.
 *   · **Silent about caregivers.** An owner who shares a pet needs to see what
 *     happened while they were out, and it belongs *here*, across every pet,
 *     rather than buried one pet at a time.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useCaregiverActivity, useMyMemberships } from '@/data/queries/useCaregivers';
import { useDaySummaries } from '@/data/queries/useCareTasks';
import { usePetIndex, usePets } from '@/data/queries/usePets';
import { useUpdateProfile, useUser } from '@/data/queries/useUsers';
import {
  SPECIES_META,
  type ActivityAction,
  type ActivityEvent,
  type DaySummary,
  type Pet,
} from '@/data/types';
import { SettingsGroup } from '@/features/settings/SettingsGroup';
import { SettingsRow } from '@/features/settings/SettingsRow';
import { describeReminders, useAppSettings } from '@/features/settings/appSettings';
import { formatClock, friendlyDate, lastNDays, toDateOnly } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { RoleBadge } from '@/rbac/RoleBadge';
import { windowState, type Membership } from '@/rbac/permissions';
import { useNow } from '@/rbac/usePermission';
import { usePreferences } from '@/stores/preferences';
import { useCurrentUser, useSession } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Avatar,
  Card,
  Column,
  ConfirmSheet,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  SheetHeader,
  StatTile,
  Surface,
  Text,
  TextArea,
  Timeline,
  Touchable,
  toast,
  useSheet,
  type IconName,
  type TimelineEntry,
  type TimelineTone,
} from '@/ui';
import { EmptyActivity, EmptyCaregivers } from '@/ui/illustrations';
import {
  PetCardSkeleton,
  ProfileHeaderSkeleton,
  TimelineSkeleton,
} from '@/ui/skeletons/ContentSkeletons';
import { Sheet } from '@/ui/Sheet';
import { SkeletonGroup } from '@/ui/Skeleton';

/* ---------------------------------------------------------------- constants */

/** How far back the "days of care" and streak numbers look. */
const CARE_WINDOW_DAYS = 90;

/** Enough recent caregiver activity to answer "what did I miss?" without a wall. */
const ACTIVITY_LIMIT = 12;

const BIO_MAX = 160;

/** One glyph and one colour per kind of thing a caregiver can do. */
const ACTIVITY_META: Record<ActivityAction, { icon: IconName; tone: TimelineTone }> = {
  'feeding.logged': { icon: 'restaurant-outline', tone: 'success' },
  'feeding.skipped': { icon: 'remove-circle-outline', tone: 'neutral' },
  'medicine.given': { icon: 'medical-outline', tone: 'success' },
  'medicine.skipped': { icon: 'remove-circle-outline', tone: 'warning' },
  'weight.recorded': { icon: 'barbell-outline', tone: 'info' },
  'vaccination.updated': { icon: 'shield-checkmark-outline', tone: 'info' },
  'vetvisit.created': { icon: 'medkit-outline', tone: 'info' },
  'document.uploaded': { icon: 'document-attach-outline', tone: 'neutral' },
  'appointment.created': { icon: 'calendar-outline', tone: 'primary' },
  'appointment.updated': { icon: 'calendar-outline', tone: 'primary' },
  'pet.updated': { icon: 'create-outline', tone: 'neutral' },
  'caregiver.invited': { icon: 'person-add-outline', tone: 'accent' },
  'caregiver.joined': { icon: 'people-outline', tone: 'accent' },
  'caregiver.revoked': { icon: 'person-remove-outline', tone: 'danger' },
  'permission.denied': { icon: 'lock-closed-outline', tone: 'warning' },
};

const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' } as const;

/* ------------------------------------------------------------------ helpers */

/**
 * Consecutive days, counting back from today, where everything scheduled was
 * done. A day with nothing scheduled is neutral — it neither counts nor breaks
 * the run, because a cat with no medication shouldn't lose your streak on a
 * Sunday. Today is neutral too while it's still in progress; the run is about
 * days you finished, not the one you're standing in.
 */
function careStreak(summaries: readonly DaySummary[]): number {
  let streak = 0;
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const day = summaries[index];
    if (!day) break;
    if (day.total === 0) continue;
    if (day.done >= day.total) {
      streak += 1;
      continue;
    }
    if (index === summaries.length - 1) continue;
    break;
  }
  return streak;
}

function daysWithCare(summaries: readonly DaySummary[]): number {
  return summaries.filter((day) => day.done > 0).length;
}

/* ---------------------------------------------------------------- component */

export default function YouScreen() {
  const t = useTheme();
  const router = useRouter();
  const now = useNow();

  const user = useCurrentUser();
  const signOut = useSession((s) => s.signOut);
  const themePreference = usePreferences((s) => s.theme);
  const reminders = useAppSettings((s) => s.reminders);

  const petsQuery = usePets();
  const petIndex = usePetIndex();
  const membershipsQuery = useMyMemberships();
  const activityQuery = useCaregiverActivity(ACTIVITY_LIMIT);

  const window = useMemo(() => {
    const days = lastNDays(CARE_WINDOW_DAYS);
    const today = toDateOnly(new Date());
    return { from: days[0] ?? today, to: days[days.length - 1] ?? today };
  }, []);
  const summariesQuery = useDaySummaries(window.from, window.to);

  const updateProfile = useUpdateProfile();
  const bioSheet = useSheet();
  const signOutSheet = useSheet();
  const [bioDraft, setBioDraft] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  /* ---- derived --------------------------------------------------------- */

  const pets = useMemo(() => petsQuery.data ?? [], [petsQuery.data]);
  const owned = useMemo(
    () => pets.filter((pet) => pet.ownerId === user?.id),
    [pets, user?.id],
  );

  const sitting = useMemo(() => {
    const rows = membershipsQuery.data ?? [];
    return rows
      .filter((membership) => membership.role === 'caregiver' && membership.status !== 'revoked')
      .map((membership) => ({ membership, pet: petIndex.get(membership.petId) }))
      .filter((row): row is { membership: Membership; pet: Pet } => row.pet !== undefined);
  }, [membershipsQuery.data, petIndex]);

  const summaries = summariesQuery.data ?? [];
  const streak = useMemo(() => careStreak(summaries), [summaries]);
  const logged = useMemo(() => daysWithCare(summaries), [summaries]);

  const firstOwned = owned[0];

  /* ---- actions ---------------------------------------------------------- */

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        petsQuery.refetch(),
        membershipsQuery.refetch(),
        activityQuery.refetch(),
        summariesQuery.refetch(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [activityQuery, membershipsQuery, petsQuery, summariesQuery]);

  const openBio = useCallback(() => {
    setBioDraft(user?.bio ?? '');
    bioSheet.open();
  }, [bioSheet, user?.bio]);

  const saveBio = useCallback(() => {
    const next = bioDraft.trim();
    updateProfile.mutate({ bio: next.length > 0 ? next : null });
    haptics.success();
    bioSheet.close();
    toast.success('That reads nicely 🐾', { description: 'Your profile line is updated.' });
  }, [bioDraft, bioSheet, updateProfile]);

  const goToInvite = useCallback(() => {
    if (!firstOwned) {
      router.push(toHref('/pets'));
      return;
    }
    router.push(toHref(`/pet/${firstOwned.id}/caregivers`));
  }, [firstOwned, router]);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(index * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  /* ---- chrome ----------------------------------------------------------- */

  const header = (
    <ScreenHeader
      title="You"
      large={false}
      showBack={false}
      actions={
        <IconButton
          icon="settings-outline"
          accessibilityLabel="Settings"
          accessibilityHint="Appearance, reminders, security and your account."
          variant="ghost"
          tone="neutral"
          onPress={() => router.push(toHref('/settings'))}
        />
      }
    />
  );

  const bottomInset = t.spacing.giant + t.spacing.md;

  /* ---- states ----------------------------------------------------------- */

  if (petsQuery.isPending || membershipsQuery.isPending || !user) {
    return (
      <Screen header={header} scroll bottomInset={bottomInset}>
        <SkeletonGroup label="Loading your profile" gap="xl">
          <ProfileHeaderSkeleton />
          <PetCardSkeleton count={2} />
          <TimelineSkeleton items={3} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (petsQuery.isError) {
    return (
      <Screen header={header} center bottomInset={bottomInset}>
        <ErrorState
          error={petsQuery.error}
          title="We couldn’t load your household"
          onRetry={() => petsQuery.refetch()}
        />
      </Screen>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  return (
    <Screen
      header={header}
      scroll
      bottomInset={bottomInset}
      refreshing={refreshing}
      onRefresh={() => {
        void refresh();
      }}
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xl }}
    >
      <Animated.View entering={enter(0)}>
        <ProfileHero
          name={user.displayName}
          email={user.email}
          avatarUrl={user.avatarUrl}
          bio={user.bio}
          memberSince={user.createdAt}
          ownedCount={owned.length}
          sittingCount={sitting.length}
          onEditBio={openBio}
          onEditProfile={() => router.push(toHref('/settings/account'))}
        />
      </Animated.View>

      <Animated.View entering={enter(1)}>
        <Row gap="sm" align="stretch">
          <StatTile
            size="sm"
            label="In your care"
            value={pets.length}
            icon="paw-outline"
            caption={
              sitting.length > 0
                ? `${owned.length} yours · ${sitting.length} you sit for`
                : 'All yours'
            }
          />
          <StatTile
            size="sm"
            label="Days logged"
            value={logged}
            icon="calendar-outline"
            iconColor="accentText"
            caption={`of the last ${CARE_WINDOW_DAYS}`}
          />
          <StatTile
            size="sm"
            label="Streak"
            value={streak}
            unit={streak === 1 ? 'day' : 'days'}
            icon="flame-outline"
            iconColor={streak > 0 ? 'accentText' : 'textTertiary'}
            caption={streak > 0 ? 'every task done' : 'finish today to start one'}
          />
        </Row>
      </Animated.View>

      <Animated.View entering={enter(2)}>
        <SectionHeader
          title="Pets you look after"
          subtitle="The other half of the job — someone else's pet, and exactly what they trusted you with."
          count={sitting.length > 0 ? sitting.length : undefined}
          countTone="accent"
        />
        {sitting.length === 0 ? (
          <EmptyState
            variant="compact"
            frame
            tone="accent"
            illustration={<EmptyCaregivers size={t.spacing.colossal * 2} />}
            headline="You’re not sitting for anyone yet"
            body="Sharing works both ways. Invite someone to help with yours and you’ll see exactly how it looks from their side."
            action={{
              label: firstOwned ? 'Invite someone to help' : 'Add your first pet',
              icon: firstOwned ? 'person-add-outline' : 'add',
              onPress: goToInvite,
            }}
          />
        ) : (
          <Column gap="md">
            {sitting.map(({ membership, pet }, index) => (
              <Animated.View key={membership.id} entering={enter(3 + index)}>
                <SitterPetCard
                  pet={pet}
                  membership={membership}
                  now={now}
                  onPress={() => router.push(toHref(`/pet/${pet.id}`))}
                />
              </Animated.View>
            ))}
          </Column>
        )}
      </Animated.View>

      <Animated.View entering={enter(3)}>
        <CaregiverActivity
          events={activityQuery.data ?? []}
          pending={activityQuery.isPending}
          error={activityQuery.isError ? activityQuery.error : null}
          onRetry={() => activityQuery.refetch()}
          onInvite={goToInvite}
          hasOwnedPets={owned.length > 0}
          hasCaregivers={sitting.length > 0 || owned.length > 0}
          onOpenPet={(petId) => router.push(toHref(`/pet/${petId}`))}
        />
      </Animated.View>

      <Animated.View entering={enter(4)} style={{ gap: t.spacing.base }}>
        <SettingsGroup title="Settings" animate={false}>
          <SettingsRow
            icon="options-outline"
            title="All settings"
            subtitle="Appearance, reminders, security and account"
            onPress={() => router.push(toHref('/settings'))}
          />
          <SettingsRow
            icon="color-palette-outline"
            tone="accent"
            title="Appearance"
            value={THEME_LABEL[themePreference]}
            onPress={() => router.push(toHref('/settings/appearance'))}
          />
          <SettingsRow
            icon="notifications-outline"
            tone="warning"
            title="Reminders"
            value={describeReminders(reminders)}
            onPress={() => router.push(toHref('/settings/notifications'))}
          />
        </SettingsGroup>

        <SettingsGroup animate={false}>
          <SettingsRow
            icon="log-out-outline"
            tone="danger"
            destructive
            title="Sign out"
            subtitle={user.email}
            chevron={false}
            onPress={() => signOutSheet.open()}
          />
        </SettingsGroup>
      </Animated.View>

      <Sheet
        controller={bioSheet}
        scrollable
        footer={
          <Row gap="sm">
            <View style={{ flex: 1 }}>
              <Touchable
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                haptic="tap"
                onPress={bioSheet.close}
                pressScale="medium"
                style={{
                  paddingVertical: t.spacing.base,
                  borderRadius: t.radius.xl,
                  alignItems: 'center',
                  borderWidth: t.borderWidth.hairline,
                  borderColor: t.color.borderStrong,
                }}
              >
                <Text variant="button">Cancel</Text>
              </Touchable>
            </View>
            <View style={{ flex: 1 }}>
              <Touchable
                accessibilityRole="button"
                accessibilityLabel="Save your profile line"
                haptic="none"
                onPress={saveBio}
                pressScale="medium"
                style={[
                  t.elevation(1),
                  {
                    paddingVertical: t.spacing.base,
                    borderRadius: t.radius.xl,
                    alignItems: 'center',
                    backgroundColor: t.color.primary,
                  },
                ]}
              >
                <Text variant="button" color="onPrimary">
                  Save
                </Text>
              </Touchable>
            </View>
          </Row>
        }
      >
        <SheetHeader
          title="A line about you"
          subtitle="It sits under your name here and on anything you post. Keep it short and human."
          onClose={bioSheet.close}
        />
        <TextArea
          value={bioDraft}
          onChangeText={setBioDraft}
          label="About you"
          placeholder="Two rescue cats and a great many opinions about litter."
          maxLength={BIO_MAX}
          minRows={3}
          maxRows={6}
          helper="Other people see this — your pets' names are fine, your address isn't."
        />
      </Sheet>

      <ConfirmSheet
        controller={signOutSheet}
        title="Sign out of Furry Tracker?"
        body="Everything you’ve logged stays exactly where it is. You’ll just need to sign in again to see it."
        confirmLabel="Sign out"
        cancelLabel="Stay signed in"
        icon="log-out-outline"
        onConfirm={() => signOut()}
      />
    </Screen>
  );
}

/* ------------------------------------------------------------------- hero */

type ProfileHeroProps = {
  name: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  memberSince: string;
  ownedCount: number;
  sittingCount: number;
  onEditBio: () => void;
  onEditProfile: () => void;
};

function ProfileHero({
  name,
  email,
  avatarUrl,
  bio,
  memberSince,
  ownedCount,
  sittingCount,
  onEditBio,
  onEditProfile,
}: ProfileHeroProps) {
  const t = useTheme();

  const joined = useMemo(() => {
    const date = new Date(memberSince);
    if (Number.isNaN(date.getTime())) return null;
    return `With Furry Tracker since ${date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
  }, [memberSince]);

  return (
    <Surface variant="surface" elevation={1} radius="xxl" padding="lg" style={{ gap: t.spacing.base }}>
      <Row gap="base" align="start">
        <Avatar
          uri={avatarUrl}
          name={name}
          size="xl"
          ring
          ringColor="primary"
          onPress={onEditProfile}
          accessibilityLabel={`${name}. Your photo.`}
          accessibilityHint="Opens your account settings."
        />

        <Column flex gap="xxs" style={{ paddingTop: t.spacing.xs }}>
          <Text variant="title1" numberOfLines={2}>
            {name}
          </Text>
          <Text variant="footnote" color="textTertiary" numberOfLines={1}>
            {email}
          </Text>
          {joined ? (
            <Text variant="caption" color="textFaint" numberOfLines={1}>
              {joined}
            </Text>
          ) : null}
        </Column>

        <IconButton
          icon="pencil"
          accessibilityLabel="Edit your profile"
          variant="tonal"
          tone="neutral"
          size="sm"
          onPress={onEditProfile}
        />
      </Row>

      <Row gap="xs" wrap>
        <RolePill
          icon="shield-checkmark"
          label={ownedCount === 1 ? 'Owner of 1 pet' : `Owner of ${ownedCount} pets`}
          fill={t.color.primarySoft}
          ink={t.color.onPrimarySoft}
        />
        {sittingCount > 0 ? (
          <RolePill
            icon="home"
            label={sittingCount === 1 ? 'Sitting for 1 pet' : `Sitting for ${sittingCount} pets`}
            fill={t.color.accentSoft}
            ink={t.color.onAccentSoft}
          />
        ) : null}
      </Row>

      <Touchable
        accessibilityRole="button"
        accessibilityLabel={bio ? `About you: ${bio}` : 'Add a line about you'}
        accessibilityHint="Opens a short editor for your profile line."
        haptic="tap"
        onPress={onEditBio}
        pressScale="subtle"
        style={
          bio
            ? {
                borderRadius: t.radius.lg,
                backgroundColor: t.color.surfaceAlt,
                padding: t.spacing.md,
              }
            : {
                borderRadius: t.radius.lg,
                borderWidth: t.borderWidth.thin,
                borderColor: t.color.border,
                borderStyle: 'dashed',
                padding: t.spacing.md,
              }
        }
      >
        <Row gap="sm" align="start">
          <View style={{ paddingTop: t.spacing.hair }}>
            <Icon name={bio ? 'pencil-outline' : 'add-circle-outline'} size="sm" color="primaryText" />
          </View>
          <Text
            variant="callout"
            color={bio ? 'textSecondary' : 'textTertiary'}
            style={{ flex: 1 }}
          >
            {bio ?? 'Say a line about you and your pets — it shows up wherever you post.'}
          </Text>
        </Row>
      </Touchable>
    </Surface>
  );
}

function RolePill({
  icon,
  label,
  fill,
  ink,
}: {
  icon: IconName;
  label: string;
  fill: string;
  ink: string;
}) {
  const t = useTheme();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.xs,
        paddingVertical: t.spacing.xs,
        paddingHorizontal: t.spacing.md,
        borderRadius: t.radius.pill,
        backgroundColor: fill,
      }}
    >
      <Icon name={icon} size="xs" color={ink} />
      <Text variant="captionStrong" color={ink} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/* -------------------------------------------------------------- sitter card */

function SitterPetCard({
  pet,
  membership,
  now,
  onPress,
}: {
  pet: Pet;
  membership: Membership;
  now: Date;
  onPress: () => void;
}) {
  const t = useTheme();
  const owner = useUser(pet.ownerId);
  const identity = t.speciesColor(pet.species);
  const state = windowState(membership, now);
  const onDuty = membership.status === 'active' && (state === 'active' || state === 'open-ended');

  const species = SPECIES_META[pet.species].label.toLowerCase();
  const ownerName = owner.data?.displayName;
  const line = ownerName ? `${possessive(ownerName)} ${species}` : `Someone’s ${species}`;

  return (
    <Card
      accent={identity.base}
      onPress={onPress}
      accessibilityLabel={`${pet.name}, ${line}`}
      accessibilityHint="Opens this pet and what you're allowed to do."
    >
      <Row gap="base">
        <Avatar
          uri={pet.photoUrl}
          name={pet.name}
          species={pet.species}
          size="lg"
          ring
          live={onDuty}
        />
        <Column flex gap="xs">
          <Column gap="hair">
            <Text variant="title3" numberOfLines={1}>
              {pet.name}
            </Text>
            <Text variant="footnote" color="textTertiary" numberOfLines={1}>
              {line}
            </Text>
          </Column>
          <RoleBadge role="caregiver" membership={membership} size="sm" />
        </Column>
        <Icon name="chevron-forward" size="sm" color="textTertiary" />
      </Row>
    </Card>
  );
}

/* ----------------------------------------------------------- activity feed */

type CaregiverActivityProps = {
  events: readonly ActivityEvent[];
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  onInvite: () => void;
  hasOwnedPets: boolean;
  hasCaregivers: boolean;
  onOpenPet: (petId: string) => void;
};

function CaregiverActivity({
  events,
  pending,
  error,
  onRetry,
  onInvite,
  hasOwnedPets,
  onOpenPet,
}: CaregiverActivityProps) {
  const t = useTheme();
  const now = useNow();
  const petIndex = usePetIndex();

  const entries = useMemo<TimelineEntry[]>(() => {
    let lastDay: string | null = null;
    return events.map((event) => {
      const meta = ACTIVITY_META[event.action];
      const pet = petIndex.get(event.petId);
      const day = friendlyDate(event.at, now);
      const dayLabel = day === lastDay ? undefined : day;
      lastDay = day;

      return {
        id: event.id,
        title: event.summary,
        subtitle: pet ? pet.name : undefined,
        meta: formatClock(event.at),
        icon: meta.icon,
        tone: meta.tone,
        dayLabel,
        onPress: () => onOpenPet(event.petId),
        accessibilityHint: pet ? `Opens ${possessive(pet.name)} profile.` : undefined,
      } satisfies TimelineEntry;
    });
  }, [events, now, onOpenPet, petIndex]);

  return (
    <View>
      <SectionHeader
        title="While you were out"
        subtitle="Everything your sitters logged, across every pet you own."
      />

      {pending ? (
        <TimelineSkeleton items={3} />
      ) : error ? (
        <ErrorState
          variant="compact"
          frame
          error={error}
          title="That list didn’t load"
          onRetry={onRetry}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          variant="compact"
          frame
          illustration={<EmptyActivity size={t.spacing.colossal * 2} />}
          headline="Nothing from your sitters yet"
          body="When someone logs a meal or records a weight while you're away, it lands here — so you always know what happened."
          action={
            hasOwnedPets
              ? {
                  label: 'Invite someone to help',
                  icon: 'person-add-outline',
                  onPress: onInvite,
                }
              : undefined
          }
        />
      ) : (
        <Timeline entries={entries} nowIndex={null} />
      )}
    </View>
  );
}
