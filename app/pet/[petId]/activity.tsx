/**
 * The activity log — what everyone has actually done for this pet.
 *
 * `activity.view` is outside `CAREGIVER_GRANTABLE`, so this is the owner's
 * ledger by construction. That is the point of it: a sitter logs a dose, the
 * owner sees it that evening, and nobody has to send a text saying "did you?".
 *
 * Three things shape the layout:
 *
 *   · **Days, not a stream.** Care is a daily rhythm, so the log groups by
 *     calendar day with a rail running through each group. "Yesterday" as a
 *     heading answers more questions than a column of timestamps.
 *   · **Two filters, both about attribution.** Who did it, and what kind of
 *     thing it was. Those are the two questions an owner actually arrives with;
 *     a free-text search over pre-rendered sentences would be worse than either.
 *   · **A filtered empty result is not an empty log.** They get different words,
 *     because "Priya hasn't logged anything yet" and "nothing has ever been
 *     logged" call for completely different next steps.
 *
 * Paging is explicit rather than infinite-on-scroll: a log you can accidentally
 * fall through a fortnight of is a log you can't read.
 */

import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';

import { usePetActivity, usePetCaregivers } from '@/data/queries/useCaregivers';
import { useUser } from '@/data/queries/useUsers';
import type { ActivityEvent, ID, User } from '@/data/types';
import {
  ActivityRow,
  ACTIVITY_KIND_META,
  ACTIVITY_KINDS,
  activityKindOf,
  type ActivityKind,
} from '@/features/caregivers/ActivityRow';
import { usePetScope } from '@/features/pets/PetScope';
import { friendlyDate, toDateOnly } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { plural, possessive } from '@/lib/format';
import { askOwnerForAccess } from '@/rbac/DenialSheet';
import { useNow } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Avatar,
  Button,
  Chip,
  Column,
  EmptyState,
  ErrorState,
  Icon,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Surface,
  Text,
} from '@/ui';
import { EmptyActivity, EmptySearch, PermissionLocked } from '@/ui/illustrations';
import { SkeletonGroup } from '@/ui/Skeleton';
import { TimelineSkeleton } from '@/ui/skeletons/ContentSkeletons';

/* -------------------------------------------------------------------- types */

type DayGroup = { key: string; label: string; events: ActivityEvent[] };

/* ---------------------------------------------------------------- constants */

/** Actor chips beyond this get an overflow rather than a scroll of faces. */
const MAX_ACTOR_CHIPS = 8;

/* ------------------------------------------------------------------ helpers */

/** Chips are narrow; a first name fits where "Priya Raman" would truncate. */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

