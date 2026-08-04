/**
 * The invite flow — four questions, then a code.
 *
 * This is the screen the whole RBAC model exists to serve, so it is built as a
 * conversation rather than a form: one question per step, each with its own
 * heading and its own reason for being asked, and a review that reads the
 * decision back before anything is created.
 *
 * The review step is the load-bearing one. Owners do not audit grant lists —
 * they read one sentence and decide — so the summary says in plain words both
 * what the person *will* be able to do and what stays with the owner. Getting
 * that sentence right is worth more than any number of checkboxes above it.
 *
 * Steps move with the direction of travel (forward slides in from the right,
 * Back from the left), which is the cheapest way to make a multi-screen flow
 * feel like one surface. Under reduced motion the same choreography plays as a
 * cross-fade.
 *
 * Nothing is written until "Create the invite". The generated code is then the
 * whole screen — QR, code, share sheet — because at that moment the owner has
 * exactly one job left, which is getting it to another human.
 */

import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  SlideInLeft,
  SlideInRight,
  SlideOutLeft,
  SlideOutRight,
} from 'react-native-reanimated';

import { useCreateInvite } from '@/data/queries/useCaregivers';
import type { Invite } from '@/data/types';
import { InviteQR } from '@/features/caregivers/InviteQR';
import { usePetScope } from '@/features/pets/PetScope';
import {
  endOfLocalDayISO,
  formatDay,
  fromDateOnly,
  startOfLocalDayISO,
  toDateOnly,
} from '@/lib/date';
import { buildInviteUrl, toHref } from '@/lib/deeplinks';
import haptics from '@/lib/haptics';
import { plural, possessive } from '@/lib/format';
import { copyInviteLink, isDismissed, shareInvite } from '@/lib/share';
import { CapabilityPicker } from '@/rbac/CapabilityPicker';
import { presetById, type Capability, type PresetId } from '@/rbac/permissions';
import { useNow } from '@/rbac/usePermission';
import { useTheme } from '@/theme';
import {
  Avatar,
  Button,
  Chip,
  Column,
  confetti,
  DateField,
  EmptyState,
  Icon,
  IconButton,
  Input,
  ProgressBar,
  Row,
  Screen,
  ScreenHeader,
  Surface,
  Text,
  toast,
  Touchable,
  type CalendarRange,
  type IconName,
} from '@/ui';
import { PermissionLocked } from '@/ui/illustrations';
import { Skeleton, SkeletonGroup, SkeletonText } from '@/ui/Skeleton';

/* -------------------------------------------------------------------- types */

type Step = 'who' | 'what' | 'when' | 'review';

type StepMeta = {
  /** Short label on the progress rail. */
  chip: string;
  title: string;
  blurb: string;
  icon: IconName;
};

type QuickRange = {
  id: string;
  label: string;
  icon: IconName;
  hint: string;
  range: CalendarRange;
};

/* ---------------------------------------------------------------- constants */

const STEPS: readonly Step[] = ['who', 'what', 'when', 'review'];

const STEP_META: Record<Step, StepMeta> = {
  who: {
    chip: 'Who',
    title: 'Who is this for?',
    blurb: 'Just so the invite has their name on it. Both of these are optional.',
    icon: 'person-outline',
  },
  what: {
    chip: 'Access',
    title: 'What can they do?',
    blurb: 'Start from a preset, then fine-tune anything you’d rather hold back.',
    icon: 'options-outline',
  },
  when: {
    chip: 'When',
    title: 'For how long?',
    blurb: 'Access switches itself on and off — you never have to remember to.',
    icon: 'calendar-outline',
  },
  review: {
    chip: 'Review',
    title: 'Does this look right?',
    blurb: 'One last read before the code exists.',
    icon: 'checkmark-circle-outline',
  },
};

/** How long the generated link stays usable, separately from the access window. */
const LINK_TTL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Plain-language verb for each grant, in the order they read best aloud. */
const ACTION_PHRASES: readonly (readonly [Capability, string])[] = [
  ['feeding.log', 'log meals'],
  ['medicine.log', 'log doses'],
  ['weight.log', 'record weight'],
  ['feeding.schedule.edit', 'change the feeding schedule'],
  ['vaccination.edit', 'update vaccinations'],
  ['vetvisit.edit', 'write up vet visits'],
  ['document.upload', 'add photos and documents'],
  ['appointment.create', 'book appointments'],
  ['appointment.edit', 'reschedule appointments'],
  ['community.post', 'post about them'],
];

