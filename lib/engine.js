// Menu recommendation engine adapted from feature/ai-recommend.
export const CATEGORIES = [
  '치킨', '한식', '중식', '분식', '피자', '카페·디저트', '일식', '양식', '아시안',
  '고기·구이', '패스트푸드', '족발·보쌈', '야식', '도시락·죽', '샐러드', '편의점',
];
const CATEGORY_MAP = new Map([
  ['치킨·튀김','치킨'], ['국·탕','한식'], ['밥·덮밥','한식'], ['양식·일식','양식'],
  ['돈까스·일식','일식'], ['버거','패스트푸드'],
]);
const portionEvidence = /푸짐|넉넉|대용량|곱빼기|[2-9]\s*인분|두\s*마리|[2-9]\s*마리/;
const wholeChickenEvidence = /한\s*마리|1\s*마리/;
const EXTRA_CHEESE = '치즈 듬뿍';
const cheeseRequest = /(?:치[즈츠]|모짜렐라|모차렐라)(?:를|을|가|는|은|도)?\s*(?:많|듬뿍|가득|푸짐|넉넉|두\s*배|2\s*배|추가|더\s*올린)|(?:듬뿍|가득|두\s*배|2\s*배)\s*치[즈츠]|(?:더블|엑스트라)\s*치[즈츠]/;
const cheeseAmount = /(?:치즈|모짜렐라|모차렐라)(?:를|을|가|는|은|도)?\s*(?:두\s*배|2\s*배|듬뿍|가득|푸짐|넉넉|많이|많은|많아요|수북)|(?:더블|엑스트라|듬뿍|가득|두\s*배|2\s*배)\s*치즈/;
const franchiseQuestion = /프[랜렌]차이즈(?:\s*(?:가|는|도))?\s*(?:아니(?:야|에요|죠)|아닌(?:가|지)|맞(?:아|나요|죠|는지)|인(?:가|지)|예요|에요|야|입니까|[?？])/;
const sideOrDrink = /^(?:공깃?밥|밥추가|콜라|사이다|탄산수|생수|제로콜라|주류)|모둠튀김|모듬튀김|감자튀김|치즈볼|군만두|음료|토핑|사리|소스추가|아이스크림|케이크|아메리카노/;
function menuPortion(menu, category) {
  const servings = /(?:^|[^\d])(\d{1,2})(?:\s*[~∼–-]\s*\d{1,2})?\s*인(?:분|용|\s*세트|\s*기준|(?=[\s)\]]|$))/;
  const knownCount = /(?:^|[^가-힣])(한|두|세|네)\s*명(?:이서|\s*기준)/;
  const descriptionCount = menu.desc.match(knownCount)?.[1];
  const explicit = Number(menu.name.match(servings)?.[1] || menu.desc.match(servings)?.[1] ||
    ({ 한: 1, 두: 2, 세: 3, 네: 4 })[descriptionCount]);
  if (explicit > 0 && explicit <= 20) return { servings: explicit, estimated: false };
  const shareable = category === '치킨' || category === '피자';
  const count = menu.name.match(/(\d)\s*마리/);
  const chickens = Number(count?.[1] || (/두\s*마리/.test(menu.name) ? 2 : 1));
  return { servings: shareable ? Math.max(1, chickens) * 2 : 1, estimated: true };
}
const ALL_REGIONS = '서울 전체';
const SEOUL_DISTRICTS = new Set('강남구 강동구 강북구 강서구 관악구 광진구 구로구 금천구 노원구 도봉구 동대문구 동작구 마포구 서대문구 서초구 성동구 성북구 송파구 양천구 영등포구 용산구 은평구 종로구 중구 중랑구'.split(' '));
const compact = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const DISH_ALIASES = [
  /짜장면|자장면|짜장/, /짬뽕/, /탕수육/, /꿔바로우/, /닭강정/, /(?:후라이드|프라이드)(?:순살|뼈)?(?:치킨)?/,
  /간장(?:순살|뼈)?치킨/, /양념(?:순살|뼈)?치킨/, /마늘(?:순살|뼈)?치킨/, /김치찌개/, /된장찌개/, /순두부찌개/, /부대찌개/,
  /김치찜/, /찜닭/, /옻닭/, /감자탕/, /국밥/, /제육볶음|제육/, /비빔밥/, /갈비탕/,
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
  const stores = snapshot.stores.filter(store => store.is_open !== false && menuGroups.has(store.id)).map(store => ({
    ...store, category: CATEGORY_MAP.get(store.category) ?? store.category, minOrder: 0,
  }));
  const storesById = new Map(stores.map(store => [store.id, store]));
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

  // ---------- 노출 횟수 (가게별, 매일 0시 초기화) ----------
  // ponytail: 서버 메모리라 재시작/서버리스 인스턴스마다 초기화됨. 유지가 필요하면 Supabase 테이블로.
  const exposure = { day: '', counts: {} };
  const dateFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul' });
  function expo(id) {
    const day = dateFormat.format();
    if (exposure.day !== day) { exposure.day = day; exposure.counts = {}; }
    return (storesById.get(id)?.exposure_count ?? 0) + (exposure.counts[id] ?? 0);
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
  const freshCond = () => ({ menu: null, dish: null, foods: [], store: null, people: null, budget: null, budget_floor: null, budget_unit: 'total', price_pref: 'none', taste: [], franchise: 'none', budget_under: false });
  const fresh = dong => ({ dong, neighborhood: null, excludedRegion: null, awaitingRegion: false, cond: freshCond(), chosen: [], questions: 0, asked: [], pending: null, seen: [], excludeSeen: false, exposed: [], cheapBoost: 1, lastMin: null, lastTop: [], lastRecommendations: [], preferredMenu: null });
  const isGroupMeal = c => c.people > 1 && c.budget != null;
  const canSearch = ({ cond, dong }) => !!dong && !!(cond.menu || cond.dish || cond.foods.length || cond.store || isGroupMeal(cond));
  const areaLabel = state => state.neighborhood ? `${state.dong} ${state.neighborhood}` : state.excludedRegion ? `서울 전체 (${state.excludedRegion} 제외)` : state.dong;

  const validOption = option => option && typeof option.label === 'string' && Array.isArray(option.store_ids);

  function load(raw) {
    const s = { ...fresh(null), ...(raw && typeof raw === 'object' ? raw : {}) };
    if (s.dong !== ALL_REGIONS && !regions.includes(s.dong)) s.dong = null;
    if (!areas.get(s.neighborhood)?.has(s.dong)) s.neighborhood = null;
    if (s.dong !== ALL_REGIONS || !regions.includes(s.excludedRegion)) s.excludedRegion = null;
    s.cond = { ...freshCond(), ...(s.cond && typeof s.cond === 'object' ? s.cond : {}) };
    for (const k of ['chosen', 'asked', 'seen', 'exposed', 'lastTop']) s[k] = Array.isArray(s[k]) ? s[k].slice(-500) : [];
    s.chosen = s.chosen.filter(validOption).slice(0, 3);
    s.pending = Array.isArray(s.pending) ? s.pending.filter(validOption).slice(0, 5) : null;
    const validLine = item => typeof item?.menuId === 'string' && Number.isInteger(item.qty) && item.qty >= 1 && item.qty <= 20;
    s.lastRecommendations = Array.isArray(s.lastRecommendations) ? s.lastRecommendations.slice(0, 36).filter(item =>
      typeof item?.storeId === 'string' && validLine(item) &&
      (item.items == null || (Array.isArray(item.items) && item.items.length <= 2 && item.items.every(validLine)))) : [];
    if (typeof s.preferredMenu !== 'string') s.preferredMenu = null;
    const inputCond = s.cond;
    s.cond = freshCond();
    setCond(s, inputCond, true);
    s.questions = Number(s.questions) || 0;
    s.cheapBoost = Math.min(Math.max(Number(s.cheapBoost) || 1, 1), 1.5);
    return s;
  }

  function resetSearch(state) {
    Object.assign(state, { awaitingRegion: false, chosen: [], questions: 0, asked: [], pending: null, seen: [], excludeSeen: false, cheapBoost: 1, lastMin: null, lastTop: [], lastRecommendations: [], preferredMenu: null });
  }

  function setCond(state, next, rehydrate = false) {
    const prev = state.cond;
    const c = { ...prev };
    for (const k of ['menu', 'dish', 'store', 'people', 'budget', 'budget_unit', 'price_pref', 'taste', 'franchise']) if (k in next) c[k] = next[k];
    if (!CATEGORIES.includes(c.menu)) c.menu = null;
    for (const k of ['dish', 'store']) c[k] = typeof c[k] === 'string' ? c[k].trim().slice(0, 80) || null : null;
    if (/^(?:너가|네가|니가|당신이)$/.test(c.dish ?? '')) c.dish = null;
    if ('foods' in next || 'menu' in next || 'dish' in next || 'store' in next) {
      c.foods = Array.isArray(next.foods) ? next.foods.slice(0, 3).flatMap(food => {
        const menu = CATEGORIES.includes(food?.menu) ? food.menu : null;
        const dish = typeof food?.dish === 'string' ? food.dish.trim().slice(0, 80) || null : null;
        return menu || dish ? [{ menu, dish }] : [];
      }) : [];
    }
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
  function ctx(state, alternatives = false) {
    const c = state.cond, people = c.people || 1;
    const exact = !alternatives && !!(c.dish || c.store);
    const primaryMenus = s => {
      if (exact && c.dish) return menuGroups.get(s.id).filter(m => dishMatches(c.dish, m.name));
      if (!c.menu && !exact && isGroupMeal(c) && ['카페·디저트', '편의점'].includes(s.category)) return [];
      if (!exact && people > 1) return mains[s.id].filter(m => !sideOrDrink.test(compact(m.name)));
      return exact && c.store && !mains[s.id].length ? menuGroups.get(s.id) : mains[s.id];
    };
    const items = s => {
      const menus = primaryMenus(s);
      return c.taste.includes(EXTRA_CHEESE) ? menus.filter(menu => menuEvidence(menu, EXTRA_CHEESE)) : menus;
    };
    const plansByStore = new Map();
    const plans = store => {
      if (plansByStore.has(store.id)) return plansByStore.get(store.id);
      const mainMenus = items(store);
      const otherMeals = people > 1 ? menuGroups.get(store.id).filter(menu =>
        !sideOrDrink.test(compact(menu.name)) && mainMenuFor(store.category, menu.name)) : [];
      const portions = new Map([...mainMenus, ...otherMeals].map(menu => [menu.id, menuPortion(menu, store.category)]));
      const options = [];
      const add = (menu, qty, other, otherQty) => {
        const lines = [{ menu, qty }];
        if (other) lines.push({ menu: other, qty: otherQty });
        const subtotal = lines.reduce((sum, line) => sum + line.menu.price * line.qty, 0);
        if (subtotal < store.minOrder) return;
        options.push({
          menu, qty, lines, total: subtotal + store.tip,
          estimated: lines.some(line => portions.get(line.menu.id).estimated),
          extraServings: lines.reduce((sum, line) => sum + portions.get(line.menu.id).servings * line.qty, 0) - people,
        });
      };
      for (const menu of mainMenus) {
        const portion = portions.get(menu.id).servings;
        add(menu, Math.ceil(people / portion));
        if (portion >= people) continue;
        for (const other of otherMeals) {
          if (other.id === menu.id) continue;
          for (let qty = 1; qty * portion < people; qty += 1) {
            add(menu, qty, other, Math.ceil((people - qty * portion) / portions.get(other.id).servings));
          }
        }
      }
      plansByStore.set(store.id, options);
      return options;
    };
    const minTotal = s => plans(s).reduce((lowest, plan) => Math.min(lowest, plan.total), Infinity);
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
    return { plans, items, exact, people, base, totalBudget, budgetFloor, fitsBudget, mode, avgRating, minTotal };
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
      && x.plans(s).some(plan => o.ignoreBudget || x.fitsBudget(plan.total, tb))
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
    term === EXTRA_CHEESE ? [menu.name, menu.desc].some(value => cheeseAmount.test(value)) :
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

  const TASTES = ['바삭', '간장', '양념', '마늘', '매운', '순살', '뼈', '치즈', '로제', '짜장', '짬뽕', '마라', '국물', '담백', '반반', '불향', '해물', '크림', '얼큰', '칼칼', '달콤', '화덕', '세트'];
  const MENU_WORDS = [
    ['치킨', /치킨|통닭|후라이드|닭강정/], ['중식', /중식|중국|짜장|짬뽕|탕수육|마라|꿔바로우/],
    ['분식', /분식|떡볶이|김밥|순대|라볶이/], ['피자', /피자/],
    ['한식', /한식|국밥|해장|제육|비빔밥|찌개|갈비|찜|탕/], ['카페·디저트', /카페|디저트|커피|케이크/],
    ['일식', /일식|초밥|스시|우동|돈가스|돈까스|라멘/], ['양식', /양식|파스타|스테이크|리소토/],
    ['아시안', /아시안|쌀국수|팟타이/], ['고기·구이', /고기[·/ ]구이|삼겹살|목살/],
    ['패스트푸드', /패스트푸드|햄버거|버거/], ['족발·보쌈', /족발|보쌈/], ['야식', /야식/],
    ['도시락·죽', /도시락|[가-힣]+죽/], ['샐러드', /샐러드|포케/], ['편의점', /편의점/],
  ];
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
      const clauses = part.split(/(?:에서(?:는)?|으로\s*바꾸고|로\s*바꾸고|바꿔서|[,.;!?])\s*/);
      const localText = (clauses.findLast(clause => MENU_WORDS.some(([, pattern]) => pattern.test(clause))) ?? part).trim();
      const literal = localText.match(/^([가-힣A-Za-z\d]+(?:\s+[가-힣A-Za-z\d]+){0,2}?)\s*(?:이|가|을|를)?\s+(?:먹고\s*싶|추천해|찾아)/)?.[1] ||
        localText.match(/^([가-힣A-Za-z\d]+(?:\s+[가-힣A-Za-z\d]+){0,2})$/)?.[1];
      const literalFood = literal && category && !cheeseRequest.test(literal) && !readArea(literal) && compact(literal) !== compact(category) &&
        /(?:치킨|피자|탕|찌개|찜|스테이크|파스타|우동|라멘|국밥|김밥|초밥|짜장면|짬뽕|떡볶이)$/.test(compact(literal)) &&
        !/^(?:양|가격|예산)|[은는한]\s/.test(literal) ? literal : null;
      const dish = literalFood || named?.name || known;
      if (dish || category) return { menu: named?.categories.size === 1 ? [...named.categories][0] : category ?? null, dish: dish ?? null, text };
    }
    return null;
  }

  function readFoodList(text) {
    const parts = text.split(/(?:이랑|하고|(?:랑|와|과)(?=\s)|\s및\s|\s그리고\s|,\s+|\s*[＋+]\s*)/);
    if (parts.length < 2) return [];
    const foods = parts.flatMap(part => {
      const food = readFood(part);
      return food ? [{ menu: food.menu, dish: food.dish }] : [];
    });
    return [...new Map(foods.map(food => [compact(food.dish || food.menu), food])).values()].slice(0, 3);
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
    if (/프[랜렌]차이즈\s*(?:는|를|가)?\s*(?:말고|빼|제외|싫|x)|프[랜렌]차이즈\s*(?:가\s*)?아닌\s*(?:가게|곳|집|매장|걸로|데로|피자집|치킨집)|개인\s*(?:가게|매장|피자집)\s*(?:만|으로)/i.test(t)) out.franchise = 'exclude';
    else if (/프[랜렌]차이즈\s*만/.test(t)) out.franchise = 'only';
    else if (/프[랜렌]차이즈(도|는)?\s*(괜찮|상관)|프[랜렌]차이즈\s*포함/.test(t)) out.franchise = 'none';
    const foodText = food?.text || t.split(/말고|대신(?:에)?/).at(-1);
    const found = TASTES.filter(w => foodText.includes(w)).concat(/매콤|맵/.test(foodText) && !foodText.includes('매운') ? ['매운'] : []);
    if (cheeseRequest.test(foodText)) found.push(EXTRA_CHEESE);
    if (/양[이가은도]?\s*많|푸짐|넉넉|배부르|배불/.test(foodText)) found.push('푸짐');
    const taste = (terms) => terms.includes(EXTRA_CHEESE) ? terms.filter(term => term !== '치즈') : terms;
    if (/(?:맛|취향)\s*(?:은|는)?\s*(?:아무\s*거나|상관\s*없)/.test(t)) out.taste = [];
    else if ((food && (food.menu !== cur.menu || food.dish !== cur.dish)) || (found.length && /말고|대신|바꿔/.test(t))) out.taste = taste(found);
    else if (found.length) out.taste = taste([...cur.taste, ...found]);
    return out;
  }

  // ---------- 화면용 ----------
  const won = n => `${n.toLocaleString('ko-KR')}원`;
  const menuButtons = () => CATEGORIES.map(c => ({ label: c, action: { type: 'apply', cond: { menu: c } } }));
  const followUps = () => ['다른 데는?', '더 싸게', '다른 지역도 괜찮아요', '처음부터'].map(t => ({ label: t, action: { type: 'text', text: t }, ghost: true }));
  const moreButton = count => ({
    label: count > 36 ? `후보 더 보기 · ${count}곳 남음` : `남은 후보 ${count}곳 더 보기`,
    action: { type: 'text', text: `나머지 ${Math.min(count, 36)}곳도 보여줘` },
    ghost: true,
  });
  const moreRequest = /^(?:(?:나머지|남은|다른|추가로)\s*(\d{1,4})\s*(?:곳|개|가지)(?:의\s*)?(?:후보|가게|메뉴)?(?:도|은|는|을|를)?\s*(?:다\s*)?(?:보여|알려|추천).*|(?:아직\s*)?(?:안\s*본|나머지|남은|다른)\s*(?:후보|데|대|곳|가게|집|메뉴)?(?:도|는|은|를|을)?\s*(?:전부\s*|모두\s*|더\s*|다\s*)?(?:(?:있어|추천|보여|알려)[가-힣\s]*)?[?! .]*|(?:더|전부|모두)\s*(?:보여|알려).*)$/;

  function chips(state) {
    const c = state.cond;
    if (!state.dong) return [];
    const out = [{ label: areaLabel(state) }];
    if (!canSearch(state)) return out;
    if (c.menu) out.push({ label: c.menu });
    for (const food of c.foods) out.push({ label: food.dish || food.menu });
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
  const brandKey = store => store.franchise ? compact(storeBase(store.name)) : store.id;
  function diversify(rows, getStore) {
    const brands = new Set();
    const distinct = [];
    const repeated = [];
    for (const row of rows) {
      const brand = brandKey(getStore(row));
      (brands.has(brand) ? repeated : distinct).push(row);
      brands.add(brand);
    }
    return { distinct, repeated };
  }
  const matchesStore = (query, store) => [store.name, storeBase(store.name)].some(name => compact(name) === compact(query));
  const storeNames = [...new Set(stores.flatMap(s => [s.name, storeBase(s.name)]))]
    .map(name => [compact(name), name]).filter(([key]) => key.length >= 2 && !CATEGORIES.some(c => compact(c) === key))
    .sort(([a], [b]) => b.length - a.length);
  function findStoreName(text) {
    const normalized = compact(text);
    return storeNames.find(([key]) => normalized.includes(key))?.[1];
  }

  const withStoreBadge = card => ({ ...card, isGoodPrice: storesById.get(card.storeId)?.is_good_price === true });
  const out = (state, reply) => ({
    state,
    reply: {
      ...reply,
      ...(reply.cards ? { cards: reply.cards.map(withStoreBadge) } : {}),
      ...(reply.selected ? { selected: withStoreBadge(reply.selected) } : {}),
      chips: chips(state),
    },
  });

  function answerFranchiseQuestion(state, text) {
    const recommended = state.lastRecommendations.map(item => stores.find(store => store.id === item.storeId)).filter(Boolean);
    const named = findStoreName(text);
    const rank = text.match(/(\d{1,2})\s*(?:번|번째|위)|첫\s*번째|두\s*번째|세\s*번째/);
    const index = rank && (rank[1] ? Number(rank[1]) - 1 : /첫/.test(rank[0]) ? 0 : /두/.test(rank[0]) ? 1 : 2);
    const candidates = rank ? [recommended[index]].filter(Boolean) : named ? stores.filter(store => matchesStore(named, store)) : recommended;
    if (!candidates.length) return out(state, {
      text: '어느 가게가 궁금하신가요? 가게 이름이나 추천 번호를 알려 주세요.',
      preserveResults: true,
    });
    const names = [...new Set(candidates.map(store => store.name))];
    const franchise = candidates.filter(store => store.franchise);
    const sameBrand = franchise.length > 1 && new Set(franchise.map(brandKey)).size === 1;
    const status = franchise.length === candidates.length
      ? sameBrand ? `네, DB 기준으로 ‘${storeBase(franchise[0].name)}’의 프랜차이즈 지점들이에요.`
        : `DB에서 프랜차이즈로 분류된 가게예요. ${names.join(' · ')}`
      : franchise.length ? `DB에서 프랜차이즈로 분류된 가게는 ${franchise.map(store => store.name).join(' · ')}이고, 나머지는 프랜차이즈가 아니에요.`
        : `DB에서 비프랜차이즈로 분류된 가게예요. ${names.join(' · ')}`;
    return out(state, {
      text: status,
      preserveResults: true,
      buttons: franchise.length ? [{ label: '같은 조건으로 프랜차이즈 빼기', action: { type: 'apply', cond: { franchise: 'exclude' } } }] : [],
    });
  }

  function planCard({ menu, qty, lines, total, estimated, extraServings }, people) {
    return {
      menuId: menu.id, menu: menu.name, qty, total,
      ...(lines.length > 1 ? { items: lines.map(line => ({ menuId: line.menu.id, name: line.menu.name, qty: line.qty })) } : {}),
      ...(people > 1 ? {
        portionNote: estimated ? `${people}인 기준 예상 구성` : `${people + extraServings}인분 표기 기준`,
        setMenu: lines.length === 1 && /세트|콤보/.test(menu.name),
      } : {}),
    };
  }

  function eligibleMenus(store, x) {
    const cheapest = new Map();
    for (const plan of x.plans(store)) {
      if (x.fitsBudget(plan.total) && plan.total < (cheapest.get(plan.menu.id)?.total ?? Infinity)) {
        cheapest.set(plan.menu.id, plan);
      }
    }
    return [...cheapest.values()].sort((a, b) => a.total - b.total).map(plan => plan.menu);
  }

  function confirmRecommendation(state, text) {
    const approval = text.match(/(?:마음|맘)에\s*들|그(?:거|걸)(?:로)?\s*(?:할래|할게|좋아|괜찮)|(?:괜찮|좋)(?:아|아요|네|네요|습니다|은데)|(?:저|이|그)(?:걸|거)로\s*(?:할래|할게|정할게)/);
    if (!approval || !state.lastRecommendations.length || hasPrice(text) ||
      /말고|대신|바꿔|다시\s*(?:찾|검색)|다른\s*(?:지역|동네|데|가게|메뉴)|안\s*(?:좋|괜찮|들)|(?:좋지|들지|들진)\s*않/.test(text)) return null;
    const rank = text.match(/(\d{1,2})\s*(?:번|번째|위)|첫\s*번(?:째)?|두\s*번째|세\s*번째|맨\s*(?:위|아래)|마지막/);
    const ranked = rank && (rank[1] ? Number(rank[1]) - 1 : /첫|맨\s*위/.test(rank[0]) ? 0 : /두/.test(rank[0]) ? 1 : /세/.test(rank[0]) ? 2 : state.lastRecommendations.length - 1);
    const choices = state.lastRecommendations.flatMap((item, index) => {
      const store = stores.find(s => s.id === item.storeId);
      if (!store) return [];
      const lines = (item.items ?? [item]).map(line => ({
        menu: menuGroups.get(store.id).find(menu => menu.id === line.menuId), qty: line.qty,
      }));
      if (!lines.length || lines.some(line => !line.menu)) return [];
      return [{ index, store, lines, menu: lines[0].menu }];
    });
    const mentioned = compact(text);
    const named = choices.filter(({ store, lines }) => [store.name, storeBase(store.name), ...lines.map(line => line.menu.name)]
      .some(name => compact(name) && mentioned.includes(compact(name))));
    const general = /(?:마음|맘)에\s*들|^(?:좋아(?:요)?|괜찮(?:아|아요|네|네요))[!. ]*$|(?:이|그|저)(?:거|걸|\s*가게|\s*메뉴|\s*추천)|(?:방금|직전|아까)\s*(?:추천|보여)/.test(text);
    if (!rank && !named.length && !general) return null;
    const preferred = choices.find(c => c.menu.id === state.preferredMenu);
    const candidates = rank ? choices.filter(c => c.index === ranked) : named.length ? named : preferred ? [preferred] : choices;
    state.pending = null;
    state.awaitingRegion = false;
    if (candidates.length !== 1) return out(state, {
      text: '어느 추천이 마음에 들었나요? 가게나 메뉴 이름, 또는 추천 번호를 알려 주세요.',
      buttons: (candidates.length ? candidates : choices).map(c => ({ label: `${c.index + 1}번 · ${c.store.name}`, action: { type: 'text', text: `${c.index + 1}번이 마음에 들어` } })),
    });
    const { store, menu, lines } = candidates[0];
    const total = lines.reduce((sum, line) => sum + line.menu.price * line.qty, store.tip);
    const people = state.cond.people || 1;
    const portions = lines.map(line => ({ ...menuPortion(line.menu, store.category), qty: line.qty }));
    const estimated = portions.some(portion => portion.estimated);
    const extraServings = portions.reduce((sum, portion) => sum + portion.servings * portion.qty, 0) - people;
    const name = lines.map(line => line.menu.name).join(' + ');
    state.preferredMenu = menu.id;
    return out(state, {
      text: `‘${store.name}’의 ‘${name}’이 마음에 드셨군요. 아래에서 바로 장바구니에 담거나 가게 메뉴를 볼 수 있어요.`,
      selected: { storeId: store.id, name: store.name, ...planCard({ menu, qty: lines[0].qty, lines, total, estimated, extraServings }, people), checks: [store.region + ' ' + store.dong], rating: store.rating, quote: menu.desc, budgetNote: budgetNoteFor(state, total) },
    });
  }

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
    if (state.cond.franchise === 'exclude' && !state.cond.taste.includes(EXTRA_CHEESE)) {
      add(n => `프랜차이즈도 괜찮으면 ${n}곳${more} 있어요`, { cond: { franchise: 'none' } }, { type: 'apply', cond: { franchise: 'none' } });
    }
    if (state.excludeSeen && !leftIds.size) {
      add(n => `새 가게는 더 없어요. 아까 본 ${n}곳 다시 볼까요?`, { excludeSeen: false }, { type: 'apply', seenAgain: true });
    }
    return res.slice(0, 3);
  }

  function zero(state, x, leftIds = new Set(), lead = `${areaLabel(state)}에서 검색한 가게 중 현재 조건을 모두 만족하는 곳을 찾지 못했어요.`) {
    const cs = concessions(state, x, leftIds);
    if (!cs.length) return out(state, { text: `${lead} 지역이나 음식 조건을 바꿔 찾아볼 수 있어요.`, buttons: followUps().filter(b => b.label === '처음부터' || (b.label === '다른 지역도 괜찮아요' && state.dong !== ALL_REGIONS)), remaining: 0 });
    return out(state, { text: `${lead} 이렇게 바꿔 볼까요?`, buttons: cs, remaining: 0 });
  }

  function budgetNoteFor({ cond }, total) {
    if (cond.budget == null) return null;
    const people = cond.budget_unit === 'per_person' ? cond.people || 1 : 1;
    const cap = cond.budget * people;
    const floor = (cond.budget_floor || 0) * people;
    if (total > cap) return `예산보다 ${won(total - cap)} 높아요`;
    if (total === cap && cond.budget_under) return '입력한 예산과 같아요 · 미만 조건 제외';
    if (total < floor) return `최소 예산보다 ${won(floor - total)} 낮아요`;
    return null;
  }

  function rememberCards(state, cards, displayed = cards) {
    for (const { storeId } of cards) {
      if (!state.exposed.includes(storeId)) {
        expo(storeId);
        exposure.counts[storeId] = (exposure.counts[storeId] ?? 0) + 1;
        state.exposed.push(storeId);
      }
      if (!state.seen.includes(storeId)) state.seen.push(storeId);
    }
    state.lastMin = Math.min(...displayed.map(card => card.total));
    state.lastTop = cards.map(card => card.storeId);
    state.lastRecommendations = displayed.map(({ storeId, menuId, qty, items }) => ({
      storeId, menuId, qty, ...(items ? { items: items.map(({ menuId, qty }) => ({ menuId, qty })) } : {}),
    }));
    state.preferredMenu = null;
  }

  function budgetAlternatives(state, x, lead, limit = 3) {
    if (x.totalBudget == null) return null;
    const terms = [...new Set([...state.cond.taste, ...state.chosen.map(choice => choice.label)])];
    const compare = (a, b) => a.distance - b.distance || b.confirmed.length - a.confirmed.length ||
      a.total - b.total || (b.store.rating ?? 0) - (a.store.rating ?? 0);
    const closest = filterStores(state, x, { ignoreBudget: true }).map(store => {
      return x.plans(store).map(plan => {
        const { menu, total } = plan;
        const confirmed = terms.filter(term => menuEvidence(menu, term));
        const distance = total < x.budgetFloor ? x.budgetFloor - total : Math.abs(total - x.totalBudget);
        return { ...plan, store, confirmed, distance };
      }).sort(compare)[0];
    }).sort(compare);
    if (!closest.length) return null;
    const { distinct, repeated } = diversify(closest, plan => plan.store);
    const candidates = state.excludeSeen ? [...distinct, ...repeated] : distinct;
    const cards = candidates.slice(0, limit).map(plan => {
      const { store, menu, total, confirmed } = plan;
      const budgetNote = budgetNoteFor(state, total);
      return {
        storeId: store.id, name: store.name, ...planCard(plan, x.people),
        checks: [store.region + ' ' + store.dong, store.franchise ? '프랜차이즈' : '프랜차이즈 아님', ...confirmed],
        partial: !!lead || !!budgetNote || confirmed.length < terms.length,
        rating: store.rating, budgetNote,
        reason: terms.length && confirmed.length < terms.length ? '메뉴 정보에서 요청한 맛이나 양을 모두 확인할 수 없어요.' : '',
        quote: menu.desc,
      };
    });
    rememberCards(state, cards);
    const remaining = closest.length - cards.length;
    const intro = lead || `${areaLabel(state)}에서 현재 조건을 모두 만족하는 메뉴를 찾지 못했어요.`;
    return out(state, {
      text: `${intro} 배달비를 포함해 입력하신 예산에 가까운 대안을 보여드릴게요.`,
      cards,
      remaining,
      buttons: [...(remaining ? [moreButton(remaining)] : []), ...followUps().filter(button =>
        button.label !== '다른 데는?' && (button.label !== '다른 지역도 괜찮아요' || state.dong !== ALL_REGIONS))],
    });
  }

  function combinedFoodResults(state, limit) {
    const { foods, taste } = state.cond;
    const groups = foods.map(food => {
      const label = food.dish || food.menu;
      const search = { ...state, cond: { ...state.cond, ...food } };
      const x = ctx(search);
      const compare = (a, b) => Number(!!a.budgetNote) - Number(!!b.budgetNote) ||
        Number(a.partial) - Number(b.partial) || a.total - b.total || (b.rating ?? 0) - (a.rating ?? 0);
      const candidates = filterStores(search, x, { ignoreBudget: true }).flatMap(store => {
        const cards = x.plans(store).map(plan => {
          const { menu, total } = plan;
          const confirmed = taste.filter(term => menuEvidence(menu, term));
          return {
            storeId: store.id, name: store.name, foodLabel: label, ...planCard(plan, x.people),
            checks: [store.region + ' ' + store.dong, ...confirmed], rating: store.rating,
            partial: confirmed.length < taste.length, budgetNote: budgetNoteFor(state, total), quote: menu.desc,
          };
        });
        const best = cards.sort(compare)[0];
        return best ? [best] : [];
      }).sort(compare);
      return { label, candidates };
    });
    const picked = new Map();
    const remaining = new Set(groups.flatMap(group => group.candidates.map(card => card.storeId)));
    const cursor = groups.map(() => 0);
    const firstGroup = state.excludeSeen ? state.seen.length % groups.length : 0;
    while (picked.size < limit && remaining.size) {
      for (let offset = 0; offset < groups.length && picked.size < limit; offset += 1) {
        const index = (firstGroup + offset) % groups.length;
        const { candidates } = groups[index];
        while (cursor[index] < candidates.length && !remaining.has(candidates[cursor[index]].storeId)) cursor[index] += 1;
        const candidate = candidates[cursor[index]];
        if (candidate) {
          picked.set(candidate.storeId, candidate);
          remaining.delete(candidate.storeId);
        }
      }
    }
    const cards = [...picked.values()];
    const missing = groups.filter(group => !group.candidates.length).map(group => group.label);
    const complete = `${groups.map(group => group.label).join('·')} 후보를 음식별로 골랐어요. 카드마다 배달비 포함 예상가를 표시했어요. 가게가 다르면 따로 주문해 주세요.`;
    const budgetDetail = state.cond.budget != null ? ' 함께 주문할 때의 총예산은 장바구니에서 확인해 주세요.' : '';
    const intro = state.excludeSeen ? '같은 조건에서 아직 보여드리지 않은 후보예요.' : complete;
    const unavailable = !state.excludeSeen && missing.length ? ` ${missing.join('·')}는 ${areaLabel(state)}에서 조건에 맞는 후보를 찾지 못했어요.` : '';
    if (cards.length) rememberCards(state, cards);
    state.awaitingRegion = state.dong !== ALL_REGIONS;
    return out(state, {
      text: cards.length ? `${intro}${budgetDetail}${unavailable} 이번에 ${cards.length}곳을 보여드렸고, 남은 후보는 ${remaining.size}곳이에요.`
        : state.excludeSeen ? '같은 조건에서 더 보여드릴 후보가 없어요. 다른 지역이나 조건으로 찾아볼 수 있어요.'
          : `${areaLabel(state)}에서 ${groups.map(group => group.label).join('·')} 후보를 찾지 못했어요. 지역이나 조건을 바꿔 찾아볼 수 있어요.`,
      cards,
      lookup: true,
      remaining: remaining.size,
      buttons: [...(remaining.size ? [moreButton(remaining.size)] : []), ...followUps().filter(button =>
        ['다른 지역도 괜찮아요', '처음부터'].includes(button.label) && (button.label !== '다른 지역도 괜찮아요' || state.dong !== ALL_REGIONS))],
    });
  }

  const aiCond = c => ({ menu: c.menu, people: c.people || 1, taste: c.taste, franchise: c.franchise }); // 가격 정보는 AI ②③에 안 넘긴다

  // ---------- 3단계: 좁히기 질문 ----------
  async function question(state, left, x, ai) {
    const sent = new Map(left.slice(0, 16).map(s => [s.id, eligibleMenus(s, x).slice(0, 8)]));
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
  async function results(state, x, left, ai, alternativeLead = '', limit = 3) {
    const terms = [...new Set([...state.cond.taste, ...state.chosen.map(c => c.label)])];
    const eligible = s => eligibleMenus(s, x);
    const { dish, menu } = state.cond;
    const related = alternativeLead && dish ? Object.entries(SIMILAR).filter(([word]) => dish.includes(word)).flatMap(([word, similar]) => [word, ...similar]) : [];
    const alternativeScore = m => related.some(word => menuEvidence(m, word)) ? 15 : 0;
    const evidence = (s, words) => Math.max(0, ...eligible(s).map(m => words.filter(w => menuEvidence(m, w)).length));
    const pre = s => {
      const hits = evidence(s, terms);
      return priceScore(x.minTotal(s), x) * 30 + ratingScore(s, x.avgRating) * 20 + hits * 25 +
        (hits > 0 && hits === terms.length ? 100 : 0) + Math.max(0, ...eligible(s).map(alternativeScore));
    };
    const candidateLimit = Math.max(8, limit);
    const ranked = left.map(store => ({ store, score: pre(store) }))
      .sort((a, b) => b.score - a.score || expo(a.store.id) - expo(b.store.id));
    const { distinct, repeated } = diversify(ranked, row => row.store);
    const cands = [...distinct, ...repeated].slice(0, candidateLimit).map(row => row.store);

    const fullyVerified = terms.length ? new Map(cands.map(s => [s.id, eligible(s).filter(m => terms.every(term => menuEvidence(m, term)))])) : null;
    const hasVerifiedMatches = fullyVerified && [...fullyVerified.values()].some(list => list.length);
    const judged = new Map();
    try {
      const res = await ai.judge({
        cond: aiCond(state.cond), chosen: state.chosen.map(c => c.label),
        stores: cands.slice(0, 8).map(s => ({ store_id: s.id, menus: eligible(s).slice(0, 10).map(m => ({ menu_id: m.id, name: m.name, desc: m.desc.slice(0, 100) })) })),
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
        const allowed = new Set(j.menu_ids);
        const opts = x.plans(s).filter(plan => allowed.has(plan.menu.id) && x.fitsBudget(plan.total))
          .sort((a, b) => alternativeScore(b.menu) - alternativeScore(a.menu) || a.total - b.total ||
            Number(a.estimated) - Number(b.estimated) || a.extraServings - b.extraServings || a.lines.length - b.lines.length);
        if (!opts.length) continue; // 대표 메뉴 없으면 제외
        const preferred = terms.includes('푸짐') && menu === '치킨'
          ? opts.find(({ menu }) => portionEvidence.test(menu.name + ' ' + menu.desc)) ||
            opts.find(({ menu }) => wholeChickenEvidence.test(menu.name + ' ' + menu.desc))
          : null;
        const plan = preferred || opts[0];
        const { menu: m, total } = plan;
        const matchScore = alternativeLead ? 25 + alternativeScore(m) : j.match === '맞음' ? 50 : 25;
        const score = matchScore + priceScore(total, x) * 30 + ratingScore(s, x.avgRating) * 20;
        res.push({ s, j, m, total, score, plan });
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
    if (!scored.length) return budgetAlternatives(state, x, alternativeLead, limit) || zero(state, x, new Set(), alternativeLead || undefined);

    scored.sort((a, b) => b.score - a.score);
    const [first, ...rest] = scored;
    const peers = rest.filter(r => first.score - r.score <= 5).sort((a, b) => expo(a.s.id) - expo(b.s.id) || Math.random() - 0.5);
    const priority = [first, ...peers, ...rest.filter(row => !peers.includes(row))];
    const brands = diversify(priority, row => row.s);
    const pick = (state.excludeSeen ? [...brands.distinct, ...brands.repeated] : brands.distinct).slice(0, limit);
    pick.sort((a, b) => b.score - a.score);

    const c = state.cond;
    const cards = pick.map(({ s, j, m, total, score, plan }) => {
      const checks = [s.region + ' ' + s.dong];
      checks.push(s.franchise ? '프랜차이즈' : '프랜차이즈 아님');
      const confirmed = terms.filter(t => menuEvidence(m, t));
      checks.push(...confirmed);
      if (x.mode === 'budget') checks.push('예산');
      const save = x.base ? Math.round((x.base - total) / 1000) * 1000 : 0;
      return {
        storeId: s.id, name: s.name, ...planCard(plan, x.people), checks,
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
    rememberCards(state, cards);
    const where = x.mode === 'budget' ? '예산 안에 드는' : '조건에 맞는';
    const text = alternativeLead ? `${alternativeLead} 같은 ${c.menu} 카테고리에서 고른 대안이에요.`
      : swapped ? `'${swapped.missing.join('·')}' 조건을 확인할 수 있는 메뉴가 없어요. 대신 ${x.mode === 'budget' ? '같은 예산 안에서 ' : ''}${swapped.similar ? '비슷한 메뉴가 있는' : '다른 조건이 맞는'} 곳을 골랐어요.`
      : missing.length ? `‘${missing.join('·')}’ 조건은 메뉴 정보에서 확인하지 못했어요. 확인된 조건에 맞는 ${cards.length}곳을 골랐어요.`
      : cards.every(card => card.partial) ? `요청하신 조건을 모두 확인할 수는 없었어요. 확인 가능한 조건에 맞는 ${cards.length}곳이에요.`
      : !same ? `남은 ${left.length}곳 중 ${cards.length}곳을 골랐어요.`
      : left.length === cards.length ? `${where} 가게는 이 ${cards.length}곳이 전부라 결과가 그대로예요.`
      : `${where} ${left.length}곳 중에서는 이 ${cards.length}곳이 가장 잘 맞아요. 다른 곳도 보시려면 '다른 데는?'을 눌러 주세요.`;
    const remaining = left.filter(s => !state.seen.includes(s.id)).length;
    return out(state, {
      text: state.excludeSeen ? `같은 조건에서 아직 보여드리지 않은 ${cards.length}곳이에요.` : text,
      banner: x.mode === 'value' ? '예산을 말씀 안 하셔서 가성비 좋은 곳 위주로 골랐어요.' : null,
      cards,
      buttons: [...(remaining ? [moreButton(remaining)] : []), ...(!alternativeLead && cards.length < 3 ? concessions(state, x, leftIds) : []), ...followUps().filter(b =>
        b.label !== '다른 데는?' && (state.dong !== ALL_REGIONS || b.label !== '다른 지역도 괜찮아요'))],
      remaining,
    });
  }

  async function fromStep2(state, ai, ask = true, limit = 3) {
    state.awaitingRegion = false;
    state.lastRecommendations = [];
    state.preferredMenu = null;
    if (state.cond.foods.length > 1) return combinedFoodResults(state, limit);
    const x = ctx(state);
    const left = filterStores(state, x);
    if (state.excludeSeen && !left.length && !filterStores(state, x, { ignoreBudget: true }).length &&
        !(x.exact && state.cond.menu && filterStores(state, ctx(state, true), { ignoreBudget: true }).length)) {
      return out(state, {
        text: '같은 조건에서 더 보여드릴 후보가 없어요. 다른 지역이나 조건으로 찾아볼 수 있어요.',
        remaining: 0,
        buttons: followUps().filter(button => ['다른 지역도 괜찮아요', '처음부터'].includes(button.label) &&
          (button.label !== '다른 지역도 괜찮아요' || state.dong !== ALL_REGIONS)),
      });
    }
    let result;
    if (!left.length && x.exact) {
      const c = state.cond;
      const existsHere = stores.some(s => inArea(s, state) && (!c.menu || s.category === c.menu) &&
        (!c.store || matchesStore(c.store, s)) && x.items(s).length);
      const subject = [c.store, c.dish].filter(Boolean).map(v => `‘${v}’`).join('의 ');
      const lead = existsHere ? `${subject}에 해당하는 데이터는 있지만 현재 조건에 맞는 결과가 없어요.`
        : `${areaLabel(state)}에서 ${subject}에 해당하는 ${c.dish ? '메뉴' : '가게'}를 찾지 못했어요. 이 검색 범위에서는 선택할 수 없어요.`;
      const fallback = ctx(state, true);
      const alternatives = c.menu && !existsHere ? filterStores(state, fallback) : [];
      result = alternatives.length ? await results(state, fallback, alternatives, ai, lead, limit)
        : budgetAlternatives(state, existsHere || !c.menu ? x : fallback, lead, limit) || zero(state, x, new Set(), lead);
      if (!c.menu && !existsHere) {
        result.reply.text += ' 어떤 종류의 음식으로 대안을 찾아볼까요?';
        result.reply.buttons = [...menuButtons(), ...result.reply.buttons];
      }
    } else if (!left.length) {
      const { taste, franchise, menu } = state.cond;
      const cheeseLead = taste.includes(EXTRA_CHEESE)
        ? `${areaLabel(state)}에서 치즈 양이 많다는 근거가 있고 현재 조건에 맞는 ${franchise === 'exclude' ? '비프랜차이즈 ' : ''}${menu || '메뉴'}를 찾지 못했어요.` : undefined;
      result = budgetAlternatives(state, x, cheeseLead, limit) || zero(state, x, new Set(), cheeseLead);
    } else {
      result = await results(state, x, left, ai, '', limit);
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
      if (canSearch(state)) return fromStep2(state, ai);
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
      if (!canSearch(state)) return out(state, { text: '어떤 음식을 찾으세요?', buttons: menuButtons() });
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
      const rules = ruleParse(t, state.cond);
      if (rules.franchise === undefined && franchiseQuestion.test(t)) return answerFranchiseQuestion(state, t);
      const confirmation = confirmRecommendation(state, t);
      if (confirmation) return confirmation;
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
      const continuation = t.match(moreRequest);
      if (canSearch(state) && !area && !Object.keys(rules).length && continuation) {
        if (state.cond.store && state.cond.menu && /^다른\s*(?:데|대|곳|가게|집)(?:도|는|은|을|를|[?!.\s]|$)/.test(t) && !continuation[1]) {
          const seen = state.seen;
          setCond(state, { store: null });
          state.seen = seen;
        }
        state.excludeSeen = true;
        state.pending = null;
        const count = Number(continuation[1]) || (/전부|모두/.test(t) ? 36 : 3);
        return fromStep2(state, ai, false, Math.min(count, 36));
      }
      const foodText = t.split(/말고|대신(?:에)?|아니라/).at(-1);
      const foods = readFoodList(foodText);
      if (!state.dong && (foods.length > 1 || isGroupMeal({ ...state.cond, ...rules }))) state.dong = ALL_REGIONS;
      if (!state.dong) return out(state, { text: '먼저 지역을 골라 주세요. 지역 이름을 입력하거나 “지역 상관없어”라고 입력해도 돼요.' });
      if (rules.franchise !== undefined && !area && canSearch(state) &&
          (Object.keys(rules).length === 1 || (rules.menu === state.cond.menu && !rules.dish && !rules.taste && Object.keys(rules).length === 3))) {
        const store = state.cond.store && stores.find(store => matchesStore(state.cond.store, store));
        const clearStore = store && ((rules.franchise === 'exclude' && store.franchise) || (rules.franchise === 'only' && !store.franchise));
        setCond(state, { franchise: rules.franchise, ...(clearStore ? { store: null } : {}) });
        return fromStep2(state, ai);
      }
      if (foods.length > 1) {
        setCond(state, { ...rules, menu: null, dish: null, store: null, foods });
        return fromStep2(state, ai);
      }
      const optionIndex = state.pending?.findIndex(o => compact(t) === compact(o.label));
      if (state.pending && (noPreference || optionIndex >= 0) && !areaChanged) {
        return handle(state, { type: 'option', index: noPreference ? -1 : optionIndex }, ai);
      }
      if (canSearch(state) && state.lastMin > 1 && !area && rules.menu === undefined && rules.budget === undefined &&
        /^(?:더\s*(?:싸게|사게|저렴하게|싼\s*걸로)|(?:가격|예산)\s*(?:을)?\s*(?:좀|조금|더)?\s*낮춰(?:\s*줘)?)[?! .]*$/.test(ft)) {
        setCond(state, { budget: state.lastMin, budget_unit: 'total', price_pref: 'none', budget_under: true });
        return fromStep2(state, ai);
      }
      if (area && !Object.keys(rules).length && /지역|동네|서울|구|동/.test(t) && !/먹고|찾아|음식|메뉴/.test(t)) {
        return canSearch(state) ? fromStep2(state, ai) : out(state, { text: `${areaLabel(state)}에서 어떤 음식을 찾으세요?`, buttons: menuButtons() });
      }

      const newText = t.split(/말고|대신(?:에)?|아니라/).at(-1).trim() || t;
      const named = findStoreName(newText);
      const storeQuery = (cheeseRequest.test(newText) && rules.menu && !rules.dish ? null : named) || newText.match(/[“"‘']([^”"’']{2,60})[”"’']\s*(?:가게|매장|식당)/)?.[1] ||
        newText.match(/(?:^|\s)([가-힣A-Za-z0-9·-]{2,40}(?:점|치킨집|식당))\s*(?:은|는|이|가|도)?\s*(?:있|찾|알려|어때|에서)/)?.[1];
      let parsed = {};
      try { parsed = await ai.parse(t, aiParseCond(state.cond)); }
      catch (e) { if (e.message !== 'Gemini unavailable') console.warn('[AI ①] 실패 → 규칙 기반:', e.message); }
      const foodIntent = /먹고|먹을|추천|메뉴|땡겨|당겨|있어|배달|바꿔|찾아|보여/.test(newText);
      const rawDish = foodIntent && typeof parsed.dish === 'string' && compact(parsed.dish).length >= 2 &&
        !cheeseRequest.test(parsed.dish) &&
        !/^(?:너가|네가|니가|당신이|배불리|배부르게|푸짐하게|든든하게|넉넉하게|한끼|한끼식사|식사|음식)$/.test(compact(parsed.dish)) &&
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
          ![next.dish, next.menu, next.store, area?.label].some(v => compact(v) === compact(term)) &&
          !(next.taste?.includes(EXTRA_CHEESE) && compact(term) === '치즈'));
        if (mentioned.length) next.taste = [...new Set([...(next.taste || state.cond.taste), ...mentioned])];
      }
      if (!Object.keys(next).length && !area) {
        return out(state, { text: canSearch(state) ? '바꿀 조건을 확인하지 못했어요. 음식 이름이나 지역, 예산을 말씀해 주세요.' : '어떤 음식을 찾으세요? 음식 이름이나 가게 이름을 말씀해 주세요.', buttons: menuButtons() });
      }
      setCond(state, next);
      if (!canSearch(state)) return out(state, { text: '어떤 음식을 찾으세요?', buttons: menuButtons() });
      return fromStep2(state, ai);
    }
    throw new Error('bad action');
  }

  const aiParseCond = c => ({ menu: c.menu, dish: c.dish, people: c.people, budget: c.budget, budget_unit: c.budget_unit, price_pref: c.price_pref, taste: c.taste, franchise: c.franchise });

  return { handle, regions, categories: CATEGORIES };
}
