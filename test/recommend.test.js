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

const noGemini = new Proxy({}, { get: () => async () => { throw Error('LLM unavailable'); } });
const textTurn = (engine, previous, text, ai = noGemini) =>
  engine.handle(previous?.state, { type: 'text', text }, ai);
const cards = turn => turn.reply.cards?.map(c => c.storeId) ?? [];

test('requires cheese quantity evidence, diversifies brands and answers franchise questions in context', async () => {
  const pizza = [
    ['chain-one', '오븐피자 잠실점', true, '치즈 듬뿍', 18000],
    ['chain-two', '오븐피자 혜화점', true, '모짜렐라 가득', 19000],
    ['chain-three', '오븐피자 망우점', true, '더블 치즈', 20000],
    ['small-shop', '양철지붕피자', false, '치즈를 많이 올렸어요', 27000],
    ['cheese-only', '작은피자', false, '치즈 쭉쭉 고소', 9000],
    ['plain', '모락피자', false, '1인용 미니 피자', 7000],
  ];
  const engine = createEngine({
    stores: pizza.map(([id, name, franchise]) => ({
      id, name, franchise, region: '서초구', dong: '서초4동', category: '피자', rating: 4.5, tip: 1000,
    })),
    menus: pizza.map(([store, , , desc, price]) => ({ store, id: store + '-menu', name: '치즈피자', desc, price })),
  });
  const first = await textTurn(engine, null, '서초구에서 치즈가 많은 고소한 피자를 먹고 싶어');
  assert.deepEqual(first.state.cond.taste, ['치즈 듬뿍']);
  assert.equal(first.state.cond.dish, null);
  assert.equal(cards(first).filter(id => id.startsWith('chain')).length, 1);
  assert.ok(cards(first).includes('small-shop'));
  assert.ok(first.reply.cards.every(card => card.checks.includes('치즈 듬뿍')));
  const noAi = new Proxy({}, { get: () => assert.fail('A franchise question should only read the catalog') });
  const answer = await textTurn(engine, first, '너가 추천해준곳은 프렌차이즈 아닌가?', noAi);
  assert.match(answer.reply.text, /프랜차이즈.*오븐피자.*나머지/);
  assert.equal(answer.reply.preserveResults, true);
  assert.deepEqual(answer.state, first.state);
  const independent = await engine.handle(answer.state, answer.reply.buttons[0].action, noGemini);
  assert.deepEqual(cards(independent), ['small-shop']);
  assert.deepEqual(independent.state.cond.taste, ['치즈 듬뿍']);
  assert.equal(independent.state.cond.franchise, 'exclude');
  const explicit = await textTurn(engine, first, '프렌차이즈 아닌 피자집으로 바꿔줘');
  assert.deepEqual(cards(explicit), ['small-shop']);
  assert.deepEqual(explicit.state.cond.taste, ['치즈 듬뿍']);
  const tooCheap = await textTurn(engine, independent, '1만원으로 바꿔줘');
  assert.deepEqual(cards(tooCheap), ['small-shop']);
  assert.match(tooCheap.reply.cards[0].budgetNote, /18,000원/);
  const unavailable = await textTurn(createEngine({
    stores: [{ id: 'plain', name: '작은피자', franchise: false, region: '서초구', dong: '서초4동', category: '피자', rating: 4.5, tip: 1000 }],
    menus: [{ store: 'plain', id: 'plain-menu', name: '치즈피자', desc: '치즈 쭉쭉 고소', price: 9000 }],
  }), null, '서초구에서 치즈 듬뿍 피자 추천해줘');
  assert.match(unavailable.reply.text, /치즈 양이 많다는 근거/);
  assert.deepEqual(cards(unavailable), []);
});

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
  assert.deepEqual(cards(overBudget), ['gangnam-chinese']);
  assert.equal(overBudget.reply.cards[0].budgetNote, '예산보다 1,500원 높아요');
  assert.ok(!overBudget.reply.cards[0].checks.includes('예산'));
});

