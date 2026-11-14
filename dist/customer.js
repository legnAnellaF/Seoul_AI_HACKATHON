import { api, authForm, date, esc, readLocal, receiveSession, rpc, saveLocal, session, signOut, statusLabels, submitAuth, won } from "./db.js";

const screen = document.querySelector("#screen");
const bar = document.querySelector("#checkout-bar");
const message = document.querySelector("#customer-message");
const icons = { chicken: 3, dessert: 4, pizza: 5, korean: 6, burger: 7, chinese: 8, more: 9 };
const glyphs = { japanese: "🍣", western: "🍝", nearby: "📍" };
const state = { categories: [], stores: [], menus: [], query: "", addressQuery: "" };
let route = { name: "home" };
let previous = [];
let busy = false;
let messageTimer;

const storageKey = (name, scope = session()?.user?.id ?? "guest") => "seoul-" + scope + "-" + name;
const stored = (name, fallback) => readLocal(storageKey(name), fallback);
const write = (name, value) => saveLocal(storageKey(name), value);
const cart = () => stored("cart", []);
const favorites = () => stored("favorites", []);
const addresses = () => stored("addresses", []);
const activeAddress = () => addresses().find(item => item.id === stored("address", null));
const getStore = id => state.stores.find(store => store.id === id);
const menusFor = id => state.menus.filter(item => item.store_id === id);
const itemCount = rows => rows.reduce((total, item) => total + item.quantity, 0);
const cost = rows => rows.reduce((total, item) => total + item.price * item.quantity, 0);
const empty = text => '<p class="empty">' + esc(text) + '</p>';
const icon = (label, symbol, action) => '<button class="icon-button" aria-label="' + label + '" data-act="' + action + '">' + symbol + '</button>';
const button = (label, action, value = "", className = "secondary") =>
  '<button class="' + className + '" data-act="' + action + '" data-value="' + esc(value) + '">' + esc(label) + '</button>';
const top = (title, tools = "") => '<header class="screen-header">' + icon("뒤로 가기", "←", "back") + '<h1>' + esc(title) + '</h1>' + tools + '</header>';
const addressText = address => [address.road, address.detail].filter(Boolean).join(" ");

function notify(text) {
  clearTimeout(messageTimer);
  message.textContent = text;
  message.classList.add("visible");
  messageTimer = setTimeout(() => message.classList.remove("visible"), 4000);
}

function open(name, value, tab = false) {
  if (tab) previous = [];
  else previous.push(route);
  route = { name, value };
  if (name === "search") state.query = "";
  if (name === "addresses") state.addressQuery = "";
  render(true);
  if (name === "search") screen.querySelector("#search-query")?.focus();
  if (["orders", "notifications", "my-reviews"].includes(name)) void fetchActivity();
}

function back() {
  route = previous.pop() ?? { name: "home" };
  render(true);
}

async function catalog() {
  const [categories, stores, menus] = await Promise.all([
    api("categories", { order: "position" }),
    api("stores", { order: "name" }),
    api("menu_items", { available: "eq.true", order: "id" }),
  ]);
  state.categories = categories;
  state.stores = stores;
  state.menus = menus.filter(item => stores.some(store => store.id === item.store_id));
}

function categoryImage(id) {
  return icons[id] === undefined
    ? '<span class="cat-glyph" aria-hidden="true">' + (glyphs[id] || "▦") + '</span>'
    : '<img src="assets/cat-' + icons[id] + '.webp" alt="">';
}

