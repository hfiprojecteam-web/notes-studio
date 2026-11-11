// A small Model Context Protocol server (Streamable HTTP, stateless) so that Claude or another assistant can read
// Notes Studio and leave drafts in it. It can never schedule, publish, reply or contact anyone.

type Api = (path: string, init?: { method?: string; body?: unknown }) => Promise<any>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (args: any, api: Api) => Promise<unknown>;
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const READ = { readOnlyHint: true };
const cut = (t: string, n = 600) => (t && t.length > n ? t.slice(0, n) + "…" : t);

const TOOLS: Tool[] = [
  {
    name: "get_overview",
    description: "Start here. Returns the writer's Substack handle, the app language, how many drafts and scheduled Notes there are, and the writer's voice profile (who they are, audience, tone, words to use and avoid). Read the voice profile before proposing any text.",
    inputSchema: obj(),
    annotations: READ,
    run: async (_a, api) => {
      const [s, notes, voice] = await Promise.all([api("/settings"), api("/notes"), api("/voice")]);
      const count = (st: string) => notes.filter((n: any) => n.status === st).length;
      const p = voice.profile;
      return {
        handle: s.handle, language: s.language, timezone: s.timezone, daily_slots: s.slots,
        drafts: count("draft"), scheduled: count("scheduled"), waiting_for_approval: notes.filter((n: any) => !n.reviewed).length,
        voice: { about: p.about, audience: p.audience, topics: p.topics, tones: p.tones, structure: p.structure, length: p.length, emoji: p.emoji, hashtags: p.hashtags, person: p.person, address: p.address, use_words: p.use_words, avoid_words: p.avoid_words, closing: p.cta, portrait: p.portrait, writing_samples: p.samples.length },
        rules: "Drafts you create wait for the writer's approval in the app. You cannot schedule, publish, reply or contact anyone.",
      };
    },
  },
  {
    name: "list_notes",
    description: "Lists the Notes kept in the app: drafts, the scheduled queue with times, and Notes already published from the app. Use it to see what is planned and to avoid repeating a topic.",
    inputSchema: obj({ status: { type: "string", enum: ["draft", "scheduled", "published", "failed"], description: "Only this status. Omit for all." } }),
    annotations: READ,
    run: async (a, api) =>
      (await api("/notes")).filter((n: any) => !a.status || n.status === a.status).slice(0, 80)
        .map((n: any) => ({ id: n.id, status: n.status, approved: !!n.reviewed, origin: n.source, scheduled_at: n.scheduled_at ? new Date(n.scheduled_at).toISOString() : null, body: n.body })),
  },
  {
    name: "get_results",
    description: "How the writer's published Substack Notes performed over a period: totals, what the Notes brought in (free and paid subscribers, follows, link clicks), engagement by hour, weekday and length, and the best Notes. Use it to ground advice in what actually worked.",
    inputSchema: obj({ days: { type: "integer", minimum: 7, maximum: 3650, description: "Look-back window in days. Default 90." } }),
    annotations: READ,
    run: async (a, api) => {
      const d = await api(`/stats?days=${a.days ?? 90}`);
      const slim = (n: any) => ({ body: cut(n.body, 500), date: new Date(n.date).toISOString().slice(0, 10), likes: n.likes, restacks: n.restacks, replies: n.replies, free_subscribers: n.free_subs, paid_subscribers: n.paid_subs, follows: n.follows, clicks: n.clicks });
      return { days: d.days, notes: d.total, likes: d.likes, restacks: d.restacks, replies: d.replies, brought_in: d.brought, by_hour: d.by_hour, by_weekday: d.by_weekday, by_length: d.by_length, best_by_engagement: d.top.map(slim), best_by_subscribers: d.by_result.map(slim) };
    },
  },
  {
    name: "list_materials",
    description: "Lists the research documents and briefs the writer keeps in the app (title, source, size). Read one with read_material.",
    inputSchema: obj(),
    annotations: READ,
    run: async (_a, api) => api("/materials"),
  },
  {
    name: "read_material",
    description: "Returns the full text of one research document from list_materials.",
    inputSchema: obj({ id: { type: "integer" } }, ["id"]),
    annotations: READ,
    run: async (a, api) => api(`/materials/${a.id}`),
  },
  {
    name: "list_people",
    description: "The people around the writer. side 'subscribers' returns readers who interact, with whether they subscribe or pay, the reasons they are worth attention, the writer's own notes and next step. side 'creators' returns the other Substack creators the writer studies, with how often they publish, their formats and their best Note. Personal data: use it only to help the writer, never repeat it elsewhere.",
    inputSchema: obj({ side: { type: "string", enum: ["subscribers", "creators"] }, circle_only: { type: "boolean", description: "Subscribers side: only the people the writer chose to follow closely." } }, ["side"]),
    annotations: READ,
    run: async (a, api) => {
      const d = await api("/people");
      if (a.side === "creators") {
        return d.people.filter((p: any) => p.kind === "creator").map((p: any) => ({ name: p.name, handle: p.handle, publication: p.publication, tag: p.tag, watched: p.watched, followers: p.followers, subscribers: p.subscribers, habits: p.radar, analysis: p.topics?.items ?? null }));
      }
      return d.people.filter((p: any) => p.kind !== "creator" && (!a.circle_only || p.circle)).slice(0, 80)
        .map((p: any) => ({ name: p.name, handle: p.handle, publication: p.publication, in_circle: !!p.circle, suggested: p.suggested, relationship: p.sub_state, tag: p.tag, reasons: p.reasons, replies: p.interactions, waiting_for_reply: p.waiting, followers: p.followers, writer_notes: p.note, next_step: p.next_step }));
    },
  },
  {
    name: "save_draft",
    description: "Saves a Note the writer and you worked out together as a draft in the app. It appears in the Studio marked as coming from chat and waits for the writer's approval there; it is not scheduled or published. Save only text the writer asked you to save, in their voice and language, plain text without markdown.",
    inputSchema: obj({ body: { type: "string", description: "The full text of the Note." } }, ["body"]),
    run: async (a, api) => {
      const r = await api("/notes/from-chat", { method: "POST", body: { body: a.body } });
      return { saved: true, id: r.id, next: "The writer approves it in Notes Studio, then schedules it." };
    },
  },
  {
    name: "update_draft",
    description: "Replaces the text of a draft that is not yet scheduled or published. The draft goes back to waiting for the writer's approval.",
    inputSchema: obj({ id: { type: "integer" }, body: { type: "string" } }, ["id", "body"]),
    run: async (a, api) => {
      await api(`/notes/${a.id}/from-chat`, { method: "PUT", body: { body: a.body } });
      return { updated: true, id: a.id };
    },
  },
  {
    name: "save_material",
    description: "Stores a research note, outline or brief in the app's Materials library so the writer can read it later. Use it for long-form thinking, not for Notes.",
    inputSchema: obj({ title: { type: "string" }, body: { type: "string", description: "Markdown or plain text." } }, ["title", "body"]),
    run: async (a, api) => {
      const r = await api("/materials", { method: "POST", body: { title: a.title, body: a.body, source: "Chat" } });
      return { saved: true, id: r.id };
    },
  },
];

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export async function handleMcp(req: Request, api: Api): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const one = async (m: any): Promise<any | null> => {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
    if (m.id === undefined) return null; // notification: nothing to answer
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: VERSIONS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "notes-studio", version: "1.0.0" },
          instructions: "Notes Studio is one writer's private workspace for Substack Notes. Call get_overview first and follow the voice profile. You help the writer think and write; the writer approves, schedules and publishes inside the app.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === m.params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${m.params?.name}`);
        try {
          const out = await tool.run(m.params?.arguments ?? {}, api);
          return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
        } catch (e) {
          return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  };
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map(one))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await one(msg);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}
