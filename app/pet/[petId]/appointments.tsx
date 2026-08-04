/**
 * The vet diary for one pet.
 *
 * A list of appointments is nearly useless; the *next* appointment is nearly
 * everything. So the screen opens with a single hero that answers "when, where,
 * and what do I do about it" without a tap — countdown, clinic, and the three
 * actions people actually perform (ring them, drive there, put it in the
 * calendar). Everything below is history and planning.
 *
 * Two behaviours worth calling out:
 *
 *   · **Resolving a past visit starts the write-up.** Tapping "We went" flips
 *     the status optimistically *and* opens the write-up sheet, which is the
 *     only reliable moment to capture what the vet said. Declining still leaves
 *     the status correct — the record is never held hostage to the paperwork.
 *   · **Filters never lie about emptiness.** "Nothing booked yet" and "no
 *     cancelled visits" are different situations with different fixes, so they
 *     get different states, and the filtered one offers a way back rather than
 *     an illustration of a void the user created.
 *
 * Reads are gated as hard as writes: the adapter asserts `appointment.view`, so
 * a sitter without it never fires the query at all — they get an explanation.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import {
  useAppointments,
  useUpdateAppointmentStatus,
} from '@/data/queries/useAppointments';
import { useDocuments, useVaccinations } from '@/data/queries/useHealth';
import type { Appointment, AppointmentStatus, ID } from '@/data/types';
import {
  APPOINTMENT_STATUS_META,
  AppointmentCard,
} from '@/features/appointments/AppointmentCard';
import { AppointmentTimeline } from '@/features/appointments/AppointmentTimeline';
import { VisitWriteUpSheet } from '@/features/appointments/VisitWriteUpSheet';
import { usePetScope } from '@/features/pets/PetScope';
import { toHref } from '@/lib/deeplinks';
import { plural, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { DENIAL_COPY, type DenialReason } from '@/rbac/permissions';
import { useNow, usePermission } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Button,
  Chip,
  Column,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Row,
  Screen,
  ScreenHeader,
  Skeleton,
  SkeletonGroup,
  SegmentedControl,
  Surface,
  Text,
  toast,
  useSheet,
  type Segment,
} from '@/ui';
import { EmptyAppointments, PermissionLocked } from '@/ui/illustrations';

/* ---------------------------------------------------------------- constants */

type Tab = 'upcoming' | 'past';
type StatusFilter = AppointmentStatus | 'all';

const TABS: Segment<Tab>[] = [
  { value: 'upcoming', label: 'Upcoming', icon: 'calendar-outline' },
  { value: 'past', label: 'Past', icon: 'time-outline' },
];

/** Order the status chips appear in, when the data contains them. */
const STATUS_ORDER: readonly AppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'completed',
  'missed',
  'cancelled',
];

/* ------------------------------------------------------------------ helpers */

function denial(reason: DenialReason | null): { title: string; body: string } {
  return DENIAL_COPY[reason ?? 'not-granted'];
}

/* ---------------------------------------------------------------- component */

