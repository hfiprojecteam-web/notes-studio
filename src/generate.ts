import Anthropic from "@anthropic-ai/sdk";

export interface Voice {
  voicePrompt?: string; // the writer's own instructions
  examples: string[]; // the writer's published notes
  samples?: string[]; // longer pieces of the writer's own prose
}

export interface VoiceProfile {
  language: string; // "auto" or a language name
  about: string;
  audience: string;
  topics: string;
  tones: string[];
  length: string;
  emoji: string;
  hashtags: string;
  person: string;
  address: string;
  structure: string[];
  use_words: string;
  avoid_words: string;
  cta: string;
  portrait: string;
  samples: string[];
}

export const EMPTY_PROFILE: VoiceProfile = {
  language: "auto", about: "", audience: "", topics: "", tones: [], length: "", emoji: "", hashtags: "", person: "", address: "",
  structure: [], use_words: "", avoid_words: "", cta: "", portrait: "", samples: [],
};

/** Turns the structured profile into the instruction text given to Claude. */
export function composeVoice(p: VoiceProfile): string {
  const lines: string[] = [];
  const add = (label: string, value: string | string[]) => {
    const v = Array.isArray(value) ? value.join(", ") : value?.trim();
    if (v) lines.push(`${label}: ${v}`);
  };
  if (p.language && p.language !== "auto") lines.push(`Always write in ${p.language}, whatever the language of the source material.`);
  add("Who the writer is", p.about);
  add("Who they write for", p.audience);
  add("Subjects they cover", p.topics);
  add("Tone", p.tones);
  add("Preferred length of a Note", p.length);
  add("Emoji", p.emoji);
  add("Hashtags", p.hashtags);
  add("Grammatical person", p.person);
  add("How they address the reader", p.address);
  add("Structural habits", p.structure);
  add("Words and expressions they like to use", p.use_words);
  add("Words, expressions and habits to avoid", p.avoid_words);
  add("How they usually close or invite a response", p.cta);
  if (p.portrait?.trim()) lines.push(`Portrait of the voice:\n${p.portrait.trim()}`);
  return lines.join("\n");
}

const WRITER = [
  "You write on behalf of one specific Substack writer. Substack Notes are short posts in a feed, read by people scrolling quickly, so each one has to stand on its own and earn the stop.",
  "The writer's published Notes are given as examples. They are the reference for voice: match their language, length, rhythm, line breaks, punctuation habits, level of formality and use (or absence) of emoji and hashtags. A reader who knows the writer should not be able to tell the text was drafted by someone else. When there are few or no examples, lean on the writer's instructions.",
  "Write in the same language as the examples unless the writer's instructions say otherwise. Do not copy sentences from the examples, and do not invent facts, numbers or personal anecdotes that are not in the material you are given.",
  "Return plain text only: no titles, no numbering, no markdown. Never use em dashes.",
].join("\n\n");

function voiceBlock(v: Voice) {
  const parts: string[] = [];
  if (v.voicePrompt?.trim()) parts.push(`<writer_instructions>\n${v.voicePrompt.trim()}\n</writer_instructions>`);
  if (v.samples?.length) {
    parts.push(
      `<writing_samples note="Longer prose by the same writer. Use it to hear the voice; do not treat its length or structure as the format of a Note.">\n${v.samples.map((e, i) => `<sample index="${i + 1}">\n${e}\n</sample>`).join("\n")}\n</writing_samples>`,
    );
  }
  if (v.examples.length) {
    parts.push(`<published_notes>\n${v.examples.map((e, i) => `<note index="${i + 1}">\n${e}\n</note>`).join("\n")}\n</published_notes>`);
  }
  return parts;
}

const LIST_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "string" } } },
  required: ["items"],
  additionalProperties: false,
} as const;

/** One structured request to Claude that returns a list of texts. */
async function askList(apiKey: string, system: string, user: string): Promise<string[]> {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: LIST_SCHEMA } },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude ha rifiutato la richiesta: prova a riformulare.");
  if (response.stop_reason === "max_tokens") throw new Error("Risposta troncata: riduci la quantità richiesta.");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  return (JSON.parse(text) as { items: string[] }).items.map((s) => s.trim()).filter(Boolean);
}

export function generateNotes(
  apiKey: string,
  v: Voice,
  input: { count: number; topic?: string; sourceTitle?: string; sourceText?: string },
) {
  const parts = voiceBlock(v);
  if (input.sourceText?.trim()) parts.push(`<source_article title="${input.sourceTitle ?? ""}">\n${input.sourceText.trim()}\n</source_article>`);
  if (input.topic?.trim()) parts.push(`<idea>\n${input.topic.trim()}\n</idea>`);
  parts.push(
    `Write ${input.count} Notes${input.sourceText ? " drawn from the source article" : ""}${input.topic ? " developing the idea above" : ""}. Each Note makes one point. Vary the angle across the batch (an observation, a lesson, a question, a contrarian take, a short story from the source) so they do not read like the same post rewritten. Return one item per Note.`,
  );
  return askList(apiKey, WRITER, parts.join("\n\n"));
}

