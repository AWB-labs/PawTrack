-- ============================================================================
-- Petal — 0007_fix_pets_caregiver_visibility.sql
--
-- Fixes: a caregiver who accepted a valid invite (correct, active membership
-- row, correct window) could never actually see the pet — not on the detail
-- screen, not in their pets list, anywhere. The detail screen sat on its
-- skeleton forever since the query legitimately returned zero rows, not an
-- error.
--
-- Root cause: 0006_fix_pets_select_returning.sql wrote the caregiver branch
-- of the `pets` SELECT policy as
--
--   exists (select 1 from memberships m where m.pet_id = id and ...)
--
-- intending `id` to mean the outer `pets.id` (the row the policy is
-- evaluating). But `memberships` also has its own `id` column (its primary
-- key), and inside a correlated subquery an unqualified column name resolves
-- to the *nearest* enclosing scope that has it — which is `m`, not the outer
-- `pets` table. So this silently became `m.pet_id = m.id`: a membership's
-- pet reference compared against that same membership row's own primary
-- key. Those are never equal except by coincidence, so the whole caregiver
-- branch matched nothing, ever, for any caregiver on any pet. The owner
-- branch (`owner_id = auth.uid()`, no subquery involved) was unaffected,
-- which is exactly why the earlier fix's own re-test — signing up as an
-- *owner* and creating a pet — never caught it.
--
-- Fix: qualify the outer reference explicitly as `pets.id` so there's no
-- ambiguity for Postgres to resolve the wrong way.
-- ============================================================================

drop policy "pets are visible to their household" on public.pets;

create policy "pets are visible to their household"
  on public.pets for select to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1
      from public.memberships m
      where m.pet_id = pets.id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
        and (m.starts_at is null or m.starts_at <= now())
        and (m.ends_at is null or m.ends_at >= now())
    )
  );
