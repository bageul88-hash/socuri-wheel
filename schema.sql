-- ============================================================
--  socuri-wheel — Supabase 초기 스키마
--
--  신규 프로젝트의 SQL Editor 에 통째로 붙여넣어 1회 실행.
--  index.html(키오스크, 비로그인 anon) / admin.html(관리자, authenticated)
--  두 화면의 실제 코드 사용처에서 역산한 스키마입니다.
--
--  구조 요약
--    테이블 6 : members, point_logs, spins, settings, spaces, reservations
--    RPC   4 : kiosk_register, kiosk_spin, kiosk_check_today, get_member_by_code
--
--  접근 원칙
--    키오스크(anon)      : settings 읽기만 직접. 나머지는 전부 RPC 경유.
--    관리자(authenticated): 전 테이블 풀 액세스.
-- ============================================================

create extension if not exists pgcrypto;

-- ────────────── 1. members ──────────────
-- id 가 uuid 인 근거: admin.html 의 openPM('…') 가 id 를 따옴표로 감싸 전달.
create table public.members (
  id           uuid primary key default gen_random_uuid(),
  name         text        not null,
  phone        text,
  points       integer     not null default 0,
  attend_count integer     not null default 0,
  created_at   timestamptz not null default now()
);
create index members_created_at_idx on public.members (created_at desc);
-- 회원번호(전화번호 뒷 4자리) 조회용 — get_member_by_code 가 사용
create index members_phone_last4_idx
  on public.members (right(regexp_replace(phone, '\D', '', 'g'), 4));

-- ────────────── 2. point_logs ──────────────
-- admin.html 포인트 조정 시 이력 적재 (실패해도 무시되는 보조 테이블)
create table public.point_logs (
  id         bigint generated always as identity primary key,
  member_id  uuid        not null references public.members(id) on delete cascade,
  delta      integer     not null,
  reason     text,
  created_at timestamptz not null default now()
);
create index point_logs_member_idx on public.point_logs (member_id, created_at desc);

-- ────────────── 3. spins ──────────────
-- 원반 참여 이력. 1일 1회 제한 판정의 근거 테이블.
create table public.spins (
  id         bigint generated always as identity primary key,
  member_id  uuid        not null references public.members(id) on delete cascade,
  prize      text        not null,
  created_at timestamptz not null default now()
);
create index spins_member_created_idx on public.spins (member_id, created_at desc);

-- ────────────── 4. settings ──────────────
-- key/value 설정 저장소. 현재는 'wheel'(원반 옵션 배열) 한 건만 사용.
create table public.settings (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

-- ⚠ 'wheel' 행 시드는 필수.
--   admin.html 저장 로직이 update → 실패 시 insert 인데, supabase-js v2 는
--   0행 update 를 에러로 취급하지 않음. 행이 없으면 저장이 조용히 무시됨.
insert into public.settings (key, value) values
  ('wheel', '[
     {"label":"아메리카노 1잔","weight":1},
     {"label":"1,000원 할인","weight":3},
     {"label":"꽝! 다음 기회에","weight":4},
     {"label":"사이즈 업","weight":3},
     {"label":"디저트 1개","weight":1},
     {"label":"포인트 2배","weight":2}
   ]'::jsonb)
on conflict (key) do nothing;

-- ────────────── 5. spaces ──────────────
create table public.spaces (
  id             bigint generated always as identity primary key,
  name           text    not null,
  price_per_hour integer,                       -- NULL/0 이면 화면에 "무료"
  active         boolean not null default true, -- admin 은 active=true 만 조회
  created_at     timestamptz not null default now()
);

-- ────────────── 6. reservations ──────────────
-- spaces 로의 FK 는 필수. admin 의 .select("*, spaces(name, price_per_hour)")
-- 임베드는 FK 제약이 없으면 PostgREST 가 400 을 반환함.
create table public.reservations (
  id         bigint generated always as identity primary key,
  space_id   bigint      not null references public.spaces(id) on delete restrict,
  name       text        not null,
  phone      text,
  date       date        not null,
  start_time time        not null,
  end_time   time        not null,
  people     integer     not null default 1,
  memo       text,
  status     text        not null default '대기'
             check (status in ('대기','승인','취소','환불')),
  created_at timestamptz not null default now()
);
create index reservations_date_idx  on public.reservations (date desc, start_time desc);
create index reservations_space_idx on public.reservations (space_id);


-- ============================================================
--  RLS
-- ============================================================
alter table public.members      enable row level security;
alter table public.point_logs   enable row level security;
alter table public.spins        enable row level security;
alter table public.settings     enable row level security;
alter table public.spaces       enable row level security;
alter table public.reservations enable row level security;

-- settings : 키오스크가 원반 설정을 읽어야 하므로 anon SELECT 허용
create policy settings_select_all on public.settings
  for select to anon, authenticated using (true);
create policy settings_insert_admin on public.settings
  for insert to authenticated with check (true);
create policy settings_update_admin on public.settings
  for update to authenticated using (true) with check (true);

-- 나머지 : 로그인한 관리자만. anon 정책을 두지 않음(= 직접 접근 전면 차단).
create policy members_admin_all      on public.members      for all to authenticated using (true) with check (true);
create policy point_logs_admin_all   on public.point_logs   for all to authenticated using (true) with check (true);
create policy spins_admin_all        on public.spins        for all to authenticated using (true) with check (true);
create policy spaces_admin_all       on public.spaces       for all to authenticated using (true) with check (true);
create policy reservations_admin_all on public.reservations for all to authenticated using (true) with check (true);


-- ============================================================
--  RPC — 키오스크용. SECURITY DEFINER 로 RLS 를 우회하는 지점.
-- ============================================================

-- 회원번호 4자리 조회.
-- ⚠ 추정: "회원번호" = 전화번호 뒷 4자리.
--   근거 — 가입 시 회원번호를 화면에 한 번도 보여주지 않고 admin 목록에도
--   회원번호 컬럼이 없음. 손님이 아는 4자리 값은 전화 뒷자리뿐.
--   또한 클라이언트가 res.data[0] 로 배열 첫 행을 꺼냄 = 중복 가능한 값.
create or replace function public.get_member_by_code(code text)
returns table (id uuid, name text, phone text, points integer, attend_count integer)
language sql security definer set search_path = public as $$
  select m.id, m.name, m.phone, m.points, m.attend_count
    from public.members m
   where right(regexp_replace(m.phone, '\D', '', 'g'), 4) = code
   order by m.created_at desc
   limit 5;
$$;

-- 오늘 이미 참여했는지 (한국 시간 기준 1일 1회)
create or replace function public.kiosk_check_today(p_member_id uuid)
returns boolean
language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.spins s
     where s.member_id = p_member_id
       and (s.created_at at time zone 'Asia/Seoul')::date
         = (now()        at time zone 'Asia/Seoul')::date
  );
