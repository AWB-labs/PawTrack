# Petal — Supabase setup

Petal ships fully explorable without any of this: with no credentials the app runs on the seeded
mock adapter, and every screen works offline. This directory is what you run when you want the real
thing — Postgres, Auth, Storage and Row Level Security.

Follow the steps in order. Each one is verifiable before you move to the next, so if something is
wrong you find out on step 3 rather than on your first sign-in.

| File | What it does |
| --- | --- |
| `migrations/0001_init.sql` | Enums, tables, indexes, triggers, the `pet_cards` view |
| `migrations/0002_rls.sql` | RLS helpers + every policy. **This is the security boundary.** |
| `migrations/0003_functions.sql` | `peek_invite`, `accept_invite`, `care_tasks_for_day`, `care_day_summaries`, `adherence_summary` |
| `migrations/0004_storage.sql` | The `pet-media` bucket + its four object policies |
| `migrations/0005_seed_groups.sql` | Five starter community groups, so Community isn't empty on first run |
| `migrations/0006_fix_pets_select_returning.sql` | Fixes the `pets` SELECT policy so `INSERT ... RETURNING` (i.e. `.insert().select().single()`) works for the row you just created — see the file's own comment for why the original policy failed only on the RETURNING side |

---

## 1. Create the project

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Name it `petal` (or `petal-dev`), choose a region close to your users, and set a database
   password you keep somewhere safe.
3. Wait for provisioning to finish — the SQL editor is unavailable until it does.

Nothing else on this page matters yet.

---

## 2. Run the migrations

**Fastest — Supabase CLI, no linking required:**

```bash
supabase db push --db-url "postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres" --include-all
```