/** Beyond three the sentence stops being one you can read in a breath. */
const MAX_PHRASES = 3;

/** Deliberately forgiving — this field is a note to self, not a login. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ------------------------------------------------------------------ helpers */

/** A calendar range is whole days; a membership window is instants. */
function rangeToWindow(range: CalendarRange): { startsAt: string | null; endsAt: string | null } {
  const start = range.start ? fromDateOnly(range.start) : null;
  const end = range.end ? fromDateOnly(range.end) : null;
  return {
    startsAt: start ? startOfLocalDayISO(start) : null,
    // The last day is inclusive, or a sitter loses access at breakfast.
    endsAt: end ? endOfLocalDayISO(end) : null,
  };
}

/** "Just today", "This weekend", "A week" — the three real-world shapes. */
function buildQuickRanges(now: Date): QuickRange[] {
  const today = toDateOnly(now);
  const day = now.getDay();
  // Sunday already *is* the weekend; any other day looks forward to Saturday.
  const toSaturday = day === 0 ? 0 : (6 - day) % 7;
  const saturday = new Date(now.getTime() + toSaturday * DAY_MS);
  const weekendEnd = day === 0 ? saturday : new Date(saturday.getTime() + DAY_MS);

  return [
    {
      id: 'today',
      label: 'Just today',
      icon: 'today-outline',
      hint: 'Access for the rest of today only.',
      range: { start: today, end: today },
    },
    {
      id: 'weekend',
      label: 'This weekend',
      icon: 'partly-sunny-outline',
      hint: 'Saturday and Sunday.',
      range: { start: toDateOnly(saturday), end: toDateOnly(weekendEnd) },
    },
    {
      id: 'week',
      label: 'A week',
      icon: 'calendar-number-outline',
      hint: 'Today plus the next six days.',
      range: { start: today, end: toDateOnly(new Date(now.getTime() + 6 * DAY_MS)) },
    },
  ];
}

function dayWord(date: Date | null, now: Date): string {
  if (!date) return 'today';
  return toDateOnly(date) === toDateOnly(now) ? 'today' : formatDay(date, now);
}

/** Sentence fragment: "from Fri 3 Oct to Sun 5 Oct", "with no end date". */
function windowPhrase(range: CalendarRange, now: Date): string {
  const start = range.start ? fromDateOnly(range.start) : null;
  const end = range.end ? fromDateOnly(range.end) : null;
  const startWord = dayWord(start, now);

  if (!end) return `from ${startWord}, with no end date`;
  const days = Math.max(1, Math.round((end.getTime() - (start ?? now).getTime()) / DAY_MS) + 1);
  if (days === 1) return startWord === 'today' ? 'for the rest of today' : `on ${startWord}`;
  return `from ${startWord} to ${dayWord(end, now)}`;
}

/** The same thing as a standalone label, for the review list. */
function windowLabel(range: CalendarRange, now: Date): string {
  if (!range.start && !range.end) return 'From today, no end date';
  const phrase = windowPhrase(range, now);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** Long-form reassurance under the date picker. */
function describeRange(range: CalendarRange, petName: string, now: Date): string {
  if (!range.start) {
    return `Pick the days you'll be away and ${petName} is covered for exactly that long — not a day more.`;
  }
  const start = fromDateOnly(range.start);
  if (!range.end) {
    return `Access starts ${dayWord(start, now)} and stays on until you turn it off.`;
  }
  const end = fromDateOnly(range.end);
  if (!start || !end) return `Pick the days you'll be away.`;
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1);
  return `${petName} is covered for ${plural(days, 'day')} — ${dayWord(start, now)} to ${dayWord(end, now)}.`;
}

