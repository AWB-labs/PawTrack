/**
 * Today — the app's home, and the screen people actually open.
 *
 * Everything here is arranged around one question: *what needs doing, right
 * now, and can I do it from where I'm standing?* That produces a specific
 * shape, top to bottom:
 *
 *   greeting + ring  →  how the day is going, in one glance
 *   week strip       →  where today sits, and how the rest of the week went
 *   pet filter       →  only when a household is big enough to need one
 *   banners          →  the three things that are *about* to become problems
 *   up next          →  the single thing to do, with a button you can hit blind
 *   sections         →  Overdue · Morning · Afternoon · Evening, sticky-headed
 *   later today      →  everything not yet due, deliberately quiet
 *
 * Four decisions worth naming:
 *
 *   · **Not-yet-due work is peeled off the top.** At 7am, sorting the whole day
 *     into time buckets shows you eleven rows you can't act on. `groupTasks`
 *     with `deferUpcoming` keeps the actionable part above the fold and parks
 *     the rest in one quiet group. Looking at *another* day switches that off,
 *     because tomorrow is entirely upcoming.
 *   · **The header is rendered inside `Screen`'s children, not its `header`
 *     slot.** The slot pads content down by the header's height; this list has
 *     to scroll *underneath* the blur, and it needs `stickyHeaderIndices` on its
 *     own scroller, which is also what buys the paw pull-to-refresh.
 *   · **Banners are per-pet probes, not a cross-pet query.** Vaccination and
 *     medicine reads are scoped to a pet by the RBAC layer, so each pet gets a
 *     small component that asks its own questions, gates them on
 *     `vaccination.view` / `medicine.view`, and renders at most one banner. A
 *     sitter with view-only access simply never fires the query.
 *   · **All-done is a state, not an absence.** Finishing the day replaces the
 *     Up Next hero with a genuine celebration and leaves the completed rows
 *     below it, because "what did I already do" is the next question you ask.
 */

