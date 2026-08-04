/**
 * Petal — PasswordField.
 *
 * `Input` already owns the frame, the floating label, the reveal toggle and the
 * shake-on-error, so what lives here is only the part a password needs: a live
 * strength meter that tells the truth.
 *
 * Two opinions in the scoring:
 *
 *   · **Length beats punctuation.** A sixteen-character phrase scores full marks
 *     without a single symbol, because it genuinely is stronger than `P@ss1!`.
 *     Composition rules that demand a symbol mostly produce `Password1!`.
 *   · **The hint is the point, not the score.** Four bars tell you where you
 *     stand; the line under them tells you what to type next. "Weak" on its own
 *     is a scold.
 *
 * The meter only exists once there's something to measure — it grows in on the
 * first keystroke and collapses when the field is emptied, so a resting sign-up
 * form isn't carrying a row of grey stubs.
 */

import React, { useEffect, useMemo, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';

import { useTheme, type Theme } from '@/theme';
import { Input, ProgressBar, Row, Text, type InputProps } from '@/ui';

/* -------------------------------------------------------------------- types */

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4;
export type PasswordStrengthTone = 'danger' | 'warning' | 'success';

export type PasswordStrength = {
  /** 0 only when the field is empty. */
  score: PasswordStrengthScore;
  /** One word for the meter — "Weak", "Strong". */
  label: string;
  /** The next thing to type. Always actionable, never a scold. */
  hint: string;
  tone: PasswordStrengthTone;
};

export type PasswordFieldProps = Omit<
  InputProps,
  'secureTextEntry' | 'showRevealToggle' | 'value' | 'onChangeText' | 'style'
> & {
  value: string;
  onChangeText: (next: string) => void;
  /** The live meter. Off for sign-in, where scoring an old password is noise. */
  meter?: boolean;
  /** Fires whenever the score moves, so a form can gate its submit button. */
  onStrengthChange?: (strength: PasswordStrength) => void;
  /** Anything below the meter — a "forgot password" link, a caps-lock note. */
  footer?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/* ---------------------------------------------------------------- constants */

/** Matches the copy in `lib/errors.ts` for `weak-password`. */
export const MIN_PASSWORD_LENGTH = 8;

/** Bars in the meter. Four reads as a scale; five reads as a rating. */
const METER_CELLS = [0, 1, 2, 3] as const;

/** The length at which a plain phrase is strong on its own merits. */
const PHRASE_LENGTH = 16;
const COMFORTABLE_LENGTH = 12;

/* ------------------------------------------------------------------ scoring */

const LABELS: Record<Exclude<PasswordStrengthScore, 0>, string> = {
  1: 'Weak',
  2: 'Getting there',
  3: 'Strong',
  4: 'Excellent',
};

const TONES: Record<PasswordStrengthScore, PasswordStrengthTone> = {
  0: 'danger',
  1: 'danger',
  2: 'warning',
  3: 'success',
  4: 'success',
};

/**
 * Deterministic, offline, and cheap enough to run on every keystroke — no
 * dictionary, no network, nothing that could ever send a password anywhere.
 */
export function scorePassword(value: string): PasswordStrength {
  if (value.length === 0) {
    return {
      score: 0,
      label: '',
      hint: `${MIN_PASSWORD_LENGTH} characters or more.`,
      tone: 'danger',
    };
  }

  if (value.length < MIN_PASSWORD_LENGTH) {
    const short = MIN_PASSWORD_LENGTH - value.length;
    return {
      score: 1,
      label: LABELS[1],
      hint: `${short} more character${short === 1 ? '' : 's'} to go.`,
      tone: 'danger',
    };
  }

  const variety =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/\d/.test(value)) +
    Number(/[^A-Za-z0-9]/.test(value));

  const points =
    1 +
    Number(value.length >= COMFORTABLE_LENGTH) +
    Number(variety >= 2) +
    Number(variety >= 3) +
    Number(value.length >= PHRASE_LENGTH);

  const score = Math.min(4, points) as Exclude<PasswordStrengthScore, 0>;

  const hint =
    score >= 4
      ? 'Nobody is guessing that.'
      : score === 3
        ? 'That will keep the records safe.'
        : variety < 2
          ? 'A capital letter or a number would lift it.'
          : 'A couple more characters and it’s there.';

  return { score, label: LABELS[score], hint, tone: TONES[score] };
}

/**
 * Submit-time validation. Separate from the score on purpose: the meter is
 * encouragement, this is the gate, and only one of them should ever turn red.
 */
export function passwordProblem(value: string): string | null {
  if (value.length === 0) return 'Pop in a password and we’re away.';
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Passwords need ${MIN_PASSWORD_LENGTH} characters or more — that’s ${MIN_PASSWORD_LENGTH - value.length} short.`;
  }
  return null;
}

/* ------------------------------------------------------------------ helpers */

function toneFill(t: Theme, tone: PasswordStrengthTone): string {
  switch (tone) {
    case 'danger':
      return t.color.danger;
    case 'warning':
      return t.color.warning;
    case 'success':
    default:
      return t.color.success;
  }
}

function toneInk(t: Theme, tone: PasswordStrengthTone): string {
  switch (tone) {
    case 'danger':
      return t.color.onDangerSoft;
    case 'warning':
      return t.color.onWarningSoft;
    case 'success':
    default:
      return t.color.onSuccessSoft;
  }
}

/* ---------------------------------------------------------------- component */

export function PasswordField({
  value,
  onChangeText,
  meter = false,
  onStrengthChange,
  footer,
  style,
  label = 'Password',
  leadingIcon = 'lock-closed-outline',
  ...rest
}: PasswordFieldProps) {
  const t = useTheme();
  const strength = useMemo(() => scorePassword(value), [value]);

  useEffect(() => {
    onStrengthChange?.(strength);
  }, [onStrengthChange, strength]);

  const fill = toneFill(t, strength.tone);
  const showMeter = meter && value.length > 0;

  const cells = METER_CELLS.map((index) => ({
    value: index < strength.score ? 1 : 0,
    color: fill,
    label: `Level ${index + 1}`,
  }));

  return (
    <View style={[{ gap: t.spacing.sm }, style]}>
      <Input
        {...rest}
        label={label}
        leadingIcon={leadingIcon}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry
        showRevealToggle
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />

      {showMeter ? (
        <Animated.View
          entering={
            t.reduceMotion
              ? FadeIn.duration(t.motion.duration.fast)
              : FadeInDown.duration(t.motion.duration.base).easing(t.motion.easing.decelerate)
          }
          exiting={FadeOut.duration(t.motion.duration.fast)}
          style={{ gap: t.spacing.xs }}
        >
          <ProgressBar
            size="sm"
            segments={cells}
            trackColor={t.color.surfaceAlt}
            accessibilityLabel={`Password strength: ${strength.label}. ${strength.hint}`}
          />

          {/* Keyed so the words cross-fade as the score moves rather than
              snapping — the bars carry the change, the copy confirms it. */}
          <Animated.View key={strength.score} entering={FadeIn.duration(t.motion.duration.fast)}>
            <Row gap="xs" wrap>
              <Text variant="captionStrong" color={toneInk(t, strength.tone)}>
                {strength.label}
              </Text>
              <Text variant="caption" color="textTertiary">
                {strength.hint}
              </Text>
            </Row>
          </Animated.View>
        </Animated.View>
      ) : null}

      {footer}
    </View>
  );
}

export default PasswordField;
