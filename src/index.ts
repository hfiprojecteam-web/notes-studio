import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Env, encrypt, getSettings, getSid, localParts, makeSession, nextSlots, passwordMatches, sessionValid, setSetting } from "./lib";
import { publishDue, publishOne, sync } from "./jobs";
import { generateNotes } from "./generate";
import * as substack from "./substack";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  const status = err instanceof substack.SubstackError && err.status === 401 ? 502 : 500;
  return c.json({ error: err.message }, status);
});

app.use("*", async (c, next) => {
  if (c.env.SUBSTACK_API_BASE) substack.setBase(c.env.SUBSTACK_API_BASE);
  await next();
});

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
    voice_prompt: s.voice_prompt,
    has_cookie: !!s.sid_enc,
    has_claude_key: !!c.env.ANTHROPIC_API_KEY,
    last_sync: s.last_sync ? Number(s.last_sync) : null,
    last_sync_error: s.last_sync_error,
  });
});

app.put("/api/settings", async (c) => {
  const b = await c.req.json<{ handle?: string; timezone?: string; slots?: string[]; voice_prompt?: string; cookie?: string }>();
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
  if (b.voice_prompt !== undefined) await setSetting(c.env, "voice_prompt", b.voice_prompt);
  if (b.cookie) {
    // Accept either the bare value or a pasted "substack.sid=..." pair.
    const sid = b.cookie.trim().replace(/^substack\.sid=/, "").split(";")[0];
    await setSetting(c.env, "sid_enc", await encrypt(c.env, sid));
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
    return `${(await substack.getUserNotes(Number(s.user_id), 1)).length} Notes nella prima pagina`;
  });
  await run("Cookie di sessione", async () => {
    const sid = await getSid(c.env, s);
    if (!sid) throw new Error("Cookie non impostato");
    const me = await substack.whoAmI(sid);
    if (s.user_id && String(me.id) !== s.user_id) throw new Error(`Il cookie appartiene a un altro account (${me.handle ?? me.id})`);
    return `Valido per ${me.name ?? me.handle ?? me.id}`;
  });
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

app.post("/api/generate", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY non configurata" }, 400);
  const b = await c.req.json<{ count?: number; topic?: string; source_text?: string; source_url?: string }>();
  const count = Math.min(Math.max(Number(b.count) || 5, 1), 20);
  let sourceText = b.source_text?.trim();
  let sourceTitle: string | undefined;
  if (!sourceText && b.source_url?.trim()) {
    const post = await substack.getPostText(b.source_url.trim());
    sourceText = post.text;
    sourceTitle = post.title;
  }
  if (!sourceText && !b.topic?.trim()) return c.json({ error: "Indica un'idea, un testo o il link di un post" }, 400);

  const s = await getSettings(c.env);
  // Voice reference: the best-performing notes plus the most recent ones.
  const top = await c.env.DB.prepare("SELECT substack_id, body FROM my_notes WHERE length(body) > 40 ORDER BY likes + restacks * 2 DESC LIMIT 12").all<{
    substack_id: string;
    body: string;
  }>();
  const latest = await c.env.DB.prepare("SELECT substack_id, body FROM my_notes WHERE length(body) > 40 ORDER BY date DESC LIMIT 8").all<{
    substack_id: string;
    body: string;
  }>();
  const examples = [...new Map([...top.results, ...latest.results].map((r) => [r.substack_id, r.body])).values()];

  const bodies = await generateNotes({
    apiKey: c.env.ANTHROPIC_API_KEY,
    count,
    topic: b.topic,
    sourceText,
    sourceTitle,
    voicePrompt: s.voice_prompt,
    examples,
  });
  const now = Date.now();
  await c.env.DB.batch(
    bodies.map((body) => c.env.DB.prepare("INSERT INTO notes (body, status, source, created_at) VALUES (?, 'draft', 'generated', ?)").bind(body, now)),
  );
  return c.json({ ok: true, created: bodies.length, examples_used: examples.length });
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
  return c.json(await sync(c.env, { deep }));
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
    "SELECT f.*, w.name, w.photo_url FROM feed_items f JOIN follows w ON w.handle = f.handle ORDER BY f.date DESC LIMIT 150",
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

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        if (env.SUBSTACK_API_BASE) substack.setBase(env.SUBSTACK_API_BASE);
        await publishDue(env);
        // Refresh metrics, feed and replies every 30 minutes.
        if (new Date(event.scheduledTime).getUTCMinutes() % 30 === 0) {
          try {
            await sync(env);
          } catch (e) {
            await setSetting(env, "last_sync_error", e instanceof Error ? e.message : String(e));
          }
        }
      })(),
    );
  },
};
