-- ============================================================================
-- Petal — 0008_moderation.sql
-- Agreement, filtering, flagging, blocking, ejection.
--
-- This file is the server half of App Store Guideline 1.2. The app has a public
-- feed, so five things have to be true and provable, and four of them are here:
--
--   1. Nobody can post until they have agreed to the terms.        (petal_has_agreed)
--   2. Objectionable text is refused at the boundary, not hidden
--      by a client that could simply not run.                      (petal_blocked_term)
--   3. Anybody can flag anything, and a flag has an effect the
--      moment it is filed rather than when a human gets to it.     (content_reports)
--   4. Blocking removes both directions instantly, and files the
--      report that tells us why.                                   (user_blocks)
--   5. A moderator can remove content *and* eject the account
--      behind it in one call, inside the published 24 hours.       (petal_eject_user)
--
-- The client mirrors 1–4 for feel and for feedback (src/lib/moderation.ts,
-- src/features/community/SafetySheets.tsx). Only this file is a defence: it is
-- the copy an attacker holding an anon key and talking to PostgREST directly
-- still has to get past.
--
-- Enum labels are byte-identical to the TypeScript unions in src/data/types.ts,
-- camelCase included ('animalCruelty', 'selfHarm'). Do not tidy them.
-- ============================================================================

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.report_reason as enum (
  'harassment',
  'hate',
  'sexual',
  'violence',
  'animalCruelty',
  'spam',
  'impersonation',
  'selfHarm',
  'other'
);

create type public.report_target_kind as enum ('post', 'comment', 'user');

create type public.report_status as enum ('open', 'actioned', 'dismissed');

create type public.moderation_severity as enum ('warn', 'block');

-- ---------------------------------------------------------------------------
-- profiles: agreement and standing
--
-- `terms_version` is the gate, enforced in two places with deliberately
-- different strictness. petal_has_agreed() below asks only "has this account
-- ever agreed?", because that is the question a security boundary can answer
-- without being redeployed every time the copy changes. Which *version* is
-- current is the app's question: bumping TERMS_VERSION in
-- src/features/legal/agreement.ts leaves every profile behind the new number and
-- the router's legal branch re-gates them. Raise this function's `minimum` in a
-- later migration if a change is serious enough to be worth locking out clients
-- that have not updated.
--
-- `suspended_at` is ejection. It is deliberately *not* a delete: an ejected
-- account has to stay identifiable so the same person cannot quietly reappear
-- against the same reports, and so the audit trail survives.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column terms_accepted_at timestamptz,
  add column terms_version     integer,
  add column suspended_at      timestamptz,
  add column suspended_reason  text;

create index profiles_suspended_idx on public.profiles (suspended_at) where suspended_at is not null;

-- ---------------------------------------------------------------------------
-- Hiding
--
-- Removal is a timestamp rather than a delete for the same reason the reports
-- keep a snapshot: content that has been taken down is exactly the content a
-- moderator, and occasionally a regulator, needs to be able to look at. The
-- select policies below make a hidden row invisible to everyone except its
-- author, who is told it is under review rather than left wondering.
-- ---------------------------------------------------------------------------

alter table public.posts
  add column hidden_at     timestamptz,
  add column hidden_reason text;

alter table public.comments
  add column hidden_at     timestamptz,
  add column hidden_reason text;

create index posts_visible_created_idx
  on public.posts (created_at desc) where hidden_at is null;

create index comments_visible_post_idx
  on public.comments (post_id, created_at) where hidden_at is null;

-- ---------------------------------------------------------------------------
-- The term list
--
-- Kept in a table rather than in a function body so operations can add a term
-- the moment it is seen, without a migration and without a client release. It
-- is readable only through petal_blocked_term(), which is SECURITY DEFINER:
-- handing the list to every signed-in client is handing out the evasion guide.
-- ---------------------------------------------------------------------------

create table public.moderation_terms (
  term     text primary key,
  category public.report_reason not null,
  severity public.moderation_severity not null default 'block',
  note     text,
  added_at timestamptz not null default now(),
  constraint moderation_terms_shape check (term ~ '^[a-z0-9]+( [a-z0-9]+)*$')
);

comment on table public.moderation_terms is
  'Folded, lowercase terms. Mirrors the RULES table in src/lib/moderation.ts; that copy is for instant feedback, this one is the boundary.';

