# Petal — build contract

**Read this before writing any file.** Every contributor (human or agent) follows it exactly.
Deviating breaks the design system, which is the point of the product.

## Environment (non-negotiable)

- **Expo SDK 54** (`expo@~54.0.35`), React Native 0.81.5, React 19.1.0, TypeScript strict.
- **Must run in Expo Go.** No `react-native-skia`, no custom native modules, no
  `react-native-lottie`, nothing requiring a prebuild. If you want an effect, build it from
  `react-native-svg` + `expo-linear-gradient` + `expo-blur` + Reanimated.
- **Reanimated 4** (`react-native-reanimated@~4.1.1` + `react-native-worklets`). Babel plugin is
  auto-wired by `babel-preset-expo` — do not add it manually.
- **expo-router v6** file routes under `app/`. Import from `expo-router` (`Link`, `router`,
  `useRouter`, `useLocalSearchParams`, `Stack`, `Tabs`, `Redirect`).
- Reference docs: `https://docs.expo.dev/versions/v54.0.0/`. Verify any API you are unsure of.
- Path alias `@/*` → `src/*`. Use it; never write `../../../`.
- Platforms: iOS + Android. No web-specific code paths.

## Hard rules

1. **No hard-coded colours, sizes, radii, durations or font names.** Everything comes from
   `useTheme()`. A literal `#fff`, `padding: 16`, `borderRadius: 12`, `fontSize: 15` or
   `duration: 300` in a component is a bug. The only exception is `0`, `1` (hairline) and
   `'transparent'`.
2. **No `Text` from `react-native`.** Use `@/ui/Text`. It carries the type scale, dynamic-type
   caps and colour tokens.
3. **No bare `TouchableOpacity`/`Pressable`.** Use `@/ui/Touchable` (or `Button`/`IconButton`),
   which guarantees ≥44pt hit area, press animation, haptics and a11y props.
4. **Every interactive element needs `accessibilityRole`, an `accessibilityLabel` when the
   visible text isn't sufficient, and `accessibilityState` for toggles/disabled.**
5. **Every list/collection screen must implement all four states**: loading (skeleton matching
   the real content's shape — never a spinner), empty (illustration + headline + one clear
   action), error (illustration + cause + retry), and content.
6. **Dark mode is designed, not derived.** Read `theme.scheme` where a value must genuinely
   differ. Never invert. Never use shadows in dark mode — `theme.elevation(n)` already handles it.
7. **Reduced motion:** decorative/looping motion must check `theme.reduceMotion` and degrade to
   opacity-only. Functional feedback (press scale) stays — Reanimated presets already carry
   `ReduceMotion.System`.
8. **RBAC in both layers.** UI gates with `usePermission`/`<PermissionGate>`; the adapter throws
   `PermissionError`. Never rely on only one.
9. **No `any`.** No `@ts-ignore`. No `console.log` left behind (`__DEV__`-guarded warnings OK).
10. **No placeholder/lorem content and no `TODO` stubs.** Write the real, finished screen. If you
    need copy, write good copy.

## Theme API

```ts
import { useTheme, makeStyles } from '@/theme';

const t = useTheme();
t.scheme                 // 'light' | 'dark'
t.color.*                // semantic palette — see src/theme/palette.ts for the full list
t.spacing.xs|sm|md|base|lg|xl|xxl|xxxl|huge|giant
t.gutter                 // standard horizontal screen padding
t.radius.sm|md|lg|xl|xxl|xxxl|pill
t.borderWidth.hairline|thin|thick|focus
t.type.body|title1|…     // full ramp in src/theme/typography.ts
t.motion.duration.fast|base|slow|slower|page
t.motion.easing.standard|decelerate|accelerate|smooth|overshoot
t.motion.springWith('press'|'snappy'|'gentle'|'bouncy'|'heavy')
t.motion.timing(ms, 'standard')
t.motion.pressScale.small|medium|large|subtle
t.motion.stagger.tight|base|loose
t.elevation(0..5)        // returns a ViewStyle; dark-mode aware
t.glow(color)            // coloured shadow for the single hero CTA on a screen
t.speciesColor('dog')    // { base, tint } — per-pet identity colour
t.minTarget              // 44
t.fontScale, t.isLargeText, t.reduceMotion
```

Key colour tokens: `bg bgSunken surface surfaceAlt surfaceRaised surfaceGlass border borderStrong
divider text textSecondary textTertiary textFaint textInverse primary onPrimary primaryText
primarySoft onPrimarySoft accent onAccent accentText accentSoft onAccentSoft success onSuccess
successSoft onSuccessSoft warning onWarning warningSoft onWarningSoft danger onDanger dangerSoft
onDangerSoft info onInfo infoSoft onInfoSoft focus scrim skeleton skeletonSheen chrome
chromeBorder`.

**Contrast pairing rule:** a fill token is always used with its matching `on*` ink
(`primary`+`onPrimary`, `accentSoft`+`onAccentSoft`, …). For coloured *text* on a page ground use
`primaryText` / `accentText`, never `primary` / `accent`. `textFaint` is decorative only — never
essential text.

## Motion vocabulary

- Enter: `base`/`slow` + `decelerate`. Exit: `fast` + `accelerate`.
- Anything a finger drove → spring. Anything the system drove → timing.
- Press: scale to `t.motion.pressScale.*` with `springWith('press')` + `haptics.tap()`.
- List entrances: stagger `t.motion.stagger.base` per item, cap the stagger at ~8 items.
- `bouncy` spring is reserved for genuine rewards (task completed, pet added). Do not use it for
  routine UI.

## Haptics

```ts
import haptics from '@/lib/haptics';
haptics.tap() select() commit() heavy() threshold() soft() success() warn() error() celebrate()
```
Already preference-gated and failure-safe. Never call `expo-haptics` directly.

## Data layer

```ts
import { useSession } from '@/stores/session';
import { adapter } from '@/data';
```
Screens use the React Query hooks in `@/data/queries/*`, never the adapter directly.
Mutations that change a list must be optimistic where the user expects instant feedback
(likes, ticking a meal/dose off) and roll back on error with a toast.

## RBAC in the UI

```ts
const { allowed, reason, explain } = usePermission('feeding.log', petId);
```
- Destructive or owner-only actions a caregiver can never do → **hide**.
- Actions they could have but weren't granted → **show disabled** with an explanation on tap
  (that's how they learn to ask the owner).
- `<PermissionGate capability="…" petId={…}>` wraps whole sections.
- Never render a raw denial string — use `explain()` which opens the themed sheet with
  `DENIAL_COPY`.

## Voice & copy

Warm, brief, specific, and it uses the pet's name. Never system-speak.

- ✅ "Buddy's dinner time! 🐾"  ✅ "Two doses left — worth a refill this week."
- ✅ "No vaccinations on file yet. Add Buddy's first one and we'll track the due date for you."
- ❌ "No data available."  ❌ "Error 500."  ❌ "Are you sure you want to perform this action?"

Empty states: headline names the gap in plain words, one line of body explaining the payoff, one
primary action. Errors: say what happened, then offer retry — never blame the user.

## File conventions

- One component per file, named export **and** default export matching the filename.
- Props type named `<Component>Props`, exported.
- Order: imports → types → constants → component → `makeStyles`/`StyleSheet` at the bottom.
- `makeStyles` for theme-derived styles; inline style objects only for values that depend on
  props/animated state.
- Comment *why*, never *what*. Match the density of the existing `src/theme` files.
