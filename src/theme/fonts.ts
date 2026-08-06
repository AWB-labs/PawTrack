/**
 * Font modules for `useFonts` at boot.
 *
 * Static requires (not dynamic `import()`) so Metro bundles them and the splash
 * can be held until they're actually resident — a font that resolves one frame
 * late produces a visible reflow, which is exactly the kind of thing that makes
 * an app feel unfinished.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import {
  Fraunces_600SemiBold,
  Fraunces_600SemiBold_Italic,
  Fraunces_700Bold,
} from '@expo-google-fonts/fraunces';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';

export const fontModules = {
  Fraunces_600SemiBold,
  Fraunces_700Bold,
  Fraunces_600SemiBold_Italic,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  // Every icon in the app is Ionicons (see `src/ui/Icon.tsx`). Without this,
  // the splash screen hides as soon as the *text* fonts are ready, so any
  // icon that paints on the very first frame (before its own re-render)
  // can land before Ionicons' glyph font is actually resident — it renders
  // as a blank glyph, not a "tofu" box, so it's easy to miss in a screenshot.
  ...Ionicons.font,
} as const;
