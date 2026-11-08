-- いつか帳 共有帳のデータベース（Supabase / Postgres）
-- Supabase ダッシュボード → SQL Editor にこのファイルの中身を貼って Run する。何度流しても壊れないようにしてある。
--
-- 設計の要は notebook_id を全表に持たせること。権限の判定は is_member(notebook_id) の1つで済む。
-- 個人用の帳はこの表を一切使わない（端末内の localStorage / IndexedDB のまま）。
-- 時刻のうち created / done_at は端末の値（ミリ秒）をそのまま持ち、updated_at / deleted_at はサーバーの時計で持つ。

create extension if not exists pgcrypto with schema extensions;

-- ============================================================
-- 表
-- ============================================================

create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  display_name    text not null default '',
  plan            text not null default 'free' check (plan in ('free', 'plus')),
  plan_expires_at timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists public.notebooks (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(name) between 1 and 40),
  owner_id          uuid not null references public.profiles(id) on delete cascade,
  invite_token      text unique,
  invite_expires_at timestamptz,
  invite_uses_left  int,
  created_at        timestamptz not null default now()
);

create table if not exists public.members (
  notebook_id  uuid not null references public.notebooks(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  status       text not null default 'pending' check (status in ('pending', 'active', 'left')),
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (notebook_id, user_id)
);

create table if not exists public.categories (
  id          text not null,
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  name        text not null,
  color       text not null,
  hint        text,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (notebook_id, id)
);

create table if not exists public.items (
  id          text primary key,
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  category_id text not null,
  author_id   uuid default auth.uid() references public.profiles(id) on delete set null,
  text        text not null default '',
  url         text not null default '',
  note        text not null default '',
  photos      jsonb not null default '[]'::jsonb,   -- [{ "id": "p...", "by": "<user uuid>" }]
  done        boolean not null default false,
  done_at     bigint,
  created     bigint not null,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists items_nb_updated on public.items (notebook_id, updated_at);

create table if not exists public.reviews (
  item_id     text not null references public.items(id) on delete cascade,
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  rating      int not null default 0 check (rating between 0 and 5),
  review      text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (item_id, user_id)
);
create index if not exists reviews_nb_updated on public.reviews (notebook_id, updated_at);

-- ============================================================
-- 権限判定
-- ============================================================

create or replace function public.is_member(nb uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members
                 where notebook_id = nb and user_id = auth.uid() and status = 'active');
$$;

create or replace function public.is_owner(nb uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from notebooks where id = nb and owner_id = auth.uid());
$$;

create or replace function public.is_plus() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles
                 where id = auth.uid() and plan = 'plus'
                   and (plan_expires_at is null or plan_expires_at > now()));
$$;

-- ============================================================
-- 自動処理
-- ============================================================

-- Sign in with Apple で初めて入った人の profiles 行を作る
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- items の更新規則
--   ・書いた人・帳・作成日時は変えられない
--   ・削除済み（deleted_at あり）の行への編集は捨てる（削除が勝つ）
--   ・deleted_at は soft_delete_item / restore_item 経由でしか変えられない
--   ・写真は追記のみ。両方が足せば両方残る。外すのは remove_photo 経由だけ
create or replace function public.items_before_update() returns trigger
language plpgsql as $$
declare
  via text := coalesce(current_setting('itsuka.via', true), '');
begin
  new.author_id   := old.author_id;
  new.notebook_id := old.notebook_id;
  new.created     := old.created;
  if via = 'delete' or via = 'restore' then
    new.updated_at := now();
    return new;
  end if;
  if old.deleted_at is not null then
    return old;
  end if;
  new.deleted_at := old.deleted_at;
  if via <> 'photo' then
    -- 同じ写真IDは先に足したほうを残し、並びは古いものから
    new.photos := coalesce((
      select jsonb_agg(p order by ord) from (
        select distinct on (p->>'id') p, ord from (
          select p, n as ord from jsonb_array_elements(old.photos) with ordinality as a(p, n)
          union all
          select p, 1000000 + n from jsonb_array_elements(new.photos) with ordinality as b(p, n)
        ) both_p order by p->>'id', ord
      ) dedup
    ), '[]'::jsonb);
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists items_before_update on public.items;
create trigger items_before_update before update on public.items
  for each row execute function public.items_before_update();

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists reviews_touch on public.reviews;
create trigger reviews_touch before insert or update on public.reviews
  for each row execute function public.touch_updated_at();
drop trigger if exists categories_touch on public.categories;
create trigger categories_touch before insert or update on public.categories
  for each row execute function public.touch_updated_at();

-- 感想の notebook_id はメモから決める（端末の値を信じない）
create or replace function public.reviews_fill_nb() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select notebook_id into new.notebook_id from items where id = new.item_id;
  new.user_id := auth.uid();
  return new;
end $$;
drop trigger if exists reviews_fill_nb on public.reviews;
create trigger reviews_fill_nb before insert on public.reviews
  for each row execute function public.reviews_fill_nb();

-- ============================================================
-- RLS
-- ============================================================

alter table public.profiles   enable row level security;
alter table public.notebooks  enable row level security;
alter table public.members    enable row level security;
alter table public.categories enable row level security;
alter table public.items      enable row level security;
alter table public.reviews    enable row level security;

-- profiles：自分の行だけ。課金状態（plan）は端末から書き換えられない（Edge Function だけが書く）
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles for select using (id = auth.uid());
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;

-- notebooks：承認待ちの人にも名前だけは見える。作成・削除は関数経由
drop policy if exists notebooks_select on public.notebooks;
create policy notebooks_select on public.notebooks for select using (
  exists (select 1 from members m where m.notebook_id = notebooks.id and m.user_id = auth.uid()
          and m.status in ('pending', 'active')));
drop policy if exists notebooks_owner_update on public.notebooks;
create policy notebooks_owner_update on public.notebooks for update using (owner_id = auth.uid());
revoke update on public.notebooks from authenticated, anon;
grant update (name) on public.notebooks to authenticated;

-- members：読むだけ。書き込みは関数経由
drop policy if exists members_select on public.members;
create policy members_select on public.members for select using (is_member(notebook_id) or user_id = auth.uid());

-- categories：メンバーなら誰でも
drop policy if exists categories_all on public.categories;
create policy categories_all on public.categories for all
  using (is_member(notebook_id)) with check (is_member(notebook_id));

-- items：メンバーなら追加・編集できる。物理削除はしない
drop policy if exists items_select on public.items;
create policy items_select on public.items for select using (is_member(notebook_id));
drop policy if exists items_insert on public.items;
create policy items_insert on public.items for insert
  with check (is_member(notebook_id) and author_id = auth.uid());
drop policy if exists items_update on public.items;
create policy items_update on public.items for update
  using (is_member(notebook_id)) with check (is_member(notebook_id));

-- reviews：読むのはメンバー全員、書くのは自分の分だけ
drop policy if exists reviews_select on public.reviews;
create policy reviews_select on public.reviews for select using (is_member(notebook_id));
drop policy if exists reviews_write on public.reviews;
create policy reviews_write on public.reviews for insert
  with check (user_id = auth.uid() and is_member(notebook_id));
drop policy if exists reviews_update on public.reviews;
create policy reviews_update on public.reviews for update
  using (user_id = auth.uid()) with check (user_id = auth.uid() and is_member(notebook_id));
drop policy if exists reviews_delete on public.reviews;
create policy reviews_delete on public.reviews for delete using (user_id = auth.uid());

-- ============================================================
-- 関数（アプリから rpc で呼ぶ）
-- ============================================================

-- 共有帳を作る。プラス会員だけ。初期カテゴリ5つで始まる
create or replace function public.create_notebook(nb_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare nb uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not is_plus() then raise exception 'plus required' using errcode = 'P0001'; end if;
  insert into notebooks (name, owner_id) values (left(trim(nb_name), 40), auth.uid()) returning id into nb;
  insert into members (notebook_id, user_id, role, status) values (nb, auth.uid(), 'owner', 'active');
  insert into categories (id, notebook_id, name, color, hint, sort_order) values
    ('want',  nb, '欲しい',   '#F2545B', 'なにが欲しい？',   0),
    ('watch', nb, '観たい',   '#F5934A', 'なにを観たい？',   1),
    ('go',    nb, '行きたい', '#3DBE7A', 'どこに行きたい？', 2),
    ('eat',   nb, '食べたい', '#3FA2EA', 'なにを食べたい？', 3),
    ('make',  nb, '作りたい', '#F2C230', 'なにを作りたい？', 4);
  return nb;
end $$;

-- 招待リンク用のトークンを作る（作り直すと前のリンクは無効になる）。有効期限7日・回数上限つき
create or replace function public.create_invite(nb uuid, max_uses int default 5) returns text
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not is_owner(nb) then raise exception 'owner only'; end if;
  t := replace(gen_random_uuid()::text, '-', '');
  update notebooks set invite_token = t, invite_expires_at = now() + interval '7 days',
         invite_uses_left = greatest(1, least(max_uses, 50))
   where id = nb;
  return t;
end $$;

-- 招待リンクから参加申請を出す。リンクだけでは中身は見えない（作成者の承認が要る）
create or replace function public.request_join(token text)
returns table (notebook_id uuid, name text, status text)
language plpgsql security definer set search_path = public as $$
declare n notebooks; cur text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into n from notebooks where invite_token = token;
  if n.id is null or n.invite_expires_at < now() or coalesce(n.invite_uses_left, 0) <= 0 then
    raise exception 'invalid invite' using errcode = 'P0002';
  end if;
  select m.status into cur from members m where m.notebook_id = n.id and m.user_id = auth.uid();
  if cur = 'active' or cur = 'pending' then
    return query select n.id, n.name, cur; return;
  end if;
  insert into members (notebook_id, user_id, role, status) values (n.id, auth.uid(), 'member', 'pending')
    on conflict on constraint members_pkey do update set status = 'pending', joined_at = now();
  update notebooks set invite_uses_left = invite_uses_left - 1 where id = n.id;
  return query select n.id, n.name, 'pending'::text;
end $$;

-- 承認・却下（作成者だけ）
create or replace function public.decide_member(nb uuid, member uuid, approve boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(nb) then raise exception 'owner only'; end if;
  if approve then
    update members set status = 'active', joined_at = now(), last_read_at = now()
     where notebook_id = nb and user_id = member and status = 'pending';
  else
    delete from members where notebook_id = nb and user_id = member and status = 'pending';
  end if;
end $$;

-- メンバーを外す（作成者だけ）。書いたメモは残る
create or replace function public.remove_member(nb uuid, member uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(nb) or member = auth.uid() then raise exception 'not allowed'; end if;
  update members set status = 'left' where notebook_id = nb and user_id = member;
end $$;

-- 自分で抜ける（作成者は抜けられない。帳を削除する）
create or replace function public.leave_notebook(nb uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if is_owner(nb) then raise exception 'owner cannot leave'; end if;
  update members set status = 'left' where notebook_id = nb and user_id = auth.uid();
end $$;

-- 帳を削除する（作成者だけ）。写真はアプリが Storage から消す
create or replace function public.delete_notebook(nb uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(nb) then raise exception 'owner only'; end if;
  delete from notebooks where id = nb;
end $$;

-- メモの削除と取り消し（作成者か、書いた本人だけ）
create or replace function public.soft_delete_item(item text) returns void
language plpgsql security definer set search_path = public as $$
declare it items;
begin
  select * into it from items where id = item;
  if it.id is null or not is_member(it.notebook_id) then raise exception 'not found'; end if;
  if it.author_id is distinct from auth.uid() and not is_owner(it.notebook_id) then
    raise exception 'not allowed' using errcode = 'P0003';
  end if;
  perform set_config('itsuka.via', 'delete', true);
  update items set deleted_at = now() where id = item;
end $$;

create or replace function public.restore_item(item text) returns void
language plpgsql security definer set search_path = public as $$
declare it items;
begin
  select * into it from items where id = item;
  if it.id is null or not is_member(it.notebook_id) then raise exception 'not found'; end if;
  if it.author_id is distinct from auth.uid() and not is_owner(it.notebook_id) then
    raise exception 'not allowed';
  end if;
  perform set_config('itsuka.via', 'restore', true);
  update items set deleted_at = null where id = item;
end $$;

-- 写真を外す（足した本人か作成者だけ）
create or replace function public.remove_photo(item text, photo text) returns void
language plpgsql security definer set search_path = public as $$
declare it items; who text;
begin
  select * into it from items where id = item;
  if it.id is null or not is_member(it.notebook_id) then raise exception 'not found'; end if;
  select p->>'by' into who from jsonb_array_elements(it.photos) p where p->>'id' = photo;
  if who is distinct from auth.uid()::text and not is_owner(it.notebook_id) then
    raise exception 'not allowed';
  end if;
  perform set_config('itsuka.via', 'photo', true);
  update items set photos = coalesce((select jsonb_agg(p) from jsonb_array_elements(it.photos) p
                                      where p->>'id' <> photo), '[]'::jsonb)
   where id = item;
end $$;

-- 帳の一覧（ヘッダーのドロップダウン用）。名前・人数・未読件数
create or replace function public.notebook_summaries()
returns table (id uuid, name text, owner_id uuid, role text, status text, member_count int, unread int, pending_count int)
language sql stable security definer set search_path = public as $$
  select n.id, n.name, n.owner_id, m.role, m.status,
         (select count(*)::int from members x where x.notebook_id = n.id and x.status = 'active'),
         case when m.status = 'active' then
           (select count(*)::int from items i where i.notebook_id = n.id and i.deleted_at is null
              and i.updated_at > m.last_read_at and i.author_id is distinct from auth.uid())
         else 0 end,
         case when m.role = 'owner' then
           (select count(*)::int from members x where x.notebook_id = n.id and x.status = 'pending')
         else 0 end
    from members m join notebooks n on n.id = m.notebook_id
   where m.user_id = auth.uid() and m.status in ('pending', 'active')
   order by n.created_at;
$$;

-- メンバー一覧（名前つき）。作成者には承認待ちも見える
create or replace function public.notebook_members(nb uuid)
returns table (user_id uuid, display_name text, role text, status text)
language sql stable security definer set search_path = public as $$
  select m.user_id, coalesce(nullif(p.display_name, ''), 'メンバー'), m.role, m.status
    from members m left join profiles p on p.id = m.user_id
   where m.notebook_id = nb
     and (is_member(nb) and m.status = 'active' or is_owner(nb) and m.status = 'pending')
   order by m.role desc, m.joined_at;
$$;

-- 書いた人の名前（退会した人の分も残す。一覧のサブ情報と感想の表示用）
create or replace function public.notebook_authors(nb uuid)
returns table (user_id uuid, display_name text, status text)
language sql stable security definer set search_path = public as $$
  select m.user_id, coalesce(nullif(p.display_name, ''), 'メンバー'), m.status
    from members m left join profiles p on p.id = m.user_id
   where m.notebook_id = nb and is_member(nb);
$$;

create or replace function public.mark_read(nb uuid) returns void
language sql security definer set search_path = public as $$
  update members set last_read_at = now() where notebook_id = nb and user_id = auth.uid();
$$;

revoke execute on function public.create_notebook, public.create_invite, public.request_join,
  public.decide_member, public.remove_member, public.leave_notebook, public.delete_notebook,
  public.soft_delete_item, public.restore_item, public.remove_photo, public.notebook_summaries,
  public.notebook_members, public.notebook_authors, public.mark_read from anon, public;
grant execute on function public.create_notebook, public.create_invite, public.request_join,
  public.decide_member, public.remove_member, public.leave_notebook, public.delete_notebook,
  public.soft_delete_item, public.restore_item, public.remove_photo, public.notebook_summaries,
  public.notebook_members, public.notebook_authors, public.mark_read to authenticated;

-- ============================================================
-- Realtime（開いている帳の変更を受け取る）
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['items', 'reviews', 'categories', 'members'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================
-- 写真（Storage）  パスは <notebook_id>/<item_id>/<写真id>.jpg
-- ============================================================
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
  on conflict (id) do nothing;

drop policy if exists photos_select on storage.objects;
create policy photos_select on storage.objects for select
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists photos_insert on storage.objects;
create policy photos_insert on storage.objects for insert
  with check (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists photos_update on storage.objects;
create policy photos_update on storage.objects for update
  using (bucket_id = 'photos' and owner_id = auth.uid()::text);
drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects for delete
  using (bucket_id = 'photos' and (owner_id = auth.uid()::text
         or public.is_owner(((storage.foldername(name))[1])::uuid)));
