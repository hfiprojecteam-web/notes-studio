import { Env, getSettings, getSid, localParts, setSetting, zonedToUtc } from "./lib";
import * as substack from "./substack";

/** Publishes one queued note. Marks it `publishing` first so two runs can never post it twice. */
export async function publishOne(env: Env, id: number): Promise<{ ok: boolean; error?: string }> {
  const claim = await env.DB.prepare("UPDATE notes SET status = 'publishing' WHERE id = ? AND status IN ('scheduled','draft','failed')")
    .bind(id)
    .run();
  if (!claim.meta.changes) return { ok: false, error: "Note non trovata o già in pubblicazione" };

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

  // 3. Latest notes of the creators I follow
  const follows = others
    ? await env.DB.prepare("SELECT handle, user_id FROM follows ORDER BY added_at LIMIT 20").all<{ handle: string; user_id: number }>()
    : { results: [] as { handle: string; user_id: number }[] };
  const errors: string[] = [];
  for (const f of follows.results) {
    await nap(800, 2600);
    try {
      for (const n of await substack.getUserNotes(f.user_id, 1, sid)) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO feed_items (substack_id, handle, body, date, likes, restacks, replies) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(substack_id) DO UPDATE SET likes=excluded.likes, restacks=excluded.restacks, replies=excluded.replies`,
          ).bind(n.id, f.handle, n.body, n.date, n.likes, n.restacks, n.replies),
        );
      }
    } catch (e) {
      errors.push(`${f.handle}: ${e instanceof Error ? e.message : e}`);
    }
  }
  stmts.push(env.DB.prepare("DELETE FROM feed_items WHERE date < ?").bind(now - 30 * 86400_000));

  // 4. Daily snapshot of my own numbers, so trends can be drawn later
  try {
    const p = await substack.getFullProfile(s.handle, sid);
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
  if (others) await setSetting(env, "last_others_sync", String(now));
  await setSetting(env, "last_sync_error", errors.join("; "));
  return { myNotes: mine.length, others, checkedForReplies: recent.length, follows: follows.results.length, errors };
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
  if (!s.user_id) return;
  const now = Date.now();
  const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
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
