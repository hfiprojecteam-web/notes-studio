import Anthropic from "@anthropic-ai/sdk";

const SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
} as const;

export interface GenerateInput {
  apiKey: string;
  count: number;
  topic?: string; // rough idea
  sourceTitle?: string;
  sourceText?: string; // article to turn into notes
  voicePrompt?: string; // the user's own instructions
  examples: string[]; // the user's published notes
}

export async function generateNotes(input: GenerateInput): Promise<string[]> {
  const client = new Anthropic({ apiKey: input.apiKey });

  const system = [
    "You write Substack Notes on behalf of one specific writer. Substack Notes are short posts in a feed, read by people scrolling quickly, so each one has to stand on its own and earn the stop.",
    "The writer's published Notes are given as examples. They are the reference for voice: match their language, length, rhythm, line breaks, punctuation habits, level of formality and use (or absence) of emoji and hashtags. A reader who knows the writer should not be able to tell these Notes were drafted by someone else.",
    "Write in the same language as the examples unless the writer's instructions say otherwise. Do not copy sentences from the examples, and do not invent facts, numbers or personal anecdotes that are not in the source material or the examples.",
    "Each Note should make one point. Vary the angle across the batch (an observation, a lesson, a question, a contrarian take, a short story from the source) so the Notes do not read like the same post rewritten.",
    "Return plain text bodies only: no titles, no numbering, no markdown.",
  ].join("\n\n");

  const parts: string[] = [];
  if (input.voicePrompt?.trim()) parts.push(`<writer_instructions>\n${input.voicePrompt.trim()}\n</writer_instructions>`);
  if (input.examples.length) {
    parts.push(
      `<published_notes>\n${input.examples.map((e, i) => `<note index="${i + 1}">\n${e}\n</note>`).join("\n")}\n</published_notes>`,
    );
  }
  if (input.sourceText?.trim()) {
    parts.push(`<source_article title="${input.sourceTitle ?? ""}">\n${input.sourceText.trim()}\n</source_article>`);
  }
  if (input.topic?.trim()) parts.push(`<idea>\n${input.topic.trim()}\n</idea>`);
  parts.push(
    `Write ${input.count} Notes${input.sourceText ? " drawn from the source article" : ""}${input.topic ? " developing the idea above" : ""}.`,
  );

  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system,
    messages: [{ role: "user", content: parts.join("\n\n") }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude ha rifiutato la richiesta: prova a riformulare l'idea.");
  if (response.stop_reason === "max_tokens") throw new Error("Risposta troncata: riduci il numero di Notes richieste.");

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  const parsed = JSON.parse(text) as { notes: { body: string }[] };
  return parsed.notes.map((n) => n.body.trim()).filter(Boolean);
}
