-- ============================================================================
-- Petal — 0003_functions.sql
-- Remote procedures the app calls with `supabase.rpc(...)`.
--
-- Two categories, and the distinction matters:
--
--   · SECURITY DEFINER — accept_invite() and peek_invite(). Both are used by
--     someone who has *no* relationship to the pet yet, so no policy in
--     0002_rls.sql could ever let them through. Each does its own authorisation
--     in the body, and each is deliberately narrow about what it returns.
--
--   · SECURITY INVOKER (the default) — care_tasks_for_day(),
--     care_day_summaries() and adherence_summary(). These read tables the caller
--     already has policies for, so RLS does the filtering for free: a sitter
--     with feeding.log but no medicine.view gets a day of meals and no doses,
--     without a single extra check written here.
--
-- Time zones: recurring care is stored as 'HH:mm' local text, so turning a
-- schedule into an instant needs to know *whose* local. `p_tz` carries the
-- device's IANA zone (the adapter passes Intl's resolved zone, falling back to
-- UTC). Without it a 7am feed would be marked overdue at midnight in Sydney.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- peek_invite(code) — the invite preview screen, before there's a membership
-- ---------------------------------------------------------------------------

/**
 * Returns just enough to render "Priya wants you to look after Buddy":
 * the invite terms, an identity-only pet card, and the owner's public profile.
 * Never the pet's medical record — the holder of a code is a stranger until
 * they accept, and codes are short enough to be guessed at.
 *
 * Returns NULL for anything unusable (unknown, revoked, expired, used up) so
 * the client renders one honest "this invite has expired" state instead of
 * branching on five error strings.
 */
