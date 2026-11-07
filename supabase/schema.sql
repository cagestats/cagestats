-- Cage Stats: database setup for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- Safe to run more than once.

-- ---------------------------------------------------------------- tables

-- One row per watch. The watch keeps a random secret; only its hash is stored here.
create table if not exists public.devices (
    id                uuid primary key default gen_random_uuid(),
    secret_hash       text not null unique,
    user_id           uuid references auth.users (id) on delete cascade,
    label             text not null default 'Watch',
    link_code         text unique,
    link_code_expires timestamptz,
    created_at        timestamptz not null default now(),
    linked_at         timestamptz,
    last_seen_at      timestamptz
);

-- One row per match. Summary columns for fast lists, plus the full watch record in raw.
create table if not exists public.matches (
    id          uuid primary key default gen_random_uuid(),
    device_id   uuid not null references public.devices (id) on delete cascade,
    local_id    text not null,
    started_at  timestamptz not null,
    duration_ms bigint not null,
    paused_ms   bigint not null default 0,
    distance_m  double precision not null default 0,
    moving_ms   bigint not null default 0,
    avg_hr      integer,
    max_hr      integer,
    tracked     text[] not null default '{}',
    counts      jsonb not null default '{}'::jsonb,
    raw         jsonb not null,
    uploaded_at timestamptz not null default now(),
    unique (device_id, local_id)
);

create index if not exists matches_device_started on public.matches (device_id, started_at desc);
create index if not exists devices_user on public.devices (user_id);

-- ---------------------------------------------------------------- row-level security
-- Signed-in users see and manage only their own watches and matches.
-- Watches never read tables directly; they only call the functions below.

alter table public.devices enable row level security;
alter table public.matches enable row level security;

drop policy if exists "own devices: read" on public.devices;
create policy "own devices: read" on public.devices
    for select to authenticated using (user_id = auth.uid());

drop policy if exists "own devices: rename" on public.devices;
create policy "own devices: rename" on public.devices
    for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own devices: unlink" on public.devices;
create policy "own devices: unlink" on public.devices
    for delete to authenticated using (user_id = auth.uid());

drop policy if exists "own matches: read" on public.matches;
create policy "own matches: read" on public.matches
    for select to authenticated
    using (device_id in (select id from public.devices where user_id = auth.uid()));

drop policy if exists "own matches: delete" on public.matches;
create policy "own matches: delete" on public.matches
    for delete to authenticated
    using (device_id in (select id from public.devices where user_id = auth.uid()));

-- ---------------------------------------------------------------- helpers

create or replace function public._hash_secret(p_secret text)
returns text
language sql immutable
as $$
    select encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
$$;

create or replace function public._new_link_code()
returns text
language plpgsql volatile
as $$
declare
    -- No 0/O or 1/I, so codes are easy to read off a watch.
    alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    code text;
begin
    loop
        code := '';
        for i in 1..6 loop
            code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
        end loop;
        exit when not exists (select 1 from public.devices where link_code = code);
    end loop;
    return code;
end
$$;

-- ---------------------------------------------------------------- watch-facing functions

