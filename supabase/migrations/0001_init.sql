-- ============================================================================
-- Petal — 0001_init.sql
-- Schema: enums, tables, indexes, triggers.
--
-- Conventions, so the app and the database never argue:
--   · snake_case here, camelCase in TypeScript. The mapping lives in exactly one
--     place: src/data/SupabaseAdapter.ts.
--   · Enum labels are byte-identical to the TypeScript string unions in
--     src/data/types.ts, including camelCase ones like 'smallPet' and
--     'twiceDaily'. Do not "tidy" them to snake_case — the adapter passes them
--     through untouched, which is what keeps the two ends provably in sync.
--   · Weights are kilograms. Always. `weightUnit` is a display preference and
--     never reaches this database.
--   · Times-of-day for recurring care are `HH:mm` text, not timestamps. A 7am
--     feed is 7am wherever the owner is standing; storing it as UTC makes it
--     drift an hour the moment they fly somewhere.
--   · Every foreign key is indexed, and every (pet_id, <time>) read path the app
--     actually performs has a composite index behind it.
--
-- Row Level Security is switched on in 0002_rls.sql. Nothing here is readable
-- until that file has run.
-- ============================================================================

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.pet_species as enum (
  'dog', 'cat', 'bird', 'rabbit', 'reptile', 'fish', 'smallPet', 'other'
);

create type public.pet_sex as enum ('male', 'female', 'unknown');

create type public.membership_role as enum ('owner', 'caregiver');

create type public.membership_status as enum ('active', 'pending', 'expired', 'revoked');

create type public.invite_status as enum ('active', 'accepted', 'expired', 'revoked');

create type public.preset_id as enum (
  'viewOnly', 'dailyCare', 'fullSitter', 'vetTrips', 'custom'
);

-- Mirrors CAPABILITIES in src/rbac/permissions.ts, in the same order.
create type public.capability as enum (
  'pet.view',
  'pet.edit',
  'pet.delete',
  'pet.transfer',
  'weight.view',
  'weight.log',
  'vaccination.view',
  'vaccination.edit',
  'vetvisit.view',
  'vetvisit.edit',
  'document.view',
  'document.upload',
  'document.delete',
  'feeding.view',
  'feeding.log',
  'feeding.schedule.edit',
  'medicine.view',
  'medicine.log',
  'medicine.edit',
  'appointment.view',
  'appointment.create',
  'appointment.edit',
  'caregiver.view',
  'caregiver.invite',
  'caregiver.revoke',
  'activity.view',
  'community.post'
);

create type public.vet_visit_type as enum (
  'checkup', 'illness', 'injury', 'dental', 'surgery', 'vaccination', 'other'
);

create type public.document_kind as enum (
  'record', 'xray', 'photo', 'invoice', 'prescription', 'insurance', 'other'
);

create type public.portion_unit as enum ('g', 'ml', 'cup', 'scoop', 'can', 'piece');

create type public.medicine_form as enum (
  'tablet', 'capsule', 'liquid', 'injection', 'topical', 'drops', 'chew', 'inhaler'
);

create type public.medicine_frequency as enum (
  'daily', 'twiceDaily', 'threeTimesDaily', 'everyOtherDay', 'weekly', 'monthly', 'asNeeded'
);

create type public.dose_status as enum ('given', 'skipped', 'missed');

create type public.appointment_type as enum (
  'checkup', 'vaccination', 'dental', 'grooming', 'surgery', 'followUp', 'other'
);

create type public.appointment_status as enum (
  'scheduled', 'confirmed', 'completed', 'cancelled', 'missed'
);

create type public.activity_action as enum (
  'feeding.logged',
  'feeding.skipped',
  'medicine.given',
  'medicine.skipped',
  'weight.recorded',
  'vaccination.updated',
  'vetvisit.created',
  'document.uploaded',
  'appointment.created',
  'appointment.updated',
  'pet.updated',
  'caregiver.invited',
  'caregiver.joined',
  'caregiver.revoked',
  'permission.denied'
);

create type public.group_kind as enum ('breed', 'species', 'topic', 'local');

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

/** Keeps `updated_at` honest without every writer remembering to set it. */
create or replace function public.petal_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

