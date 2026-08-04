/**
 * Petal — InviteCard.
 *
 * A pending invite is a *thing you hand to someone*, so the card is built around
 * the handover rather than around the record: the code is the largest element on
 * it, tracked wide enough to read across a table and to type without
 * transcription errors, and tapping it copies.
 *
 * The countdown runs on the shared RBAC clock rather than a local timer, which
 * is what lets "expires in 6 hours" tick down to "expires in 5 hours" while the
 * owner is still looking at the screen, and flips the whole card to its expired
 * treatment the moment it lapses — no pull-to-refresh, no stale promise.
 *
 * Spent invites (accepted, expired, revoked) keep their place, dimmed and
 * without actions. An invite that vanishes the instant it's used leaves the
 * owner wondering whether they imagined sending it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import type { Invite } from '@/data/types';
import { formatDay, relativeTime } from '@/lib/date';
import haptics from '@/lib/haptics';
import { copyInviteCode, isDismissed, shareInvite } from '@/lib/share';
import { presetById } from '@/rbac/permissions';
import { useNow } from '@/rbac/usePermission';
import { useTheme, type Theme } from '@/theme';
import {
  Badge,
  Button,
  Column,
  ConfirmSheet,
  Divider,
  Icon,
  Row,
  Surface,
  Text,
  toast,
  Touchable,
  useSheet,
  type BadgeTone,
  type IconName,
} from '@/ui';

/* -------------------------------------------------------------------- types */

