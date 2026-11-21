import assert from 'node:assert/strict';
import { test } from 'node:test';
import recommend from '../api/recommend.js';

async function post(action, state = null) {
  const reply = {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; },
  };
  await recommend({ method: 'POST', body: { action, state } }, reply);
  assert.equal(reply.statusCode, 200);
  return reply.payload;
}

test('recommend API works without a Gemini key and rules mode prevents Gemini calls with a configured key', async t => {
  const settings = ['GEMINI_API_KEY', 'RECOMMENDATION_MODE'].map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of settings) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const stores = ['boneless', 'bone'].map(id => ({
    id, name: id, region: '서초구', dong: '서초4동', category: '치킨', tip: 1000, rating: 4.5,
  }));
  const menus = [
    { id: 'boneless-menu', store: 'boneless', name: '간장 순살치킨', price: 18000, desc: '' },
    { id: 'bone-menu', store: 'bone', name: '뼈 치킨', price: 17000, desc: '' },
  ];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname;
    requests.push(path);
    assert.equal(path, '/rest/v1/rpc/seoul_recommendation_snapshot');
    return Response.json({ stores, menus });
  });

  delete process.env.RECOMMENDATION_MODE;
  delete process.env.GEMINI_API_KEY;
  const first = await post({ type: 'text', text: '서초구에서 둘이 2만5천 원 안에 치킨 추천해줘' });
  assert.equal(first.provider, 'rules');
  assert.equal(first.state.cond.budget, 25000);
  assert.equal(first.reply.cards.length, 2);
  assert.match(first.reply.followUp, /순살과 뼈/);

  process.env.RECOMMENDATION_MODE = 'rules';
  process.env.GEMINI_API_KEY = 'test-key';
  const pick = first.reply.buttons.find(button => button.label === '순살 (1곳)');
  const narrowed = await post(pick.action, first.state);
  assert.equal(narrowed.provider, 'rules');
  assert.deepEqual(narrowed.reply.cards.map(card => card.menuId), ['boneless-menu']);
  assert.equal(narrowed.reply.cards[0].total, 19000);
  assert.deepEqual(requests, ['/rest/v1/rpc/seoul_recommendation_snapshot']);
});
