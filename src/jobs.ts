import { Env, getSettings, getSid, setSetting } from "./lib";
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
    "SELECT id FROM notes WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 3",
  )
    .bind(Date.now())
    .all<{ id: number }>();
  for (const r of results) await publishOne(env, r.id);
}

/** Pulls my notes + metrics, the notes of followed creators, and unanswered replies. */
export async function sync(env: Env, opts: { deep?: boolean } = {}) {
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
  const recent = mine.filter((n) => n.replies > 0 && now - n.date < 14 * 86400_000).slice(0, 12);
  for (const n of recent) {
    const replies = await substack.getReplies(n.id, sid);
    for (const r of replies) {
      if (r.userId === me) continue;
      if (r.answeredBy.includes(me)) {
        stmts.push(env.DB.prepare("UPDATE activity SET status = 'done' WHERE reply_id = ?").bind(r.id));
      } else {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO activity (reply_id, note_id, note_body, author_name, author_handle, body, date) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(reply_id) DO NOTHING`,
          ).bind(r.id, n.id, n.body.slice(0, 280), r.name, r.handle, r.body, r.date),
        );
      }
    }
  }

  // 3. Latest notes of the creators I follow
  const follows = await env.DB.prepare("SELECT handle, user_id FROM follows ORDER BY added_at LIMIT 20").all<{ handle: string; user_id: number }>();
  const errors: string[] = [];
  for (const f of follows.results) {
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

  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await setSetting(env, "last_sync", String(now));
  await setSetting(env, "last_sync_error", errors.join("; "));
  return { myNotes: mine.length, checkedForReplies: recent.length, follows: follows.results.length, errors };
}
