// Client for Substack's internal (undocumented) web API.
// Read endpoints are public and were verified on 2026-11-11.
// Write endpoints need the user's `substack.sid` session cookie and may change without notice.

let BASE = "https://substack.com/api/v1";

/** Points the client at another origin (local tests behind a proxy). */
export function setBase(url: string) {
  BASE = url;
}
// An honest client name: Substack's bot filter rejects requests that claim to be a browser but are not (verified: 403).
const UA = "notes-studio/1.0";

export class SubstackError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface RemoteNote {
  id: string;
  userId: number;
  handle: string | null;
  name: string | null;
  body: string;
  date: number;
  likes: number;
  restacks: number;
  replies: number;
}

export interface RemoteReply {
  id: string;
  userId: number;
  name: string | null;
  handle: string | null;
  body: string;
  date: number;
  answeredBy: number[]; // user ids found among the descendants
  photoUrl: string | null;
  pubName: string | null;
  pubSubdomain: string | null;
}

export interface FullProfile {
  id: number;
  handle: string;
  name: string | null;
  photoUrl: string | null;
  bio: string | null;
  followers: number | null;
  subscribers: string | null; // Substack only publishes a rounded figure, e.g. "8.2K+"
  pubName: string | null;
  pubSubdomain: string | null;
  subscriptions: { name: string; subdomain: string | null; state: string; founding: boolean }[];
  subscriptionsTruncated: boolean;
}

async function call(path: string, init: RequestInit = {}, sid?: string): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", UA);
  headers.set("Accept", "application/json");
  if (sid) headers.set("Cookie", `substack.sid=${sid}`);
  let res = await fetch(`${BASE}${path}`, { ...init, headers });
  // Reads are safe to repeat: on a rate limit wait briefly and try once more. Writes are never retried.
  if (res.status === 429 && (init.method ?? "GET") === "GET") {
    const wait = Math.min(Number(res.headers.get("Retry-After")) || 3, 8);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = res.status === 429 ? "Substack sta limitando le richieste (HTTP 429): riprova tra qualche minuto" : `HTTP ${res.status}`;
    try {
      msg = JSON.parse(text).errors?.[0]?.msg ?? msg;
    } catch {
      /* non-JSON error page */
    }
    throw new SubstackError(msg, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SubstackError("Risposta non JSON da Substack", res.status);
  }
}

function toNote(c: any): RemoteNote {
  return {
    id: String(c.id),
    userId: c.user_id,
    handle: c.handle ?? null,
    name: c.name ?? null,
    body: c.body ?? "",
    date: Date.parse(c.date),
    likes: c.reaction_count ?? 0,
    restacks: c.restacks ?? 0,
    replies: c.children_count ?? 0,
  };
}

export async function getProfile(handle: string) {
  const p = await call(`/user/${encodeURIComponent(handle)}/public_profile`);
  return {
    id: p.id as number,
    handle: p.handle as string,
    name: (p.name ?? null) as string | null,
    photoUrl: (p.photo_url ?? null) as string | null,
  };
}

/** Public profile with audience size and the publications this person publicly subscribes to. */
export async function getFullProfile(handle: string, sid?: string): Promise<FullProfile> {
  const p = await call(`/user/${encodeURIComponent(handle)}/public_profile`, {}, sid);
  const pub = p.primaryPublication ?? (p.publicationUsers ?? []).find((u: any) => u.is_primary)?.publication ?? null;
  return {
    id: p.id,
    handle: p.handle,
    name: p.name ?? null,
    photoUrl: p.photo_url ?? null,
    bio: p.bio ?? null,
    followers: typeof p.followerCount === "number" ? p.followerCount : null,
    subscribers: p.subscriberCount ? String(p.subscriberCount) : null,
    pubName: pub?.name ?? null,
    pubSubdomain: pub?.subdomain ?? null,
    subscriptions: (p.subscriptions ?? []).map((x: any) => ({
      name: x.publication?.name ?? "?",
      subdomain: x.publication?.subdomain ?? null,
      state: String(x.membership_state ?? ""),
      founding: !!x.is_founding,
    })),
    subscriptionsTruncated: !!p.subscriptionsTruncated,
  };
}

/** Replies in a thread carry no handle; looking the reply up on its own does. */
export async function getNoteAuthorHandle(noteId: string, sid?: string): Promise<string | null> {
  const d = await call(`/reader/comment/${noteId}`, {}, sid);
  return d?.item?.comment?.handle ?? null;
}

export interface NoteStats {
  follows: number;
  freeSubs: number;
  paidSubs: number;
  clicks: number;
  shareClicks: number;
  arr: number;
}

/** What one of my own Notes brought in: follows, subscriptions and clicks. Needs the session cookie. */
export async function getNoteStats(noteId: string, sid: string): Promise<NoteStats | null> {
  const d = await call(`/reader/comment/${noteId}/stats`, {}, sid);
  const f = d?.item?.feedItemStats;
  if (!f) return null;
  return {
    follows: f.total_follows ?? 0,
    freeSubs: f.total_free_subscriptions ?? 0,
    paidSubs: f.total_paid_subscriptions ?? 0,
    clicks: f.total_clicks ?? 0,
    shareClicks: f.total_share_clicks ?? 0,
    arr: f.total_arr ?? 0,
  };
}

/** Where new subscribers of my publication came from, as Substack's own dashboard reports it. */
export async function getGrowthSources(subdomain: string, days: number, sid: string): Promise<any> {
  const res = await fetch(`https://${subdomain}.substack.com/api/v1/publication/stats/growth/sources?days=${days}`, {
    headers: { "User-Agent": UA, Accept: "application/json", Cookie: `substack.sid=${sid}` },
  });
  if (!res.ok) throw new SubstackError(`Fonti di crescita non disponibili (HTTP ${res.status})`, res.status);
  return res.json();
}