function groupByDay(events: readonly ActivityEvent[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;

  for (const event of events) {
    const key = toDateOnly(event.at);
    if (!current || current.key !== key) {
      current = { key, label: friendlyDate(event.at, now), events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }
  return groups;
}

/* ---------------------------------------------------------------- component */

export default function ActivityScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const now = useNow();

  const petId = scope.petId;
  const petName = scope.pet?.name ?? 'this pet';
  const owner = useUser(scope.pet?.ownerId);

  /** The audit trail is owner-only, so the reads are gated on it. */
  const isOwner = scope.isOwner;
  const gatedId = isOwner ? petId : null;

  const activityQuery = usePetActivity(gatedId);
  const caregiversQuery = usePetCaregivers(gatedId);

  const [actorFilter, setActorFilter] = useState<ID | null>(null);
  const [kindFilter, setKindFilter] = useState<ActivityKind | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const events = useMemo(() => activityQuery.data ?? [], [activityQuery.data]);

  /** Everyone linked to the pet, so a name and a face resolve without a fetch. */
  const people = useMemo(() => {
    const map = new Map<ID, User>();
    for (const row of caregiversQuery.data ?? []) map.set(row.userId, row.user);
    return map;
  }, [caregiversQuery.data]);

  /** Only offer a face as a filter if that person actually appears in the log. */
  const actors = useMemo(() => {
    const seen = new Map<ID, User>();
    for (const event of events) {
      if (seen.has(event.actorId)) continue;
      const person = people.get(event.actorId);
      if (person) seen.set(event.actorId, person);
    }
    return [...seen.values()].slice(0, MAX_ACTOR_CHIPS);
  }, [events, people]);

  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          (actorFilter === null || event.actorId === actorFilter) &&
          (kindFilter === null || activityKindOf(event.action) === kindFilter),
      ),
    [actorFilter, events, kindFilter],
  );

  const groups = useMemo(() => groupByDay(filtered, now), [filtered, now]);
  const sittingCount = useMemo(
    () => filtered.filter((event) => event.actorRole === 'caregiver').length,
    [filtered],
  );

  const isFiltered = actorFilter !== null || kindFilter !== null;
  const filterName = actorFilter ? (people.get(actorFilter)?.displayName ?? 'them') : null;

  const clearFilters = useCallback(() => {
    setActorFilter(null);
    setKindFilter(null);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await activityQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [activityQuery]);

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(Math.min(index, 8) * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  /* ---- no membership ---------------------------------------------------- */

  if (scope.isForbidden) {
    return (
      <Screen header={<ScreenHeader title="Activity" large={false} />} center>
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
      <Screen header={<ScreenHeader title="Activity" large={false} />} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="The log is the owner’s"
          body={`Everything you log for ${petName} goes straight to ${
            owner.data?.displayName ?? 'the owner'
          } — but the full history of who did what stays with them. Nothing you've done is lost.`}
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
      title="Activity"
      subtitle={`Everything logged for ${petName}, newest first.`}
    />
  );

  /* ---- loading ---------------------------------------------------------- */

  if (scope.isLoading || activityQuery.isPending) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label={`Loading ${possessive(petName)} activity`} gap="lg">
          <TimelineSkeleton items={5} />
        </SkeletonGroup>
      </Screen>
    );
  }

  /* ---- error ------------------------------------------------------------ */

  if (activityQuery.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={activityQuery.error}
          title="We couldn’t load the log"
          body={`Nothing has been lost — every entry is still recorded, we just couldn't fetch ${possessive(petName)} history this time.`}
          onRetry={() => activityQuery.refetch()}
        />
      </Screen>
    );
  }

  /* ---- nothing has ever happened ---------------------------------------- */

  if (events.length === 0) {
    return (
      <Screen header={header} center>
        <EmptyState
          illustration={<EmptyActivity size={t.spacing.colossal * 3} />}
          headline={`Nothing logged for ${petName} yet`}
          body="The moment a meal, a dose or a weigh-in gets ticked off — by you or by a sitter — it lands here with a name and a time on it."
          action={{
            label: `Open ${possessive(petName)} day`,
            icon: 'sunny-outline',
            onPress: () => router.replace(toHref(`/pet/${petId}`)),
          }}
          footer={
            <Row gap="xs">
              <Icon name="shield-checkmark-outline" size="xs" color="textTertiary" />
              <Text variant="caption" color="textTertiary" align="center">
                Only you can see this log.
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
    >
      {/* ---------------------------------------------------------- summary */}
      <Animated.View entering={enter(0)}>
        <Surface variant="surface" elevation={1} radius="xxl" padding="base" style={{ gap: t.spacing.xs }}>
          <Row gap="md" align="start">
            <Column flex gap="hair">
              <Text variant="title3">
                {`${plural(filtered.length, 'entry', 'entries')}${isFiltered ? ' in this view' : ''}`}
              </Text>
              <Text variant="footnote" color="textSecondary">
                {sittingCount > 0
                  ? `${plural(sittingCount, 'thing')} logged by someone sitting for you.`
                  : `All of it logged by you, so far.`}
              </Text>
            </Column>
            <Icon name="time-outline" size="lg" color="primaryText" />
          </Row>
        </Surface>
      </Animated.View>

      {/* ---------------------------------------------------------- filters */}
      <SectionHeader
        title="Filter"
        variant="overline"
        trailing={
          isFiltered ? (
            <Button label="Clear" onPress={clearFilters} variant="ghost" size="sm" haptic="select" />
          ) : undefined
        }
      />

      {actors.length > 1 ? (
        <Column gap="xs" style={{ paddingBottom: t.spacing.sm }}>
          <Text variant="caption" color="textTertiary">
            Who logged it
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: t.spacing.sm, paddingRight: t.gutter }}
          >
            <Chip
              label="Everyone"
              icon="people-outline"
              selected={actorFilter === null}
              onPress={() => setActorFilter(null)}
              accessibilityHint="Shows entries from everyone."
            />
            {actors.map((person) => (
              <Chip
                key={person.id}
                label={firstName(person.displayName)}
                selected={actorFilter === person.id}
                onPress={() => setActorFilter(actorFilter === person.id ? null : person.id)}
                accessibilityLabel={person.displayName}
                accessibilityHint={`Shows only what ${person.displayName} logged.`}
              />
            ))}
          </ScrollView>
        </Column>
      ) : null}

      <Column gap="xs">
        <Text variant="caption" color="textTertiary">
          Kind of entry
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: t.spacing.sm, paddingRight: t.gutter }}
        >
          <Chip
            label="Everything"
            icon="apps-outline"
            selected={kindFilter === null}
            onPress={() => setKindFilter(null)}
            accessibilityHint="Shows every kind of entry."
          />
          {ACTIVITY_KINDS.map((kind) => (
            <Chip
              key={kind}
              label={ACTIVITY_KIND_META[kind].label}
              icon={ACTIVITY_KIND_META[kind].icon}
              tone="accent"
              selected={kindFilter === kind}
              onPress={() => setKindFilter(kindFilter === kind ? null : kind)}
              accessibilityHint={`Shows only ${ACTIVITY_KIND_META[kind].label.toLowerCase()} entries.`}
            />
          ))}
        </ScrollView>
      </Column>

      {/* ----------------------------------------------------------- groups */}
      {filtered.length === 0 ? (
        <View style={{ paddingTop: t.spacing.xxl }}>
          <EmptyState
            variant="compact"
            tone="neutral"
            illustration={<EmptySearch size={t.spacing.colossal * 2} />}
            headline={
              filterName
                ? `Nothing from ${filterName} here`
                : 'Nothing of that kind yet'
            }
            body={
              filterName
                ? `${filterName} hasn't logged anything matching this filter for ${petName}. Try widening it.`
                : `No ${kindFilter ? ACTIVITY_KIND_META[kindFilter].label.toLowerCase() : ''} entries in ${possessive(petName)} log so far.`
            }
            action={{ label: 'Clear the filter', icon: 'close-circle-outline', onPress: clearFilters }}
          />
        </View>
      ) : (
        <Animated.View layout={LinearTransition.duration(t.motion.duration.base)}>
          {groups.map((group, groupIndex) => (
            <View key={group.key}>
              <SectionHeader
                title={group.label}
                count={group.events.length}
                first={groupIndex === 0}
                icon="calendar-clear-outline"
                iconColor="textTertiary"
              />
              {group.events.map((event, index) => (
                <ActivityRow
                  key={event.id}
                  event={event}
                  actor={people.get(event.actorId) ?? null}
                  index={index}
                  last={index === group.events.length - 1}
                />
              ))}
            </View>
          ))}
        </Animated.View>
      )}

      {/* ------------------------------------------------------------ paging */}
      {activityQuery.hasNextPage && filtered.length > 0 ? (
        <View style={{ paddingTop: t.spacing.lg, alignItems: 'center' }}>
          <Button
            label="Show earlier activity"
            onPress={() => {
              void activityQuery.fetchNextPage();
            }}
            variant="secondary"
            size="md"
            leftIcon="arrow-down"
            loading={activityQuery.isFetchingNextPage}
            accessibilityHint={`Loads the next page of ${possessive(petName)} history.`}
          />
        </View>
      ) : filtered.length > 0 ? (
        <Row gap="xs" justify="center" style={{ paddingTop: t.spacing.lg }}>
          <Avatar
            uri={owner.data?.avatarUrl ?? null}
            name={owner.data?.displayName ?? petName}
            size="xs"
            accessibilityLabel={owner.data?.displayName ?? 'The owner'}
          />
          <Text variant="caption" color="textTertiary" align="center">
            {`That's the whole history for ${petName}.`}
          </Text>
        </Row>
      ) : null}
    </Screen>
  );
}
