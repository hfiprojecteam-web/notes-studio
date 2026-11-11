export interface Env {
  DB: D1Database;
  APP_PASSWORD: string; // login password for the app
  SECRET_KEY: string; // random string: signs sessions and encrypts the Substack cookie
  ANTHROPIC_API_KEY?: string;
  SUBSTACK_API_BASE?: string; // tests only
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------- sessions ----------

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function passwordMatches(env: Env, given: string) {
  // Compare HMACs so the comparison is constant-time regardless of length.
  return safeEqual(await hmac(env.SECRET_KEY, given), await hmac(env.SECRET_KEY, env.APP_PASSWORD));
}

export async function makeSession(env: Env) {
  const exp = Date.now() + 30 * 86400_000;
  return `${exp}.${await hmac(env.SECRET_KEY, `session:${exp}`)}`;
}

export async function sessionValid(env: Env, token: string | undefined) {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SECRET_KEY, `session:${exp}`));
}

// ---------- encryption of the Substack cookie at rest ----------

async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`enc:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(env: Env, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env.SECRET_KEY), enc.encode(plain));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function decrypt(env: Env, stored: string) {
  const [iv, ct] = stored.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env.SECRET_KEY), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ---------- settings ----------

export interface Settings {
  handle: string;
  user_id: string;
  timezone: string;
  slots: string; // JSON array of "HH:MM"
  slot_days: string; // JSON array of weekdays the slots apply to: 1 = Monday ... 7 = Sunday
  voice_prompt: string;
  voice_profile: string; // JSON, see VoiceProfile
  sid_enc: string;
  last_sync: string;
  last_sync_error: string;
  cookie_ok: string; // "1" | "0" | "" (unknown)
  cookie_checked_at: string;
  paused: string; // "1" stops every automatic action
  ai_drafts: string; // "0" switches Claude's writing help off
  next_own_sync: string;
  next_others_sync: string;
  last_others_sync: string;
  last_manual_sync: string;
  pub_subdomain: string;
  login_fails: string;
  login_lock_until: string;
  publish_mode: string; // "native" = Substack's own scheduler publishes; anything else = this app's timer
  alert_url: string; // optional address that receives a push message when something goes wrong
  connector_hash: string; // SHA-256 of the connector token; the token itself is never stored
  next_radar_sync: string;
  last_radar_sync: string;
  language: string; // interface and writing language: it, en, de, es, ru, fr, hi, pt
}

const DEFAULTS: Settings = {
  handle: "",
  user_id: "",
  timezone: "Europe/Rome",
  slots: '["09:00","13:00","18:30"]',
  slot_days: "[1,2,3,4,5,6,7]",
  voice_prompt: "",
  voice_profile: "",
  sid_enc: "",
  last_sync: "",
  last_sync_error: "",
  cookie_ok: "",
  cookie_checked_at: "",
  paused: "",
  ai_drafts: "",
  next_own_sync: "",
  next_others_sync: "",
  last_others_sync: "",
  last_manual_sync: "",
  pub_subdomain: "",
  login_fails: "",
  login_lock_until: "",
  publish_mode: "",
  alert_url: "",
  connector_hash: "",
  next_radar_sync: "",
  last_radar_sync: "",
  language: "it",
};

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const out = { ...DEFAULTS } as Record<string, string>;
  for (const r of results) out[r.key] = r.value;
  return out as unknown as Settings;
}

export async function setSetting(env: Env, key: keyof Settings, value: string) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function getSid(env: Env, s: Settings): Promise<string | null> {
  if (!s.sid_enc) return null;
  try {
    return await decrypt(env, s.sid_enc);
  } catch {
    return null;
  }
}

// ---------- time slots ----------

/** Parts of a UTC instant as seen on a wall clock in `tz`. */
export function localParts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, weekday: p.weekday as string };
}

/** Epoch ms of a wall-clock time in `tz`. */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  // Two passes handle the DST edge where the first offset guess is off by an hour.
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess += Date.UTC(y, m - 1, d, h, min) - seen;
  }
  return guess;
}

/** The next `count` free slot times after `from`, skipping the ones in `taken`. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** 1 = Monday ... 7 = Sunday, for an instant seen in `tz`. */
export const weekdayOf = (ms: number, tz: string) => WEEKDAYS.indexOf(localParts(ms, tz).weekday) + 1;

export function nextSlots(count: number, slots: string[], tz: string, taken: Set<number>, from = Date.now(), days: number[] = [1, 2, 3, 4, 5, 6, 7]) {
  const sorted = [...slots].sort();
  const out: number[] = [];
  if (!sorted.length || !days.length) return out;
  const start = localParts(from, tz);
  for (let day = 0; out.length < count && day < 400; day++) {
    // Walk calendar days via UTC noon so month/year rollovers are handled by Date.
    const base = new Date(Date.UTC(start.y, start.m - 1, start.d + day, 12));
    for (const s of sorted) {
      const [h, min] = s.split(":").map(Number);
      const t = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, min, tz);
      if (t > from + 60_000 && !taken.has(t) && days.includes(weekdayOf(t, tz))) {
        out.push(t);
        if (out.length === count) break;
      }
    }
  }
  return out;
}

/** Edit distance between two texts, used to tell a rewritten suggestion from an untouched one. */
export function editDistance(a: string, b: string): number {
  a = a.slice(0, 3000);
  b = b.slice(0, 3000);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** A suggestion counts as the writer's own once a meaningful part of it has been rewritten. */
export function madeOwn(original: string, current: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const o = norm(original), c = norm(current);
  return editDistance(o, c) >= Math.max(15, Math.round(o.length * 0.2));
}

export async function sha256(text: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export function sameText(a: string, b: string) {
  return safeEqual(a, b);
}