function joinPhrases(list: readonly string[], conjunction: string): string {
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} ${conjunction} ${list[list.length - 1]}`;
}

/**
 * The sentence the whole flow exists for: exactly what this person will and
 * will not be able to do, in words an owner can act on.
 */
function reviewCopy(input: {
  grants: readonly Capability[];
  petName: string;
  personName: string | null;
  range: CalendarRange;
  now: Date;
}): { can: string; cannot: string } {
  const who = input.personName?.trim() || 'Whoever you send this to';
  const held = new Set(input.grants);
  const granted = ACTION_PHRASES.filter(([capability]) => held.has(capability)).map(([, p]) => p);
  const missing = ACTION_PHRASES.filter(([capability]) => !held.has(capability)).map(([, p]) => p);
  const when = windowPhrase(input.range, input.now);

  const shown = granted.slice(0, MAX_PHRASES);
  const extra = granted.length - shown.length;

  const can =
    granted.length === 0
      ? `${who} will be able to see ${possessive(input.petName)} profile, schedule and medicines ${when} — and won't be able to log or change a single thing.`
      : `${who} will be able to ${joinPhrases(shown, 'and')}${
          extra > 0 ? `, plus ${extra} more` : ''
        } for ${input.petName}, ${when}.`;

  const cannot =
    missing.length === 0
      ? `That's everything a sitter can ever hold. Editing the profile, inviting other sitters and deleting records still stay with you.`
      : `They won't be able to ${joinPhrases(missing.slice(0, 2), 'or')}. Editing ${possessive(
          input.petName,
        )} profile, inviting anyone else and deleting records always stay with you.`;

  return { can, cannot };
}

/* ---------------------------------------------------------------- component */

