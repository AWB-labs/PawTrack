/**
 * Every cross-cutting provider, in the one order that works.
 *
 * Order matters and is not arbitrary:
 *   GestureHandlerRootView  — must be the outermost native view or gestures die.
 *   SafeAreaProvider        — insets are read by Screen/ScreenHeader below it.
 *   ThemeProvider           — everything visual depends on it, including the hosts.
 *   QueryProvider           — data layer; sits above anything that fetches.
 *   BottomSheetModalProvider— @gorhom/bottom-sheet portal root.
 *   Hosts (toast/denial/confetti) — rendered last so they paint above all screens.
 */

import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import React, { type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { QueryProvider } from '@/data/QueryProvider';
import { DenialSheetHost } from '@/rbac/DenialSheet';
import { ThemeProvider } from '@/theme';
import { ConfettiHost } from '@/ui/Confetti';
import { ToastHost } from '@/ui/Toast';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <QueryProvider>
            <BottomSheetModalProvider>
              {children}
              {/* Overlay hosts — order here is their z-order. */}
              <DenialSheetHost />
              <ToastHost />
              <ConfettiHost />
            </BottomSheetModalProvider>
          </QueryProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default AppProviders;
