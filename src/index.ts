import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Env, encrypt, getSettings, getSid, localParts, zonedToUtc, makeSession, nextSlots, passwordMatches, sessionValid, setSetting } from "./lib";
import { checkCookie, personUpdate, publishOne, sync, tick } from "./jobs";
import { EMPTY_PROFILE, Voice, VoiceProfile, analyzeVoice, composeVoice, generateNotes, isRewriteMode, remixInspiration, rewriteNote, suggestReply } from "./generate";
import * as substack from "./substack";
import page from "../public/index.html";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  const status = err instanceof substack.SubstackError && err.status === 401 ? 502 : 500;
  return c.json({ error: err.message }, status);
});

app.use("*", async (c, next) => {
  if (c.env.SUBSTACK_API_BASE) substack.setBase(c.env.SUBSTACK_API_BASE);
  await next();
});

app.get("/", (c) => c.html(page, 200, { "Cache-Control": "no-cache", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" }));

// ---------- auth ----------

app.post("/api/login", async (c) => {
  const { password } = await c.req.json<{ password: string }>();
  if (!c.env.APP_PASSWORD || !c.env.SECRET_KEY) return c.json({ error: "APP_PASSWORD e SECRET_KEY non configurati" }, 500);
  if (!(await passwordMatches(c.env, password ?? ""))) return c.json({ error: "Password errata" }, 401);
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
    has_voice: !!composeVoice(readProfile(s)),
    has_cookie: !!s.sid_enc,
    has_claude_key: !!c.env.ANTHROPIC_API_KEY,
    last_sync: s.last_sync ? Number(s.last_sync) : null,
    last_sync_error: s.last_sync_error,
    cookie_ok: s.cookie_ok === "" ? null : s.cookie_ok === "1",
    cookie_checked_at: s.cookie_checked_at ? Number(s.cookie_checked_at) : null,
    paused: s.paused === "1",
    ai_drafts: s.ai_drafts === "1",
    next_others_sync: s.next_others_sync ? Number(s.next_others_sync) : null,
    last_others_sync: s.last_others_sync ? Number(s.last_others_sync) : null,
  });
});

app.put("/api/settings", async (c) => {
  const b = await c.req.json<{ handle?: string; timezone?: string; slots?: string[]; cookie?: string; paused?: boolean; ai_drafts?: boolean }>();
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
  if (b.paused !== undefined) await setSetting(c.env, "paused", b.paused ? "1" : "");
  if (b.ai_drafts !== undefined) await setSetting(c.env, "ai_drafts", b.ai_drafts ? "1" : "");
  if (b.cookie) {
    // Accept either the bare value or a pasted "substack.sid=..." pair.
    const sid = b.cookie.trim().replace(/^substack\.sid=/, "").split(";")[0];
    await setSetting(c.env, "sid_enc", await encrypt(c.env, sid));
    await checkCookie(c.env);
  }
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
  return c.json({ ok: true, created: bodies.length });
});

app.put("/api/notes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ body?: string; scheduled_at?: number | null }>();
  const note = await c.env.DB.prepare("SELECT status FROM notes WHERE id = ?").bind(id).first<{ status: string }>();
  if (!note) return c.json({ error: "Note non trovata" }, 404);
  if (note.status === "published" || note.status === "publishing") return c.json({ error: "Note già pubblicata" }, 409);
  if (b.body !== undefined) {
    if (!b.body.trim()) return c.json({ error: "Testo vuoto" }, 400);
    await c.env.DB.prepare("UPDATE notes SET body = ? WHERE id = ?").bind(b.body.trim(), id).run();
  }
  if (b.scheduled_at !== undefined) {
    await c.env.DB.prepare("UPDATE notes SET scheduled_at = ?, status = ?, error = NULL WHERE id = ?")
      .bind(b.scheduled_at, b.scheduled_at ? "scheduled" : "draft", id)
      .run();
  }
  return c.json({ ok: true });
});

app.delete("/api/notes/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM notes WHERE id = ? AND status != 'publishing'").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

/** Puts drafts into the next free time slots (all drafts, or the given ids). */
app.post("/api/notes/schedule", async (c) => {
  const b = await c.req.json<{ ids?: number[] }>().catch(() => ({}) as { ids?: number[] });
  const s = await getSettings(c.env);
  const drafts = (await c.env.DB.prepare("SELECT id FROM notes WHERE status = 'draft' ORDER BY created_at, id").all<{ id: number }>()).results
    .map((r) => r.id)
    .filter((id) => !b.ids || b.ids.includes(id));
  const taken = new Set(
    (await c.env.DB.prepare("SELECT scheduled_at FROM notes WHERE status = 'scheduled'").all<{ scheduled_at: number }>()).results.map((r) => r.scheduled_at),
  );
  const times = nextSlots(drafts.length, JSON.parse(s.slots), s.timezone, taken);
  if (times.length < drafts.length) return c.json({ error: "Nessuno slot orario configurato nelle Impostazioni" }, 400);
  if (drafts.length) {
    await c.env.DB.batch(
      drafts.map((id, i) => c.env.DB.prepare("UPDATE notes SET status = 'scheduled', scheduled_at = ? WHERE id = ?").bind(times[i], id)),
    );
  }
  return c.json({ ok: true, scheduled: drafts.length });
});

