import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Env, encrypt, getSettings, getSid, localParts, weekdayOf, zonedToUtc, makeSession, nextSlots, passwordMatches, sessionValid, setSetting, madeOwn, sameText, sha256 } from "./lib";
import { handleMcp } from "./mcp";
import { checkCookie, personUpdate, publishOne, radarSync, raiseAlert, sync, syncNative, tick } from "./jobs";
import { EMPTY_PROFILE, Voice, VoiceProfile, analyzeVoice, composeVoice, analyzeCreator, generateNotes, generateOutlines, isMessageKind, personalMessage, isRewriteMode, remixInspiration, rewriteNote, suggestReply } from "./generate";
import * as substack from "./substack";
import page from "../public/index.html";

import { UI_LANGS } from "./i18n";

const app = new Hono<{ Bindings: Env }>();

app.onError(async (err, c) => {
  const status = err instanceof substack.SubstackError && err.status === 401 ? 502 : 500;
  // Errors that are not an answer from Substack or a message meant for the writer are bugs: keep a trace of them.
  // One alert per distinct error per hour, so a broken screen cannot flood the list.
  const expected = err instanceof substack.SubstackError || /^(Substack:|La scrittura|ANTHROPIC_API_KEY|Claude ha rifiutato|Risposta troncata|Imposta prima|Cookie Substack|Network connection lost|fetch failed)/.test(err.message);
  if (!expected) {
    const where = `${c.req.method} ${new URL(c.req.url).pathname}`;
    try {
      await raiseAlert(c.env, "error", "Errore imprevisto nell'app", `${where}: ${err.message}`, `err:${where}:${err.message.slice(0, 80)}:${Math.floor(Date.now() / 3600_000)}`);
    } catch {
      /* the alert itself must never hide the original error */
    }
  }
  return c.json({ error: err.message }, status);
});

app.use("*", async (c, next) => {
  if (c.env.SUBSTACK_API_BASE) substack.setBase(c.env.SUBSTACK_API_BASE);
  await next();
});