import { useQueryClient } from '@tanstack/react-query';
import { differenceInCalendarDays } from 'date-fns';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUpcomingAppointments } from '@/data/queries/useAppointments';
import { useCareTasks, useDayProgress } from '@/data/queries/useCareTasks';
import { useMyMemberships } from '@/data/queries/useCaregivers';
import { useVaccinations } from '@/data/queries/useHealth';
import { useMedicines } from '@/data/queries/useMedicine';
import { usePets } from '@/data/queries/usePets';
import { queryKeys } from '@/data/queryKeys';
import type { CareTask, DateOnly, ID, Pet } from '@/data/types';
import { PetSwitcher } from '@/features/pets/PetSwitcher';
import { DayProgressHeader } from '@/features/today/DayProgressHeader';
import { DayStrip } from '@/features/today/DayStrip';
import { TaskRow } from '@/features/today/TaskRow';
import { TaskSectionHeader, groupTasks } from '@/features/today/TaskSection';
import { UpNextCard } from '@/features/today/UpNextCard';
import { toDateOnly, dueLabel, formatClock, friendlyDate, fromDateOnly } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { joinWithAnd, plural, possessive } from '@/lib/format';
import { useNow, usePermission } from '@/rbac/usePermission';
import { useCurrentUser } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Banner,
  Column,
  EmptyState,
  ErrorState,
  RefreshableScrollView,
  Row,
  Screen,
  ScreenHeader,
  Skeleton,
  SkeletonCircle,
  SkeletonGroup,
  Surface,
  Text,
  useScreenScroll,
} from '@/ui';
import { EmptyFeeding, EmptyPets, SuccessCheck } from '@/ui/illustrations';
import { TaskRowSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* ---------------------------------------------------------------- constants */

/** Past this the cascade reads as lag rather than choreography. */
const STAGGER_CAP = 8;

/** Pets probed for banners. Four alert cards is a wall, not a warning. */
const ALERT_PET_CAP = 3;

/** Doses left in the pack that make a refill worth mentioning. */
const REFILL_THRESHOLD = 4;

/** Appointments read ahead when looking for "tomorrow". */
const UPCOMING_WINDOW = 10;

/** The states that still want something from someone. */
const OUTSTANDING: readonly CareTask['state'][] = ['due', 'overdue', 'upcoming'];

/* ------------------------------------------------------------------ helpers */

const isOutstanding = (task: CareTask): boolean => OUTSTANDING.includes(task.state);

/** "Buddy, Mochi and Kiwi" — never long enough to stop being a sentence. */
function household(names: readonly string[]): string {
  if (names.length === 0) return 'everyone';
  if (names.length <= 3) return joinWithAnd(names, 'and');
  return joinWithAnd([...names.slice(0, 2), `${names.length - 2} more`], 'and');
}

/** Which of the pet's own screens a task belongs to. */
function sectionFor(task: CareTask): string {
  switch (task.kind) {
    case 'feeding':
      return 'feeding';
    case 'medicine':
      return 'medicine';
    case 'appointment':
    default:
      return 'appointments';
  }
}

/* ---------------------------------------------------------------- component */

export default function TodayScreen() {
  return (
    <Screen padded={false} edges={[]} keyboardAvoiding={false}>
      <TodayBoard />
    </Screen>
  );
}

/**
 * Split out so it can read `Screen`'s scroll context — the header's collapse and
 * the list's top clearance are the same number, published once.
 */
function TodayBoard() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const client = useQueryClient();
  const now = useNow();
  const me = useCurrentUser();
  const { scrollY, headerHeight } = useScreenScroll();

  const todayKey = useMemo(() => toDateOnly(now), [now]);
  const [selected, setSelected] = useState<DateOnly>(todayKey);
  const [petId, setPetId] = useState<ID | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const isToday = selected === todayKey;
  const selectedDate = useMemo(() => fromDateOnly(selected) ?? now, [now, selected]);

  /* ---- data -------------------------------------------------------------- */

  const petsQuery = usePets();
  const tasksQuery = useCareTasks({ date: selected, petId });
  const progress = useDayProgress({ date: selected, petId });
  const membershipsQuery = useMyMemberships();

  const pets = useMemo(() => petsQuery.data ?? [], [petsQuery.data]);
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);

  const petIndex = useMemo(() => new Map(pets.map((pet) => [pet.id, pet])), [pets]);
  const scopedPets = useMemo(
    () => (petId === null ? pets : pets.filter((pet) => pet.id === petId)),
    [petId, pets],
  );
  const petNames = useMemo(() => scopedPets.map((pet) => pet.name), [scopedPets]);

  /** Pets someone is actively sitting — their portrait breathes in the switcher. */
  const liveIds = useMemo(
    () =>
      (membershipsQuery.data ?? [])
        .filter((row) => row.role === 'caregiver' && row.status === 'active')
        .map((row) => row.petId),
    [membershipsQuery.data],
  );

  const outstanding = useMemo(() => tasks.filter(isOutstanding), [tasks]);
  const upNext = isToday ? (outstanding[0] ?? null) : null;
  const lastOneLeft = outstanding.length === 1 ? (outstanding[0]?.id ?? null) : null;
  const allDone = tasks.length > 0 && outstanding.length === 0;

  const groups = useMemo(
    () => groupTasks(tasks, { deferUpcoming: isToday }),
    [isToday, tasks],
  );

  /* ---- actions ----------------------------------------------------------- */

  const openTask = useCallback(
    (task: CareTask) => router.push(toHref(`/pet/${task.petId}/${sectionFor(task)}`)),
    [router],
  );

  const openPath = useCallback((path: string) => router.push(toHref(path)), [router]);

  const addPet = useCallback(() => router.push(toHref('/pet/new')), [router]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        petsQuery.refetch(),
        // The strip's dots and the ring live under the same prefix, so one
        // invalidation refreshes everything the pull implied.
        client.invalidateQueries({ queryKey: queryKeys.care.root }),
        client.invalidateQueries({ queryKey: queryKeys.appointments.root }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [client, petsQuery]);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(
            Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
          )
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  /* ---- chrome ------------------------------------------------------------ */

  const header = (
    <ScreenHeader
      title={isToday ? 'Today' : friendlyDate(selectedDate, now)}
      large={false}
      showBack={false}
    />
  );

  /** Everything the floating tab bar occupies, so nothing hides behind it. */
  const tabBarZone = Math.max(insets.bottom, t.spacing.md) + t.spacing.giant;
  const clearance = { paddingTop: headerHeight + t.spacing.sm };
  const bottomClearance = tabBarZone + t.spacing.lg;

  /* ---- loading ----------------------------------------------------------- */

  if (petsQuery.isPending || tasksQuery.isPending) {
    return (
      <>
        <ScrollView
          scrollEnabled={false}
          contentContainerStyle={[clearance, { paddingHorizontal: t.gutter }]}
        >
          <TodaySkeleton />
        </ScrollView>
        <HeaderLayer>{header}</HeaderLayer>
      </>
    );
  }

  /* ---- error ------------------------------------------------------------- */

  if (tasksQuery.isError) {
    return (
      <>
        <View style={[styles.flex, styles.center, clearance, { paddingHorizontal: t.gutter }]}>
          <ErrorState
            error={tasksQuery.error}
            title="Today didn’t load"
            body="Nothing is lost — every meal and dose you’ve logged is still safely recorded. Let’s try fetching the day again."
            onRetry={() => tasksQuery.refetch()}
          />
        </View>
        <HeaderLayer>{header}</HeaderLayer>
      </>
    );
  }

  /* ---- no pets ----------------------------------------------------------- */

  if (pets.length === 0) {
    return (
      <>
        <View style={[styles.flex, styles.center, clearance, { paddingHorizontal: t.gutter }]}>
          <EmptyState
            illustration={<EmptyPets size={t.spacing.colossal * 3} />}
            headline="Your day starts with a pet"
            body="Add your first one and Petal turns their meals, medicine and vet dates into a list that fills itself in every morning."
            action={{
              label: 'Add a pet',
              icon: 'add',
              onPress: addPet,
              accessibilityHint: 'Opens the new pet flow.',
            }}
          />
        </View>
        <HeaderLayer>{header}</HeaderLayer>
      </>
    );
  }

  /* ---- content ----------------------------------------------------------- */

  const blocks: React.ReactNode[] = [];
  const stickyIndices: number[] = [];

  const add = (node: React.ReactNode): number => {
    blocks.push(node);
    return blocks.length - 1;
  };

  add(
    <Animated.View key="greeting" entering={enter(0)}>
      <DayProgressHeader
        userName={me?.displayName ?? null}
        progress={progress}
        petNames={petNames}
        date={selectedDate}
        isToday={isToday}
        now={now}
      />
    </Animated.View>,
  );

  add(
    <Animated.View key="strip" entering={enter(1)} style={{ paddingTop: t.spacing.xs }}>
      <DayStrip selected={selected} onSelect={setSelected} today={todayKey} petId={petId} />
    </Animated.View>,
  );

  if (pets.length > 1) {
    add(
      <Animated.View key="switcher" entering={enter(2)}>
        <PetSwitcher
          pets={pets}
          selectedId={petId}
          onSelect={setPetId}
          includeAll
          allLabel="Everyone"
          liveIds={liveIds}
          size="md"
          accessibilityLabel="Show one pet, or everyone"
          style={{ marginHorizontal: -t.gutter }}
        />
      </Animated.View>,
    );
  }

  if (isToday) {
    add(
      <Animated.View key="alerts" entering={enter(3)}>
        <TodayAlerts pets={scopedPets} petIndex={petIndex} onOpen={openPath} />
      </Animated.View>,
    );
  }

  if (allDone) {
    add(
      <Animated.View key="hero" entering={enter(4)}>
        <AllDoneCard names={petNames} done={progress.done} isToday={isToday} />
      </Animated.View>,
    );
  } else if (upNext) {
    add(
      <Animated.View key="hero" entering={enter(4)}>
        <UpNextCard
          task={upNext}
          pet={petIndex.get(upNext.petId)}
          celebrateOnComplete={lastOneLeft === upNext.id}
          onOpen={openTask}
        />
      </Animated.View>,
    );
  } else if (tasks.length === 0) {
    add(
      <Animated.View key="hero" entering={enter(4)}>
        <NothingScheduled
          pets={scopedPets}
          isToday={isToday}
          onSetUp={() => {
            const first = scopedPets[0];
            if (first) openPath(`/pet/${first.id}/feeding`);
          }}
        />
      </Animated.View>,
    );
  }

  let rowIndex = 0;

  for (const group of groups) {
    stickyIndices.push(
      add(<TaskSectionHeader key={`head-${group.id}`} group={group} sticky />),
    );
    add(
      <Column key={`rows-${group.id}`} gap="sm">
        {group.tasks.map((task) => {
          const index = rowIndex;
          rowIndex += 1;
          return (
            <TaskRow
              key={task.id}
              task={task}
              pet={petIndex.get(task.petId)}
              index={index}
              emphasis={group.id === 'later' ? 'quiet' : 'default'}
              celebrateOnComplete={lastOneLeft === task.id}
              onPress={openTask}
            />
          );
        })}
      </Column>,
    );
  }

  return (
    <>
      <RefreshableScrollView
        refreshing={refreshing}
        onRefresh={() => {
          void refresh();
        }}
        scrollY={scrollY}
        indicatorOffset={headerHeight}
        stickyHeaderIndices={stickyIndices}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          clearance,
          {
            paddingHorizontal: t.gutter,
            paddingBottom: bottomClearance,
            gap: t.spacing.sm,
          },
        ]}
      >
        {blocks}
      </RefreshableScrollView>

      <HeaderLayer>{header}</HeaderLayer>
    </>
  );
}

