export const maxRecommendationCycles = 40;
const maxTurnsPerCycle = 40;
const cyclePrefix = 'seoul-recommend-cycle:';
const knownTastes = new Set([
  '안 매운', '매운', '순살', '뼈', '치즈 듬뿍', '푸짐', '바삭', '마늘', '간장', '양념', '치즈', '로제',
  '짜장', '짬뽕', '마라', '국물', '담백', '반반', '불향', '해물', '크림', '얼큰', '칼칼', '달콤', '화덕', '세트',
  '단맛', '신맛', '짠맛', '쓴맛', '고소함', '감칠맛',
]);

export const validHistoryId = id => typeof id === 'string' && !!id.trim() && id.length <= 120;
const validPositive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;

export function readHistoryContext(raw) {
  const { region, category, people, budget, tastes } = raw ?? {};
  return {
    region: typeof region === 'string' && /^(?:[가-힣]{1,4}구|서울 전체)$/.test(region) ? region : null,
    category: typeof category === 'string' && /^[가-힣·]{2,16}$/.test(category) ? category : null,
    people: validPositive(people, 20),
    budget: validPositive(budget, 100000000),
    tastes: Array.isArray(tastes) ? [...new Set(tastes.filter(value => knownTastes.has(value)))].sort().slice(0, 8) : [],
  };
}

export function recommendationContext(state) {
  const { menu, people, budget, budget_unit, taste } = state?.cond ?? {};
  return readHistoryContext({
    region: state?.dong, category: menu, people,
    budget: budget_unit === 'per_person' && budget ? budget * (people ?? 1) : budget,
    tastes: taste,
  });
}

export function recordRecommendationTurn(cycle, action, state, reply) {
  if (reply.resetConversation) return null;
  const step = {
    action: action.type, context: recommendationContext(state),
    offers: reply.cards?.length ?? Number(Boolean(reply.selected)),
  };
  return {
    id: cycle?.id ?? crypto.randomUUID(),
    steps: [...(cycle?.steps ?? []), step].slice(-maxTurnsPerCycle),
  };
}

const storagePrefix = accountId => cyclePrefix + (accountId ?? 'guest') + ':';
export const orderHistoryVersionKey = accountId => 'seoul-recommend-order-version:' + accountId;

function storedCycles(accountId, storage) {
  const prefix = storagePrefix(accountId);
  const entries = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const cycle = JSON.parse(storage.getItem(key));
      if (cycle?.id === key.slice(prefix.length) && Number.isFinite(cycle.completedAt) &&
          validHistoryId(cycle.choice?.storeId) && Array.isArray(cycle.choice.menuIds) && Array.isArray(cycle.steps)) {
        entries.push({ key, cycle });
      }
    } catch { /* A damaged entry does not affect other cycles. */ }
  }
  return entries.sort((a, b) => b.cycle.completedAt - a.cycle.completedAt);
}

export function saveRecommendationCycle(accountId, cycle, offer, choice, storage = globalThis.localStorage, now = Date.now()) {
  // A card can complete only the cycle that produced it, after a successful cart write.
  if (!cycle?.steps?.length || cycle.id !== offer?.cycleId || !validHistoryId(choice.storeId)) return false;
  const menuIds = [...new Set(choice.menuIds.filter(validHistoryId))].slice(0, 2);
  if (!menuIds.length) return false;
  const key = storagePrefix(accountId) + cycle.id;
  try {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, JSON.stringify({
      ...cycle, completedAt: now, context: readHistoryContext(offer.context),
      choice: { storeId: choice.storeId, menuIds, total: validPositive(choice.total, 100000000) },
    }));
    for (const old of storedCycles(accountId, storage).slice(maxRecommendationCycles)) storage.removeItem(old.key);
    return true;
  } catch {
    return false;
  }
}

export function recommendationCycles(accountId, storage = globalThis.localStorage) {
  try {
    return storedCycles(accountId, storage).slice(0, maxRecommendationCycles).map(({ cycle }) => {
      const { context, choice, completedAt } = cycle;
      const revisions = new Set(cycle.steps.map(step => readHistoryContext(step?.context))
        .filter(step => step.category === context?.category && step.region === context?.region)
        .map(({ people, budget, tastes }) => JSON.stringify([people, budget, tastes])));
      return { ...choice, context, completedAt, refinements: Math.min(3, Math.max(0, revisions.size - 1)) };
    });
  } catch {
    return [];
  }
}
