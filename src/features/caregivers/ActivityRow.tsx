/**
 * Petal — ActivityRow.
 *
 * One line of the audit trail. The adapter writes the sentence ("Priya logged
 * Buddy's dinner — 120 g kibble"), so this component's whole job is to make that
 * sentence *placeable*: who said it, when, in what capacity, and what kind of
 * thing it was.
 *
 * The action tile doubles as the timeline node. A separate dot beside a separate
 * icon is two marks competing for the same job; putting the glyph *in* the node
 * means the rail reads as a spine of coloured events, and a fortnight of care
 * becomes skimmable by colour before a word is read.
 *
 * The "while sitting" marker is deliberately quiet. It matters — an owner
 * scanning the log wants to know which entries were theirs and which were the
 * neighbour's — but it is context, not an alarm, so it gets a soft chip rather
 * than a badge.
 */

import { useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import type { ActivityAction, ActivityEvent, User } from '@/data/types';
import { formatClock, relativeTime } from '@/lib/date';
import { useNow } from '@/rbac/usePermission';
import { useTheme, type Theme } from '@/theme';
import { Avatar, Column, Icon, Row, Surface, Text, Touchable, type IconName } from '@/ui';

/* -------------------------------------------------------------------- types */

export type ActivityTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Coarse grouping for the log's filter. Fifteen actions is too many chips. */
export type ActivityKind = 'care' | 'health' | 'records' | 'people';

export type ActivityRowProps = {
  event: ActivityEvent;
  /** The person who did it. Falls back to an initial-less avatar when unknown. */
  actor?: User | null;
  /** Draw the vertical rail behind the node. */
  rail?: boolean;
  /** Last entry in its day group — the rail stops at this node. */
  last?: boolean;
  index?: number;
  animate?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type ActionMeta = { icon: IconName; tone: ActivityTone; kind: ActivityKind; label: string };

/* ---------------------------------------------------------------- constants */

const STAGGER_CAP = 8;

/**
 * One glyph and one colour per action. The colour is what makes a scrolled
 * fortnight readable — meals warm, medicine brand-green, anything about people
 * or access in its own family.
 */
export const ACTIVITY_META: Record<ActivityAction, ActionMeta> = {
  'feeding.logged': { icon: 'restaurant', tone: 'accent', kind: 'care', label: 'Meal' },
  'feeding.skipped': { icon: 'remove-circle-outline', tone: 'warning', kind: 'care', label: 'Meal skipped' },
  'medicine.given': { icon: 'medical', tone: 'primary', kind: 'care', label: 'Dose' },
  'medicine.skipped': { icon: 'alert-circle-outline', tone: 'warning', kind: 'care', label: 'Dose skipped' },
  'weight.recorded': { icon: 'fitness', tone: 'success', kind: 'health', label: 'Weigh-in' },
  'vaccination.updated': { icon: 'shield-checkmark', tone: 'info', kind: 'health', label: 'Vaccination' },
  'vetvisit.created': { icon: 'medkit', tone: 'info', kind: 'health', label: 'Vet visit' },
  'appointment.created': { icon: 'calendar', tone: 'info', kind: 'health', label: 'Appointment' },
  'appointment.updated': { icon: 'calendar-outline', tone: 'info', kind: 'health', label: 'Appointment' },
  'document.uploaded': { icon: 'document-attach', tone: 'neutral', kind: 'records', label: 'Document' },
  'pet.updated': { icon: 'paw', tone: 'neutral', kind: 'records', label: 'Profile' },
  'caregiver.invited': { icon: 'mail-unread', tone: 'warning', kind: 'people', label: 'Invite sent' },
  'caregiver.joined': { icon: 'people', tone: 'success', kind: 'people', label: 'Joined' },
  'caregiver.revoked': { icon: 'person-remove', tone: 'danger', kind: 'people', label: 'Access removed' },
  'permission.denied': { icon: 'lock-closed', tone: 'danger', kind: 'people', label: 'Blocked' },
};

/** Filter buckets for the activity screen, in the order they read best. */
export const ACTIVITY_KIND_META: Record<ActivityKind, { label: string; icon: IconName }> = {
  care: { label: 'Everyday care', icon: 'restaurant-outline' },
  health: { label: 'Health', icon: 'heart-outline' },
  records: { label: 'Records', icon: 'document-attach-outline' },
  people: { label: 'People', icon: 'people-outline' },
};

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['care', 'health', 'records', 'people'];

/* ------------------------------------------------------------------ helpers */

export const activityMetaFor = (action: ActivityAction): ActionMeta =>
  ACTIVITY_META[action] ?? ACTIVITY_META['pet.updated'];

export const activityKindOf = (action: ActivityAction): ActivityKind => activityMetaFor(action).kind;

function toneSkin(t: Theme, tone: ActivityTone): { fill: string; ink: string; node: string } {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accentSoft, ink: t.color.onAccentSoft, node: t.color.accent };
    case 'success':
      return { fill: t.color.successSoft, ink: t.color.onSuccessSoft, node: t.color.success };
    case 'warning':
      return { fill: t.color.warningSoft, ink: t.color.onWarningSoft, node: t.color.warning };
    case 'danger':
      return { fill: t.color.dangerSoft, ink: t.color.onDangerSoft, node: t.color.danger };
    case 'info':
      return { fill: t.color.infoSoft, ink: t.color.onInfoSoft, node: t.color.info };
    case 'neutral':
      return { fill: t.color.surfaceAlt, ink: t.color.textSecondary, node: t.color.borderStrong };
    case 'primary':
    default:
      return { fill: t.color.primarySoft, ink: t.color.onPrimarySoft, node: t.color.primary };
  }
}

