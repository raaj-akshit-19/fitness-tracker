-- Raft: the initial schema.
--
-- Four tables, each row owned by one signed-in user:
--   profiles      one per user, made when the account is created
--   months        the months a user keeps (what a monthly sheet used to be)
--   daily_logs    one row per day that has anything entered
--   measurements  one row per Sunday that has anything entered
--
-- Every user-owned table has row level security: a user can only ever see and
-- change their own rows, whatever the application asks for. A day or a Sunday
-- can only be stored inside a month the same user keeps, and deleting a month
-- deletes its days and Sundays with it, so nothing is ever left behind.
--
-- The values and limits are the same as the application's validation
-- (backend/validation.py), so the database refuses anything the app would.

-- ---------------------------------------------------------------- profiles

create table public.profiles (
    id            uuid primary key references auth.users (id) on delete cascade,
    email         text,
    display_name  text not null default '' check (char_length(display_name) <= 60),
    created_at    timestamptz not null default now(),
    -- When anything of this user's last changed. The page asks for it every few
    -- seconds to know whether to read the month again.
    changed_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- months

create table public.months (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references public.profiles (id) on delete cascade,
    year        integer not null check (year between 2000 and 2100),
    month       integer not null check (month between 1 and 12),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint months_one_per_user unique (user_id, year, month)
);

-- ---------------------------------------------------------------- daily logs

create table public.daily_logs (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null,
    date              date not null,
    -- The month a day belongs to, worked out from its date, so that it can be
    -- tied to that month below.
    year              integer generated always as (extract(year from date)::integer) stored,
    month             integer generated always as (extract(month from date)::integer) stored,
    exercise_status   text check (exercise_status in ('Completed', 'Partial', 'Rest Day', 'Missed')),
    junk_food_status  text check (junk_food_status in ('None', 'Controlled', 'Had')),
    cardio_seconds    integer check (cardio_seconds between 0 and 999 * 60 + 59),
    calories          numeric check (calories >= 0 and calories <= 20000 and calories = trunc(calories)),
    protein           numeric check (protein >= 0 and protein <= 1000 and protein = round(protein, 1)),
    weight_lifted     numeric check (weight_lifted >= 0 and weight_lifted <= 100000 and weight_lifted = round(weight_lifted, 1)),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    constraint daily_logs_one_per_day unique (user_id, date),
    -- A day can only be stored in one of its owner's months, and goes with it.
    constraint daily_logs_in_a_month foreign key (user_id, year, month)
        references public.months (user_id, year, month) on delete cascade
);

-- ---------------------------------------------------------------- measurements

create table public.measurements (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null,
    date        date not null check (extract(isodow from date) = 7),     -- Sundays only
    year        integer generated always as (extract(year from date)::integer) stored,
    month       integer generated always as (extract(month from date)::integer) stored,
    weight      numeric check (weight > 0 and weight <= 500 and weight = round(weight, 1)),
    waist       numeric check (waist > 0 and waist <= 500 and waist = round(waist, 1)),
    chest       numeric check (chest > 0 and chest <= 500 and chest = round(chest, 1)),
    bicep       numeric check (bicep > 0 and bicep <= 500 and bicep = round(bicep, 1)),
    thigh       numeric check (thigh > 0 and thigh <= 500 and thigh = round(thigh, 1)),
    forearm     numeric check (forearm > 0 and forearm <= 500 and forearm = round(forearm, 1)),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint measurements_one_per_sunday unique (user_id, date),
    constraint measurements_in_a_month foreign key (user_id, year, month)
        references public.months (user_id, year, month) on delete cascade
);

-- The unique constraints above already index (user_id, year, month) and
-- (user_id, date). These make deleting a month find its days quickly.
create index daily_logs_by_month on public.daily_logs (user_id, year, month);
create index measurements_by_month on public.measurements (user_id, year, month);

-- ---------------------------------------------------------------- triggers

-- Keep updated_at current on every change.
create function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger months_updated_at before update on public.months
    for each row execute function public.set_updated_at();
create trigger daily_logs_updated_at before update on public.daily_logs
    for each row execute function public.set_updated_at();
create trigger measurements_updated_at before update on public.measurements
    for each row execute function public.set_updated_at();

-- Note on the owner's profile that something of theirs changed: added,
-- changed or deleted. This is what lets the page notice a deleted month too.
create function public.note_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.profiles
       set changed_at = now()
     where id = coalesce(new.user_id, old.user_id);
    return null;
end;
$$;

create trigger months_changed after insert or update or delete on public.months
    for each row execute function public.note_change();
create trigger daily_logs_changed after insert or update or delete on public.daily_logs
    for each row execute function public.note_change();
create trigger measurements_changed after insert or update or delete on public.measurements
    for each row execute function public.note_change();

-- Make the profile when an account is created. The display name is the one
-- given at registration.
create function public.make_profile() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, email, display_name)
    values (
        new.id,
        new.email,
        left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 60)
    );
    return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
    for each row execute function public.make_profile();

-- These are only ever run by the triggers above, never called directly.
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.note_change() from public, anon, authenticated;
revoke execute on function public.make_profile() from public, anon, authenticated;

-- ---------------------------------------------------------------- row level security

alter table public.profiles enable row level security;
alter table public.months enable row level security;
alter table public.daily_logs enable row level security;
alter table public.measurements enable row level security;

-- profiles: a user reads and renames only their own. They are made by the
-- trigger above and removed with the account, never by the user directly.
create policy "profiles: owner reads" on public.profiles
    for select to authenticated using ((select auth.uid()) = id);
create policy "profiles: owner updates" on public.profiles
    for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- months, daily_logs, measurements: the owner, and only the owner, can do anything.
create policy "months: owner reads" on public.months
    for select to authenticated using ((select auth.uid()) = user_id);
create policy "months: owner adds" on public.months
    for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "months: owner changes" on public.months
    for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "months: owner deletes" on public.months
    for delete to authenticated using ((select auth.uid()) = user_id);

create policy "daily_logs: owner reads" on public.daily_logs
    for select to authenticated using ((select auth.uid()) = user_id);
create policy "daily_logs: owner adds" on public.daily_logs
    for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "daily_logs: owner changes" on public.daily_logs
    for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "daily_logs: owner deletes" on public.daily_logs
    for delete to authenticated using ((select auth.uid()) = user_id);

create policy "measurements: owner reads" on public.measurements
    for select to authenticated using ((select auth.uid()) = user_id);
create policy "measurements: owner adds" on public.measurements
    for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "measurements: owner changes" on public.measurements
    for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "measurements: owner deletes" on public.measurements
    for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------- privileges

-- Someone who is not signed in gets nothing at all. A signed-in user gets only
-- the privileges the app needs (Supabase's defaults would also give TRUNCATE,
-- which row level security does not cover), and the policies above narrow
-- those to their own rows.
revoke all on public.profiles, public.months, public.daily_logs, public.measurements from anon, authenticated;
grant select, update (display_name) on public.profiles to authenticated;
grant select, insert, update, delete on public.months, public.daily_logs, public.measurements to authenticated;