test('searches a group budget without a category and offers the nearest totals', async () => {
  const engine = createEngine({
    stores: snapshot.stores.filter(store => store.category === '치킨'),
    menus: snapshot.menus,
  });
  const result = await textTurn(engine, null, '5명이서 4만원에 배불리 먹고 싶어');
  assert.equal(result.state.dong, '서울 전체');
  assert.equal(result.state.cond.people, 5);
  assert.equal(result.state.cond.budget, 40000);
  assert.match(result.reply.text, /현재 조건.*예산에 가까운 대안/);
  assert.deepEqual(result.reply.cards.map(card => [card.qty, card.total]), [[3, 49000], [3, 52000], [2, 55000]]);
  assert.ok(result.reply.cards.every(card => card.partial && !card.checks.includes('예산')));
  assert.equal(result.reply.cards[0].budgetNote, '예산보다 9,000원 높아요');
  const confirmed = await textTurn(engine, result, '1번 메뉴가 마음에 들어');
  assert.equal(confirmed.reply.selected.budgetNote, '예산보다 9,000원 높아요');
  const sameDistrict = await textTurn(engine, result, '강남구에서 찾아줘');
  assert.deepEqual(cards(sameDistrict), ['gangnam-chicken']);
  assert.equal(sameDistrict.state.cond.budget, 40000);
});

test('compares listed set portions and mixed meals with one delivery fee per store', async () => {
  const engine = createEngine({
    stores: [
      { id: 'set-shop', name: '모둠중식', region: '강남구', dong: '역삼동', category: '중식', rating: 4.5, tip: 3000 },
      { id: 'mix-shop', name: '골목반점', region: '강남구', dong: '삼성동', category: '중식', rating: 4.5, tip: 2000 },
    ],
    menus: [
      { id: 'set', store: 'set-shop', name: '특선 세트 (3인분)', desc: '', price: 26000 },
      { id: 'single', store: 'set-shop', name: '잡채밥', desc: '', price: 11000 },
      { id: 'main', store: 'mix-shop', name: '해물짬뽕', desc: '2인분', price: 19000 },
      { id: 'rice', store: 'mix-shop', name: '새우볶음밥', desc: '1인분', price: 10000 },
      { id: 'drink', store: 'mix-shop', name: '콜라', desc: '', price: 1000 },
    ],
  });
  const result = await textTurn(engine, null, '강남구에서 3명이서 3만2천원으로 중식 추천해줘');
  assert.equal(result.reply.cards.length, 2);
  const set = result.reply.cards.find(card => card.storeId === 'set-shop');
  const mix = result.reply.cards.find(card => card.storeId === 'mix-shop');
  assert.equal(set.qty, 1);
  assert.equal(set.total, 29000);
  assert.equal(set.setMenu, true);
  assert.equal(set.portionNote, '3인분 표기 기준');
  assert.equal(mix.total, 31000);
  assert.deepEqual(mix.items.map(item => item.menuId).sort(), ['main', 'rice']);
  const approved = await textTurn(engine, result, '골목반점이 마음에 들어');
  assert.equal(approved.reply.selected.total, mix.total);
  assert.deepEqual(approved.reply.selected.items, mix.items);
  const exact = await textTurn(engine, null, '강남구에서 3명이서 3만2천원으로 짬뽕 추천해줘');
  assert.equal(exact.reply.cards[0].menuId, 'main');
  assert.ok(exact.reply.cards[0].items.some(item => item.menuId === 'rice'));
});

