/**
 * Petal — the caregiver's access card.
 *
 * This is the component the whole RBAC layer exists for. A sitter opening
 * Mochi's page should learn, in one glance and with no tapping:
 *
 *   1. which hat they're wearing,
 *   2. how much of the sitting window is left,
 *   3. what they can do, and
 *   4. what stays with the owner — and how to ask for more.
 *
 * Deliberately *not* a permissions table. Tables make people feel audited; this
 * reads like a note the owner left on the counter. The window bar is the trick
 * that makes it feel alive: it's a real elapsed fraction on a live clock, so
 * "six days left" is true at 11:59pm without a refresh.
 *
 * Renders nothing for owners and for pets the user holds no membership on —
 * an owner does not need to be told they own their dog.
 */

import { Ionicons } from '@expo/vector-icons';
import {
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isSameYear,
} from 'date-fns';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  Pressable,
  StyleSheet,
  Text as RNText,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextProps as RNTextProps,
  type ViewStyle,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import haptics from '@/lib/haptics';
import { askOwnerForAccess } from '@/rbac/DenialSheet';
import RoleBadge from '@/rbac/RoleBadge';
import {
  CAPABILITY_GROUPS,
  CAPABILITY_LABELS,
  CAREGIVER_GRANTABLE,
  matchPreset,
  presetById,
  windowState,
  type Capability,
  type CapabilityGroup,
} from '@/rbac/permissions';
import { useEffectiveCapabilities, useMembership, useNow } from '@/rbac/usePermission';
import { makeStyles, useTheme, type SpeciesKey, type Theme, type TypeVariant } from '@/theme';

/* ------------------------------------------------------------------- types */

export type AccessSummaryCardProps = {
  petId: string;
  petName: string;
  /** Turns "the owner" into "Priya" everywhere in the card. */
  ownerName?: string | null;
  /** Tints the window bar with the pet's identity colour. */
  species?: SpeciesKey;
  defaultExpanded?: boolean;
  /** Override the built-in share-sheet composer (e.g. to open an in-app chat). */
  onAskOwner?: () => void;
  style?: StyleProp<ViewStyle>;
};

type IconName = ComponentProps<typeof Ionicons>['name'];

type WindowView = {
  kind: 'upcoming' | 'active' | 'ended' | 'openEnded';
  /** 0–1 elapsed. Null when there is nothing to fill. */
  fraction: number | null;
  startLabel: string;
  endLabel: string;
  status: string;
};

/* --------------------------------------------------------------- constants */

/**
 * `pet.view` lives outside `CAPABILITY_GROUPS` (the editor treats it as
 * implicit), but a sitter reading their own card wants to see it named.
 */
const PROFILE_GROUP: CapabilityGroup = {
  id: 'profile',
  label: 'Profile',
  icon: 'paw-outline',
  items: [{ capability: 'pet.view', label: "See the pet's profile" }],
};

const ALL_GROUPS: CapabilityGroup[] = [PROFILE_GROUP, ...CAPABILITY_GROUPS];

/**
 * Owner-only capabilities worth naming to a sitter. `pet.delete` and
 * `pet.transfer` are omitted on purpose — nobody sitting a dog for a weekend
 * needs to read the words "delete pet" and "transfer ownership".
 */
const RESERVED_FOR_OWNER: readonly Capability[] = [
  'pet.edit',
  'medicine.edit',
  'caregiver.invite',
  'activity.view',
];

const MAX_ASKABLE_SHOWN = 5;

/* ---------------------------------------------------------------- helpers */

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

function dayLabel(date: Date, now: Date): string {
  return format(date, isSameYear(date, now) ? 'EEE d MMM' : 'd MMM yyyy');
}

function buildWindow(
  startsAt: string | null,
  endsAt: string | null,
  createdAt: string,
  state: ReturnType<typeof windowState>,
  now: Date,
): WindowView {
  const start = new Date(startsAt ?? createdAt);
  const end = endsAt ? new Date(endsAt) : null;
  const startLabel = Number.isNaN(start.getTime()) ? '' : dayLabel(start, now);
  const endLabel = end && !Number.isNaN(end.getTime()) ? dayLabel(end, now) : '';

  if (state === 'upcoming') {
    const days = differenceInCalendarDays(start, now);
    const status =
      days <= 0 ? 'Starts later today' : days === 1 ? 'Starts tomorrow' : `Starts in ${days} days`;
    return { kind: 'upcoming', fraction: 0, startLabel, endLabel, status };
  }

  if (state === 'ended' && end) {
    return {
      kind: 'ended',
      fraction: 1,
      startLabel,
      endLabel,
      status: `Ended ${formatDistanceToNowStrict(end, { addSuffix: true })}`,
    };
  }

  if (!end) {
    return {
      kind: 'openEnded',
      fraction: null,
      startLabel,
      endLabel: '',
      status: 'No end date set',
    };
  }

  const span = end.getTime() - start.getTime();
  const fraction = span > 0 ? clamp01((now.getTime() - start.getTime()) / span) : 1;
  const days = differenceInCalendarDays(end, now);
  const status =
    days <= 0 ? 'Last day' : days === 1 ? '1 day left' : `${days} days left`;

  return { kind: 'active', fraction, startLabel, endLabel, status };
}