insert into public.moderation_terms (term, category, severity) values
  ('nigger', 'hate', 'block'),
  ('nigga', 'hate', 'block'),
  ('coon', 'hate', 'block'),
  ('jigaboo', 'hate', 'block'),
  ('faggot', 'hate', 'block'),
  ('dyke', 'hate', 'block'),
  ('tranny', 'hate', 'block'),
  ('shemale', 'hate', 'block'),
  ('kike', 'hate', 'block'),
  ('spic', 'hate', 'block'),
  ('wetback', 'hate', 'block'),
  ('chink', 'hate', 'block'),
  ('gook', 'hate', 'block'),
  ('raghead', 'hate', 'block'),
  ('towelhead', 'hate', 'block'),
  ('retard', 'hate', 'block'),
  ('retarded', 'hate', 'block'),
  ('mongoloid', 'hate', 'block'),
  ('white power', 'hate', 'block'),
  ('heil hitler', 'hate', 'block'),
  ('sieg heil', 'hate', 'block'),
  ('porn', 'sexual', 'block'),
  ('pornhub', 'sexual', 'block'),
  ('nudes', 'sexual', 'block'),
  ('onlyfans', 'sexual', 'block'),
  ('camgirl', 'sexual', 'block'),
  ('escort service', 'sexual', 'block'),
  ('blowjob', 'sexual', 'block'),
  ('handjob', 'sexual', 'block'),
  ('anal sex', 'sexual', 'block'),
  ('cumshot', 'sexual', 'block'),
  ('creampie', 'sexual', 'block'),
  ('deepthroat', 'sexual', 'block'),
  ('dick pic', 'sexual', 'block'),
  ('send nudes', 'sexual', 'block'),
  ('sex chat', 'sexual', 'block'),
  ('sexcam', 'sexual', 'block'),
  ('bestiality', 'sexual', 'block'),
  ('zoophilia', 'sexual', 'block'),
  ('animal porn', 'sexual', 'block'),
  ('child porn', 'sexual', 'block'),
  ('loli', 'sexual', 'block'),
  ('shota', 'sexual', 'block'),
  ('kill yourself', 'violence', 'block'),
  ('kys', 'violence', 'block'),
  ('kill you', 'violence', 'block'),
  ('kill your family', 'violence', 'block'),
  ('rape you', 'violence', 'block'),
  ('shoot you', 'violence', 'block'),
  ('stab you', 'violence', 'block'),
  ('beat you to death', 'violence', 'block'),
  ('hunt you down', 'violence', 'block'),
  ('burn your house', 'violence', 'block'),
  ('i know where you live', 'violence', 'block'),
  ('bomb threat', 'violence', 'block'),
  ('school shooting', 'violence', 'block'),
  ('dog fighting', 'animalCruelty', 'block'),
  ('dogfighting', 'animalCruelty', 'block'),
  ('cock fighting', 'animalCruelty', 'block'),
  ('bait dog', 'animalCruelty', 'block'),
  ('kick the dog', 'animalCruelty', 'block'),
  ('kick your dog', 'animalCruelty', 'block'),
  ('beat the dog', 'animalCruelty', 'block'),
  ('beat your dog', 'animalCruelty', 'block'),
  ('drown the puppies', 'animalCruelty', 'block'),
  ('drown the kittens', 'animalCruelty', 'block'),
  ('poison the cat', 'animalCruelty', 'block'),
  ('poison your dog', 'animalCruelty', 'block'),
  ('how to hurt a dog', 'animalCruelty', 'block'),
  ('how to hurt a cat', 'animalCruelty', 'block'),
  ('shoot the cat', 'animalCruelty', 'block'),
  ('starve the dog', 'animalCruelty', 'block'),
  ('bitch', 'harassment', 'warn'),
  ('cunt', 'harassment', 'warn'),
  ('whore', 'harassment', 'warn'),
  ('slut', 'harassment', 'warn'),
  ('moron', 'harassment', 'warn'),
  ('idiot', 'harassment', 'warn'),
  ('scumbag', 'harassment', 'warn'),
  ('stfu', 'harassment', 'warn'),
  ('fuck you', 'harassment', 'warn'),
  ('fuck off', 'harassment', 'warn'),
  ('go die', 'harassment', 'warn'),
  ('free bitcoin', 'spam', 'warn'),
  ('crypto giveaway', 'spam', 'warn'),
  ('make money fast', 'spam', 'warn'),
  ('buy followers', 'spam', 'warn');

-- ---------------------------------------------------------------------------
-- Folding
--
-- The same idea as fold() in src/lib/moderation.ts: nobody types a slur cleanly
-- once they know a filter exists, so the text is reduced to bare letters before
-- a single term is compared. Three readings are produced because no single one
-- is right for every evasion:
--
--   spaced   — words, single-spaced. Catches ordinary text.
--   squashed — runs of three or more letters cut to one, so "niiiigger" lands
--              on "nigger" while "cool" and "bass" survive untouched.
--   tight    — every separator removed. Only consulted for terms of six letters
--              or more, which is what makes "n i g g e r" catchable without
--              "porn" matching inside "popcorn".
-- ---------------------------------------------------------------------------

