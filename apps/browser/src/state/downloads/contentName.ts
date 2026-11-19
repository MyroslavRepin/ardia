export const CONTENT_NAME_CATEGORIES = [
  "invoice",
  "receipt",
  "statement",
  "contract",
  "report",
  "paper",
  "slides",
  "resume",
  "letter",
  "manual",
  "form",
  "ticket",
  "screenshot",
  "notes",
  "code",
  "data",
  "book",
  "other",
] as const;

export type ContentNameCategory = (typeof CONTENT_NAME_CATEGORIES)[number];

export type ContentNameParts = { category: string; title: string; date: string };

const TITLE_MAX = 48;
const COMPOUND_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"];
const EXTENSION = /\.[a-z0-9]{1,10}$/i;
const EARLIEST_YEAR = 1970;
const LATEST_YEARS_AHEAD = 1;

export function extensionOf(filename: string): string {
  const lower = filename.toLowerCase();
  const compound = COMPOUND_EXTENSIONS.find((ext) => lower.endsWith(ext) && lower.length > ext.length);
  if (compound) return filename.slice(-compound.length);
  const match = EXTENSION.exec(filename);
  return match && match.index > 0 ? match[0] : "";
}

export function slug(text: string, max = TITLE_MAX): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let out = "";
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return out || (words[0] ?? "").slice(0, max);
}

const pad = (n: number) => String(n).padStart(2, "0");

export const isoDay = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

export function contentDate(text: string, fallback: Date): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return isoDay(fallback);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(year, month - 1, day);
  const real = at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day;
  const plausible = year >= EARLIEST_YEAR && year <= fallback.getFullYear() + LATEST_YEARS_AHEAD;
  return real && plausible ? `${year}-${pad(month)}-${pad(day)}` : isoDay(fallback);
}

export function contentCategory(text: string): ContentNameCategory {
  const lower = text.trim().toLowerCase();
  return (CONTENT_NAME_CATEGORIES as readonly string[]).includes(lower) ? (lower as ContentNameCategory) : "other";
}

function withoutCategory(title: string, category: ContentNameCategory): string {
  const words = title.split("-");
  const kept = words.filter((word) => word !== category && word !== `${category}s`);
  return kept.length ? kept.join("-") : title;
}

export function contentFilename(parts: ContentNameParts, original: string, finished: Date): string | null {
  const category = contentCategory(parts.category);
  const title = withoutCategory(slug(parts.title), category);
  if (!title) return null;
  return `${contentDate(parts.date, finished)}_${category}_${title}${extensionOf(original).toLowerCase()}`;
}

export function withNumber(filename: string, n: number): string {
  const ext = extensionOf(filename);
  return `${filename.slice(0, filename.length - ext.length)}-${n}${ext}`;
}
