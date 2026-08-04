-- ============================================================================
-- Petal — 0002_rls.sql
-- Row Level Security. This file *is* the security boundary.
--
-- src/rbac/permissions.ts is enforced three times: the UI hides or disables the
-- control, the adapter's assertCan() throws before the request leaves the
-- device, and these policies decide what actually happens. The first two are
-- for feel and for feedback. Only this one is a defence, because it is the only
-- one an attacker cannot skip by talking to PostgREST directly with a stolen
-- anon key.
--
-- The model, restated from permissions.ts so it can be checked against this file
-- line by line:
--
--   · Authorisation is always (user, pet, capability) — never (user, capability).
--     The same person owns Buddy and sits for Mochi in the same session.
--   · Ownership is rooted in `pets.owner_id`. Owners hold every capability,
--     are never time-scoped, and can never be revoked.
--   · A caregiver must clear four gates at once: status = 'active', now() inside
--     [starts_at, ends_at], the capability present in `grants` (or in the
--     baseline), and the capability inside the CAREGIVER_GRANTABLE ceiling. The
--     ceiling is checked last and independently, so a tampered `grants` array
--     containing 'pet.delete' buys nothing.
--   · Owner-only capabilities — pet.delete, pet.transfer, caregiver.*,
--     document.delete, medicine.edit, activity.view — are written here as
--     `petal_is_owner(...)`, not as a capability lookup. They cannot be granted,
--     so they are not expressible as grants.
--
-- Why the helpers are SECURITY DEFINER: the policy on `pets` needs to read
-- `memberships`, and the policy on `memberships` needs to read `pets`. Reading
-- them through a definer function steps outside RLS for that lookup, which is
-- both what breaks the recursion and what stops a caregiver inferring rows they
-- cannot see. `set search_path` is mandatory on every one of them — without it a
-- definer function is a privilege-escalation hole.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

/**
 * Root grant. Deliberately reads `pets.owner_id` rather than the mirrored
 * `memberships` row: a forged membership with role = 'owner' must be worth
 * nothing, and this is what makes that true.
 */
create or replace function public.petal_is_owner(pet uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.pets p
    where p.id = pet
      and p.owner_id = (select auth.uid())
  );
$$;

