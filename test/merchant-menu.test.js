import assert from 'node:assert/strict';
import { test } from 'node:test';
import menuDescription from '../api/menu-description.js';
import recommend from '../api/recommend.js';

async function post(handler, body) {
  const res = {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; },
  };
  await handler({ method: 'POST', body }, res);
  return { status: res.statusCode, data: res.payload };
}

const draftInput = {
  name: '마늘간장 치킨', price: 18000, taste: '맵지 않은 간장 맛', servings: 3,
  portion: '닭다리살 350g', features: '순살', notes: '겉바속촉으로 튀깁니다',
};

test('menu drafts use the seller input with Gemini and fall back on unsupported numbers or missing credentials', async t => {
  const oldKey = process.env.GEMINI_API_KEY;
  t.after(() => {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  });
  let calls = 0;
  let output = '맵지 않은 간장 맛을 입힌 순살 치킨으로, 3인분을 제공합니다.';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(new URL(url).hostname, 'generativelanguage.googleapis.com');
    const body = JSON.parse(init.body);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), draftInput);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ description: output }) }] } }] });
  });

  process.env.GEMINI_API_KEY = 'test-key';
  const generated = await post(menuDescription, draftInput);
  assert.deepEqual(generated, { status: 200, data: { description: output, provider: 'gemini' } });
  output = '12인분입니다.';
  const fallback = await post(menuDescription, draftInput);
  assert.equal(fallback.data.provider, 'rules');
  assert.match(fallback.data.description, /맵지 않은 간장 맛.*3인분.*350g.*순살.*겉바속촉/);
  assert.doesNotMatch(fallback.data.description, /12인분/);

  delete process.env.GEMINI_API_KEY;
  assert.deepEqual(await post(menuDescription, draftInput), fallback);
  assert.equal((await post(menuDescription, { ...draftInput, servings: 21 })).status, 400);
  assert.equal(calls, 2);
});

test('recommendations apply saved menu details, prices and removals only to the matching browser', async t => {
  const shop = { id: 'merchant', name: '동네부엌', region: '서초구', dong: '서초4동', category: '치킨', tip: 1000, rating: 4.5 };
  const original = { id: 'original', store: shop.id, name: '뼈 후라이드치킨', price: 19000, desc: '', main: true };
  const approved = {
    id: 'new', store: shop.id, name: '오늘의 한 접시', price: 18000, desc: '겉바속촉으로 튀긴 한 접시예요.', available: true, removed: false,
    details: { taste: '맵지 않은 간장 맛', servings: 3, features: '순살' },
  };
  const merchantBrowser = '10000000-0000-4000-8000-000000000001';
  const guestBrowser = '10000000-0000-4000-8000-000000000002';
  let edits = [approved, { ...approved, id: 'salad', name: '치킨 샐러드', price: 3000 }];
  let baseReads = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/seoul_recommendation_snapshot')) {
      baseReads++;
      return Response.json({ stores: [shop], menus: [original] });
    }
    assert.ok(path.endsWith('/seoul_delivery_demo'));
    const { action, browser_key: browserKey } = JSON.parse(init.body);
    assert.equal(action, 'recommendation_menu_changes');
    return Response.json(browserKey === merchantBrowser ? edits : []);
  });

  const search = (browserKey, text) => post(recommend, { browserKey, action: { type: 'text', text } });
  const request = '서초구에서 셋이 2만 원 이하로 바삭하고 안 매운 순살 치킨 추천해줘';
  const first = await search(merchantBrowser, request);
  assert.equal(first.status, 200);
  const [card] = first.data.reply.cards;
  assert.equal(card.menuId, approved.id);
  assert.equal(card.qty, 1);
  assert.equal(card.total, 19000);
  assert.equal(card.portionNote, '3인분 표기 기준');
  assert.equal(card.quote, approved.desc);
  assert.ok(card.checks.includes('바삭'));
  assert.ok(card.checks.includes('순살'));
  assert.equal(first.data.reply.cards.length, 1);

  const other = await search(guestBrowser, request);
  assert.deepEqual(other.data.reply.cards ?? [], []);
  edits = [{ ...approved, price: 21000 }];
  const overBudget = await search(merchantBrowser, request);
  assert.equal(overBudget.data.reply.cards[0].budgetNote, '예산보다 2,000원 높아요');

  edits = [{ ...approved, available: false }, { ...original, removed: true, available: false }];
  const noMenus = await search(merchantBrowser, '서초구 치킨 추천해줘');
  assert.equal(noMenus.status, 200);
  assert.deepEqual(noMenus.data.reply.cards ?? [], []);
  const unaffected = await search(guestBrowser, '서초구 치킨 추천해줘');
  assert.deepEqual(unaffected.data.reply.cards.map(result => result.menuId), ['original']);
  assert.equal(baseReads, 1);
});
