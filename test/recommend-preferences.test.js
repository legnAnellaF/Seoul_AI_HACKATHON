import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../lib/engine.js';
import { recommendationAffinity } from '../lib/recommend-preferences.js';
import {
  recommendationChoiceCounts, recommendationContext, recommendationCycles, recordRecommendationTurn,
  saveRecommendationChoices, saveRecommendationCycle,
} from '../dist/recommend-history.js';
import { choiceKey, followUpChoice, recommendedChoiceKeys } from '../dist/recommend-choices.js';

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

test('badges recognize repeated choices from their own group, scoped by account and browser', () => {
  const storage = memoryStorage();
  const menu = { group: 'menu', value: '치킨' };
  const people = { group: 'people', value: '2' };
  const hot = { group: 'heat', value: '매운' };
  const mild = { group: 'heat', value: '안 매운' };
  saveRecommendationChoices('customer', [people, people, hot, mild], storage);
  assert.equal(recommendedChoiceKeys([people, hot], recommendationChoiceCounts('customer', storage)).size, 0);
  saveRecommendationChoices('customer', [people, hot, mild], storage);
  saveRecommendationChoices('customer', [menu, menu], storage);
  const options = [menu, people, hot, mild];
  const count = () => recommendationChoiceCounts('customer', storage);
  assert.deepEqual([...recommendedChoiceKeys(options, count())], ['people:2']);
  saveRecommendationChoices('customer', [menu, hot], storage);
  assert.deepEqual([...recommendedChoiceKeys(options, count())], ['menu:치킨', 'people:2', 'heat:매운']);
  assert.equal(recommendedChoiceKeys(options, recommendationChoiceCounts('other', storage)).size, 0);
  assert.equal(recommendedChoiceKeys(options, recommendationChoiceCounts(undefined, storage)).size, 0);

  const crunchy = followUpChoice('바삭', '어떤 식감이 좋으세요?', '치킨');
  const soft = followUpChoice('부드럽게', '어떤 식감이 좋으세요?', '치킨');
  const sameLabel = followUpChoice('부드럽게', '어떤 반죽이 좋으세요?', '치킨');
  const observed = new Map([[choiceKey(crunchy), 3], [choiceKey(soft), 4]]);
  assert.notEqual(choiceKey(soft), choiceKey(sameLabel));
  assert.deepEqual([...recommendedChoiceKeys([crunchy, soft], observed, true)], [choiceKey(soft)]);
});

test('existing cart cycles contribute known changed conditions without double-counting new choice logs', () => {
  const storage = memoryStorage();
  const state = { dong: '서초구', cond: { menu: '치킨', people: 2, taste: ['순살'] } };
  const cycle = recordRecommendationTurn(null, { type: 'text' }, state, {});
  const { tracksChoices, ...legacy } = cycle;
  assert.equal(tracksChoices, true);
  const choice = { storeId: 'regular', menuIds: ['regular-menu'], total: 21000 };
  const save = entry => saveRecommendationCycle('customer', entry, {
    cycleId: entry.id, context: recommendationContext(state),
  }, choice, storage);
  save(legacy);
  save({ ...cycle, id: 'new-cycle' });
  const choices = recommendationChoiceCounts('customer', storage);
  assert.equal(choices.get('people:2'), 1);
  assert.equal(choices.get('menu:치킨'), 1);
  assert.equal(choices.get('chicken-cut:순살'), 1);
});

test('chat and direct choices use the same signals without counting carried conditions or expired buttons', async () => {
  const engine = createEngine({
    stores: [{ id: 'spicy', region: '서초구', dong: '서초4동', category: '치킨', name: '동네닭집', tip: 1000, rating: 4.5 }],
    menus: [{ id: 'spicy-menu', store: 'spicy', name: '매콤한 양념치킨', desc: '매운맛', price: 17000 }],
  });
  const start = await engine.handle(null, { type: 'dong', dong: '서초구' });
  const chat = await engine.handle(start.state, { type: 'text', text: '둘이 매운 치킨 추천해줘' });
  assert.deepEqual(chat.reply.learnedChoices, [
    { group: 'people', value: '2' }, { group: 'menu', value: '치킨' }, { group: 'heat', value: '매운' },
  ]);
  const click = await engine.handle(start.state, { type: 'apply', cond: { menu: '치킨', people: 2, taste: ['매운'] } });
  assert.deepEqual(click.reply.learnedChoices, chat.reply.learnedChoices);
  const budget = await engine.handle(chat.state, { type: 'text', text: '예산만 2만 원으로' });
  assert.deepEqual(budget.reply.learnedChoices, [{ group: 'budget-total', value: '20000' }]);
  const expired = await engine.handle(budget.state, { type: 'option', index: 8 });
  assert.equal(expired.reply.learnedChoices, undefined);
});

