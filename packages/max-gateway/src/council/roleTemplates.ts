// @effect-diagnostics nodeBuiltinImport:off - The companion is a standalone Node process with a small import graph.
// @effect-diagnostics globalTimers:off - Companion lifecycle and transport use native timers.
// @effect-diagnostics globalDate:off - Persisted lifecycle timestamps use ISO wall-clock time.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

import { CouncilError, type CouncilTemplate, type CouncilRole } from "./types.ts";
// oxlint-disable-next-line t3code/no-em-dash-copy -- Preserve the authorized legacy synthesis prompt verbatim.
export const SYNTHESIS_SYSTEM_PROMPT = `You are a neutral analyst comparing responses from multiple AI models to the same prompt. Your job is to identify where the models agree, where they disagree, what the best answer is, and what uncertainties remain.

You MUST respond with ONLY a valid JSON object — no markdown, no explanation, no text before or after the JSON. Use this exact structure:

{
  "consensus": ["point where models agree — cite which ones"],
  "disagreements": ["point where models differ — cite which ones and how"],
  "verdict": "A single paragraph: the recommended answer synthesising the strongest elements from all responses.",
  "uncertainties": ["key assumption or open question that could change the answer"]
}

Rules:
- Each array should have 1-5 concise items.
- The verdict should be 2-4 sentences.
- Always name the providers (e.g. "ChatGPT and Claude agree that…", "Gemini differs by…").
- Do not invent information that wasn't in the original responses.
- Do not include any text outside the JSON object.`;
export const COUNCIL_PREFACE =
  "You are one member of a council answering the question below. Answer it directly in plain prose for a non-technical reader. You may research (web search/fetch) if useful. Do not modify files, run shell commands, or describe your process, modes, or working rules.";
export const SYNTHESIS_PREFACE =
  "Compare the answers below directly for a non-technical reader. Do not repeat process descriptions, modes, or working rules from the answers. Do not modify files or run shell commands.";
export const META_DEBATE: CouncilTemplate = {
  id: "meta-debate",
  name: "Meta-debate",
  description: "Compare model responses and synthesize their strongest answer.",
  format: "meta-debate",
  builtIn: true,
  roles: [],
  synthesizerInstruction: SYNTHESIS_SYSTEM_PROMPT,
};
export const slug = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function templateInput(value: unknown, id?: string): CouncilTemplate {
  if (!value || typeof value !== "object") throw new CouncilError(400, "Invalid template");
  const v = value as Record<string, unknown>;
  if (
    !text(v.name) ||
    /[\r\n]/.test(v.name) ||
    typeof v.description !== "string" ||
    !text(v.synthesizerInstruction) ||
    !["meta-debate", "freeform"].includes(String(v.format)) ||
    !Array.isArray(v.roles)
  )
    throw new CouncilError(400, "Invalid template fields");
  const roles: CouncilRole[] = v.roles.map((r: unknown) => {
    if (
      !r ||
      typeof r !== "object" ||
      !("name" in r) ||
      !("instruction" in r) ||
      !text(r.name) ||
      /[\r\n]/.test(r.name) ||
      !text(r.instruction) ||
      !slug(r.name)
    )
      throw new CouncilError(400, "Invalid role");
    return { id: slug(r.name), name: r.name, instruction: r.instruction };
  });
  if (new Set(roles.map((r) => r.id)).size !== roles.length || !slug(v.name))
    throw new CouncilError(400, "Duplicate or invalid role/name");
  return {
    id: id ?? slug(v.name),
    name: v.name,
    description: v.description,
    format: v.format as CouncilTemplate["format"],
    builtIn: false,
    roles,
    synthesizerInstruction: v.synthesizerInstruction,
  };
}
function serialize(t: CouncilTemplate) {
  return `---\nname: ${JSON.stringify(t.name)}\ndescription: ${JSON.stringify(t.description)}\nformat: ${t.format}\n---\n${t.roles.map((r) => `## Role: ${r.name}\n${r.instruction}\n`).join("\n")}\n## Synthesizer\n${t.synthesizerInstruction}\n`;
}
function parse(raw: string, id: string) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!front) throw new CouncilError(400, "Invalid template file");
  const fields: Record<string, unknown> = {};
  for (const line of front[1]!.split("\n")) {
    const m = /^(name|description|format):\s*(.*)$/.exec(line);
    if (m) {
      let v = m[2]!.replace(/\s+#.*$/, "").trim();
      if (v.startsWith('"')) v = JSON.parse(v);
      fields[m[1]!] = v;
    }
  }
  const sections = [
    ...front[2]!.matchAll(/^## (Role: (.+)|Synthesizer)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm),
  ];
  return templateInput(
    {
      ...fields,
      roles: sections.filter((s) => s[2]).map((s) => ({ name: s[2], instruction: s[3]!.trim() })),
      synthesizerInstruction: sections.find((s) => s[1] === "Synthesizer")?.[3]?.trim(),
    },
    id,
  );
}
export class RoleTemplates {
  readonly directory: string;
  constructor(
    directory = process.env.MAX_TEMPLATES_DIR ??
      NodePath.join(NodeOS.homedir(), ".t3/max-templates"),
  ) {
    this.directory = directory;
    NodeFS.mkdirSync(directory, { recursive: true });
    try {
      NodeFS.writeFileSync(this.file("meta-debate"), serialize(META_DEBATE), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  private file(id: string) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new CouncilError(400, "Invalid template id");
    return NodePath.join(this.directory, `${id}.md`);
  }
  list(): CouncilTemplate[] {
    return [
      structuredClone(META_DEBATE),
      ...NodeFS.readdirSync(this.directory)
        .filter((n) => n.endsWith(".md") && n !== "meta-debate.md")
        .sort()
        .map((n) => this.get(n.slice(0, -3))),
    ];
  }
  get(id: string): CouncilTemplate {
    if (id === "meta-debate") return structuredClone(META_DEBATE);
    try {
      return parse(NodeFS.readFileSync(this.file(id), "utf8"), id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new CouncilError(404, "Template not found");
      throw e;
    }
  }
  save(value: unknown, id?: string) {
    if (id === "meta-debate") throw new CouncilError(409, "Built-in templates cannot be edited");
    if (id) this.get(id);
    const t = templateInput(value, id);
    if (t.id === "meta-debate") throw new CouncilError(409, "Template already exists");
    try {
      NodeFS.writeFileSync(this.file(t.id), serialize(t), { flag: id ? "w" : "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new CouncilError(409, "Template already exists");
      throw e;
    }
    return t;
  }
  delete(id: string) {
    if (id === "meta-debate") throw new CouncilError(409, "Built-in templates cannot be deleted");
    this.get(id);
    NodeFS.unlinkSync(this.file(id));
  }
}