test('keeps both foods in the first results and lists all six unseen stores on request', async () => {
  const chickenStores = Array.from({ length: 4 }, (_, index) => ({ id: `chicken-${index}`, category: '치킨' }));
  const snackStores = Array.from({ length: 5 }, (_, index) => ({ id: `snack-${index}`, category: '분식' }));
  const stores = [...chickenStores, ...snackStores].map(store => ({
    ...store, name: store.id, region: '서초구', dong: '서초4동', tip: 1000, rating: 4.5,
  }));
  const menus = stores.map(store => ({
    id: `${store.id}-1`, store: store.id, name: store.category === '치킨' ? '후라이드치킨' : '떡볶이',
    price: store.category === '치킨' ? 18000 : 5500, desc: '',
  }));
  const engine = createEngine({ stores, menus });
  const first = await textTurn(engine, null, '치킨이랑 떡볶이를 같이 먹고 싶어');
  assert.equal(first.state.dong, '서울 전체');
  assert.deepEqual(first.reply.cards.map(card => card.foodLabel), ['치킨', '떡볶이', '치킨']);
  assert.equal(first.reply.remaining, 6);
  assert.match(first.reply.buttons[0].label, /6곳 더 보기/);
  const rest = await textTurn(engine, first, '다른 6곳도 알려줘');
  assert.equal(cards(rest).length, 6);
  assert.equal(new Set([...cards(first), ...cards(rest)]).size, 9);
  assert.equal(rest.reply.remaining, 0);
  assert.deepEqual(rest.state.cond.foods, first.state.cond.foods);
  const exhausted = await textTurn(engine, rest, '나머지 후보도 보여줘');
  assert.match(exhausted.reply.text, /더 보여드릴 후보가 없어요/);
  const switched = await textTurn(engine, rest, '떡볶이 말고 치킨으로 바꿔줘');
  assert.equal(switched.state.cond.menu, '치킨');
  assert.deepEqual(switched.state.cond.foods, []);
});