/** Any live relationship to the pet — owner, or a caregiver inside their window. */
create or replace function public.petal_is_member(pet uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.petal_is_owner(pet) or exists (
    select 1
    from public.memberships m
    where m.pet_id = pet
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and (m.starts_at is null or m.starts_at <= now())
      and (m.ends_at is null or m.ends_at >= now())
  );
$$;

/**
 * evaluate() from permissions.ts, in SQL. The four caregiver gates are the four
 * conjuncts below, in the same order as the TypeScript switch:
 *
 *   status = 'active'                     → not pending / expired / revoked
 *   starts_at <= now() <= ends_at         → the sitting window
 *   cap ∈ petal_caregiver_grantable()     → the ceiling (owner-only capabilities)
 *   cap ∈ baseline ∪ m.grants             → the explicit grant list
 */
create or replace function public.petal_has_capability(pet uuid, cap text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.petal_is_owner(pet)
    or exists (
      select 1
      from public.memberships m
      where m.pet_id = pet
        and m.user_id = (select auth.uid())
        and m.role = 'caregiver'
        and m.status = 'active'
        and (m.starts_at is null or m.starts_at <= now())
        and (m.ends_at is null or m.ends_at >= now())
        and cap = any (public.petal_caregiver_grantable())
        and (
          cap = any (public.petal_caregiver_baseline())
          or cap = any (m.grants::text[])
        )
    );
$$;

comment on function public.petal_is_owner(uuid) is
  'True when auth.uid() owns the pet. The root grant — owners hold every capability.';
comment on function public.petal_has_capability(uuid, text) is
  'Mirrors evaluate() in src/rbac/permissions.ts: status, time window, grant list and the caregiver ceiling.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- RLS filters rows; GRANT decides whether the role may touch the table at all.
-- Both are needed: without the grants PostgREST returns 401 for everything, and
-- without RLS the grants would expose every row.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

grant execute on function public.petal_is_owner(uuid) to anon, authenticated;
grant execute on function public.petal_is_member(uuid) to anon, authenticated;
grant execute on function public.petal_has_capability(uuid, text) to anon, authenticated;
grant execute on function public.petal_caregiver_grantable() to anon, authenticated;
grant execute on function public.petal_caregiver_baseline() to anon, authenticated;
grant execute on function public.petal_sanitize_grants(public.capability[]) to anon, authenticated;

grant select, insert, update, delete on all tables in schema public to authenticated;

-- Signed-out users read nothing directly; the only anonymous surface is the
-- invite preview RPC in 0003, which is SECURITY DEFINER and code-gated.
revoke all on all tables in schema public from anon;

-- The community feed's safe pet projection is read-only, for signed-in users.
revoke all on public.pet_cards from anon, authenticated;
grant select on public.pet_cards to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. A table without RLS in this schema is a bug.
-- ---------------------------------------------------------------------------

alter table public.profiles         enable row level security;
alter table public.pets             enable row level security;
alter table public.memberships      enable row level security;
alter table public.invites          enable row level security;
alter table public.weight_entries   enable row level security;
alter table public.vaccinations     enable row level security;
alter table public.vet_visits       enable row level security;
alter table public.documents        enable row level security;
alter table public.feeding_schedules enable row level security;
alter table public.feeding_logs     enable row level security;
alter table public.medicines        enable row level security;
alter table public.medicine_logs    enable row level security;
alter table public.appointments     enable row level security;
alter table public.activity_events  enable row level security;
alter table public.groups           enable row level security;
alter table public.group_members    enable row level security;
alter table public.posts            enable row level security;
alter table public.post_likes       enable row level security;
alter table public.comments         enable row level security;
alter table public.comment_likes    enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
--
-- Readable by any signed-in user: caregiver lists, post authors and comment
-- authors all need a name and an avatar. Only ever writable by yourself, and
-- rows are created by the auth trigger, not by the client.
-- ---------------------------------------------------------------------------

create policy "profiles are readable by signed-in users"
  on public.profiles for select to authenticated
  using (true);

create policy "you can create your own profile"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

create policy "you can edit your own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- pets
-- ---------------------------------------------------------------------------

create policy "pets are visible to their household"
  on public.pets for select to authenticated
  using (public.petal_has_capability(id, 'pet.view'));

create policy "you can only create pets you own"
  on public.pets for insert to authenticated
  with check (owner_id = (select auth.uid()));

-- pet.edit and pet.transfer are both owner-only, so USING is the whole gate.
-- WITH CHECK stays permissive on purpose: a transfer rewrites owner_id to
-- someone else, and re-running the ownership test against the new row would
-- reject the very operation the capability exists for.
create policy "owners can edit their pet"
  on public.pets for update to authenticated
  using (public.petal_is_owner(id))
  with check (true);

create policy "owners can delete their pet"
  on public.pets for delete to authenticated
  using (public.petal_is_owner(id));

-- ---------------------------------------------------------------------------
-- memberships — caregiver.view / invite / revoke are all owner-only
--
-- Caregivers can read their own row (the app shows them "what you can do here"),
-- and can walk away from a sitting job, but cannot see who else has access,
-- cannot invite, and cannot widen their own grants.
-- ---------------------------------------------------------------------------

create policy "you see your own membership, owners see all of theirs"
  on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.petal_is_owner(pet_id));

-- Direct inserts are owner-only; accepting an invite goes through the
-- SECURITY DEFINER accept_invite() RPC instead, because the joiner has no
-- relationship to the pet yet. role is pinned to 'caregiver': owner rows are
-- only ever written by the ownership triggers in 0001.
create policy "owners can add caregivers"
  on public.memberships for insert to authenticated
  with check (public.petal_is_owner(pet_id) and role = 'caregiver');

create policy "owners can edit caregiver access"
  on public.memberships for update to authenticated
  using (public.petal_is_owner(pet_id))
  with check (public.petal_is_owner(pet_id) and role = 'caregiver');

create policy "owners can remove caregivers, caregivers can leave"
  on public.memberships for delete to authenticated
  using (
    role = 'caregiver'
    and (public.petal_is_owner(pet_id) or user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- invites — caregiver.invite is owner-only
--
-- Note there is no policy letting the *invitee* read the row: they have no
-- membership yet, so a policy could only be written as "anyone who knows a
-- code", which is an enumeration oracle. peek_invite() in 0003 does that lookup
-- behind a definer function that returns four safe fields.
-- ---------------------------------------------------------------------------

create policy "owners see invites for their pets"
  on public.invites for select to authenticated
  using (public.petal_is_owner(pet_id));

create policy "owners create invites"
  on public.invites for insert to authenticated
  with check (public.petal_is_owner(pet_id) and created_by = (select auth.uid()));

create policy "owners revoke invites"
  on public.invites for update to authenticated
  using (public.petal_is_owner(pet_id))
  with check (public.petal_is_owner(pet_id));

create policy "owners delete invites"
  on public.invites for delete to authenticated
  using (public.petal_is_owner(pet_id));

-- ---------------------------------------------------------------------------
-- weight_entries — weight.view / weight.log
--
-- You may undo your own entry; correcting or removing anyone else's is the
-- owner's call. Same shape for every log-style table below.
-- ---------------------------------------------------------------------------

create policy "weights follow weight.view"
  on public.weight_entries for select to authenticated
  using (public.petal_has_capability(pet_id, 'weight.view'));

create policy "weight.log records a weight"
  on public.weight_entries for insert to authenticated
  with check (
    public.petal_has_capability(pet_id, 'weight.log')
    and recorded_by = (select auth.uid())
  );

create policy "you can correct your own weight entry"
  on public.weight_entries for update to authenticated
  using (
    public.petal_is_owner(pet_id)
    or (recorded_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'weight.log'))
  )
  with check (
    public.petal_is_owner(pet_id)
    or (recorded_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'weight.log'))
  );

create policy "you can delete your own weight entry"
  on public.weight_entries for delete to authenticated
  using (
    public.petal_is_owner(pet_id)
    or (recorded_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'weight.log'))
  );

