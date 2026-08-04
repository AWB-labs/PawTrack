# Petal — architecture

Short notes on the decisions that shaped everything else. Each one is here because the obvious
alternative would have cost us later.

## 1. Role is a property of `(user, pet)`, never of `user`

The brief's sharpest requirement: one person owns Buddy and sits for Mochi *at the same time*. So
there is no `user.role` column, no `isOwner` flag on the session, and no owner/caregiver split at
the router level. Instead:

- `Membership { petId, userId, role, grants[], startsAt, endsAt, status }` is the unit of access.
- Every authorisation question is `evaluate(membership, capability, now)` — see
  [`src/rbac/permissions.ts`](../src/rbac/permissions.ts).
- The session carries *all* of a user's memberships; `PetScopeProvider` resolves the relevant one
  when you enter a pet's stack.

Caregiver access is scoped on three axes simultaneously — **capability** (explicit grants,
intersected with a `CAREGIVER_GRANTABLE` ceiling so a bad row can't hand out `pet.delete`), **time**
(`[startsAt, endsAt]`), and **status** (pending/active/expired/revoked).

`evaluate()` returns a *reason* on denial, not a bare `false`. That reason is what makes the UI
legible: the app can say "your sitting dates start Monday" instead of greying a button out in
silence.

## 2. RBAC is enforced three times, from one source of truth

The brief asks for both UI and data-layer enforcement. We do three:

| Layer | Mechanism | Purpose |
|---|---|---|
| UI | `usePermission` / `<PermissionGate>` | Instant, explanatory. Hide owner-only, disable-and-explain the rest. |
| Client data layer | `assertCan()` in every adapter mutation → throws `PermissionError` | Catches any screen that forgot to gate. |
| Postgres | RLS policies + `petal_has_capability()` | The actual security boundary. Everything above it is UX. |

All three read the same matrices. The SQL helper re-implements `evaluate()`'s logic deliberately —
that duplication is the price of the client not being trusted.

Because that duplication can drift silently, `npm run check:rbac` diffs the TypeScript model against
the SQL on every run. It catches the obvious case (a capability added to one and not the other) and
one non-obvious case worth spelling out: gating an owner-only capability with
`petal_has_capability(pet, 'activity.view')` rather than `petal_is_owner(pet)`. Those are equivalent
*today* only because the caregiver ceiling makes the capability branch unreachable — so the wrong
form reads as correct and passes every test, right up until someone widens the ceiling and a policy
named "only the owner reads the activity log" quietly stops meaning that. The check found exactly
that instance in `0002_rls.sql`; it now uses `petal_is_owner()`.

## 3. Two adapters behind one interface

`DataAdapter` ([`src/data/adapter.ts`](../src/data/adapter.ts)) is the only thing screens see.

- **`MockAdapter`** — seeded, offline, AsyncStorage-backed, with simulated latency so skeletons are
  genuinely visible. Ships in the repo so the app is fully explorable with zero setup.
- **`SupabaseAdapter`** — real Postgres/Storage/Auth.

Selection happens once in `src/data/index.ts` from `EXPO_PUBLIC_SUPABASE_URL`. Adding credentials
is the entire migration; no screen changes.

The simulated latency is not a gimmick — building against an instant in-memory store is how apps
end up with loading states nobody ever looked at.

## 4. State: Zustand for device state, React Query for server state

- **Zustand** — theme, haptics, units, session, active pet. Things that must be correct on the
  first frame, before any network call.
- **React Query** — everything the adapter returns, with a hierarchical key factory so one pet's
  feeding can be invalidated without touching the community feed.

Mutations the user expects to feel instant (likes, ticking off a meal or dose, joining a group) are
optimistic with full rollback. Everything else is honest about latency.

## 5. expo-router v6 with `Stack.Protected`

Chosen over hand-rolled React Navigation for two concrete reasons:

1. **Deep links are the caregiver invite flow.** `petal://invite/BUDDY-4KQ2` needs to resolve to a
   real screen for a *signed-out* user without losing the code. File-based routes give that free.
2. **`Stack.Protected` removes the redirect race.** Guards mount branches declaratively, so there's
   no flash of the wrong screen and no `useEffect` navigation ordering bugs.

It is React Navigation underneath, so the brief's requirement is met either way.

Route shape:

```
(auth)          welcome · sign-in · sign-up · forgot-password
lock            biometric re-entry
(onboarding)    profile · first-pet · reminders · done
(tabs)          Today · Pets · Community · You
pet/[petId]/    profile · health · feeding · medicine · appointments · caregivers · activity …
record/         modal create/edit forms (petId + optional id ⇒ one screen serves both)
invite/[code]   deep-link target, reachable signed-out
```

## 6. Design tokens are structural, not decorative

`src/theme/` is a three-layer system: primitives (`tokens.ts`) → semantics (`palette.ts`) →
runtime (`ThemeProvider.tsx`). Screens only ever touch the third.

Decisions worth calling out:

- **Warm neutrals, never grey.** A pet app holding medical records needs to feel calm, not clinical.
- **Fill/ink pairs (`primary`+`onPrimary`) instead of free colour choice.** Contrast becomes
  structurally guaranteed rather than accidentally correct.
- **`contrast.ts` audits every semantic pairing on boot in `__DEV__`** and logs failures. A11y stops
  being a review checklist and becomes a build signal.
- **Dark mode is authored, not inverted.** Warm near-black ground, brand lifted from moss-500 to
  moss-300 to hold 8:1, and *no shadows at all* — depth there comes from surface lightness plus a
  hairline top highlight, because a shadow on near-black is invisible.
- **Type pairs Fraunces (serif display) with Plus Jakarta Sans (UI).** Editorial warmth up top,
  legible density in the data. Dynamic-type caps are per-variant so body copy can reach 2× while a
  card title can't explode the layout.

## 7. Motion has a vocabulary, not a bag of durations

`src/theme/motion.ts` fixes four rules: nothing linear; enter slow / exit fast; springs for anything
a finger drove and timings for anything the system drove; `bouncy` reserved for genuine rewards.
Every preset carries `ReduceMotion.System`, and decorative motion additionally checks
`theme.reduceMotion` and degrades to opacity rather than disappearing.

## 8. Expo Go compatible on purpose

No Skia, no Lottie, no custom native modules. Every visual is `react-native-svg` +
`expo-linear-gradient` + `expo-blur` + Reanimated 4. The cost is a little more hand-drawn SVG; the
benefit is that the app runs from a QR code with no build step, which is worth far more during
development. Remote push is the one casualty — reminders use local notifications, which is the
correct mechanism for them anyway.
