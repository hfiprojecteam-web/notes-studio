import { Env, getSettings, getSid, localParts, setSetting, zonedToUtc } from "./lib";
import * as substack from "./substack";
import { trServer } from "./i18n";

/** Publishes one queued note. Marks it `publishing` first so two runs can never post it twice. */
export async function publishOne(env: Env, id: number): Promise<{ ok: boolean; error?: string }> {
  const claim = await env.DB.prepare("UPDATE notes SET status = 'publishing' WHERE id = ? AND status IN ('scheduled','draft','failed') AND reviewed = 1")
    .bind(id)
    .run();
  if (!claim.meta.changes) return { ok: false, error: "Note non trovata, già in pubblicazione, o spunto di Claude non ancora riscritto" };

  const note = await env.DB.prepare("SELECT body FROM notes WHERE id = ?").bind(id).first<{ body: string }>();
  const sid = await getSid(env, await getSettings(env));
  try {
    if (!sid) throw new Error("Cookie Substack mancante: inseriscilo nelle Impostazioni");
    const substackId = await substack.publishNote(sid, note!.body);
    await env.DB.prepare("UPDATE notes SET status = 'published', published_at = ?, substack_id = ?, error = NULL WHERE id = ?")
      .bind(Date.now(), substackId, id)
      .run();
    return { ok: true };
  } catch (e) {
    // No automatic retry: if Substack accepted the note but the response was lost, a retry would double-post.
    const error = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE notes SET status = 'failed', error = ? WHERE id = ?").bind(error, id).run();
    await raiseAlert(env, "publish", "Una Note non è stata pubblicata", `${error}: ${note!.body.slice(0, 120)}`);
    return { ok: false, error };
  }
}

export async function publishDue(env: Env) {
  const { results } = await env.DB.prepare(
    // Each note goes out up to 6 minutes after its slot (a fixed offset per note), never on the exact minute.
    "SELECT id FROM notes WHERE status = 'scheduled' AND scheduled_at + (id % 7) * 60000 <= ? ORDER BY scheduled_at LIMIT 2",
  )
    .bind(Date.now())
    .all<{ id: number }>();
  for (const r of results) await publishOne(env, r.id);
}

/** A short random pause, so a run does not hit Substack with a burst of evenly spaced requests. */
const nap = (minMs: number, maxMs: number) => new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));

/**
 * Pulls my own notes and numbers. With `others`, also reads other people's content
 * (replies to my notes, followed creators, people profiles): that part runs once a day.
 */