-- ---------------------------------------------------------------------------
-- vaccinations — vaccination.view / vaccination.edit
-- ---------------------------------------------------------------------------

create policy "vaccinations follow vaccination.view"
  on public.vaccinations for select to authenticated
  using (public.petal_has_capability(pet_id, 'vaccination.view'));

create policy "vaccination.edit adds a vaccination"
  on public.vaccinations for insert to authenticated
  with check (
    public.petal_has_capability(pet_id, 'vaccination.edit')
    and created_by = (select auth.uid())
  );

create policy "vaccination.edit updates a vaccination"
  on public.vaccinations for update to authenticated
  using (public.petal_has_capability(pet_id, 'vaccination.edit'))
  with check (public.petal_has_capability(pet_id, 'vaccination.edit'));

create policy "vaccination.edit deletes a vaccination"
  on public.vaccinations for delete to authenticated
  using (public.petal_has_capability(pet_id, 'vaccination.edit'));

-- ---------------------------------------------------------------------------
-- vet_visits — vetvisit.view / vetvisit.edit
-- ---------------------------------------------------------------------------

create policy "vet visits follow vetvisit.view"
  on public.vet_visits for select to authenticated
  using (public.petal_has_capability(pet_id, 'vetvisit.view'));

create policy "vetvisit.edit writes up a visit"
  on public.vet_visits for insert to authenticated
  with check (
    public.petal_has_capability(pet_id, 'vetvisit.edit')
    and created_by = (select auth.uid())
  );

create policy "vetvisit.edit updates a visit"
  on public.vet_visits for update to authenticated
  using (public.petal_has_capability(pet_id, 'vetvisit.edit'))
  with check (public.petal_has_capability(pet_id, 'vetvisit.edit'));

create policy "vetvisit.edit deletes a visit"
  on public.vet_visits for delete to authenticated
  using (public.petal_has_capability(pet_id, 'vetvisit.edit'));

-- ---------------------------------------------------------------------------
-- documents — document.view / document.upload, and document.delete is OWNER-ONLY
--
-- Deleting an x-ray is unrecoverable, so it stays with the owner permanently.
-- The matching storage.objects policies (see supabase/README.md) enforce the
-- same rule on the bytes, not just on the row.
-- ---------------------------------------------------------------------------

create policy "documents follow document.view"
  on public.documents for select to authenticated
  using (public.petal_has_capability(pet_id, 'document.view'));

create policy "document.upload adds a document"
  on public.documents for insert to authenticated
  with check (
    public.petal_has_capability(pet_id, 'document.upload')
    and uploaded_by = (select auth.uid())
  );

create policy "you can retitle a document you uploaded"
  on public.documents for update to authenticated
  using (
    public.petal_is_owner(pet_id)
    or (uploaded_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'document.upload'))
  )
  with check (
    public.petal_is_owner(pet_id)
    or (uploaded_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'document.upload'))
  );