/** CHECK helper — every element of a text[] is a valid 24-hour `HH:mm`. */
create or replace function public.petal_valid_times(times text[])
returns boolean
language sql
immutable
as $$
  select coalesce(bool_and(t ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'), true)
  from unnest(coalesce(times, '{}'::text[])) as t;
$$;

/**
 * The ceiling for caregivers — byte-for-byte CAREGIVER_GRANTABLE from
 * src/rbac/permissions.ts. Anything absent here can never be granted, no matter
 * what a membership row claims: deleting a pet, transferring ownership, editing
 * medicines, deleting documents and managing other caregivers stay with the
 * owner permanently. 0002_rls.sql intersects every caregiver check with this
 * list, which is what makes a tampered `grants` array harmless.
 */
create or replace function public.petal_caregiver_grantable()
returns text[]
language sql
immutable
as $$
  select array[
    'pet.view',
    'weight.view',
    'weight.log',
    'vaccination.view',
    'vetvisit.view',
    'document.view',
    'document.upload',
    'feeding.view',
    'feeding.log',
    'feeding.schedule.edit',
    'medicine.view',
    'medicine.log',
    'appointment.view',
    'appointment.create',
    'appointment.edit',
    'vaccination.edit',
    'vetvisit.edit',
    'community.post'
  ]::text[];
$$;

/** CAREGIVER_BASELINE — held implicitly by every active caregiver. */
create or replace function public.petal_caregiver_baseline()
returns text[]
language sql
immutable
as $$
  select array['pet.view', 'feeding.view', 'medicine.view']::text[];
$$;

/** sanitizeGrants() in SQL: clamp an arbitrary grant list to the ceiling. */
create or replace function public.petal_sanitize_grants(grants public.capability[])
returns public.capability[]
language sql
immutable
as $$
  select coalesce(
    array(
      select distinct g
      from unnest(coalesce(grants, '{}'::public.capability[])) as g
      where g::text = any (public.petal_caregiver_grantable())
    ),
    '{}'::public.capability[]
  );
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth.users row
-- ---------------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text        not null default '',
  display_name text        not null,
  avatar_url   text,
  bio          text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_display_name_len check (char_length(display_name) between 1 and 80),
  constraint profiles_bio_len check (bio is null or char_length(bio) <= 280)
);

create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.petal_touch_updated_at();

/**
 * Provisions a profile the moment an account exists — including OAuth accounts,
 * where the display name arrives under one of three provider-specific keys.
 * SECURITY DEFINER because the inserting role is `supabase_auth_admin`, which
 * has no rights on `public`.
 */
create or replace function public.petal_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Pet person'
    ),
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'avatar_url'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'picture'), '')
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.petal_handle_new_user();

/** Keeps the profile's email in step when the user changes it in auth. */
create or replace function public.petal_handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = coalesce(new.email, '') where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.petal_handle_user_email_change();

-- ---------------------------------------------------------------------------
-- pets
-- ---------------------------------------------------------------------------

create table public.pets (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references public.profiles (id) on delete cascade,
  name                  text not null,
  species               public.pet_species not null,
  breed                 text,
  birthday              date,
  approximate_age_months integer,
  sex                   public.pet_sex not null default 'unknown',
  neutered              boolean,
  color_markings        text,
  photo_url             text,
  microchip_id          text,
  microchip_registry    text,
  -- Denormalised from weight_entries by trigger so pet lists never join.
  current_weight_kg     numeric(6, 3),
  target_weight_kg      numeric(6, 3),
  notes                 text,
  allergies             text[] not null default '{}',
  conditions            text[] not null default '{}',
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint pets_name_len check (char_length(btrim(name)) between 1 and 60),
  constraint pets_age_months check (approximate_age_months is null
                                    or approximate_age_months between 0 and 600),
  constraint pets_weight_positive check (current_weight_kg is null or current_weight_kg > 0),
  constraint pets_target_weight_positive check (target_weight_kg is null or target_weight_kg > 0),
  constraint pets_birthday_sane check (birthday is null or birthday <= current_date)
);

create index pets_owner_id_idx on public.pets (owner_id);
create index pets_owner_active_idx on public.pets (owner_id, created_at) where archived_at is null;

