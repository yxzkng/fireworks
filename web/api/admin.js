/**
 * 관리자 전용 — 제보 사진 목록 확인 및 삭제.
 *
 *   GET  /api/admin?action=list      최근 제보 목록(사진 유무·flags·hidden 포함)
 *   POST /api/admin?action=delete    { id } 제보 1건을 DB·Storage에서 완전히 지운다
 *
 * 모든 요청은 헤더 `x-admin-password`로 인증한다(환경변수 ADMIN_PASSWORD와 비교).
 * service_role 키는 여기(서버)에서만 쓴다 — RLS를 무시하고 지울 수 있는 유일한
 * 경로이므로 브라우저로는 절대 내려주지 않는다(schema.sql은 delete 정책 자체가
 * 없어 anon 키로는 아무도 못 지우게 막아뒀다).
 */

function checkAuth(req, res) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    res.status(503).json({ error: 'admin_not_configured' });
    return false;
  }
  const given = req.headers['x-admin-password'];
  if (given !== password) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function sbHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

async function listReports(base, serviceKey, res) {
  const url = `${base}/rest/v1/reports?select=id,area,nickname,comment,level,flags,hidden,photo_path,created_at&order=created_at.desc&limit=200`;
  const r = await fetch(url, { headers: sbHeaders(serviceKey) });
  if (!r.ok) return res.status(502).json({ error: 'fetch_failed', status: r.status });
  const rows = await r.json();
  return res.json({ reports: rows });
}

async function deleteReport(base, serviceKey, id, res) {
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'missing_id' });
  }

  const getUrl = `${base}/rest/v1/reports?id=eq.${encodeURIComponent(id)}&select=photo_path`;
  const getRes = await fetch(getUrl, { headers: sbHeaders(serviceKey) });
  if (!getRes.ok) return res.status(502).json({ error: 'fetch_failed', status: getRes.status });
  const rows = await getRes.json();
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const { photo_path } = rows[0];

  if (photo_path) {
    const paths = [photo_path, photo_path.replace(/\.jpg$/, '.thumb.jpg')];
    const delRes = await fetch(`${base}/storage/v1/object/photos`, {
      method: 'DELETE',
      headers: { ...sbHeaders(serviceKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    });
    // Storage 삭제 실패는 DB 삭제를 막지 않는다(고아 파일보다 노출 제보가 남는 게 더 나쁘다).
    if (!delRes.ok) console.error('storage delete failed', await delRes.text().catch(() => ''));
  }

  const delUrl = `${base}/rest/v1/reports?id=eq.${encodeURIComponent(id)}`;
  const delDbRes = await fetch(delUrl, { method: 'DELETE', headers: sbHeaders(serviceKey) });
  if (!delDbRes.ok) return res.status(502).json({ error: 'delete_failed', status: delDbRes.status });

  return res.json({ ok: true });
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !serviceKey) {
    return res.status(503).json({ error: 'supabase_not_configured' });
  }

  const action = req.query?.action;

  if (req.method === 'GET' && action === 'list') {
    return listReports(base, serviceKey, res);
  }

  if (req.method === 'POST' && action === 'delete') {
    const id = req.body?.id;
    return deleteReport(base, serviceKey, id, res);
  }

  return res.status(404).json({ error: 'unknown_action' });
}