create or replace function public.peek_invite(code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.invites;
  v_pet    public.pets;
  v_owner  public.profiles;
begin
  if code is null or btrim(code) = '' then
    return null;
  end if;

  select i.* into v_invite
  from public.invites i
  where upper(i.code) = upper(btrim(peek_invite.code));

  if not found then return null; end if;
  if v_invite.status <> 'active' then return null; end if;
  if v_invite.expires_at <= now() then return null; end if;
  if v_invite.uses >= v_invite.max_uses then return null; end if;

  select p.* into v_pet from public.pets p where p.id = v_invite.pet_id;
  if not found then return null; end if;

  select pr.* into v_owner from public.profiles pr where pr.id = v_pet.owner_id;
  if not found then return null; end if;

  return jsonb_build_object(
    'invite', jsonb_build_object(
      'id',           v_invite.id,
      'petId',        v_invite.pet_id,
      'code',         v_invite.code,
      'createdBy',    v_invite.created_by,
      'presetId',     v_invite.preset_id,
      'grants',       to_jsonb(v_invite.grants),
      'startsAt',     v_invite.starts_at,
      'endsAt',       v_invite.ends_at,
      'expiresAt',    v_invite.expires_at,
      'maxUses',      v_invite.max_uses,
      'uses',         v_invite.uses,
      'status',       v_invite.status,
      'inviteeName',  v_invite.invitee_name,
      'inviteeEmail', v_invite.invitee_email,
      'createdAt',    v_invite.created_at
    ),
    'pet', jsonb_build_object(
      'id',        v_pet.id,
      'ownerId',   v_pet.owner_id,
      'name',      v_pet.name,
      'species',   v_pet.species,
      'breed',     v_pet.breed,
      'photoUrl',  v_pet.photo_url,
      'createdAt', v_pet.created_at
    ),
    'owner', jsonb_build_object(
      'id',          v_owner.id,
      'displayName', v_owner.display_name,
      'avatarUrl',   v_owner.avatar_url,
      'bio',         v_owner.bio,
      'createdAt',   v_owner.created_at
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_invite(code) — turns a code into a membership
-- ---------------------------------------------------------------------------

/**
 * The one write in the app performed by someone with no prior access, so every
 * guard lives in this body:
 *
 *   · signed in                         (anonymous callers get 42501)
 *   · invite exists, active, unexpired, uses remaining  — under FOR UPDATE, so
 *     two phones scanning the same single-use QR can't both win
 *   · grants clamped through petal_sanitize_grants(), so an invite row edited to
 *     contain 'pet.delete' still produces a membership that cannot delete
 *   · role forced to 'caregiver'; ownership only ever comes from pets.owner_id
 *
 * Re-accepting is idempotent: it refreshes the window and grants rather than
 * erroring, which is what makes "the owner sent me a new invite with longer
 * dates" work without anyone having to remove the old membership first.
 */
create or replace function public.accept_invite(code text)
returns public.memberships
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_invite     public.invites;
  v_membership public.memberships;
  v_pet_name   text;
  v_joiner     text;
begin
  if v_uid is null then
    raise exception 'Sign in to accept this invite.' using errcode = '42501';
  end if;

  select i.* into v_invite
  from public.invites i
  where upper(i.code) = upper(btrim(accept_invite.code))
  for update;

  if not found then
    raise exception 'That code doesn''t match any invite.' using errcode = 'P0002';
  end if;

  if v_invite.expires_at <= now() then
    update public.invites set status = 'expired' where id = v_invite.id and status = 'active';
    raise exception 'This invite link has expired. Ask the owner for a new one.'
      using errcode = 'P0001';
  end if;

  if v_invite.status = 'revoked' then
    raise exception 'This invite was turned off by the owner.' using errcode = 'P0001';
  end if;

  if v_invite.status <> 'active' or v_invite.uses >= v_invite.max_uses then
    raise exception 'This invite has already been used.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.pets p where p.id = v_invite.pet_id and p.owner_id = v_uid) then
    raise exception 'You already own this pet.' using errcode = 'P0001';
  end if;

  insert into public.memberships (
    pet_id, user_id, role, grants, starts_at, ends_at, status, invited_by
  )
  values (
    v_invite.pet_id,
    v_uid,
    'caregiver',
    public.petal_sanitize_grants(v_invite.grants),
    v_invite.starts_at,
    v_invite.ends_at,
    'active',
    v_invite.created_by
  )
  on conflict (pet_id, user_id) do update
    set grants    = excluded.grants,
        starts_at = excluded.starts_at,
        ends_at   = excluded.ends_at,
        status    = 'active',
        invited_by = excluded.invited_by
    -- Guard: an owner row must never be demoted by accepting an invite.
    where memberships.role = 'caregiver'
  returning * into v_membership;

  if v_membership.id is null then
    raise exception 'You already have access to this pet.' using errcode = 'P0001';
  end if;

  update public.invites
     set uses   = uses + 1,
         status = case when uses + 1 >= max_uses then 'accepted' else status end
   where id = v_invite.id;

  select p.name into v_pet_name from public.pets p where p.id = v_invite.pet_id;
  select pr.display_name into v_joiner from public.profiles pr where pr.id = v_uid;

  insert into public.activity_events (
    pet_id, actor_id, actor_role, action, summary, entity_id, meta
  )
  values (
    v_invite.pet_id,
    v_uid,
    'caregiver',
    'caregiver.joined',
    coalesce(v_joiner, 'A caregiver') || ' joined as a caregiver for ' ||
      coalesce(v_pet_name, 'this pet'),
    v_membership.id,
    jsonb_build_object(
      'inviteId', v_invite.id::text,
      'presetId', v_invite.preset_id::text
    )
  );

  return v_membership;
end;
$$;

-- ---------------------------------------------------------------------------
-- care_tasks_for_day(pet, date, tz) — the Today timeline
-- ---------------------------------------------------------------------------

/**
 * Feeding, medicine and appointments as one normalised stream, which is what
 * makes "3 of 7 done" honest — three lists stapled together can't be counted.
 *
 * `state` for anything already logged is final ('done' / 'skipped'). For
 * anything still open it is computed against now() with a 30-minute grace
 * either side, and the client recomputes it from the device clock so a task
 * doesn't sit there saying "upcoming" while the phone shows a later time.
 */
create or replace function public.care_tasks_for_day(
  p_pet  uuid,
  p_date date,
  p_tz   text default 'UTC'
)
returns table (
  id           text,
  kind         text,
  pet_id       uuid,
  at           timestamptz,
  title        text,
  subtitle     text,
  state        text,
  source_id    uuid,
  requires     text,
  completed_by uuid,
  completed_at timestamptz,
  meta         jsonb
)
language sql
stable
as $$
  with bounds as (
    select
      (p_date::timestamp) at time zone p_tz         as day_start,
      ((p_date + 1)::timestamp) at time zone p_tz   as day_end,
      now()                                         as now_at
  ),

  feeding as (
    select
      'feeding:' || s.id::text || ':' ||
        to_char(slot.slot_at at time zone p_tz, 'YYYYMMDDHH24MI')       as id,
      'feeding'                                                        as kind,
      s.pet_id                                                         as pet_id,
      slot.slot_at                                                     as at,
      s.label                                                          as title,
      -- 120.00 → '120', 12.50 → '12.5'. The format always emits two decimals,
      -- so stripping trailing zeros then a bare point is safe.
      rtrim(rtrim(to_char(s.portion, 'FM999999990.99'), '0'), '.') ||
        ' ' || s.unit::text || ' · ' || s.food_name                    as subtitle,
      case
        when l.id is not null and l.skipped then 'skipped'
        when l.id is not null               then 'done'
        when slot.slot_at <  b.now_at - interval '30 minutes' then 'overdue'
        when slot.slot_at <= b.now_at + interval '30 minutes' then 'due'
        else 'upcoming'
      end                                                              as state,
      s.id                                                             as source_id,
      'feeding.log'                                                    as requires,
      l.logged_by                                                      as completed_by,
      l.at                                                             as completed_at,
      jsonb_build_object(
        'scheduleId', s.id::text,
        'foodName',   s.food_name,
        'portion',    s.portion::float8,
        'unit',       s.unit::text,
        'logId',      l.id::text
      )                                                                as meta
    from public.feeding_schedules s
    cross join bounds b
    cross join lateral (
      select (p_date::timestamp + s.time_of_day::time) at time zone p_tz as slot_at
    ) slot
    left join lateral (
      select fl.id, fl.at, fl.skipped, fl.logged_by
      from public.feeding_logs fl
      where fl.schedule_id = s.id
        and fl.at >= b.day_start
        and fl.at <  b.day_end
      order by fl.at desc
      limit 1
    ) l on true
    where s.pet_id = p_pet
      and s.active
      and extract(dow from p_date)::smallint = any (s.days_of_week)
  ),

  medicine as (
    select
      'medicine:' || m.id::text || ':' ||
        to_char(slot.slot_at at time zone p_tz, 'YYYYMMDDHH24MI')      as id,
      'medicine'                                                       as kind,
      m.pet_id                                                         as pet_id,
      slot.slot_at                                                     as at,
      m.name                                                           as title,
      m.dosage ||
        case when m.with_food then ' · with food' else '' end          as subtitle,
      case
        when l.status = 'given'   then 'done'
        when l.status = 'skipped' then 'skipped'
        when l.status = 'missed'  then 'overdue'
        when slot.slot_at <  b.now_at - interval '30 minutes' then 'overdue'
        when slot.slot_at <= b.now_at + interval '30 minutes' then 'due'
        else 'upcoming'
      end                                                              as state,
      m.id                                                             as source_id,
      'medicine.log'                                                   as requires,
      l.logged_by                                                      as completed_by,
      l.at                                                             as completed_at,
      jsonb_build_object(
        'medicineId',     m.id::text,
        'dosage',         m.dosage,
        'form',           m.form::text,
        'withFood',       m.with_food,
        'remainingDoses', m.remaining_doses,
        'logId',          l.id::text
      )                                                                as meta
    from public.medicines m
    cross join bounds b
    cross join lateral unnest(m.times_of_day) as slot_times(time_text)
    cross join lateral (
      select (p_date::timestamp + slot_times.time_text::time) at time zone p_tz as slot_at
    ) slot
    left join lateral (
      select ml.id, ml.at, ml.status, ml.logged_by
      from public.medicine_logs ml
      where ml.medicine_id = m.id
        and date_trunc('minute', ml.scheduled_for) = date_trunc('minute', slot.slot_at)
      limit 1
    ) l on true
    where m.pet_id = p_pet
      and m.active
      and m.starts_at <= p_date
      and (m.ends_at is null or m.ends_at >= p_date)
      and case m.frequency
            when 'everyOtherDay' then ((p_date - m.starts_at) % 2) = 0
            when 'weekly'        then ((p_date - m.starts_at) % 7) = 0
            when 'monthly'       then extract(day from p_date) = extract(day from m.starts_at)
            -- As-needed medicine has no slots; it's logged ad hoc.
            when 'asNeeded'      then false
            else true
          end
  ),

  visits as (
    select
      'appointment:' || a.id::text                                     as id,
      'appointment'                                                    as kind,
      a.pet_id                                                         as pet_id,
      a.at                                                             as at,
      a.reason                                                         as title,
      coalesce(
        nullif(btrim(a.clinic), ''),
        nullif(btrim(a.vet_name), ''),
        case a.type
          when 'checkup'     then 'Check-up'
          when 'vaccination' then 'Vaccination'
          when 'dental'      then 'Dental'
          when 'grooming'    then 'Grooming'
          when 'surgery'     then 'Surgery'
          when 'followUp'    then 'Follow-up'
          else 'Appointment'
        end
      )                                                                as subtitle,
      case
        when a.status = 'completed' then 'done'
        when a.status = 'cancelled' then 'skipped'
        when a.status = 'missed'    then 'overdue'
        when a.at <  b.now_at - interval '30 minutes' then 'overdue'
        when a.at <= b.now_at + interval '30 minutes' then 'due'
        else 'upcoming'
      end                                                              as state,
      a.id                                                             as source_id,
      'appointment.edit'                                               as requires,
      null::uuid                                                       as completed_by,
      case when a.status = 'completed' then a.updated_at end           as completed_at,
      jsonb_build_object(
        'type',        a.type::text,
        'status',      a.status::text,
        'durationMin', a.duration_min,
        'clinic',      a.clinic,
        'vetName',     a.vet_name
      )                                                                as meta
    from public.appointments a
    cross join bounds b
    where a.pet_id = p_pet
      and a.at >= b.day_start
      and a.at <  b.day_end
  )

  select * from feeding
  union all
  select * from medicine
  union all
  select * from visits
  order by 4, 5;
$$;

-- ---------------------------------------------------------------------------
-- care_day_summaries(pet, from, to, tz) — the week/month strip
-- ---------------------------------------------------------------------------

/**
 * `done` counts only genuinely completed tasks. A skipped meal is neither done
 * nor overdue: it was a decision, and the ring shouldn't punish it or take
 * credit for it.
 */
create or replace function public.care_day_summaries(
  p_pet  uuid,
  p_from date,
  p_to   date,
  p_tz   text default 'UTC'
)
returns table (
  date    date,
  total   integer,
  done    integer,
  overdue integer
)
language sql
stable
as $$
  select
    series.day::date                                            as date,
    count(t.id)::integer                                        as total,
    count(t.id) filter (where t.state = 'done')::integer         as done,
    count(t.id) filter (where t.state = 'overdue')::integer      as overdue
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as series(day)
  left join lateral public.care_tasks_for_day(p_pet, series.day::date, p_tz) t on true
  group by series.day
  order by series.day;
$$;

-- ---------------------------------------------------------------------------
-- adherence_summary(medicine, days, tz) — the ring + sparkline
-- ---------------------------------------------------------------------------

/**
 * Expected doses come from the prescription (frequency × times-of-day, clipped
 * to the start/end dates), not from how many logs exist — otherwise a medicine
 * nobody logged would show 100% adherence.
 *
 * Two deliberate choices:
 *   · Today is never counted as missed. Doses still ahead on the clock aren't
 *     failures, and a ring that drops every morning teaches people to ignore it.
 *   · A day with no doses due (a weekly medicine's other six days) doesn't break
 *     the streak; it's skipped over.
 */
create or replace function public.adherence_summary(
  p_medicine uuid,
  p_days     integer,
  p_tz       text default 'UTC'
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_med      public.medicines;
  v_days     integer := least(greatest(coalesce(p_days, 7), 1), 366);
  v_today    date;
  v_from     date;
  v_rows     jsonb;
  v_daily    jsonb;
  v_expected integer := 0;
  v_given    integer := 0;
  v_skipped  integer := 0;
  v_missed   integer := 0;
  v_streak   integer := 0;
  v_row      jsonb;
  i          integer;
begin
  -- SECURITY INVOKER: if the caller lacks medicine.view, RLS returns no row and
  -- this is indistinguishable from "no such medicine". That's intentional.
  select m.* into v_med from public.medicines m where m.id = p_medicine;
  if not found then
    raise exception 'That medicine is no longer on file.' using errcode = 'P0002';
  end if;

  v_today := (now() at time zone p_tz)::date;
  v_from  := v_today - (v_days - 1);

  with days as (
    select gs::date as day
    from generate_series(v_from::timestamp, v_today::timestamp, interval '1 day') gs
  ),
  expected as (
    select
      d.day,
      case
        when v_med.starts_at > d.day then 0
        when v_med.ends_at is not null and v_med.ends_at < d.day then 0
        when v_med.frequency = 'asNeeded' then 0
        when v_med.frequency = 'everyOtherDay'
             and ((d.day - v_med.starts_at) % 2) <> 0 then 0
        when v_med.frequency = 'weekly'
             and ((d.day - v_med.starts_at) % 7) <> 0 then 0
        when v_med.frequency = 'monthly'
             and extract(day from d.day) <> extract(day from v_med.starts_at) then 0
        else coalesce(array_length(v_med.times_of_day, 1), 0)
      end as expected
    from days d
  ),
  logs as (
    select
      (ml.scheduled_for at time zone p_tz)::date as day,
      ml.status
    from public.medicine_logs ml
    where ml.medicine_id = p_medicine
      and ml.scheduled_for >= (v_from::timestamp) at time zone p_tz
      and ml.scheduled_for <  ((v_today + 1)::timestamp) at time zone p_tz
  ),
  daily as (
    select
      e.day,
      e.expected,
      count(l.status) filter (where l.status = 'given')::integer   as given,
      count(l.status) filter (where l.status = 'skipped')::integer as skipped
    from expected e
    left join logs l on l.day = e.day
    group by e.day, e.expected
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'date',     to_char(d.day, 'YYYY-MM-DD'),
          'expected', d.expected,
          'given',    d.given,
          'skipped',  d.skipped,
          'missed',   case
                        when d.day >= v_today then 0
                        else greatest(d.expected - d.given - d.skipped, 0)
                      end
        )
        order by d.day
      ),
      '[]'::jsonb
    ),
    coalesce(sum(d.expected), 0)::integer,
    coalesce(sum(d.given), 0)::integer,
    coalesce(sum(d.skipped), 0)::integer,
    coalesce(sum(
      case when d.day >= v_today then 0
           else greatest(d.expected - d.given - d.skipped, 0) end
    ), 0)::integer
  into v_rows, v_expected, v_given, v_skipped, v_missed
  from daily d;

  -- Streak: walk backwards from today while every due dose was given.
  for i in reverse (jsonb_array_length(v_rows) - 1) .. 0 loop
    v_row := v_rows -> i;

    if (v_row ->> 'expected')::integer = 0 then
      continue;                                   -- no doses due; not a break
    elsif (v_row ->> 'given')::integer >= (v_row ->> 'expected')::integer then
      v_streak := v_streak + 1;
    elsif (v_row ->> 'date') = to_char(v_today, 'YYYY-MM-DD') then
      continue;                                   -- today is still in progress
    else
      exit;
    end if;
  end loop;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date',     e ->> 'date',
        'expected', (e ->> 'expected')::integer,
        'given',    (e ->> 'given')::integer
      )
    ),
    '[]'::jsonb
  )
  into v_daily
  from jsonb_array_elements(v_rows) e;

  return jsonb_build_object(
    'medicineId', p_medicine,
    'windowDays', v_days,
    'expected',   v_expected,
    'given',      v_given,
    'skipped',    v_skipped,
    'missed',     v_missed,
    'rate',       case when v_expected > 0
                       then round(v_given::numeric / v_expected::numeric, 4)
                       else 0 end,
    'streakDays', v_streak,
    'daily',      v_daily
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Execution grants
--
-- Default-deny: PUBLIC loses execute on the definer functions, then the two
-- roles that should have it get it back explicitly. peek_invite is the only
-- anonymous surface in the app — a deep link can preview an invite before the
-- invitee has signed up.
-- ---------------------------------------------------------------------------

revoke execute on function public.peek_invite(text) from public;
revoke execute on function public.accept_invite(text) from public;

grant execute on function public.peek_invite(text)   to anon, authenticated;
grant execute on function public.accept_invite(text) to authenticated;

grant execute on function public.care_tasks_for_day(uuid, date, text)   to authenticated;
grant execute on function public.care_day_summaries(uuid, date, date, text) to authenticated;
grant execute on function public.adherence_summary(uuid, integer, text) to authenticated;
