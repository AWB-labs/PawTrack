/**
 * Device-local preferences. Deliberately *not* server state — these must apply
 * on the very first frame, before any network call, so they live in Zustand with
 * AsyncStorage persistence rather than React Query.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ThemePreference = 'system' | 'light' | 'dark';
export type WeightUnit = 'kg' | 'lb';

export type PreferencesState = {
  theme: ThemePreference;
  /** Haptics can be genuinely unpleasant for some users — always overridable. */
  haptics: boolean;
  /** App-level motion reduction, independent of the OS switch. */
  reduceMotion: boolean;
  weightUnit: WeightUnit;
  /** Biometric unlock armed for returning sessions. */
  biometricLock: boolean;
  /** Has the welcome carousel been seen on this device? */
  hasSeenWelcome: boolean;
  /**
   * Which version of the terms was agreed to *on this handset*, before there
   * was an account to record it against. Zero means the agreement screen has
   * not been through yet, and the welcome buttons route via it.
   *
   * This is a convenience, not the record. The record lives on the profile and
   * is what the router's legal gate reads — a device that has agreed still
   * meets the gate when the account behind it hasn't.
   */
  acceptedTermsVersion: number;
  /** Last pet the user was looking at — restores context on cold start. */
  lastActivePetId: string | null;

  setTheme: (theme: ThemePreference) => void;
  setHaptics: (enabled: boolean) => void;
  setReduceMotion: (enabled: boolean) => void;
  setWeightUnit: (unit: WeightUnit) => void;
  setBiometricLock: (enabled: boolean) => void;
  markWelcomeSeen: () => void;
  acceptTerms: (version: number) => void;
  setLastActivePetId: (petId: string | null) => void;
};

export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'system',
      haptics: true,
      reduceMotion: false,
      weightUnit: 'kg',
      biometricLock: false,
      hasSeenWelcome: false,
      acceptedTermsVersion: 0,
      lastActivePetId: null,

      setTheme: (theme) => set({ theme }),
      setHaptics: (haptics) => set({ haptics }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setWeightUnit: (weightUnit) => set({ weightUnit }),
      setBiometricLock: (biometricLock) => set({ biometricLock }),
      markWelcomeSeen: () => set({ hasSeenWelcome: true }),
      acceptTerms: (acceptedTermsVersion) => set({ acceptedTermsVersion }),
      setLastActivePetId: (lastActivePetId) => set({ lastActivePetId }),
    }),
    {
      name: 'petal.preferences.v1',
      storage: createJSONStorage(() => AsyncStorage),
      // v1: the settings screen that could ever arm `biometricLock` is gone, so
      // any device that had already armed it is force-unlocked rather than left
      // stranded behind a switch nothing can reach anymore.
      //
      // v2: the community agreement. Every existing device starts at 0 — a
      // handset that has been used for months has still never seen these terms,
      // and defaulting it to "agreed" would make the record a lie.
      version: 2,
      migrate: (persisted) => ({
        ...(persisted as PreferencesState),
        biometricLock: false,
        acceptedTermsVersion: 0,
      }),
    },
  ),
);

/** Non-reactive read, for use inside worklets/imperative helpers. */
export const getPreferences = () => usePreferences.getState();