app.get("/", (c) => c.html(page, 200, { "Cache-Control": "no-cache", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" }));

// Dictionaries are public: the login page needs them before anyone has signed in.
app.get("/i18n/:lang", (c) => {
  const l = UI_LANGS[c.req.param("lang")];
  return l?.dict ? c.json(l.dict, 200, { "Cache-Control": "public, max-age=300" }) : c.json({}, 404);
});

// ---------- connector for Claude and other assistants (MCP) ----------
// The address itself is the key: /mcp/<token>. Only its hash is stored, and it can be replaced from the settings.
app.all("/mcp/:token", async (c) => {
  const s = await getSettings(c.env);
  const token = c.req.param("token");
  if (!s.connector_hash || token.length < 32 || !sameText(await sha256(token), s.connector_hash)) return c.json({ error: "Not found" }, 404);
  const session = await makeSession(c.env);
  // Tools reuse the app's own routes, so the connector can never do more than the app allows.
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.fetch(
      new Request(`https://internal/api${path}`, {
        method: init.method ?? "GET",
        headers: { Cookie: `session=${session}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
      c.env,
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  };
  return handleMcp(c.req.raw, api);
});

// ---------- auth ----------

app.post("/api/login", async (c) => {
  const { password } = await c.req.json<{ password: string }>();
  if (!c.env.APP_PASSWORD || !c.env.SECRET_KEY) return c.json({ error: "APP_PASSWORD e SECRET_KEY non configurati" }, 500);
  // One owner, one password: after 5 wrong attempts the login closes for everyone for 15 minutes.
  // The count is global on purpose, because an attacker can change address at will.
  const s = await getSettings(c.env);
  const now = Date.now();
  if (Number(s.login_lock_until || 0) > now) {
    return c.json({ error: `Troppi tentativi: riprova tra ${Math.ceil((Number(s.login_lock_until) - now) / 60_000)} minuti` }, 429);
  }
  if (!(await passwordMatches(c.env, password ?? ""))) {
    const fails = Number(s.login_fails || 0) + 1;
    if (fails >= 5) {
      await setSetting(c.env, "login_fails", "0");
      await setSetting(c.env, "login_lock_until", String(now + 15 * 60_000));
      await raiseAlert(c.env, "login", "Tentativi di accesso falliti", "Cinque password errate di fila: l'accesso è rimasto chiuso per 15 minuti.", `login:${Math.floor(now / 900_000)}`);
    } else await setSetting(c.env, "login_fails", String(fails));
    return c.json({ error: "Password errata" }, 401);
  }
  if (s.login_fails && s.login_fails !== "0") await setSetting(c.env, "login_fails", "0");
  setCookie(c, "session", await makeSession(c.env), { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 30 * 86400 });
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  if (!(await sessionValid(c.env, getCookie(c, "session")))) return c.json({ error: "Non autenticato" }, 401);
  await next();
});

// ---------- settings ----------

app.get("/api/settings", async (c) => {
  const s = await getSettings(c.env);
  return c.json({
    handle: s.handle,
    timezone: s.timezone,
    slots: JSON.parse(s.slots),
    slot_days: JSON.parse(s.slot_days),
    has_voice: !!composeVoice(readProfile(s)),
    has_cookie: !!s.sid_enc,
    has_claude_key: !!c.env.ANTHROPIC_API_KEY,
    last_sync: s.last_sync ? Number(s.last_sync) : null,
    last_sync_error: s.last_sync_error,
    cookie_ok: s.cookie_ok === "" ? null : s.cookie_ok === "1",
    cookie_checked_at: s.cookie_checked_at ? Number(s.cookie_checked_at) : null,
    language: s.language,
    has_connector: !!s.connector_hash,
    publish_mode: s.publish_mode === "native" ? "native" : "timer",
    alert_url: s.alert_url,
    paused: s.paused === "1",
    ai_drafts: s.ai_drafts !== "0",
    next_others_sync: s.next_others_sync ? Number(s.next_others_sync) : null,
    last_others_sync: s.last_others_sync ? Number(s.last_others_sync) : null,
  });
});

app.put("/api/settings", async (c) => {
  const b = await c.req.json<{ handle?: string; timezone?: string; slots?: string[]; slot_days?: number[]; cookie?: string; paused?: boolean; ai_drafts?: boolean; language?: string; alert_url?: string; publish_mode?: string }>();
  if (b.handle !== undefined) {
    const handle = b.handle.trim().replace(/^@/, "");
    if (handle) {
      const p = await substack.getProfile(handle);
      await setSetting(c.env, "handle", p.handle);
      await setSetting(c.env, "user_id", String(p.id));
    }
  }
  if (b.timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: b.timezone });
    } catch {
      return c.json({ error: "Fuso orario non valido" }, 400);
    }
    await setSetting(c.env, "timezone", b.timezone);
  }
  if (b.slots) {
    const slots = [...new Set(b.slots.map((s) => s.trim()).filter((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)))].sort();
    await setSetting(c.env, "slots", JSON.stringify(slots));
  }
  if (Array.isArray(b.slot_days)) {
    await setSetting(c.env, "slot_days", JSON.stringify([...new Set(b.slot_days.map(Number).filter((d) => d >= 1 && d <= 7))].sort()));
  }
  if (b.language && b.language in UI_LANGS) await setSetting(c.env, "language", b.language);
  if (b.alert_url !== undefined) {
    const u = b.alert_url.trim();
    if (u && !/^https:\/\/[^\s]+$/.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) return c.json({ error: "Indirizzo non valido: deve iniziare con https://" }, 400);
    await setSetting(c.env, "alert_url", u);
  }
  if (b.publish_mode === "native" || b.publish_mode === "timer") await setSetting(c.env, "publish_mode", b.publish_mode);
  if (b.paused !== undefined) await setSetting(c.env, "paused", b.paused ? "1" : "");
  if (b.ai_drafts !== undefined) await setSetting(c.env, "ai_drafts", b.ai_drafts ? "1" : "0");
  if (b.cookie) {
    // Accept either the bare value or a pasted "substack.sid=..." pair.
    const sid = b.cookie.trim().replace(/^substack\.sid=/, "").split(";")[0];
    await setSetting(c.env, "sid_enc", await encrypt(c.env, sid));
    await checkCookie(c.env);
  }
  return c.json({ ok: true });
});

/** Creates (or replaces) the connector address. It is shown once, here, and never stored in clear. */
app.post("/api/connector", async (c) => {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await setSetting(c.env, "connector_hash", await sha256(token));
  return c.json({ url: `${new URL(c.req.url).origin}/mcp/${token}` });
});

app.delete("/api/connector", async (c) => {
  await setSetting(c.env, "connector_hash", "");
  return c.json({ ok: true });
});

/** Checks each piece of the Substack connection and reports what works. */
app.get("/api/diagnostics", async (c) => {
  const s = await getSettings(c.env);
  const out: { check: string; ok: boolean; detail: string }[] = [];
  const run = async (check: string, fn: () => Promise<string>) => {
    try {
      out.push({ check, ok: true, detail: await fn() });
    } catch (e) {
      out.push({ check, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };
  await run("Profilo pubblico", async () => {
    if (!s.handle) throw new Error("Handle non impostato");
    const p = await substack.getProfile(s.handle);
    return `${p.name} (id ${p.id})`;
  });
  await run("Lettura Notes", async () => {
    if (!s.user_id) throw new Error("Handle non impostato");
    return `${(await substack.getUserNotes(Number(s.user_id), 1, (await getSid(c.env, s)) ?? undefined)).length} Notes nella prima pagina`;
  });
  await run("Cookie di sessione", async () => {
    const sid = await getSid(c.env, s);
    if (!sid) throw new Error("Cookie non impostato");
    const me = await substack.whoAmI(sid);
    if (s.user_id && String(me.id) !== s.user_id) throw new Error(`Il cookie appartiene a un altro account (${me.handle ?? me.id})`);
    return `Valido per ${me.name ?? me.handle ?? me.id}`;
  });
  await checkCookie(c.env);
  out.push({ check: "Chiave Claude", ok: !!c.env.ANTHROPIC_API_KEY, detail: c.env.ANTHROPIC_API_KEY ? "Configurata" : "ANTHROPIC_API_KEY non impostata" });
  return c.json(out);
});

// ---------- notes queue ----------

app.get("/api/notes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM notes ORDER BY
       CASE status WHEN 'failed' THEN 0 WHEN 'publishing' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'draft' THEN 3 ELSE 4 END,
       CASE WHEN status = 'scheduled' THEN scheduled_at END ASC,
       COALESCE(published_at, created_at) DESC
     LIMIT 300`,
  ).all();
  return c.json(results);
});

app.post("/api/notes", async (c) => {
  const b = await c.req.json<{ body?: string; bodies?: string[]; scheduled_at?: number }>();
  const bodies = (b.bodies ?? [b.body ?? ""]).map((x) => x.trim()).filter(Boolean);
  if (!bodies.length) return c.json({ error: "Testo vuoto" }, 400);
  const now = Date.now();
  await c.env.DB.batch(
    bodies.map((body) =>
      c.env.DB.prepare("INSERT INTO notes (body, status, scheduled_at, source, created_at) VALUES (?,?,?,?,?)").bind(
        body,
        b.scheduled_at ? "scheduled" : "draft",
        b.scheduled_at ?? null,
        "manual",
        now,
      ),
    ),
  );
  const ids = (await c.env.DB.prepare("SELECT id FROM notes WHERE created_at = ? ORDER BY id DESC LIMIT ?").bind(now, bodies.length).all<{ id: number }>()).results.map((r) => r.id).reverse();
  if (b.scheduled_at) for (const id of ids) await syncNative(c.env, id);
  return c.json({ ok: true, created: bodies.length, ids });
});

const NEEDS_REWRITE = "È uno spunto di Claude: approvalo o riscrivilo prima di programmarlo";

app.put("/api/notes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ body?: string; scheduled_at?: number | null; approve?: boolean }>();
  const note = await c.env.DB.prepare("SELECT status, ai_original, reviewed FROM notes WHERE id = ?")
    .bind(id)
    .first<{ status: string; ai_original: string | null; reviewed: number }>();
  if (!note) return c.json({ error: "Note non trovata" }, 404);
  if (note.status === "published" || note.status === "publishing") return c.json({ error: "Note già pubblicata" }, 409);
  let reviewed = note.reviewed === 1;
  if (b.body !== undefined) {
    if (!b.body.trim()) return c.json({ error: "Testo vuoto" }, 400);
    // A suggestion written by Claude becomes the writer's own only once it has really been rewritten.
    if (note.ai_original !== null) reviewed = madeOwn(note.ai_original, b.body);
    if (note.ai_original !== null && note.reviewed === 1) reviewed = true; // once approved, it stays approved
    await c.env.DB.prepare("UPDATE notes SET body = ?, reviewed = ? WHERE id = ?").bind(b.body.trim(), reviewed ? 1 : 0, id).run();
  }
  // The writer may also take a suggestion exactly as it is: what matters is that the choice is theirs.
  if (b.approve && !reviewed) {
    reviewed = true;
    await c.env.DB.prepare("UPDATE notes SET reviewed = 1 WHERE id = ?").bind(id).run();
  }
  if (b.scheduled_at !== undefined) {
    if (b.scheduled_at && !reviewed) return c.json({ error: NEEDS_REWRITE, saved: b.body !== undefined }, 409);
    await c.env.DB.prepare("UPDATE notes SET scheduled_at = ?, status = ?, error = NULL WHERE id = ?")
      .bind(b.scheduled_at, b.scheduled_at ? "scheduled" : "draft", id)
      .run();
  }
  await syncNative(c.env, id);
  return c.json({ ok: true, reviewed });
});

app.delete("/api/notes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // Withdraw it from Substack's scheduler first: a deleted note must not come out anyway.
  await c.env.DB.prepare("UPDATE notes SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'scheduled'").bind(id).run();
  await syncNative(c.env, id);
  await c.env.DB.prepare("DELETE FROM notes WHERE id = ? AND status != 'publishing'").bind(id).run();
  return c.json({ ok: true });
});

// Drafts written with an assistant in chat: saved as suggestions that wait for the writer's approval.
app.post("/api/notes/from-chat", async (c) => {
  const { body } = await c.req.json<{ body: string }>();
  if (!body?.trim()) return c.json({ error: "Testo vuoto" }, 400);
  const r = await c.env.DB.prepare("INSERT INTO notes (body, status, source, created_at, ai_original, reviewed) VALUES (?, 'draft', 'chat', ?, ?, 0)")
    .bind(body.trim(), Date.now(), body.trim())
    .run();
  return c.json({ ok: true, id: r.meta.last_row_id });
});

app.put("/api/notes/:id/from-chat", async (c) => {
  const { body } = await c.req.json<{ body: string }>();
  if (!body?.trim()) return c.json({ error: "Testo vuoto" }, 400);
  const r = await c.env.DB.prepare("UPDATE notes SET body = ?, ai_original = ?, reviewed = 0, source = 'chat' WHERE id = ? AND status = 'draft'")
    .bind(body.trim(), body.trim(), Number(c.req.param("id")))
    .run();
  if (!r.meta.changes) return c.json({ error: "Bozza non trovata, oppure già programmata o pubblicata" }, 404);
  return c.json({ ok: true });
});

/** Puts drafts into the next free time slots (all drafts, or the given ids). */
app.post("/api/notes/schedule", async (c) => {
  const b = await c.req.json<{ ids?: number[] }>().catch(() => ({}) as { ids?: number[] });
  const s = await getSettings(c.env);
  const drafts = (await c.env.DB.prepare("SELECT id FROM notes WHERE status = 'draft' AND reviewed = 1 ORDER BY created_at, id").all<{ id: number }>()).results
    .map((r) => r.id)
    .filter((id) => !b.ids || b.ids.includes(id));
  const taken = new Set(
    (await c.env.DB.prepare("SELECT scheduled_at FROM notes WHERE status = 'scheduled'").all<{ scheduled_at: number }>()).results.map((r) => r.scheduled_at),
  );
  const times = nextSlots(drafts.length, JSON.parse(s.slots), s.timezone, taken, Date.now(), JSON.parse(s.slot_days));
  if (times.length < drafts.length) return c.json({ error: "Nessuno slot orario disponibile: controlla orari e giorni nelle Impostazioni" }, 400);
  if (drafts.length) {
    await c.env.DB.batch(
      drafts.map((id, i) => c.env.DB.prepare("UPDATE notes SET status = 'scheduled', scheduled_at = ? WHERE id = ?").bind(times[i], id)),
    );
  }
  let done = 0;
  for (const id of drafts) {
    try {
      await syncNative(c.env, id);
      done++;
    } catch (e) {
      // Substack refused (for example its limit of scheduled Notes): the rest stay as drafts.
      const rest = drafts.slice(done + 1);
      if (rest.length) await c.env.DB.prepare(`UPDATE notes SET status = 'draft', scheduled_at = NULL WHERE native_id IS NULL AND id IN (${rest.map(() => "?").join(",")})`).bind(...rest).run();
      return c.json({ error: `${done} programmate, poi si è fermato. ${e instanceof Error ? e.message : e}` }, 502);
    }
  }
  return c.json({ ok: true, scheduled: drafts.length });
});

/** Sends every scheduled note back to drafts. */
app.post("/api/notes/unschedule", async (c) => {
  const ids = (await c.env.DB.prepare("SELECT id FROM notes WHERE status = 'scheduled'").all<{ id: number }>()).results.map((r) => r.id);
  for (const id of ids) {
    await c.env.DB.prepare("UPDATE notes SET status = 'draft', scheduled_at = NULL WHERE id = ?").bind(id).run();
    await syncNative(c.env, id);
  }
  return c.json({ ok: true, unscheduled: ids.length });
});

app.post("/api/notes/:id/publish", async (c) => {
  const r = await publishOne(c.env, Number(c.req.param("id")));
  return c.json(r, r.ok ? 200 : 502);
});

// ---------- generator ----------

/** Voice reference for Claude: the writer's instructions, best-performing notes and latest notes. */
async function voice(env: Env): Promise<Voice> {
  const s = await getSettings(env);
  type Row = { substack_id: string; body: string };
  const top = await env.DB.prepare("SELECT substack_id, body FROM my_notes WHERE length(body) > 40 ORDER BY likes + restacks * 2 DESC LIMIT 12").all<Row>();
  const latest = await env.DB.prepare("SELECT substack_id, body FROM my_notes WHERE length(body) > 40 ORDER BY date DESC LIMIT 8").all<Row>();
  const profile = readProfile(s);
  profile.language = UI_LANGS[s.language]?.name ?? "Italian"; // one language for the whole app, set in the settings
  return {
    voicePrompt: composeVoice(profile),
    samples: profile.samples,
    examples: [...new Map([...top.results, ...latest.results].map((r) => [r.substack_id, r.body])).values()],
  };
}

/** The stored profile; instructions written before the profile existed become its free-text portrait. */
function readProfile(s: { voice_profile: string; voice_prompt: string }): VoiceProfile {
  try {
    if (s.voice_profile) return { ...EMPTY_PROFILE, ...JSON.parse(s.voice_profile) };
  } catch {
    /* fall through to the default */
  }
  return { ...EMPTY_PROFILE, portrait: s.voice_prompt ?? "" };
}

const LANGUAGES = ["auto", "Italian", "English", "Spanish", "French", "German", "Portuguese"];

app.get("/api/voice", async (c) => {
  const s = await getSettings(c.env);
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM my_notes WHERE length(body) > 40").first<{ n: number }>();
  return c.json({ profile: readProfile(s), languages: LANGUAGES, notes: n?.n ?? 0, has_claude_key: !!c.env.ANTHROPIC_API_KEY });
});

app.put("/api/voice", async (c) => {
  const b = await c.req.json<Partial<VoiceProfile>>();
  const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.map((x) => str(x, 60)).filter(Boolean).slice(0, max) : []);
  const samples = (Array.isArray(b.samples) ? b.samples : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 5);
  if (samples.join("").length > 40_000) return c.json({ error: "I testi campione superano i 40.000 caratteri complessivi: accorciali" }, 400);
  const profile: VoiceProfile = {
    language: LANGUAGES.includes(String(b.language)) ? String(b.language) : "auto",
    about: str(b.about, 1500), audience: str(b.audience, 1500), topics: str(b.topics, 1500),
    tones: list(b.tones, 8), length: str(b.length, 60), emoji: str(b.emoji, 60), hashtags: str(b.hashtags, 60),
    person: str(b.person, 60), address: str(b.address, 60), structure: list(b.structure, 8),
    use_words: str(b.use_words, 1500), avoid_words: str(b.avoid_words, 1500), cta: str(b.cta, 800), portrait: str(b.portrait, 4000),
    samples,
  };
  await setSetting(c.env, "voice_profile", JSON.stringify(profile));
  return c.json({ ok: true });
});

app.post("/api/voice/analyze", async (c) => {
  const key = await claudeKey(c.env);
  const profile = readProfile(await getSettings(c.env));
  const notes = await c.env.DB.prepare("SELECT body FROM my_notes WHERE length(body) > 40 ORDER BY likes + restacks * 2 DESC LIMIT 25").all<{ body: string }>();
  const texts = [...profile.samples, ...notes.results.map((r) => r.body)];
  if (texts.join("").length < 600) return c.json({ error: "Servono più testi: incolla almeno un tuo scritto tra i testi campione e salva" }, 400);
  return c.json({ portrait: await analyzeVoice(key, texts, UI_LANGS[(await getSettings(c.env)).language]?.name ?? "Italian") });
});

/** Draft writing is off unless the owner switched it on in the settings. */
async function claudeKey(env: Env) {
  if ((await getSettings(env)).ai_drafts === "0") throw new Error("La scrittura di bozze con Claude è disattivata (Impostazioni)");
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY non configurata su Cloudflare");
  return env.ANTHROPIC_API_KEY;
}

async function saveDrafts(env: Env, bodies: string[]) {
  const now = Date.now();
  if (bodies.length) {
    await env.DB.batch(bodies.map((body) => env.DB.prepare("INSERT INTO notes (body, status, source, created_at, ai_original, reviewed) VALUES (?, 'draft', 'generated', ?, ?, 0)").bind(body, now, body)));
  }
  return bodies.length;
}

app.post("/api/generate", async (c) => {
  const key = await claudeKey(c.env);
  const b = await c.req.json<{ count?: number; topic?: string; source_text?: string; source_url?: string; dry?: boolean; mode?: string }>();
  const count = Math.min(Math.max(Number(b.count) || 5, 1), 20);
  let sourceText = b.source_text?.trim();
  let sourceTitle: string | undefined;
  if (!sourceText && b.source_url?.trim()) {
    const post = await substack.getPostText(b.source_url.trim());
    sourceText = post.text;
    sourceTitle = post.title;
  }
  if (!sourceText && !b.topic?.trim()) return c.json({ error: "Indica un'idea, un testo o il link di un post" }, 400);
  const v = await voice(c.env);
  const bodies = await (b.mode === "full" ? generateNotes : generateOutlines)(key, v, { count, topic: b.topic, sourceText, sourceTitle });
  if (b.dry) return c.json({ ok: true, created: 0, bodies });
  return c.json({ ok: true, created: await saveDrafts(c.env, bodies), examples_used: v.examples.length });
});

/** Returns alternative versions of a draft. Nothing is saved: the writer picks one. */
app.post("/api/rewrite", async (c) => {
  const key = await claudeKey(c.env);
  const b = await c.req.json<{ body?: string; mode?: string }>();
  if (!b.body?.trim()) return c.json({ error: "Testo vuoto" }, 400);
  if (!isRewriteMode(b.mode)) return c.json({ error: "Modalità non valida" }, 400);
  return c.json({ variants: await rewriteNote(key, await voice(c.env), b.body.trim(), b.mode) });
});

// ---------- inspirations ----------

app.get("/api/inspirations", async (c) => {
  return c.json((await c.env.DB.prepare("SELECT * FROM inspirations ORDER BY saved_at DESC LIMIT 200").all()).results);
});

app.post("/api/inspirations", async (c) => {
  const { substack_id } = await c.req.json<{ substack_id: string }>();
  const n = await c.env.DB.prepare("SELECT f.substack_id, f.handle, f.body, w.name FROM feed_items f LEFT JOIN follows w ON w.handle = f.handle WHERE f.substack_id = ?")
    .bind(String(substack_id))
    .first<{ substack_id: string; handle: string; body: string; name: string | null }>();
  if (!n) return c.json({ error: "Note non trovata nel feed" }, 404);
  await c.env.DB.prepare("INSERT OR IGNORE INTO inspirations (substack_id, handle, name, body, saved_at) VALUES (?,?,?,?,?)")
    .bind(n.substack_id, n.handle, n.name, n.body, Date.now())
    .run();
  return c.json({ ok: true });
});

app.delete("/api/inspirations/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM inspirations WHERE substack_id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

app.post("/api/inspirations/:id/remix", async (c) => {
  const key = await claudeKey(c.env);
  const n = await c.env.DB.prepare("SELECT handle, name, body FROM inspirations WHERE substack_id = ?")
    .bind(c.req.param("id"))
    .first<{ handle: string; name: string | null; body: string }>();
  if (!n) return c.json({ error: "Ispirazione non trovata" }, 404);
  const bodies = await remixInspiration(key, await voice(c.env), { author: n.name ?? n.handle, body: n.body }, 3);
  return c.json({ ok: true, created: await saveDrafts(c.env, bodies) });
});

// ---------- week calendar ----------

/** The 7 days starting today (shifted by `offset` weeks) with the slot times of each, in the writer's timezone. */
app.get("/api/week", async (c) => {
  const s = await getSettings(c.env);
  const offset = Math.max(-52, Math.min(52, Number(c.req.query("offset")) || 0));
  const slots: string[] = JSON.parse(s.slots);
  const activeDays: number[] = JSON.parse(s.slot_days);
  const today = localParts(Date.now(), s.timezone);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(today.y, today.m - 1, today.d + offset * 7 + i, 12));
    const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const next = new Date(Date.UTC(y, m - 1, day + 1, 12));
    days.push({
      key: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      start: zonedToUtc(y, m, day, 0, 0, s.timezone),
      end: zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, s.timezone),
      slots: (activeDays.includes(weekdayOf(zonedToUtc(y, m, day, 12, 0, s.timezone), s.timezone)) ? slots : []).map((label) => {
        const [h, min] = label.split(":").map(Number);
        return { label, ts: zonedToUtc(y, m, day, h, min, s.timezone) };
      }),
    });
  }
  return c.json({ timezone: s.timezone, offset, now: Date.now(), has_slots: slots.length > 0 && activeDays.length > 0, days });
});

// ---------- stats ----------

app.get("/api/stats", async (c) => {
  const s = await getSettings(c.env);
  const days = Math.min(Number(c.req.query("days")) || 90, 3650);
  const { results } = await c.env.DB.prepare("SELECT * FROM my_notes WHERE date >= ? ORDER BY date DESC")
    .bind(Date.now() - days * 86400_000)
    .all<{ substack_id: string; body: string; date: number; likes: number; restacks: number; replies: number }>();

  const score = (n: { likes: number; restacks: number; replies: number }) => n.likes + n.restacks + n.replies;
  const bucket = <K extends string | number>(keyOf: (n: (typeof results)[number]) => K) => {
    const m = new Map<K, { count: number; total: number }>();
    for (const n of results) {
      const k = keyOf(n);
      const e = m.get(k) ?? { count: 0, total: 0 };
      e.count++;
      e.total += score(n);
      m.set(k, e);
    }
    return [...m.entries()].map(([key, v]) => ({ key, count: v.count, avg: +(v.total / v.count).toFixed(1) }));
  };

  const lengthLabel = (len: number) => (len < 150 ? "Brevi (<150)" : len < 400 ? "Medie (150-400)" : "Lunghe (>400)");
  return c.json({
    days,
    total: results.length,
    likes: results.reduce((a, n) => a + n.likes, 0),
    restacks: results.reduce((a, n) => a + n.restacks, 0),
    replies: results.reduce((a, n) => a + n.replies, 0),
    brought: {
      measured: results.filter((n: any) => n.stats_at).length,
      follows: results.reduce((a, n: any) => a + (n.follows ?? 0), 0),
      free_subs: results.reduce((a, n: any) => a + (n.free_subs ?? 0), 0),
      paid_subs: results.reduce((a, n: any) => a + (n.paid_subs ?? 0), 0),
      clicks: results.reduce((a, n: any) => a + (n.clicks ?? 0), 0),
    },
    by_result: [...results].filter((n: any) => (n.free_subs ?? 0) + (n.paid_subs ?? 0) + (n.follows ?? 0) > 0)
      .sort((a: any, b: any) => (b.paid_subs * 100 + b.free_subs * 10 + b.follows) - (a.paid_subs * 100 + a.free_subs * 10 + a.follows)).slice(0, 10),
    by_hour: bucket((n) => localParts(n.date, s.timezone).h).sort((a, b) => a.key - b.key),
    by_weekday: bucket((n) => localParts(n.date, s.timezone).weekday),
    by_length: bucket((n) => lengthLabel(n.body.length)),
    top: [...results].sort((a, b) => score(b) - score(a)).slice(0, 10),
    last_sync: s.last_sync ? Number(s.last_sync) : null,
  });
});

app.post("/api/sync", async (c) => {
  const deep = c.req.query("deep") === "1";
  const s = await getSettings(c.env);
  const wait = 15 * 60_000 - (Date.now() - Number(s.last_manual_sync || 0));
  if (wait > 0) return c.json({ error: `Hai appena sincronizzato: riprova tra ${Math.ceil(wait / 60_000)} minuti` }, 429);
  await setSetting(c.env, "last_manual_sync", String(Date.now()));
  // A manual run refreshes my own numbers only; other people's content follows its daily schedule.
  return c.json(await sync(c.env, { deep, others: c.req.query("others") === "1" }));
});

// ---------- activity ----------

app.get("/api/activity", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM activity WHERE status = 'open' ORDER BY date DESC LIMIT 200").all();
  return c.json(results);
});