create trigger pets_touch
  before update on public.pets
  for each row execute function public.petal_touch_updated_at();

-- ---------------------------------------------------------------------------
-- memberships — the (user, pet) authorisation row
-- ---------------------------------------------------------------------------

create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  pet_id     uuid not null references public.pets (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       public.membership_role not null default 'caregiver',
  -- Ignored for owners, who hold everything by virtue of pets.owner_id.
  grants     public.capability[] not null default '{}',
  starts_at  timestamptz,
  ends_at    timestamptz,
  status     public.membership_status not null default 'pending',
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_unique_per_pet unique (pet_id, user_id),
  constraint memberships_window_ordered check (starts_at is null
                                               or ends_at is null
                                               or starts_at < ends_at)
);

create index memberships_pet_id_idx on public.memberships (pet_id);
create index memberships_user_id_idx on public.memberships (user_id);
create index memberships_invited_by_idx on public.memberships (invited_by);
-- The hot path for every RLS check: "is this user active on this pet right now".
create index memberships_pet_user_active_idx
  on public.memberships (pet_id, user_id, status)
  where status = 'active';

create trigger memberships_touch
  before update on public.memberships
  for each row execute function public.petal_touch_updated_at();

/**
 * Ownership is rooted in `pets.owner_id`; this mirror row exists so the app can
 * answer "every pet I'm involved with" from one table. Created by trigger rather
 * than by the client, so it exists even for rows inserted from the SQL editor.
 */
create or replace function public.petal_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.memberships (pet_id, user_id, role, grants, status)
  values (new.id, new.owner_id, 'owner', '{}', 'active')
  on conflict (pet_id, user_id) do update
    set role = 'owner', status = 'active', starts_at = null, ends_at = null;
  return new;
end;
$$;

create trigger pets_owner_membership
  after insert on public.pets
  for each row execute function public.petal_owner_membership();

/**
 * Ownership transfer. The previous owner keeps working access as a full
 * caregiver rather than being cut off mid-sentence — losing your pet's history
 * because you handed the record over is not an experience we want to ship.
 */
create or replace function public.petal_transfer_ownership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    update public.memberships
       set role = 'caregiver',
           status = 'active',
           grants = public.petal_caregiver_grantable()::public.capability[]
     where pet_id = new.id and user_id = old.owner_id;

    insert into public.memberships (pet_id, user_id, role, grants, status)
    values (new.id, new.owner_id, 'owner', '{}', 'active')
    on conflict (pet_id, user_id) do update
      set role = 'owner', status = 'active', starts_at = null, ends_at = null;
  end if;
  return new;
end;
$$;

create trigger pets_transfer_ownership
  after update of owner_id on public.pets
  for each row execute function public.petal_transfer_ownership();

-- ---------------------------------------------------------------------------
-- invites
-- ---------------------------------------------------------------------------

create table public.invites (
  id            uuid primary key default gen_random_uuid(),
  pet_id        uuid not null references public.pets (id) on delete cascade,
  -- Human-typeable, e.g. 'BUDDY-4KQ2'. Also encoded in the QR.
  code          text not null,
  created_by    uuid not null references public.profiles (id) on delete cascade,
  preset_id     public.preset_id not null default 'custom',
  grants        public.capability[] not null default '{}',
  starts_at     timestamptz,
  ends_at       timestamptz,
  -- The link dies on its own schedule, separately from the access window.
  expires_at    timestamptz not null,
  max_uses      integer not null default 1,
  uses          integer not null default 0,
  status        public.invite_status not null default 'active',
  invitee_name  text,
  invitee_email text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint invites_code_shape check (code ~ '^[A-Z0-9][A-Z0-9-]{3,31}$'),
  constraint invites_max_uses check (max_uses between 1 and 50),
  constraint invites_uses_bounded check (uses >= 0 and uses <= max_uses),
  constraint invites_window_ordered check (starts_at is null
                                           or ends_at is null
                                           or starts_at < ends_at)
);

create unique index invites_code_key on public.invites (upper(code));
create index invites_pet_id_idx on public.invites (pet_id);
create index invites_created_by_idx on public.invites (created_by);
create index invites_open_idx on public.invites (pet_id, created_at desc) where status = 'active';