export default function AppointmentsScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const petId = scope.petId;
  const pet = scope.pet;
  const now = useNow();

  /* ---- permissions ------------------------------------------------------ */

  const canView = usePermission('appointment.view', petId);
  const canCreate = usePermission('appointment.create', petId);
  const canEdit = usePermission('appointment.edit', petId);
  const canSeeDocuments = usePermission('document.view', petId);
  const canSeeVaccinations = usePermission('vaccination.view', petId);

  const explainWith = useMemo(() => ({ petName: pet?.name ?? null }), [pet?.name]);

  /* ---- data ------------------------------------------------------------- */

  const query = useAppointments(canView.allowed ? petId : null);
  const documentsQuery = useDocuments(canSeeDocuments.allowed ? petId : null);
  const vaccinationsQuery = useVaccinations(canSeeVaccinations.allowed ? petId : null);
  const updateStatus = useUpdateAppointmentStatus(petId);

  const [tab, setTab] = useState<Tab>('upcoming');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [writeUpFor, setWriteUpFor] = useState<Appointment | null>(null);
  const writeUpSheet = useSheet();

  const rows = useMemo(() => query.data ?? [], [query.data]);

  const { upcoming, past } = useMemo(() => {
    const stamp = now.getTime();
    const future: Appointment[] = [];
    const history: Appointment[] = [];
    for (const row of rows) {
      (Date.parse(row.at) >= stamp ? future : history).push(row);
    }
    return { upcoming: future, past: history };
  }, [now, rows]);

  const active = tab === 'upcoming' ? upcoming : past;

  /** The one the hero shows — the soonest visit that hasn't been called off. */
  const next = useMemo(
    () =>
      upcoming
        .filter((row) => row.status === 'scheduled' || row.status === 'confirmed')
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null,
    [upcoming],
  );

  /** Only offer a filter for a status that's actually in front of the user. */
  const availableStatuses = useMemo(() => {
    const present = new Set(active.map((row) => row.status));
    return STATUS_ORDER.filter((status) => present.has(status));
  }, [active]);

  const filtered = useMemo(
    () => (statusFilter === 'all' ? active : active.filter((row) => row.status === statusFilter)),
    [active, statusFilter],
  );

  /* ---- actions ---------------------------------------------------------- */

  const open = useCallback((path: string) => router.push(toHref(path)), [router]);

  const handleBook = useCallback(() => {
    if (!canCreate.allowed) {
      canCreate.explain(explainWith);
      return;
    }
    open(`/record/appointment?petId=${petId}`);
  }, [canCreate, explainWith, open, petId]);

  const handleOpen = useCallback(
    (appointment: Appointment) => {
      if (!canEdit.allowed) {
        canEdit.explain(explainWith);
        return;
      }
      open(`/record/appointment?petId=${petId}&id=${appointment.id}`);
    },
    [canEdit, explainWith, open, petId],
  );

  const handleStatusChange = useCallback(
    (appointment: Appointment, status: AppointmentStatus) => {
      updateStatus.mutate({ appointment, status });

      if (status === 'completed') {
        haptics.success();
        setWriteUpFor(appointment);
        writeUpSheet.open();
        return;
      }

      toast.info(`Marked as ${APPOINTMENT_STATUS_META[status].label.toLowerCase()}`, {
        description: `${appointment.reason} · you can change this any time from the visit.`,
      });
    },
    [updateStatus, writeUpSheet],
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([query.refetch(), vaccinationsQuery.refetch()]).finally(() =>
      setRefreshing(false),
    );
  }, [query, vaccinationsQuery]);

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

  const petName = pet?.name ?? 'your pet';

  const subtitle =
    rows.length === 0
      ? `${possessive(petName)} vet diary`
      : upcoming.length > 0
        ? `${plural(upcoming.length, 'visit')} coming up for ${petName}`
        : `Nothing ahead · ${plural(past.length, 'visit')} on record`;

  const header = (
    <ScreenHeader
      title="Appointments"
      subtitle={subtitle}
      actions={
        canView.allowed ? (
          <IconButton
            icon="add"
            accessibilityLabel="Book a visit"
            accessibilityHint={`Starts a new appointment for ${petName}.`}
            variant="tonal"
            tone="primary"
            onPress={handleBook}
            disabledReason={canCreate.allowed ? undefined : denial(canCreate.reason).title}
          />
        ) : null
      }
    />
  );

  /* ---- gated ------------------------------------------------------------ */

  if (!canView.allowed) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline={denial(canView.reason).title}
          body={denial(canView.reason).body}
          action={{
            label: 'What can I do?',
            icon: 'help-circle-outline',
            onPress: () => canView.explain(explainWith),
          }}
          secondaryAction={{
            label: `Back to ${petName}`,
            icon: 'arrow-back',
            onPress: () => router.back(),
          }}
        />
      </Screen>
    );
  }

  /* ---- loading ---------------------------------------------------------- */

  if (query.isPending || !pet) {
    return (
      <Screen header={header} scroll>
        <AppointmentsSkeleton />
      </Screen>
    );
  }

  /* ---- error ------------------------------------------------------------ */

  if (query.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={query.error}
          title="We couldn’t open the diary"
          body={`${possessive(pet.name)} appointments are safe — the app just couldn’t fetch them this time.`}
          onRetry={() => query.refetch()}
        />
      </Screen>
    );
  }

  /* ---- truly empty ------------------------------------------------------ */

  if (rows.length === 0) {
    return (
      <Screen header={header} center>
        <EmptyState
          illustration={<EmptyAppointments size={t.spacing.colossal * 3} />}
          headline={`Nothing in ${possessive(pet.name)} diary yet`}
          body="Book the next check-up and we’ll count down to it, remind you the day before, and keep the write-up with their records."
          action={{
            label: 'Book a visit',
            icon: 'calendar-outline',
            onPress: handleBook,
            disabledReason: canCreate.allowed ? undefined : denial(canCreate.reason).title,
          }}
        />
      </Screen>
    );
  }

  /* ---- content ---------------------------------------------------------- */

  const editReason = canEdit.allowed ? undefined : denial(canEdit.reason).title;

  return (
    <Screen
      header={header}
      scroll
      refreshing={refreshing}
      onRefresh={handleRefresh}
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.xl }}
      footer={
        <Button
          label="Book a visit"
          leftIcon="calendar-outline"
          variant="primary"
          size="lg"
          fullWidth
          hero
          haptic="commit"
          onPress={handleBook}
          disabledReason={canCreate.allowed ? undefined : denial(canCreate.reason).title}
          accessibilityHint={`Opens the booking form for ${pet.name}.`}
        />
      }
    >
      {next ? (
        <Animated.View entering={enter(0)}>
          <AppointmentCard
            appointment={next}
            petName={pet.name}
            variant="hero"
            now={now}
            onPress={() => handleOpen(next)}
            pressDisabledReason={editReason}
            documents={documentsQuery.data}
            vaccinations={vaccinationsQuery.data}
            onOpenDocument={(id: ID) => open(`/record/document?petId=${petId}&id=${id}`)}
            onOpenVaccination={(id: ID) => open(`/record/vaccination?petId=${petId}&id=${id}`)}
          />
        </Animated.View>
      ) : (
        <Animated.View entering={enter(0)}>
          <NothingBookedCard
            petName={pet.name}
            onBook={handleBook}
            bookDisabledReason={canCreate.allowed ? undefined : denial(canCreate.reason).title}
          />
        </Animated.View>
      )}

      <Animated.View entering={enter(1)} style={{ gap: t.spacing.md }}>
        <SegmentedControl
          segments={TABS}
          value={tab}
          onChange={(value) => {
            setTab(value);
            setStatusFilter('all');
          }}
          accessibilityLabel="Show upcoming or past visits"
        />

        {availableStatuses.length > 1 ? (
          <Row gap="sm" wrap>
            <Chip
              label="Everything"
              selected={statusFilter === 'all'}
              size="sm"
              onPress={() => setStatusFilter('all')}
              accessibilityHint="Shows every visit in this list."
            />
            {availableStatuses.map((status) => (
              <Chip
                key={status}
                label={APPOINTMENT_STATUS_META[status].label}
                icon={APPOINTMENT_STATUS_META[status].icon}
                selected={statusFilter === status}
                size="sm"
                onPress={() => setStatusFilter(status)}
                accessibilityHint={`Shows only visits marked ${APPOINTMENT_STATUS_META[status].label.toLowerCase()}.`}
              />
            ))}
          </Row>
        ) : null}
      </Animated.View>

      {filtered.length === 0 ? (
        <Animated.View entering={enter(2)}>
          <EmptyState
            variant="compact"
            frame
            tone="neutral"
            icon={tab === 'upcoming' ? 'calendar-outline' : 'time-outline'}
            headline={
              statusFilter === 'all'
                ? tab === 'upcoming'
                  ? 'Nothing coming up'
                  : 'No visits behind you yet'
                : `No ${APPOINTMENT_STATUS_META[statusFilter].label.toLowerCase()} visits here`
            }
            body={
              statusFilter === 'all'
                ? tab === 'upcoming'
                  ? `${pet.name} has no future visits booked. Their history is under Past.`
                  : `Everything in ${possessive(pet.name)} diary is still ahead of them.`
                : 'Nothing in this list matches that filter.'
            }
            action={
              statusFilter === 'all'
                ? undefined
                : {
                    label: 'Show everything',
                    icon: 'refresh-outline',
                    onPress: () => setStatusFilter('all'),
                  }
            }
          />
        </Animated.View>
      ) : (
        <AppointmentTimeline
          appointments={filtered}
          petName={pet.name}
          direction={tab}
          now={now}
          onOpen={handleOpen}
          openDisabledReason={editReason}
          // Kept wired even when denied: the buttons render dimmed and the tap
          // explains what to ask the owner for, rather than vanishing.
          onStatusChange={(appointment, status) =>
            canEdit.allowed
              ? handleStatusChange(appointment, status)
              : canEdit.explain(explainWith)
          }
          statusDisabledReason={editReason}
          documents={documentsQuery.data}
          vaccinations={vaccinationsQuery.data}
          onOpenDocument={(id: ID) => open(`/record/document?petId=${petId}&id=${id}`)}
          onOpenVaccination={(id: ID) => open(`/record/vaccination?petId=${petId}&id=${id}`)}
          excludeIds={next ? [next.id] : undefined}
        />
      )}

      <VisitWriteUpSheet
        controller={writeUpSheet}
        appointment={writeUpFor}
        pet={pet}
        vaccinations={vaccinationsQuery.data}
        onDismiss={() => setWriteUpFor(null)}
      />
    </Screen>
  );
}

