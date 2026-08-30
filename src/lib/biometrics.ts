/**
 * Petal — biometric unlock.
 *
 * Petal holds vaccination records, medication schedules and vet correspondence.
 * That's worth a lock, but only if the lock explains itself: the single worst
 * settings screen in the world is a toggle that's greyed out with no reason
 * given. So `isAvailable()` deliberately reports `hasHardware` and `isEnrolled`
 * *separately* — the difference between "your phone can't do this" and "your
 * phone can, you just haven't set it up" is the difference between a dead end
 * and a two-tap fix.
 *
 * The friendly label matters too. Nobody calls it "facial recognition
 * authentication" — on an iPhone it's Face ID, on a Pixel it's Face Unlock, and
 * using the wrong name makes the prompt feel like it came from somewhere else.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import { logError } from './errors';

/* ------------------------------------------------------------------ types */

export type BiometricKind = 'faceId' | 'touchId' | 'faceUnlock' | 'fingerprint' | 'iris' | 'passcode' | 'none';

export type UnavailableReason = 'no-hardware' | 'not-enrolled' | 'device-not-secured';

export type BiometricAvailability = {
  /** Hardware present *and* something enrolled. The only flag a call site needs. */
  available: boolean;
  hasHardware: boolean;
  isEnrolled: boolean;
  kind: BiometricKind;
  /** "Face ID", "Touch ID", "Fingerprint" — what the user calls it. */
  label: string;
  /** Ionicons name, so settings rows draw the right glyph. */
  icon: string;
  securityLevel: LocalAuthentication.SecurityLevel;
  /** Null when available. Otherwise exactly what's missing. */
  reason: UnavailableReason | null;
  /** One sentence, ready to render under a disabled toggle. */
  explanation: string | null;
};

export type BiometricFailure =
  | 'cancelled'
  | 'fallback'
  | 'lockout'
  | 'not-enrolled'
  | 'unavailable'
  | 'failed'
  | 'unknown';

export type BiometricResult =
  | { ok: true }
  | {
      ok: false;
      reason: BiometricFailure;
      /** Warm copy, safe to show directly. Empty for `'cancelled'`. */
      message: string;
      /** False when trying again cannot possibly work (lockout, no hardware). */
      canRetry: boolean;
    };

export type AuthenticateOptions = {
  /** Shown in the system sheet. Say *why*, not "Authenticate". */
  reason?: string;
  cancelLabel?: string;
  /** iOS only — the "Use Passcode" button's label. */
  fallbackLabel?: string;
  /**
   * Allow the device passcode as a fallback. On by default: locking someone out
   * of their own dog's medication schedule because Face ID misfired twice is a
   * worse outcome than the marginal security gain.
   */
  allowPasscode?: boolean;
};

/* ----------------------------------------------------------------- labels */

const KIND_META: Record<BiometricKind, { label: string; icon: string }> = {
  faceId: { label: 'Face ID', icon: 'scan-outline' },
  touchId: { label: 'Touch ID', icon: 'finger-print-outline' },
  faceUnlock: { label: 'Face Unlock', icon: 'scan-outline' },
  fingerprint: { label: 'Fingerprint', icon: 'finger-print-outline' },
  iris: { label: 'Iris unlock', icon: 'eye-outline' },
  passcode: { label: 'Device passcode', icon: 'keypad-outline' },
  none: { label: 'Screen lock', icon: 'lock-closed-outline' },
};

/**
 * Pick the modality the user would name if you asked them. iOS devices report
 * exactly one of face/fingerprint, so the branch is unambiguous there; Android
 * can report several, and fingerprint is both the most common and the most
 * reliable, so it wins the tie.
 */
function resolveKind(types: LocalAuthentication.AuthenticationType[], enrolledLevel: LocalAuthentication.SecurityLevel): BiometricKind {
  const hasFace = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
  const hasFinger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
  const hasIris = types.includes(LocalAuthentication.AuthenticationType.IRIS);

  if (Platform.OS === 'ios') {
    if (hasFace) return 'faceId';
    if (hasFinger) return 'touchId';
  } else {
    if (hasFinger) return 'fingerprint';
    if (hasFace) return 'faceUnlock';
    if (hasIris) return 'iris';
  }

  if (enrolledLevel === LocalAuthentication.SecurityLevel.SECRET) return 'passcode';
  return 'none';
}

export function biometricLabel(kind: BiometricKind): string {
  return KIND_META[kind].label;
}

/* ----------------------------------------------------------- availability */

const UNAVAILABLE: BiometricAvailability = {
  available: false,
  hasHardware: false,
  isEnrolled: false,
  kind: 'none',
  label: KIND_META.none.label,
  icon: KIND_META.none.icon,
  securityLevel: LocalAuthentication.SecurityLevel.NONE,
  reason: 'no-hardware',
  explanation: 'This device doesn’t have a fingerprint or face sensor, so Petal can’t lock itself that way.',
};

/**
 * Everything the security settings screen needs in one round trip. Never
 * throws — an unreadable sensor reports as unavailable rather than taking the
 * screen down with it.
 */
