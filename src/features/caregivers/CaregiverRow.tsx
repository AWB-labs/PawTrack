/**
 * Petal — CaregiverRow.
 *
 * One person's link to one pet. It has to answer four questions without a tap,
 * because an owner scanning this list is deciding whether their dog is covered
 * this weekend:
 *
 *   1. **Who**, with a face rather than an email address.
 *   2. **In what capacity** — the role badge, plus the preset name, plus a
 *      plain-language readout of what they can actually *do* ("Meals ·
 *      Medicine · Weight"). A grant list is an audit; three words are an answer.
 *   3. **For how long** — the window bar is a live elapsed fraction on the
 *      shared clock, so "2 days left" is true at midnight without a refresh and
 *      the bar visibly fills over a weekend of sitting.
 *   4. **What state it's in** — pending, upcoming, active, ended and revoked get
 *      different accents, different glyphs and different words. A revoked row
 *      stays (the activity trail has to remain attributable) but it must never
 *      look like a live one.
 *
 * The management controls are `hide`-gated rather than disabled: managing other
 * caregivers is owner-only forever, so a dimmed "Remove" button on a sitter's
 * screen would be a threat with no way to act on it. The screen passes
 * `canManage`; when it's false the row is simply a legible read-only card.
 *
 * Revoking confirms in place. `ConfirmSheet` — never `Alert` — because the
 * question has to name the person and say exactly what survives.
 */

import { useCallback, useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import type { MembershipWithUser } from '@/data/types';
import { formatDay, relativeTime } from '@/lib/date';
import { possessive } from '@/lib/format';
import {
  matchPreset,
  presetById,
  windowState,
  type Capability,
  type Membership,
} from '@/rbac/permissions';
import { RoleBadge } from '@/rbac/RoleBadge';
import { useNow } from '@/rbac/usePermission';
import { useTheme, type Theme } from '@/theme';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Column,
  ConfirmSheet,
  Icon,
  ProgressBar,
  Row,
  Text,
  useSheet,
  type IconName,
  type ProgressBarTone,
} from '@/ui';

/* -------------------------------------------------------------------- types */

