/**
 * Settings — Account.
 *
 * Two halves that deserve opposite treatments.
 *
 * The profile edit is deliberately frictionless: type, and a save bar rises when
 * there is something to save. Nothing auto-commits — a name that saves on every
 * keystroke means a half-typed name reaches every caregiver who is looking at
 * the activity feed right now.
 *
 * Deletion is deliberately slow, and it is the reason this file is long. The
 * rules it follows:
 *
 *   · **Never show a confirmation whose consequences you couldn't load.** If the
 *     pet list is still loading or failed, the sheet says so and the button
 *     stays off. Asking someone to confirm a deletion while being vague about
 *     what it deletes is the worst thing this screen could do.
 *   · **Name the actual animals.** "Buddy and Mochi go for good" lands; "your
 *     data will be removed" doesn't.
 *   · **Be precise about other people.** Caregivers lose access the instant it
 *     happens, and the pets you *sit for* are not yours to delete — they stay
 *     with their owner, untouched. Both facts are stated rather than implied.
 *   · **Enumerate, don't promise.** Every line describes something this screen
 *     actually performs: reminders cancelled, pets deleted, profile cleared,
 *     signed out. No claims are made about anything Petal can't carry out here.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';

import { useDeletePet, usePets } from '@/data/queries/usePets';
import { useRequestPasswordReset, useUpdateProfile } from '@/data/queries/useUsers';
import { SettingsGroup } from '@/features/settings/SettingsGroup';
import { SettingsRow } from '@/features/settings/SettingsRow';
import { logError } from '@/lib/errors';
import { joinWithAnd, pluralWord } from '@/lib/format';
import haptics from '@/lib/haptics';
import { cancelEverything } from '@/lib/notifications';
import { useCurrentUser, useSession } from '@/stores/session';
import { useTheme } from '@/theme';
import {
  Button,
  Column,
  ConfirmSheet,
  ErrorState,
  Icon,
  Input,
  PhotoPicker,
  Row,
  Screen,
  ScreenHeader,
  Sheet,
  SheetHeader,
  Skeleton,
  SkeletonGroup,
  Surface,
  Text,
  TextArea,
  toast,
  useSheet,
  type IconName,
} from '@/ui';

/* ---------------------------------------------------------------- constants */

const NAME_MAX = 40;
const BIO_MAX = 160;

/** Typed exactly, so a thumb can't slide past it. Matched case-insensitively. */
const CONFIRM_WORD = 'DELETE';

/* ---------------------------------------------------------------- component */

