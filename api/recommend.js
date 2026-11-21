import { createLLM } from "../lib/llm/index.js";
import { createEngine } from "../lib/engine.js";
import { supabaseConfig } from "../dist/supabase-config.js";

// 턴 전체 시간 예산. 남은 시간이 부족하면 AI 재요청 없이 규칙 기반 폴백.
const TURN_BUDGET_MS = 12000;
// 가게 데이터(snapshot)는 수 MB라 받는 데 수 초 걸린다. 인스턴스마다 캐시해서 콜드 로드만 느리게.
const CATALOG_TIMEOUT_MS = 15000; // + AI 예산 12초 < Vercel maxDuration 30초
const CATALOG_TTL_MS = 10 * 60 * 1000;

let catalog;
let loading;

export async function engine() {
  if (catalog?.expires > Date.now()) return catalog.value;
  loading ??= (async () => {
    const response = await fetch(supabaseConfig.url + "/rest/v1/rpc/seoul_recommendation_snapshot", {
      method: "POST",
      headers: { apikey: supabaseConfig.publishableKey, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error("Supabase response " + response.status);
    const snapshot = await response.json();
    if (!Array.isArray(snapshot.stores) || !Array.isArray(snapshot.menus)) throw new Error("Catalog response invalid");
    const value = createEngine(snapshot);
    catalog = { value, expires: Date.now() + CATALOG_TTL_MS };
    return value;
  })().finally(() => { loading = undefined; });
  return loading;
}

export default async function recommend(req, res) {
  const started = Date.now();
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "지원하지 않는 요청입니다." });
  }

  let body;
  if (req.method === "POST") {
    try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
    catch { return res.status(400).json({ error: "추천 요청을 읽을 수 없습니다." }); }
    const action = body?.action;
    if (!["dong", "text", "apply", "option"].includes(action?.type) ||
        (action.type === "text" && (typeof action.text !== "string" || action.text.length > 300)) ||
        JSON.stringify(body).length > 50000) {
      return res.status(400).json({ error: "지역이나 음식 요청을 확인해 주세요." });
    }
  }

  let current;
  try { current = await engine(); }
  catch (error) {
    console.warn("Recommendation catalog unavailable:", error.message);
    return res.status(503).json({ error: "가게 데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요." });
  }
  const catalogMs = Date.now() - started;
  if (req.method === "GET") return res.status(200).json({ regions: current.regions, categories: current.categories });

  if (body.action.type === "dong" && !current.regions.includes(body.action.dong)) {
    return res.status(400).json({ error: "목록에 표시된 지역을 골라 주세요." });
  }
  const ai = createLLM(process.env, { deadline: Date.now() + TURN_BUDGET_MS });
  try {
    const result = await current.handle(body.state, body.action, ai);
    const timing = { catalog: catalogMs, ...ai.timing, total: Date.now() - started };
    return res.status(200).json({ ...result, provider: ai.used ? ai.provider : "rules", timing });
  } catch (error) {
    console.warn("Recommendation request failed:", error.message);
    return res.status(400).json({ error: "요청을 처리하지 못했어요. 지역과 조건을 다시 확인해 주세요." });
  }
}