export type InviteCardProps = {
  invite: Invite;
  petName: string;
  /** Owner-only controls. False renders the card read-only. */
  canManage?: boolean;
  /** Opens the QR view. Omit to hide the QR action. */
  onShowQR?: (invite: Invite) => void;
  /** Replaces the built-in share sheet — e.g. to send inside another app. */
  onShare?: (invite: Invite) => void;
  /** Fired after the confirmation sheet is answered, never before. */
  onRevoke?: (invite: Invite) => void;
  index?: number;
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type InviteSkin = {
  label: string;
  tone: BadgeTone;
  icon: IconName;
  accent: string;
  live: boolean;
};

/* ---------------------------------------------------------------- constants */

const STAGGER_CAP = 8;

/** How long the code's "copied" tick sits before the control settles back. */
const COPIED_HOLD_MS = 1600;

/* ------------------------------------------------------------------ helpers */

function skinFor(t: Theme, invite: Invite, now: Date): InviteSkin {
  const lapsed = Date.parse(invite.expiresAt) <= now.getTime();

  if (invite.status === 'revoked') {
    return { label: 'Turned off', tone: 'danger', icon: 'close-circle-outline', accent: t.color.danger, live: false };
  }
  if (invite.status === 'accepted') {
    return { label: 'Accepted', tone: 'success', icon: 'checkmark-circle-outline', accent: t.color.success, live: false };
  }
  if (invite.status === 'expired' || lapsed) {
    return { label: 'Expired', tone: 'neutral', icon: 'time-outline', accent: t.color.borderStrong, live: false };
  }
  return { label: 'Waiting', tone: 'warning', icon: 'mail-unread-outline', accent: t.color.warning, live: true };
}

/** The countdown line. Warm, specific, and never a bare timestamp. */
function describeExpiry(invite: Invite, skin: InviteSkin, now: Date): string {
  if (invite.status === 'revoked') return 'This link no longer works';
  if (invite.status === 'accepted') return 'Someone used this code and joined';
  if (!skin.live) return `Expired ${relativeTime(invite.expiresAt, now)}`;
  return `Expires ${relativeTime(invite.expiresAt, now)}`;
}

/** The access this invite hands over, in one line. */
function describeAccess(invite: Invite, now: Date): string {
  const preset = presetById(invite.presetId);
  if (!invite.startsAt && !invite.endsAt) return `${preset.label} · no end date`;
  const from = invite.startsAt ? formatDay(invite.startsAt, now) : 'From today';
  const to = invite.endsAt ? formatDay(invite.endsAt, now) : 'open-ended';
  return `${preset.label} · ${from} → ${to}`;
}

/* ---------------------------------------------------------------- component */

export function InviteCard({
  invite,
  petName,
  canManage = false,
  onShowQR,
  onShare,
  onRevoke,
  index = 0,
  animate = true,
  style,
  testID,
}: InviteCardProps) {
  const t = useTheme();
  const now = useNow();
  const revokeSheet = useSheet();

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const skin = skinFor(t, invite, now);
  const preset = useMemo(() => presetById(invite.presetId), [invite.presetId]);
  const expiry = describeExpiry(invite, skin, now);
  const access = describeAccess(invite, now);

  const recipient = invite.inviteeName?.trim()
    ? invite.inviteeName.trim()
    : invite.inviteeEmail?.trim() || null;

  const handleCopy = useCallback(() => {
    void (async () => {
      const outcome = await copyInviteCode(invite.code);
      if (!outcome.ok) {
        toast.error(outcome.message);
        return;
      }
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPIED_HOLD_MS);
      toast.success('Code copied', { description: `Paste it wherever you're inviting them from.` });
    })();
  }, [invite.code]);

  const handleShare = useCallback(() => {
    if (onShare) {
      onShare(invite);
      return;
    }
    haptics.tap();
    void (async () => {
      const outcome = await shareInvite({
        petName,
        code: invite.code,
        inviteeName: invite.inviteeName,
        accessBlurb: preset.caregiverBlurb,
      });
      if (!outcome.ok && !isDismissed(outcome)) toast.error(outcome.message);
      else if (outcome.ok && outcome.via === 'clipboard') {
        toast.info('Copied instead', { description: 'The share sheet wouldn’t open, so the invite is on your clipboard.' });
      }
    })();
  }, [invite, onShare, petName, preset.caregiverBlurb]);

  const handleRevoke = useCallback(() => {
    onRevoke?.(invite);
  }, [invite, onRevoke]);

  const entering = animate
    ? t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(
          Math.min(index, STAGGER_CAP) * t.motion.stagger.tight,
        )
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(Math.min(index, STAGGER_CAP) * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate)
    : undefined;

  const showActions = canManage && skin.live;

  return (
    <Animated.View entering={entering} style={style}>
      <Surface
        variant="surface"
        elevation={1}
        radius="xxl"
        padding="base"
        border
        testID={testID}
        style={[{ gap: t.spacing.base }, skin.live ? null : { opacity: t.opacity.muted }]}
      >
        {/* ------------------------------------------------------------ head */}
        <Row gap="md" align="start">
          <View
            style={{
              width: t.spacing.xxxl,
              height: t.spacing.xxxl,
              borderRadius: t.radius.md,
              backgroundColor: skin.live ? t.color.warningSoft : t.color.surfaceAlt,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon
              name={skin.icon}
              size="md"
              color={skin.live ? 'onWarningSoft' : 'textSecondary'}
            />
          </View>

          <Column flex gap="hair">
            <Text variant="headline" numberOfLines={1}>
              {recipient ? `Invite for ${recipient}` : 'Open invite'}
            </Text>
            <Text variant="caption" color="textTertiary" numberOfLines={2}>
              {expiry}
            </Text>
          </Column>

          <Badge label={skin.label} tone={skin.tone} size="md" />
        </Row>

        {/* ------------------------------------------------------------ code */}
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={`Invite code ${invite.code.split('').join(' ')}`}
          accessibilityHint="Copies the code to your clipboard."
          haptic="none"
          onPress={handleCopy}
          pressScale="large"
        >
          <View
            style={{
              alignItems: 'center',
              gap: t.spacing.xs,
              paddingVertical: t.spacing.lg,
              paddingHorizontal: t.spacing.base,
              borderRadius: t.radius.xl,
              backgroundColor: t.color.surfaceAlt,
              borderWidth: t.borderWidth.thin,
              borderColor: skin.live ? t.color.primarySoftBorder : t.color.border,
              borderStyle: 'dashed',
            }}
          >
            <Text
              variant="metric"
              align="center"
              numberOfLines={1}
              tabular
              adjustsFontSizeToFit
              style={{ letterSpacing: t.spacing.xxs }}
            >
              {invite.code}
            </Text>

            <Animated.View key={copied ? 'copied' : 'idle'} entering={FadeIn.duration(t.motion.duration.fast)}>
              <Row gap="xxs">
                <Icon
                  name={copied ? 'checkmark-circle' : 'copy-outline'}
                  size="xs"
                  color={copied ? 'primaryText' : 'textTertiary'}
                />
                <Text variant="caption" color={copied ? 'primaryText' : 'textTertiary'}>
                  {copied ? 'Copied to your clipboard' : 'Tap to copy'}
                </Text>
              </Row>
            </Animated.View>
          </View>
        </Touchable>

        {/* ---------------------------------------------------------- access */}
        <Row gap="xs" align="start">
          <Icon name="key-outline" size="xs" color="textTertiary" />
          <Text variant="caption" color="textSecondary" numberOfLines={2} style={{ flex: 1 }}>
            {access}
          </Text>
        </Row>

        {invite.maxUses > 1 ? (
          <Text variant="caption" color="textTertiary">
            {`Used ${invite.uses} of ${invite.maxUses} times`}
          </Text>
        ) : null}

        {/* --------------------------------------------------------- actions */}
        {showActions ? (
          <>
            <Divider />
            <Row gap="sm" wrap>
              <Button
                label="Share"
                onPress={handleShare}
                variant="tonal"
                size="sm"
                leftIcon="paper-plane-outline"
                accessibilityHint={`Sends the invite message for ${petName}.`}
              />
              {onShowQR ? (
                <Button
                  label="QR code"
                  onPress={() => onShowQR(invite)}
                  variant="secondary"
                  size="sm"
                  leftIcon="qr-code-outline"
                  accessibilityHint="Shows a scannable code they can point a camera at."
                />
              ) : null}
              <View style={{ flex: 1 }} />
              <Button
                label="Revoke"
                onPress={() => revokeSheet.open()}
                variant="ghost"
                size="sm"
                leftIcon="ban-outline"
                haptic="select"
                accessibilityHint="Stops this code from working."
              />
            </Row>
          </>
        ) : null}
      </Surface>

      {showActions ? (
        <ConfirmSheet
          controller={revokeSheet}
          title="Turn off this invite?"
          body={`Anyone holding ${invite.code} won't be able to use it any more. You can always create a fresh invite for ${petName} in a few taps.`}
          confirmLabel="Turn it off"
          cancelLabel="Keep it working"
          icon="ban-outline"
          onConfirm={handleRevoke}
        >
          <Column
            gap="xxs"
            style={{
              padding: t.spacing.base,
              borderRadius: t.radius.lg,
              backgroundColor: t.color.surfaceAlt,
            }}
          >
            <Text variant="bodyStrong" tabular>
              {invite.code}
            </Text>
            <Text variant="caption" color="textTertiary">
              {access}
            </Text>
          </Column>
        </ConfirmSheet>
      ) : null}
    </Animated.View>
  );
}

export default InviteCard;