test('grounded cola and wrap choices learn the same answer from buttons and chat and retain safe menu filters', async () => {
  const shop = (id, category, name, desc) => ({
    store: { id, region: '서초구', dong: '서초4동', category, name: id + '가게', tip: 1000, rating: 4.5 },
    menu: { id: id + '-menu', store: id, name, desc, price: 19000 },
  });
  const rows = [
    shop('cola', '치킨', '후라이드 순살치킨 세트', '기본 구성은 순살치킨, 콜라입니다.'),
    shop('no-cola', '치킨', '순살치킨', '음료 미포함'),
    shop('unknown', '치킨', '후라이드 순살치킨', '기본 치킨'),
    shop('wrap', '고기·구이', '구이 모둠', '쌈채소를 한 번에 담았어요.'),
    shop('no-wrap', '고기·구이', '한입 구이', '쌈채소 별도 구매'),
  ];
  const engine = createEngine({ stores: rows.map(row => row.store), menus: rows.map(row => row.menu) });
  const chicken = await engine.handle(null, { type: 'text', text: '서초구 치킨 추천해줘' });
  assert.match(chicken.reply.followUp, /콜라/);
  const button = chicken.reply.buttons.find(button => button.label === '콜라 포함 (1곳)');
  const click = await engine.handle(chicken.state, button.action);
  const text = await engine.handle(chicken.state, { type: 'text', text: '콜라도 같이 주세요' });
  assert.deepEqual(click.reply.learnedChoices, [button.choice]);
  assert.deepEqual(text.reply.learnedChoices, [button.choice]);
  assert.deepEqual(text.reply.cards.map(card => card.storeId), ['cola']);
  const negative = await engine.handle(chicken.state, { type: 'text', text: '콜라 없이 주세요' });
  assert.deepEqual(negative.reply.cards.map(card => card.storeId), ['no-cola']);
  const info = await engine.handle(chicken.state, { type: 'text', text: '콜라 같이 오나요?' });
  assert.equal(info.reply.learnedChoices, undefined);

  const grill = await engine.handle(null, { type: 'text', text: '서초구 고기·구이 추천해줘' });
  assert.match(grill.reply.followUp, /쌈채소/);
  const wrap = await engine.handle(grill.state, { type: 'text', text: '쌈채소 먹어요' });
  assert.deepEqual(wrap.reply.learnedChoices, [{ group: 'addon-쌈채소', value: '쌈채소 포함' }]);
  assert.deepEqual(wrap.reply.cards.map(card => card.storeId), ['wrap']);
});

test('an optional taste or price answer is learned without clearing the budget', async () => {
  const stores = ['first', 'second'].map(id => ({
    id, region: '서초구', dong: '서초4동', category: '피자', name: id, tip: 1000, rating: 4.5,
  }));
  const engine = createEngine({ stores, menus: stores.map(({ id }, index) => ({
    id: id + '-menu', store: id, name: '매운 피자', desc: '매콤한 소스', price: 16000 + index * 2000,
  })) });
  const first = await engine.handle(null, { type: 'text', text: '서초구 매운 피자 2만 원 이하로 추천해줘' });
  assert.match(first.reply.followUp, /맛과 가격/);
  const taste = first.reply.buttons.find(button => button.label === '맛이 더 중요해요');
  const result = await engine.handle(first.state, taste.action);
  assert.deepEqual(result.reply.learnedChoices, [taste.choice]);
  assert.equal(result.state.cond.budget, 20000);
  assert.equal(result.state.cond.price_pref, 'any');
  const price = await engine.handle(first.state, { type: 'text', text: '가격 우선으로' });
  assert.deepEqual(price.reply.learnedChoices, [{ group: 'priority', value: 'price' }]);
  const skip = await engine.handle(first.state, { type: 'text', text: '상관없어요' });
  assert.equal(skip.state.cond.price_pref, 'none');
  assert.equal(skip.reply.learnedChoices, undefined);
});