/** Published posts of a user with their public counters, newest first. */
export async function getUserPosts(userId: number, limit = 12, sid?: string) {
  const d = await call(`/profile/posts?profile_user_id=${userId}&limit=${limit}`, {}, sid);
  return (d.posts ?? []).map((p: any) => ({
    id: String(p.id),
    title: String(p.title ?? ""),
    url: String(p.canonical_url ?? ""),
    date: Date.parse(p.post_date),
    likes: p.reaction_count ?? 0,
    comments: p.comment_count ?? 0,
    restacks: p.restacks ?? 0,
    words: p.wordcount ?? 0,
    audience: String(p.audience ?? ""),
  }));
}

/**
 * Calls a GET endpoint and describes the shape of the answer without returning any value.
 * Used to find out which undocumented endpoints exist for a signed-in account.
 */
export async function probe(url: string, sid: string) {
  const shape = (v: any, depth: number): any => {
    if (Array.isArray(v)) return depth <= 0 ? `array(${v.length})` : [`array(${v.length})`, v.length ? shape(v[0], depth - 1) : null];
    if (v && typeof v === "object") return depth <= 0 ? "object" : Object.fromEntries(Object.keys(v).slice(0, 40).map((k) => [k, shape(v[k], depth - 1)]));
    return v === null ? "null" : typeof v;
  };
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: `substack.sid=${sid}` } });
    const text = await res.text();
    let body: any = null;
    try {
      body = shape(JSON.parse(text), 4);
    } catch {
      body = `non-JSON (${text.length} bytes)`;
    }
    return { url, status: res.status, shape: res.ok ? body : null };
  } catch (e) {
    return { url, status: 0, shape: e instanceof Error ? e.message : String(e) };
  }
}

/** Notes written by a user, newest first. Follows `nextCursor` for up to `pages` pages. */
export async function getUserNotes(userId: number, pages = 1, sid?: string): Promise<RemoteNote[]> {
  const out: RemoteNote[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < pages; i++) {
    const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await call(`/reader/feed/profile/${userId}?types=note${q}`, {}, sid);
    for (const item of data.items ?? []) {
      // Skip restacks of other people's notes: keep only notes authored by this user.
      if (item.type === "comment" && item.comment?.user_id === userId) out.push(toNote(item.comment));
    }
    cursor = data.nextCursor ?? null;
    if (!cursor) break;
  }
  return out;
}

export async function getReplies(noteId: string, sid?: string): Promise<RemoteReply[]> {
  const data = await call(`/reader/comment/${noteId}/replies`, {}, sid);
  return (data.commentBranches ?? []).map((b: any) => ({
    id: String(b.comment.id),
    userId: b.comment.user_id,
    name: b.comment.name ?? null,
    handle: b.comment.handle ?? null,
    body: b.comment.body ?? "",
    date: Date.parse(b.comment.date),
    answeredBy: (b.descendantComments ?? []).map((d: any) => d.comment?.user_id).filter(Boolean),
    photoUrl: b.comment.photo_url ?? null,
    pubName: b.comment.user_primary_publication?.name ?? null,
    pubSubdomain: b.comment.user_primary_publication?.subdomain ?? null,
  }));
}

/** Plain text -> the ProseMirror document Substack stores for a note. */
export function textToBodyJson(text: string) {
  const urlRe = /(https?:\/\/[^\s]+)/g;
  const paragraphs = text
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: "doc",
    attrs: { schemaVersion: "v1" },
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: p
        .split(urlRe)
        .filter(Boolean)
        .map((part) =>
          /^https?:\/\//.test(part)
            ? { type: "text", text: part, marks: [{ type: "link", attrs: { href: part } }] }
            : { type: "text", text: part },
        ),
    })),
  };
}

/** Publishes a note (or a reply when `parentId` is set). Returns the new note id. */
export async function publishNote(sid: string, text: string, parentId?: string): Promise<string> {
  const body: Record<string, unknown> = {
    bodyJson: textToBodyJson(text),
    tabId: "for-you",
    surface: "feed",
    replyMinimumRole: "everyone",
  };
  if (parentId) body.parent_id = Number(parentId);
  const data = await call(
    "/comment/feed",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    sid,
  );
  const id = data?.id ?? data?.comment?.id;
  if (!id) throw new SubstackError("Substack non ha restituito l'id della Note", 200);
  return String(id);
}

/** Checks the session cookie. Returns the logged-in user's id and handle. */
export async function whoAmI(sid: string) {
  const p = await call("/user/profile/self", {}, sid);
  return { id: p.id as number, handle: (p.handle ?? null) as string | null, name: (p.name ?? null) as string | null };
}

/** Text of a Substack post, from its public URL. */
export async function getPostText(url: string): Promise<{ title: string; text: string }> {
  const u = new URL(url);
  const slug = u.pathname.match(/\/p\/([^/?#]+)/)?.[1];
  if (!slug) throw new SubstackError("URL non riconosciuto: serve un link .../p/titolo-del-post", 400);
  const res = await fetch(`${u.origin}/api/v1/posts/${slug}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new SubstackError(`Impossibile leggere il post (HTTP ${res.status})`, res.status);
  const post: any = await res.json();
  const text = String(post.body_html ?? "")
    .replace(/<\/(p|h\d|li|blockquote)>/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new SubstackError("Il post non ha testo leggibile (forse è a pagamento)", 422);
  return { title: post.title ?? "", text };
}
