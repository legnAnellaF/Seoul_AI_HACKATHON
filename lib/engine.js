// Menu recommendation engine adapted from feature/ai-recommend.
const CATEGORIES = ['치킨','한식','중식','분식','피자','카페·디저트','일식','양식','아시안'];
const CATEGORY_MAP = new Map([
  ['치킨·튀김','치킨'], ['국·탕','한식'], ['밥·덮밥','한식'], ['고기·구이','한식'], ['양식·일식','양식'],
]);
const portionEvidence = /푸짐|넉넉|대용량|곱빼기|[2-9]\s*인분|두\s*마리|[2-9]\s*마리/;
const wholeChickenEvidence = /한\s*마리|1\s*마리/;
const ALL_REGIONS = '서울 전체';
const SEOUL_DISTRICTS = new Set('강남구 강동구 강북구 강서구 관악구 광진구 구로구 금천구 노원구 도봉구 동대문구 동작구 마포구 서대문구 서초구 성동구 성북구 송파구 양천구 영등포구 용산구 은평구 종로구 중구 중랑구'.split(' '));
const compact = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const DISH_ALIASES = [
  /짜장면|자장면|짜장/, /짬뽕/, /탕수육/, /꿔바로우/, /닭강정/, /(?:후라이드|프라이드)(?:순살|뼈)?(?:치킨)?/,
  /간장(?:순살|뼈)?치킨/, /양념(?:순살|뼈)?치킨/, /마늘(?:순살|뼈)?치킨/, /김치찌개/, /된장찌개/, /순두부찌개/, /부대찌개/,
  /김치찜/, /찜닭/, /감자탕/, /국밥/, /제육볶음|제육/, /비빔밥/, /갈비탕/,
  /떡볶이|떡뽁이/, /라볶이/, /김밥/, /순대/, /초밥|스시/, /돈가스|돈까스/,
  /우동/, /라멘/, /마라탕/, /마라샹궈/, /쌀국수/, /팟타이/, /파스타/, /스테이크/, /리소토/,
];
const dishMatches = (requested, name) => {
  const term = compact(requested);
  const item = compact(name);
  const aliases = DISH_ALIASES.find(pattern => pattern.test(term) && term.match(pattern)?.[0] === term);
  return !!term && (item.includes(term) || !!aliases?.test(item));
};
const mainMenuFor = (category, name) => {
  if (category === '치킨') return /치킨|통닭|닭강정|후라이드|프라이드|닭다리|닭날개|텐더/.test(name) && !/까스|가스|버거|샐러드/.test(name);
  if (category === '피자') return /피자/.test(name);
  return true;
};

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const clamp = v => Math.max(0, Math.min(1, v));