test('shows unseen single-food recommendations when the user asks for a count', async () => {
  const engine = createEngine(snapshot);
  const first = await textTurn(engine, null, '서초구에서 치킨 추천해줘');
  assert.equal(first.reply.remaining, 1);
  const rest = await textTurn(engine, first, '나머지 1곳도 보여줘');
  assert.equal(cards(rest).length, 1);
  assert.equal(rest.reply.remaining, 0);
  assert.ok(!cards(first).includes(cards(rest)[0]));
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

test('acknowledges a previous recommendation without re-running the search', async () => {
  const engine = createEngine(snapshot);
  const first = await textTurn(engine, null, '강남구에서 피자 추천해줘');
  assert.ok(first.reply.cards.length >= 2);
  const mustNotCallAI = new Proxy({}, { get() { assert.fail('confirmation must not perform a new search'); } });
  const ambiguous = await textTurn(engine, first, '마음에 들어', mustNotCallAI);
  assert.match(ambiguous.reply.text, /어느 추천이 마음에 들었나요/);
  const chosen = await textTurn(engine, ambiguous, '2번 가게가 마음에 들어', mustNotCallAI);
  const second = first.reply.cards[1];
  assert.equal(chosen.reply.selected.menuId, second.menuId);
  assert.equal(chosen.reply.selected.storeId, second.storeId);
  assert.match(chosen.reply.text, /장바구니/);
  assert.deepEqual(chosen.state.cond, first.state.cond);
  const again = await textTurn(engine, chosen, '그걸로 할게', mustNotCallAI);
  assert.equal(again.reply.selected.menuId, second.menuId);
  const byMenu = await textTurn(engine, first, '버섯 피자가 좋아', mustNotCallAI);
  assert.equal(byMenu.reply.selected.menu, '버섯 피자');
  const switched = await textTurn(engine, chosen, '마음에 드는데 중식으로 바꿔줘');
  assert.equal(switched.state.cond.menu, '중식');
  assert.equal(switched.reply.selected, undefined);
});

test('[P0-2] AI ② 입력은 상한까지만, 앞부분이 아니라 점수 순으로 보내고 선택지 가게는 코드가 근거로 계산한다', async () => {
  const { AI2_MAX_STORES, AI2_MAX_MENUS_PER_STORE, AI2_DESC_MAX_CHARS } = await import('../lib/engine.js');
  const stores = [], menus = [];
  for (let i = 0; i < 20; i++) {
    const id = 'big-' + String(i).padStart(2, '0');
    // 뒤쪽 가게일수록 별점이 높다 → 앞부분 자르기면 뽑히지 않는다
    stores.push({ id, region: '서초구', dong: '서초4동', category: '치킨', name: '닭집' + i, tip: 1000, rating: 3.5 + i * 0.07 });
    for (let k = 0; k < 6; k++) menus.push({ id: `${id}-${k}`, store: id, name: (i % 2 ? '순살' : '뼈') + '치킨' + k, price: 18000 + k * 100, desc: '가'.repeat(150) });
  }
  const engine = createEngine({ stores, menus });
  let payload;
  const ai = {
    parse: async () => { throw Error('LLM unavailable'); },
    judge: async () => { throw Error('LLM unavailable'); },
    question: async p => { payload = p; return { question: '순살과 뼈 중 어느 쪽?', options: [{ label: '순살', store_ids: [] }, { label: '뼈', store_ids: ['big-00'] }] }; },
  };
  const turn = await textTurn(engine, null, '서초구 치킨', ai);
  assert.equal(payload.stores.length, AI2_MAX_STORES);
  assert.ok(payload.stores.every(s => s.menus.length <= AI2_MAX_MENUS_PER_STORE && s.menus.every(m => m.desc.length <= AI2_DESC_MAX_CHARS)));
  assert.ok(payload.stores.some(s => s.store_id === 'big-19'));
  assert.ok(!payload.stores.some(s => s.store_id === 'big-00'));
  // AI가 store_ids를 비워 보내도 남은 20곳 전체에서 근거로 다시 센다
  assert.ok(turn.reply.buttons.some(b => b.label === '순살 (10곳)'));
  assert.ok(turn.reply.buttons.some(b => b.label === '뼈 (10곳)'));
});

test('[P0-4] 보정 별점·신규 가게·영업 여부', async () => {
  const stores = [], menus = [];
  const shop = (id, rating, reviews, extra = {}) => {
    stores.push({ id, region: '용산구', dong: '이촌동', category: '분식', name: id + '분식', tip: 1000, rating, reviews, ...extra });
    menus.push({ id: id + '-1', store: id, name: '떡볶이', price: 9000, desc: '' });
  };
  shop('lucky-one', 5.0, 1);       // 리뷰 1개짜리 5.0
  shop('steady', 4.7, 500);        // 리뷰 많은 4.7
  shop('newbie', null, 0);         // 리뷰 0개 신규
  shop('closed', 4.9, 300, { open: false });
  shop('avg-a', 4.0, 200); shop('avg-b', 4.2, 200);
  const engine = createEngine({ stores, menus });
  const turn = await textTurn(engine, null, '용산구 분식 추천해줘');
  assert.equal(cards(turn)[0], 'steady');   // 리뷰 1개 5.0 가게가 1등이 아님
  assert.match(turn.reply.text, /남은 5곳/); // 6곳 중 영업 안 하는 1곳만 빠짐 (신규 가게는 남음)
  assert.ok(cards(turn).includes('newbie'));
  assert.ok(!cards(turn).includes('closed'));
});

test('[P0-4] 리뷰 0개 신규 가게는 후보에서 빠지지 않고, open 정보가 없으면 지금처럼 영업중으로 본다', async () => {
  const engine = createEngine({
    stores: [
      { id: 'n1', region: '용산구', dong: '이촌동', category: '분식', name: '새가게', tip: 1000, rating: null, reviews: 0, open: true },
      { id: 'n2', region: '용산구', dong: '이촌동', category: '분식', name: '옛가게', tip: 1000, rating: 4.4 },
    ],
    menus: [
      { id: 'n1-1', store: 'n1', name: '떡볶이', price: 8000, desc: '' },
      { id: 'n2-1', store: 'n2', name: '떡볶이', price: 8000, desc: '' },
    ],
  });
  const turn = await textTurn(engine, null, '용산구 분식 추천해줘');
  assert.deepEqual(cards(turn).sort(), ['n1', 'n2']);
});

test('[P0-4] 메뉴에 main 표시가 있으면 그 메뉴를 대표 메뉴로 쓴다', async () => {
  const engine = createEngine({
    stores: [{ id: 'm1', region: '용산구', dong: '이촌동', category: '분식', name: '김밥집', tip: 1000, rating: 4.5 }],
    menus: [
      { id: 'm1-1', store: 'm1', name: '참치김밥', price: 5000, desc: '' },
      { id: 'm1-2', store: 'm1', name: '라볶이', price: 9000, desc: '', main: true },
    ],
  });
  const turn = await textTurn(engine, null, '용산구 분식 추천해줘');
  assert.match(turn.reply.cards[0].menu, /라볶이/);
});
