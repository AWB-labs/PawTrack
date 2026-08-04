-- ============================================================================
-- Petal — 0004_storage.sql
-- The `pet-media` bucket and its object policies.
--
-- Pet documents are x-rays, invoices and prescriptions. The bucket is private —
-- the app never links to an object directly, it asks the adapter for a
-- short-lived signed URL (resolveDocumentUrl(), one hour).
--
-- Every key the app writes looks like  pets/<pet_id>/documents/<uuid>.<ext>
-- (or .../thumbnails/<uuid>.jpg), so segment 2 of the path is the pet id. The
-- regex guard matters: without it a malformed key would make the ::uuid cast
-- raise instead of simply denying.
-- ============================================================================

-- 25 MB ceiling covers a multi-page vet PDF or a phone photo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pet-media',
  'pet-media',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

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