Get that connection string from **Project Settings → Database → Connection string → URI** (use the
*pooler* one, port 5432, session mode — the CLI doesn't need the direct connection). `--include-all`
applies every migration in `migrations/` that the remote hasn't seen yet, in filename order, and
records each in `supabase_migrations.schema_migrations` so re-running is a no-op. `db push` reads the
whole repo tree via `--db-url`; it does not require `supabase init` or `supabase link` first.

**Or, in the dashboard:** open **SQL Editor → New query** and run all five files **in order**, one
query per run, waiting for "Success" before the next: `0001_init.sql`, `0002_rls.sql`,
`0003_functions.sql`, `0004_storage.sql`, `0005_seed_groups.sql`.

The order matters: 0002 enables RLS on tables 0001 creates, 0003 calls helpers 0002 defines, and 0004
calls `petal_has_capability()` from 0002.

Note for the CLI path: `supabase db query --file <path>` looks like the more obvious command, but it
executes through a prepared statement and will fail on these files with *"cannot insert multiple
commands into a prepared statement"* — multi-statement SQL needs `db push`, not `db query`. `db
query` is still the right tool for the single-statement checks below.

**Verify** — run this and expect `20` tables, all with `rowsecurity = true`:

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;
```

And this, which should return `t` (you are the `postgres` role, so `auth.uid()` is null and every
capability check must fail closed):

```sql
select public.petal_has_capability(gen_random_uuid(), 'pet.view') is false;
```

---

## 3. The `pet-media` storage bucket and its policies

Already done if you ran `0004_storage.sql` in step 2. This section explains what it set up, for
reference — skip to step 4 unless you're debugging storage access.

Pet documents are x-rays, invoices and prescriptions. The bucket is **private** — the app never
links to an object directly, it asks the adapter for a short-lived signed URL
(`resolveDocumentUrl()`, one hour). `0004_storage.sql` creates the bucket and four object policies
that mirror the table policies in `0002_rls.sql`, so the bytes and the rows can never disagree:

```sql
-- 3a. The bucket. 25 MB ceiling covers a multi-page vet PDF or a phone photo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pet-media',
  'pet-media',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

-- 3b. Object policies.
--
-- Every key the app writes looks like  pets/<pet_id>/documents/<uuid>.<ext>
-- (or .../thumbnails/<uuid>.jpg), so segment 2 of the path is the pet id. The
-- regex guard matters: without it a malformed key would make the ::uuid cast
-- raise instead of simply denying.

create policy "pet media is readable with document.view"
on storage.objects for select to authenticated
using (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = 'pets'
  and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.petal_has_capability(((storage.foldername(name))[2])::uuid, 'document.view')
);

create policy "pet media is writable with document.upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = 'pets'
  and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.petal_has_capability(((storage.foldername(name))[2])::uuid, 'document.upload')
);

create policy "pet media may be replaced with document.upload"
on storage.objects for update to authenticated
using (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = 'pets'
  and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.petal_has_capability(((storage.foldername(name))[2])::uuid, 'document.upload')
)
with check (
  bucket_id = 'pet-media'
  and public.petal_has_capability(((storage.foldername(name))[2])::uuid, 'document.upload')
);

-- document.delete is owner-only in permissions.ts, so it is owner-only here too.
create policy "only the pet owner deletes pet media"
on storage.objects for delete to authenticated
using (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = 'pets'
  and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and public.petal_is_owner(((storage.foldername(name))[2])::uuid)
);
```

**Verify** — **Storage → pet-media** exists and shows a padlock (private), and **Policies** lists
four entries.

---

## 4. Enable Google and Apple sign-in

Both providers redirect back through Supabase, so the URL you register with Google/Apple is
Supabase's callback, **not** Petal's deep link:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

### Google

1. Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type **Web application**. Add the Supabase callback above as an *Authorized redirect
   URI*.
3. Copy the client ID and client secret.
4. Supabase → **Authentication → Sign In / Providers → Google** → enable, paste both, **Save**.

### Apple

1. Apple Developer → **Certificates, Identifiers & Profiles**.
2. Create an **App ID** for `app.petal.mobile` with *Sign in with Apple* enabled (this matches
   `ios.bundleIdentifier` in `app.json`).
3. Create a **Services ID** (e.g. `app.petal.mobile.web`), enable *Sign in with Apple*, and set the
   Supabase callback above as the Return URL.
4. Create a **Key** with *Sign in with Apple*, download the `.p8`, note the Key ID and your Team ID.
5. Supabase → **Authentication → Sign In / Providers → Apple** → enable, paste the Services ID as
   the client ID and the generated secret, **Save**.

### Email

**Authentication → Sign In / Providers → Email** is on by default. Decide about confirmations:

- **Confirm email ON** (the default, and right for production): `signUp()` returns no session, and
  the adapter surfaces *"Almost there — tap the link in the email we just sent…"*.
- **Confirm email OFF** (convenient while building): sign-up returns a session and drops the user
  straight into the app.

---

## 5. Set the redirect URLs for the `petal` scheme

**Authentication → URL Configuration → Redirect URLs.** Add:

```
petal://auth/callback
petal://auth/reset
```

These match `app.json`'s `"scheme": "petal"` and the two `makeRedirectUri()` calls in
`src/data/SupabaseAdapter.ts`.

**In Expo Go** the redirect is not `petal://` — Expo Go owns the scheme, so `makeRedirectUri()`
returns something like `exp://192.168.1.20:8081/--/auth/callback`. Add the exact value your machine
prints (log it once from the sign-in screen), or add the wildcard `exp://**` while developing. A
development build (`npx expo run:ios` / `run:android`) uses the real `petal://` URLs.

Set **Site URL** to `petal://auth/callback` too — it's the fallback when a provider drops the
redirect parameter.

---

## 6. Add the two environment variables

**Project Settings → API** gives you both values.

1. Copy `.env.example` to `.env.local` in the repo root (`.env.local` is already git-ignored;
   plain `.env` is not).
2. Fill in:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<the anon / publishable key>
```

3. Restart Metro with a cleared cache — `EXPO_PUBLIC_*` values are **inlined at bundle time**, so a
   warm cache keeps serving the old (empty) values:

```bash
npx expo start --clear
```

Only ever use the **anon / publishable** key. The `service_role` key bypasses every policy in
`0002_rls.sql`; it must never appear in a mobile bundle, which is exactly what `EXPO_PUBLIC_` means.

---

## 7. Flip the app from mock to live

There's no switch to flip by hand. `src/data/supabase.ts` exposes `isSupabaseConfigured()`, which is
true when both variables are present and well-formed, and `src/data/index.ts` picks the adapter from
it at startup:

- **Both variables set** → `SupabaseAdapter` (`adapter.kind === 'supabase'`).
- **Either missing** → `MockAdapter` (`adapter.kind === 'mock'`), seeded demo data, no network.

So: adding the variables and restarting Metro *is* the switch. To go back to the demo, comment them
out (or rename `.env.local`) and restart with `--clear`. Nothing else in the app changes — screens
talk to the `DataAdapter` interface and cannot tell which one answered.

---

## 8. Seed the community directory

Already done if you ran `0005_seed_groups.sql` in step 2. Groups are curated, so `groups` is the one
table with no client write path — a fresh project shows an empty Community tab until you add some.
For reference, that migration inserts:

```sql
insert into public.groups (name, slug, kind, description, accent) values
  ('Golden Retrievers', 'golden-retrievers', 'breed',
   'Fluff, fetch and the occasional stolen sandwich.', '#C97B1F'),
  ('Cat People',        'cat-people',        'species',
   'Nine lives, one group chat.', '#8A5CC4'),
  ('Senior Pets',       'senior-pets',       'topic',
   'Slower walks, softer beds, and the medicine schedules that come with them.', '#4F8149'),
  ('Rescue Stories',    'rescue-stories',    'topic',
   'Before-and-afters, first nights home, and the wins worth celebrating.', '#F2653A'),
  ('New Puppies',       'new-puppies',       'topic',
   'Sleep is temporary. Photos are forever.', '#2E7BC4')
on conflict (slug) do nothing;
```

---

## 9. Check it end to end

In the app, in this order:

1. **Sign up** with email. → a row appears in `public.profiles` (written by the
   `on_auth_user_created` trigger, not by the client).
2. **Add a pet.** → one row in `pets` *and* one in `memberships` with `role = 'owner'` (written by
   the `pets_owner_membership` trigger).
3. **Log a weight.** → `pets.current_weight_kg` updates itself via `petal_sync_current_weight`.
4. **Add a feeding schedule**, then open Today. → the meal appears at the right local time; that's
   `care_tasks_for_day` receiving your device's IANA time zone.
5. **Invite a caregiver** with the "Daily care" preset, accept it from a second account, and confirm
   the sitter can log meals but cannot open Vaccinations. That single check exercises the grant
   list, the caregiver ceiling and the owner-only capabilities at once.
6. **Upload a document**, then reopen it. → the URL in the network log is `…/object/sign/…` with a
   token, never a public path.

---

## Notes for whoever maintains this

- **Time zones.** Feeding times and medicine times are `HH:mm` local text, never timestamps. The
  three care RPCs take an optional `p_tz` (defaulting to `'UTC'`) and the adapter always passes the
  device's IANA zone. A 7am feed is 7am wherever the owner is standing.
- **Weights are kilograms, always.** `weightUnit` is a display preference and never reaches the
  database.
- **RLS is the boundary; the client checks are for feel.** `assertCan()` in the adapter exists so a
  denial is instant and explained. If you add a table, add its policies in the same commit, and
  mirror `src/rbac/permissions.ts` exactly — including the fact that `pet.delete`, `pet.transfer`,
  `caregiver.*`, `document.delete`, `medicine.edit` and `activity.view` are owner-only and must be
  written as `petal_is_owner(...)`, not as a capability lookup.
- **`activity_events` is append-only.** There are deliberately no UPDATE or DELETE policies. An
  audit trail you can rewrite isn't one.
- **The `pet_cards` view is intentionally not RLS-filtered.** It exposes id, owner, name, species,
  breed and photo for pets that appear in a post, so the community feed can render "Buddy 🐶"
  without loosening the policies on `pets`. Do not add columns to it.
- **Adding a capability** means: the `capability` enum in `0001_init.sql`, the `CAPABILITIES` array
  in `permissions.ts`, `petal_caregiver_grantable()` if a caregiver may ever hold it, and the
  policies that use it. Four places, one meaning.