export type CaregiverRowProps = {
  membership: MembershipWithUser;
  /** Used throughout the copy — "…can look after Buddy". */
  petName: string;
  /** Marks the row describing the signed-in user. */
  isYou?: boolean;
  /**
   * Owner-only controls. False renders a read-only card — the management
   * actions are hidden, not disabled, because no caregiver can ever hold them.
   */
  canManage?: boolean;
  onEditPermissions?: (membership: MembershipWithUser) => void;
  onExtend?: (membership: MembershipWithUser) => void;
  /** Fired after the confirmation sheet is answered, never before. */
  onRevoke?: (membership: MembershipWithUser) => void;
  /** Position in its list; drives the entrance stagger. */
  index?: number;
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** How the link reads right now. Drives every colour and every word below. */
type LinkState = 'owner' | 'pending' | 'upcoming' | 'active' | 'ended' | 'revoked';

type Skin = { accent: string; icon: IconName; bar: ProgressBarTone };

/* ---------------------------------------------------------------- constants */

/** Past ~8 the cascade reads as lag rather than choreography. */
const STAGGER_CAP = 8;

/**
 * The compact readout. Deliberately *doing* verbs only — a sitter who can see
 * the medicine list but not log a dose has "View only" access, and saying
 * "Medicine" there would be a lie the owner acts on.
 */
const DOING_LABELS: readonly (readonly [Capability, string])[] = [
  ['feeding.log', 'Meals'],
  ['medicine.log', 'Medicine'],
  ['weight.log', 'Weight'],
  ['appointment.create', 'Appointments'],
  ['vaccination.edit', 'Vaccinations'],
  ['vetvisit.edit', 'Visit notes'],
  ['document.upload', 'Photos'],
  ['feeding.schedule.edit', 'Schedules'],
  ['community.post', 'Posts'],
];

/** Beyond this the line wraps and stops being scannable. */
const MAX_DOING_SHOWN = 3;

/* ------------------------------------------------------------------ helpers */

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

function linkStateOf(membership: Membership, now: Date): LinkState {
  if (membership.role === 'owner') return 'owner';
  if (membership.status === 'revoked') return 'revoked';
  if (membership.status === 'pending') return 'pending';
  if (membership.status === 'expired') return 'ended';

  switch (windowState(membership, now)) {
    case 'upcoming':
      return 'upcoming';
    case 'ended':
      return 'ended';
    default:
      return 'active';
  }
}

function skinFor(t: Theme, state: LinkState): Skin {
  switch (state) {
    case 'owner':
      return { accent: t.color.primary, icon: 'shield-checkmark', bar: 'primary' };
    case 'pending':
      return { accent: t.color.warning, icon: 'mail-unread-outline', bar: 'warning' };
    case 'upcoming':
      return { accent: t.color.info, icon: 'hourglass-outline', bar: 'info' };
    case 'active':
      return { accent: t.color.success, icon: 'radio-button-on', bar: 'success' };
    case 'revoked':
      return { accent: t.color.danger, icon: 'close-circle-outline', bar: 'danger' };
    case 'ended':
    default:
      return { accent: t.color.borderStrong, icon: 'flag-outline', bar: 'primary' };
  }
}

/** The three words an owner reads instead of a grant list. */
function describeDoing(membership: Membership): string {
  if (membership.role === 'owner') return 'Everything, including the account';

  const held = new Set<Capability>(membership.grants);
  const doing = DOING_LABELS.filter(([capability]) => held.has(capability)).map(([, label]) => label);

  if (doing.length === 0) return 'Can see, cannot log';
  const shown = doing.slice(0, MAX_DOING_SHOWN);
  const extra = doing.length - shown.length;
  return extra > 0 ? `${shown.join(' · ')} · +${extra}` : shown.join(' · ');
}

/** The one line under the bar: how much of the arrangement is left. */
function describeWindow(membership: Membership, state: LinkState, now: Date): string {
  const end = membership.endsAt ? new Date(membership.endsAt) : null;
  const start = membership.startsAt ? new Date(membership.startsAt) : null;

  switch (state) {
    case 'pending':
      return start ? `Starts ${relativeTime(start, now)} once accepted` : 'Waiting on them to accept';
    case 'upcoming':
      return start ? `Starts ${relativeTime(start, now)}` : 'Starts soon';
    case 'ended':
      return end ? `Finished ${relativeTime(end, now)}` : 'Finished';
    case 'revoked':
      return 'Access switched off';
    case 'owner':
      return 'Ownership never expires';
    case 'active':
    default:
      return end ? `Ends ${relativeTime(end, now)}` : 'No end date — ongoing';
  }
}

/* ---------------------------------------------------------------- component */

export function CaregiverRow({
  membership,
  petName,
  isYou = false,
  canManage = false,
  onEditPermissions,
  onExtend,
  onRevoke,
  index = 0,
  animate = true,
  style,
  testID,
}: CaregiverRowProps) {
  const t = useTheme();
  const now = useNow();
  const revokeSheet = useSheet();

  const person = membership.user;
  const state = linkStateOf(membership, now);
  const skin = skinFor(t, state);
  const isOwner = state === 'owner';
  const preset = useMemo(() => presetById(matchPreset(membership.grants)), [membership.grants]);
  const doing = useMemo(() => describeDoing(membership), [membership]);
  const windowLine = describeWindow(membership, state, now);

  /**
   * Elapsed fraction of the sitting window. `createdAt` stands in for a null
   * start — a membership with no start date began the moment it was made, and a
   * bar that fills from 1970 is worse than no bar at all.
   */
  const progress = useMemo<number | null>(() => {
    if (isOwner || !membership.endsAt) return null;
    const start = Date.parse(membership.startsAt ?? membership.createdAt);
    const end = Date.parse(membership.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return clamp01((now.getTime() - start) / (end - start));
  }, [isOwner, membership.createdAt, membership.endsAt, membership.startsAt, now]);

  const startLabel = membership.startsAt ? formatDay(membership.startsAt, now) : 'From today';
  const endLabel = membership.endsAt ? formatDay(membership.endsAt, now) : '';

  const spoken = useMemo(() => {
    const parts = [
      isYou ? `${person.displayName} — you` : person.displayName,
      isOwner ? 'Owner' : `${preset.label} access`,
      doing,
      windowLine,
    ];
    return parts.join('. ');
  }, [doing, isOwner, isYou, person.displayName, preset.label, windowLine]);

  const handleRevoke = useCallback(() => {
    onRevoke?.(membership);
  }, [membership, onRevoke]);

  const entering = animate
    ? t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(
          Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
        )
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate)
    : undefined;

  /** Only a live caregiver arrangement can be managed — and never your own row. */
  const showControls = canManage && !isOwner && state !== 'revoked';

  return (
    <Animated.View entering={entering} style={style}>
      <Card
        accent={skin.accent}
        radius="xxl"
        padding="base"
        gap="md"
        elevation={1}
        testID={testID}
        style={state === 'revoked' || state === 'ended' ? { opacity: t.opacity.muted } : undefined}
      >
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={spoken}
          style={{ gap: t.spacing.md }}
        >
          <Row gap="md" align="start">
            <Avatar
              uri={person.avatarUrl}
              name={person.displayName}
              size="lg"
              ring={isOwner}
              live={state === 'active'}
              status={state === 'active' ? 'sitting' : undefined}
              accessibilityLabel={person.displayName}
            />

            <Column flex gap="xs">
              <Row gap="xs">
                <Text variant="title3" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {person.displayName}
                </Text>
                {isYou ? <Badge label="You" tone="primary" size="sm" /> : null}
              </Row>

              <RoleBadge role={membership.role} size="sm" membership={membership} />
            </Column>
          </Row>

          {/* ------------------------------------------------ what they can do */}
          <Row
            gap="sm"
            align="start"
            style={{
              paddingVertical: t.spacing.sm,
              paddingHorizontal: t.spacing.md,
              borderRadius: t.radius.md,
              backgroundColor: t.color.surfaceAlt,
            }}
          >
            <Icon name={isOwner ? 'key-outline' : 'checkmark-circle-outline'} size="sm" color="textSecondary" />
            <Column flex gap="hair">
              <Text variant="subheadStrong" numberOfLines={2}>
                {doing}
              </Text>
              {!isOwner ? (
                <Text variant="caption" color="textTertiary" numberOfLines={1}>
                  {preset.label} access
                </Text>
              ) : null}
            </Column>
          </Row>

          {/* -------------------------------------------------- access window */}
          {!isOwner ? (
            <Column gap="xs">
              {progress === null ? (
                <Row
                  gap="sm"
                  style={{
                    paddingVertical: t.spacing.xs,
                    paddingHorizontal: t.spacing.md,
                    borderRadius: t.radius.md,
                    backgroundColor: t.color.primarySoft,
                  }}
                >
                  <Icon name="infinite" size="sm" color="onPrimarySoft" />
                  <Text variant="caption" color="onPrimarySoft" numberOfLines={1} style={{ flex: 1 }}>
                    {startLabel} · no end date set
                  </Text>
                </Row>
              ) : (
                <ProgressBar
                  value={progress}
                  tone={skin.bar}
                  size="md"
                  label={startLabel}
                  trailingLabel={endLabel}
                  gradient={state === 'active'}
                  accessibilityLabel={`Sitting window: ${startLabel} to ${endLabel}. ${windowLine}.`}
                />
              )}

              <Row gap="xs">
                <Icon name={skin.icon} size="xs" color={state === 'active' ? 'success' : 'textTertiary'} />
                <Text
                  variant="caption"
                  color={state === 'active' ? 'text' : 'textTertiary'}
                  numberOfLines={1}
                  style={{ flexShrink: 1 }}
                >
                  {windowLine}
                </Text>
              </Row>
            </Column>
          ) : (
            <Row gap="xs">
              <Icon name={skin.icon} size="xs" color="primaryText" />
              <Text variant="caption" color="textTertiary" numberOfLines={1}>
                {windowLine}
              </Text>
            </Row>
          )}
        </View>

        {/* --------------------------------------------------- owner controls */}
        {showControls ? (
          <Row gap="sm" wrap>
            <Button
              label="Permissions"
              onPress={() => onEditPermissions?.(membership)}
              variant="tonal"
              size="sm"
              leftIcon="options-outline"
              accessibilityHint={`Changes what ${person.displayName} can do for ${petName}.`}
            />
            <Button
              label={state === 'ended' ? 'Invite again' : 'Dates'}
              onPress={() => onExtend?.(membership)}
              variant="secondary"
              size="sm"
              leftIcon="calendar-outline"
              accessibilityHint={`Changes how long ${person.displayName} keeps access.`}
            />
            <View style={{ flex: 1 }} />
            <Button
              label="Remove"
              onPress={() => revokeSheet.open()}
              variant="ghost"
              size="sm"
              leftIcon="person-remove-outline"
              haptic="select"
              accessibilityHint={`Ends ${possessive(person.displayName)} access to ${petName}.`}
            />
          </Row>
        ) : null}
      </Card>

      {showControls ? (
        <ConfirmSheet
          controller={revokeSheet}
          title={`Remove ${person.displayName}?`}
          body={`${person.displayName} will lose access to ${possessive(petName)} profile straight away, and won't be able to log meals or medicine any more. Everything they already logged stays in the activity log.`}
          confirmLabel={`Yes, remove ${person.displayName}`}
          cancelLabel="Keep their access"
          icon="person-remove-outline"
          onConfirm={handleRevoke}
        >
          <Row
            gap="md"
            style={{
              padding: t.spacing.base,
              borderRadius: t.radius.lg,
              backgroundColor: t.color.surfaceAlt,
            }}
          >
            <Avatar uri={person.avatarUrl} name={person.displayName} size="md" />
            <Column flex gap="hair">
              <Text variant="bodyStrong" numberOfLines={1}>
                {person.displayName}
              </Text>
              <Text variant="caption" color="textTertiary" numberOfLines={2}>
                {`${preset.label} · ${windowLine}`}
              </Text>
            </Column>
          </Row>
        </ConfirmSheet>
      ) : null}
    </Animated.View>
  );
}

export default CaregiverRow;
