-- Pinmap: tables, access rules and photo storage.
-- Run once: Supabase dashboard → SQL Editor → New query → paste everything → Run.
-- Safe to run again.

-- Places and photos. The record itself lives in `data` (JSON), so the app can add fields
-- without schema changes. `updated_at` = client time of the edit (last write wins),
-- `server_at` = server time, used by devices to fetch "what changed since last sync".
create table if not exists public.places (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb not null,
  updated_at  bigint not null,
  deleted     boolean not null default false,
  server_at   timestamptz not null default now()
);

create table if not exists public.photos (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  place_id    text not null,
  data        jsonb not null,
  updated_at  bigint not null,
  deleted     boolean not null default false,
  server_at   timestamptz not null default now()
);

create index if not exists places_user_server on public.places (user_id, server_at);
create index if not exists photos_user_server on public.photos (user_id, server_at);

create or replace function public.pinmap_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.server_at := now();
  return new;
end $$;

drop trigger if exists places_touch on public.places;
create trigger places_touch before insert or update on public.places
  for each row execute function public.pinmap_touch();
drop trigger if exists photos_touch on public.photos;
create trigger photos_touch before insert or update on public.photos
  for each row execute function public.pinmap_touch();

-- Everyone sees and changes only their own rows.
alter table public.places enable row level security;
alter table public.photos enable row level security;

drop policy if exists "own places" on public.places;
create policy "own places" on public.places for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own photos" on public.photos;
create policy "own photos" on public.photos for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Private bucket for photo files: <user id>/<photo id>.jpg and <photo id>_t.jpg (thumbnail).
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "pinmap read own files" on storage.objects;
create policy "pinmap read own files" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists "pinmap add own files" on storage.objects;
create policy "pinmap add own files" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists "pinmap update own files" on storage.objects;
create policy "pinmap update own files" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists "pinmap delete own files" on storage.objects;
create policy "pinmap delete own files" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
