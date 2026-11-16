import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../lib/engine.js';

const snapshot = { stores: [], menus: [] };
function add(id, region, dong, category, name, menu, price, desc = '') {
  snapshot.stores.push({ id, region, dong, category, name, tip: 1000, rating: 4.5 });
  snapshot.menus.push({ id: id + '-1', store: id, name: menu, price, desc });
}
add('seocho-chicken', '서초구', '서초4동', '치킨', '서초통닭', '간장 순살치킨', 18000, '바삭한 껍질');
add('seocho-chicken-bone', '서초구', '서초2동', '치킨', '골목닭집', '뼈 양념치킨', 16000);
add('seocho-chicken-crunch', '서초구', '서초4동', '치킨', '바른통닭', '후라이드 순살치킨', 17000);
add('seocho-chicken-two', '서초구', '서초1동', '치킨', '옛날통닭', '두 마리 치킨', 27000, '넉넉한 두 마리');
add('gangnam-chicken', '강남구', '역삼동', '치킨', '역삼치킨', '간장 순살치킨', 21000, '바삭하고 푸짐한 치킨');
add('gangnam-pizza', '강남구', '역삼동', '피자', '역삼화덕', '버섯 피자', 18000);
add('gangnam-pizza-expensive', '강남구', '삼성동', '피자', '삼성화덕', '페퍼로니 피자', 28000);
add('gangnam-chinese', '강남구', '역삼동', '중식', '미소반점', '해물짬뽕', 8500, '얼큰한 해물 국물');
add('gangnam-chinese-two', '강남구', '삼성동', '중식', '정원중식당', '새우볶음밥', 9500);
add('mapo-korean', '마포구', '합정동', '한식', '합정식당', '김치찌개', 9000);
add('gangdong-gukbap', '강동구', '길동', '한식', '길동밥상', '돼지국밥', 17500, '푸짐한 한 그릇');
add('mapo-gukbap', '마포구', '합정동', '한식', '합정국밥집', '돼지국밥', 11000, '푸짐한 한 그릇');
add('gangdong-cheap-gukbap', '강동구', '성내동', '한식', '성내식당', '아침국밥', 7000, '푸짐한 국밥');
add('outside-seoul', '원미구', '상동', '치킨', '상동닭집', '후라이드치킨', 11000);
snapshot.menus.push({ id: 'seocho-side', store: 'seocho-chicken', name: '등심돈까스', price: 6000, desc: '푸짐한 돈까스' });

const noGemini = new Proxy({}, { get: () => async () => { throw Error('Gemini unavailable'); } });
const textTurn = (engine, previous, text, ai = noGemini) =>
  engine.handle(previous?.state, { type: 'text', text }, ai);
const cards = turn => turn.reply.cards?.map(c => c.storeId) ?? [];

test('changes district and dong without clearing food, headcount or budget', async () => {
  const engine = createEngine(snapshot);
  const first = await textTurn(engine, null, '서초구에서 둘이 2만5천 원 안에 치킨 추천해줘');
  assert.equal(first.state.dong, '서초구');
  assert.equal(first.state.cond.people, 2);
  assert.equal(first.state.cond.budget, 25000);
  assert.ok(cards(first).every(id => id.startsWith('seocho-')));
  assert.ok(first.reply.cards.every(c => c.menu !== '등심돈까스'));
  const change = await textTurn(engine, first, '서초구 말고 강남구에서 찾아줘');
  assert.equal(change.state.dong, '강남구');
  assert.equal(change.state.cond.budget, 25000);
  assert.deepEqual(cards(change), ['gangnam-chicken']);
  const dong = await textTurn(engine, change, '역삼동으로');
  assert.equal(dong.state.neighborhood, '역삼동');
  assert.deepEqual(cards(dong), ['gangnam-chicken']);
  const dropdown = await engine.handle(dong.state, { type: 'dong', dong: '서초구' }, noGemini);
  assert.equal(dropdown.state.cond.menu, '치킨');
  assert.equal(dropdown.state.neighborhood, null);
  assert.ok(cards(dropdown).every(id => id.startsWith('seocho-')));
});