export function createEngine(snapshot) {
  const menuGroups = new Map();
  for (const menu of snapshot.menus) {
    if (!menuGroups.has(menu.store)) menuGroups.set(menu.store, []);
    menuGroups.get(menu.store).push(menu);
  }
  const stores = snapshot.stores.filter(store => menuGroups.has(store.id)).map(store => ({
    ...store, category: CATEGORY_MAP.get(store.category) ?? store.category, minOrder: 0,
  }));
  const regions = [...new Set(stores.map(store => store.region))].sort((a,b) => a.localeCompare(b,'ko'));
  const areas = new Map();
  for (const { region, dong } of stores) {
    if (!areas.has(dong)) areas.set(dong, new Set());
    areas.get(dong).add(region);
  }
  const inArea = (store, state) => (state.dong === ALL_REGIONS ? SEOUL_DISTRICTS.has(store.region) : store.region === state.dong) &&
    store.region !== state.excludedRegion && (!state.neighborhood || store.dong === state.neighborhood);
  const mains = Object.fromEntries(stores.map(store => {
    const items = menuGroups.get(store.id).filter(m => mainMenuFor(store.category, m.name));
    const cutoff = median(items.map(menu => menu.price)) * 0.5;
    return [store.id, items.filter(menu => menu.price >= cutoff).sort((a,b) => a.price-b.price)];
  }));
  const PER_TWO = ['치킨', '피자']; // 2인당 1개, 나머지 1인당 1개 [제안]

  // ---------- 노출 횟수 (가게별, 매일 0시 초기화) ----------
  // ponytail: 서버 메모리라 재시작/서버리스 인스턴스마다 초기화됨. 유지가 필요하면 Supabase 테이블로.
  const exposure = { day: '', counts: {} };
  const today = () => new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  function expo(id) {
    if (exposure.day !== today()) { exposure.day = today(); exposure.counts = {}; }
    return exposure.counts[id] ?? 0;
  }

  // ---------- 가격 패턴 (숫자+원/만/천, 한글 수사+원/만) ----------
  const PRICE_RE = /\d[\d,]*(?:\.\d+)?\s*(?:만\s*(?:[\d일이삼사오육칠팔구]+\s*천)?\s*원?|천\s*원?|원)|[일이삼사오육칠팔구십백]*[만천]\s*[일이삼사오육칠팔구십백천]*\s*원|[일이삼사오육칠팔구]만(?=\s|$)/;
  const hasPrice = t => PRICE_RE.test(String(t || ''));
  const DIG = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
  function parseAmount(text) {
    const m = String(text).match(PRICE_RE);
    if (!m) return null;
    let total = 0, cur = 0, d = 0;
    for (const [, n, h, u] of m[0].replace(/[,\s원]/g, '').matchAll(/(\d+(?:\.\d+)?)|([일이삼사오육칠팔구])|([십백천만])/g)) {
      if (n) d = Number(n);
      else if (h) d = DIG[h];
      else if (u === '만') { total += (cur + d || 1) * 10000; cur = 0; d = 0; }
      else { cur += (d || 1) * { 십: 10, 백: 100, 천: 1000 }[u]; d = 0; }
    }
    return Math.round(total + cur + d) || null;
  }

  // ---------- 상태 ----------
  const freshCond = () => ({ menu: null, dish: null, store: null, people: null, budget: null, budget_floor: null, budget_unit: 'total', price_pref: 'none', taste: [], franchise: 'none', budget_under: false });
  const fresh = dong => ({ dong, neighborhood: null, excludedRegion: null, awaitingRegion: false, cond: freshCond(), chosen: [], questions: 0, asked: [], pending: null, seen: [], excludeSeen: false, exposed: [], cheapBoost: 1, lastMin: null, lastTop: [] });
  const hasFood = ({ cond }) => !!(cond.menu || cond.dish || cond.store);
  const areaLabel = state => state.neighborhood ? `${state.dong} ${state.neighborhood}` : state.excludedRegion ? `서울 전체 (${state.excludedRegion} 제외)` : state.dong;

  const validOption = option => option && typeof option.label === 'string' && Array.isArray(option.store_ids);

  function load(raw) {
    const s = { ...fresh(null), ...(raw && typeof raw === 'object' ? raw : {}) };
    if (s.dong !== ALL_REGIONS && !regions.includes(s.dong)) s.dong = null;
    if (!areas.get(s.neighborhood)?.has(s.dong)) s.neighborhood = null;
    if (s.dong !== ALL_REGIONS || !regions.includes(s.excludedRegion)) s.excludedRegion = null;
    s.cond = { ...freshCond(), ...(s.cond && typeof s.cond === 'object' ? s.cond : {}) };
    for (const k of ['chosen', 'asked', 'seen', 'exposed', 'lastTop']) s[k] = Array.isArray(s[k]) ? s[k].slice(-100) : [];
    s.chosen = s.chosen.filter(validOption).slice(0, 3);
    s.pending = Array.isArray(s.pending) ? s.pending.filter(validOption).slice(0, 5) : null;
    const inputCond = s.cond;
    s.cond = freshCond();
    setCond(s, inputCond, true);
    s.questions = Number(s.questions) || 0;
    s.cheapBoost = Math.min(Math.max(Number(s.cheapBoost) || 1, 1), 1.5);
    return s;
  }

  function resetSearch(state) {
    Object.assign(state, { awaitingRegion: false, chosen: [], questions: 0, asked: [], pending: null, seen: [], excludeSeen: false, cheapBoost: 1, lastMin: null, lastTop: [] });
  }

  function setCond(state, next, rehydrate = false) {
    const prev = state.cond;
    const c = { ...prev };
    for (const k of ['menu', 'dish', 'store', 'people', 'budget', 'budget_unit', 'price_pref', 'taste', 'franchise']) if (k in next) c[k] = next[k];
    if (!CATEGORIES.includes(c.menu)) c.menu = null;
    for (const k of ['dish', 'store']) c[k] = typeof c[k] === 'string' ? c[k].trim().slice(0, 80) || null : null;
    c.people = Number.isInteger(c.people) && c.people > 0 && c.people <= 20 ? c.people : null;
    c.budget = Number.isFinite(c.budget) && c.budget > 0 ? Math.round(c.budget) : null;
    const floor = next.budget_floor ?? ('budget' in next ? null : prev.budget_floor);
    c.budget_floor = Number.isInteger(floor) && floor > 0 && floor <= c.budget ? floor : null;
    if (!['total', 'per_person'].includes(c.budget_unit)) c.budget_unit = 'total';
    if (!['none', 'cheap', 'any'].includes(c.price_pref)) c.price_pref = 'none';
    c.taste = Array.isArray(c.taste) ? [...new Set(c.taste.map(t => String(t).trim()).filter(Boolean))].slice(0, 8) : [];
    if (!['none', 'exclude', 'only'].includes(c.franchise)) c.franchise = 'none';
    if ('budget_under' in next || c.budget !== prev.budget || c.budget_unit !== prev.budget_unit) c.budget_under = !!next.budget_under;
    if (rehydrate) { state.cond = c; return; }
    if (JSON.stringify(c) !== JSON.stringify(prev)) resetSearch(state);
    state.cond = c; state.pending = null; state.excludeSeen = false; state.cheapBoost = 1;
  }

  // ---------- 1.5단계: 수량·기준가·가격 모드 ----------
  const qtyFor = (cat, people) => (PER_TWO.includes(cat) ? Math.ceil(people / 2) : people);

  function ctx(state, alternatives = false) {
    const c = state.cond, people = c.people || 1;
    const exact = !alternatives && !!(c.dish || c.store);
    const items = s => {
      if (exact && c.dish) return menuGroups.get(s.id).filter(m => dishMatches(c.dish, m.name));
      return exact && c.store && !mains[s.id].length ? menuGroups.get(s.id) : mains[s.id];
    };
    const qty = s => qtyFor(s.category, people);
    const minTotal = s => Math.min(...items(s).map(m => m.price * qty(s) + s.tip));
    // 기준가: 영업·프랜차이즈 무관, 같은 동+업종 → 5곳 미만이면 3개 동 → 그래도 5곳 미만이면 없음
    let pool = stores.filter(s => s.category === c.menu && inArea(s, state));
    if (pool.length < 5) pool = stores.filter(s => s.category === c.menu);
    const base = pool.length >= 5 ? median(pool.map(minTotal).filter(Number.isFinite)) : null;
    const totalBudget = c.budget == null ? null : c.budget * (c.budget_unit === 'per_person' ? people : 1) - Number(c.budget_under);
    const budgetFloor = (c.budget_floor || 0) * (c.budget_unit === 'per_person' ? people : 1);
    const fitsBudget = (total, cap = totalBudget) => cap == null || (total >= budgetFloor && total <= cap);
    const mode = totalBudget != null ? 'budget' : c.price_pref === 'any' ? 'any' : c.price_pref === 'cheap' ? 'cheap' : 'value';
    const rated = stores.filter(s => inArea(s, state) && s.rating != null);
    const avgRating = rated.length ? rated.reduce((a, s) => a + s.rating, 0) / rated.length : 4.3;
    return { qty, items, exact, people, base, totalBudget, fitsBudget, mode, avgRating, minTotal };
  }

  // ---------- 2단계: 필터 ----------
  function filterStores(state, x, o = {}) {
    const c = { ...state.cond, ...o.cond };
    const chosen = o.chosen ?? state.chosen;
    const seen = (o.excludeSeen ?? state.excludeSeen) ? state.seen : [];
    const tb = o.totalBudget ?? x.totalBudget;
    const cheapCap = x.base == null ? Infinity : x.base * (o.cheapBoost ?? state.cheapBoost);
    return stores.filter(s => inArea(s, state) && (!c.menu || s.category === c.menu)
      && (!x.exact || !c.store || matchesStore(c.store, s))
      && !(c.franchise === 'exclude' && s.franchise) && !(c.franchise === 'only' && !s.franchise)
      && (x.mode !== 'cheap' || x.minTotal(s) <= cheapCap)
      && x.items(s).some(m => m.price * x.qty(s) >= s.minOrder && x.fitsBudget(m.price * x.qty(s) + s.tip, tb))
      && (s.rating == null || s.rating >= 3.5)
      && !seen.includes(s.id)
      && chosen.every(ch => ch.store_ids.includes(s.id)));
  }

  // ---------- 5단계: 점수 ----------
  function priceScore(total, x) {
    if (x.mode === 'budget' && x.totalBudget > 0) return clamp((x.totalBudget - total) / (x.totalBudget * 0.3));
    if ((x.mode === 'value' || x.mode === 'cheap') && x.base) return clamp((x.base * 1.2 - total) / (x.base * 0.4));
    return 0.5;
  }
  function ratingScore(s, avg) {
    const adj = s.rating ?? avg;
    return clamp((adj - 3.5) / 1.5);
  }

  // ---------- AI 실패 시 코드만으로 판단 (메뉴 이름·설명 키워드) ----------
  const menuEvidence = (menu, term) => term === '푸짐' ? portionEvidence.test(`${menu.name} ${menu.desc}`) :
    !!compact(term) && compact(`${menu.name} ${menu.desc}`).includes(compact(term));
  // terms의 각 항목은 단어 하나, 또는 "이 중 하나면 됨" 단어 배열 (비슷한 맛 대체용)
  function keywordJudge(ms, terms) {
    if (!terms.length) return { match: '맞음', menu_ids: ms.slice(0, 5).map(m => m.id), quotes: {}, reason: '', words: [] };
    const hits = m => terms.map(t => [t].flat().find(w => menuEvidence(m, w))).filter(Boolean);
    const best = Math.max(0, ...ms.map(m => hits(m).length));
    if (!best) return { match: '안 맞음', menu_ids: [], quotes: {}, reason: '', words: [] };
    const top = ms.filter(m => hits(m).length === best);
    const words = hits(top[0]);
    return {
      match: best === terms.length ? '맞음' : '일부',
      menu_ids: top.slice(0, 5).map(m => m.id), quotes: Object.fromEntries(top.filter(m => m.desc).map(m => [m.id,m.desc])),
      reason: `${words.join('·')} 조건에 맞는 메뉴가 있어요`, words,
    };
  }

  // 원하는 맛의 메뉴가 없을 때 대신 찾아볼 비슷한 맛 [제안 · 리허설에서 조정]
  const SIMILAR = {
    크림: ['로제', '크리미', '치즈', '갈릭', '마늘'], 로제: ['크림', '크리미', '치즈'], 치즈: ['크림', '모짜렐라', '체다', '로제'],
    매운: ['매콤', '양념', '마라', '칼칼', '얼큰', '청양', '얼얼'], 마라: ['얼얼', '매운', '칼칼'], 칼칼: ['얼큰', '매콤', '짬뽕'], 얼큰: ['칼칼', '매콤'],
    간장: ['마늘', '데리야끼'], 마늘: ['갈릭', '간장'], 달콤: ['양념', '꿀', '단짠', '달큰'], 양념: ['달콤', '매콤'],
    담백: ['후라이드', '맑', '깔끔'], 바삭: ['튀김', '크리스피', '겉바속촉'], 불향: ['불맛', '화덕', '직화'], 해물: ['해산물', '새우', '오징어', '홍합'],
    트러플: ['버섯', '머쉬룸'],
  };

  const TASTES = ['바삭', '간장', '양념', '마늘', '매운', '순살', '뼈', '치즈', '로제', '짜장', '짬뽕', '마라', '국물', '담백', '반반', '불향', '해물', '크림', '얼큰', '칼칼', '달콤', '화덕'];
  const MENU_WORDS = [['치킨', /치킨|통닭|후라이드|닭강정/], ['중식', /중식|중국|짜장|짬뽕|탕수육|마라|꿔바로우/], ['분식', /분식|떡볶이|김밥|순대|라볶이/], ['피자', /피자/], ['한식', /한식|국밥|해장|제육|비빔밥|찌개|갈비|찜|탕/], ['카페·디저트', /카페|디저트|커피|케이크/], ['일식', /일식|초밥|스시|우동|돈가스|라멘/], ['양식', /양식|파스타|스테이크|리소토/], ['아시안', /아시안|쌀국수|팟타이/]];
  // ---------- 오타 바로잡기 (자모 단위 편집 거리) ----------
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ', JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ', JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
  const jamo = s => [...s].map(ch => {
    const c = ch.charCodeAt(0) - 0xac00;
    return c < 0 || c > 11171 ? ch : CHO[(c / 588) | 0] + JUNG[((c % 588) / 28) | 0] + (c % 28 ? JONG[c % 28] : '');
  }).join('');
  // 소리가 비슷한 자모끼리는 0.5 (치긴→치킨, 깐장→간장, 피짜→피자, 프렌→프랜, 저럼→저렴), ㅇ 넣고 빼기도 0.5 (두리서→둘이서)
  const ALIKE = ['ㄱㄲㅋ', 'ㄷㄸㅌ', 'ㅂㅃㅍ', 'ㅅㅆ', 'ㅈㅉㅊ', 'ㅐㅔ', 'ㅒㅖ', 'ㅙㅞㅚ', 'ㅓㅕ', 'ㅏㅑ', 'ㅗㅛ', 'ㅜㅠ'];
  const subCost = (x, y) => (x === y ? 0 : ALIKE.some(g => g.includes(x) && g.includes(y)) ? 0.5 : 1);
  const gapCost = x => (x === 'ㅇ' ? 0.5 : 1);
  function lev(a, b) {
    let prev = [0];
    for (let j = 1; j <= b.length; j++) prev[j] = prev[j - 1] + gapCost(b[j - 1]);
    for (let i = 1; i <= a.length; i++) {
      const cur = [prev[0] + gapCost(a[i - 1])];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + gapCost(a[i - 1]), cur[j - 1] + gapCost(b[j - 1]), prev[j - 1] + subCost(a[i - 1], b[j - 1]));
      prev = cur;
    }
    return prev[b.length];
  }
  // ponytail: 아는 단어 목록과 같은 음절 수 구간만, 소리 비슷한 오타만 교체(2음절 0.5 · 3~4음절 1 · 5음절 1.5). 메뉴 데이터 문장 374개로 오탐 0 확인.
  // 흔한 다른 단어와 헷갈리는 말(한식↔간식, 반반↔반찬 등)은 목록에서 뺐다. 더 넓은 오타는 Claude(AI ①)가 맡는다.
  const FUZZY = ['프랜차이즈', '꿔바로우', '후라이드', '처음부터', '떡볶이', '라볶이', '탕수육', '닭강정', '감자탕', '둘이서', '셋이서', '넷이서', '가성비',
    '치킨', '피자', '짜장', '짬뽕', '김밥', '순대', '분식', '중식', '찜닭', '국밥', '간장', '양념', '마늘', '바삭', '순살', '매운', '매콤', '치즈', '로제',
    '국물', '담백', '불향', '해물', '얼큰', '칼칼', '달콤', '화덕', '저렴'].map(w => [w, jamo(w)]);
  function fixTypos(text) {
    let s = String(text);
    const locked = new Array(s.length).fill(false); // 이미 맞게 쓴 단어 안쪽은 건드리지 않는다 (프랜차이즈의 '이즈'→치즈 방지)
    const lock = (i, n) => locked.fill(true, i, i + n);
    for (const [w] of FUZZY) for (let i = s.indexOf(w); i >= 0; i = s.indexOf(w, i + 1)) lock(i, w.length);
    for (const [w, wj] of FUZZY) {
      const max = w.length <= 2 ? 0.5 : w.length <= 4 ? 1 : 1.5;
      for (let i = 0; i + w.length <= s.length; i++) {
        const win = s.slice(i, i + w.length);
        if (locked.slice(i, i + w.length).some(Boolean) || !/^[가-힣]+$/.test(win) || lev(jamo(win), wj) > max) continue;
        s = s.slice(0, i) + w + s.slice(i + w.length);
        lock(i, w.length);
      }
    }
    return s;
  }

  function readArea(text) {
    const broad = text.match(/(?:지역|동네)\s*(?:은|는|도)?\s*(?:상관\s*없|무관|아무|어디든)|(?:다른|주변)\s*(?:지역|동네|구)\s*(?:도|까지|에서|로|검색|괜찮|상관|추천|넓혀)|서울\s*(?:전체|전역|어디든)|어느\s*(?:지역|동네)든|어디(?:든|라도)\s*(?:괜찮|좋아)/);
    const hits = [];
    let excludedRegion = null;
    const add = (label, dong, neighborhood) => {
      const at = text.lastIndexOf(label);
      if (at < 0) return;
      if (/^\s*(?:에서(?:는)?|은|는|을|를|도)?\s*(?:말고|빼고|제외)/.test(text.slice(at + label.length))) {
        excludedRegion = dong;
        return;
      }
      hits.push({ dong, neighborhood, at, label });
    };
    for (const region of regions) {
      if (text.includes(region)) add(region, region, null);
      else if (region.endsWith('구')) {
        const short = region.slice(0, -1);
        if (text.match(new RegExp(`(?:^|\\s)${short}(?:으로|에서|쪽|로|\\s|$)`))) add(short, region, null);
      }
    }
    for (const [area, parents] of areas) {
      if (!area || !text.includes(area)) continue;
      const parent = [...parents].find(r => hits.some(hit => hit.dong === r && !hit.neighborhood));
      if (parent || parents.size === 1) add(area, parent || [...parents][0], area);
    }
    const missing = [...text.matchAll(/(?:^|\s)([가-힣]{2,10}구|[가-힣]{1,10}\d*동)(?=\s*(?:으로|에서|에도|에는|이랑|쪽|으로는|으로도|로|에\s|도\s|만\s|[?!.,]|$))/g)]
      .filter(([, label]) => !regions.includes(label) && !areas.has(label) && !['다른동', '같은동'].includes(label)).at(-1);
    const hit = hits.sort((a, b) => (b.at + b.label.length) - (a.at + a.label.length) || b.label.length - a.label.length)[0];
    if (broad && !hit && !missing) return { dong: ALL_REGIONS, neighborhood: null, excludedRegion };
    return missing && (!hit || missing.index > hit.at) ? { missing: missing[1] } : hit;
  }

  const catalogDishes = new Map();
  for (const s of stores) {
    for (const m of menuGroups.get(s.id)) {
      const key = compact(m.name);
      if (key.length < 3 || CATEGORIES.some(category => compact(category) === key)) continue;
      const item = catalogDishes.get(key) || { name: m.name, categories: new Set() };
      item.categories.add(s.category);
      catalogDishes.set(key, item);
    }
  }
  const dishEntries = [...catalogDishes].sort(([a], [b]) => b.length - a.length);

  function readFood(raw) {
    const parts = raw.split(/\s*(?:대신(?:에)?|말고|아니라|아니[, ]+)\s*/);
    for (const part of parts.reverse()) {
      const text = fixTypos(part);
      const key = compact(part);
      const named = dishEntries.find(([name]) => key.includes(name))?.[1];
      const known = DISH_ALIASES.map(pattern => compact(text).match(pattern)).filter(Boolean).sort((a, b) =>
        (b.index + b[0].length) - (a.index + a[0].length) || b[0].length - a[0].length)[0]?.[0];
      const category = MENU_WORDS.map(([name, pattern]) => [name, text.match(pattern)]).filter(([, match]) => match)
        .sort(([, a], [, b]) => b[0].length - a[0].length || b.index - a.index)[0]?.[0];
      const localText = part.split(/(?:에서(?:는)?|에서는|으로\s*바꾸고|로\s*바꾸고|바꿔서|[,.;!?])\s*/).at(-1).trim();
      const literal = localText.match(/^([가-힣A-Za-z\d]+(?:\s+[가-힣A-Za-z\d]+){0,2}?)\s*(?:이|가|을|를)?\s+(?:먹고\s*싶|추천해|찾아)/)?.[1] ||
        localText.match(/^([가-힣A-Za-z\d]+(?:\s+[가-힣A-Za-z\d]+){0,2})$/)?.[1];
      const literalFood = literal && category && !readArea(literal) && compact(literal) !== compact(category) &&
        /(?:치킨|피자|탕|찌개|찜|스테이크|파스타|우동|라멘|국밥|김밥|초밥|짜장면|짬뽕|떡볶이)$/.test(compact(literal)) &&
        !/^(?:양|가격|예산)|[은는한]\s/.test(literal) ? literal : null;
      const dish = literalFood || named?.name || known;
      if (dish || category) return { menu: named?.categories.size === 1 ? [...named.categories][0] : category ?? null, dish: dish ?? null, text };
    }
    return null;
  }

  // AI ① 실패 시 규칙 기반 조건 정리
  function ruleParse(raw, cur) {
    const t = fixTypos(raw);
    const out = {};
    const food = readFood(raw);
    if (food) { out.menu = food.menu; out.dish = food.dish; }
    const n = t.match(/(\d+)\s*(?:명|인(?!당))/);
    const p = n ? Number(n[1]) : /혼자|한\s*명(?!에|당)/.test(t) ? 1 : /둘|두\s*명/.test(t) ? 2 : /셋|세\s*명/.test(t) ? 3 : /넷|네\s*명/.test(t) ? 4 : null;
    if (p) out.people = p;
    if (hasPrice(t)) {
      out.budget = parseAmount(t);
      out.budget_unit = /인당|1인|한\s*명(에|당)/.test(t) ? 'per_person' : 'total';
      out.price_pref = 'none';
      out.budget_under = /미만/.test(t);
      const band = t.match(/(?:\d+|[일이삼사오육칠팔구십]+)?\s*만\s*원\s*대/);
      if (band) {
        out.budget_floor = parseAmount(band[0]);
        out.budget = out.budget_floor + 9999;
      }
    }
    if (/(?:가격|예산|금액|비용)\s*(은|는)?\s*(?:상관\s*없|무관)|비싸도/.test(t)) { out.price_pref = 'any'; out.budget = null; }
    else if (/싸게|가성비|저렴|싼\s*가격|낮은\s*가격/.test(t)) out.price_pref = 'cheap';
    if (/프랜차이즈\s*(말고|빼고|제외|싫|x)/i.test(t)) out.franchise = 'exclude';
    else if (/프랜차이즈\s*만/.test(t)) out.franchise = 'only';
    else if (/프랜차이즈(도)?\s*(괜찮|상관)/.test(t)) out.franchise = 'none';
    const foodText = food?.text || t.split(/말고|대신(?:에)?/).at(-1);
    const found = TASTES.filter(w => foodText.includes(w)).concat(/매콤|맵/.test(foodText) && !foodText.includes('매운') ? ['매운'] : []);
    if (/양[이가은도]?\s*많|푸짐|넉넉|배부르|배불/.test(foodText)) found.push('푸짐');
    if (/(?:맛|취향)\s*(?:은|는)?\s*(?:아무\s*거나|상관\s*없)/.test(t)) out.taste = [];
    else if ((food && (food.menu !== cur.menu || food.dish !== cur.dish)) || (found.length && /말고|대신|바꿔/.test(t))) out.taste = found;
    else if (found.length) out.taste = [...cur.taste, ...found];
    return out;
  }

  // ---------- 화면용 ----------
  const won = n => `${n.toLocaleString('ko-KR')}원`;
  const menuButtons = () => CATEGORIES.map(c => ({ label: c, action: { type: 'apply', cond: { menu: c } } }));
  const followUps = () => ['다른 데는?', '더 싸게', '다른 지역도 괜찮아요', '처음부터'].map(t => ({ label: t, action: { type: 'text', text: t }, ghost: true }));

  function chips(state) {
    const c = state.cond;
    if (!state.dong) return [];
    const out = [{ label: areaLabel(state) }];
    if (!hasFood(state)) return out;
    if (c.menu) out.push({ label: c.menu });
    for (const field of ['dish', 'store']) if (c[field]) out.push({ label: c[field], remove: { type: 'apply', cond: { [field]: null } } });
    out.push({ label: `${c.people || 1}인` });
    if (c.budget) {
      const tb = c.budget_unit === 'per_person' ? c.budget * (c.people || 1) : c.budget;
      const low = c.budget_floor * (c.budget_unit === 'per_person' ? c.people || 1 : 1);
      const label = low ? `총 ${won(low)}~${won(tb)}` : c.budget_under ? `${won(tb)} 미만` : `총 ${won(tb)} 이하`;
      out.push({ label, kind: 'price', remove: { type: 'apply', cond: { budget: null, price_pref: 'none' } } });
    } else if (c.price_pref === 'cheap') out.push({ label: '싸게', kind: 'price', remove: { type: 'apply', cond: { price_pref: 'none' } } });
    else if (c.price_pref === 'any') out.push({ label: '가격 무관', kind: 'price', remove: { type: 'apply', cond: { price_pref: 'none' } } });
    else out.push({ label: '가성비 우선', kind: 'price', accent: true, remove: { type: 'apply', cond: { price_pref: 'any' } } });
    for (const t of c.taste.filter(t => !state.chosen.some(ch => ch.label === t))) out.push({ label: t, remove: { type: 'apply', cond: { taste: c.taste.filter(x => x !== t) } } });
    if (c.franchise !== 'none') out.push({ label: c.franchise === 'exclude' ? '프랜차이즈 X' : '프랜차이즈만', remove: { type: 'apply', cond: { franchise: 'none' } } });
    for (const ch of state.chosen) out.push({ label: ch.label, remove: { type: 'apply', chosenRemove: ch.label } });
    return out;
  }

  const storeBase = name => name.replace(/\s+\S+점$/, '');
  const matchesStore = (query, store) => [store.name, storeBase(store.name)].some(name => compact(name) === compact(query));
  const storeNames = [...new Set(stores.flatMap(s => [s.name, storeBase(s.name)]))]
    .map(name => [compact(name), name]).filter(([key]) => key.length >= 2 && !CATEGORIES.some(c => compact(c) === key))
    .sort(([a], [b]) => b.length - a.length);
  function findStoreName(text) {
    const normalized = compact(text);
    return storeNames.find(([key]) => normalized.includes(key))?.[1];
  }

  const out = (state, reply) => ({ state, reply: { ...reply, chips: chips(state) } });

  // ---------- 양보안 ----------
  function concessions(state, x, leftIds) {
    const res = [];
    const more = leftIds.size ? ' 더' : '';
    const add = (text, o, action) => {
      const n = filterStores(state, x, o).filter(s => !leftIds.has(s.id)).length;
      if (n) { res.push({ label: text(n), action }); return true; }
      return false;
    };
    if (x.mode === 'budget') {
      for (const d of [2000, 5000]) {
        if (add(n => `${won(d)}만 더 쓰면 ${n}곳${more} 있어요`, { totalBudget: x.totalBudget + d },
          { type: 'apply', cond: { budget: x.totalBudget + d, budget_unit: 'total' } })) break;
      }
    }
    if (x.mode === 'cheap' && x.base && state.cheapBoost < 1.1) {
      add(n => `동네 보통 가격보다 10% 더 써도 되면 ${n}곳${more} 있어요`, { cheapBoost: 1.1 }, { type: 'apply', cheapBoost: 1.1 });
    }
    if (state.chosen.length) {
      const last = state.chosen.at(-1);
      add(n => `'${last.label}' 말고 다른 것도 괜찮으면 ${n}곳${more} 있어요`, { chosen: state.chosen.slice(0, -1) }, { type: 'apply', chosenRemove: last.label });
    }
    if (state.cond.franchise === 'exclude') {
      add(n => `프랜차이즈도 괜찮으면 ${n}곳${more} 있어요`, { cond: { franchise: 'none' } }, { type: 'apply', cond: { franchise: 'none' } });
    }
    if (state.excludeSeen && !leftIds.size) {
      add(n => `새 가게는 더 없어요. 아까 본 ${n}곳 다시 볼까요?`, { excludeSeen: false }, { type: 'apply', seenAgain: true });
    }
    return res.slice(0, 3);
  }

  function zero(state, x, leftIds = new Set(), lead = '지금 조건으로는 가게가 없어요.') {
    const cs = concessions(state, x, leftIds);
    if (!cs.length) return out(state, { text: lead, buttons: followUps().filter(b => b.label === '처음부터' || (b.label === '다른 지역도 괜찮아요' && state.dong !== ALL_REGIONS)), remaining: 0 });
    return out(state, { text: `${lead} 이렇게 바꿔 볼까요?`, buttons: cs, remaining: 0 });
  }

  const aiCond = c => ({ menu: c.menu, people: c.people || 1, taste: c.taste, franchise: c.franchise }); // 가격 정보는 AI ②③에 안 넘긴다

  // ---------- 3단계: 좁히기 질문 ----------
  async function question(state, left, x, ai) {
    const sent = new Map(left.slice(0, 16).map(s => [s.id, x.items(s).filter(m =>
      x.fitsBudget(m.price * x.qty(s) + s.tip)).slice(0, 8)]));
    let q;
    try {
      q = await ai.question({
        cond: aiCond(state.cond), chosen: state.chosen.map(c => c.label), asked: state.asked,
        stores: [...sent].map(([id, menus]) => ({ store_id: id, menus: menus.map(m => ({ name: m.name, desc: m.desc.slice(0, 100) })) })),
      });
    } catch (e) { if (e.message !== 'Gemini unavailable') console.warn('[AI ②] 실패 → 기본 후속 질문:', e.message); return null; }
    const opts = (q.options || [])
      .filter(o => o && typeof o.label === 'string' && o.label.trim() && !hasPrice(o.label) && o.label !== '상관없어요')
      .map(o => ({ label: o.label.trim().slice(0, 30), store_ids: [...new Set(o.store_ids || [])].filter(id => sent.get(id)?.some(m => menuEvidence(m, o.label))) }))
      .filter(o => o.store_ids.length)
      .slice(0, 5);
    if (opts.length < 2 || new Set(opts.map(o => [...o.store_ids].sort().join())).size < 2) return null; // 더 나눌 기준 없음
    state.questions++; state.asked.push(String(q.question)); state.pending = opts;
    return {
      text: String(q.question),
      buttons: [...opts.map((o, i) => ({ label: `${o.label} (${o.store_ids.length}곳)`, action: { type: 'option', index: i } })),
        { label: '상관없어요', action: { type: 'option', index: -1 } }],
      remaining: left.length,
    };
  }

  // ---------- 4·5·6단계: 맞음 판단 → 대표 메뉴·점수·TOP3 → 카드 ----------
  async function results(state, x, left, ai, alternativeLead = '') {
    const terms = [...new Set([...state.cond.taste, ...state.chosen.map(c => c.label)])];
    const eligible = s => x.items(s).filter(m => m.price * x.qty(s) >= s.minOrder && x.fitsBudget(m.price * x.qty(s) + s.tip));
    const { dish, menu } = state.cond;
    const related = alternativeLead && dish ? Object.entries(SIMILAR).filter(([word]) => dish.includes(word)).flatMap(([word, similar]) => [word, ...similar]) : [];
    const alternativeScore = m => related.some(word => menuEvidence(m, word)) ? 15 : 0;
    const evidence = (s, words) => Math.max(0, ...eligible(s).map(m => words.filter(w => menuEvidence(m, w)).length));
    const pre = s => {
      const hits = evidence(s, terms);
      return priceScore(x.minTotal(s), x) * 30 + ratingScore(s, x.avgRating) * 20 + hits * 25 +
        (hits > 0 && hits === terms.length ? 100 : 0) + Math.max(0, ...eligible(s).map(alternativeScore));
    };
    const cands = left.length > 8 ? [...left].sort((a, b) => pre(b) - pre(a) || expo(a.id) - expo(b.id)).slice(0, 8) : left;

    const fullyVerified = terms.length ? new Map(cands.map(s => [s.id, eligible(s).filter(m => terms.every(term => menuEvidence(m, term)))])) : null;
    const hasVerifiedMatches = fullyVerified && [...fullyVerified.values()].some(list => list.length);
    const judged = new Map();
    try {
      const res = await ai.judge({
        cond: aiCond(state.cond), chosen: state.chosen.map(c => c.label),
        stores: cands.map(s => ({ store_id: s.id, menus: eligible(s).slice(0, 10).map(m => ({ menu_id: m.id, name: m.name, desc: m.desc.slice(0, 100) })) })),
      });
      const byId = new Map(cands.map(s => [s.id, s]));
      for (const j of res || []) {
        const s = byId.get(j?.store_id);
        if (!s || judged.has(s.id) || !['맞음', '일부', '안 맞음'].includes(j.match)) continue; // 없는 가게 버림
        const valid = new Map(eligible(s).map(m => [m.id, m]));
        const quotes = {};
        for (const q of j.quotes || []) {
          const m = valid.get(q?.menu_id);
          if (m && q.quote && m.desc.includes(q.quote)) quotes[m.id] = q.quote; // 원문 인용만
        }
        const menuIds = (Array.isArray(j.menu_ids) ? j.menu_ids : []).filter(id => valid.has(id)).slice(0, 5);
        const portionUnverified = terms.includes('푸짐') &&
          !menuIds.every(id => portionEvidence.test(valid.get(id).name + ' ' + valid.get(id).desc));
        judged.set(s.id, {
          match: portionUnverified && j.match === '맞음' ? '일부' : j.match,
          menu_ids: menuIds,
          quotes,
        });
      }
    } catch (e) { if (e.message !== 'Gemini unavailable') console.warn('[AI ③] 실패 → 키워드 판단:', e.message); }
    for (const s of cands) {
      if (!judged.has(s.id) || (x.exact && !judged.get(s.id).menu_ids.length)) {
        const matched = keywordJudge(eligible(s), terms);
        judged.set(s.id, x.exact && !matched.menu_ids.length ? { ...keywordJudge(eligible(s), []), match: '일부' } : matched);
      }
      if (hasVerifiedMatches) {
        const verified = fullyVerified.get(s.id);
        judged.set(s.id, verified.length ? keywordJudge(verified, terms) : { match: '안 맞음' });
      }
    }

    const scoreAll = judgedMap => {
      const res = [];
      for (const s of cands) {
        const j = judgedMap.get(s.id);
        if (j.match === '안 맞음') continue;
        const opts = eligible(s).filter(m => j.menu_ids.includes(m.id))
          .map(m => ({ m, total: m.price * x.qty(s) + s.tip }))
          .sort((a, b) => alternativeScore(b.m) - alternativeScore(a.m) || a.total - b.total);
        if (!opts.length) continue; // 대표 메뉴 없으면 제외
        const preferred = terms.includes('푸짐') && menu === '치킨'
          ? opts.find(({ m }) => portionEvidence.test(m.name + ' ' + m.desc)) ||
            opts.find(({ m }) => wholeChickenEvidence.test(m.name + ' ' + m.desc))
          : null;
        const { m, total } = preferred || opts[0];
        const matchScore = alternativeLead ? 25 + alternativeScore(m) : j.match === '맞음' ? 50 : 25;
        const score = matchScore + priceScore(total, x) * 30 + ratingScore(s, x.avgRating) * 20;
        res.push({ s, j, m, total, score });
      }
      return res;
    };
    let scored = scoreAll(judged);

    // 맛 조건(예: 크림)을 가진 메뉴가 후보 어디에도 없어서 0곳이면: 그 조건만 비슷한 맛으로 바꿔서 → 그래도 없으면 빼고 다시 고른다.
    // 예산·프랜차이즈 등 필터는 그대로이고, 바꾼 사실은 화면에 밝힌다 (몰래 유지). 결과는 '일부'로만 표시.
    let swapped = null;
    const inMenus = w => left.some(s => eligible(s).some(m => menuEvidence(m, w)));
    const missing = terms.filter(t => !inMenus(t));
    if (!scored.length && terms.length) {
      if (missing.length) {
        const kept = terms.filter(t => !missing.includes(t));
        const alike = [...new Set(missing.flatMap(t => SIMILAR[t] || []))].filter(inMenus);
        for (const tryTerms of alike.length ? [[...kept, alike], kept] : [kept]) {
          const relaxed = new Map(cands.map(s => {
            const j = keywordJudge(eligible(s), tryTerms);
            const near = j.words.filter(w => alike.includes(w));
            return [s.id, { ...j, match: j.match === '안 맞음' ? j.match : '일부',
              reason: near.length ? `'${missing.join('·')}' 대신 비슷한 ${near.join('·')} 메뉴예요` : '' }];
          }));
          scored = scoreAll(relaxed);
          if (scored.length) { swapped = { missing, similar: tryTerms.some(Array.isArray) }; break; }
        }
      }
    }
    if (!scored.length && (x.exact || alternativeLead)) {
      scored = scoreAll(new Map(cands.map(s => [s.id, { ...keywordJudge(eligible(s), []), match: '일부' }])));
    }
    const leftIds = new Set(left.map(s => s.id));
    if (!scored.length) return zero(state, x, new Set(), alternativeLead || '조건에 딱 맞는 가게가 없어요.');

    scored.sort((a, b) => b.score - a.score);
    const [first, ...rest] = scored;
    const peers = rest.filter(r => first.score - r.score <= 5).sort((a, b) => expo(a.s.id) - expo(b.s.id) || Math.random() - 0.5);
    const pick = [first, ...peers.slice(0, 2)];
    for (const r of rest) if (pick.length < 3 && !pick.includes(r)) pick.push(r);
    pick.sort((a, b) => b.score - a.score);

    for (const { s } of pick) {
      if (!state.exposed.includes(s.id)) { expo(s.id); exposure.counts[s.id] = (exposure.counts[s.id] ?? 0) + 1; state.exposed.push(s.id); }
      if (!state.seen.includes(s.id)) state.seen.push(s.id);
    }
    state.lastMin = Math.min(...pick.map(p => p.total));

    const c = state.cond;
    const cards = pick.map(({ s, j, m, total, score }) => {
      const checks = [s.region + ' ' + s.dong];
      if (c.franchise === 'exclude') checks.push('프랜차이즈 아님');
      if (c.franchise === 'only') checks.push('프랜차이즈');
      const confirmed = terms.filter(t => menuEvidence(m, t));
      checks.push(...confirmed);
      if (x.mode === 'budget') checks.push('예산');
      const save = x.base ? Math.round((x.base - total) / 1000) * 1000 : 0;
      return {
        storeId: s.id, name: s.name, menu: m.name, qty: x.qty(s) >= 2 ? x.qty(s) : null, total, checks,
        partial: !!alternativeLead || j.match === '일부' || confirmed.length < terms.length,
        valueLabel: x.base && x.base - total >= 1000 ? `동네 ${c.menu} 보통 가격보다 ${won(save)} 저렴` : null,
        rating: s.rating,
        reason: j.reason || (confirmed.length ? `메뉴 정보에서 ${confirmed.join('·')} 조건을 확인했어요.` : ''), quote: j.quotes[m.id] || m.desc,
        score: Math.round(score * 10) / 10,
      };
    });
    // 조건(예산 등)을 바꿨는데 TOP3가 그대로면, 고장처럼 보이지 않게 이유를 말해 준다
    const ids = pick.map(p => p.s.id);
    const same = state.lastTop.length === ids.length && ids.every(id => state.lastTop.includes(id));
    state.lastTop = ids;
    const where = x.mode === 'budget' ? '예산 안에 드는' : '조건에 맞는';
    const text = alternativeLead ? `${alternativeLead} 같은 ${c.menu} 카테고리에서 고른 대안이에요.`
      : swapped ? `'${swapped.missing.join('·')}' 조건을 확인할 수 있는 메뉴가 없어요. 대신 ${x.mode === 'budget' ? '같은 예산 안에서 ' : ''}${swapped.similar ? '비슷한 메뉴가 있는' : '다른 조건이 맞는'} 곳을 골랐어요.`
      : missing.length ? `'${missing.join('·')}' 메뉴가 있는 가게는 없어서, 나머지 조건으로 ${left.length}곳 중 ${cards.length}곳을 골랐어요.`
      : cards.every(card => card.partial) ? `요청하신 조건을 모두 확인할 수는 없었어요. 확인 가능한 조건에 맞는 ${cards.length}곳이에요.`
      : !same ? `남은 ${left.length}곳 중 ${cards.length}곳을 골랐어요.`
      : left.length === cards.length ? `${where} 가게는 이 ${cards.length}곳이 전부라 결과가 그대로예요.`
      : `${where} ${left.length}곳 중에서는 이 ${cards.length}곳이 가장 잘 맞아요. 다른 곳도 보시려면 '다른 데는?'을 눌러 주세요.`;
    const unseen = left.some(s => !state.seen.includes(s.id)); // 안 본 가게가 없으면 '다른 데는?'은 빈손이라 숨긴다
    return out(state, {
      text,
      banner: x.mode === 'value' ? '예산을 말씀 안 하셔서 가성비 좋은 곳 위주로 골랐어요.' : null,
      cards,
      buttons: [...(!alternativeLead && cards.length < 3 ? concessions(state, x, leftIds) : []), ...followUps().filter(b =>
        (unseen || b.label !== '다른 데는?') && (state.dong !== ALL_REGIONS || b.label !== '다른 지역도 괜찮아요'))],
      remaining: left.length,
    });
  }

  async function fromStep2(state, ai, ask = true) {
    state.awaitingRegion = false;
    const x = ctx(state);
    const left = filterStores(state, x);
    let result;
    if (!left.length && x.exact) {
      const c = state.cond;
      const existsHere = stores.some(s => inArea(s, state) && (!c.menu || s.category === c.menu) &&
        (!c.store || matchesStore(c.store, s)) && x.items(s).length);
      const subject = [c.store, c.dish].filter(Boolean).map(v => `‘${v}’`).join('의 ');
      const lead = existsHere ? `${subject}은(는) 등록되어 있지만 현재 조건에 맞는 결과가 없어요.`
        : `${areaLabel(state)}의 등록 데이터에서 ${subject}을(를) 찾지 못했어요. 이 검색 범위에서는 해당 메뉴나 가게를 선택할 수 없어요.`;
      const fallback = ctx(state, true);
      const alternatives = c.menu && !existsHere ? filterStores(state, fallback) : [];
      result = alternatives.length ? await results(state, fallback, alternatives, ai, lead) : zero(state, x, new Set(), lead);
      if (!c.menu && !existsHere) {
        result.reply.text += ' 어떤 종류의 음식으로 대안을 찾아볼까요?';
        result.reply.buttons = [...menuButtons(), ...result.reply.buttons];
      }
    } else if (!left.length) {
      return zero(state, x);
    } else {
      result = await results(state, x, left, ai);
    }
    if (!result.reply.cards?.length) return result;
    const q = ask && left.length >= 4 && state.questions < 3 ? await question(state, left, x, ai) : null;
    state.awaitingRegion = !q && state.dong !== ALL_REGIONS;
    result.reply.followUp = q?.text || (state.dong === ALL_REGIONS ? '원하는 지역이나 맛, 예산이 있으면 말씀해 주세요.' : '다른 지역도 찾아볼까요? 맛이나 예산을 바꿔도 좋아요.');
    if (q) result.reply.buttons = [...q.buttons, ...result.reply.buttons];
    return result;
  }

  // ---------- 진입점 ----------
  async function handle(raw, action, ai) {
    const state = load(raw);
    const a = action && typeof action === 'object' ? action : {};

    if (a.type === 'dong') {
      if (!regions.includes(a.dong)) throw new Error('bad dong');
      if (state.dong !== a.dong || state.neighborhood || state.excludedRegion) {
        state.dong = a.dong;
        state.neighborhood = null;
        state.excludedRegion = null;
        resetSearch(state);
      }
      if (hasFood(state)) return fromStep2(state, ai);
      return out(state, { text: `${a.dong}에서 찾아볼게요. 뭐 드시고 싶으세요? 인원·예산·취향을 편하게 말씀해 주세요.`, buttons: menuButtons() });
    }

    if (a.type === 'option') {
      const o = (state.pending || [])[a.index];
      if (!state.pending || (!o && a.index !== -1)) return out(state, { text: '이전 선택지는 만료됐어요. 원하는 조건을 다시 말씀해 주세요.' });
      if (o) {
        state.chosen.push(o);
        state.cond.taste = [...new Set([o.label, ...state.cond.taste])].slice(0, 8);
      }
      state.pending = null;
      return fromStep2(state, ai, !!o);
    }

    if (a.type === 'apply') {
      const next = a.cond && typeof a.cond === 'object' ? a.cond : {};
      if ('menu' in next) resetSearch(state);
      setCond(state, 'menu' in next ? { dish: null, store: null, taste: [], ...next } : next);
      if (a.chosenRemove) {
        state.chosen = state.chosen.filter(ch => ch.label !== a.chosenRemove);
        state.cond.taste = state.cond.taste.filter(t => t !== a.chosenRemove);
      }
      if (a.cheapBoost) state.cheapBoost = Math.min(Number(a.cheapBoost) || 1, 1.5);
      if (!hasFood(state)) return out(state, { text: '어떤 음식을 찾으세요?', buttons: menuButtons() });
      return fromStep2(state, ai, !a.seenAgain);
    }

    if (a.type === 'text') {
      const t = String(a.text || '').trim().slice(0, 300);
      const ft = fixTypos(t);
      if (!t) return out(state, { text: '어떤 음식을 찾으세요?', buttons: menuButtons() });
      if (/처음\s*부터|다시\s*시작/.test(ft)) {
        Object.assign(state, fresh(state.dong), { neighborhood: state.neighborhood });
        return out(state, { text: '처음부터 다시 할게요. 뭐 드시고 싶으세요?', buttons: menuButtons() });
      }
      const noPreference = /^(?:상관\s*없(?:어|어요|습니다)?|아무\s*거나|둘\s*다\s*좋아(?:요)?)[.!? ]*$/.test(t);
      const area = readArea(t) ?? (noPreference && (!state.dong || state.awaitingRegion) ? { dong: ALL_REGIONS, neighborhood: null } : null);
      if (area?.missing) return out(state, { text: `‘${area.missing}’의 등록 지역을 찾지 못했어요. 다른 지역을 말씀하시거나 검색 범위를 넓혀 보세요.`, buttons: [followUps()[2]] });
      const areaChanged = !!area && (state.dong !== area.dong || state.neighborhood !== area.neighborhood || state.excludedRegion !== (area.excludedRegion ?? null));
      if (areaChanged) {
        state.dong = area.dong;
        state.neighborhood = area.neighborhood;
        state.excludedRegion = area.excludedRegion ?? null;
        resetSearch(state);
      }
      if (!state.dong) return out(state, { text: '먼저 지역을 골라 주세요. 지역 이름을 입력하거나 “지역 상관없어”라고 입력해도 돼요.' });

      const rules = ruleParse(t, state.cond);
      const optionIndex = state.pending?.findIndex(o => compact(t) === compact(o.label));
      if (state.pending && (noPreference || optionIndex >= 0) && !areaChanged) {
        return handle(state, { type: 'option', index: noPreference ? -1 : optionIndex }, ai);
      }
      if (hasFood(state) && !area && !Object.keys(rules).length && /^다른\s*(?:데|대|곳|가게|집)(?:도|는|은)?\s*(?:있어\w*|추천\w*|보여\w*)?[?! .]*$/.test(ft)) {
        if (state.cond.store && state.cond.menu) {
          const seen = state.seen;
          setCond(state, { store: null });
          state.seen = seen;
        }
        state.excludeSeen = true; state.pending = null;
        return fromStep2(state, ai, false);
      }
      if (hasFood(state) && state.lastMin > 1 && !area && rules.menu === undefined && rules.budget === undefined &&
        /^(?:더\s*(?:싸게|사게|저렴하게|싼\s*걸로)|(?:가격|예산)\s*(?:을)?\s*(?:좀|조금|더)?\s*낮춰(?:\s*줘)?)[?! .]*$/.test(ft)) {
        setCond(state, { budget: state.lastMin, budget_unit: 'total', price_pref: 'none', budget_under: true });
        return fromStep2(state, ai);
      }
      if (area && !Object.keys(rules).length && /지역|동네|서울|구|동/.test(t) && !/먹고|찾아|음식|메뉴/.test(t)) {
        return hasFood(state) ? fromStep2(state, ai) : out(state, { text: `${areaLabel(state)}에서 어떤 음식을 찾으세요?`, buttons: menuButtons() });
      }

      const newText = t.split(/말고|대신(?:에)?|아니라/).at(-1).trim() || t;
      const named = findStoreName(newText);
      const storeQuery = named || newText.match(/[“"‘']([^”"’']{2,60})[”"’']\s*(?:가게|매장|식당)/)?.[1] ||
        newText.match(/(?:^|\s)([가-힣A-Za-z0-9·-]{2,40}(?:점|치킨집|식당))\s*(?:은|는|이|가|도)?\s*(?:있|찾|알려|어때|에서)/)?.[1];
      let parsed = {};
      try { parsed = await ai.parse(t, aiParseCond(state.cond)); }
      catch (e) { if (e.message !== 'Gemini unavailable') console.warn('[AI ①] 실패 → 규칙 기반:', e.message); }
      const foodIntent = /먹고|먹을|추천|메뉴|땡겨|당겨|있어|배달|바꿔|찾아|보여/.test(newText);
      const rawDish = foodIntent && typeof parsed.dish === 'string' && compact(parsed.dish).length >= 2 &&
        compact(newText).includes(compact(parsed.dish)) && !CATEGORIES.includes(parsed.dish) ? parsed.dish : null;
      const literalDish = !area && newText.match(/^([가-힣A-Za-z\d]+(?:\s+[가-힣A-Za-z\d]+){0,2}?)\s*(?:이|가|을|를)?\s+(?:먹고\s*싶|추천해|찾아)/)?.[1];
      const dishWithCategory = typeof rules.menu === 'string' && !rules.dish && rawDish && compact(rawDish) !== compact(rules.menu);
      let next = { ...rules };
      if (dishWithCategory || (rules.menu === undefined && (rawDish || (!Object.keys(rules).length && literalDish)))) {
        next.menu = parsed.menu || null;
        next.dish = rawDish || literalDish;
        if (next.dish !== state.cond.dish) next.taste ??= [];
      } else if (rules.menu === undefined && parsed.menu && (foodIntent || /^[가-힣]{2,6}$/.test(newText)) && parsed.menu !== state.cond.menu && !Object.keys(rules).length && !area) {
        next = { menu: parsed.menu, dish: null, taste: [] };
      }
      const namedCategory = named && stores.find(s => matchesStore(named, s))?.category;
      if (storeQuery) {
        next = { ...next, store: storeQuery, menu: next.menu || namedCategory || state.cond.menu, dish: next.dish ?? (namedCategory === state.cond.menu ? state.cond.dish : null) };
        if (namedCategory && namedCategory !== state.cond.menu) next.taste ??= [];
      } else if (next.menu !== undefined || next.dish !== undefined) {
        next.store = null;
      }
      if (Array.isArray(parsed.taste)) {
        const mentioned = parsed.taste.filter(term => typeof term === 'string' && compact(term).length >= 2 && compact(newText).includes(compact(term)) &&
          ![next.dish, next.menu, next.store, area?.label].some(v => compact(v) === compact(term)));
        if (mentioned.length) next.taste = [...new Set([...(next.taste || state.cond.taste), ...mentioned])];
      }
      if (!Object.keys(next).length && !area) {
        return out(state, { text: hasFood(state) ? '바꿀 조건을 확인하지 못했어요. 음식 이름이나 지역, 예산을 말씀해 주세요.' : '어떤 음식을 찾으세요? 음식 이름이나 가게 이름을 말씀해 주세요.', buttons: menuButtons() });
      }
      setCond(state, next);
      if (!hasFood(state)) return out(state, { text: '어떤 음식을 찾으세요?', buttons: menuButtons() });
      return fromStep2(state, ai);
    }
    throw new Error('bad action');
  }

  const aiParseCond = c => ({ menu: c.menu, dish: c.dish, people: c.people, budget: c.budget, budget_unit: c.budget_unit, price_pref: c.price_pref, taste: c.taste, franchise: c.franchise });

  return { handle, regions, categories: CATEGORIES };
}
