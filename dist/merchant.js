import { api, authForm, date, esc, receiveSession, rpc, session, signOut, statusLabels, submitAuth, won } from "./db.js";

const storeId = "alley-chicken";
const headings = { home: "홈", orders: "주문 내역", menu: "메뉴 관리", sales: "매출", reviews: "리뷰 관리" };
const content = document.querySelector("#dashboard-content");
const message = document.querySelector("#merchant-message");
let tab = "home";
let allowed = false;
let orders = [];
let menus = [];
let editing;
let page = 0;
let orderFilter = "";
let monthFilter = "";
let busy = false;
const pageSize = 20;
const dayKey = value => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
const empty = text => '<p class="empty">' + esc(text) + '</p>';
const action = (label, mode, value = "", style = "secondary") => '<button class="' + style + '" data-mode="' + mode + '" data-value="' + esc(value) + '">' + esc(label) + '</button>';

async function load() {
  allowed = Boolean(session() && await rpc("manages_delivery_store", { target: storeId }));
  if (!allowed) { orders = []; menus = []; return; }
  [orders, menus] = await Promise.all([
    api("delivery_orders", { select: "*,delivery_reviews(rating,body,reply,created_at)", store_id: "eq." + storeId, order: "created_at.desc" }),
    api("menu_items", { store_id: "eq." + storeId, order: "id" })
  ]);
}

function controls(order) {
  const transitions = {
    pending: [["접수하기", "accepted", "primary"], ["거절", "rejected", "secondary"]],
    accepted: [["배달 시작", "delivering", "primary"]],
    delivering: [["배달 완료", "completed", "primary"]]
  };
  return (transitions[order.status] || []).map(([label, status, style]) => action(label, "status", order.id + "/" + status, style)).join("");
}

function orderTable(rows) {
  if (!rows.length) return empty("해당하는 주문이 없습니다.");
  return '<div class="table-wrap"><table><thead><tr><th>주문 시각</th><th>메뉴·배달 주소</th><th>결제 예정 금액</th><th>상태</th><th>주문 처리</th></tr></thead><tbody>' +
    rows.map(order => '<tr><td>' + date(order.created_at) + '<small>#' + order.id.slice(0, 8) +
    '</small></td><td><strong>' + order.items.map(item => esc(item.name) + " × " + item.quantity).join(" · ") +
    '</strong><small>' + esc(order.address) + '</small></td><td>' + won(order.total) +
    '</td><td><span class="label">' + statusLabels[order.status] + '</span></td><td><div class="row-actions">' + controls(order) + '</div></td></tr>').join("") + '</tbody></table></div>';
}

function salesFor(predicate) {
  const rows = orders.filter(order => order.status === "completed" && order.completed_at && predicate(dayKey(order.completed_at)));
  const sum = rows.reduce((total, order) => total + order.subtotal, 0);
  return { rows, sum };
}

function home() {
  const pending = orders.filter(order => order.status === "pending");
  const delivering = orders.filter(order => ["accepted", "delivering"].includes(order.status));
  const today = salesFor(day => day === dayKey(Date.now()));
  return '<div class="dash-stats"><article><span>접수 대기</span><strong>' + pending.length +
    '건</strong></article><article><span>조리·배달 중</span><strong>' + delivering.length +
    '건</strong></article><article><span>오늘 메뉴 매출</span><strong>' + won(today.sum) +
    '</strong></article></div><section class="panel"><h2>신규 주문</h2>' + orderTable(pending) +
    '</section><section class="panel"><h2>배달 현황</h2>' + orderTable(delivering) + '</section>';
}

function history() {
  const rows = orderFilter ? orders.filter(order => order.status === orderFilter) : orders;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  page = Math.min(page, pages - 1);
  return '<section class="panel"><div class="spread"><h2>전체 주문 ' + rows.length + '건</h2><label>상태 <select id="order-filter">' +
    '<option value="">전체</option>' + Object.entries(statusLabels).map(([key, label]) => '<option value="' + key + '"' +
      (orderFilter === key ? " selected" : "") + '>' + label + '</option>').join("") + '</select></label></div>' +
    orderTable(rows.slice(page * pageSize, (page + 1) * pageSize)) + '<div class="pager">' +
    (page ? action("이전", "page", page - 1) : '') + '<span>' + (page + 1) + ' / ' + pages + '</span>' +
    (page + 1 < pages ? action("다음", "page", page + 1) : '') + '</div></section>';
}