-- Called by the watch. Registers it on first contact and returns a link code
-- until a signed-in user claims it on the dashboard.
create or replace function public.register_device(p_secret text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    d public.devices;
begin
    if p_secret is null or length(p_secret) < 32 then
        raise exception 'Invalid device secret';
    end if;

    insert into public.devices (secret_hash)
    values (public._hash_secret(p_secret))
    on conflict (secret_hash) do update set last_seen_at = now()
    returning * into d;

    if d.user_id is not null then
        return jsonb_build_object('linked', true);
    end if;

    if d.link_code is null or d.link_code_expires < now() then
        update public.devices
        set link_code = public._new_link_code(),
            link_code_expires = now() + interval '30 minutes'
        where id = d.id
        returning * into d;
    end if;

    return jsonb_build_object('linked', false, 'code', d.link_code, 'expires', d.link_code_expires);
end
$$;

-- Called by the watch after each match. Safe to repeat: the same match is updated, not duplicated.
-- Matches upload even before the watch is linked; they appear once it is.
create or replace function public.upload_match(p_secret text, p_match jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    d public.devices;
    v_counts jsonb;
    v_avg int;
    v_max int;
begin
    if p_secret is null or length(p_secret) < 32 then
        raise exception 'Invalid device secret';
    end if;
    if p_match ->> 'id' is null or p_match ->> 'startedAt' is null or p_match ->> 'durationMs' is null then
        raise exception 'Match is missing id, startedAt or durationMs';
    end if;

    -- First contact from this watch registers it.
    insert into public.devices (secret_hash)
    values (public._hash_secret(p_secret))
    on conflict (secret_hash) do update set last_seen_at = now()
    returning * into d;

    select coalesce(jsonb_object_agg(t, c), '{}'::jsonb) into v_counts
    from (
        select e ->> 'type' as t, count(*) as c
        from jsonb_array_elements(coalesce(p_match -> 'events', '[]'::jsonb)) e
        group by 1
    ) x;

    -- samples are rows of [atMs, hr, speed, distM]
    select round(avg((s ->> 1)::numeric))::int, max((s ->> 1)::numeric)::int
    into v_avg, v_max
    from jsonb_array_elements(coalesce(p_match -> 'samples', '[]'::jsonb)) s
    where jsonb_typeof(s -> 1) = 'number';

    insert into public.matches (
        device_id, local_id, started_at, duration_ms, paused_ms,
        distance_m, moving_ms, avg_hr, max_hr, tracked, counts, raw
    ) values (
        d.id,
        p_match ->> 'id',
        to_timestamp((p_match ->> 'startedAt')::bigint / 1000.0),
        (p_match ->> 'durationMs')::bigint,
        coalesce((p_match ->> 'pausedMs')::bigint, 0),
        coalesce((p_match ->> 'distanceM')::double precision, 0),
        coalesce((p_match ->> 'movingMs')::bigint, 0),
        v_avg,
        v_max,
        array(select jsonb_array_elements_text(coalesce(p_match -> 'tracked', '[]'::jsonb))),
        v_counts,
        p_match
    )
    on conflict (device_id, local_id) do update set
        started_at  = excluded.started_at,
        duration_ms = excluded.duration_ms,
        paused_ms   = excluded.paused_ms,
        distance_m  = excluded.distance_m,
        moving_ms   = excluded.moving_ms,
        avg_hr      = excluded.avg_hr,
        max_hr      = excluded.max_hr,
        tracked     = excluded.tracked,
        counts      = excluded.counts,
        raw         = excluded.raw,
        uploaded_at = now();

    update public.devices set last_seen_at = now() where id = d.id;

    return jsonb_build_object('ok', true, 'linked', d.user_id is not null);
end
$$;

-- Called by the watch when a match is deleted there.
create or replace function public.delete_match(p_secret text, p_local_id text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
    delete from public.matches m
    using public.devices d
    where m.device_id = d.id
      and d.secret_hash = public._hash_secret(p_secret)
      and m.local_id = p_local_id;
    return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------- dashboard-facing function

-- Called by a signed-in user on the dashboard with the code shown on their watch.
create or replace function public.link_device(p_code text, p_label text default 'Watch')
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
    d public.devices;
begin
    if auth.uid() is null then
        raise exception 'Sign in first';
    end if;

    update public.devices
    set user_id = auth.uid(),
        label = coalesce(nullif(trim(p_label), ''), 'Watch'),
        linked_at = now(),
        link_code = null,
        link_code_expires = null
    where link_code = upper(trim(p_code))
      and link_code_expires > now()
      and user_id is null
    returning * into d;

    if not found then
        raise exception 'That code is wrong or has expired. Open Link on the watch for a fresh one.';
    end if;

    return jsonb_build_object('ok', true, 'device_id', d.id);
end
$$;

-- ---------------------------------------------------------------- permissions

revoke all on function public._hash_secret(text) from public, anon, authenticated;
revoke all on function public._new_link_code() from public, anon, authenticated;

-- Table access for the dashboard (rows are still filtered by the policies above).
revoke all on public.devices, public.matches from anon;
grant select, delete on public.matches to authenticated;
grant select, delete on public.devices to authenticated;
grant update (label) on public.devices to authenticated;

grant execute on function public.register_device(text) to anon, authenticated;
grant execute on function public.upload_match(text, jsonb) to anon, authenticated;
grant execute on function public.delete_match(text, text) to anon, authenticated;
grant execute on function public.link_device(text, text) to authenticated;
