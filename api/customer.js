import { createHash, randomBytes } from "node:crypto";
import { supabaseConfig } from "../dist/supabase-config.js";

const ACCESS = "__Host-bappilot-access";
const REFRESH = "__Host-bappilot-refresh";
const REFRESH_AGE = 30 * 24 * 60 * 60;
const SITE = "https://seoul-ai-hackathon.vercel.app/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RPC_ACTIONS = new Set(["customer_orders", "customer_favorites", "customer_favorite", "place", "review"]);

function cookie(name, value, age) {
  return name + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + age;
}

function clearSession(res) {
  res.setHeader("Set-Cookie", [cookie(ACCESS, "", 0), cookie(REFRESH, "", 0)]);
}

function setSession(res, data) {
  if (!data?.access_token || !data.refresh_token) throw new Error("Missing session");
  res.setHeader("Set-Cookie", [
    cookie(ACCESS, data.access_token, Number(data.expires_in) || 3600),
    cookie(REFRESH, data.refresh_token, REFRESH_AGE),
  ]);
}

function readSession(req) {
  const cookies = new Map(String(req.headers.cookie || "").split(";").map(part => {
    const item = part.trim();
    const eq = item.indexOf("=");
    return [item.slice(0, eq), item.slice(eq + 1)];
  }));
  return { access: cookies.get(ACCESS), refresh: cookies.get(REFRESH) };
}

function originAllowed(req) {
  const host = req.headers.host;
  if (!host) return false;
  return req.headers.origin === "https://" + host ||
    (/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host) && req.headers.origin === "http://" + host);
}

async function supabase(path, method, body, token) {
  const headers = { apikey: supabaseConfig.publishableKey, "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch(supabaseConfig.url + path, {
    method, headers, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) };
}

const auth = (path, method, body, token) => supabase("/auth/v1/" + path, method, body, token);
const isExpired = reply => reply.status === 401 || reply.status === 403;
const error = (res, status, message, code) => res.status(status).json({ error: message, code });

function profile(user) {
  if (!user?.id || !user.email) throw new Error("Missing account profile");
  const name = user.user_metadata?.name;
  return { id: user.id, email: user.email, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 30) : user.email.split("@")[0] };
}

async function callWithSession(req, res, operation) {
  const session = readSession(req);
  if (session.access) {
    const first = await operation(session.access);
    if (!isExpired(first) || first.data?.code === "42501") return first;
  }
  if (!session.refresh) return { ok: false, status: 401 };
  const renewed = await auth("token?grant_type=refresh_token", "POST", { refresh_token: session.refresh });
  if (!renewed.ok) {
    if (renewed.status >= 500 || renewed.status === 429) throw new Error("Auth refresh temporarily unavailable");
    clearSession(res);
    return { ok: false, status: 401 };
  }
  setSession(res, renewed.data);
  return operation(renewed.data.access_token);
}

function authError(res, reply, registering) {
  const code = reply.data?.error_code;
  if (reply.status === 429) return error(res, 429, "요청이 많아요. 잠시 후 다시 시도해 주세요.");
  if (reply.status >= 500) return error(res, 503, "로그인 서비스에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
  if (code === "email_not_confirmed") return error(res, 400, "가입 확인 이메일의 링크를 연 뒤 로그인해 주세요.");
  if (code === "email_address_not_authorized") return error(res, 400, "이 이메일로 가입 확인 메일을 보낼 수 없어요. 기존 계정으로 로그인해 주세요.");
  if (registering && code === "weak_password") return error(res, 400, "가입 기준에 맞는 비밀번호를 입력해 주세요.");
  return error(res, 400, registering ? "가입 요청을 처리하지 못했어요. 이메일과 비밀번호를 확인해 주세요." : "이메일 또는 비밀번호를 확인해 주세요.");
}

async function signIn(res, credentials, registering) {
  const email = typeof credentials.email === "string" ? credentials.email.trim() : "";
  const password = credentials.password;
  const name = typeof credentials.name === "string" ? credentials.name.trim() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== "string" || !password || Buffer.byteLength(password) > 72 ||
      (registering && (password.length < 8 || !name || name.length > 30))) {
    return error(res, 400, "이메일, 비밀번호와 가입 정보를 확인해 주세요.");
  }
  // Email confirmation uses a code flow. The customer signs in with their password after confirming.
  const challenge = registering ? createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url") : null;
  const result = registering
    ? await auth("signup?redirect_to=" + encodeURIComponent(SITE), "POST", {
        email, password, data: { name }, code_challenge: challenge, code_challenge_method: "s256",
      })
    : await auth("token?grant_type=password", "POST", { email, password });
  if (!result.ok) return authError(res, result, registering);
  if (registering && !result.data?.access_token) return res.status(200).json({ needsConfirmation: true });
  const account = profile(result.data?.user);
  setSession(res, result.data);
  return res.status(200).json({ account });
}

export default async function customer(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return error(res, 405, "지원하지 않는 요청입니다.");
  }
  if (!originAllowed(req) || !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
    return error(res, 403, "주문자 화면에서 다시 시도해 주세요.");
  }
  let request;
  try {
    if (typeof req.body === "string" && req.body.length > 12000) throw new Error("Request too large");
    request = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!request || typeof request !== "object" || JSON.stringify(request).length > 12000) throw new Error("Invalid request");
  } catch {
    return error(res, 400, "요청 정보를 확인해 주세요.");
  }
  const { action, account, browser_key, payload = {} } = request;
  try {
    if (action === "login" || action === "register") return await signIn(res, request, action === "register");
    if (action === "logout") {
      try {
        await callWithSession(req, res, token => auth("logout?scope=local", "POST", null, token));
      } catch { /* The browser can still end its local session if Auth is unavailable. */ }
      clearSession(res);
      return res.status(200).json({ account: null });
    }
    if (action === "session") {
      const result = await callWithSession(req, res, token => auth("user", "GET", null, token));
      if (isExpired(result)) return res.status(200).json({ account: null });
      if (!result.ok) throw new Error("Could not load account");
      return res.status(200).json({ account: profile(result.data) });
    }
    if (!RPC_ACTIONS.has(action) || typeof account !== "string" || !UUID.test(account) ||
        typeof browser_key !== "string" || !UUID.test(browser_key) ||
        !payload || typeof payload !== "object" || Array.isArray(payload)) {
      return error(res, 400, "주문자 요청 정보를 확인해 주세요.");
    }
    const result = await callWithSession(req, res, token => supabase("/rest/v1/rpc/seoul_delivery_demo", "POST", {
      action, browser_key, payload: { ...payload, expected_customer: account },
    }, token));
    if (isExpired(result)) return error(res, 401, "다시 로그인한 뒤 시도해 주세요.", "login_required");
    if (!result.ok) {
      const message = result.data?.code === "P0001" ? result.data.message : "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
      return error(res, result.status >= 500 ? 503 : 400, message);
    }
    return res.status(200).json(result.data);
  } catch {
    return error(res, 503, "주문자 서비스에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
}