/* ----------------------------------------------------------- header layer */

/** The floating chrome, painted last so it wins the paint order on Android too. */
function HeaderLayer({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={[styles.header, { zIndex: t.zIndex.header }]} pointerEvents="box-none">
      {children}
    </View>
  );
}

/* ------------------------------------------------------------- all done */

type AllDoneCardProps = {
  names: readonly string[];
  done: number;
  isToday: boolean;
};

/**
 * The reward for an empty list. Deliberately *not* an empty state: the person
 * looking at this did the work, and the screen should say so before it says
 * anything else.
 */
function AllDoneCard({ names, done, isToday }: AllDoneCardProps) {
  const t = useTheme();
  const who = household(names);
  const verb = names.length === 1 ? 'is' : 'are';

  return (
    <Surface elevation={2} radius="xxl" padding="xl" style={styles.clip}>
      <LinearGradient
        colors={[t.color.successSoft, t.color.surface]}
        start={GRADIENT_START}
        end={GRADIENT_END}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <Column align="center" gap="md">
        <SuccessCheck size={t.spacing.colossal * 2} />
        <Text variant="title1" align="center" accessibilityRole="header">
          {isToday ? 'That’s everything' : 'That day was fully sorted'}
        </Text>
        <Text variant="callout" color="textSecondary" align="center">
          {`${who} ${verb} sorted — ${plural(done, 'thing')} ticked off. ${
            isToday ? 'Go and enjoy them.' : 'Not a single thing missed.'
          }`}
        </Text>
      </Column>
    </Surface>
  );
}