create or replace function public.petal_fold(input text)
returns text
language sql
immutable
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        translate(lower(coalesce(input, '')), '01345789@$!|+', 'oieastbgasiit'),
        '[^a-z0-9]+', ' ', 'g'
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

create or replace function public.petal_fold_tight(input text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    translate(lower(coalesce(input, '')), '01345789@$!|+', 'oieastbgasiit'),
    '[^a-z0-9]+', '', 'g'
  );
$$;

/**
 * The first blocking term this text trips, or a null row when it is clean.
 *
 * SECURITY DEFINER because `moderation_terms` is not readable by anyone signed
 * in — the caller gets a verdict, never the list. `set search_path` is
 * mandatory here as everywhere else in this schema.
 */
create or replace function public.petal_blocked_term(input text)
returns public.moderation_terms
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with reading as (
    select
      public.petal_fold(input) as spaced,
      regexp_replace(public.petal_fold(input), '(.)\1{2,}', '\1', 'g') as squashed,
      public.petal_fold_tight(input) as tight
  )
  select t.*
  from public.moderation_terms t, reading r
  where t.severity = 'block'
    and (
      r.spaced ~ ('\m' || t.term || '\M')
      or r.squashed ~ ('\m' || t.term || '\M')
      or (length(t.term) >= 6 and strpos(r.tight, replace(t.term, ' ', '')) > 0)
    )
  order by length(t.term) desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Standing
-- ---------------------------------------------------------------------------

/** Has this account agreed to the current terms? Gates every write to the feed. */
create or replace function public.petal_has_agreed(minimum integer default 1)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and coalesce(p.terms_version, 0) >= minimum
  );
$$;

/** Ejected accounts keep reading — they simply cannot add anything to the feed. */
create or replace function public.petal_is_suspended()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.suspended_at is not null
  );
$$;

-- ---------------------------------------------------------------------------
-- Blocking
-- ---------------------------------------------------------------------------

create table public.user_blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  reason     public.report_reason,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

create index user_blocks_blocker_idx on public.user_blocks (blocker_id);
create index user_blocks_blocked_idx on public.user_blocks (blocked_id);

/**
 * Blocking is symmetric on purpose. A one-way mute leaves the blocked account
 * able to keep replying into a thread the person who blocked them can still
 * read, which is the exact situation the control exists to end.
 */
create or replace function public.petal_is_blocked(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = other)
       or (b.blocker_id = other and b.blocked_id = (select auth.uid()))
  );
$$;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create table public.content_reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_id      uuid not null references public.profiles (id) on delete cascade,
  target_kind      public.report_target_kind not null,
  target_id        uuid not null,
  -- Denormalised so the queue can eject an account without chasing a row that
  -- a moderator may already have removed.
  target_author_id uuid references public.profiles (id) on delete set null,
  reason           public.report_reason not null,
  details          text,
  -- What the content said when it was flagged. Survives the take-down.
  snapshot         text,
  status           public.report_status not null default 'open',
  resolution       text,
  resolved_by      uuid references public.profiles (id) on delete set null,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint content_reports_details_len check (details is null or char_length(details) <= 1000),
  constraint content_reports_not_self check (target_author_id is null or target_author_id <> reporter_id)
);

-- One person, one open report per thing. Reporting twice is not two signals.
create unique index content_reports_once_idx
  on public.content_reports (reporter_id, target_kind, target_id);

create index content_reports_target_idx on public.content_reports (target_kind, target_id);
create index content_reports_author_idx on public.content_reports (target_author_id);
create index content_reports_open_idx
  on public.content_reports (created_at) where status = 'open';

/** Anything you flagged is gone from your feed the instant you flag it. */
create or replace function public.petal_reported_by_me(
  kind public.report_target_kind,
  target uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.content_reports r
    where r.reporter_id = (select auth.uid())
      and r.target_kind = kind
      and r.target_id = target
  );
$$;

/**
 * What a report does before a human sees it.
 *
 * The published commitment is review within 24 hours, and a commitment that
 * leaves the content up for those 24 hours is not much of one. So the severe
 * categories — hate, sexual, violence, animal cruelty, self-harm — take content
 * down on the *first* report, and everything else on the second from a
 * different person. A moderator's job then becomes confirming a removal and
 * ejecting the account, rather than racing the damage.
 *
 * False positives are recoverable: petal_eject_user's counterpart is a plain
 * update clearing hidden_at, and a dismissed report restores the row.
 */