function home() {
  const cats = [...state.categories, { id: "nearby", name: "주변 가게" }, { id: "more", name: "더보기" }];
  const shortcuts = ["무료배달", "온누리/지역화폐", "포장/매장식사", "전국 휴게소"];
  const address = activeAddress();
  return '<section class="home-screen"><header class="home-head">' +
    '<button class="address-button" data-act="addresses"><span class="pin" aria-hidden="true"></span><strong>' +
    esc(address ? address.road : "배달 주소를 등록해 주세요") + '</strong><span aria-hidden="true">⌄</span></button>' +
    '<button class="icon-button image-icon" aria-label="알림 목록" data-act="notifications"><img src="assets/bell.webp" alt=""></button>' +
    '<button class="icon-button image-icon cart-icon" aria-label="장바구니" data-act="cart"><img src="assets/cart.webp" alt="">' +
    (cart().length ? '<span class="count">' + itemCount(cart()) + '</span>' : '') + '</button></header>' +
    '<button class="home-search" data-act="search"><span class="glass" aria-hidden="true"></span>음식이나 가게를 검색해 보세요</button>' +
    '<section class="category-grid" aria-label="음식 카테고리">' +
    cats.map(cat => '<button data-act="category" data-value="' + esc(cat.id) + '">' + categoryImage(cat.id) + '<span>' + esc(cat.name) + '</span></button>').join("") + '</section>' +
    '<section class="shortcut-grid" aria-label="서비스 바로가기">' +
    shortcuts.map((label, index) => '<button disabled><img src="assets/shortcut-' + index + '.webp" alt="">' + label + '</button>').join("") +
    '</section></section>';
}

function addressList() {
  return top("주소 설정", icon("주소 추가", "✎", "address-new")) +
    '<div class="pane stack"><label class="search-field"><span class="glass" aria-hidden="true"></span>' +
    '<input type="search" id="address-query" aria-label="저장한 주소 검색" placeholder="도로명, 건물명, 지번으로 검색" value="' + esc(state.addressQuery) + '"></label>' +
    button("⌖ 현재 위치로 찾기", "location") + button("⌂ 우리집 추가", "address-new", "우리집", "plain left") +
    '</div><div id="address-results" class="address-results">' + addressResults() + '</div>';
}

function addressResults() {
  const list = addresses();
  if (!list.length) return empty("등록된 주소가 없습니다. 오른쪽 위 연필 버튼으로 배달 주소를 등록해 주세요.");
  const matches = list.filter(item => (addressText(item) + " " + item.label).includes(state.addressQuery.trim()));
  return matches.map(item => {
    const selected = item.id === activeAddress()?.id;
    return '<button class="address-row" data-act="address-select" data-value="' + esc(item.id) + '"><span class="pin" aria-hidden="true"></span><span><strong>' +
      esc(item.label || item.road) + '</strong>' + (selected ? ' <small class="selected-address">현재 설정된 주소</small>' : '') +
      '<span>' + esc(addressText(item)) + '</span>' + (item.note ? '<small>' + esc(item.note) + '</small>' : '') +
      '</span><span aria-hidden="true">' + (selected ? "✓" : "") + '</span></button>';
  }).join("") || empty("일치하는 주소가 없습니다.");
}

function addressForm() {
  return top("주소 등록") + '<form id="address-form" class="pane stack">' +
    '<label>별칭<input name="label" maxlength="30" placeholder="우리집" value="' + esc(route.value || "") + '"></label>' +
    '<label>도로명 또는 지번 주소<input name="road" required minlength="3" maxlength="110" placeholder="서울 서초구 …"></label>' +
    '<label>상세 주소<input name="detail" maxlength="55" placeholder="동, 호수"></label>' +
    '<label>배달 요청사항<input name="note" maxlength="80" placeholder="문 앞에 놓아 주세요"></label>' +
    '<button type="submit" class="primary">주소 저장</button></form>';
}

function heart(id) {
  const liked = favorites().includes(id);
  return '<button data-act="heart" data-value="' + esc(id) + '" class="heart ' + (liked ? "liked" : "") +
    '" aria-label="' + (liked ? "찜 취소" : "찜하기") + '" aria-pressed="' + liked + '">' + (liked ? "♥" : "♡") + '</button>';
}

function storeList(list) {
  if (!list.length) return empty("표시할 가게가 없습니다.");
  return '<div class="store-list">' + list.map(store =>
    '<article class="store-card"><button class="store-open" data-act="store" data-value="' + esc(store.id) + '">' +
    '<div class="media-placeholder" aria-hidden="true"></div><span class="store-card-text"><strong>' + esc(store.name) +
    '</strong><span>' + esc(store.district) + ' · ' + esc(store.delivery_time) + '</span><small>최소주문 ' + won(store.minimum) + ' · 배달비 ' + won(store.delivery_fee) +
    '</small></span></button>' + heart(store.id) + '</article>').join("") + '</div>';
}

