/**
 * The deep-link accept screen — `petal://invite/BUDDY-4KQ2`.
 *
 * This route sits *outside* every guard in `app/_layout.tsx` on purpose. Someone
 * tapping an invite in a message may not have Petal installed, let alone be
 * signed in, and bouncing them to a login screen that has forgotten why they
 * came is how caregiver invites die. So the link always resolves to a real
 * screen: the pet, the owner, the exact access on offer and the dates it covers
 * — readable before anyone is asked for an email address.
 *
 * "Sign in to accept" therefore *pushes* rather than replaces. When auth
 * succeeds the `(auth)` branch unmounts and this screen is what's underneath,
 * still holding the code, ready to accept.
 *
 * Every way this can fail is a designed state rather than a thrown error:
 * unknown code, malformed code, expired link, revoked link, already used,
 * already a member, and "you own this pet already". A person holding a dead
 * invite needs to know which kind of dead it is, because only some of them are
 * worth texting the owner about.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { useAcceptInvite, useInvitePreview } from '@/data/queries/useCaregivers';
import { SPECIES_META, type Invite } from '@/data/types';
import { describePet } from '@/features/pets/PetCard';
import { formatDay, relativeTime } from '@/lib/date';
import { toHref } from '@/lib/deeplinks';
import { toUserMessage } from '@/lib/errors';
import { plural, possessive } from '@/lib/format';
import haptics from '@/lib/haptics';
import { normalizeInviteCode, parseInviteCode } from '@/lib/id';
import { presetById, type Capability } from '@/rbac/permissions';
import { useMemberships, useNow } from '@/rbac/usePermission';
import { useCurrentUser, useSessionStatus } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Avatar,
  Banner,
  Button,
  Column,
  confetti,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Row,
  Screen,
  ScreenHeader,
  Surface,
  Text,
  toast,
} from '@/ui';
import { ErrorNotFound, InviteScan, PermissionLocked } from '@/ui/illustrations';
import { Skeleton, SkeletonCircle, SkeletonGroup, SkeletonText } from '@/ui/Skeleton';

/* -------------------------------------------------------------------- types */

/** Every way this screen can end. Each one gets its own words. */
type Outcome =
  | 'ready'
  | 'needsAuth'
  | 'locked'
  | 'expired'
  | 'revoked'
  | 'used'
  | 'alreadyMember'
  | 'alreadyOwner';

/* ---------------------------------------------------------------- constants */

/** The doing-verbs worth naming on the offer card, most reassuring first. */
const OFFER_LABELS: readonly (readonly [Capability, string])[] = [
  ['feeding.log', 'Log meals'],
  ['medicine.log', 'Log doses'],
  ['weight.log', 'Record weight'],
  ['vaccination.edit', 'Update vaccinations'],
  ['vetvisit.edit', 'Write up vet visits'],
  ['feeding.schedule.edit', 'Change the feeding schedule'],
  ['community.post', 'Post about them'],
];

const MAX_OFFER_SHOWN = 5;

/* ------------------------------------------------------------------ helpers */

function outcomeFor(input: {
  invite: Invite;
  ownerId: string;
  viewerId: string | null;
  isMember: boolean;
  authed: boolean;
  locked: boolean;
  now: Date;
}): Outcome {
  if (input.viewerId && input.viewerId === input.ownerId) return 'alreadyOwner';
  if (input.isMember) return 'alreadyMember';
  if (input.invite.status === 'revoked') return 'revoked';
  if (input.invite.status === 'expired' || Date.parse(input.invite.expiresAt) <= input.now.getTime()) {
    return 'expired';
  }
  if (input.invite.status === 'accepted' || input.invite.uses >= input.invite.maxUses) return 'used';
  if (input.locked) return 'locked';
  if (!input.authed) return 'needsAuth';
  return 'ready';
}

/** The access window, said the way a person would say it. */
function describeWindow(invite: Invite, now: Date): string {
  if (!invite.startsAt && !invite.endsAt) return 'Starting now, with no end date';
  const from = invite.startsAt ? formatDay(invite.startsAt, now) : 'Today';
  if (!invite.endsAt) return `From ${from}, with no end date`;
  return `${from} → ${formatDay(invite.endsAt, now)}`;
}

/* ---------------------------------------------------------------- component */

