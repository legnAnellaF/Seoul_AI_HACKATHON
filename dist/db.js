import { supabaseConfig } from "./supabase-config.js";

const sessionKey = "seoul-delivery-session";
let refreshInFlight;
export const readLocal = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
};
export const saveLocal = (key, value) => localStorage.setItem(key, JSON.stringify(value));
export const session = () => readLocal(sessionKey, null);

async function request(path, { method = "GET", body, token, prefer } = {}) {
  const headers = { apikey: supabaseConfig.publishableKey };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(supabaseConfig.url + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message || data?.msg || data?.error_description || "요청을 처리하지 못했습니다.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function saveSession(data, user = data.user) {
  const expiresAt = data.expires_at || Date.now() / 1000 + Number(data.expires_in || 0);
  const value = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt, user };
  saveLocal(sessionKey, value);
  return value;
}

export async function receiveSession() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("access_token") || !params.has("refresh_token")) return;
  history.replaceState(null, "", location.pathname + location.search);
  const access_token = params.get("access_token");
  const user = await request("/auth/v1/user", { token: access_token });
  saveSession({ access_token, refresh_token: params.get("refresh_token"), expires_at: Number(params.get("expires_at")) }, user);
}

async function authToken() {
  const current = session();
  if (!current || current.expires_at > Date.now() / 1000 + 60) return current?.access_token;
  refreshInFlight ??= request("/auth/v1/token?grant_type=refresh_token", {
    method: "POST", body: { refresh_token: current.refresh_token }
  }).then(data => saveSession(data).access_token).catch(error => {
    if (error.status === 400 || error.status === 401) localStorage.removeItem(sessionKey);
    throw error;
  }).finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

export async function authenticate(email, password, nickname) {
  const callback = location.origin + location.pathname;
  const path = nickname === undefined ? "/auth/v1/token?grant_type=password" : "/auth/v1/signup?redirect_to=" + encodeURIComponent(callback);
  const data = await request(path, { method: "POST", body: { email, password, ...(nickname === undefined ? {} : { data: { nickname } }) } });
  if (data?.access_token) saveSession(data);
  return Boolean(data?.access_token);
}

export async function signOut() {
  const token = await authToken();
  if (token) await request("/auth/v1/logout?scope=local", { method: "POST", token });
  localStorage.removeItem(sessionKey);
}

export async function api(resource, query = {}, options = {}) {
  const params = new URLSearchParams(query);
  return request("/rest/v1/" + resource + (params.size ? "?" + params : ""), { ...options, token: await authToken() });
}
export const rpc = (name, body) => api("rpc/" + name, {}, { method: "POST", body });
export const won = value => new Intl.NumberFormat("ko-KR").format(value) + "원";
export const date = value => new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul"
}).format(new Date(value));
export const statusLabels = { pending: "접수 대기", accepted: "조리 중", delivering: "배달 중", completed: "배달 완료", rejected: "주문 거절" };
export const esc = (value = "") => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

export function authForm(owner = false) {
  return `<form id="auth-form" class="stack">
    <label>이메일<input name="email" type="email" required autocomplete="email"></label>
    <label>비밀번호<input name="password" type="password" required minlength="6" autocomplete="current-password"></label>
    ${owner ? "" : '<label>닉네임 <small>가입 시 입력</small><input name="nickname" maxlength="30" autocomplete="nickname"></label>'}
    <button class="primary" type="submit" value="login">로그인</button>
    ${owner ? "" : '<button class="secondary" type="submit" value="signup">회원가입</button>'}
  </form>`;
}

export async function submitAuth(event) {
  const fields = new FormData(event.target);
  const signup = event.submitter?.value === "signup";
  const nickname = signup ? String(fields.get("nickname")).trim() : undefined;
  if (signup && !nickname) throw new Error("닉네임을 입력해 주세요.");
  return authenticate(fields.get("email").trim(), fields.get("password"), nickname);
}