export default function AccountSettingsScreen() {
  const t = useTheme();
  const router = useRouter();

  const user = useCurrentUser();
  const signOut = useSession((s) => s.signOut);

  const petsQuery = usePets();
  const updateProfile = useUpdateProfile();
  const requestReset = useRequestPasswordReset();
  const deletePet = useDeletePet();

  const passwordSheet = useSheet();
  const deleteSheet = useSheet();

  const [name, setName] = useState(user?.displayName ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [photo, setPhoto] = useState<string | null>(user?.avatarUrl ?? null);
  const [touched, setTouched] = useState(false);
  const [confirmWord, setConfirmWord] = useState('');
  const [deleting, setDeleting] = useState(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* ---- derived ---------------------------------------------------------- */

  const trimmedName = name.trim();
  const trimmedBio = bio.trim();

  const nameProblem =
    touched && trimmedName.length === 0
      ? 'Your sitters need something to call you — even a first name is plenty.'
      : undefined;

  const dirty =
    user !== null &&
    (trimmedName !== user.displayName ||
      trimmedBio !== (user.bio ?? '') ||
      photo !== user.avatarUrl);

  const canSave = dirty && trimmedName.length > 0 && !updateProfile.isPending;

  const pets = useMemo(() => petsQuery.data ?? [], [petsQuery.data]);
  const owned = useMemo(
    () => pets.filter((pet) => pet.ownerId === user?.id),
    [pets, user?.id],
  );
  const sittingCount = pets.length - owned.length;

  const confirmed = confirmWord.trim().toUpperCase() === CONFIRM_WORD;
  const consequencesReady = petsQuery.isSuccess;

  /* ---- actions ---------------------------------------------------------- */

  const save = useCallback(() => {
    if (!canSave) return;
    updateProfile.mutate({
      displayName: trimmedName,
      bio: trimmedBio.length > 0 ? trimmedBio : null,
      avatarUrl: photo,
    });
    haptics.success();
    toast.success('Saved 🐾', { description: 'That’s what your sitters will see from now on.' });
  }, [canSave, photo, trimmedBio, trimmedName, updateProfile]);

  const discard = useCallback(() => {
    if (!user) return;
    haptics.tap();
    setName(user.displayName);
    setBio(user.bio ?? '');
    setPhoto(user.avatarUrl);
    setTouched(false);
  }, [user]);

  const sendReset = useCallback(() => {
    if (!user) return Promise.resolve();
    return requestReset
      .mutateAsync(user.email)
      .then(() => {
        haptics.success();
        toast.success('Link sent', {
          description: `If we know ${user.email}, a reset link is on its way. It expires in an hour.`,
        });
      })
      // The mutation raises its own error toast; swallowing here keeps the
      // sheet's promise from rejecting into nowhere.
      .catch(() => undefined);
  }, [requestReset, user]);

  const openDelete = useCallback(() => {
    setConfirmWord('');
    deleteSheet.open();
  }, [deleteSheet]);

  const runDelete = useCallback(async () => {
    if (!user || !confirmed || !consequencesReady || deleting) return;
    setDeleting(true);
    haptics.heavy();

    try {
      // Reminders first: a notification for a pet that no longer exists is the
      // one thing that could outlive this.
      await cancelEverything();

      for (const pet of owned) {
        await deletePet.mutateAsync(pet.id);
      }

      if (user.avatarUrl !== null || user.bio !== null) {
        await updateProfile.mutateAsync({ avatarUrl: null, bio: null });
      }

      deleteSheet.close();
      toast.info('That’s everything gone', {
        description: 'Your pets, their records and every queued reminder have been removed.',
      });
      await signOut();
    } catch (error) {
      // Both mutations raise their own toast; this only has to stop the flow
      // and leave the sheet open so nothing looks half-finished.
      logError('settings.deleteAccount', error);
      haptics.error();
    } finally {
      if (alive.current) setDeleting(false);
    }
  }, [
    confirmed,
    consequencesReady,
    deletePet,
    deleteSheet,
    deleting,
    owned,
    signOut,
    updateProfile,
    user,
  ]);

  /* ---- chrome ----------------------------------------------------------- */

  const enter = useCallback(
    (index: number) =>
      t.reduceMotion
        ? FadeIn.duration(t.motion.duration.base).delay(index * t.motion.stagger.tight)
        : FadeInDown.duration(t.motion.duration.slow)
            .delay(index * t.motion.stagger.base)
            .easing(t.motion.easing.decelerate),
    [t.motion, t.reduceMotion],
  );

  const header = <ScreenHeader title="Account" subtitle="Who you are to the people you share a pet with." />;

  if (!user) {
    return (
      <Screen header={header} center>
        <ErrorState
          title="You’re signed out"
          body="There’s no account to show. Sign back in and this page fills itself in."
          secondaryAction={{ label: 'Go back', onPress: () => router.back() }}
        />
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      scroll
      contentContainerStyle={{ gap: t.spacing.xl, paddingBottom: t.spacing.xxl }}
    >
      {/* ---- profile ----------------------------------------------------- */}

      <Animated.View entering={enter(0)}>
        <Surface variant="surface" elevation={1} radius="xxl" padding="lg">
          <Column gap="lg">
            <PhotoPicker
              value={photo}
              onChange={setPhoto}
              shape="circle"
              label="Your photo"
              placeholderText="Add a photo"
              helper="Optional. It only ever appears to people you share a pet with."
            />

            <Input
              label="Your name"
              value={name}
              onChangeText={setName}
              onBlur={() => setTouched(true)}
              error={nameProblem}
              leadingIcon="person-outline"
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              maxLength={NAME_MAX}
              showCounter={false}
              returnKeyType="done"
              testID="account-name"
            />

            <TextArea
              label="About you"
              value={bio}
              onChangeText={setBio}
              placeholder="Two rescue cats and a great many opinions about litter."
              maxLength={BIO_MAX}
              minRows={3}
              maxRows={6}
              helper="Shown under your name here and on anything you post. Your pets’ names are fine; your address isn’t."
              testID="account-bio"
            />
          </Column>
        </Surface>
      </Animated.View>

      {dirty ? (
        <Animated.View
          entering={
            t.reduceMotion
              ? FadeIn.duration(t.motion.duration.base)
              : FadeInDown.duration(t.motion.duration.base).easing(t.motion.easing.decelerate)
          }
          exiting={FadeOut.duration(t.motion.duration.fast)}
        >
          <Row gap="sm">
            <View style={{ flex: 1 }}>
              <Button
                label="Discard"
                variant="secondary"
                size="lg"
                fullWidth
                onPress={discard}
                disabled={updateProfile.isPending}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label="Save changes"
                variant="primary"
                size="lg"
                fullWidth
                hero
                haptic="none"
                loading={updateProfile.isPending}
                disabled={!canSave}
                onPress={save}
              />
            </View>
          </Row>
        </Animated.View>
      ) : null}

      {/* ---- sign-in ----------------------------------------------------- */}

      <Animated.View entering={enter(1)}>
        <SettingsGroup
          title="Signing in"
          icon="key-outline"
          animate={false}
          footer="Your email is how you sign in and how invites find you, so it isn’t something we can change from inside the app."
        >
          <SettingsRow
            icon="mail-outline"
            tone="neutral"
            title="Email"
            subtitle={user.email}
          />
          <SettingsRow
            icon="lock-open-outline"
            tone="info"
            title="Change your password"
            subtitle="We’ll email you a link that sets a new one"
            accessibilityHint="Asks you to confirm, then sends a reset email."
            onPress={() => passwordSheet.open()}
          />
        </SettingsGroup>
      </Animated.View>

      {/* ---- danger ------------------------------------------------------ */}

      <Animated.View entering={enter(2)}>
        <SettingsGroup
          title="Leaving"
          icon="warning-outline"
          animate={false}
          footer="If you only want a break, sign out instead — everything waits for you exactly as it is."
        >
          <SettingsRow
            icon="trash-outline"
            tone="danger"
            destructive
            title="Delete your account"
            subtitle="Removes your pets, their records and everything logged for them"
            accessibilityHint="Opens a confirmation you have to type into."
            onPress={openDelete}
          />
        </SettingsGroup>
      </Animated.View>

      {/* ---- sheets ------------------------------------------------------ */}

      <ConfirmSheet
        controller={passwordSheet}
        tone="primary"
        icon="key-outline"
        title="Send a password reset link?"
        body={`We’ll email ${user.email} a link that sets a new password. It expires in an hour, and you stay signed in here either way.`}
        confirmLabel="Send the link"
        cancelLabel="Not now"
        onConfirm={sendReset}
      />

      <Sheet
        controller={deleteSheet}
        size="tall"
        scrollable
        dismissible={!deleting}
        onDismiss={() => setConfirmWord('')}
        footer={
          <Column gap="sm">
            <Button
              label="Keep my account"
              variant="secondary"
              size="lg"
              fullWidth
              disabled={deleting}
              onPress={deleteSheet.close}
            />
            <Button
              label={owned.length > 0 ? 'Delete everything' : 'Delete my account'}
              variant="danger"
              size="lg"
              fullWidth
              haptic="none"
              loading={deleting}
              // Hard-disabled until the word is typed — the field above says so
              // plainly. The not-yet-loaded case keeps its voice instead, so a
              // tap explains why the button won't move.
              disabled={!confirmed}
              disabledReason={
                consequencesReady
                  ? undefined
                  : 'We’re still reading what this would delete — the button unlocks once we know.'
              }
              accessibilityHint="This cannot be undone."
              onPress={() => void runDelete()}
            />
          </Column>
        }
      >
        <SheetHeader
          title="Delete your account?"
          subtitle="There’s no undo and no export. Take what you need first."
          onClose={deleting ? undefined : deleteSheet.close}
        />

        {petsQuery.isPending ? (
          <SkeletonGroup label="Working out what this would delete" gap="md">
            <Skeleton w="90%" h={t.spacing.base} r="sm" />
            <Skeleton w="75%" h={t.spacing.base} r="sm" dim />
            <Skeleton w="82%" h={t.spacing.base} r="sm" dim />
          </SkeletonGroup>
        ) : petsQuery.isError ? (
          <ErrorState
            variant="compact"
            frame
            error={petsQuery.error}
            title="We can’t tell you what this would delete"
            body="And we won’t let you confirm until we can. Try again in a moment."
            onRetry={() => petsQuery.refetch()}
          />
        ) : (
          <Column gap="base">
            <Consequence
              icon="paw-outline"
              tone="danger"
              text={
                owned.length === 0
                  ? 'You don’t own any pets, so there are no records of theirs to remove.'
                  : `${joinWithAnd(
                      owned.map((pet) => pet.name),
                      'and',
                    )} — and every meal, dose, weight, vaccination, vet visit and document logged for ${
                      owned.length === 1 ? 'them' : 'each of them'
                    } — are deleted for good.`
              }
            />
            <Consequence
              icon="people-outline"
              tone="danger"
              text={
                owned.length === 0
                  ? 'Nobody is helping you with a pet, so nobody loses access.'
                  : 'Everyone you’ve invited to help loses access the moment this happens. They keep nothing — not the schedules, not the history they wrote.'
              }
            />
            {sittingCount > 0 ? (
              <Consequence
                icon="home-outline"
                tone="info"
                text={`The ${sittingCount} ${pluralWord(sittingCount, 'pet')} you sit for ${
                  sittingCount === 1 ? 'isn’t' : 'aren’t'
                } yours to delete. ${
                  sittingCount === 1 ? 'It stays' : 'They stay'
                } exactly as ${sittingCount === 1 ? 'it is' : 'they are'} with the owner — you simply drop off the list.`}
              />
            ) : null}
            <Consequence
              icon="notifications-off-outline"
              tone="warning"
              text="Every queued reminder is cancelled, so nothing arrives afterwards for a pet that isn’t there."
            />
            <Consequence
              icon="person-outline"
              tone="warning"
              text="Your photo and profile line are cleared, and you’re signed out on this phone."
            />

            <Input
              label={`Type ${CONFIRM_WORD} to confirm`}
              value={confirmWord}
              onChangeText={setConfirmWord}
              autoCapitalize="characters"
              autoCorrect={false}
              leadingIcon="create-outline"
              helper="Deliberately fiddly. This is the last step."
              disabled={deleting}
              returnKeyType="done"
              testID="account-delete-confirm"
            />
          </Column>
        )}
      </Sheet>
    </Screen>
  );
}

/* ------------------------------------------------------------ consequence */

type ConsequenceTone = 'danger' | 'warning' | 'info';

function Consequence({
  icon,
  tone,
  text,
}: {
  icon: IconName;
  tone: ConsequenceTone;
  text: string;
}) {
  const t = useTheme();
  const disc = t.spacing.xxl;

  const skin =
    tone === 'danger'
      ? { fill: t.color.dangerSoft, ink: t.color.onDangerSoft }
      : tone === 'warning'
        ? { fill: t.color.warningSoft, ink: t.color.onWarningSoft }
        : { fill: t.color.infoSoft, ink: t.color.onInfoSoft };

  return (
    <Row gap="md" align="start">
      <View
        style={{
          width: disc,
          height: disc,
          borderRadius: t.radius.pill,
          backgroundColor: skin.fill,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size="sm" color={skin.ink} />
      </View>
      <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
        {text}
      </Text>
    </Row>
  );
}