app.post("/api/activity/:id/done", async (c) => {
  await c.env.DB.prepare("UPDATE activity SET status = 'done' WHERE reply_id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

app.post("/api/activity/:id/suggest", async (c) => {
  const key = await claudeKey(c.env);
  const a = await c.env.DB.prepare("SELECT note_body, author_name, author_handle, body FROM activity WHERE reply_id = ?")
    .bind(c.req.param("id"))
    .first<{ note_body: string | null; author_name: string | null; author_handle: string | null; body: string }>();
  if (!a) return c.json({ error: "Risposta non trovata" }, 404);
  const reply = await suggestReply(key, await voice(c.env), {
    noteBody: a.note_body ?? "",
    author: a.author_name ?? a.author_handle ?? "reader",
    replyBody: a.body,
  });
  return c.json({ reply });
});

app.post("/api/activity/:id/reply", async (c) => {
  const { body } = await c.req.json<{ body: string }>();
  if (!body?.trim()) return c.json({ error: "Risposta vuota" }, 400);
  const sid = await getSid(c.env, await getSettings(c.env));
  if (!sid) return c.json({ error: "Cookie Substack mancante" }, 400);
  await substack.publishNote(sid, body.trim(), c.req.param("id"));
  await c.env.DB.prepare("UPDATE activity SET status = 'done' WHERE reply_id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---------- follows ----------

app.get("/api/follows", async (c) => {
  const follows = await c.env.DB.prepare("SELECT * FROM follows ORDER BY added_at").all();
  const feed = await c.env.DB.prepare(
    "SELECT f.*, w.name, w.photo_url, (SELECT 1 FROM inspirations i WHERE i.substack_id = f.substack_id) AS saved FROM feed_items f JOIN follows w ON w.handle = f.handle ORDER BY f.date DESC LIMIT 150",
  ).all();
  return c.json({ follows: follows.results, feed: feed.results });
});

app.post("/api/follows", async (c) => {
  const { handle } = await c.req.json<{ handle: string }>();
  const clean = (handle ?? "").trim().replace(/^https?:\/\/substack\.com\/@/, "").replace(/^@/, "").split(/[/?]/)[0];
  if (!clean) return c.json({ error: "Handle mancante" }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM follows").first<{ n: number }>();
  if ((count?.n ?? 0) >= 10) return c.json({ error: "Massimo 10 profili osservati" }, 400);
  const p = await substack.getProfile(clean);
  await c.env.DB.prepare("INSERT OR REPLACE INTO follows (handle, user_id, name, photo_url, added_at) VALUES (?,?,?,?,?)")
    .bind(p.handle, p.id, p.name, p.photoUrl, Date.now())
    .run();
  await c.env.DB.prepare("INSERT INTO people (user_id, handle, name, photo_url, kind, added_at) VALUES (?,?,?,?,'creator',?) ON CONFLICT(user_id) DO UPDATE SET kind = 'creator'")
    .bind(p.id, p.handle, p.name, p.photoUrl, Date.now())
    .run();
  const notes = await substack.getUserNotes(p.id, 1);
  if (notes.length) {
    await c.env.DB.batch(
      notes.map((n) =>
        c.env.DB.prepare("INSERT OR REPLACE INTO feed_items (substack_id, handle, body, date, likes, restacks, replies) VALUES (?,?,?,?,?,?,?)").bind(
          n.id,
          p.handle,
          n.body,
          n.date,
          n.likes,
          n.restacks,
          n.replies,
        ),
      ),
    );
  }
  return c.json({ ok: true, name: p.name });
});

app.delete("/api/follows/:handle", async (c) => {
  const h = c.req.param("handle");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM follows WHERE handle = ?").bind(h),
    c.env.DB.prepare("DELETE FROM feed_items WHERE handle = ?").bind(h),
  ]);
  return c.json({ ok: true });
});

// ---------- research materials (read-only library) ----------

app.get("/api/materials", async (c) => {
  return c.json((await c.env.DB.prepare("SELECT id, title, source, length(body) AS size, created_at FROM materials ORDER BY created_at DESC").all()).results);
});

app.get("/api/materials/:id", async (c) => {
  const m = await c.env.DB.prepare("SELECT * FROM materials WHERE id = ?").bind(Number(c.req.param("id"))).first();
  return m ? c.json(m) : c.json({ error: "Materiale non trovato" }, 404);
});

app.post("/api/materials", async (c) => {
  const b = await c.req.json<{ title?: string; body?: string; source?: string }>();
  const body = (b.body ?? "").trim();
  if (!body) return c.json({ error: "Testo vuoto" }, 400);
  if (body.length > 400_000) return c.json({ error: "Testo troppo lungo (massimo 400.000 caratteri)" }, 400);
  const title = (b.title ?? "").trim().slice(0, 200) || body.split("\n")[0].replace(/^#+\s*/, "").slice(0, 120) || "Senza titolo";
  const r = await c.env.DB.prepare("INSERT INTO materials (title, body, source, created_at) VALUES (?,?,?,?)")
    .bind(title, body, (b.source ?? "").trim().slice(0, 200), Date.now())
    .run();
  return c.json({ ok: true, id: r.meta.last_row_id });
});

app.delete("/api/materials/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM materials WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------- today ----------

/** One screen that answers "what should I do now": what waits for me, what goes out next, what is still to set up. */
app.get("/api/today", async (c) => {
  const s = await getSettings(c.env);
  const now = Date.now();
  const db = c.env.DB;
  const one = async (sql: string, ...args: unknown[]) => ((await db.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0);
  const [replies, approvals, failed, scheduledCount, draftsCount, myNotes, published, follows, inspirations, materials, people, activityAll] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM activity WHERE status = 'open'"),
    one("SELECT COUNT(*) AS n FROM notes WHERE reviewed = 0 AND status = 'draft'"),
    one("SELECT COUNT(*) AS n FROM notes WHERE status IN ('failed','publishing')"),
    one("SELECT COUNT(*) AS n FROM notes WHERE status = 'scheduled'"),
    one("SELECT COUNT(*) AS n FROM notes WHERE status = 'draft' AND reviewed = 1"),
    one("SELECT COUNT(*) AS n FROM my_notes"),
    one("SELECT COUNT(*) AS n FROM notes WHERE status = 'published'"),
    one("SELECT COUNT(*) AS n FROM follows"),
    one("SELECT COUNT(*) AS n FROM inspirations"),
    one("SELECT COUNT(*) AS n FROM materials"),
    one("SELECT COUNT(*) AS n FROM people"),
    one("SELECT COUNT(*) AS n FROM activity"),
  ]);
  const replyItems = (await db.prepare("SELECT reply_id, author_name, author_handle, body, date FROM activity WHERE status = 'open' ORDER BY date DESC LIMIT 3").all()).results;
  const steps = (await db.prepare("SELECT user_id, name, handle, next_step, next_date FROM people WHERE circle = 1 AND next_date IS NOT NULL AND next_date <= ? ORDER BY next_date LIMIT 5").bind(now + 36 * 3600_000).all()).results;
  const next = (await db.prepare("SELECT id, body, scheduled_at, native_id FROM notes WHERE status = 'scheduled' ORDER BY scheduled_at LIMIT 3").all()).results;
  const last = await db.prepare("SELECT * FROM my_notes ORDER BY date DESC LIMIT 1").first();
  const taken = new Set((await db.prepare("SELECT scheduled_at FROM notes WHERE status = 'scheduled'").all<{ scheduled_at: number }>()).results.map((r) => r.scheduled_at));
  const freeSoon = nextSlots(40, JSON.parse(s.slots), s.timezone, taken, now, JSON.parse(s.slot_days)).filter((t) => t < now + 48 * 3600_000).length;
  const profile = readProfile(s);
  return c.json({
    setup: [
      { key: "handle", done: !!s.handle },
      { key: "cookie", done: !!s.sid_enc && s.cookie_ok !== "0" },
      { key: "first_note", done: published > 0 },
      { key: "voice", done: !!composeVoice({ ...profile, language: "auto" }) || profile.samples.length > 0 },
      { key: "alerts", done: !!s.alert_url },
    ],
    todo: { replies, reply_items: replyItems, steps, approvals, failed },
    queue: { next, scheduled: scheduledCount, drafts: draftsCount, free_soon: freeSoon },
    last,
    has: { activity: activityAll > 0, feed: follows + inspirations > 0, materials: materials > 0, people: people > 0, stats: myNotes > 0 },
  });
});

// ---------- alerts ----------

app.get("/api/alerts", async (c) => {
  return c.json((await c.env.DB.prepare("SELECT id, at, kind, title, detail FROM alerts WHERE seen = 0 ORDER BY at DESC LIMIT 20").all()).results);
});

app.post("/api/alerts/seen", async (c) => {
  const b = await c.req.json<{ id?: number }>().catch(() => ({}) as { id?: number });
  if (b.id) await c.env.DB.prepare("UPDATE alerts SET seen = 1 WHERE id = ?").bind(b.id).run();
  else await c.env.DB.prepare("UPDATE alerts SET seen = 1 WHERE seen = 0").run();
  return c.json({ ok: true });
});

app.post("/api/alerts/test", async (c) => {
  const pushed = await raiseAlert(c.env, "test", "Avviso di prova", new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC");
  return c.json({ ok: true, pushed });
});

// ---------- people ----------

const SUB_TAGS = ["lettore", "potenziale cliente", "cliente", "ambasciatore", "imprenditore"];
const CREATOR_TAGS = ["competitor", "coopetitor", "affine", "ispirazione"];
const TAGS = [...SUB_TAGS, ...CREATOR_TAGS];

/** Subscription to MY publication, read from the person's public subscriptions (or set by hand). */
function subState(p: any, mySubdomain: string): "paid" | "free" | "none" | null {
  if (p.sub_manual) return p.sub_manual;
  if (!Array.isArray(p.subscriptions) || !mySubdomain) return null;
  const mine = p.subscriptions.find((x: any) => x.subdomain === mySubdomain);
  if (!mine) return p.subs_truncated ? null : "none";
  return mine.founding || mine.state === "subscribed" ? "paid" : "free";
}

app.get("/api/people", async (c) => {
  const s = await getSettings(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, COUNT(a.reply_id) AS interactions, MAX(a.date) AS last_interaction,
            SUM(CASE WHEN a.status = 'open' THEN 1 ELSE 0 END) AS waiting,
            (SELECT MAX(date) FROM contacts k WHERE k.user_id = p.user_id) AS last_contact
     FROM people p LEFT JOIN activity a ON a.author_id = p.user_id
     GROUP BY p.user_id ORDER BY waiting DESC, interactions DESC, COALESCE(p.followers, 0) DESC LIMIT 300`,
  ).all();
  const watched = new Set((await c.env.DB.prepare("SELECT user_id FROM follows").all<{ user_id: number }>()).results.map((r) => r.user_id));
  const feed = (await c.env.DB.prepare("SELECT f.*, w.user_id FROM feed_items f JOIN follows w ON w.handle = f.handle").all<any>()).results;
  const snaps = (await c.env.DB.prepare("SELECT user_id, MIN(day) AS d0, MAX(day) AS d1, COUNT(*) AS n FROM creator_snapshots GROUP BY user_id").all<any>()).results;
  const firstLast = (await c.env.DB.prepare(
    "SELECT s.user_id, s.day, s.followers FROM creator_snapshots s JOIN (SELECT user_id, MIN(day) AS d0, MAX(day) AS d1 FROM creator_snapshots GROUP BY user_id) m ON m.user_id = s.user_id AND (s.day = m.d0 OR s.day = m.d1)",
  ).all<any>()).results;
  const now = Date.now();
  /** Habits and results of a watched creator, computed from what the daily read has collected so far. */
  const radar = (r: any) => {
    const notes = feed.filter((n) => n.user_id === r.user_id);
    const posts: any[] = r.posts ? JSON.parse(r.posts) : [];
    const out: any = { notes_seen: notes.length, posts_seen: posts.length };
    if (notes.length) {
      const span = Math.max(1, (now - Math.min(...notes.map((n) => n.date))) / 86400_000);
      const eng = (n: any) => n.likes + n.restacks + n.replies;
      const hours = new Map<number, number>();
      for (const n of notes) { const h = localParts(n.date, s.timezone).h; hours.set(h, (hours.get(h) ?? 0) + 1); }
      const top = [...notes].sort((a, b) => eng(b) - eng(a))[0];
      const avg = notes.reduce((a, n) => a + eng(n), 0) / notes.length;
      Object.assign(out, {
        notes_per_day: +(notes.length / span).toFixed(1),
        avg_interactions: +avg.toFixed(1),
        with_link: Math.round((notes.filter((n) => /https?:\/\//.test(n.body)).length / notes.length) * 100),
        avg_length: Math.round(notes.reduce((a, n) => a + n.body.length, 0) / notes.length),
        usual_hour: [...hours.entries()].sort((a, b) => b[1] - a[1])[0][0],
        top: { id: top.substack_id, body: top.body.slice(0, 220), interactions: eng(top), times: avg ? +(eng(top) / avg).toFixed(1) : null },
      });
    }
    if (posts.length >= 2) {
      const span = Math.max(1, (posts[0].date - posts[posts.length - 1].date) / (7 * 86400_000));
      Object.assign(out, {
        posts_per_week: +((posts.length - 1) / span).toFixed(1),
        paid_share: Math.round((posts.filter((x) => x.audience && x.audience !== "everyone").length / posts.length) * 100),
        last_post: { title: posts[0].title, url: posts[0].url, date: posts[0].date },
      });
    }
    const fl = firstLast.filter((x) => x.user_id === r.user_id).sort((a, b) => (a.day < b.day ? -1 : 1));
    const sn = snaps.find((x) => x.user_id === r.user_id);
    if (fl.length && sn) out.growth = { delta: fl[fl.length - 1].followers - fl[0].followers, days: sn.n };
    return out;
  };
  const people = results.map((r: any) => {
    const p = { ...r, subscriptions: r.subscriptions ? JSON.parse(r.subscriptions) : null, posts: undefined };
    p.watched = watched.has(r.user_id);
    // Two sides: the people who read me, and the creators I study. A creator who also subscribes stays a creator.
    p.kind = r.kind ?? (p.watched || CREATOR_TAGS.includes(r.tag) ? "creator" : "iscritto");
    if (p.kind === "creator") p.radar = radar(r);
    p.topics = r.topics ? JSON.parse(r.topics) : null;
    p.sub_state = subState(p, s.pub_subdomain);
    // Why this person may be worth adding to the circle. Each reason is a fact, shown as is.
    const paysOthers = (p.subscriptions ?? []).filter((x: any) => x.subdomain !== s.pub_subdomain && (x.founding || x.state === "subscribed")).length;
    const reasons: string[] = [];
    let score = 0;
    if (p.sub_state === "paid") { score += 6; reasons.push("È tuo abbonato a pagamento"); }
    if (p.sub_state === "free") { score += 4; reasons.push("È iscritto alla tua pubblicazione"); }
    if (p.interactions >= 2) { score += 3; reasons.push(`Ti ha risposto ${p.interactions} volte`); }
    else if (p.interactions === 1) { score += 1; reasons.push("Ti ha risposto 1 volte"); }
    if (paysOthers) { score += 2; reasons.push(`Paga già ${paysOthers} newsletter`); }
    if ((p.followers ?? 0) >= 1000) { score += 2; reasons.push(`Ha ${p.followers} follower`); }
    p.reasons = reasons;
    p.score = score;
    p.suggested = p.kind !== "creator" && !p.circle && !p.dismissed && score >= 3;
    return p;
  });
  return c.json({ tags: TAGS, sub_tags: SUB_TAGS, creator_tags: CREATOR_TAGS, watched_max: 10, people });
});

/** Looks up any Substack profile by handle and stores it. */
app.post("/api/people", async (c) => {
  const { handle, kind } = await c.req.json<{ handle: string; kind?: string }>();
  const clean = (handle ?? "").trim().replace(/^https?:\/\/substack\.com\/@/, "").replace(/^@/, "").split(/[/?]/)[0];
  if (!clean) return c.json({ error: "Handle mancante" }, 400);
  const sid = (await getSid(c.env, await getSettings(c.env))) ?? undefined;
  const p = await substack.getFullProfile(clean, sid);
  await personUpdate(c.env, p, Date.now()).run();
  if (kind === "creator") await c.env.DB.prepare("UPDATE people SET kind = 'creator' WHERE user_id = ?").bind(p.id).run();
  else await c.env.DB.prepare("UPDATE people SET kind = 'iscritto', circle = 1, dismissed = 0 WHERE user_id = ?").bind(p.id).run();
  return c.json({ ok: true, name: p.name, user_id: p.id });
});

app.put("/api/people/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ tag?: string | null; circle?: boolean; dismissed?: boolean; sub_manual?: string | null; note?: string; next_step?: string; next_date?: number | null; kind?: string }>();
  if (b.tag && !TAGS.includes(b.tag)) return c.json({ error: "Etichetta non valida" }, 400);
  if (b.sub_manual && !["paid", "free", "none"].includes(b.sub_manual)) return c.json({ error: "Stato non valido" }, 400);
  const set: string[] = [];
  const val: unknown[] = [];
  const put = (col: string, v: unknown) => { set.push(`${col} = ?`); val.push(v); };
  if (b.tag !== undefined) put("tag", b.tag || null);
  if (b.kind === "creator" || b.kind === "iscritto") put("kind", b.kind);
  if (b.circle !== undefined) put("circle", b.circle ? 1 : 0);
  if (b.dismissed !== undefined) put("dismissed", b.dismissed ? 1 : 0);
  if (b.sub_manual !== undefined) put("sub_manual", b.sub_manual || null);
  if (b.note !== undefined) put("note", String(b.note).slice(0, 4000));
  if (b.next_step !== undefined) put("next_step", String(b.next_step).slice(0, 300));
  if (b.next_date !== undefined) put("next_date", b.next_date || null);
  if (set.length) await c.env.DB.prepare(`UPDATE people SET ${set.join(", ")} WHERE user_id = ?`).bind(...val, id).run();
  return c.json({ ok: true });
});

/** Starts or stops the daily read of a creator's public notes, posts and profile (at most 10 at a time). */
app.post("/api/people/:id/watch", async (c) => {
  const id = Number(c.req.param("id"));
  const { on } = await c.req.json<{ on: boolean }>();
  const p = await c.env.DB.prepare("SELECT handle, name, photo_url FROM people WHERE user_id = ?").bind(id).first<{ handle: string | null; name: string | null; photo_url: string | null }>();
  if (!p) return c.json({ error: "Persona non trovata" }, 404);
  if (!on) {
    await c.env.DB.batch([c.env.DB.prepare("DELETE FROM follows WHERE user_id = ?").bind(id), c.env.DB.prepare("DELETE FROM feed_items WHERE handle = ?").bind(p.handle ?? "")]);
    return c.json({ ok: true });
  }
  if (!p.handle) return c.json({ error: "Profilo non ancora identificato: riprova dopo la prossima lettura" }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM follows").first<{ n: number }>();
  if ((count?.n ?? 0) >= 10) return c.json({ error: "Massimo 10 profili osservati" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR REPLACE INTO follows (handle, user_id, name, photo_url, added_at) VALUES (?,?,?,?,?)").bind(p.handle, id, p.name, p.photo_url, Date.now()),
    c.env.DB.prepare("UPDATE people SET kind = 'creator' WHERE user_id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

app.post("/api/people/:id/topics", async (c) => {
  const key = await claudeKey(c.env);
  const id = Number(c.req.param("id"));
  const p = await c.env.DB.prepare("SELECT name, handle, posts FROM people WHERE user_id = ?").bind(id).first<{ name: string | null; handle: string | null; posts: string | null }>();
  if (!p) return c.json({ error: "Persona non trovata" }, 404);
  const notes = (await c.env.DB.prepare("SELECT body FROM feed_items WHERE handle = ? ORDER BY date DESC LIMIT 40").bind(p.handle ?? "").all<{ body: string }>()).results.map((r) => r.body);
  const posts = (p.posts ? JSON.parse(p.posts) : []).map((x: any) => x.title);
  if (notes.length + posts.length < 5) return c.json({ error: "Ancora troppo poco materiale: riprova dopo qualche giorno di osservazione" }, 400);
  const s = await getSettings(c.env);
  const topics = await analyzeCreator(key, UI_LANGS[s.language]?.name ?? "Italian", { name: p.name ?? p.handle ?? "", notes, posts });
  await c.env.DB.prepare("UPDATE people SET topics = ? WHERE user_id = ?").bind(JSON.stringify({ at: Date.now(), items: topics }), id).run();
  return c.json({ ok: true });
});

// Contact log: what I wrote to someone and how it went. Sending always happens by hand, outside the app.
app.get("/api/people/:id/contacts", async (c) => {
  return c.json((await c.env.DB.prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY date DESC LIMIT 100").bind(Number(c.req.param("id"))).all()).results);
});

app.post("/api/people/:id/contacts", async (c) => {
  const b = await c.req.json<{ kind?: string; text?: string; outcome?: string }>();
  if (!b.text?.trim() && !b.outcome?.trim()) return c.json({ error: "Scrivi cosa hai inviato o com'è andata" }, 400);
  await c.env.DB.prepare("INSERT INTO contacts (user_id, date, kind, text, outcome) VALUES (?,?,?,?,?)")
    .bind(Number(c.req.param("id")), Date.now(), String(b.kind ?? "").slice(0, 40), String(b.text ?? "").slice(0, 4000), String(b.outcome ?? "").slice(0, 1000))
    .run();
  return c.json({ ok: true });
});

app.post("/api/people/:id/message", async (c) => {
  const key = await claudeKey(c.env);
  const { kind } = await c.req.json<{ kind: string }>();
  if (!isMessageKind(kind)) return c.json({ error: "Tipo di messaggio non valido" }, 400);
  const id = Number(c.req.param("id"));
  const p = await c.env.DB.prepare("SELECT name, handle, publication, bio FROM people WHERE user_id = ?").bind(id).first<{ name: string | null; handle: string | null; publication: string | null; bio: string | null }>();
  if (!p) return c.json({ error: "Persona non trovata" }, 404);
  const last = await c.env.DB.prepare("SELECT body, note_body FROM activity WHERE author_id = ? ORDER BY date DESC LIMIT 1").bind(id).first<{ body: string; note_body: string | null }>();
  const facts = [
    p.publication ? `Writes the publication "${p.publication}"` : "",
    p.bio ? `Their bio: ${p.bio}` : "",
    last ? `They replied "${last.body.slice(0, 300)}" to the writer's Note "${(last.note_body ?? "").slice(0, 200)}"` : "",
  ].filter(Boolean);
  return c.json({ message: await personalMessage(key, await voice(c.env), kind, { name: p.name ?? p.handle ?? "", facts }) });
});

app.delete("/api/people/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM people WHERE user_id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------- growth sources ----------

app.get("/api/sources", async (c) => {
  const s = await getSettings(c.env);
  const sid = await getSid(c.env, s);
  if (!sid || !s.pub_subdomain) return c.json({ error: "Servono il cookie e una pubblicazione: riprova dopo il prossimo aggiornamento dei dati" }, 400);
  const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 7), 365);
  const d = await substack.getGrowthSources(s.pub_subdomain, days, sid);
  // Each source carries three metrics (traffic, subscribers, revenue): keep just those numbers.
  const pick = (metrics: any[]) => {
    const get = (word: string) => (metrics ?? []).find((m) => String(m?.name ?? "").toLowerCase().startsWith(word))?.total ?? null;
    return { traffic: get("traffic"), subscribers: get("subscriber"), revenue: get("revenue") };
  };
  return c.json({
    days,
    totals: pick(d.totals),
    sources: (d.sourceMetrics ?? []).map((x: any) => ({
      name: x.sourceName ?? x.source,
      ...pick(x.metrics),
      children: (x.children ?? []).map((ch: any) => ({ name: ch.sourceName ?? ch.source, ...pick(ch.metrics) })),
    })),
  });
});

app.post("/api/radar/sync", async (c) => {
  const s = await getSettings(c.env);
  const wait = 60 * 60_000 - (Date.now() - Number(s.last_radar_sync || 0));
  if (wait > 0) return c.json({ error: `I creator sono stati letti da poco: riprova tra ${Math.ceil(wait / 60_000)} minuti` }, 429);
  return c.json(await radarSync(c.env));
});

// ---------- trend ----------

app.get("/api/trend", async (c) => {
  return c.json((await c.env.DB.prepare("SELECT * FROM (SELECT * FROM snapshots ORDER BY day DESC LIMIT 120) ORDER BY day").all()).results);
});

// ---------- endpoint exploration ----------

/**
 * Tries the undocumented endpoints the next features would need and records only the shape of each answer
 * (field names and types, never values), so it can be read back without exposing account data.
 */
app.post("/api/explore", async (c) => {
  const s = await getSettings(c.env);
  const sid = await getSid(c.env, s);
  if (!sid || !s.handle) return c.json({ error: "Servono handle e cookie" }, 400);
  const me = await substack.getFullProfile(s.handle, sid);
  const note = await c.env.DB.prepare("SELECT substack_id FROM my_notes ORDER BY date DESC LIMIT 1").first<{ substack_id: string }>();
  const post = (await substack.getUserPosts(me.id, 1, sid).catch(() => []))[0];
  const W = "https://substack.com/api/v1";
  const P = me.pubSubdomain ? `https://${me.pubSubdomain}.substack.com/api/v1` : null;
  const urls = [
    `${W}/user/profile/self`, `${W}/activity/unread`, `${W}/activity`, `${W}/notifications`, `${W}/reader/notifications`,
    `${W}/activity/feed`, `${W}/inbox`, `${W}/subscriptions`, `${W}/feed/following`, `${W}/reader/feed?tab=following`,
    ...(note ? [`${W}/reader/comment/${note.substack_id}/reactions`, `${W}/reader/comment/${note.substack_id}/restacks`, `${W}/comment/${note.substack_id}/reactors`, `${W}/note_stats/${note.substack_id}`, `${W}/reader/comment/${note.substack_id}/stats`, `${W}/comment/${note.substack_id}/stats`, `${W}/notes/${note.substack_id}/stats`, `${W}/comment/${note.substack_id}/restackers`, `${W}/reader/comment/${note.substack_id}/restacked_by`] : []),
    ...(P
      ? [
          `${P}/archive?sort=new&limit=2`, `${P}/post_management/published?offset=0&limit=2&order_by=post_date&order_direction=desc`,
          `${P}/post_management/drafts?offset=0&limit=2`, `${P}/post_management/scheduled?offset=0&limit=2`, `${P}/drafts?limit=2`,
          `${P}/publish-dashboard/summary-v2?range=30`, `${P}/publication/stats/growth/sources?days=30`, `${P}/subscriber-stats`,
          `${P}/subscriber/stats`, `${P}/subscribers?limit=1`, `${P}/subscriptions/stats`, `${P}/publication_user/self`,
          ...(post ? [`${P}/post/${post.id}/comments?all_comments=true&sort=best_first`, `${P}/post_management/detail/${post.id}`, `${P}/post/${post.id}/reactors`] : []),
        ]
      : []),
  ];
  const results = [];
  for (const u of urls.slice(0, 40)) results.push(await substack.probe(u, sid));
  const report = { at: Date.now(), publication: me.pubSubdomain, has_note: !!note, has_post: !!post, results };
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('explore_result', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(report))
    .run();
  return c.json({ ok: true, tried: results.length, found: results.filter((r) => r.status === 200).length, results: results.map((r) => ({ url: r.url, status: r.status })) });
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        if (env.SUBSTACK_API_BASE) substack.setBase(env.SUBSTACK_API_BASE);
        await tick(env);
      })(),
    );
  },
};
