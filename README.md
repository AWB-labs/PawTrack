# Petal 🐾

A pet-care app for owners *and* the people who look after their pets. Health records, feeding,
medicine, vet appointments, scoped caregiver access, and a community feed — built as a flagship
consumer product rather than a CRUD shell.

Expo SDK 54 · React Native 0.81 · TypeScript · expo-router v6 · Reanimated 4 · Supabase

---

## Run it

```bash
npm install
```

```bash
npm start
```

Scan the QR with **Expo Go**. No native build, no backend setup — the app boots against a seeded
offline dataset.

**Demo sign-in:** any email and password works. Use `maya@petal.app` for the full owner experience
(she owns three pets *and* sits for a fourth, which is the dual-role model in action), or
`priya@petal.app` to see the app as a caregiver with scoped permissions.

## Connect Supabase

The app runs on a mock adapter until credentials exist, then switches with no code changes.

1. Follow [`supabase/README.md`](supabase/README.md) — create the project, run the three
   migrations, create the `pet-media` bucket.
2. Copy `.env.example` to `.env.local` (git-ignored) and fill in:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
```

3. Restart with a cleared cache:

```bash
npm run start:clear
```

`src/data/index.ts` detects the env vars and swaps `MockAdapter` for `SupabaseAdapter`.

## Layout

```
app/                  expo-router routes (see docs/ARCHITECTURE.md for the tree)
src/
  theme/              design tokens → semantic palette → runtime. Start here.
  ui/                 the component library. Every screen is built from it.
  rbac/               capability model, permission hooks, access UI
  data/               adapter contract, mock + supabase impls, React Query hooks
  features/           feature-specific composites (today, pets, health, community…)
  stores/             Zustand: preferences, session, transient UI
  lib/                haptics, notifications, dates, formatting, biometrics, errors
supabase/migrations/  schema + RLS + RPCs
docs/                 ARCHITECTURE.md (decisions) · BUILD_CONTRACT.md (house rules)
```

## Reading order

If you're picking this up cold:

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the eight decisions everything else follows from.
2. [`src/rbac/permissions.ts`](src/rbac/permissions.ts) — the access model. It's the heart of the product.
3. [`src/theme/palette.ts`](src/theme/palette.ts) — how colour and contrast are guaranteed rather than hoped for.
4. [`docs/BUILD_CONTRACT.md`](docs/BUILD_CONTRACT.md) — the rules any new screen must follow.

## Scripts

| | |
|---|---|
| `npm start` | Expo dev server |
| `npm run start:clear` | …with the Metro cache cleared (use after env changes) |
| `npm run check` | typecheck + contrast audit + RBAC parity — run this before committing |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:contrast` | Fails if any semantic colour pairing drops below WCAG AA |
| `npm run check:rbac` | Fails if `permissions.ts` and the SQL capability model disagree |
| `npm run doctor` | `expo-doctor` dependency check |

## Notes

- **Expo Go compatible by design.** No Skia, no Lottie, no custom native modules — every visual is
  SVG + gradients + blur + Reanimated. Remote push is the one thing that needs a dev build;
  reminders use local notifications, which is the right mechanism for them regardless.
- **Accessibility is checked, not assumed.** `src/theme/contrast.ts` audits every semantic colour
  pairing on boot in `__DEV__` and logs any that fall below WCAG AA. The same audit runs headlessly
  via `npm run check:contrast`, so it can gate CI.
- **The RBAC duplication is guarded.** The capability model necessarily exists twice — in
  TypeScript and in SQL, because the client isn't trusted. `npm run check:rbac` diffs the two and
  fails on any divergence, including the subtle case where an owner-only capability is gated with
  `petal_has_capability()` instead of `petal_is_owner()` (equivalent today, silently wrong the day
  the caregiver ceiling widens).
