/**
 * Petal — Timeline.
 *
 * The vertical rail behind Today and the activity log. It is one component
 * rather than two because they are genuinely the same object seen at two
 * scales: a day of care tasks, and a history of what was done to a pet.
 *
 * Details that earn their keep:
 *
 *   · **The rail is drawn per row, in two halves.** The first row has no line
 *     above its dot and the last none below, so the rail starts and ends *on*
 *     an event instead of dangling into whitespace.
 *   · **The now marker is a real row**, not an overlay. It sits between two
 *     entries and pushes them apart, which is why it survives dynamic type and
 *     variable-height content — an absolutely positioned line would not.
 *   · **State is in the dot, not in the copy.** Done is filled, upcoming is
 *     hollow, missed is a filled warning. You can read a day's status down the
 *     rail without reading a word.
 */

import React, { useEffect, useMemo, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme, type Theme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Row } from './Stack';
import { Text } from './Text';
import { Touchable } from './Touchable';

/* -------------------------------------------------------------------- types */

export type TimelineTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export type TimelineState = 'done' | 'due' | 'upcoming' | 'missed' | 'skipped';

export type TimelineEntry = {
  id: string;
  title: string;
  subtitle?: string;
  /** Right-aligned time or value — "07:30", "120 g". */
  meta?: string;
  icon?: IconName;
  tone?: TimelineTone;
  state?: TimelineState;
  /** Starts a new day group above this entry. */
  dayLabel?: string;
  onPress?: () => void;
  disabledReason?: string;
  /** Trailing control — a checkbox, a badge, a chevron. */
  trailing?: ReactNode;
  /** Replaces the title/subtitle block for a fully custom row. */
  content?: ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

export type TimelineProps = {
  entries: TimelineEntry[];
  /**
   * Index the "now" marker sits above. `entries.length` puts it at the end,
   * `null` hides it.
   */
  nowIndex?: number | null;
  nowLabel?: string;
  dense?: boolean;
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/* ---------------------------------------------------------------- constants */

/** Beyond this the entrance cascade reads as lag rather than choreography. */
const MAX_STAGGERED = 8;

/* ------------------------------------------------------------------ helpers */

function toneColors(t: Theme, tone: TimelineTone) {
  switch (tone) {
    case 'accent':
      return { fill: t.color.accent, soft: t.color.accentSoft, ink: t.color.onAccentSoft };
    case 'success':
      return { fill: t.color.success, soft: t.color.successSoft, ink: t.color.onSuccessSoft };
    case 'warning':
      return { fill: t.color.warning, soft: t.color.warningSoft, ink: t.color.onWarningSoft };
    case 'danger':
      return { fill: t.color.danger, soft: t.color.dangerSoft, ink: t.color.onDangerSoft };
    case 'info':
      return { fill: t.color.info, soft: t.color.infoSoft, ink: t.color.onInfoSoft };
    case 'neutral':
      return { fill: t.color.textTertiary, soft: t.color.surfaceAlt, ink: t.color.textSecondary };
    case 'primary':
    default:
      return { fill: t.color.primary, soft: t.color.primarySoft, ink: t.color.onPrimarySoft };
  }
}

/** State wins over tone: an overdue dose is amber whatever colour it carries. */
function stateTone(state: TimelineState | undefined, tone: TimelineTone | undefined): TimelineTone {
  switch (state) {
    case 'missed':
      return 'warning';
    case 'done':
      return tone ?? 'success';
    case 'skipped':
      return 'neutral';
    default:
      return tone ?? 'primary';
  }
}

/* ---------------------------------------------------------------- component */

export function Timeline({
  entries,
  nowIndex = null,
  nowLabel = 'Now',
  dense = false,
  animate = true,
  style,
  testID,
}: TimelineProps) {
  const t = useTheme();

  const railWidth = t.spacing.xxl;
  const gap = dense ? t.spacing.md : t.spacing.base;
  const rowGap = dense ? t.spacing.base : t.spacing.lg;
  const lineWidth = t.borderWidth.thick;
  const titleLead = t.type.headline.lineHeight ?? t.spacing.xl;

  const rows = useMemo(() => {
    let lastDay: string | undefined;
    return entries.map((entry, index) => {
      // Only the *first* entry of a day carries its header, so a screen can set
      // `dayLabel` on every entry and let the rail do the grouping.
      const day = entry.dayLabel !== undefined && entry.dayLabel !== lastDay ? entry.dayLabel : null;
      if (entry.dayLabel !== undefined) lastDay = entry.dayLabel;
      return { entry, index, day };
    });
  }, [entries]);

  return (
    <View style={style} testID={testID}>
      {rows.map(({ entry, index, day }) => (
        <React.Fragment key={entry.id}>
          {day !== null ? (
            <DayHeader label={day} railWidth={railWidth} gap={gap} first={index === 0} />
          ) : null}
          {nowIndex === index ? (
            <NowMarker label={nowLabel} railWidth={railWidth} gap={gap} lineWidth={lineWidth} />
          ) : null}
          <TimelineRow
            entry={entry}
            index={index}
            first={index === 0}
            last={index === entries.length - 1}
            railWidth={railWidth}
            gap={gap}
            rowGap={rowGap}
            lineWidth={lineWidth}
            titleLead={titleLead}
            animate={animate}
          />
        </React.Fragment>
      ))}
      {nowIndex !== null && nowIndex >= entries.length ? (
        <NowMarker label={nowLabel} railWidth={railWidth} gap={gap} lineWidth={lineWidth} />
      ) : null}
    </View>
  );
}

/* --------------------------------------------------------------------- row */

type TimelineRowProps = {
  entry: TimelineEntry;
  index: number;
  first: boolean;
  last: boolean;
  railWidth: number;
  gap: number;
  rowGap: number;
  lineWidth: number;
  titleLead: number;
  animate: boolean;
};

function TimelineRow({
  entry,
  index,
  first,
  last,
  railWidth,
  gap,
  rowGap,
  lineWidth,
  titleLead,
  animate,
}: TimelineRowProps) {
  const t = useTheme();
  const tone = stateTone(entry.state, entry.tone);
  const skin = toneColors(t, tone);

  const icon = entry.icon;
  const hasIcon = icon !== undefined;
  const dotSize = hasIcon ? t.spacing.xl + t.spacing.xxs : t.spacing.md;
  const dotTop = Math.max(0, (titleLead - dotSize) / 2);
  const hollow = entry.state === 'upcoming';

  const description =
    entry.accessibilityLabel ??
    [entry.title, entry.subtitle, entry.meta].filter(Boolean).join(', ');

  const body = (
    <View style={{ flexDirection: 'row', gap, paddingBottom: last ? 0 : rowGap }}>
      <View style={{ width: railWidth, alignItems: 'center' }}>
        {/* Two halves, so the rail begins and ends on an event. */}
        {!first ? (
          <View
            style={{
              position: 'absolute',
              top: 0,
              height: dotTop,
              width: lineWidth,
              backgroundColor: t.color.border,
            }}
          />
        ) : null}
        {!last ? (
          <View
            style={{
              position: 'absolute',
              top: dotTop + dotSize,
              bottom: 0,
              width: lineWidth,
              backgroundColor: t.color.border,
            }}
          />
        ) : null}

        <View
          style={{
            marginTop: dotTop,
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: hollow ? t.color.surface : hasIcon ? skin.soft : skin.fill,
            borderWidth: hollow || hasIcon ? t.borderWidth.thick : 0,
            borderColor: hollow ? t.color.borderStrong : skin.fill,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {icon ? <Icon name={icon} size="xs" color={skin.ink} /> : null}
        </View>
      </View>

      <View style={{ flex: 1, gap: t.spacing.hair }}>
        {entry.content ?? (
          <>
            <Row gap="sm" align="start">
              <Text
                variant="headline"
                color={entry.state === 'skipped' ? 'textTertiary' : 'text'}
                numberOfLines={2}
                style={{ flex: 1 }}
              >
                {entry.title}
              </Text>
              {entry.meta ? (
                <Text variant="footnote" color="textTertiary" tabular numberOfLines={1}>
                  {entry.meta}
                </Text>
              ) : null}
              {entry.trailing}
            </Row>
            {entry.subtitle ? (
              <Text variant="footnote" color="textSecondary" numberOfLines={2}>
                {entry.subtitle}
              </Text>
            ) : null}
          </>
        )}
      </View>
    </View>
  );

  const staggered = Math.min(index, MAX_STAGGERED) * t.motion.stagger.tight;
  const entering = !animate
    ? undefined
    : t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(staggered)
      : FadeInDown.delay(staggered).springify().damping(t.motion.spring.gentle.damping);

  const content = <Animated.View entering={entering}>{body}</Animated.View>;

  if (!entry.onPress && entry.disabledReason === undefined) return content;

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={description}
      accessibilityHint={entry.accessibilityHint}
      disabledReason={entry.disabledReason}
      haptic="tap"
      onPress={entry.onPress}
      pressScale="large"
    >
      {content}
    </Touchable>
  );
}

/* ------------------------------------------------------------------ markers */

function DayHeader({
  label,
  railWidth,
  gap,
  first,
}: {
  label: string;
  railWidth: number;
  gap: number;
  first: boolean;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        gap,
        paddingTop: first ? 0 : t.spacing.lg,
        paddingBottom: t.spacing.md,
      }}
      accessibilityRole="header"
    >
      <View style={{ width: railWidth }} />
      <Text variant="overline" color="textTertiary">
        {label}
      </Text>
    </View>
  );
}

/**
 * The current moment. The dot breathes so the eye finds it in a long day;
 * under reduced motion it simply holds at full size, which still reads.
 */
function NowMarker({
  label,
  railWidth,
  gap,
  lineWidth,
}: {
  label: string;
  railWidth: number;
  gap: number;
  lineWidth: number;
}) {
  const t = useTheme();
  const pulse = useSharedValue(0);
  const reduce = t.reduceMotion;

  useEffect(() => {
    if (reduce) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, t.motion.timing(t.motion.duration.ambient / 2, 'smooth')),
      -1,
      true,
    );
    return () => cancelAnimation(pulse);
  }, [pulse, reduce, t.motion]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: reduce ? 0.28 : 0.34 - pulse.value * 0.24,
    transform: [{ scale: reduce ? 1.5 : 1 + pulse.value * 1.1 }],
  }));

  const dot = t.spacing.md;

  return (
    <View style={{ flexDirection: 'row', gap, alignItems: 'center', paddingVertical: t.spacing.sm }}>
      <View style={{ width: railWidth, alignItems: 'center', justifyContent: 'center' }}>
        {/* The rail continues through the marker. */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: lineWidth,
            backgroundColor: t.color.border,
          }}
        />
        <Animated.View
          style={[
            {
              position: 'absolute',
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: t.color.accent,
            },
            haloStyle,
          ]}
        />
        <View
          style={{
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: t.color.accent,
            borderWidth: t.borderWidth.thick,
            borderColor: t.color.bg,
          }}
        />
      </View>
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
        <Text variant="captionStrong" color="accentText">
          {label}
        </Text>
        <View style={{ flex: 1, height: t.borderWidth.hairline, backgroundColor: t.color.accent, opacity: 0.32 }} />
      </View>
    </View>
  );
}

export default Timeline;