/* --------------------------------------------------------- nothing to do */

type NothingScheduledProps = {
  pets: readonly Pet[];
  isToday: boolean;
  onSetUp: () => void;
};

function NothingScheduled({ pets, isToday, onSetUp }: NothingScheduledProps) {
  const t = useTheme();
  const only = pets.length === 1 ? pets[0] : undefined;
  const first = pets[0];

  return (
    <EmptyState
      variant="compact"
      frame
      illustration={<EmptyFeeding size={t.spacing.colossal * 2} />}
      headline={
        only ? `Nothing on ${possessive(only.name)} list ${isToday ? 'today' : 'that day'}` : 'A completely clear day'
      }
      body={
        isToday
          ? 'Add a meal time or a medicine and it’ll show up here every day — with a reminder, so you never have to hold it in your head.'
          : 'Nothing is scheduled for that day. Meals and doses appear here as soon as you set a routine.'
      }
      action={
        first
          ? {
              label: 'Set up meal times',
              icon: 'restaurant-outline',
              onPress: onSetUp,
              accessibilityHint: `Opens ${possessive(first.name)} feeding schedule.`,
            }
          : undefined
      }
    />
  );
}

/* ------------------------------------------------------------------ alerts */

type TodayAlertsProps = {
  pets: readonly Pet[];
  petIndex: Map<ID, Pet>;
  onOpen: (path: string) => void;
};