$$;

-- 신규 가입 / 기존 회원 재사용 → {member_id, spun_today}
-- 전화번호(숫자만)가 같으면 동일인으로 간주 — 커밋 93dee8e "회원 중복방지(RPC)"
create or replace function public.kiosk_register(p_name text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.members
   where regexp_replace(phone,   '\D','','g')
       = regexp_replace(p_phone, '\D','','g')
   order by created_at limit 1;

  if v_id is null then
    insert into public.members (name, phone) values (p_name, p_phone)
    returning id into v_id;
  end if;

  return jsonb_build_object('member_id', v_id,
                            'spun_today', public.kiosk_check_today(v_id));
end;
$$;

-- 당첨 결과 저장 + 방문수 증가. 하루 1회 제한을 서버에서 재검증.
-- ⚠ 추정: attend_count 를 올리는 코드가 프론트 어디에도 없고 admin 은 읽기만 함.
--   원반 참여 = 방문 1회로 보고 여기에 둠.
create or replace function public.kiosk_spin(p_member_id uuid, p_prize text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.kiosk_check_today(p_member_id) then return; end if;
  insert into public.spins (member_id, prize) values (p_member_id, p_prize);
  update public.members set attend_count = attend_count + 1 where id = p_member_id;
end;
$$;

grant execute on function public.kiosk_register(text,text) to anon, authenticated;
grant execute on function public.get_member_by_code(text)  to anon, authenticated;
grant execute on function public.kiosk_check_today(uuid)   to anon, authenticated;
grant execute on function public.kiosk_spin(uuid,text)     to anon, authenticated;


-- ============================================================
--  실행 후 수동으로 해야 하는 것
--
--  1) 관리자 계정 생성
--     admin.html 은 Supabase Auth 이메일/비밀번호 로그인을 사용.
--     Dashboard → Authentication → Users → Add user 로 계정을 만들어야 함.
--
--  2) spaces 데이터 입력
--     공간예약 탭은 spaces 행이 있어야 동작. 예:
--     insert into public.spaces (name, price_per_hour) values
--       ('세미나실 A', 30000), ('스터디룸 B', 20000), ('라운지', null);
--
--  3) 등급(tier) 설정은 DB 에 없음
--     admin.html 의 클라이언트 배열이라 새로고침하면 초기화됨(기존 동작 그대로).
--     영속화하려면 settings 테이블에 'tiers' 키로 옮기면 됨.
-- ============================================================