create trigger invites_touch
  before update on public.invites
  for each row execute function public.petal_touch_updated_at();

-- ---------------------------------------------------------------------------
-- weight_entries
-- ---------------------------------------------------------------------------

create table public.weight_entries (
  id          uuid primary key default gen_random_uuid(),
  pet_id      uuid not null references public.pets (id) on delete cascade,
  kg          numeric(6, 3) not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null references public.profiles (id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now(),
  constraint weight_entries_kg_sane check (kg > 0 and kg < 1000)
);

create index weight_entries_pet_id_idx on public.weight_entries (pet_id);
create index weight_entries_recorded_by_idx on public.weight_entries (recorded_by);
create index weight_entries_pet_at_idx on public.weight_entries (pet_id, recorded_at desc);

/** Keeps pets.current_weight_kg pointing at the most recent reading. */
create or replace function public.petal_sync_current_weight()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pet uuid := coalesce(new.pet_id, old.pet_id);
begin
  update public.pets p
     set current_weight_kg = (
           select w.kg
           from public.weight_entries w
           where w.pet_id = v_pet
           order by w.recorded_at desc, w.created_at desc
           limit 1
         )
   where p.id = v_pet;
  return null;
end;
$$;

create trigger weight_entries_sync_pet
  after insert or update or delete on public.weight_entries
  for each row execute function public.petal_sync_current_weight();

-- ---------------------------------------------------------------------------
-- vaccinations
-- ---------------------------------------------------------------------------

create table public.vaccinations (
  id              uuid primary key default gen_random_uuid(),
  pet_id          uuid not null references public.pets (id) on delete cascade,
  name            text not null,
  -- Core vs non-core is a clinical distinction, and drives badge weight in the UI.
  core            boolean not null default false,
  administered_at date,
  due_at          date,
  vet_name        text,
  clinic          text,
  batch_number    text,
  notes           text,
  document_ids    uuid[] not null default '{}',
  created_by      uuid not null references public.profiles (id) on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint vaccinations_name_len check (char_length(btrim(name)) between 1 and 120)
);

create index vaccinations_pet_id_idx on public.vaccinations (pet_id);
create index vaccinations_created_by_idx on public.vaccinations (created_by);
create index vaccinations_pet_due_idx on public.vaccinations (pet_id, due_at);

create trigger vaccinations_touch
  before update on public.vaccinations
  for each row execute function public.petal_touch_updated_at();

-- ---------------------------------------------------------------------------
-- vet_visits
-- ---------------------------------------------------------------------------

create table public.vet_visits (
  id           uuid primary key default gen_random_uuid(),
  pet_id       uuid not null references public.pets (id) on delete cascade,
  at           timestamptz not null,
  type         public.vet_visit_type not null default 'checkup',
  reason       text not null,
  vet_name     text,
  clinic       text,
  diagnosis    text,
  treatment    text,
  weight_kg    numeric(6, 3),
  -- Minor units (cents/pence) so no float ever touches money.
  cost_minor   integer,
  currency     text not null default 'USD',
  follow_up_at date,
  notes        text,
  document_ids uuid[] not null default '{}',
  created_by   uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint vet_visits_currency check (currency ~ '^[A-Z]{3}$'),
  constraint vet_visits_cost check (cost_minor is null or cost_minor >= 0),
  constraint vet_visits_weight check (weight_kg is null or (weight_kg > 0 and weight_kg < 1000))
);

create index vet_visits_pet_id_idx on public.vet_visits (pet_id);
create index vet_visits_created_by_idx on public.vet_visits (created_by);
create index vet_visits_pet_at_idx on public.vet_visits (pet_id, at desc);

create trigger vet_visits_touch
  before update on public.vet_visits
  for each row execute function public.petal_touch_updated_at();

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

create table public.documents (
  id             uuid primary key default gen_random_uuid(),
  pet_id         uuid not null references public.pets (id) on delete cascade,
  title          text not null,
  kind           public.document_kind not null default 'record',
  mime_type      text not null default 'application/octet-stream',
  -- Object key inside the `pet-media` bucket: pets/<pet_id>/documents/<id>.<ext>
  storage_path   text not null,
  thumbnail_path text,
  size_bytes     bigint,
  page_count     integer,
  uploaded_by    uuid not null references public.profiles (id) on delete cascade,
  uploaded_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint documents_title_len check (char_length(btrim(title)) between 1 and 140),
  constraint documents_size check (size_bytes is null or size_bytes >= 0),
  constraint documents_pages check (page_count is null or page_count > 0),
  -- Objects must live under their own pet's prefix or the storage policies lie.
  constraint documents_path_scoped check (storage_path like 'pets/' || pet_id::text || '/%')
);

create index documents_pet_id_idx on public.documents (pet_id);
create index documents_uploaded_by_idx on public.documents (uploaded_by);
create index documents_pet_at_idx on public.documents (pet_id, uploaded_at desc);

create trigger documents_touch
  before update on public.documents
  for each row execute function public.petal_touch_updated_at();

-- ---------------------------------------------------------------------------
-- feeding_schedules / feeding_logs
-- ---------------------------------------------------------------------------

create table public.feeding_schedules (
  id           uuid primary key default gen_random_uuid(),
  pet_id       uuid not null references public.pets (id) on delete cascade,
  label        text not null,
  -- 'HH:mm', local to the household. See the header note.
  time_of_day  text not null,
  food_name    text not null,
  portion      numeric(8, 2) not null,
  unit         public.portion_unit not null default 'g',
  -- 0 = Sunday … 6 = Saturday. All seven means daily.
  days_of_week smallint[] not null default '{0,1,2,3,4,5,6}',
  reminders_on boolean not null default true,
  active       boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint feeding_schedules_time check (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  constraint feeding_schedules_portion check (portion > 0),
  constraint feeding_schedules_days check (
    days_of_week <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
    and coalesce(array_length(days_of_week, 1), 0) between 1 and 7
  )
);

create index feeding_schedules_pet_id_idx on public.feeding_schedules (pet_id);
create index feeding_schedules_pet_active_idx
  on public.feeding_schedules (pet_id, time_of_day) where active;

create trigger feeding_schedules_touch
  before update on public.feeding_schedules
  for each row execute function public.petal_touch_updated_at();

create table public.feeding_logs (
  id          uuid primary key default gen_random_uuid(),
  pet_id      uuid not null references public.pets (id) on delete cascade,
  -- Null for an unscheduled snack. Kept (not cascaded) if the schedule is deleted.
  schedule_id uuid references public.feeding_schedules (id) on delete set null,
  at          timestamptz not null default now(),
  food_name   text not null,
  portion     numeric(8, 2) not null,
  unit        public.portion_unit not null default 'g',
  -- A skipped meal is data, not an absence — vets ask about appetite.
  skipped     boolean not null default false,
  logged_by   uuid not null references public.profiles (id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now(),
  constraint feeding_logs_portion check (portion >= 0)
);

create index feeding_logs_pet_id_idx on public.feeding_logs (pet_id);
create index feeding_logs_schedule_id_idx on public.feeding_logs (schedule_id);
create index feeding_logs_logged_by_idx on public.feeding_logs (logged_by);
create index feeding_logs_pet_at_idx on public.feeding_logs (pet_id, at desc);
create index feeding_logs_schedule_at_idx on public.feeding_logs (schedule_id, at desc);

-- ---------------------------------------------------------------------------
-- medicines / medicine_logs
-- ---------------------------------------------------------------------------

create table public.medicines (
  id              uuid primary key default gen_random_uuid(),
  pet_id          uuid not null references public.pets (id) on delete cascade,
  name            text not null,
  form            public.medicine_form not null default 'tablet',
  dosage          text not null,
  frequency       public.medicine_frequency not null default 'daily',
  times_of_day    text[] not null default '{}',
  starts_at       date not null default current_date,
  -- Null for ongoing / lifelong medication.
  ends_at         date,
  -- Doses left in the current pack — drives the refill nudge.
  remaining_doses integer,
  refill_at       date,
  prescribed_by   text,
  instructions    text,
  with_food       boolean not null default false,
  reminders_on    boolean not null default true,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint medicines_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint medicines_times check (public.petal_valid_times(times_of_day)),
  constraint medicines_window check (ends_at is null or ends_at >= starts_at),
  constraint medicines_remaining check (remaining_doses is null or remaining_doses >= 0)
);

create index medicines_pet_id_idx on public.medicines (pet_id);
create index medicines_pet_active_idx on public.medicines (pet_id, starts_at) where active;

create trigger medicines_touch
  before update on public.medicines
  for each row execute function public.petal_touch_updated_at();

create table public.medicine_logs (
  id            uuid primary key default gen_random_uuid(),
  pet_id        uuid not null references public.pets (id) on delete cascade,
  medicine_id   uuid not null references public.medicines (id) on delete cascade,
  -- The slot this dose belongs to, so adherence maths can find the gaps.
  scheduled_for timestamptz not null,
  at            timestamptz,
  status        public.dose_status not null,
  dosage        text,
  logged_by     uuid not null references public.profiles (id) on delete cascade,
  note          text,
  created_at    timestamptz not null default now()
);

create index medicine_logs_pet_id_idx on public.medicine_logs (pet_id);
create index medicine_logs_medicine_id_idx on public.medicine_logs (medicine_id);
create index medicine_logs_logged_by_idx on public.medicine_logs (logged_by);
create index medicine_logs_pet_at_idx on public.medicine_logs (pet_id, scheduled_for desc);
-- One row per slot: re-logging the same dose corrects it instead of double-counting.
-- (A plain column pair, not `date_trunc(...)` — index expressions must be
-- IMMUTABLE and date_trunc on timestamptz is only STABLE. The client always
-- sends the exact slot instant, so equality is the right key anyway.)
create unique index medicine_logs_slot_key
  on public.medicine_logs (medicine_id, scheduled_for);

/**
 * A caregiver may hold `medicine.log` but never `medicine.edit`, so they cannot
 * write to `medicines` — yet the pack count has to fall when they give a dose.
 * SECURITY DEFINER lets the trigger do the decrement on their behalf, which is
 * the only reason "2 doses left" stays true when someone else is sitting.
 */
create or replace function public.petal_sync_remaining_doses()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' and new.status = 'given' then
    update public.medicines
       set remaining_doses = greatest(remaining_doses - 1, 0)
     where id = new.medicine_id and remaining_doses is not null;

  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'given' then
      update public.medicines
         set remaining_doses = greatest(remaining_doses - 1, 0)
       where id = new.medicine_id and remaining_doses is not null;
    elsif old.status = 'given' then
      update public.medicines
         set remaining_doses = remaining_doses + 1
       where id = new.medicine_id and remaining_doses is not null;
    end if;

  elsif tg_op = 'DELETE' and old.status = 'given' then
    update public.medicines
       set remaining_doses = remaining_doses + 1
     where id = old.medicine_id and remaining_doses is not null;
  end if;

  return null;
end;
$$;

create trigger medicine_logs_sync_remaining
  after insert or update or delete on public.medicine_logs
  for each row execute function public.petal_sync_remaining_doses();

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------

create table public.appointments (
  id                    uuid primary key default gen_random_uuid(),
  pet_id                uuid not null references public.pets (id) on delete cascade,
  at                    timestamptz not null,
  duration_min          integer not null default 30,
  type                  public.appointment_type not null default 'checkup',
  reason                text not null,
  clinic                text,
  clinic_phone          text,
  clinic_address        text,
  vet_name              text,
  status                public.appointment_status not null default 'scheduled',
  notes                 text,
  -- Minutes before `at` to fire reminders; multiple allowed (a day + an hour).
  reminder_offsets      integer[] not null default '{1440,60}',
  linked_document_ids   uuid[] not null default '{}',
  linked_vaccination_ids uuid[] not null default '{}',
  -- Set once the visit is written up.
  vet_visit_id          uuid references public.vet_visits (id) on delete set null,
  created_by            uuid not null references public.profiles (id) on delete cascade,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint appointments_duration check (duration_min between 5 and 1440),
  constraint appointments_reason_len check (char_length(btrim(reason)) between 1 and 200)
);

create index appointments_pet_id_idx on public.appointments (pet_id);
create index appointments_created_by_idx on public.appointments (created_by);
create index appointments_vet_visit_id_idx on public.appointments (vet_visit_id);
create index appointments_pet_at_idx on public.appointments (pet_id, at);
create index appointments_upcoming_idx
  on public.appointments (at) where status in ('scheduled', 'confirmed');

create trigger appointments_touch
  before update on public.appointments
  for each row execute function public.petal_touch_updated_at();

-- ---------------------------------------------------------------------------
-- activity_events — append-only audit trail
-- ---------------------------------------------------------------------------

create table public.activity_events (
  id         uuid primary key default gen_random_uuid(),
  pet_id     uuid not null references public.pets (id) on delete cascade,
  actor_id   uuid not null references public.profiles (id) on delete cascade,
  actor_role public.membership_role not null default 'caregiver',
  action     public.activity_action not null,
  -- Pre-rendered sentence: "Priya logged Buddy's dinner (120 g kibble)".
  summary    text not null,
  entity_id  uuid,
  at         timestamptz not null default now(),
  meta       jsonb not null default '{}'::jsonb
);

create index activity_events_pet_id_idx on public.activity_events (pet_id);
create index activity_events_actor_id_idx on public.activity_events (actor_id);
create index activity_events_pet_at_idx on public.activity_events (pet_id, at desc);

/**
 * The client sends the role it believes it holds; the log records the one the
 * database can prove. An audit line that says "owner" because the caller said so
 * is worse than no audit line at all.
 */
create or replace function public.petal_stamp_actor_role()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.actor_role := case
    when exists (
      select 1 from public.pets p
      where p.id = new.pet_id and p.owner_id = new.actor_id
    ) then 'owner'::public.membership_role
    else 'caregiver'::public.membership_role
  end;
  return new;
end;
$$;

create trigger activity_events_stamp_role
  before insert on public.activity_events
  for each row execute function public.petal_stamp_actor_role();

-- ---------------------------------------------------------------------------
-- community: groups / posts / comments
-- ---------------------------------------------------------------------------

create table public.groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text not null,
  kind         public.group_kind not null default 'topic',
  description  text not null default '',
  -- Denormalised counters, maintained by trigger.
  member_count integer not null default 0,
  post_count   integer not null default 0,
  -- Deterministic cover tint so group cards feel authored, not random.
  accent       text not null default '#4F8149',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint groups_slug_shape check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint groups_accent_shape check (accent ~ '^#[0-9A-Fa-f]{6}$')
);

create unique index groups_slug_key on public.groups (slug);

create trigger groups_touch
  before update on public.groups
  for each row execute function public.petal_touch_updated_at();

create table public.group_members (
  group_id  uuid not null references public.groups (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index group_members_group_id_idx on public.group_members (group_id);
create index group_members_user_id_idx on public.group_members (user_id);

create table public.posts (
  id                   uuid primary key default gen_random_uuid(),
  author_id            uuid not null references public.profiles (id) on delete cascade,
  -- Posts can be "as" a pet — that's the whole charm of a pet community.
  pet_id               uuid references public.pets (id) on delete set null,
  group_id             uuid references public.groups (id) on delete set null,
  body                 text not null,
  image_urls           text[] not null default '{}',
  like_count           integer not null default 0,
  comment_count        integer not null default 0,
  -- Derived by trigger, never trusted from the client.
  posted_while_sitting boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint posts_body_len check (char_length(btrim(body)) between 1 and 2000),
  constraint posts_images check (coalesce(array_length(image_urls, 1), 0) <= 4)
);

create index posts_author_id_idx on public.posts (author_id);
create index posts_pet_id_idx on public.posts (pet_id);
create index posts_group_id_idx on public.posts (group_id);
create index posts_created_at_idx on public.posts (created_at desc);
create index posts_group_created_idx on public.posts (group_id, created_at desc);

create trigger posts_touch
  before update on public.posts
  for each row execute function public.petal_touch_updated_at();

create table public.post_likes (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index post_likes_post_id_idx on public.post_likes (post_id);
create index post_likes_user_id_idx on public.post_likes (user_id);

create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  author_id  uuid not null references public.profiles (id) on delete cascade,
  body       text not null,
  like_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comments_body_len check (char_length(btrim(body)) between 1 and 1000)
);

create index comments_post_id_idx on public.comments (post_id);
create index comments_author_id_idx on public.comments (author_id);
create index comments_post_created_idx on public.comments (post_id, created_at);

create trigger comments_touch
  before update on public.comments
  for each row execute function public.petal_touch_updated_at();

create table public.comment_likes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create index comment_likes_comment_id_idx on public.comment_likes (comment_id);
create index comment_likes_user_id_idx on public.comment_likes (user_id);

-- ---------------------------------------------------------------------------
-- Counter triggers
--
-- Counts live on the row they describe so a feed of 20 posts is one query, not
-- 41. All of these are SECURITY DEFINER: liking someone else's post has to bump
-- their post's counter, and RLS (correctly) will not let you update their row.
-- ---------------------------------------------------------------------------

create or replace function public.petal_sync_post_like_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set like_count = like_count + 1 where id = new.post_id;
  else
    update public.posts set like_count = greatest(like_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

create trigger post_likes_count
  after insert or delete on public.post_likes
  for each row execute function public.petal_sync_post_like_count();

create or replace function public.petal_sync_comment_like_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.comments set like_count = like_count + 1 where id = new.comment_id;
  else
    update public.comments set like_count = greatest(like_count - 1, 0) where id = old.comment_id;
  end if;
  return null;
end;
$$;

create trigger comment_likes_count
  after insert or delete on public.comment_likes
  for each row execute function public.petal_sync_comment_like_count();

create or replace function public.petal_sync_post_comment_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  else
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

create trigger comments_post_count
  after insert or delete on public.comments
  for each row execute function public.petal_sync_post_comment_count();

create or replace function public.petal_sync_group_member_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.groups set member_count = member_count + 1 where id = new.group_id;
  else
    update public.groups set member_count = greatest(member_count - 1, 0) where id = old.group_id;
  end if;
  return null;
end;
$$;

create trigger group_members_count
  after insert or delete on public.group_members
  for each row execute function public.petal_sync_group_member_count();

create or replace function public.petal_sync_group_post_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' and new.group_id is not null then
    update public.groups set post_count = post_count + 1 where id = new.group_id;
  elsif tg_op = 'DELETE' and old.group_id is not null then
    update public.groups set post_count = greatest(post_count - 1, 0) where id = old.group_id;
  elsif tg_op = 'UPDATE' and new.group_id is distinct from old.group_id then
    if old.group_id is not null then
      update public.groups set post_count = greatest(post_count - 1, 0) where id = old.group_id;
    end if;
    if new.group_id is not null then
      update public.groups set post_count = post_count + 1 where id = new.group_id;
    end if;
  end if;
  return null;
end;
$$;

create trigger posts_group_count
  after insert or update or delete on public.posts
  for each row execute function public.petal_sync_group_post_count();

/**
 * "Posted while sitting" is a trust signal, so it is computed from ownership at
 * write time rather than accepted from the client.
 */
create or replace function public.petal_mark_posted_while_sitting()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.posted_while_sitting := new.pet_id is not null and exists (
    select 1 from public.pets p
    where p.id = new.pet_id and p.owner_id is distinct from new.author_id
  );
  return new;
end;
$$;

create trigger posts_mark_sitting
  before insert or update of pet_id, author_id on public.posts
  for each row execute function public.petal_mark_posted_while_sitting();

-- ---------------------------------------------------------------------------
-- pet_cards — the only pet data the community feed may see
--
-- A post can be *about* a pet you have no membership on, and the feed still has
-- to show "Buddy 🐶". Loosening RLS on `pets` would expose microchip numbers and
-- medical notes to the whole app, so instead this view exposes the four fields a
-- card needs. `security_invoker = false` (the PostgreSQL 15 default, stated
-- explicitly here because it is load-bearing) means it runs as the view owner
-- and is not filtered by the pets policies.
-- ---------------------------------------------------------------------------

create view public.pet_cards with (security_invoker = false) as
  select p.id, p.owner_id, p.name, p.species, p.breed, p.photo_url, p.created_at
  from public.pets p
  where p.id in (select distinct pet_id from public.posts where pet_id is not null);
