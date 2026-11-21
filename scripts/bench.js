// 시연 질문을 실제 LLM으로 돌려 단계별 평균·최대 시간(ms)을 출력한다.
// 실행: GEMINI_API_KEY=... node scripts/bench.js [반복 횟수=1]
import { engine } from '../api/recommend.js';
import { createLLM } from '../lib/llm/index.js';

const QUESTIONS = [
  '서초구에서 둘이서 바삭한 간장치킨, 프랜차이즈 말고',
  '강남구 혼자 먹을 매운 거 만오천 원 이하',
  '마포구 가성비 좋은 국밥',
  '송파구 피자 2만 원 이하 치즈 듬뿍',
  '종로구 셋이서 중식 3만 원',
];
const TURN_BUDGET_MS = 12000;
const runs = Number(process.argv[2]) || 1;

if (!process.env.GEMINI_API_KEY) console.warn('GEMINI_API_KEY 없음 → 규칙 기반 시간만 측정됩니다.');
const t0 = Date.now();
const current = await engine();
console.log(`catalog ${Date.now() - t0}ms`);

const rows = [];
for (let r = 0; r < runs; r++) {
  for (const text of QUESTIONS) {
    const started = Date.now();
    const ai = createLLM(process.env, { deadline: started + TURN_BUDGET_MS });
    const out = await current.handle(undefined, { type: 'text', text }, ai);
    const row = { ...ai.timing, total: Date.now() - started };
    rows.push(row);
    console.log(`${(ai.used ? ai.provider : 'rules').padEnd(6)} ${String(row.total).padStart(5)}ms  카드 ${out.reply.cards?.length ?? 0}  ${text}`);
  }
}

console.log('\n단계        평균    최대   (호출된 턴 수)');
for (const step of ['parse', 'question', 'judge', 'total']) {
  const v = rows.map(r => r[step]).filter(n => n != null);
  if (!v.length) continue;
  console.log(`${step.padEnd(9)} ${String(Math.round(v.reduce((a, b) => a + b, 0) / v.length)).padStart(6)} ${String(Math.max(...v)).padStart(6)}   (${v.length})`);
}