export default function InviteScreen() {
  const t = useTheme();
  const router = useRouter();
  const scope = usePetScope();
  const now = useNow();

  const petId = scope.petId;
  const petName = scope.pet?.name ?? 'your pet';

  const createInvite = useCreateInvite(petId);

  const [step, setStep] = useState<Step>('who');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [grants, setGrants] = useState<Capability[]>(() => [...presetById('dailyCare').grants]);
  const [presetId, setPresetId] = useState<PresetId>('dailyCare');
  const [range, setRange] = useState<CalendarRange>({ start: null, end: null });
  const [invite, setInvite] = useState<Invite | null>(null);

  const stepIndex = STEPS.indexOf(step);
  const meta = STEP_META[step];
  const presets = useMemo(() => buildQuickRanges(now), [now]);
  const personName = name.trim() || null;
  const isLast = step === 'review';

  const emailError =
    emailTouched && email.trim().length > 0 && !EMAIL_SHAPE.test(email.trim())
      ? 'That address looks like it has a typo.'
      : undefined;

  const summary = useMemo(
    () => reviewCopy({ grants, petName, personName, range, now }),
    [grants, now, personName, petName, range],
  );

  /* ---- navigation ------------------------------------------------------- */

  const goTo = useCallback((next: Step, way: 1 | -1) => {
    setDirection(way);
    setStep(next);
    haptics.tap();
  }, []);

  const goNext = useCallback(() => {
    const next = STEPS[stepIndex + 1];
    if (next !== undefined) goTo(next, 1);
  }, [goTo, stepIndex]);

  const goBack = useCallback(() => {
    const previous = STEPS[stepIndex - 1];
    if (previous !== undefined) goTo(previous, -1);
    else router.back();
  }, [goTo, router, stepIndex]);

  const create = useCallback(() => {
    const window = rangeToWindow(range);
    createInvite.mutate(
      {
        presetId,
        grants,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        inviteeName: personName,
        inviteeEmail: email.trim() || null,
        linkTtlDays: LINK_TTL_DAYS,
        maxUses: 1,
      },
      {
        onSuccess: (created) => {
          setInvite(created);
          haptics.celebrate();
          // Pure decoration — the haptic and the heading already carry the news.
          if (!t.reduceMotion) confetti.fire();
        },
      },
    );
  }, [createInvite, email, grants, personName, presetId, range, t.reduceMotion]);

  const shareIt = useCallback(() => {
    if (!invite) return;
    haptics.tap();
    void (async () => {
      const outcome = await shareInvite({
        petName,
        code: invite.code,
        inviteeName: invite.inviteeName,
        accessBlurb: presetById(invite.presetId).caregiverBlurb,
      });
      if (!outcome.ok && !isDismissed(outcome)) toast.error(outcome.message);
    })();
  }, [invite, petName]);

  const copyLink = useCallback(() => {
    if (!invite) return;
    void (async () => {
      const outcome = await copyInviteLink({ code: invite.code, preferWebLink: true });
      if (outcome.ok) {
        toast.success('Link copied', { description: 'Paste it into a message and you’re done.' });
      } else {
        toast.error(outcome.message);
      }
    })();
  }, [invite]);

  const closeButton = (
    <IconButton
      icon="close"
      accessibilityLabel="Close"
      accessibilityHint="Leaves the invite flow."
      variant="tonal"
      tone="neutral"
      onPress={() => router.back()}
    />
  );

  /* ---- resolving the pet ------------------------------------------------ */

  // The flow's copy is built out of the pet's name, so it waits rather than
  // opening with "your pet" and swapping it under the reader a beat later.
  if (scope.isLoading && !scope.pet) {
    return (
      <Screen
        header={<ScreenHeader title="Invite a sitter" large={false} leading={closeButton} />}
        scroll
      >
        <SkeletonGroup label="Opening the invite flow" gap="lg">
          <Skeleton w="100%" h={t.spacing.xxs} r="pill" />
          <Skeleton w="64%" h={t.type.display.fontSize} r="xs" />
          <SkeletonText lines={2} variant="callout" lastLineWidth={0.5} dim />
          <Skeleton w="100%" h={t.spacing.giant} r="lg" />
          <Skeleton w="100%" h={t.spacing.giant} r="lg" />
        </SkeletonGroup>
      </Screen>
    );
  }

  /* ---- gate ------------------------------------------------------------- */

  // Inviting is owner-only forever, so a caregiver who reaches this route gets
  // an explanation rather than a form they can never submit.
  if (!scope.isLoading && !scope.isOwner) {
    return (
      <Screen
        header={<ScreenHeader title="Invite a sitter" large={false} leading={closeButton} />}
        center
      >
        <EmptyState
          tone="warning"
          illustration={<PermissionLocked size={t.spacing.colossal * 3} />}
          headline="Only the owner can invite"
          body={`Sharing ${petName} stays with whoever owns their record — it's the one thing a sitter can never be granted. If someone else needs access, ask the owner to send them a code.`}
          action={{ label: 'Close', icon: 'arrow-back', onPress: () => router.back() }}
        />
      </Screen>
    );
  }

  /* ---- the generated invite --------------------------------------------- */

  if (invite) {
    return (
      <Screen
        header={<ScreenHeader title="Invite ready" large={false} leading={closeButton} />}
        scroll
        contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.xl }}
        footer={
          <Row gap="sm">
            <Button
              label="See who can help"
              onPress={() => router.replace(toHref(`/pet/${petId}/caregivers`))}
              variant="ghost"
              size="lg"
            />
            <View style={{ flex: 1 }} />
            <Button
              label="Done"
              onPress={() => router.back()}
              variant="secondary"
              size="lg"
              accessibilityHint="Closes the invite flow."
            />
          </Row>
        }
      >
        <Animated.View entering={FadeIn.duration(t.motion.duration.slow)}>
          <Column gap="xs" style={{ paddingTop: t.spacing.sm }}>
            <Text variant="display" accessibilityRole="header">
              {personName ? `${personName} is all set` : `${petName} has a sitter code`}
            </Text>
            <Text variant="callout" color="textSecondary">
              Send them the code or let them scan this. Their access begins the moment they accept.
            </Text>
          </Column>
        </Animated.View>

        <InviteQR
          value={buildInviteUrl(invite.code)}
          code={invite.code}
          petName={petName}
          caption={`This link works for ${LINK_TTL_DAYS} days`}
          actions={
            <Row gap="sm" wrap justify="center">
              <Button
                label="Share"
                onPress={shareIt}
                leftIcon="paper-plane-outline"
                size="md"
                haptic="commit"
                accessibilityHint="Opens the share sheet with a written invite."
              />
              <Button
                label="Copy link"
                onPress={copyLink}
                variant="secondary"
                size="md"
                leftIcon="link-outline"
              />
            </Row>
          }
        />

        <Surface
          variant="surface"
          elevation={0}
          radius="xl"
          padding="base"
          border
          style={{ gap: t.spacing.sm }}
        >
          <Row gap="sm" align="start">
            <Icon name="sparkles-outline" size="sm" color="primaryText" />
            <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
              {summary.can}
            </Text>
          </Row>
          <Row gap="sm" align="start">
            <Icon name="lock-closed-outline" size="sm" color="textTertiary" />
            <Text variant="footnote" color="textTertiary" style={{ flex: 1 }}>
              {summary.cannot}
            </Text>
          </Row>
        </Surface>
      </Screen>
    );
  }

  /* ---- the flow --------------------------------------------------------- */

  const entering = t.reduceMotion
    ? FadeIn.duration(t.motion.duration.base)
    : (direction === 1 ? SlideInRight : SlideInLeft)
        .duration(t.motion.duration.slow)
        .easing(t.motion.easing.decelerate);

  const exiting = t.reduceMotion
    ? FadeOut.duration(t.motion.duration.fast)
    : (direction === 1 ? SlideOutLeft : SlideOutRight)
        .duration(t.motion.duration.fast)
        .easing(t.motion.easing.accelerate);

  const nextChip = STEP_META[STEPS[stepIndex + 1] ?? 'review'].chip.toLowerCase();

  return (
    <Screen
      header={<ScreenHeader title="Invite a sitter" large={false} leading={closeButton} />}
      scroll
      contentContainerStyle={{ gap: t.spacing.lg, paddingBottom: t.spacing.xl }}
      footer={
        <Row gap="sm">
          <Button
            label={stepIndex === 0 ? 'Cancel' : 'Back'}
            onPress={goBack}
            variant="ghost"
            size="lg"
            leftIcon={stepIndex === 0 ? undefined : 'chevron-back'}
            disabled={createInvite.isPending}
          />
          <View style={{ flex: 1 }} />
          <Button
            label={isLast ? 'Create the invite' : 'Continue'}
            onPress={isLast ? create : goNext}
            variant="primary"
            size="lg"
            hero={isLast}
            rightIcon={isLast ? undefined : 'chevron-forward'}
            loading={createInvite.isPending}
            haptic={isLast ? 'commit' : 'tap'}
            accessibilityHint={
              isLast
                ? `Creates a code that lets ${personName ?? 'someone'} help with ${petName}.`
                : `Goes to ${nextChip}.`
            }
          />
        </Row>
      }
    >
      {/* -------------------------------------------------------- progress */}
      <Column gap="sm" style={{ paddingTop: t.spacing.xs }}>
        <ProgressBar
          segments={STEPS.map((_, index) => ({ value: index <= stepIndex ? 1 : 0 }))}
          tone="primary"
          size="sm"
          accessibilityLabel={`Step ${stepIndex + 1} of ${STEPS.length}: ${meta.chip}`}
        />
        <Row gap="xs">
          <Icon name={meta.icon} size="xs" color="primaryText" />
          <Text variant="overline" color="textTertiary">
            {`Step ${stepIndex + 1} of ${STEPS.length} · ${meta.chip}`}
          </Text>
        </Row>
      </Column>

      {/* ------------------------------------------------------------ step */}
      <Animated.View key={step} entering={entering} exiting={exiting} style={{ gap: t.spacing.lg }}>
        <Column gap="xs">
          <Text variant="display" accessibilityRole="header">
            {meta.title}
          </Text>
          <Text variant="callout" color="textSecondary">
            {meta.blurb}
          </Text>
        </Column>

        {step === 'who' ? (
          <Column gap="base">
            <Input
              label="Their name"
              value={name}
              onChangeText={setName}
              placeholder="Sam"
              autoCapitalize="words"
              autoComplete="name"
              leadingIcon="person-outline"
              clearable
              onClear={() => setName('')}
              helper={`Shown on the invite and in ${possessive(petName)} activity log.`}
              returnKeyType="next"
            />
            <Input
              label="Their email"
              value={email}
              onChangeText={setEmail}
              onBlur={() => setEmailTouched(true)}
              placeholder="sam@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              leadingIcon="mail-outline"
              error={emailError}
              helper="Only so you remember who it went to — Petal doesn’t email them."
              returnKeyType="done"
            />

            <Row
              gap="sm"
              align="start"
              style={{
                padding: t.spacing.base,
                borderRadius: t.radius.lg,
                backgroundColor: t.color.surfaceAlt,
              }}
            >
              <Icon name="information-circle-outline" size="sm" color="textSecondary" />
              <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
                Skip both if you like. The code works for whoever you hand it to, and you can turn it
                off at any point.
              </Text>
            </Row>
          </Column>
        ) : null}

        {step === 'what' ? (
          <CapabilityPicker
            value={grants}
            onChange={(next, preset) => {
              setGrants(next);
              setPresetId(preset);
            }}
            petName={petName}
            personName={personName}
          />
        ) : null}

        {step === 'when' ? (
          <Column gap="base">
            <Row gap="sm" wrap>
              {presets.map((preset) => (
                <Chip
                  key={preset.id}
                  label={preset.label}
                  icon={preset.icon}
                  selected={range.start === preset.range.start && range.end === preset.range.end}
                  onPress={() => setRange(preset.range)}
                  accessibilityHint={preset.hint}
                />
              ))}
              <Chip
                label="No end date"
                icon="infinite"
                selected={range.start !== null && range.end === null}
                onPress={() => setRange({ start: range.start ?? toDateOnly(now), end: null })}
                accessibilityHint="Access carries on until you turn it off."
              />
            </Row>

            <DateField
              mode="range"
              range={range}
              onRangeChange={setRange}
              label="Sitting dates"
              placeholder="Pick the days"
              helper="The last day is included — access ends at midnight."
              clearable
            />

            <Row
              gap="sm"
              align="start"
              style={{
                padding: t.spacing.base,
                borderRadius: t.radius.lg,
                backgroundColor: t.color.primarySoft,
              }}
            >
              <Icon name="calendar-outline" size="sm" color="onPrimarySoft" />
              <Text variant="callout" color="onPrimarySoft" style={{ flex: 1 }}>
                {describeRange(range, petName, now)}
              </Text>
            </Row>
          </Column>
        ) : null}

        {step === 'review' ? (
          <Column gap="base">
            <Surface
              variant="surface"
              elevation={1}
              radius="xxl"
              padding="base"
              style={{ gap: t.spacing.base }}
            >
              <Row gap="md">
                <Avatar name={personName ?? petName} size="lg" />
                <Column flex gap="hair">
                  <Text variant="title3" numberOfLines={1}>
                    {personName ?? 'Anyone with the code'}
                  </Text>
                  <Text variant="caption" color="textTertiary" numberOfLines={1}>
                    {email.trim() || `Sitting for ${petName}`}
                  </Text>
                </Column>
              </Row>

              <Row
                gap="sm"
                align="start"
                style={{
                  padding: t.spacing.base,
                  borderRadius: t.radius.lg,
                  backgroundColor: t.color.primarySoft,
                }}
              >
                <Icon name="checkmark-circle" size="md" color="onPrimarySoft" />
                <Text variant="callout" color="onPrimarySoft" style={{ flex: 1 }}>
                  {summary.can}
                </Text>
              </Row>

              <Row gap="sm" align="start">
                <Icon name="lock-closed-outline" size="sm" color="textTertiary" />
                <Text variant="footnote" color="textSecondary" style={{ flex: 1 }}>
                  {summary.cannot}
                </Text>
              </Row>
            </Surface>

            <Surface
              variant="surfaceAlt"
              elevation={0}
              radius="xl"
              paddingX="base"
              style={{ paddingVertical: t.spacing.xs }}
            >
              <ReviewLine
                icon="options-outline"
                label="Access"
                value={presetById(presetId).label}
                changeHint="Goes back to the access step."
                onPress={() => goTo('what', -1)}
              />
              <ReviewLine
                icon="calendar-outline"
                label="Dates"
                value={windowLabel(range, now)}
                changeHint="Goes back to the dates step."
                onPress={() => goTo('when', -1)}
              />
              <ReviewLine
                icon="link-outline"
                label="Link"
                value={`Expires ${LINK_TTL_DAYS} days after you create it`}
              />
            </Surface>
          </Column>
        ) : null}
      </Animated.View>
    </Screen>
  );
}

/* ------------------------------------------------------------ review lines */

type ReviewLineProps = {
  icon: IconName;
  label: string;
  value: string;
  /** Jumps back to the step that owns this answer. */
  onPress?: () => void;
  changeHint?: string;
};

function ReviewLine({ icon, label, value, onPress, changeHint }: ReviewLineProps) {
  const t = useTheme();

  const body = (
    <Row gap="md" align="center" style={{ minHeight: t.minTarget, paddingVertical: t.spacing.xs }}>
      <Icon name={icon} size="sm" color="textTertiary" />
      <Text variant="footnote" color="textTertiary" style={{ width: t.spacing.huge }}>
        {label}
      </Text>
      <Text variant="subheadStrong" style={{ flex: 1 }} numberOfLines={2}>
        {value}
      </Text>
      {onPress ? <Icon name="pencil" size="xs" color="primaryText" /> : null}
    </Row>
  );

  if (!onPress) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={`${label}: ${value}`}>
        {body}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}. Change`}
      accessibilityHint={changeHint}
      haptic="tap"
      onPress={onPress}
      pressScale="large"
    >
      {body}
    </Touchable>
  );
}