function category() {
  const id = route.value;
  const title = state.categories.find(item => item.id === id)?.name || (id === "nearby" ? "주변 가게" : "더보기");
  const area = activeAddress()?.road;
  let list = state.stores;
  if (id === "nearby" && area) {
    const district = area.match(/(?:^|\s)([가-힣]+구)(?:\s|$)/)?.[1];
    list = district ? list.filter(store => store.district.includes(district)) : [];
  } else if (id !== "nearby" && id !== "more") list = list.filter(store => store.category_id === id);
  return top(title, icon("장바구니", "🛒", "cart")) +
    (id === "more" ? '<div class="pills">' + state.categories.map(cat => button(cat.name, "category", cat.id)).join("") + '</div>' : "") + storeList(list);
}

function searchResults() {
  const q = state.query.trim().toLocaleLowerCase("ko");
  const found = state.stores.filter(store => !q || [store.name, store.district, state.categories.find(cat => cat.id === store.category_id)?.name,
    ...menusFor(store.id).map(menu => menu.name)].some(text => text?.toLocaleLowerCase("ko").includes(q)));
  return found.length ? storeList(found) : empty("검색 조건과 일치하는 가게나 메뉴가 없습니다.");
}

function search() {
  return top("검색") + '<div class="pane"><label class="search-field"><span class="glass" aria-hidden="true"></span><input id="search-query" type="search" aria-label="가게 또는 메뉴 검색" placeholder="가게 또는 메뉴 이름" value="' +
    esc(state.query) + '"></label></div><div id="search-results">' + searchResults() + '</div>';
}

function detail() {
  const store = getStore(route.value);
  if (!store) return top("가게") + empty("현재 표시할 수 없는 가게입니다.");
  const items = menusFor(store.id);
  return top(store.name, icon("장바구니", "🛒", "cart")) +
    '<div class="media-placeholder store-hero" aria-hidden="true"></div><section class="pane store-detail">' +
    '<div class="spread"><h2>' + esc(store.name) + '</h2>' + heart(store.id) + '</div><p class="muted">' + esc(store.description) +
    '</p><div class="pills"><span class="active-pill">배달</span></div><dl class="delivery-details"><div><dt>최소주문</dt><dd>' +
    won(store.minimum) + '</dd></div><div><dt>가게배달</dt><dd>' + esc(store.delivery_time) + ' · 배달비 ' + won(store.delivery_fee) +
    '</dd></div><div><dt>가게 위치</dt><dd>' + esc(store.district) + '</dd></div></dl></section>' +
    '<section class="menu-section"><div class="pane"><span class="active-pill">전체 메뉴</span><h2>메뉴</h2></div>' +
    (items.length ? items.map(item => {
      const quantity = cart().find(row => row.id === item.id)?.quantity;
      return '<article class="menu-row"><div><h3>' + esc(item.name) + '</h3><p class="muted">' + esc(item.description) +
        '</p><strong>' + won(item.price) + '</strong>' + (quantity ? '<small class="in-cart">담은 수량 ' + quantity + '</small>' : '') +
        '</div><div class="menu-image media-placeholder"><button class="menu-add" aria-label="' + esc(item.name + " 담기") +
        '" data-act="add" data-value="' + item.id + '">+</button></div></article>';
    }).join("") : empty("등록된 메뉴가 없습니다.")) + '</section>';
}