/**
 * The three things that are about to become problems. Each is dismissible for
 * the session — a nudge you can't put down stops being a nudge.
 */
function TodayAlerts({ pets, petIndex, onOpen }: TodayAlertsProps) {
  return (
    <Column gap="sm">
      <TomorrowVisitBanner petIndex={petIndex} onOpen={onOpen} />
      {pets.slice(0, ALERT_PET_CAP).map((pet) => (
        <PetAlertBanner key={pet.id} pet={pet} onOpen={onOpen} />
      ))}
    </Column>
  );
}

function TomorrowVisitBanner({
  petIndex,
  onOpen,
}: {
  petIndex: Map<ID, Pet>;
  onOpen: (path: string) => void;
}) {
  const now = useNow();
  const [dismissed, setDismissed] = useState(false);
  // Wide enough that a three-pet household's tomorrow can't fall off the end.
  const { data } = useUpcomingAppointments(UPCOMING_WINDOW);

  const tomorrow = useMemo(
    () =>
      (data ?? []).find((appointment) => {
        const at = new Date(appointment.at);
        return !Number.isNaN(at.getTime()) && differenceInCalendarDays(at, now) === 1;
      }) ?? null,
    [data, now],
  );

  if (dismissed || !tomorrow) return null;

  const pet = petIndex.get(tomorrow.petId);
  const name = pet?.name ?? 'Your pet';
  const where = tomorrow.clinic ? ` · ${tomorrow.clinic}` : '';

  return (
    <Banner
      tone="info"
      icon="calendar-outline"
      title={`${name} has an appointment tomorrow`}
      message={`${tomorrow.reason} at ${formatClock(tomorrow.at)}${where}. Worth setting out the carrier tonight.`}
      action={{
        label: 'See the details',
        icon: 'arrow-forward',
        onPress: () => onOpen(`/pet/${tomorrow.petId}/appointments`),
      }}
      onDismiss={() => setDismissed(true)}
      dismissLabel="Hide this reminder"
    />
  );
}

/**
 * One pet, one banner, most urgent wins. The reads are gated on the viewer's
 * own capabilities, so a sitter who can't see health records never fires the
 * vaccination query — the UI and the data layer agree before the request.
 */