create or replace function public.petal_apply_report()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  threshold integer;
  tally     integer;
begin
  threshold := case
    when new.reason in ('hate', 'sexual', 'violence', 'animalCruelty', 'selfHarm') then 1
    else 2
  end;

  select count(distinct reporter_id)
    into tally
    from public.content_reports
   where target_kind = new.target_kind
     and target_id = new.target_id
     and status = 'open';

  if tally >= threshold then
    if new.target_kind = 'post' then
      update public.posts
         set hidden_at = now(), hidden_reason = new.reason::text
       where id = new.target_id and hidden_at is null;
    elsif new.target_kind = 'comment' then
      update public.comments
         set hidden_at = now(), hidden_reason = new.reason::text
       where id = new.target_id and hidden_at is null;
    end if;
  end if;

  return new;
end;
$$;

create trigger content_reports_apply
  after insert on public.content_reports
  for each row execute function public.petal_apply_report();

-- ---------------------------------------------------------------------------
-- The filter, as a boundary
-- ---------------------------------------------------------------------------

create or replace function public.petal_reject_blocked_text()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hit public.moderation_terms;
begin
  hit := public.petal_blocked_term(new.body);

  if hit.term is not null then
    -- Raised as P0001 deliberately: SupabaseAdapter passes that code's message
    -- through untouched, so the sentence written here is the sentence the
    -- person reads. The category rides along in DETAIL for the logs, and the
    -- matched term never leaves the database — telling somebody exactly which
    -- word tripped the filter is telling them what to spell differently.
    raise exception 'That breaks the Furry Tracker community rules, so it wasn''t posted. Have another look and try again.'
      using detail = format('moderation:%s', hit.category);
  end if;

  return new;
end;
$$;

create trigger posts_moderate
  before insert or update of body on public.posts
  for each row execute function public.petal_reject_blocked_text();

create trigger comments_moderate
  before insert or update of body on public.comments
  for each row execute function public.petal_reject_blocked_text();

-- ---------------------------------------------------------------------------
-- Ejection
--
-- The 24-hour commitment, as one call. Suspends the account, hides everything
-- it ever posted, and closes the reports that led here — so "removed the
-- content and ejected the user" is a single auditable action rather than four
-- statements someone has to remember to run in order.
--
-- Service role only; see the revoke at the foot of this file.
-- ---------------------------------------------------------------------------

create or replace function public.petal_eject_user(target uuid, why text default 'Community rules violation')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.profiles
     set suspended_at = coalesce(suspended_at, now()), suspended_reason = why
   where id = target;

  update public.posts
     set hidden_at = coalesce(hidden_at, now()), hidden_reason = why
   where author_id = target;

  update public.comments
     set hidden_at = coalesce(hidden_at, now()), hidden_reason = why
   where author_id = target;

  update public.content_reports
     set status = 'actioned', resolution = why, resolved_at = now()
   where target_author_id = target and status = 'open';
end;
$$;

