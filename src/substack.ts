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
}

async function call(path: string, init: RequestInit = {}, sid?: string): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", UA);
  headers.set("Accept", "application/json");
  if (sid) headers.set("Cookie", `substack.sid=${sid}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
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

/** Notes written by a user, newest first. Follows `nextCursor` for up to `pages` pages. */
export async function getUserNotes(userId: number, pages = 1): Promise<RemoteNote[]> {
  const out: RemoteNote[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < pages; i++) {
    const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const data = await call(`/reader/feed/profile/${userId}?types=note${q}`);
    for (const item of data.items ?? []) {
      // Skip restacks of other people's notes: keep only notes authored by this user.
      if (item.type === "comment" && item.comment?.user_id === userId) out.push(toNote(item.comment));
    }
    cursor = data.nextCursor ?? null;
    if (!cursor) break;
  }
  return out;
}

export async function getReplies(noteId: string): Promise<RemoteReply[]> {
  const data = await call(`/reader/comment/${noteId}/replies`);
  return (data.commentBranches ?? []).map((b: any) => ({
    id: String(b.comment.id),
    userId: b.comment.user_id,
    name: b.comment.name ?? null,
    handle: b.comment.handle ?? null,
    body: b.comment.body ?? "",
    date: Date.parse(b.comment.date),
    answeredBy: (b.descendantComments ?? []).map((d: any) => d.comment?.user_id).filter(Boolean),
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
