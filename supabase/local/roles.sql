-- The roles and schema a Supabase project has before any migration runs, as far
-- as Raft needs them. Local stack only (see docker-compose.yml).

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password 'local-authenticator-password';
grant anon, authenticated, service_role to authenticator;

create role supabase_auth_admin login createrole noinherit password 'local-auth-password';
create schema auth authorization supabase_auth_admin;
grant create on database postgres to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
grant usage on schema auth to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
-- As in a Supabase project: tables made later are granted to these roles by
-- default. The migration then narrows that down.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
