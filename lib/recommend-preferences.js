import { maxRecommendationCycles, readHistoryContext, recommendationContext, validHistoryId } from '../dist/recommend-history.js';

const maxOrderEntries = 32;
const day = 24 * 60 * 60 * 1000;
const placedStatuses = new Set(['pending', 'accepted', 'delivering', 'completed']);
const increment = (map, id, count = 1) => map.set(id, (map.get(id) ?? 0) + count);
const rankedCounts = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, maxOrderEntries)
  .map(([id, count]) => ({ id, count }));

export function summarizeOrderHistory(orders) {
  const stores = new Map();
  const menus = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!placedStatuses.has(order?.status) || !validHistoryId(order.store_id)) continue;
    increment(stores, order.store_id);
    const ids = Array.isArray(order.items) ? order.items.map(item => item?.id).filter(validHistoryId) : [];
    for (const id of new Set(ids)) increment(menus, id);
  }
  return { stores: rankedCounts(stores), menus: rankedCounts(menus) };
}

function orderCounts(raw) {
  const counts = new Map();
  for (const row of Array.isArray(raw) ? raw.slice(0, maxOrderEntries) : []) {
    if (validHistoryId(row?.id) && Number.isInteger(row.count) && row.count > 0 && row.count <= 100) {
      counts.set(row.id, Math.max(counts.get(row.id) ?? 0, row.count));
    }
  }
  return counts;
}

function cycleWeight(cycle, current, now) {
  const previous = readHistoryContext(cycle.context);
  const age = Math.max(0, (now - cycle.completedAt) / day);
  const matchingTastes = current.tastes.filter(taste => previous.tastes.includes(taste)).length;
  const pastPrice = previous.budget ?? (Number.isSafeInteger(cycle.total) && cycle.total > 0 ? cycle.total : null);
  const similarBudget = pastPrice && current.budget &&
    Math.min(pastPrice, current.budget) / Math.max(pastPrice, current.budget) >= 0.75;
  const refinements = Number.isInteger(cycle.refinements) ? Math.min(3, Math.max(0, cycle.refinements)) : 0;
  const contextBonus = 0.10 * Number(!!previous.region && previous.region === current.region) +
    0.20 * Number(!!previous.category && previous.category === current.category) +
    0.10 * Number(!!previous.people && previous.people === current.people) +
    0.15 * Number(Boolean(similarBudget)) + 0.3 * matchingTastes / Math.max(1, current.tastes.length);
  return 0.5 ** (age / 45) * (1 + contextBonus) * (1 + 0.08 * refinements);
}

const boost = (count, limit, half) => limit * count / (count + half);

export function recommendationAffinity(history, state, now = Date.now()) {
  const orderedStores = orderCounts(history?.orders?.stores);
  const orderedMenus = orderCounts(history?.orders?.menus);
  const cartStores = new Map();
  const cartMenus = new Map();
  const current = recommendationContext(state);
  const cycles = Array.isArray(history?.cycles) ? history.cycles.slice(0, maxRecommendationCycles) : [];
  for (const cycle of cycles) {
    if (!validHistoryId(cycle?.storeId) || !Array.isArray(cycle.menuIds) || !Number.isSafeInteger(cycle.completedAt) ||
        cycle.completedAt <= 0 || cycle.completedAt > now + day) continue;
    const ids = [...new Set(cycle.menuIds.slice(0, 2).filter(validHistoryId))];
    if (!ids.length) continue;
    const weight = cycleWeight(cycle, current, now);
    increment(cartStores, cycle.storeId, weight);
    for (const id of ids) increment(cartMenus, id, weight);
  }
  if (!(orderedStores.size || orderedMenus.size || cartStores.size)) return null;

  return (storeId, menuId) => {
    const storeOrders = orderedStores.get(storeId) ?? 0;
    const menuOrders = orderedMenus.get(menuId) ?? 0;
    const storeSelections = cartStores.get(storeId) ?? 0;
    const menuSelections = cartMenus.get(menuId) ?? 0;
    // A real menu order carries more weight than even repeated cart selections.
    const menuScore = boost(menuOrders, 30, 1) + boost(menuSelections, 10, 2);
    return {
      menuScore,
      score: menuScore + boost(storeOrders, 20, 1) + boost(storeSelections, 7, 2),
      reason: menuOrders ? 'orderedMenu' : storeOrders ? 'orderedStore' : menuSelections ? 'cartMenu' : storeSelections ? 'cartStore' : null,
    };
  };
}