export async function sync(env: Env, opts: { deep?: boolean; others?: boolean } = {}) {
  const others = opts.others ?? false;
  const s = await getSettings(env);
  if (!s.user_id) throw new Error("Imposta prima il tuo handle Substack nelle Impostazioni");
  const me = Number(s.user_id);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  // 1. My notes and their metrics (deep = first import, goes further back)
  // Signed-in requests are rate-limited per account instead of per (shared) Cloudflare address.
  const sid = (await getSid(env, s)) ?? undefined;
  const mine = await substack.getUserNotes(me, opts.deep ? 12 : 2, sid);
  for (const n of mine) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO my_notes (substack_id, body, date, likes, restacks, replies, synced_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(substack_id) DO UPDATE SET body=excluded.body, likes=excluded.likes, restacks=excluded.restacks, replies=excluded.replies, synced_at=excluded.synced_at`,
      ).bind(n.id, n.body, n.date, n.likes, n.restacks, n.replies, now),
    );
  }

  // 1b. What each recent note brought in (follows, subscriptions, clicks): my own dashboard data
  if (sid) {
    for (const n of mine.filter((x) => now - x.date < 30 * 86400_000).slice(0, 10)) {
      await nap(500, 1500);
      try {
        const st = await substack.getNoteStats(n.id, sid);
        if (st) {
          stmts.push(
            env.DB.prepare("UPDATE my_notes SET follows=?, free_subs=?, paid_subs=?, clicks=?, share_clicks=?, arr=?, stats_at=? WHERE substack_id=?").bind(
              st.follows, st.freeSubs, st.paidSubs, st.clicks, st.shareClicks, st.arr, now, n.id,
            ),
          );
        }
      } catch {
        break; // a refusal here means the cookie or the endpoint is off: stop asking for this run
      }
    }
  }

  // 2. Replies to my recent notes that I have not answered
  const recent = others ? mine.filter((n) => n.replies > 0 && now - n.date < 14 * 86400_000).slice(0, 12) : [];
  for (const n of recent) {
    await nap(800, 2600);
    const replies = await substack.getReplies(n.id, sid);
    for (const r of replies) {
      if (r.userId === me) continue;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO people (user_id, handle, name, photo_url, publication, pub_subdomain, added_at) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET name = COALESCE(excluded.name, name), handle = COALESCE(excluded.handle, handle),
             photo_url = COALESCE(excluded.photo_url, photo_url), publication = COALESCE(publication, excluded.publication),
             pub_subdomain = COALESCE(pub_subdomain, excluded.pub_subdomain)`,
        ).bind(r.userId, r.handle, r.name, r.photoUrl, r.pubName, r.pubSubdomain, now),
      );
      if (r.answeredBy.includes(me)) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO activity (reply_id, note_id, note_body, author_name, author_handle, body, date, author_id, status) VALUES (?,?,?,?,?,?,?,?, 'done')
             ON CONFLICT(reply_id) DO UPDATE SET status = 'done', author_id = excluded.author_id`,
          ).bind(r.id, n.id, n.body.slice(0, 280), r.name, r.handle, r.body, r.date, r.userId),
        );
      } else {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO activity (reply_id, note_id, note_body, author_name, author_handle, body, date, author_id) VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(reply_id) DO UPDATE SET author_id = excluded.author_id`,
          ).bind(r.id, n.id, n.body.slice(0, 280), r.name, r.handle, r.body, r.date, r.userId),
        );
      }
    }
  }

  const errors: string[] = [];
  stmts.push(env.DB.prepare("DELETE FROM feed_items WHERE date < ?").bind(now - 30 * 86400_000));

  // 4. Daily snapshot of my own numbers, so trends can be drawn later
  try {
    const p = await substack.getFullProfile(s.handle, sid);
    if (p.pubSubdomain) await setSetting(env, "pub_subdomain", p.pubSubdomain);
    const lp = localParts(now, s.timezone);
    const day = `${lp.y}-${String(lp.m).padStart(2, "0")}-${String(lp.d).padStart(2, "0")}`;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO snapshots (day, followers, subscribers, notes, likes, restacks, replies)
         SELECT ?, ?, ?, COUNT(*), COALESCE(SUM(likes),0), COALESCE(SUM(restacks),0), COALESCE(SUM(replies),0) FROM my_notes WHERE true
         ON CONFLICT(day) DO UPDATE SET followers=excluded.followers, subscribers=excluded.subscribers, notes=excluded.notes,
           likes=excluded.likes, restacks=excluded.restacks, replies=excluded.replies`,
      ).bind(day, p.followers, p.subscribers),
    );
  } catch (e) {
    errors.push(`istantanea: ${e instanceof Error ? e.message : e}`);
  }

  // People found through replies have no handle yet: resolve a few per run from one of their replies.
  const nameless = others
    ? await env.DB.prepare(
    "SELECT p.user_id, MAX(a.reply_id) AS reply_id FROM people p JOIN activity a ON a.author_id = p.user_id WHERE p.handle IS NULL GROUP BY p.user_id LIMIT 4",
  ).all<{ user_id: number; reply_id: string }>()
    : { results: [] as { user_id: number; reply_id: string }[] };
  for (const person of nameless.results) {
    await nap(800, 2600);
    try {
      const handle = await substack.getNoteAuthorHandle(person.reply_id, sid);
      if (handle) stmts.push(env.DB.prepare("UPDATE people SET handle = ? WHERE user_id = ?").bind(handle, person.user_id));
    } catch {
      /* try again on the next run */
    }
  }

  // 5. Refresh a few people profiles per run (audience size and public subscriptions)
  const stale = others
    ? await env.DB.prepare(
    "SELECT user_id, handle FROM people WHERE handle IS NOT NULL AND (refreshed_at IS NULL OR refreshed_at < ?) ORDER BY refreshed_at IS NOT NULL, refreshed_at LIMIT 5",
  )
    .bind(now - 7 * 86400_000)
    .all<{ user_id: number; handle: string }>()
    : { results: [] as { user_id: number; handle: string }[] };
  for (const person of stale.results) {
    await nap(800, 2600);
    try {
      stmts.push(personUpdate(env, await substack.getFullProfile(person.handle, sid), now));
    } catch {
      stmts.push(env.DB.prepare("UPDATE people SET refreshed_at = ? WHERE user_id = ?").bind(now, person.user_id));
    }
  }

  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await setSetting(env, "last_sync", String(now));
  if (others) {
    const due = await env.DB.prepare("SELECT user_id, name, handle, next_step, next_date FROM people WHERE circle = 1 AND next_date IS NOT NULL AND next_date <= ? LIMIT 10")
      .bind(now + 12 * 3600_000)
      .all<{ user_id: number; name: string | null; handle: string | null; next_step: string | null; next_date: number }>();
    for (const p of due.results) {
      await raiseAlert(env, "step", "Prossimo passo in scadenza", `${p.name ?? p.handle ?? ""}: ${p.next_step || ""}`, `step:${p.user_id}:${p.next_date}`);
    }
  }
  if (others) await setSetting(env, "last_others_sync", String(now));
  await setSetting(env, "last_sync_error", errors.join("; "));
  return { myNotes: mine.length, others, checkedForReplies: recent.length, errors };
}

/** Records whether the saved session cookie still works. Only a sign-in refusal counts as broken. */
export async function checkCookie(env: Env): Promise<boolean | null> {
  const s = await getSettings(env);
  const sid = await getSid(env, s);
  let ok: boolean | null = null;
  if (sid) {
    try {
      const me = await substack.whoAmI(sid);
      ok = !s.user_id || !me.id || String(me.id) === s.user_id;
    } catch (e) {
      // A network hiccup or a rate limit says nothing about the cookie: leave the state unknown.
      ok = e instanceof substack.SubstackError && (e.status === 401 || e.status === 403) ? false : null;
    }
  }
  if (ok === false && s.cookie_ok !== "0") {
    await raiseAlert(env, "cookie", "Il collegamento a Substack si è interrotto", "Reinserisci il cookie nelle Impostazioni: fino ad allora le Notes in coda non usciranno.");
  }
  if (ok !== null || !sid) await setSetting(env, "cookie_ok", ok === null ? "" : ok ? "1" : "0");
  await setSetting(env, "cookie_checked_at", String(Date.now()));
  return ok;
}

/** Upserts a person from a full public profile. */
export function personUpdate(env: Env, p: substack.FullProfile, now: number) {
  return env.DB.prepare(
    `INSERT INTO people (user_id, handle, name, photo_url, bio, followers, subscribers, publication, pub_subdomain, subscriptions, subs_truncated, refreshed_at, added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET handle=excluded.handle, name=excluded.name, photo_url=excluded.photo_url, bio=excluded.bio,
       followers=excluded.followers, subscribers=excluded.subscribers, publication=excluded.publication, pub_subdomain=excluded.pub_subdomain,
       subscriptions=excluded.subscriptions, subs_truncated=excluded.subs_truncated, refreshed_at=excluded.refreshed_at`,
  ).bind(p.id, p.handle, p.name, p.photoUrl, p.bio, p.followers, p.subscribers, p.pubName, p.pubSubdomain, JSON.stringify(p.subscriptions), p.subscriptionsTruncated ? 1 : 0, now, now);
}

/**
 * Decides, minute by minute, what the scheduler should do. Reads of other people's content happen once a day at a
 * random time between 07:00 and 22:00; my own numbers refresh every 3 to 5 hours. Nothing runs while paused.
 */
export async function tick(env: Env) {
  const s = await getSettings(env);
  if (s.paused === "1") return;
  await publishDue(env);
  const stuck = await env.DB.prepare("SELECT id, body FROM notes WHERE status = 'publishing' AND scheduled_at < ? LIMIT 5").bind(Date.now() - 15 * 60_000).all<{ id: number; body: string }>();
  for (const n of stuck.results) {
    await raiseAlert(env, "stuck", "Una Note è bloccata in pubblicazione", `Controlla su Substack se è uscita prima di ripubblicarla: ${n.body.slice(0, 120)}`, `stuck:${n.id}`);
  }
  if (!s.user_id) return;
  const now = Date.now();
  const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
  // Watched creators have their own daily slot, so one invocation never does both batches of reads.
  if (!s.next_radar_sync || now >= Number(s.next_radar_sync)) {
    const t = localParts(now + 86400_000, s.timezone);
    await setSetting(env, "next_radar_sync", String(zonedToUtc(t.y, t.m, t.d, rand(7, 22), rand(0, 60), s.timezone)));
    try {
      await radarSync(env);
    } catch (e) {
      await setSetting(env, "last_sync_error", e instanceof Error ? e.message : String(e));
    }
    return;
  }
  const dueOthers = !s.next_others_sync || now >= Number(s.next_others_sync);
  const dueOwn = !s.next_own_sync || now >= Number(s.next_own_sync);
  if (!dueOthers && !dueOwn) return;
  // Set the next times first: if this run fails midway, it must not repeat every minute.
  await setSetting(env, "next_own_sync", String(now + rand(180, 300) * 60_000));
  if (dueOthers) {
    const t = localParts(now + 86400_000, s.timezone);
    await setSetting(env, "next_others_sync", String(zonedToUtc(t.y, t.m, t.d, rand(7, 22), rand(0, 60), s.timezone)));
  }
  try {
    await checkCookie(env);
    await sync(env, { others: dueOthers });
  } catch (e) {
    await setSetting(env, "last_sync_error", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Reads the watched creators (at most 10): their latest notes, their recent posts and their public profile.
 * Runs once a day at its own random time, separate from the other reads so each run stays small.
 */
export async function radarSync(env: Env) {
  const s = await getSettings(env);
  const sid = (await getSid(env, s)) ?? undefined;
  const now = Date.now();
  const lp = localParts(now, s.timezone);
  const day = `${lp.y}-${String(lp.m).padStart(2, "0")}-${String(lp.d).padStart(2, "0")}`;
  const follows = await env.DB.prepare("SELECT handle, user_id FROM follows ORDER BY added_at LIMIT 10").all<{ handle: string; user_id: number }>();
  const stmts: D1PreparedStatement[] = [];
  const errors: string[] = [];
  for (const f of follows.results) {
    try {
      await nap(900, 2800);
      for (const n of await substack.getUserNotes(f.user_id, 1, sid)) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO feed_items (substack_id, handle, body, date, likes, restacks, replies) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(substack_id) DO UPDATE SET likes=excluded.likes, restacks=excluded.restacks, replies=excluded.replies`,
          ).bind(n.id, f.handle, n.body, n.date, n.likes, n.restacks, n.replies),
        );
      }
      await nap(900, 2800);
      const posts = await substack.getUserPosts(f.user_id, 12, sid);
      await nap(900, 2800);
      const profile = await substack.getFullProfile(f.handle, sid);
      stmts.push(personUpdate(env, profile, now));
      stmts.push(env.DB.prepare("UPDATE people SET kind = COALESCE(kind, 'creator'), posts = ? WHERE user_id = ?").bind(JSON.stringify(posts), f.user_id));
      if (profile.followers != null) {
        stmts.push(env.DB.prepare("INSERT INTO creator_snapshots (user_id, day, followers) VALUES (?,?,?) ON CONFLICT(user_id, day) DO UPDATE SET followers = excluded.followers").bind(f.user_id, day, profile.followers));
      }
    } catch (e) {
      errors.push(`${f.handle}: ${e instanceof Error ? e.message : e}`);
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await setSetting(env, "last_radar_sync", String(now));
  if (errors.length) await setSetting(env, "last_sync_error", errors.join("; "));
  return { creators: follows.results.length, errors };
}

/**
 * Records a problem the writer must know about and, when an address is configured, pushes it there too.
 * `ref` makes an alert unique: the same ref is never raised twice. Returns whether the push went out.
 */
export async function raiseAlert(env: Env, kind: string, title: string, detail: string, ref?: string): Promise<boolean> {
  const r = await env.DB.prepare("INSERT INTO alerts (at, kind, title, detail, ref) VALUES (?,?,?,?,?) ON CONFLICT(ref) DO NOTHING")
    .bind(Date.now(), kind, title, detail.slice(0, 500), ref ?? null)
    .run();
  if (!r.meta.changes) return false;
  const s = await getSettings(env);
  if (!s.alert_url) return false;
  try {
    // Plain text with a Title header: understood by ntfy-style services and readable by any webhook.
    const res = await fetch(s.alert_url, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8", Title: "Notes Studio", Tags: "warning" },
      body: `${trServer(s.language, title)}\n${detail.slice(0, 300)}`,
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