create policy "only the owner deletes documents"
  on public.documents for delete to authenticated
  using (public.petal_is_owner(pet_id));

-- ---------------------------------------------------------------------------
-- feeding_schedules — feeding.view / feeding.schedule.edit
-- ---------------------------------------------------------------------------

create policy "schedules follow feeding.view"
  on public.feeding_schedules for select to authenticated
  using (public.petal_has_capability(pet_id, 'feeding.view'));

create policy "feeding.schedule.edit adds a schedule"
  on public.feeding_schedules for insert to authenticated
  with check (public.petal_has_capability(pet_id, 'feeding.schedule.edit'));

create policy "feeding.schedule.edit updates a schedule"
  on public.feeding_schedules for update to authenticated
  using (public.petal_has_capability(pet_id, 'feeding.schedule.edit'))
  with check (public.petal_has_capability(pet_id, 'feeding.schedule.edit'));

create policy "feeding.schedule.edit deletes a schedule"
  on public.feeding_schedules for delete to authenticated
  using (public.petal_has_capability(pet_id, 'feeding.schedule.edit'));

-- ---------------------------------------------------------------------------
-- feeding_logs — feeding.view / feeding.log
-- ---------------------------------------------------------------------------

create policy "meal logs follow feeding.view"
  on public.feeding_logs for select to authenticated
  using (public.petal_has_capability(pet_id, 'feeding.view'));

create policy "feeding.log ticks off a meal"
  on public.feeding_logs for insert to authenticated
  with check (
    public.petal_has_capability(pet_id, 'feeding.log')
    and logged_by = (select auth.uid())
  );

create policy "you can amend a meal you logged"
  on public.feeding_logs for update to authenticated
  using (
    public.petal_is_owner(pet_id)
    or (logged_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'feeding.log'))
  )
  with check (
    public.petal_is_owner(pet_id)
    or (logged_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'feeding.log'))
  );

create policy "you can undo a meal you logged"
  on public.feeding_logs for delete to authenticated
  using (
    public.petal_is_owner(pet_id)
    or (logged_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'feeding.log'))
  );

-- ---------------------------------------------------------------------------
-- medicines — medicine.view to read; medicine.edit is OWNER-ONLY to write
--
-- A sitter logs doses; they never change the prescription. The pack count still
-- has to move when they log one, which is why petal_sync_remaining_doses() in
-- 0001 is SECURITY DEFINER — it is the one sanctioned write here that isn't the
-- owner's.
-- ---------------------------------------------------------------------------

create policy "medicines follow medicine.view"
  on public.medicines for select to authenticated
  using (public.petal_has_capability(pet_id, 'medicine.view'));

create policy "only the owner adds a medicine"
  on public.medicines for insert to authenticated
  with check (public.petal_is_owner(pet_id));

create policy "only the owner edits a medicine"
  on public.medicines for update to authenticated
  using (public.petal_is_owner(pet_id))
  with check (public.petal_is_owner(pet_id));

create policy "only the owner deletes a medicine"
  on public.medicines for delete to authenticated
  using (public.petal_is_owner(pet_id));

-- ---------------------------------------------------------------------------
-- medicine_logs — medicine.view / medicine.log
-- ---------------------------------------------------------------------------

create policy "dose logs follow medicine.view"
  on public.medicine_logs for select to authenticated
  using (public.petal_has_capability(pet_id, 'medicine.view'));

create policy "medicine.log records a dose"
  on public.medicine_logs for insert to authenticated
  with check (
    public.petal_has_capability(pet_id, 'medicine.log')
    and logged_by = (select auth.uid())
  );

create policy "you can correct a dose you logged"
  on public.medicine_logs for update to authenticated
  using (
    public.petal_is_owner(pet_id)
    or (logged_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'medicine.log'))
  )
  with check (
    public.petal_is_owner(pet_id)
    or (logged_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'medicine.log'))
  );

create policy "you can undo a dose you logged"
  on public.medicine_logs for delete to authenticated
  using (
    public.petal_is_owner(pet_id)
    or (logged_by = (select auth.uid())
        and public.petal_has_capability(pet_id, 'medicine.log'))
  );

-- ---------------------------------------------------------------------------
-- appointments — appointment.view / create / edit
-- ---------------------------------------------------------------------------