function PetAlertBanner({ pet, onOpen }: { pet: Pet; onOpen: (path: string) => void }) {
  const now = useNow();
  const [dismissed, setDismissed] = useState(false);

  const canSeeVaccinations = usePermission('vaccination.view', pet.id).allowed;
  const canSeeMedicines = usePermission('medicine.view', pet.id).allowed;

  const vaccinations = useVaccinations(canSeeVaccinations ? pet.id : null);
  const medicines = useMedicines(canSeeMedicines ? pet.id : null);

  const overdueShot = useMemo(() => {
    const rows = (vaccinations.data ?? []).filter((row) => {
      if (!row.dueAt) return false;
      const due = fromDateOnly(row.dueAt);
      return due !== null && differenceInCalendarDays(due, now) < 0;
    });
    return (
      [...rows].sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))[0] ?? null
    );
  }, [now, vaccinations.data]);

  const lowPack = useMemo(() => {
    const rows = (medicines.data ?? []).filter(
      (row) => row.active && row.remainingDoses !== null && row.remainingDoses <= REFILL_THRESHOLD,
    );
    return [...rows].sort((a, b) => (a.remainingDoses ?? 0) - (b.remainingDoses ?? 0))[0] ?? null;
  }, [medicines.data]);

  if (dismissed) return null;

  if (overdueShot?.dueAt) {
    return (
      <Banner
        tone={overdueShot.core ? 'danger' : 'warning'}
        icon="shield-half-outline"
        title={`${possessive(pet.name)} ${overdueShot.name} is ${dueLabel(overdueShot.dueAt, now)}`}
        message={
          overdueShot.core
            ? 'This one is a core vaccine — worth ringing the practice today.'
            : 'Book it in and Petal will keep the next one on the calendar for you.'
        }
        action={{
          label: 'Open vaccinations',
          icon: 'arrow-forward',
          onPress: () => onOpen(`/pet/${pet.id}/vaccinations`),
        }}
        onDismiss={() => setDismissed(true)}
        dismissLabel="Hide this reminder"
      />
    );
  }

  if (lowPack && lowPack.remainingDoses !== null) {
    return (
      <Banner
        tone="warning"
        icon="medkit-outline"
        title={`${possessive(pet.name)} ${lowPack.name} is running low`}
        message={`${plural(lowPack.remainingDoses, 'dose')} left in the pack — worth a refill this week.`}
        action={{
          label: 'Open medicines',
          icon: 'arrow-forward',
          onPress: () => onOpen(`/pet/${pet.id}/medicine`),
        }}
        onDismiss={() => setDismissed(true)}
        dismissLabel="Hide this reminder"
      />
    );
  }

  return null;
}

/* --------------------------------------------------------------- skeleton */

/**
 * Shaped against the real thing: the same hero card, the same seven-ring strip,
 * the same row geometry, so nothing jumps when the data lands.
 */
function TodaySkeleton() {
  const t = useTheme();
  const ring = t.spacing.colossal + t.spacing.xl;

  return (
    <SkeletonGroup label="Loading your day" gap="base">
      <Surface elevation={1} radius="xxl" padding="base">
        <Row gap="base" align="center">
          <Column flex gap="xs">
            <Skeleton w="42%" h={t.type.overline.fontSize} r="xs" dim />
            <Skeleton w="72%" h={t.type.title1.fontSize} r="xs" />
            <Skeleton w="88%" h={t.type.callout.fontSize} r="xs" dim />
          </Column>
          <SkeletonCircle size={ring} />
        </Row>
      </Surface>

      <Row justify="between">
        {Array.from({ length: 7 }, (_, index) => (
          <Column key={index} align="center" gap="xxs">
            <Skeleton w={t.spacing.md} h={t.type.caption.fontSize} r="xs" dim />
            <SkeletonCircle size={t.spacing.xxxl} />
          </Column>
        ))}
      </Row>

      <TaskRowSkeleton count={4} />
    </SkeletonGroup>
  );
}

/* ------------------------------------------------------------------ styles */

const GRADIENT_START = { x: 0.15, y: 0 } as const;
const GRADIENT_END = { x: 1, y: 1 } as const;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  clip: { overflow: 'hidden' },
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
});
