/**
 * 하루 API 호출 수가 서울시 한도(1,000회) 안에 들어가는지 검증한다.
 * worker.js의 tiersToFetch()를 그대로 불러 계산하므로,
 * 주기를 바꾼 뒤에는 반드시 이걸 돌려볼 것.
 *
 *   node check-budget.mjs
 */
import { readFileSync } from 'fs';

const LIMIT = 1000;
const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript,' + encodeURIComponent(
  src.split('const CORS =')[0] + '\nexport {tiersToFetch, HOT, WARM, COLD, ALL};'));

let total = 0, peak = 0;
const byHour = {};
for (let mins = 0; mins < 24 * 60; mins += 5) {
  const h = Math.floor(mins / 60), m = mins % 60;
  const n = mod.tiersToFetch(new Date(Date.UTC(2026, 8, 5, h, m))).length;
  total += n;
  byHour[h] = (byHour[h] || 0) + n;
  if (h >= 12 && h < 24) peak += n;
}

console.log(`장소: HOT ${mod.HOT.length} / WARM ${mod.WARM.length} / COLD ${mod.COLD.length} → 전체 ${mod.ALL.length}곳`);
console.log(`하루 호출: ${total}회 / 한도 ${LIMIT}회  (축제시간 ${peak}회)`);
console.log(total <= LIMIT
  ? `✅ 여유 ${LIMIT - total}회`
  : `❌ ${total - LIMIT}회 초과 — tiersToFetch() 주기를 늘리세요`);
console.log('\n시간대별:');
for (let h = 0; h < 24; h++) if (byHour[h]) console.log(`  ${String(h).padStart(2,'0')}시  ${byHour[h]}`);
process.exit(total <= LIMIT ? 0 : 1);