/** The counterpart, for the reports that turn out to be nothing. */
create or replace function public.petal_restore_content(
  kind public.report_target_kind,
  target uuid,
  why text default 'Reviewed — no violation'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if kind = 'post' then
    update public.posts set hidden_at = null, hidden_reason = null where id = target;
  elsif kind = 'comment' then
    update public.comments set hidden_at = null, hidden_reason = null where id = target;
  end if;

  update public.content_reports
     set status = 'dismissed', resolution = why, resolved_at = now()
   where target_kind = kind and target_id = target and status = 'open';
end;
$$;

-- ---------------------------------------------------------------------------
-- The queue
--
-- What a moderator opens. Ordered oldest first because the commitment is a
-- deadline, not a backlog, and `hours_open` is there so breaching it is
-- visible rather than something you have to work out.
-- ---------------------------------------------------------------------------

create or replace view public.moderation_queue as
  select
    r.id,
    r.created_at,
    round(extract(epoch from (now() - r.created_at)) / 3600.0, 1) as hours_open,
    r.reason,
    r.target_kind,
    r.target_id,
    r.details,
    coalesce(r.snapshot, p.body, c.body)                          as content,
    author.id                                                     as author_id,
    author.display_name                                           as author_name,
    author.email                                                  as author_email,
    author.suspended_at                                           as author_suspended_at,
    reporter.display_name                                         as reporter_name,
    (select count(*) from public.content_reports peer
      where peer.target_kind = r.target_kind and peer.target_id = r.target_id) as report_count,
    coalesce(p.hidden_at, c.hidden_at)                            as hidden_at
  from public.content_reports r
  left join public.posts p       on r.target_kind = 'post' and p.id = r.target_id
  left join public.comments c    on r.target_kind = 'comment' and c.id = r.target_id
  left join public.profiles author on author.id = r.target_author_id
  left join public.profiles reporter on reporter.id = r.reporter_id
  where r.status = 'open'
  order by r.created_at;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.content_reports  enable row level security;
alter table public.user_blocks      enable row level security;
alter table public.moderation_terms enable row level security;

-- Reports are write-once from the client. Only the service role resolves them,
-- which is what stops somebody closing the report filed against their own post.
create policy "you can file a report"
  on public.content_reports for insert to authenticated
  with check (
    reporter_id = (select auth.uid())
    and (target_author_id is null or target_author_id <> (select auth.uid()))
  );

create policy "you see the reports you filed"
  on public.content_reports for select to authenticated
  using (reporter_id = (select auth.uid()));

create policy "you see who you blocked"
  on public.user_blocks for select to authenticated
  using (blocker_id = (select auth.uid()));

create policy "you can block someone"
  on public.user_blocks for insert to authenticated
  with check (blocker_id = (select auth.uid()));

create policy "you can unblock someone"
  on public.user_blocks for delete to authenticated
  using (blocker_id = (select auth.uid()));

-- No policy on moderation_terms: RLS with no policy denies everything, and
-- petal_blocked_term() is SECURITY DEFINER so it reads the list regardless.

-- ---------------------------------------------------------------------------
-- Community policies, restated
--
-- 0002 made posts and comments readable by every signed-in user, full stop.
-- That predates any of this. Each one is replaced with the same rule plus the
-- three exclusions that make the feed safe: hidden content, blocked accounts in
-- either direction, and anything you personally flagged.
--
-- The author's own rows stay visible to the author. Content that vanishes with
-- no explanation reads as a bug and generates a support mail; content marked
-- "under review" reads as a consequence.
-- ---------------------------------------------------------------------------

drop policy if exists "posts are readable by signed-in users" on public.posts;

create policy "posts are readable unless hidden, blocked, or flagged by you"
  on public.posts for select to authenticated
  using (
    author_id = (select auth.uid())
    or (
      hidden_at is null
      and not public.petal_is_blocked(author_id)
      and not public.petal_reported_by_me('post', id)
    )
  );

drop policy if exists "comments are readable by signed-in users" on public.comments;

create policy "comments are readable unless hidden, blocked, or flagged by you"
  on public.comments for select to authenticated
  using (
    author_id = (select auth.uid())
    or (
      hidden_at is null
      and not public.petal_is_blocked(author_id)
      and not public.petal_reported_by_me('comment', id)
    )
  );

-- Posting now requires three things rather than one: it is you, you have agreed
-- to the terms, and you have not been ejected.
drop policy if exists "you post as yourself, and only about pets you may post about" on public.posts;

create policy "you post as yourself, having agreed, and only about your pets"
  on public.posts for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.petal_has_agreed()
    and not public.petal_is_suspended()
    and (pet_id is null or public.petal_has_capability(pet_id, 'community.post'))
  );

drop policy if exists "you comment as yourself" on public.comments;

create policy "you comment as yourself, having agreed"
  on public.comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.petal_has_agreed()
    and not public.petal_is_suspended()
    and not exists (
      select 1 from public.posts p
      where p.id = comments.post_id
        and (p.hidden_at is not null or public.petal_is_blocked(p.author_id))
    )
  );

-- Liking is a write to somebody else's row count, so it takes the same standing
-- check. Without this an ejected account can still brigade a thread with hearts.
drop policy if exists "you can like a post" on public.post_likes;

create policy "you can like a post"
  on public.post_likes for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and not public.petal_is_suspended()
    and exists (
      select 1 from public.posts p
      where p.id = post_likes.post_id
        and p.hidden_at is null
        and not public.petal_is_blocked(p.author_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on public.moderation_terms from anon, authenticated;
revoke all on public.moderation_queue from anon, authenticated;

revoke all on function public.petal_eject_user(uuid, text) from anon, authenticated;
revoke all on function public.petal_restore_content(public.report_target_kind, uuid, text)
  from anon, authenticated;
revoke all on function public.petal_blocked_term(text) from anon;

grant execute on function public.petal_blocked_term(text) to authenticated;
grant execute on function public.petal_is_blocked(uuid) to authenticated;
grant execute on function public.petal_has_agreed(integer) to authenticated;
grant execute on function public.petal_is_suspended() to authenticated;
grant execute on function public.petal_reported_by_me(public.report_target_kind, uuid) to authenticated;