/* ---------------------------------------------------------------- component */

export function ActivityRow({
  event,
  actor,
  rail = true,
  last = false,
  index = 0,
  animate = true,
  onPress,
  style,
  testID,
}: ActivityRowProps) {
  const t = useTheme();
  const now = useNow();

  const meta = activityMetaFor(event.action);
  const skin = toneSkin(t, meta.tone);
  const sitting = event.actorRole === 'caregiver';
  const when = relativeTime(event.at, now);
  const clock = formatClock(event.at);
  const who = actor?.displayName ?? 'Someone';

  const tile = t.spacing.xxxl;

  const spoken = useMemo(
    () =>
      [
        event.summary,
        `${meta.label} at ${clock}, ${when}`,
        sitting ? `${who} was sitting at the time` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('. '),
    [clock, event.summary, meta.label, sitting, when, who],
  );

  const entering = animate
    ? t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(
          Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
        )
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate)
    : undefined;

  const body = (
    <Row gap="md" align="stretch">
      {/* --------------------------------------------------- rail + node */}
      <Column align="center" style={{ width: tile }}>
        <View
          style={{
            width: tile,
            height: tile,
            borderRadius: t.radius.md,
            backgroundColor: skin.fill,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={meta.icon} size="md" color={skin.ink} />
        </View>

        {rail && !last ? (
          <View
            style={{
              flex: 1,
              width: t.borderWidth.thick,
              marginTop: t.spacing.xs,
              borderRadius: t.radius.pill,
              backgroundColor: t.color.divider,
            }}
          />
        ) : null}
      </Column>

      {/* -------------------------------------------------------- content */}
      <Column flex gap="sm" style={{ paddingBottom: last ? 0 : t.spacing.lg }}>
        <Surface
          variant="surfaceAlt"
          elevation={0}
          radius="lg"
          padding="md"
          style={{ gap: t.spacing.sm }}
        >
          <Row gap="sm" align="start">
            <Text variant="callout" style={{ flex: 1 }}>
              {event.summary}
            </Text>
            <Text variant="caption" color="textTertiary" tabular>
              {clock}
            </Text>
          </Row>

          <Row gap="xs" wrap>
            <Row gap="xs" style={{ flexShrink: 1 }}>
              <Avatar
                uri={actor?.avatarUrl ?? null}
                name={who}
                size="xs"
                surfaceColor="surfaceAlt"
                accessibilityLabel={who}
              />
              <Text variant="caption" color="textSecondary" numberOfLines={1} style={{ flexShrink: 1 }}>
                {who}
              </Text>
            </Row>

            <Text variant="caption" color="textTertiary">
              ·
            </Text>
            <Text variant="caption" color="textTertiary" numberOfLines={1}>
              {when}
            </Text>

            {sitting ? (
              <Row
                gap="xxs"
                style={{
                  paddingVertical: t.spacing.hair,
                  paddingHorizontal: t.spacing.xs,
                  borderRadius: t.radius.pill,
                  backgroundColor: t.color.accentSoft,
                }}
              >
                <Icon name="home" size="xs" color="onAccentSoft" />
                <Text variant="caption" color="onAccentSoft">
                  while sitting
                </Text>
              </Row>
            ) : null}
          </Row>
        </Surface>
      </Column>
    </Row>
  );

  return (
    <Animated.View entering={entering} style={style} testID={testID}>
      {onPress ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={spoken}
          haptic="tap"
          onPress={onPress}
          pressScale="large"
        >
          {body}
        </Touchable>
      ) : (
        <View accessible accessibilityRole="text" accessibilityLabel={spoken}>
          {body}
        </View>
      )}
    </Animated.View>
  );
}

export default ActivityRow;