/* ------------------------------------------------------- nothing booked */

/**
 * The hero's understudy. It sits in the same slot so the screen doesn't lurch
 * between "there's a visit" and "there isn't", and it says the useful thing
 * rather than nothing at all.
 */
function NothingBookedCard({
  petName,
  onBook,
  bookDisabledReason,
}: {
  petName: string;
  onBook: () => void;
  bookDisabledReason?: string;
}) {
  const t = useTheme();

  return (
    <Surface
      variant="surfaceAlt"
      radius="xxl"
      padding="lg"
      border
      style={{ gap: t.spacing.md }}
    >
      <Row gap="md" align="start">
        <View
          style={{
            width: t.spacing.xxxl,
            height: t.spacing.xxxl,
            borderRadius: t.radius.md,
            backgroundColor: t.color.primarySoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="calendar-clear-outline" size="md" color="onPrimarySoft" />
        </View>
        <Column flex gap="hair">
          <Text variant="title3">Nothing booked</Text>
          <Text variant="footnote" color="textSecondary">
            {`${petName} has no visits ahead. When you book one it'll count down right here.`}
          </Text>
        </Column>
      </Row>
      <Button
        label="Book a visit"
        variant="tonal"
        size="sm"
        leftIcon="add"
        onPress={onBook}
        disabledReason={bookDisabledReason}
        accessibilityHint={`Opens the booking form for ${petName}.`}
      />
    </Surface>
  );
}

/* ------------------------------------------------------------- skeleton */

/**
 * Shaped like what's coming: the hero's status band and countdown, the filter
 * row, then three cards with an icon well and two lines each. A generic stack
 * of bars would cause exactly the layout jolt a skeleton exists to prevent.
 */
function AppointmentsSkeleton() {
  const t = useTheme();

  return (
    <SkeletonGroup label="Loading the vet diary" gap="lg">
      <Surface variant="surface" elevation={2} radius="xxl" padding="none" style={{ overflow: 'hidden' }}>
        <View
          style={{
            backgroundColor: t.color.surfaceAlt,
            padding: t.spacing.lg,
            gap: t.spacing.sm,
          }}
        >
          <Skeleton w={t.spacing.giant} h={t.type.overline.fontSize} r="xs" dim />
          <Skeleton w="58%" h={t.type.title1.fontSize} r="xs" />
          <Skeleton w="72%" h={t.type.callout.fontSize} r="xs" dim />
        </View>
        <View style={{ padding: t.spacing.lg, gap: t.spacing.base }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md }}>
            <Skeleton w={t.spacing.xxxl} h={t.spacing.xxxl} r="md" />
            <View style={{ flex: 1, gap: t.spacing.xs }}>
              <Skeleton w="64%" h={t.type.title3.fontSize} r="xs" />
              <Skeleton w="46%" h={t.type.footnote.fontSize} r="xs" dim />
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: t.spacing.sm }}>
            <Skeleton w={t.spacing.colossal} h={t.spacing.xxl} r="pill" dim />
            <Skeleton w={t.spacing.colossal} h={t.spacing.xxl} r="pill" dim />
          </View>
        </View>
      </Surface>

      <Skeleton w="100%" h={t.minTarget} r="lg" dim />

      <View style={{ gap: t.spacing.md }}>
        {[0, 1, 2].map((index) => (
          <Surface
            key={index}
            variant="surface"
            elevation={1}
            radius="xl"
            padding="base"
            style={{ gap: t.spacing.md }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md }}>
              <Skeleton w={t.spacing.xxxl} h={t.spacing.xxxl} r="md" />
              <View style={{ flex: 1, gap: t.spacing.xs }}>
                <Skeleton w="62%" h={t.type.headline.fontSize} r="xs" />
                <Skeleton w="38%" h={t.type.caption.fontSize} r="xs" dim />
              </View>
              <Skeleton w={t.spacing.giant} h={t.spacing.lg} r="pill" dim />
            </View>
            <View style={{ gap: t.spacing.xs }}>
              <Skeleton w="44%" h={t.type.headline.fontSize} r="xs" />
              <Skeleton w="56%" h={t.type.footnote.fontSize} r="xs" dim />
            </View>
          </Surface>
        ))}
      </View>
    </SkeletonGroup>
  );
}