test('expands the region and never includes stores outside Seoul in Seoul-wide results', async () => {
  const engine = createEngine(snapshot);
  const first = await textTurn(engine, null, '강남구에서 피자 추천해줘');
  const broad = await textTurn(engine, first, '다른 지역도 괜찮아');
  assert.equal(broad.state.dong, '서울 전체');
  assert.equal((await textTurn(engine, first, '상관없어요')).state.dong, '서울 전체');
  const chicken = await textTurn(engine, broad, '지역 상관없어. 치킨 말고 후라이드치킨 추천해줘');
  assert.equal(chicken.state.dong, '서울 전체');
  assert.deepEqual(cards(chicken), ['seocho-chicken-crunch']);
  const unknown = await textTurn(engine, chicken, '해운대구에서 추천해줘');
  assert.match(unknown.reply.text, /해운대구.*찾지 못했어요/);
  assert.equal(unknown.state.dong, '서울 전체');
  assert.deepEqual(cards(unknown), []);
});

test('replaces stale food filters and selections when a new request follows', async () => {
  const engine = createEngine(snapshot);
  const first = await textTurn(engine, null, '서초구에서 둘이 2만5천 원에 간장치킨 먹고 싶어');
  first.state.chosen = [{ label: '순살', store_ids: ['seocho-chicken'] }];
  first.state.seen = ['gangnam-pizza'];
  const second = await textTurn(engine, first, '치킨 말고 강남구에서 피자. 2만 원 이하로');
  assert.equal(second.state.cond.menu, '피자');
  assert.equal(second.state.cond.dish, null);
  assert.equal(second.state.cond.people, 2);
  assert.equal(second.state.cond.budget, 20000);
  assert.deepEqual(second.state.chosen, []);
  assert.deepEqual(cards(second), ['gangnam-pizza']);
  const third = await textTurn(engine, second, '가격은 상관없어');
  assert.equal(third.state.cond.budget, null);
  assert.ok(cards(third).includes('gangnam-pizza-expensive'));
  assert.ok(third.reply.followUp);
});

test('shows exact dishes, then explicitly labeled category alternatives for missing dishes or stores', async () => {
  const engine = createEngine(snapshot);
  const exact = await textTurn(engine, null, '강남구에서 짬뽕 추천해줘');
  assert.deepEqual(cards(exact), ['gangnam-chinese']);
  assert.equal(exact.reply.cards[0].menu, '해물짬뽕');
  const absent = await textTurn(engine, exact, '짜장면이 먹고 싶어');
  assert.match(absent.reply.text, /짜장면.*찾지 못했어요.*중식.*대안/);
  assert.ok(absent.reply.cards.every(c => c.partial && c.menu !== '짜장면'));
  const store = await textTurn(engine, absent, '“없는반점” 가게 있어?');
  assert.match(store.reply.text, /없는반점.*찾지 못했어요.*중식.*대안/);
  const exactShop = await textTurn(engine, store, '미소반점 있어?');
  assert.deepEqual(cards(exactShop), ['gangnam-chinese']);
  const overBudget = await textTurn(engine, exact, '8천 원 미만');
  assert.match(overBudget.reply.text, /데이터는 있지만 현재 조건/);
  assert.deepEqual(cards(overBudget), []);
});