function menu() {
  const item = menus.find(row => row.id === editing);
  return '<section class="panel"><h2>' + (item ? "메뉴 수정" : "메뉴 등록") + '</h2><form id="menu-form" class="menu-form">' +
    '<label>메뉴명<input name="name" required maxlength="80" value="' + esc(item?.name) + '"></label>' +
    '<label>가격 (원)<input name="price" type="number" min="1" max="1000000" required value="' + esc(item?.price) + '"></label>' +
    '<label>설명<input name="description" maxlength="240" value="' + esc(item?.description) + '"></label>' +
    '<label class="check"><input type="checkbox" name="available"' + (item?.available !== false ? " checked" : "") + '>판매 중</label>' +
    '<button type="submit" class="primary">' + (item ? "수정 저장" : "메뉴 등록") + '</button>' +
    (item ? action("취소", "cancel-edit") : '') + '</form></section><section class="panel"><h2>메뉴 목록</h2>' +
    (menus.length ? '<div class="table-wrap"><table><thead><tr><th>메뉴명</th><th>가격</th><th>판매 상태</th><th>관리</th></tr></thead><tbody>' +
      menus.map(row => '<tr><td><strong>' + esc(row.name) + '</strong><small>' + esc(row.description) +
      '</small></td><td>' + won(row.price) + '</td><td>' + (row.available ? "판매 중" : "품절") +
      '</td><td><div class="row-actions">' + action("수정", "edit", row.id) + action("삭제", "delete", row.id) +
      '</div></td></tr>').join("") + '</tbody></table></div>' : empty("등록된 메뉴가 없습니다.")) + '</section>';
}

function sales() {
  const today = dayKey(Date.now());
  const month = monthFilter || today.slice(0, 7);
  const daily = salesFor(day => day === today);
  const monthly = salesFor(day => day.startsWith(month));
  const sold = new Map();
  for (const order of monthly.rows) {
    for (const item of order.items) {
      const key = item.id + ":" + item.name;
      const row = sold.get(key) || { name: item.name, quantity: 0, revenue: 0 };
      row.quantity += item.quantity;
      row.revenue += item.price * item.quantity;
      sold.set(key, row);
    }
  }
  return '<div class="dash-stats"><article><span>오늘 메뉴 매출</span><strong>' + won(daily.sum) + '</strong></article><article><span>' +
    esc(month) + ' 메뉴 매출</span><strong>' + won(monthly.sum) + '</strong></article><article><span>이번 조회 월 완료 주문</span><strong>' +
    monthly.rows.length + '건</strong></article></div><section class="panel"><div class="spread"><h2>월별 판매 메뉴</h2><label>조회 월 <input id="sales-month" type="month" value="' +
    esc(month) + '"></label></div><p class="muted">한국 시간 배달 완료일 기준 · 배달비 제외</p>' +
    (sold.size ? '<div class="table-wrap"><table><thead><tr><th>메뉴</th><th>판매 수량</th><th>매출</th></tr></thead><tbody>' +
      [...sold.values()].sort((a, b) => b.revenue - a.revenue).map(row =>
        '<tr><td>' + esc(row.name) + '</td><td>' + row.quantity + '개</td><td>' + won(row.revenue) + '</td></tr>').join("") +
      '</tbody></table></div>' : empty("해당 월에 배달 완료된 주문이 없습니다.")) + '</section>';
}