export default function AcceptInviteScreen() {
  const t = useTheme();
  const router = useRouter();
  const now = useNow();

  const params = useLocalSearchParams<{ code?: string }>();
  const raw = params.code ?? '';
  const parsed = parseInviteCode(raw);
  const code = normalizeInviteCode(raw);

  const preview = useInvitePreview(parsed.valid ? code : null);
  const accept = useAcceptInvite();

  const status = useSessionStatus();
  const viewer = useCurrentUser();
  const memberships = useMemberships();

  const data = preview.data ?? null;
  const invite = data?.invite ?? null;
  const pet = data?.pet ?? null;
  const owner = data?.owner ?? null;

  const existing = useMemo(
    () => (pet ? (memberships.find((row) => row.petId === pet.id) ?? null) : null),
    [memberships, pet],
  );

  const offers = useMemo(() => {
    if (!invite) return [];
    const held = new Set<Capability>(invite.grants);
    return OFFER_LABELS.filter(([capability]) => held.has(capability)).map(([, label]) => label);
  }, [invite]);

  const outcome: Outcome | null =
    invite && pet
      ? outcomeFor({
          invite,
          ownerId: pet.ownerId,
          viewerId: viewer?.id ?? null,
          isMember: existing !== null && existing.status === 'active',
          authed: status === 'authenticated',
          locked: status === 'locked',
          now,
        })
      : null;

  const openPet = useCallback(() => {
    if (!pet) return;
    router.replace(toHref(`/pet/${pet.id}`));
  }, [pet, router]);

  const onAccept = useCallback(() => {
    if (!invite || !pet) return;
    accept.mutate(invite.code, {
      onSuccess: () => {
        haptics.celebrate();
        if (!t.reduceMotion) confetti.fire();
        toast.success(`You're helping with ${pet.name} 🐾`, {
          description: 'Everything you log lands in the owner’s activity feed.',
        });
        router.replace(toHref(`/pet/${pet.id}`));
      },
    });
  }, [accept, invite, pet, router, t.reduceMotion]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(toHref('/'));
  }, [router]);

  const header = (
    <ScreenHeader
      title="Invite"
      large={false}
      leading={
        <IconButton
          icon="close"
          accessibilityLabel="Close"
          accessibilityHint="Leaves this invite without accepting."
          variant="tonal"
          tone="neutral"
          onPress={leave}
        />
      }
    />
  );

  /* ---- a code that isn't one -------------------------------------------- */

  if (!parsed.valid) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<ErrorNotFound size={t.spacing.colossal * 3} />}
          headline="That link looks incomplete"
          body="Petal codes look like BUDDY-4KQ2. It may have been cut short on the way — ask whoever sent it to share the whole thing again."
          action={{ label: 'Close', icon: 'arrow-back', onPress: leave }}
        />
      </Screen>
    );
  }

  /* ---- loading ---------------------------------------------------------- */

  if (preview.isPending) {
    return (
      <Screen header={header} scroll>
        <SkeletonGroup label="Opening this invite" gap="lg" style={{ alignItems: 'center' }}>
          <SkeletonCircle size={t.spacing.colossal + t.spacing.xxl} />
          <Skeleton w="56%" h={t.type.hero.fontSize} r="xs" />
          <Skeleton w="38%" h={t.type.footnote.fontSize} r="xs" dim />
          <View style={{ width: '100%', paddingTop: t.spacing.lg }}>
            <SkeletonText lines={3} variant="callout" lastLineWidth={0.6} />
          </View>
        </SkeletonGroup>
      </Screen>
    );
  }

  /* ---- couldn't reach the server ---------------------------------------- */

  if (preview.isError) {
    return (
      <Screen header={header} center>
        <ErrorState
          error={preview.error}
          title="We couldn’t open this invite"
          body="The code is probably fine — we just couldn’t look it up. Give it another go."
          onRetry={() => preview.refetch()}
          secondaryAction={{ label: 'Close', icon: 'arrow-back', onPress: leave }}
        />
      </Screen>
    );
  }

  /* ---- no such code ----------------------------------------------------- */

  if (!invite || !pet || !owner || !outcome) {
    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<ErrorNotFound size={t.spacing.colossal * 3} />}
          headline="We don’t know that code"
          body={`${code} isn't an invite we recognise. Codes are case-insensitive but every character counts — worth checking for a stray letter.`}
          action={{ label: 'Close', icon: 'arrow-back', onPress: leave }}
        />
      </Screen>
    );
  }

  /* ---- already sorted --------------------------------------------------- */

  if (outcome === 'alreadyOwner' || outcome === 'alreadyMember') {
    const isOwner = outcome === 'alreadyOwner';
    return (
      <Screen header={header} center>
        <EmptyState
          tone="primary"
          illustration={
            <Avatar
              uri={pet.photoUrl}
              name={pet.name}
              species={pet.species}
              size="xxl"
              ring
            />
          }
          headline={isOwner ? `${pet.name} is already yours` : `You already help with ${pet.name}`}
          body={
            isOwner
              ? `No invite needed — you own ${possessive(pet.name)} record. If you meant to send this to someone else, share the code rather than opening it.`
              : `Your access is already set up. Open ${possessive(pet.name)} profile to see what's due today.`
          }
          action={{
            label: `Open ${pet.name}`,
            icon: 'paw-outline',
            onPress: openPet,
          }}
        />
      </Screen>
    );
  }

  /* ---- dead links ------------------------------------------------------- */

  if (outcome === 'expired' || outcome === 'revoked' || outcome === 'used') {
    const copy = {
      expired: {
        headline: 'This link has expired',
        body: `Invite links only last a few days for safety. ${owner.displayName} can send a fresh one in about ten seconds.`,
      },
      revoked: {
        headline: `${owner.displayName} turned this one off`,
        body: 'The code was switched off before it was used. If you’re still helping out, ask for a new one.',
      },
      used: {
        headline: 'This code has already been used',
        body: `Each invite is good for one person. If it wasn’t you, let ${owner.displayName} know so they can check who joined.`,
      },
    }[outcome];

    return (
      <Screen header={header} center>
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline={copy.headline}
          body={copy.body}
          footer={
            <Row gap="xs">
              <Avatar uri={pet.photoUrl} name={pet.name} species={pet.species} size="xs" />
              <Text variant="caption" color="textTertiary">
                {`Invite for ${pet.name} · ${code}`}
              </Text>
            </Row>
          }
          action={{ label: 'Close', icon: 'arrow-back', onPress: leave }}
        />
      </Screen>
    );
  }

  /* ---- the offer -------------------------------------------------------- */

  const preset = presetById(invite.presetId);
  const identity = t.speciesColor(pet.species);
  const meta = SPECIES_META[pet.species];
  const needsAuth = outcome === 'needsAuth' || outcome === 'locked';

  const enter = (index: number) =>
    t.reduceMotion
      ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
      : FadeInDown.duration(t.motion.duration.slow)
          .delay(index * t.motion.stagger.base)
          .easing(t.motion.easing.decelerate);

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.xl }}
      footer={
        <Column gap="sm">
          {accept.isError ? (
            <Banner
              tone="danger"
              title="That didn’t go through"
              message={toUserMessage(accept.error).body}
              emphasis="quiet"
            />
          ) : null}

          <Button
            label={
              needsAuth
                ? outcome === 'locked'
                  ? 'Unlock to accept'
                  : 'Sign in to accept'
                : `Accept and help with ${pet.name}`
            }
            onPress={
              needsAuth
                ? () => router.push(toHref(outcome === 'locked' ? '/lock' : '/sign-in'))
                : onAccept
            }
            size="lg"
            fullWidth
            hero
            haptic="commit"
            loading={accept.isPending}
            leftIcon={needsAuth ? 'log-in-outline' : 'checkmark-circle-outline'}
            accessibilityHint={
              needsAuth
                ? 'You’ll come straight back here afterwards.'
                : `Gives you ${preset.label.toLowerCase()} access to ${pet.name}.`
            }
          />

          <Button
            label={needsAuth ? 'Create an account' : 'Not right now'}
            onPress={needsAuth ? () => router.push(toHref('/sign-up')) : leave}
            variant="ghost"
            size="md"
            fullWidth
          />
        </Column>
      }
    >
      {/* ------------------------------------------------------------- hero */}
      <Animated.View entering={enter(0)}>
        <Column align="center" gap="md" style={{ paddingTop: t.spacing.base }}>
          <Avatar
            uri={pet.photoUrl}
            name={pet.name}
            species={pet.species}
            size="xxl"
            ring
            live={!needsAuth}
          />

          <Column align="center" gap="xxs">
            <Text variant="caption" color="textTertiary" align="center">
              {`${owner.displayName} would like your help with`}
            </Text>
            <Text variant="hero" align="center" accessibilityRole="header" numberOfLines={2}>
              {pet.name}
            </Text>
            <Row gap="xs">
              <Text variant="callout">{meta.emoji}</Text>
              <Text variant="callout" color="textSecondary" numberOfLines={1}>
                {describePet(pet, now)}
              </Text>
            </Row>
          </Column>
        </Column>
      </Animated.View>

      {/* ------------------------------------------------------------ owner */}
      <Animated.View entering={enter(1)}>
        <Surface
          variant="surface"
          elevation={1}
          radius="xxl"
          padding="base"
          style={{ gap: t.spacing.md }}
        >
          <Row gap="md">
            <Avatar uri={owner.avatarUrl} name={owner.displayName} size="md" />
            <Column flex gap="hair">
              <Text variant="bodyStrong" numberOfLines={1}>
                {owner.displayName}
              </Text>
              <Text variant="caption" color="textTertiary" numberOfLines={2}>
                {owner.bio?.trim() || `Looks after ${pet.name}`}
              </Text>
            </Column>
            <View
              style={{
                paddingVertical: t.spacing.xxs,
                paddingHorizontal: t.spacing.sm,
                borderRadius: t.radius.pill,
                backgroundColor: identity.tint,
              }}
            >
              <Text variant="caption" style={{ color: identity.base }}>
                Owner
              </Text>
            </View>
          </Row>

          {invite.inviteeName?.trim() ? (
            <Row gap="xs">
              <Icon name="pricetag-outline" size="xs" color="textTertiary" />
              <Text variant="caption" color="textTertiary">
                {`Addressed to ${invite.inviteeName.trim()}`}
              </Text>
            </Row>
          ) : null}
        </Surface>
      </Animated.View>

      {/* ------------------------------------------------------------ offer */}
      <Animated.View entering={enter(2)}>
        <Surface
          variant="surface"
          elevation={1}
          radius="xxl"
          padding="base"
          style={{ gap: t.spacing.base }}
        >
          <Row gap="sm">
            <Icon name="key-outline" size="sm" color="primaryText" />
            <Text variant="overline" color="textTertiary">
              What you’ll be able to do
            </Text>
          </Row>

          <Text variant="callout" color="textSecondary">
            {preset.caregiverBlurb}
          </Text>

          <Column gap="xs">
            {offers.length === 0 ? (
              <Row gap="sm">
                <Icon name="eye-outline" size="sm" color="textSecondary" />
                <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
                  {`See ${possessive(pet.name)} profile, schedule and medicines — logging stays off.`}
                </Text>
              </Row>
            ) : (
              offers.slice(0, MAX_OFFER_SHOWN).map((label) => (
                <Row key={label} gap="sm">
                  <Icon name="checkmark-circle" size="sm" color="primaryText" />
                  <Text variant="footnote" style={{ flex: 1 }}>
                    {label}
                  </Text>
                </Row>
              ))
            )}
            {offers.length > MAX_OFFER_SHOWN ? (
              <Text variant="caption" color="textTertiary">
                {`+ ${plural(offers.length - MAX_OFFER_SHOWN, 'more permission')}`}
              </Text>
            ) : null}
          </Column>

          <Row
            gap="sm"
            align="start"
            style={{
              padding: t.spacing.md,
              borderRadius: t.radius.lg,
              backgroundColor: t.color.surfaceAlt,
            }}
          >
            <Icon name="lock-closed-outline" size="sm" color="textTertiary" />
            <Text variant="caption" color="textSecondary" style={{ flex: 1 }}>
              {`Editing ${possessive(pet.name)} profile, inviting anyone else and deleting records stay with ${owner.displayName}.`}
            </Text>
          </Row>
        </Surface>
      </Animated.View>

      {/* ------------------------------------------------------------ dates */}
      <Animated.View entering={enter(3)}>
        <Surface
          variant="surfaceAlt"
          elevation={0}
          radius="xxl"
          padding="base"
          style={{ gap: t.spacing.sm }}
        >
          <Row gap="sm">
            <Icon name="calendar-outline" size="sm" color="accentText" />
            <Column flex gap="hair">
              <Text variant="subheadStrong">{describeWindow(invite, now)}</Text>
              <Text variant="caption" color="textTertiary">
                Access switches itself off at the end — nothing to remember.
              </Text>
            </Column>
          </Row>

          <Row gap="xs">
            <Icon name="time-outline" size="xs" color="textTertiary" />
            <Text variant="caption" color="textTertiary">
              {`This link itself expires ${relativeTime(invite.expiresAt, now)}`}
            </Text>
          </Row>
        </Surface>
      </Animated.View>

      {/* --------------------------------------------------- signed-out note */}
      {needsAuth ? (
        <Animated.View entering={enter(4)}>
          <Row
            gap="md"
            align="start"
            style={{
              padding: t.spacing.base,
              borderRadius: t.radius.xl,
              backgroundColor: t.color.primarySoft,
              borderWidth: t.borderWidth.hairline,
              borderColor: t.color.primarySoftBorder,
            }}
          >
            <InviteScan size={t.spacing.giant} />
            <Column flex gap="hair">
              <Text variant="subheadStrong" color="onPrimarySoft">
                {outcome === 'locked' ? 'Unlock Petal first' : 'You’ll need a Petal account'}
              </Text>
              <Text variant="caption" color="onPrimarySoft">
                {outcome === 'locked'
                  ? `Unlock and we'll bring you straight back to ${possessive(pet.name)} invite.`
                  : `It takes a moment, and we'll bring you straight back here to finish. The code is held for you.`}
              </Text>
            </Column>
          </Row>
        </Animated.View>
      ) : null}
    </Screen>
  );
}
