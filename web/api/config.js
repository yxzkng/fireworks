/**
 * 브라우저에 공개 설정을 내려준다.
 *
 * 정적 HTML이라 빌드 시점 치환이 없어서, 키를 코드에 박는 대신
 * 환경변수에서 읽어 전달한다. 여기 담기는 값은 모두 공개용이다
 * (카카오 JS 키와 Supabase anon 키는 원래 브라우저에 노출되는 값이며,
 *  실제 보호는 카카오 도메인 등록과 Supabase RLS가 담당한다).
 * 서울시 인증키는 절대 여기 넣지 않는다.
 */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600');
  res.json({
    kakaoKey:     process.env.NEXT_PUBLIC_KAKAO_KEY     || '',
    supabaseUrl:  process.env.NEXT_PUBLIC_SUPABASE_URL  || '',
    supabaseKey:  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  });
}
