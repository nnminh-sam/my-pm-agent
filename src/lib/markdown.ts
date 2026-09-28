import YAML from "yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMarkdown(text: string): { data: Record<string, unknown>; body: string } {
  const match = text.match(FRONTMATTER);
  if (!match) return { data: {}, body: text.trim() };
  const data = YAML.parse(match[1]) ?? {};
  return { data, body: text.slice(match[0].length).trim() };
}

/** Serialize frontmatter + body. Keys keep the given order; undefined/empty values (lists and maps) are dropped. */
export function toMarkdown(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    clean[key] = value;
  }
  const doc = new YAML.Document(clean);
  // Lists (tags, depends_on, work hours) read better inline: `tags: [api, backend]`.
  YAML.visit(doc, {
    Seq(_, node) {
      node.flow = true;
    },
  });
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  const trimmed = body.trim();
  return `---\n${yaml}---\n${trimmed ? `\n${trimmed}\n` : ""}`;
}
