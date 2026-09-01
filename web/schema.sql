-- 여의도 불꽃 지도 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행하세요.

create table if not exists reports (
  id         uuid primary key default gen_random_uuid(),
  area       text        not null,              -- 장소명 (서울시 API 장소명과 동일)
  level      smallint    not null check (level between 1 and 4),
  comment    text        check (char_length(comment) <= 80),
  nickname   text        check (char_length(nickname) <= 12),
  photo_path text,                              -- Storage 안의 파일 경로
  flags      smallint    not null default 0,
  hidden     boolean     not null default false,
  created_at timestamptz not null default now()
);

-- 목록은 항상 "최근 것부터, 장소별로" 읽는다
create index if not exists reports_recent on reports (created_at desc);
create index if not exists reports_area   on reports (area, created_at desc);

alter table reports enable row level security;

-- 누구나 읽고 쓸 수 있다(로그인 없는 공개 제보 서비스).
-- 수정·삭제는 아무도 못 한다(update/delete 정책이 없으므로).
--
-- 읽기에서 hidden 행을 막지 않는 이유 (두 가지):
--  1. Realtime은 RLS가 SELECT를 막는 행의 이벤트를 조용히 버린다. hidden=false 조건을
--     걸면 "신고 3건으로 숨겨짐" UPDATE가 구독자에게 전달되지 않아, 다른 사람 화면에는
--     그 제보가 계속 남는다.
--  2. 폴링 모드에서도 클라이언트가 "내 화면의 제보 중 숨겨진 것"을 id로 조회해
--     걷어낸다(sweepHidden). 이 조회가 막히면 같은 문제가 생긴다.
-- 걸러내기는 클라이언트가 한다. 숨겨진 제보 내용이 응답에 실려 오지만
-- 어차피 공개 게시물이라 노출 위험은 없다.
create policy "누구나 읽기" on reports
  for select using (true);

create policy "누구나 제보" on reports
  for insert with check (
    level between 1 and 4
    and char_length(coalesce(comment, '')) <= 80
    and char_length(coalesce(nickname, '')) <= 12
    -- 사진 경로는 우리가 만드는 형식만 받는다. 임의 경로를 넣어
    -- 다른 파일을 가리키게 하는 것을 막는다.
    and (photo_path is null
         or photo_path ~ '^[0-9]{10,}-[a-z0-9]{4,12}(\.thumb)?\.jpg$')
  );

-- 브라우저 쪽 제한은 새로고침이나 도구로 우회된다.
-- 실제 방어는 여기서 한다: 같은 장소에 짧은 시간 안에 쏟아지는 제보를 막는다.
create or replace function reports_rate_limit()
returns trigger
language plpgsql
as $$
declare
  recent_count int;
begin
  -- 한 장소에 10초 안에 5건이 넘게 들어오면 정상적인 제보가 아니다.
  select count(*) into recent_count
    from reports
   where area = new.area
     and created_at > now() - interval '10 seconds';

  if recent_count >= 5 then
    raise exception 'rate_limited'
      using hint = '잠시 후 다시 시도해 주세요.';
  end if;

  return new;
end;
$$;

create trigger reports_rate_limit_trigger
  before insert on reports
  for each row execute function reports_rate_limit();

-- 신고는 flags만 올릴 수 있게 별도 함수로 처리한다.
-- update 정책을 열어두면 남의 제보 내용을 고칠 수 있기 때문이다.
create or replace function report_flag(report_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update reports
     set flags  = flags + 1,
         hidden = (flags + 1) >= 3      -- 신고 3건이면 자동으로 가린다
   where id = report_id;
end;
$$;

grant execute on function report_flag(uuid) to anon;

-- ── Storage 버킷 설정 ──────────────────────────────────────
-- 대시보드에서 photos 버킷을 만들 때 아래를 함께 지정하세요.
-- (SQL로도 되지만, 이미 만들었다면 대시보드에서 고치는 편이 확실합니다.)
--
--   Public bucket : 체크
--   File size limit : 1 MB      ← 원본이 200KB 안팎이라 충분한 여유
--   Allowed MIME types : image/jpeg
--
-- SQL로 하려면:
--   update storage.buckets
--      set public = true,
--          file_size_limit = 1048576,
--          allowed_mime_types = array['image/jpeg']
--    where id = 'photos';

-- 실시간 구독 켜기 — 한 사람의 제보가 모든 접속자 화면에 바로 뜬다
alter publication supabase_realtime add table reports;

-- UPDATE 이벤트에 변경 전후 값이 모두 실리도록 한다.
-- 기본값(primary key만)이면 클라이언트가 hidden 전환을 알아볼 수 없다.
-- (폴링 모드에서는 쓰이지 않지만, SYNC_MODE를 'realtime'으로 되돌릴 때 필요하다.)
alter table reports replica identity full;