create policy "appointments follow appointment.view"
  on public.appointments for select to authenticated
  using (public.petal_has_capability(pet_id, 'appointment.view'));

create policy "appointment.create books a visit"
  on public.appointments for insert to authenticated
  with check (
    public.petal_has_capability(pet_id, 'appointment.create')
    and created_by = (select auth.uid())
  );

create policy "appointment.edit reschedules a visit"
  on public.appointments for update to authenticated
  using (public.petal_has_capability(pet_id, 'appointment.edit'))
  with check (public.petal_has_capability(pet_id, 'appointment.edit'));

create policy "appointment.edit cancels a visit"
  on public.appointments for delete to authenticated
  using (public.petal_has_capability(pet_id, 'appointment.edit'));

-- ---------------------------------------------------------------------------
-- activity_events — activity.view is OWNER-ONLY, and the log is append-only
--
-- Anyone who can act on the pet can write their own line into it; nobody can
-- edit or erase one, including the owner. An audit trail you can rewrite is not
-- an audit trail.
-- ---------------------------------------------------------------------------

-- Written as petal_is_owner(), NOT petal_has_capability(pet_id, 'activity.view').
-- The two are equivalent today only because 'activity.view' happens to sit
-- outside the caregiver ceiling — so the capability form collapses to the owner
-- check by accident. The day someone adds 'activity.view' to
-- petal_caregiver_grantable() (a very reasonable future feature: let a sitter
-- see their own log), the capability form would silently stop meaning "owner
-- only" while this policy's name still claimed it did. Owner-only intent gets
-- stated directly.
create policy "only the owner reads the activity log"
  on public.activity_events for select to authenticated
  using (public.petal_is_owner(pet_id));

create policy "members append their own activity"
  on public.activity_events for insert to authenticated
  with check (
    public.petal_has_capability(pet_id, 'pet.view')
    and actor_id = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- community
--
-- Groups are a curated directory: readable by everyone signed in, writable only
-- with the service role (seeding, moderation). Posts and comments are public to
-- signed-in users; likes are private — you can see your own, not who else liked.
-- ---------------------------------------------------------------------------

create policy "groups are readable by signed-in users"
  on public.groups for select to authenticated
  using (true);

create policy "you see your own group memberships"
  on public.group_members for select to authenticated
  using (user_id = (select auth.uid()));

create policy "you can join a group"
  on public.group_members for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "you can leave a group"
  on public.group_members for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "posts are readable by signed-in users"
  on public.posts for select to authenticated
  using (true);

-- Posting *as* a pet needs community.post on that pet — which is why a sitter's
-- post carries the "sitting" badge instead of being blocked outright.
create policy "you post as yourself, and only about pets you may post about"
  on public.posts for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and (pet_id is null or public.petal_has_capability(pet_id, 'community.post'))
  );

create policy "you can edit your own post"
  on public.posts for update to authenticated
  using (author_id = (select auth.uid()))
  with check (
    author_id = (select auth.uid())
    and (pet_id is null or public.petal_has_capability(pet_id, 'community.post'))
  );

create policy "you can delete your own post"
  on public.posts for delete to authenticated
  using (author_id = (select auth.uid()));

create policy "you see your own likes"
  on public.post_likes for select to authenticated
  using (user_id = (select auth.uid()));

create policy "you can like a post"
  on public.post_likes for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "you can unlike a post"
  on public.post_likes for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "comments are readable by signed-in users"
  on public.comments for select to authenticated
  using (true);

create policy "you comment as yourself"
  on public.comments for insert to authenticated
  with check (author_id = (select auth.uid()));

create policy "you can edit your own comment"
  on public.comments for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

-- The post's author can also remove a comment on their own post: the smallest
-- amount of moderation that keeps a pet community pleasant.
create policy "you can delete your comment, or one on your post"
  on public.comments for delete to authenticated
  using (
    author_id = (select auth.uid())
    or exists (
      select 1 from public.posts p
      where p.id = comments.post_id and p.author_id = (select auth.uid())
    )
  );

create policy "you see your own comment likes"
  on public.comment_likes for select to authenticated
  using (user_id = (select auth.uid()));

create policy "you can like a comment"
  on public.comment_likes for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "you can unlike a comment"
  on public.comment_likes for delete to authenticated
  using (user_id = (select auth.uid()));