function reviews() {
  const rows = orders.filter(order => order.delivery_reviews).map(order => ({ ...order.delivery_reviews, id: order.id, items: order.items }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return '<section class="panel"><h2>리뷰 ' + rows.length + '건</h2>' +
    (rows.length ? rows.map(review => '<article class="merchant-review"><div class="spread"><strong>★ ' + review.rating +
      ' / 5</strong><small>' + date(review.created_at) + '</small></div><small>' + review.items.map(item => esc(item.name)).join(" · ") +
      '</small><p>' + esc(review.body) + '</p><form class="reply-form stack" data-review="' + review.id +
      '"><label>사장님 답변<textarea name="reply" rows="2" required maxlength="800">' + esc(review.reply) +
      '</textarea></label><button class="primary" type="submit">' + (review.reply ? "답변 수정" : "답변 등록") + '</button></form></article>').join("") :
      empty("등록된 리뷰가 없습니다.")) + '</section>';
}

function render() {
  document.querySelector("#dashboard-title").textContent = headings[tab];
  document.querySelector("#dashboard-actions").innerHTML = session() ?
    (allowed ? action("새로고침", "refresh") : "") + action("로그아웃", "logout") : "";
  document.querySelectorAll("[data-tab]").forEach(node => {
    if (node.dataset.tab === tab) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
  if (!session()) {
    content.innerHTML = '<section class="panel login-panel"><h2>사장님 로그인</h2>' + authForm(true) +
      '<p class="muted">앱 가입이 처음이면 주문자 화면의 마이에서 이메일로 가입해 주세요.</p></section>';
    return;
  }
  if (!allowed) {
    content.innerHTML = '<section class="panel">' + empty("이 계정에는 서초 골목통닭의 관리 권한이 없습니다.") + '</section>';
    return;
  }
  content.innerHTML = ({ home, orders: history, menu, sales, reviews })[tab]();
}

async function run(work, button) {
  if (busy) return;
  busy = true;
  message.textContent = "";
  if (button) button.disabled = true;
  try { await work(); }
  catch (error) { message.textContent = error.message; }
  finally {
    busy = false;
    if (button?.isConnected) button.disabled = false;
  }
}

document.addEventListener("click", event => {
  const control = event.target.closest("[data-tab], [data-mode]");
  if (!control || busy) return;
  if (control.dataset.tab) { tab = control.dataset.tab; render(); return; }
  const { mode, value } = control.dataset;
  void run(async () => {
    if (mode === "logout") { await signOut(); allowed = false; }
    if (mode === "refresh") await load();
    if (mode === "page") page = Number(value);
    if (mode === "edit") editing = Number(value);
    if (mode === "cancel-edit") editing = undefined;
    if (mode === "status") {
      const [target, next_status] = value.split("/");
      await rpc("change_delivery_order", { target, next_status });
      await load();
      message.textContent = "주문 상태를 변경했습니다.";
    }
    if (mode === "delete") {
      if (!window.confirm("이 메뉴를 삭제할까요? 이전 주문 기록에는 메뉴가 남습니다.")) return;
      await api("menu_items", { id: "eq." + value, store_id: "eq." + storeId }, { method: "DELETE" });
      editing = undefined;
      await load();
      message.textContent = "메뉴를 삭제했습니다.";
    }
    render();
    if (mode === "edit") content.querySelector("#menu-form input")?.focus();
  }, control);
});

content.addEventListener("change", event => {
  if (event.target.id === "order-filter") { orderFilter = event.target.value; page = 0; render(); }
  if (event.target.id === "sales-month" && event.target.value) { monthFilter = event.target.value; render(); }
});

content.addEventListener("submit", event => {
  event.preventDefault();
  const form = event.target;
  const raw = new FormData(form);
  void run(async () => {
    if (form.id === "auth-form") {
      await submitAuth(event);
      await load();
    }
    if (form.id === "menu-form") {
      const item = { name: raw.get("name").trim(), description: raw.get("description").trim(), price: Number(raw.get("price")), available: raw.has("available") };
      if (!item.name) throw new Error("메뉴명을 입력해 주세요.");
      await api("menu_items", editing ? { id: "eq." + editing, store_id: "eq." + storeId } : {}, {
        method: editing ? "PATCH" : "POST",
        body: editing ? item : { ...item, store_id: storeId }
      });
      editing = undefined;
      await load();
      message.textContent = "메뉴를 저장했습니다.";
    }
    if (form.classList.contains("reply-form")) {
      const reply = raw.get("reply").trim();
      if (!reply) throw new Error("답변 내용을 입력해 주세요.");
      await api("delivery_reviews", { order_id: "eq." + form.dataset.review }, { method: "PATCH", body: { reply } });
      await load();
      message.textContent = "답변을 저장했습니다.";
    }
    render();
  }, event.submitter);
});

try { await receiveSession(); await load(); render(); }
catch (error) { render(); message.textContent = error.message; }