/* --------------------------------------------------------------- local UI */

/** Stand-in for `@/ui/Text` while the primitives land — same ramp, same caps. */
type LabelProps = RNTextProps & { variant?: TypeVariant; color?: string };

function Label({ variant = 'body', color, style, ...rest }: LabelProps) {
  const t = useTheme();
  const { maxFontSizeMultiplier, ...typeStyle } = t.type[variant];
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[typeStyle, color ? { color } : null, style]}
    />
  );
}

type ColumnHeadingProps = { icon: IconName; title: string; fill: string; ink: string };

function ColumnHeading({ icon, title, fill, ink }: ColumnHeadingProps) {
  const t = useTheme();
  const styles = useStyles();
  return (
    <View style={styles.columnHead}>
      <View style={[styles.columnHeadChip, { backgroundColor: fill }]}>
        <Ionicons name={icon} size={t.spacing.md} color={ink} />
      </View>
      <Label variant="overline" color={t.color.textSecondary}>
        {title}
      </Label>
    </View>
  );
}

/* -------------------------------------------------------------- component */

export function AccessSummaryCard({
  petId,
  petName,
  ownerName,
  species,
  defaultExpanded = false,
  onAskOwner,
  style,
}: AccessSummaryCardProps) {
  const t = useTheme();
  const styles = useStyles();
  const now = useNow();

  const membership = useMembership(petId);
  const effective = useEffectiveCapabilities(petId);

  const [expanded, setExpanded] = useState(defaultExpanded);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [trackWidth, setTrackWidth] = useState(0);

  const open = useSharedValue(defaultExpanded ? 1 : 0);
  const fill = useSharedValue(0);
  const trackW = useSharedValue(0);

  const owner = ownerName?.trim() || 'the owner';
  const preset = useMemo(() => presetById(matchPreset(membership?.grants ?? [])), [membership]);

  const view = useMemo<WindowView | null>(() => {
    if (!membership) return null;
    return buildWindow(
      membership.startsAt,
      membership.endsAt,
      membership.createdAt,
      windowState(membership, now),
      now,
    );
  }, [membership, now]);

  const canGroups = useMemo(() => {
    const granted = new Set(effective);
    return ALL_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      items: group.items.filter((item) => granted.has(item.capability)),
    })).filter((group) => group.items.length > 0);
  }, [effective]);

  const askable = useMemo(() => {
    const granted = new Set(effective);
    return CAREGIVER_GRANTABLE.filter((capability) => !granted.has(capability));
  }, [effective]);

  const targetFraction = view?.fraction ?? 0;

  useEffect(() => {
    fill.value = withTiming(
      targetFraction,
      t.motion.timing(t.motion.duration.slower, 'decelerate'),
    );
  }, [targetFraction, fill, t.motion]);

  useEffect(() => {
    trackW.value = trackWidth;
  }, [trackWidth, trackW]);

  const bodyStyle = useAnimatedStyle(
    () => ({ height: bodyHeight * open.value, opacity: open.value }),
    [bodyHeight],
  );

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${open.value * 180}deg` }],
  }));

  const fillStyle = useAnimatedStyle(() => ({
    width: Math.max(0, trackW.value * fill.value),
  }));

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    open.value = withTiming(
      next ? 1 : 0,
      t.motion.timing(t.motion.duration.base, next ? 'decelerate' : 'accelerate'),
    );
    haptics.tap();
  }, [expanded, open, t.motion]);

  const onBodyLayout = useCallback((event: LayoutChangeEvent) => {
    setBodyHeight(event.nativeEvent.layout.height);
  }, []);

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const onAsk = useCallback(() => {
    haptics.tap();
    if (onAskOwner) {
      onAskOwner();
      return;
    }
    void askOwnerForAccess({
      petName,
      ownerName: ownerName ?? null,
      capability: askable[0] ?? null,
      reason: view?.kind === 'ended' ? 'window-expired' : 'not-granted',
    });
  }, [onAskOwner, petName, ownerName, askable, view]);

  // Owners hold everything by definition; this card would be noise on their own
  // pet, and there is nothing to render without a membership.
  if (!membership || membership.role === 'owner' || !view) return null;

  const speciesTint = species ? t.speciesColor(species).base : t.color.accent;
  const gradient: readonly [string, string] =
    view.kind === 'ended'
      ? [t.color.borderStrong, t.color.border]
      : [t.color.primary, speciesTint];

  const entering = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base)
    : FadeInDown.duration(t.motion.duration.slow).easing(t.motion.easing.decelerate);

  const headline =
    view.kind === 'upcoming'
      ? `You'll be looking after ${petName}`
      : view.kind === 'ended'
        ? `You looked after ${petName}`
        : `You're looking after ${petName}`;

  return (
    <Animated.View entering={entering} style={[styles.card, style]}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Your access to ${petName}. ${preset.label}. ${view.status}.`}
        accessibilityHint="Shows everything you can and can't do for this pet."
        style={styles.header}
      >
        <View style={styles.headerTop}>
          <RoleBadge role="caregiver" size="md" membership={membership} />
          <Animated.View style={[styles.chevron, chevronStyle]}>
            <Ionicons name="chevron-down" size={t.spacing.lg} color={t.color.textSecondary} />
          </Animated.View>
        </View>

        <Label variant="title3" color={t.color.text} style={styles.headline}>
          {headline}
        </Label>
        <Label variant="footnote" color={t.color.textTertiary}>
          {preset.label} access · {owner} keeps the record
        </Label>
      </Pressable>

      {/* ---------------------------------------------------------- window */}
      <View style={styles.window}>
        {view.kind === 'openEnded' ? (
          <View style={styles.openEnded}>
            <Ionicons name="infinite" size={t.spacing.lg} color={t.color.primaryText} />
            <Label variant="callout" color={t.color.textSecondary} style={styles.openEndedText}>
              No end date — you're set until {owner} says otherwise.
            </Label>
          </View>
        ) : (
          <>
            <View style={styles.windowLabels}>
              <Label variant="caption" color={t.color.textTertiary} numberOfLines={1}>
                {view.startLabel}
              </Label>
              <Label variant="caption" color={t.color.textTertiary} numberOfLines={1}>
                {view.endLabel}
              </Label>
            </View>

            <View style={styles.track} onLayout={onTrackLayout}>
              <Animated.View style={[styles.trackFill, fillStyle]}>
                <LinearGradient
                  colors={gradient}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={{ width: Math.max(trackWidth, 0), height: '100%' }}
                />
              </Animated.View>
            </View>

            <View style={styles.windowStatus}>
              <Ionicons
                name={view.kind === 'ended' ? 'flag-outline' : 'time-outline'}
                size={t.spacing.base}
                color={view.kind === 'ended' ? t.color.textTertiary : t.color.primaryText}
              />
              <Label
                variant="subheadStrong"
                color={view.kind === 'ended' ? t.color.textTertiary : t.color.text}
              >
                {view.status}
              </Label>
            </View>
          </>
        )}
      </View>

      {/* ------------------------------------------------------- summary */}
      <Label variant="callout" color={t.color.textSecondary} style={styles.blurb}>
        {preset.caregiverBlurb}
      </Label>

      {/* ------------------------------------------------------- details */}
      <Animated.View style={[styles.bodyClip, bodyStyle]}>
        <View
          onLayout={onBodyLayout}
          accessibilityElementsHidden={!expanded}
          importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
        >
          <View style={styles.divider} />

          <View style={[styles.columns, t.isLargeText ? styles.columnsStacked : null]}>
            <View style={styles.column}>
              <ColumnHeading
                icon="checkmark"
                title="You can"
                fill={t.color.successSoft}
                ink={t.color.onSuccessSoft}
              />
              {canGroups.map((group) => (
                <View key={group.id} style={styles.group}>
                  <Label variant="captionStrong" color={t.color.textTertiary}>
                    {group.label}
                  </Label>
                  {group.items.map((item) => (
                    <View key={item.capability} style={styles.itemRow}>
                      <Ionicons
                        name="checkmark"
                        size={t.spacing.md}
                        color={t.color.primaryText}
                        style={styles.itemGlyph}
                      />
                      <Label variant="footnote" color={t.color.text} style={styles.itemText}>
                        {item.label}
                      </Label>
                    </View>
                  ))}
                </View>
              ))}
            </View>

            <View style={styles.column}>
              <ColumnHeading
                icon="lock-closed"
                title="Owner keeps"
                fill={t.color.surfaceAlt}
                ink={t.color.textSecondary}
              />

              {askable.length > 0 ? (
                <View style={styles.group}>
                  <Label variant="captionStrong" color={t.color.textTertiary}>
                    Not switched on
                  </Label>
                  {askable.slice(0, MAX_ASKABLE_SHOWN).map((capability) => (
                    <View key={capability} style={styles.itemRow}>
                      <Ionicons
                        name="remove"
                        size={t.spacing.md}
                        color={t.color.textTertiary}
                        style={styles.itemGlyph}
                      />
                      <Label
                        variant="footnote"
                        color={t.color.textSecondary}
                        style={styles.itemText}
                      >
                        {CAPABILITY_LABELS[capability]}
                      </Label>
                    </View>
                  ))}
                  {askable.length > MAX_ASKABLE_SHOWN ? (
                    <Label variant="caption" color={t.color.textTertiary}>
                      +{askable.length - MAX_ASKABLE_SHOWN} more you could ask for
                    </Label>
                  ) : null}
                </View>
              ) : null}

              <View style={styles.group}>
                <Label variant="captionStrong" color={t.color.textTertiary}>
                  Always {owner}'s
                </Label>
                {RESERVED_FOR_OWNER.map((capability) => (
                  <View key={capability} style={styles.itemRow}>
                    <Ionicons
                      name="lock-closed"
                      size={t.spacing.md}
                      color={t.color.textTertiary}
                      style={styles.itemGlyph}
                    />
                    <Label
                      variant="footnote"
                      color={t.color.textSecondary}
                      style={styles.itemText}
                    >
                      {CAPABILITY_LABELS[capability]}
                    </Label>
                  </View>
                ))}
              </View>
            </View>
          </View>

          {askable.length > 0 ? (
            <Pressable
              onPress={onAsk}
              accessibilityRole="button"
              accessibilityLabel={`Ask ${owner} for more access to ${petName}`}
              style={styles.askButton}
            >
              <Ionicons
                name="paper-plane-outline"
                size={t.spacing.base}
                color={t.color.onPrimarySoft}
              />
              <Label variant="buttonSmall" color={t.color.onPrimarySoft}>
                Ask {owner} for more
              </Label>
            </Pressable>
          ) : null}

          <Label variant="caption" color={t.color.textTertiary} style={styles.footnote}>
            Everything you log lands in {owner}'s activity feed, so nothing gets lost.
          </Label>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

export default AccessSummaryCard;

/* ----------------------------------------------------------------- styles */

const useStyles = makeStyles((t: Theme) =>
  StyleSheet.create({
    card: {
      borderRadius: t.radius.xxl,
      backgroundColor: t.color.surface,
      borderWidth: t.borderWidth.hairline,
      borderColor: t.color.border,
      padding: t.spacing.lg,
      // No `overflow: hidden` here — on iOS it clips the card's own shadow.
      // The accordion does its clipping on `bodyClip` instead.
      ...t.elevation(2),
    },
    header: {
      minHeight: t.minTarget,
    },
    headerTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.spacing.sm,
    },
    chevron: {
      width: t.spacing.xxl,
      height: t.spacing.xxl,
      borderRadius: t.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.surfaceAlt,
    },
    headline: {
      marginTop: t.spacing.md,
    },
    window: {
      marginTop: t.spacing.base,
      gap: t.spacing.sm,
    },
    windowLabels: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: t.spacing.sm,
    },
    track: {
      height: t.spacing.sm,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.surfaceAlt,
      overflow: 'hidden',
    },
    trackFill: {
      height: '100%',
      borderRadius: t.radius.pill,
      overflow: 'hidden',
    },
    windowStatus: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
    },
    openEnded: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radius.md,
      backgroundColor: t.color.primarySoft,
    },
    openEndedText: {
      flex: 1,
    },
    blurb: {
      marginTop: t.spacing.base,
    },
    bodyClip: {
      overflow: 'hidden',
    },
    divider: {
      height: t.borderWidth.hairline,
      backgroundColor: t.color.divider,
      marginTop: t.spacing.base,
      marginBottom: t.spacing.base,
    },
    columns: {
      flexDirection: 'row',
      gap: t.spacing.base,
    },
    columnsStacked: {
      flexDirection: 'column',
      gap: t.spacing.lg,
    },
    column: {
      flex: 1,
      gap: t.spacing.sm,
    },
    columnHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.xs,
    },
    columnHeadChip: {
      width: t.spacing.lg,
      height: t.spacing.lg,
      borderRadius: t.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    group: {
      gap: t.spacing.xxs,
    },
    itemRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.spacing.xs,
    },
    itemGlyph: {
      marginTop: t.spacing.hair,
    },
    itemText: {
      flex: 1,
    },
    askButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.spacing.sm,
      minHeight: t.minTarget,
      marginTop: t.spacing.lg,
      paddingHorizontal: t.spacing.base,
      borderRadius: t.radius.md,
      backgroundColor: t.color.primarySoft,
      borderWidth: t.borderWidth.hairline,
      borderColor: t.color.primarySoftBorder,
    },
    footnote: {
      marginTop: t.spacing.md,
    },
  }),
);
