// Formats data.json so that each champion sits on its own line.
// Diffs of the weekly update then read as "one line = one champion".
// Rule: a container holding only primitives stays on one line when it has
// at most MAX_INLINE items; everything else is expanded one item per line.
const MAX_INLINE = 8;

const isPrimitive = v => v === null || typeof v !== "object";

function inline(v) {
  if (Array.isArray(v)) return "[" + v.map(x => JSON.stringify(x)).join(", ") + "]";
  return "{" + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(", ") + "}";
}

function fmt(v, pad) {
  if (isPrimitive(v)) return JSON.stringify(v);
  const items = Array.isArray(v) ? v : Object.values(v);
  if (items.length === 0) return Array.isArray(v) ? "[]" : "{}";
  if (items.every(isPrimitive) && items.length <= MAX_INLINE) return inline(v);
  const inner = pad + "  ";
  const rows = Array.isArray(v)
    ? v.map(x => inner + fmt(x, inner))
    : Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${fmt(x, inner)}`);
  const [open, close] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  return `${open}\n${rows.join(",\n")}\n${pad}${close}`;
}

export function formatData(data) {
  return fmt(data, "") + "\n";
}