function basket() {
  const rows = cart();
  if (!rows.length) return top("장바구니") + empty("장바구니에 담긴 메뉴가 없습니다.");
  const groups = [...new Set(rows.map(row => row.store_id))];
  const selected = rows.filter(row => row.selected);
  return top("장바구니") + '<section class="pane stack">' + groups.map(id => {
    const store = getStore(id);
    return '<article class="basket-group"><h2>' + esc(store?.name || rows.find(row => row.store_id === id).store_name) + '</h2>' +
      rows.filter(row => row.store_id === id).map(item => '<div class="basket-item"><label><input type="checkbox" data-select="' + item.id + '"' +
        (item.selected ? " checked" : "") + '><span><strong>' + esc(item.name) + '</strong><small>' + won(item.price * item.quantity) +
        '</small></span></label><div class="quantity">' + button("−", "minus", item.id, "mini") + item.quantity +
        button("+", "plus", item.id, "mini") + '</div>' + button("삭제", "remove", item.id, "plain muted") + '</div>').join("") +
      '<p class="muted">배달비 ' + (store ? won(store.delivery_fee) : "확인 필요") + '</p></article>';
  }).join("") + '<div class="spread"><strong>선택한 메뉴 금액</strong><strong>' + won(cost(selected)) + '</strong></div>' +
  '<div class="spread"><span>배달 주소</span>' + button(activeAddress()?.road || "주소 등록", "addresses") + '</div></section>';
}

function account() {
  const user = session()?.user;
  return '<header class="screen-header"><h1>마이</h1></header><section class="pane stack">' +
    (user ? '<h2>' + esc(user.user_metadata?.nickname || user.email?.split("@")[0]) + ' 님</h2>' + button("로그아웃", "logout") : '<h2>로그인</h2>' + authForm()) +
    '<div class="account-links">' + button("주소 관리 ›", "addresses", "", "plain left") +
    button("주문 관리 ›", "orders", "", "plain left") + button("리뷰 관리 ›", "my-reviews", "", "plain left") +
    '<a class="plain left" href="merchant.html">사장님 화면 ↗</a></div></section>';
}

function activity(name) {
  const titles = { orders: "주문 내역", notifications: "알림", "my-reviews": "내 리뷰" };
  const header = name === "orders" ? '<header class="screen-header"><h1>주문 내역</h1>' + icon("새로고침", "↻", "refresh") + '</header>' :
    top(titles[name], icon("새로고침", "↻", "refresh"));
  if (!session()) return header + '<div class="pane stack">' + empty("로그인하면 확인할 수 있습니다.") + button("로그인하기", "my", "", "primary") + '</div>';
  if (state.activityError) return header + empty(state.activityError);
  if (!state.orders) return header + empty("불러오는 중…");
  const rows = name === "my-reviews" ? state.orders.filter(order => order.delivery_reviews) : state.orders;
  if (!rows.length) return header + empty(name === "notifications" ? "새 알림이 없습니다." : "아직 내역이 없습니다.");
  return header + '<section class="pane stack">' + rows.map(order => {
    const review = order.delivery_reviews;
    if (name === "notifications") return '<article class="order-card"><strong>' + esc(order.store_name) + ' · ' + statusLabels[order.status] +
      '</strong><small>' + date(order.completed_at || order.created_at) + '</small></article>';
    const list = order.items.map(item => esc(item.name) + " × " + item.quantity).join(" · ");
    return '<article class="order-card"><div class="spread"><small>' + date(order.created_at) + '</small><span class="label">' +
      statusLabels[order.status] + '</span></div><h2>' + esc(order.store_name) + '</h2><p>' + list + ' · ' + won(order.total) + '</p>' +
      (review ? '<p class="review-text">★ ' + review.rating + ' · ' + esc(review.body) +
        (review.reply ? '<small>사장님 답변 · ' + esc(review.reply) + '</small>' : '') + '</p>' :
        order.status === "completed" ? button("리뷰 쓰기", "review", order.id) : '') + '</article>';
  }).join("") + '</section>';
}

async function fetchActivity() {
  const userId = session()?.user?.id;
  if (!userId) return;
  state.activityError = "";
  try {
    const rows = await api("delivery_orders", {
      select: "*,delivery_reviews(rating,body,reply)", customer_id: "eq." + userId, order: "created_at.desc"
    });
    if (session()?.user?.id === userId) state.orders = rows;
  } catch (error) { state.activityError = error.message; }
  if (["orders", "notifications", "my-reviews"].includes(route.name)) render();
}