/**
 * Writing prompts instead of finished text: an angle, a possible opening line and the questions the writer should
 * answer in their own words. The writer does the writing.
 */
export function generateOutlines(
  apiKey: string,
  v: Voice,
  input: { count: number; topic?: string; sourceTitle?: string; sourceText?: string },
) {
  const parts = voiceBlock(v);
  if (input.sourceText?.trim()) parts.push(`<source_article title="${input.sourceTitle ?? ""}">\n${input.sourceText.trim()}\n</source_article>`);
  if (input.topic?.trim()) parts.push(`<idea>\n${input.topic.trim()}\n</idea>`);
  parts.push(
    `The writer wants to write these Notes personally and needs starting points, not finished text. Propose ${input.count} different angles${input.sourceText ? " found in the source article" : ""}${input.topic ? " on the idea above" : ""}. For each one return a single item with exactly this layout, written in the writer's language:\nANGOLO: the angle in a few words\nAPERTURA POSSIBILE: one opening line they could adapt\nDA SCRIVERE TU: two or three short questions or prompts, each on its own line starting with "- ", that only the writer can answer from their own experience or opinion\nDo not write the body of the Note.`,
  );
  return askList(apiKey, WRITER, parts.join("\n\n"));
}

const REWRITE_MODES = {
  shorter: "Rewrite the draft noticeably shorter while keeping its one point and its best line. Return 3 alternative versions.",
  direct: "Rewrite the draft so it is more direct: lead with the point, cut hedging and warm-up, prefer concrete words. Return 3 alternative versions.",
  hooks: "Keep the body of the draft as it is and rewrite only its opening line so it earns the stop. Return 3 complete versions of the Note, each with a different opening.",
} as const;
export type RewriteMode = keyof typeof REWRITE_MODES;
export const isRewriteMode = (m: unknown): m is RewriteMode => typeof m === "string" && m in REWRITE_MODES;

export function rewriteNote(apiKey: string, v: Voice, body: string, mode: RewriteMode) {
  return askList(apiKey, WRITER, [...voiceBlock(v), `<draft>\n${body}\n</draft>`, REWRITE_MODES[mode]].join("\n\n"));
}

export async function suggestReply(apiKey: string, v: Voice, ctx: { noteBody: string; author: string; replyBody: string }) {
  const user = [
    ...voiceBlock(v),
    `<my_note>\n${ctx.noteBody}\n</my_note>`,
    `<reply_from author="${ctx.author}">\n${ctx.replyBody}\n</reply_from>`,
    "Someone replied to the writer's Note. Draft the writer's answer to that reply: brief, warm without gushing, and specific to what the person actually said. If they asked a question the material here cannot answer, acknowledge it without making an answer up. Return exactly one item.",
  ].join("\n\n");
  return (await askList(apiKey, WRITER, user))[0] ?? "";
}

export function remixInspiration(apiKey: string, v: Voice, inspiration: { author: string; body: string }, count: number) {
  const user = [
    ...voiceBlock(v),
    `<inspiration author="${inspiration.author}">\n${inspiration.body}\n</inspiration>`,
    `The writer saved the Note above, written by someone else, because its idea or structure works. Write ${count} original Notes in the writer's own voice that borrow what makes it work (the angle, the shape, the kind of hook) and apply it to the writer's own subject matter. Do not paraphrase it or reuse its sentences: someone who has read the original should see a different post. Return one item per Note.`,
  ].join("\n\n");
  return askList(apiKey, WRITER, user);
}

/** Reads the writer's own texts and describes the voice, as a draft the writer then edits. */
export async function analyzeVoice(apiKey: string, texts: string[], language: string) {
  const user = [
    `<texts>\n${texts.map((t, i) => `<text index="${i + 1}">\n${t}\n</text>`).join("\n")}\n</texts>`,
    `These texts were all written by the same person. Describe their writing voice so that another writer could imitate it faithfully: sentence length and rhythm, how they open and close, vocabulary and register, recurring devices, what they never do, the stance they take towards the reader. Be specific and quote short fragments as evidence. Describe only what the texts show; where the sample is too small to tell, say so rather than guessing. Write the description in ${language === "auto" ? "the language of the texts" : language}, as plain prose of 150 to 250 words. Return exactly one item.`,
  ].join("\n\n");
  return (await askList(apiKey, "You are an editor with a precise ear for prose style.", user))[0] ?? "";
}
