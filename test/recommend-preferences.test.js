import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../lib/engine.js';
import { recommendationAffinity } from '../lib/recommend-preferences.js';
import {
  recommendationContext, recommendationCycles, recordRecommendationTurn, saveRecommendationCycle,
} from '../dist/recommend-history.js';

function memoryStorage() {
  const entries = new Map();
  return {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index],
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
}

test('a cart choice completes its own cycle once and keeps structured refinements scoped by account', () => {
  const storage = memoryStorage();
  const first = { dong: '서초구', cond: { menu: '치킨', people: 2, budget: 25000 } };
  const last = { ...first, cond: { ...first.cond, budget: 24000, taste: ['순살', '공유하지 않을 원문'] } };
  const original = recordRecommendationTurn(null, { type: 'text', text: '공유하지 않을 원문' }, first, { cards: [{}] });
  const cycle = recordRecommendationTurn(original, { type: 'option', index: 0 }, last, { cards: [{}] });
  const offer = { cycleId: cycle.id, context: recommendationContext(last) };
  const choice = { storeId: 'regular', menuIds: ['regular-menu', 'regular-menu'], total: 21000 };
  assert.deepEqual(recommendationCycles('customer', storage), []);
  assert.equal(saveRecommendationCycle('customer', cycle, { ...offer, cycleId: 'old' }, choice, storage), false);
  assert.equal(saveRecommendationCycle('customer', cycle, offer, choice, storage, 1000), true);
  assert.equal(saveRecommendationCycle('customer', cycle, offer, choice, storage, 1001), false);
  assert.deepEqual(recommendationCycles('customer', storage), [{
    storeId: 'regular', menuIds: ['regular-menu'], total: 21000, context: offer.context, completedAt: 1000, refinements: 1,
  }]);
  assert.doesNotMatch(storage.getItem(storage.key(0)), /공유하지 않을 원문/);
  assert.deepEqual(recommendationCycles('another-customer', storage), []);
  assert.deepEqual(recommendationCycles(undefined, storage), []);
  assert.equal(recordRecommendationTurn(cycle, { type: 'text' }, last, { resetConversation: true }), null);
});

test('cart learning weighs matched historical conditions and recency while confirmed orders carry more weight', () => {
  const state = { dong: '서초구', cond: { menu: '치킨', people: 2, budget: 24000, taste: ['순살'] } };
  const now = Date.UTC(2026, 10, 21);
  const similar = { context: recommendationContext(state), completedAt: now, refinements: 2, total: 21000 };
  const affinity = recommendationAffinity({
    orders: { stores: [{ id: 'ordered', count: 1 }], menus: [{ id: 'ordered-menu', count: 1 }] },
    cycles: [
      { ...similar, storeId: 'similar', menuIds: ['similar-menu'] },
      { ...similar, storeId: 'different', menuIds: ['different-menu'], context: { region: '영등포구', category: '분식', budget: 50000 }, refinements: 0 },
      { ...similar, storeId: 'older', menuIds: ['older-menu'], completedAt: now - 45 * 86400000 },
    ],
  }, state, now);
  const best = affinity('similar', 'similar-menu');
  assert.ok(best.score > affinity('different', 'different-menu').score);
  assert.ok(best.score > affinity('older', 'older-menu').score);
  assert.ok(best.score < affinity('ordered', 'ordered-menu').score);
  assert.equal(best.reason, 'cartMenu');
  assert.equal(affinity('similar', 'new-menu').reason, 'cartStore');
});

test('first and later recommendations favor the ordered SKU from eligible plans and respect current constraints', async () => {
  const shops = [
    ['regular', '서초구', true],
    ['far', '마포구', true],
    ['closed', '서초구', false],
    ['over-budget', '서초구', true],
    ...Array.from({ length: 10 }, (_, index) => ['other-' + index, '서초구', true]),
  ];
  const engine = createEngine({
    stores: shops.map(([id, region, is_open]) => ({
      id, name: id, region, dong: '동네', category: '치킨', tip: 1000, rating: 4.5, is_open,
    })),
    menus: [
      { id: 'regular-order', store: 'regular', name: '매콤한 순살치킨', price: 23000, desc: '매운 양념' },
      { id: 'regular-mild', store: 'regular', name: '순한 맛 순살치킨', price: 17500, desc: '맵지 않은 간장' },
      ...shops.slice(1).map(([store]) => ({
        id: store + '-menu', store, name: '뼈 치킨', price: store === 'over-budget' ? 29000 : 16500, desc: '순한 맛',
      })),
    ],
  });
  const history = {
    orders: {
      menus: [
        { id: 'far-menu', count: 20 }, { id: 'closed-menu', count: 20 },
        { id: 'over-budget-menu', count: 19 }, { id: 'regular-order', count: 8 },
      ],
      stores: [{ id: 'regular', count: 8 }],
    },
  };
  const region = await engine.handle(null, { type: 'dong', dong: '서초구' }, undefined, {
    orders: { menus: [{ id: 'regular-order', count: 8 }], stores: [{ id: 'regular', count: 8 }] },
  });
  assert.equal(region.reply.cards[0].menuId, 'regular-order');
  assert.equal(region.state.cond.menu, null);
  const query = { type: 'text', text: '서초구에서 둘이 2만5천 원 이하로 치킨 추천해줘' };
  const base = await engine.handle(null, query);
  assert.equal(base.reply.cards.some(card => card.storeId === 'regular'), false);
  const ai = { judge: async ({ stores }) => stores.map(({ store_id }) => ({
    store_id, match: '일부', menu_ids: [], quotes: [],
  })) };
  const result = await engine.handle(null, query, ai, history);
  assert.equal(result.reply.cards[0].menuId, 'regular-order');
  assert.equal(result.reply.cards[0].preferredBy, 'orderedMenu');
  assert.ok(result.reply.cards.every(card => card.total <= 25000 && !['closed', 'far'].includes(card.storeId)));
  const narrowed = await engine.handle(result.state, { type: 'text', text: '안 매운 치킨으로 바꿔줘' }, undefined, history);
  assert.ok(narrowed.reply.cards.length);
  assert.equal(narrowed.reply.cards.some(card => card.menuId === 'regular-order'), false);
});