function reviewForm() {
  return top("리뷰 작성") + '<form id="review-form" class="pane stack"><label>별점<select name="rating">' +
    [5, 4, 3, 2, 1].map(n => '<option value="' + n + '">' + n + '점</option>').join("") +
    '</select></label><label>리뷰<textarea name="body" required maxlength="800" rows="5"></textarea></label>' +
    '<button class="primary" type="submit">리뷰 등록</button></form>';
}

const views = {
  home, addresses: addressList, "address-new": addressForm, category, search,
  store: detail, cart: basket, my: account, review: reviewForm,
  favorites: () => '<header class="screen-header"><h1>찜</h1></header>' + storeList(state.stores.filter(store => favorites().includes(store.id))),
  orders: () => activity("orders"), notifications: () => activity("notifications"), "my-reviews": () => activity("my-reviews"),
};

function render(reset = false) {
  const scroll = reset ? 0 : screen.scrollTop;
  screen.classList.toggle("on-home", route.name === "home");
  screen.innerHTML = views[route.name]();
  screen.scrollTop = scroll;
  const tab = ["home", "favorites", "orders", "my"].includes(route.name) ? route.name : previous.find(item => ["home", "favorites", "orders", "my"].includes(item.name))?.name;
  document.querySelectorAll("[data-go]").forEach(node => {
    if (node.dataset.go === tab) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
  const rows = route.name === "store" ? cart().filter(item => item.store_id === route.value) :
    route.name === "cart" ? cart().filter(item => item.selected) : [];
  const fee = route.name === "cart" ? [...new Set(rows.map(item => item.store_id))].reduce((sum, id) => sum + (getStore(id)?.delivery_fee || 0), 0) : 0;
  bar.innerHTML = rows.length ? '<button class="primary checkout-button" data-act="' + (route.name === "store" ? "cart" : "checkout") +
    '"><span class="checkout-count">' + itemCount(rows) + '</span><strong>' + won(cost(rows) + fee) + ' 주문하기</strong></button>' : "";
}

function updateCart(id, change) {
  const rows = cart();
  const row = rows.find(item => item.id === id);
  if (change === "remove" || (change === "minus" && row?.quantity === 1)) write("cart", rows.filter(item => item.id !== id));
  else if (row) {
    if (change !== "minus" && row.quantity >= 20) return notify("메뉴당 최대 20개까지 담을 수 있습니다.");
    row.quantity += change === "minus" ? -1 : 1;
    if (change === "add") row.selected = true;
    write("cart", rows);
  } else {
    const item = state.menus.find(menu => menu.id === id);
    if (!item) return;
    const store = getStore(item.store_id);
    write("cart", [...rows, { ...item, store_name: store.name, quantity: 1, selected: true }]);
  }
  render();
  if (change === "add") {
    screen.querySelector('[data-act="add"][data-value="' + id + '"]')?.focus({ preventScroll: true });
    notify("장바구니에 담았습니다.");
  }
}

async function checkout() {
  if (!session()) { open("my"); return notify("주문하려면 로그인해 주세요."); }
  const address = activeAddress();
  if (!address) { open("addresses"); return notify("배달 주소를 등록하거나 선택해 주세요."); }
  const rows = cart().filter(row => row.selected);
  if (!rows.length) return;
  const idList = [...new Set(rows.map(row => row.store_id))];
  if (idList.length !== 1) throw new Error("한 번에 한 가게의 메뉴만 선택해 주세요.");
  const selected = rows.map(({ id, quantity }) => ({ id, quantity }));
  const payload = { target: idList[0], selections: selected, delivery_address: [addressText(address), address.note].filter(Boolean).join(" / ") };
  const signature = JSON.stringify(payload);
  const attempt = stored("checkout-attempt", {});
  const key = attempt.signature === signature ? attempt.key : crypto.randomUUID();
  write("checkout-attempt", { signature, key });
  await rpc("place_delivery_order", { ...payload, retry_key: key });
  write("cart", cart().filter(item => !rows.some(row => row.id === item.id)));
  write("checkout-attempt", {});
  state.orders = undefined;
  open("orders", undefined, true);
  notify("주문을 접수했습니다.");
}

const actions = {
  back, checkout, refresh: fetchActivity,
  heart(id) {
    const values = favorites();
    write("favorites", values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
    render();
    screen.querySelector('[data-act="heart"][data-value="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true });
  },
  "address-select"(id) {
    write("address", id);
    back();
    notify("배달 주소를 변경했습니다.");
  },
  location() {
    if (!navigator.geolocation) return notify("현재 위치를 사용할 수 없습니다. 주소를 직접 입력해 주세요.");
    navigator.geolocation.getCurrentPosition(
      () => { open("address-new"); notify("현재 주소를 도로명 또는 지번으로 입력해 주세요."); },
      () => notify("위치를 확인하지 못했습니다. 주소를 직접 입력해 주세요."),
      { timeout: 6000 }
    );
  },
  async logout() {
    await signOut();
    state.orders = undefined;
    render();
    notify("로그아웃했습니다.");
  }
};
for (const name of ["add", "plus", "minus", "remove"]) actions[name] = id => updateCart(Number(id), name);

async function run(task, control) {
  if (busy) return;
  busy = true;
  if (control) control.disabled = true;
  try { await task(); }
  catch (error) { notify(error.message); }
  finally {
    busy = false;
    if (control?.isConnected) control.disabled = false;
  }
}

document.addEventListener("click", event => {
  const control = event.target.closest("[data-act], [data-go]");
  if (!control || busy) return;
  if (control.dataset.go) open(control.dataset.go, undefined, true);
  else {
    const { act, value } = control.dataset;
    if (act in actions) void run(() => actions[act](value), control);
    else if (act in views) open(act, value);
  }
});

screen.addEventListener("input", event => {
  if (event.target.id === "search-query") {
    state.query = event.target.value;
    screen.querySelector("#search-results").innerHTML = searchResults();
  }
  if (event.target.id === "address-query") {
    state.addressQuery = event.target.value;
    screen.querySelector("#address-results").innerHTML = addressResults();
  }
});

screen.addEventListener("change", event => {
  if (!event.target.matches("[data-select]")) return;
  const id = Number(event.target.dataset.select);
  write("cart", cart().map(item => item.id === id ? { ...item, selected: event.target.checked } : item));
  render();
  screen.querySelector('[data-select="' + id + '"]')?.focus({ preventScroll: true });
});

screen.addEventListener("submit", event => {
  event.preventDefault();
  void run(async () => {
    const form = event.target;
    const values = Object.fromEntries(new FormData(form));
    if (form.id === "address-form") {
      const item = { id: crypto.randomUUID(), ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])) };
      if (item.road.length < 3) throw new Error("도로명 또는 지번 주소를 입력해 주세요.");
      write("addresses", [...addresses(), item]);
      write("address", item.id);
      back();
      notify("주소를 저장했습니다.");
    }
    if (form.id === "auth-form") {
      const wasGuest = !session();
      const signedIn = await submitAuth(event);
      if (signedIn && wasGuest) {
        for (const key of ["addresses", "address", "cart", "favorites"]) {
          const guestValue = readLocal(storageKey(key, "guest"), undefined);
          if (guestValue !== undefined && stored(key, undefined) === undefined) write(key, guestValue);
          localStorage.removeItem(storageKey(key, "guest"));
        }
      }
      state.orders = undefined;
      render();
      notify(signedIn ? "로그인했습니다." : "가입 확인 메일에서 이메일 인증을 완료해 주세요.");
    }
    if (form.id === "review-form") {
      await api("delivery_reviews", {}, { method: "POST", body: { order_id: route.value, rating: Number(values.rating), body: values.body.trim() } });
      back();
      await fetchActivity();
      notify("리뷰를 등록했습니다.");
    }
  }, event.submitter);
});

try {
  await receiveSession();
  await catalog();
  if (new URLSearchParams(location.search).get("category") === "chicken") open("category", "chicken");
  else render(true);
} catch (error) {
  render(true);
  notify(error.message);
}