export async function isAvailable(): Promise<BiometricAvailability> {
  try {
    const [hasHardware, types, isEnrolled, securityLevel] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.getEnrolledLevelAsync(),
    ]);

    const kind = resolveKind(types, securityLevel);
    const meta = KIND_META[kind];

    if (!hasHardware) {
      return { ...UNAVAILABLE, securityLevel };
    }

    if (!isEnrolled) {
      // Hardware is there but nothing is registered — the two-tap fix case.
      const named = kind === 'none' || kind === 'passcode' ? 'A fingerprint or face' : meta.label;
      return {
        available: false,
        hasHardware: true,
        isEnrolled: false,
        kind,
        label: meta.label,
        icon: meta.icon,
        securityLevel,
        reason: securityLevel === LocalAuthentication.SecurityLevel.NONE ? 'device-not-secured' : 'not-enrolled',
        explanation:
          securityLevel === LocalAuthentication.SecurityLevel.NONE
            ? 'Your phone has no screen lock yet. Add a passcode in system settings and Petal can lock to it.'
            : `${named} isn’t set up on this phone yet. Add it in your phone’s settings and this switches on.`,
      };
    }

    return {
      available: true,
      hasHardware: true,
      isEnrolled: true,
      kind,
      label: meta.label,
      icon: meta.icon,
      securityLevel,
      reason: null,
      explanation: null,
    };
  } catch (error) {
    logError('biometrics.isAvailable', error);
    return UNAVAILABLE;
  }
}

/** Cheap boolean for guards that don't need the explanation. */
export async function canUseBiometrics(): Promise<boolean> {
  return (await isAvailable()).available;
}

/* -------------------------------------------------------- authentication */

const FAILURE_COPY: Record<BiometricFailure, { message: string; canRetry: boolean }> = {
  cancelled: { message: '', canRetry: true },
  fallback: { message: '', canRetry: true },
  lockout: {
    message: 'Too many attempts — your phone has paused biometric unlock. Use your passcode, then try again.',
    canRetry: false,
  },
  'not-enrolled': {
    message: 'There’s nothing enrolled to check against. Add a fingerprint or face in your phone’s settings first.',
    canRetry: false,
  },
  unavailable: {
    message: 'Biometric unlock isn’t available on this device right now.',
    canRetry: false,
  },
  failed: {
    message: 'That didn’t match. Have another go, or use your passcode.',
    canRetry: true,
  },
  unknown: {
    message: 'Something interrupted the unlock. Try once more.',
    canRetry: true,
  },
};

const ERROR_MAP: Record<LocalAuthentication.LocalAuthenticationError, BiometricFailure> = {
  user_cancel: 'cancelled',
  app_cancel: 'cancelled',
  system_cancel: 'cancelled',
  user_fallback: 'fallback',
  lockout: 'lockout',
  not_enrolled: 'not-enrolled',
  passcode_not_set: 'not-enrolled',
  not_available: 'unavailable',
  no_space: 'unavailable',
  invalid_context: 'unavailable',
  authentication_failed: 'failed',
  unable_to_process: 'failed',
  timeout: 'failed',
  unknown: 'unknown',
};

/**
 * Prompt for unlock.
 *
 * `'cancelled'` and `'fallback'` carry empty messages on purpose: the user
 * dismissed the sheet themselves, and answering a deliberate cancel with an
 * error toast is the app arguing with them.
 */
export async function authenticate(options: AuthenticateOptions = {}): Promise<BiometricResult> {
  const availability = await isAvailable();
  if (!availability.available) {
    return {
      ok: false,
      reason: availability.reason === 'no-hardware' ? 'unavailable' : 'not-enrolled',
      message: availability.explanation ?? FAILURE_COPY.unavailable.message,
      canRetry: false,
    };
  }

  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: options.reason ?? 'Unlock your pets’ records',
      cancelLabel: options.cancelLabel ?? 'Not now',
      fallbackLabel: options.fallbackLabel ?? 'Use passcode',
      disableDeviceFallback: options.allowPasscode === false,
      // Class 3 only: a 2D-image face unlock is not a lock worth having on
      // medical records.
      biometricsSecurityLevel: 'strong',
      requireConfirmation: false,
    });

    if (result.success) return { ok: true };

    const reason = ERROR_MAP[result.error] ?? 'unknown';
    if (__DEV__ && result.warning) {
      console.warn(`[petal:biometrics] ${result.error} — ${result.warning}`);
    }
    return { ok: false, reason, ...FAILURE_COPY[reason] };
  } catch (error) {
    logError('biometrics.authenticate', error);
    return { ok: false, reason: 'unknown', ...FAILURE_COPY.unknown };
  }
}

/**
 * Dismiss an in-flight Android prompt — needed when the app backgrounds mid-
 * authentication, otherwise the sheet outlives the screen that asked for it.
 */
export async function cancel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await LocalAuthentication.cancelAuthenticate();
  } catch {
    /* nothing in flight — harmless */
  }
}

export const biometrics = {
  isAvailable,
  canUseBiometrics,
  authenticate,
  cancel,
  biometricLabel,
};

export default biometrics;
