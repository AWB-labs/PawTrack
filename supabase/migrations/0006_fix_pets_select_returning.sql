-- ============================================================================
-- Petal — 0006_fix_pets_select_returning.sql
--
-- Fixes: creating a pet failed with "new row violates row-level security
-- policy for table pets" — but only when the client asked for the row back
-- (Supabase's `.select().single()` after `.insert()`, i.e. Postgres's
-- `INSERT ... RETURNING`). The plain insert, with no RETURNING, always
-- worked; only the RETURNING side failed.
--
-- Root cause: Postgres gates `RETURNING` on INSERT/UPDATE with the table's
-- SELECT policy. The old "pets are visible to their household" policy read:
--
--   using (petal_has_capability(id, 'pet.view'))
--
-- which calls petal_is_owner(id), which re-queries `pets` by id to check
-- `owner_id = auth.uid()`. That inner subquery runs under the *same
-- command-level snapshot* as the outer INSERT — and for a row this very
-- statement just created, that snapshot doesn't yet include it from a
-- separate scan of the table. So petal_is_owner(id) came back false for the
-- row the caller unambiguously just inserted as themselves, RETURNING was
-- denied, and Postgres reported it as "new row violates row-level security
-- policy" even though the INSERT itself was perfectly valid.
--
-- This is specific to `pets`: it's the only table whose own SELECT policy
-- transitively re-queries itself. Every other table's SELECT policy checks
-- `pets` or `memberships` — a *different*, already-settled table — so
-- inserting into weight_entries, vaccinations, etc. was never affected.
--
-- Fix: check `owner_id = auth.uid()` directly against the candidate row (a
-- plain column comparison Postgres evaluates without a subquery, so it isn't
-- exposed to this snapshot timing at all) instead of routing through
-- petal_has_capability/petal_is_owner. The caregiver branch still queries
-- `memberships` — safe, since that table isn't the one being written to.
-- 'pet.view' is in CAREGIVER_BASELINE (permissions.ts), so any active
-- membership grants it implicitly; no need to check `grants` here.
-- ============================================================================

drop policy "pets are visible to their household" on public.pets;

create policy "pets are visible to their household"
  on public.pets for select to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1
      from public.memberships m
      where m.pet_id = id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
        and (m.starts_at is null or m.starts_at <= now())
        and (m.ends_at is null or m.ends_at >= now())
    )
  );