test('places a grounded follow-up after the results and discards invented catalog entries', async () => {
  const engine = createEngine(snapshot);
  const ai = {
    parse: async () => ({}),
    judge: async () => [{ store_id: 'invented', menu_ids: ['invented'], match: '맞음' }],
    question: async () => ({ question: '순살과 뼈 중 어느 쪽이 좋으세요?', options: [
      { label: '순살', store_ids: ['seocho-chicken', 'seocho-chicken-crunch', 'invented'] },
      { label: '뼈', store_ids: ['seocho-chicken-bone'] },
    ] }),
  };
  const first = await textTurn(engine, null, '서초구 치킨 추천해줘', ai);
  assert.equal(first.reply.cards.length, 3);
  assert.ok(first.reply.cards.every(c => c.storeId !== 'invented'));
  assert.match(first.reply.followUp, /순살과 뼈/);
  assert.ok(first.reply.buttons.some(b => b.label === '순살 (2곳)'));
  const narrower = await textTurn(engine, first, '순살', ai);
  assert.ok(narrower.reply.cards.every(c => /순살/.test(c.menu)));
  assert.deepEqual(narrower.state.chosen.map(c => c.label), ['순살']);
  const moved = await textTurn(engine, narrower, '강남구로 바꿔줘', ai);
  assert.deepEqual(moved.state.cond.taste, ['순살']);
  assert.deepEqual(cards(moved), ['gangnam-chicken']);
});

test('Gemini can identify a specific new dish without introducing an invented menu or an amount', async () => {
  const engine = createEngine(snapshot);
  const first = await textTurn(engine, null, '강남구에서 둘이 2만5천 원에 피자 추천해줘');
  const ai = { ...noGemini, parse: async () => ({ menu: '피자', dish: '트러플 피자', budget: 99000 }), judge: noGemini.judge, question: noGemini.question };
  const second = await textTurn(engine, first, '트러플 피자가 먹고 싶어', ai);
  assert.equal(second.state.cond.dish, '트러플 피자');
  assert.equal(second.state.cond.budget, 25000);
  assert.match(second.reply.text, /트러플 피자.*찾지 못했어요/);
  assert.deepEqual(cards(second), ['gangnam-pizza']);
  const fallback = await textTurn(engine, first, '강남구로 바꾸고 트러플 피자 추천해줘');
  assert.match(fallback.reply.text, /트러플 피자.*찾지 못했어요/);
  const short = await textTurn(engine, first, '트러플 피자');
  assert.match(short.reply.text, /트러플 피자.*찾지 못했어요/);
  const withPrice = await textTurn(engine, first, '강남구에서 트러플 피자 추천해줘. 가격은 상관없어');
  assert.equal(withPrice.state.cond.budget, null);
  assert.match(withPrice.reply.text, /트러플 피자.*찾지 못했어요/);
});

test('understands the reported 1만원대 and excludes the original district on request', async () => {
  const engine = createEngine(snapshot);
  const selected = await engine.handle(null, { type: 'dong', dong: '강동구' }, noGemini);
  const first = await textTurn(engine, selected, '양 많은 1만원대 국밥을 먹고싶어');
  assert.equal(first.state.cond.budget_floor, 10000);
  assert.equal(first.state.cond.budget, 19999);
  assert.deepEqual(cards(first), ['gangdong-gukbap']);
  const moved = await textTurn(engine, first, '강동구에서 말고 다른 지역에서도 찾아봐줘');
  assert.equal(moved.state.dong, '서울 전체');
  assert.equal(moved.state.excludedRegion, '강동구');
  assert.equal(moved.state.cond.budget_floor, 10000);
  assert.deepEqual(cards(moved), ['mapo-gukbap']);
  const cheaper = await textTurn(engine, first, '8천 원 이하로 바꿔줘');
  assert.equal(cheaper.state.cond.budget_floor, null);
  assert.deepEqual(cards(cheaper), ['gangdong-cheap-gukbap']);
});

test('category selection clears the missing dish even when reselecting the current category', async () => {
  const engine = createEngine(snapshot);
  const first = await textTurn(engine, null, '강남구에서 트러플 피자 추천해줘');
  assert.match(first.reply.text, /트러플 피자.*찾지 못했어요/);
  const category = await engine.handle(first.state, { type: 'apply', cond: { menu: '피자' } }, noGemini);
  assert.equal(category.state.cond.dish, null);
  assert.doesNotMatch(category.reply.text, /트러플/);
  assert.ok(cards(category).includes('gangnam-pizza'));
  const changed = await engine.handle(category.state, { type: 'apply', cond: { menu: '중식' } }, noGemini);
  assert.ok(cards(changed).length && cards(changed).every(id => id.startsWith('gangnam-chinese')));
});
