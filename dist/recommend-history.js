import { choiceKey, choicesForConditions, knownTastes } from './recommend-choices.js';

export const maxRecommendationCycles = 40;
const maxTurnsPerCycle = 40;
const maxChoiceTurns = 120;
const cyclePrefix = 'seoul-recommend-cycle:';
const choicePrefix = 'seoul-recommend-choice:';

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
    tracksChoices: true,
  };
}

const scopedPrefix = (prefix, accountId) => prefix + (accountId ?? 'guest') + ':';
export const orderHistoryVersionKey = accountId => 'seoul-recommend-order-version:' + accountId;

function storedEntries(storage, prefix, valid) {
  const entries = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const entry = JSON.parse(storage.getItem(key));
      if (Number.isFinite(entry?.completedAt) && valid(entry, key.slice(prefix.length))) entries.push({ key, entry });
    } catch { /* A damaged entry does not affect other records. */ }
  }
  return entries.sort((a, b) => b.entry.completedAt - a.entry.completedAt);
}

function storedCycles(accountId, storage) {
  return storedEntries(storage, scopedPrefix(cyclePrefix, accountId), (cycle, id) => cycle.id === id &&
    validHistoryId(cycle.choice?.storeId) && Array.isArray(cycle.choice.menuIds) && Array.isArray(cycle.steps));
}

export function saveRecommendationCycle(accountId, cycle, offer, choice, storage = globalThis.localStorage, now = Date.now()) {
  // A card can complete only the cycle that produced it, after a successful cart write.
  if (!cycle?.steps?.length || cycle.id !== offer?.cycleId || !validHistoryId(choice.storeId)) return false;
  const menuIds = [...new Set(choice.menuIds.filter(validHistoryId))].slice(0, 2);
  if (!menuIds.length) return false;
  const key = scopedPrefix(cyclePrefix, accountId) + cycle.id;
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
    return storedCycles(accountId, storage).slice(0, maxRecommendationCycles).map(({ entry: cycle }) => {
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

function storedChoiceTurns(accountId, storage) {
  return storedEntries(storage, scopedPrefix(choicePrefix, accountId), entry => Array.isArray(entry.keys));
}

export function saveRecommendationChoices(accountId, choices, storage = globalThis.localStorage, now = Date.now()) {
  const keys = [...new Set((Array.isArray(choices) ? choices : []).map(choiceKey).filter(Boolean))].slice(0, 12);
  if (!keys.length) return;
  try {
    const key = scopedPrefix(choicePrefix, accountId) + crypto.randomUUID();
    storage.setItem(key, JSON.stringify({ completedAt: now, keys }));
    for (const old of storedChoiceTurns(accountId, storage).slice(maxChoiceTurns)) storage.removeItem(old.key);
  } catch { /* Recommendations can work without a writable history. */ }
}

export function recommendationChoiceCounts(accountId, storage = globalThis.localStorage) {
  const counts = new Map();
  const count = key => counts.set(key, (counts.get(key) ?? 0) + 1);
  try {
    for (const { entry } of storedChoiceTurns(accountId, storage).slice(0, maxChoiceTurns)) {
      for (const key of new Set(entry.keys)) if (typeof key === 'string' && key.length <= 89) count(key);
    }
    for (const { entry: cycle } of storedCycles(accountId, storage).slice(0, maxRecommendationCycles)) {
      // Older cycles have condition snapshots but no individual choice events.
      if (cycle.tracksChoices) continue;
      const keys = new Set();
      let previous = {};
      for (const step of cycle.steps) {
        if (step?.action === 'dong') continue;
        const { category, people, tastes } = readHistoryContext(step?.context);
        const observed = choicesForConditions({
          menu: category !== previous.category ? category : null,
          people: people !== previous.people ? people : null,
          taste: tastes.filter(taste => !previous.tastes?.includes(taste)),
        });
        for (const choice of observed) keys.add(choiceKey(choice));
        previous = { category, people, tastes };
      }
      for (const key of keys) count(key);
    }
  } catch { /* The current session still accepts choices. */ }
  return counts;
}