/** Sends every scheduled note back to drafts. */
app.post("/api/notes/unschedule", async (c) => {
  const r = await c.env.DB.prepare("UPDATE notes SET status = 'draft', scheduled_at = NULL WHERE status = 'scheduled'").run();
  return c.json({ ok: true, unscheduled: r.meta.changes });
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
  return c.json({ portrait: await analyzeVoice(key, texts, profile.language) });
});

/** Draft writing is off unless the owner switched it on in the settings. */
async function claudeKey(env: Env) {
  if ((await getSettings(env)).ai_drafts !== "1") throw new Error("La scrittura di bozze con Claude è disattivata (Impostazioni)");
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY non configurata su Cloudflare");
  return env.ANTHROPIC_API_KEY;
}

async function saveDrafts(env: Env, bodies: string[]) {
  const now = Date.now();
  if (bodies.length) {
    await env.DB.batch(bodies.map((body) => env.DB.prepare("INSERT INTO notes (body, status, source, created_at) VALUES (?, 'draft', 'generated', ?)").bind(body, now)));
  }
  return bodies.length;
}

app.post("/api/generate", async (c) => {
  const key = await claudeKey(c.env);
  const b = await c.req.json<{ count?: number; topic?: string; source_text?: string; source_url?: string; dry?: boolean }>();
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
  const bodies = await generateNotes(key, v, { count, topic: b.topic, sourceText, sourceTitle });
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
      slots: slots.map((label) => {
        const [h, min] = label.split(":").map(Number);
        return { label, ts: zonedToUtc(y, m, day, h, min, s.timezone) };
      }),
    });
  }
  return c.json({ timezone: s.timezone, offset, now: Date.now(), days });
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
  if ((count?.n ?? 0) >= 20) return c.json({ error: "Massimo 20 creator (limite delle richieste per sincronizzazione)" }, 400);
  const p = await substack.getProfile(clean);
  await c.env.DB.prepare("INSERT OR REPLACE INTO follows (handle, user_id, name, photo_url, added_at) VALUES (?,?,?,?,?)")
    .bind(p.handle, p.id, p.name, p.photoUrl, Date.now())
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

// ---------- people ----------

const TAGS = ["lettore", "creator", "imprenditore", "competitor", "coopetitor"];

app.get("/api/people", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, COUNT(a.reply_id) AS interactions, MAX(a.date) AS last_interaction,
            SUM(CASE WHEN a.status = 'open' THEN 1 ELSE 0 END) AS waiting
     FROM people p LEFT JOIN activity a ON a.author_id = p.user_id
     GROUP BY p.user_id ORDER BY waiting DESC, interactions DESC, COALESCE(p.followers, 0) DESC LIMIT 300`,
  ).all();
  return c.json({ tags: TAGS, people: results.map((r: any) => ({ ...r, subscriptions: r.subscriptions ? JSON.parse(r.subscriptions) : null })) });
});

/** Looks up any Substack profile by handle and stores it. */
app.post("/api/people", async (c) => {
  const { handle } = await c.req.json<{ handle: string }>();
  const clean = (handle ?? "").trim().replace(/^https?:\/\/substack\.com\/@/, "").replace(/^@/, "").split(/[/?]/)[0];
  if (!clean) return c.json({ error: "Handle mancante" }, 400);
  const sid = (await getSid(c.env, await getSettings(c.env))) ?? undefined;
  const p = await substack.getFullProfile(clean, sid);
  await personUpdate(c.env, p, Date.now()).run();
  return c.json({ ok: true, name: p.name, user_id: p.id });
});

app.put("/api/people/:id", async (c) => {
  const { tag } = await c.req.json<{ tag: string | null }>();
  if (tag && !TAGS.includes(tag)) return c.json({ error: "Etichetta non valida" }, 400);
  await c.env.DB.prepare("UPDATE people SET tag = ? WHERE user_id = ?").bind(tag || null, Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

app.delete("/api/people/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM people WHERE user_id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
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
    ...(note ? [`${W}/reader/comment/${note.substack_id}/reactions`, `${W}/reader/comment/${note.substack_id}/restacks`, `${W}/comment/${note.substack_id}/reactors`, `${W}/note_stats/${note.substack_id}`] : []),
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
