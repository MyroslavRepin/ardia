import { create } from "zustand";
import {
  downloadNamerStatus,
  onDownload,
  renameDownload,
  suggestDownloadName,
  type Download,
  type DownloadNamerStatus,
  type DownloadRenameResult,
} from "../../platform/downloads";
import { readDocument, writeDocument } from "../../platform/documents";
import { isFields } from "../../lib/decode";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { downloadSettled } from "../automation/downloadHooks";
import { useBrowser } from "../browser/store";
import { consentToken } from "../telemetry/client";
import { noteDownloadsPanel } from "../telemetry/downloadsPanelCounts";
import { warnFor } from "../telemetry/logs";
import { contentFilename, withNumber } from "./contentName";
import { downloadSession } from "./downloadsSlice";

export type ContentName = { original: string; named: string; showing: "named" | "original" };

type ContentNamesState = {
  names: Record<string, ContentName>;
  thinking: Record<string, true>;
  status: DownloadNamerStatus;
};

const DOC = "download-names.json";
const VERSION = 1;
const NAMES_CAP = 500;
const LIVE_CAP = 500;
const NUMBERED_TRIES = [2, 3, 4];
const WEBKIT_DOWNLOAD = "wk-";

export const useContentNames = create<ContentNamesState>()(() => ({ names: {}, thinking: {}, status: "unsupported" }));

function readNames(): Record<string, ContentName> {
  let doc: ReturnType<typeof parseSaved> = null;
  try {
    doc = parseSaved(readDocument(DOC), VERSION);
  } catch {
    doc = null;
  }
  const names: Record<string, ContentName> = {};
  if (!doc || !isFields(doc.names)) return names;
  for (const [id, entry] of Object.entries(doc.names)) {
    if (!isFields(entry)) continue;
    const { original, named, showing } = entry;
    if (typeof original !== "string" || typeof named !== "string" || (showing !== "named" && showing !== "original")) continue;
    names[id] = { original, named, showing };
  }
  return names;
}

function saveNames(names: Record<string, ContentName>) {
  try {
    writeDocument(DOC, versionedJson({ names }, VERSION));
  } catch (error) {
    console.warn("[downloads] couldn't save the content names", error);
  }
}

function remember(id: string, name: ContentName) {
  const { [id]: _, ...rest } = useContentNames.getState().names;
  const entries = Object.entries({ ...rest, [id]: name });
  const names = Object.fromEntries(entries.slice(Math.max(0, entries.length - NAMES_CAP)));
  useContentNames.setState({ names });
  saveNames(names);
}

function setThinking(id: string, on: boolean) {
  const { [id]: _, ...rest } = useContentNames.getState().thinking;
  useContentNames.setState({ thinking: on ? { ...rest, [id]: true } : rest });
}

const currentDownload = (id: string) => useBrowser.getState().downloads.find((d) => d.id === id);

let engineRenames = true;
let modelReady = true;

export function contentNameEligible(d: Download): boolean {
  if (d.state !== "finished" || !d.path || !d.filename || d.dangerous || d.offTheRecord) return false;
  if (d.id.startsWith(WEBKIT_DOWNLOAD)) return false;
  return downloadSession(useBrowser.getState(), d) === null;
}

const namingOn = () =>
  PLATFORM_FEATURES.namesDownloadsOnDevice &&
  engineRenames &&
  modelReady &&
  useContentNames.getState().status !== "unsupported" &&
  useBrowser.getState().settings.nameDownloadsByContent;

async function renameTo(id: string, name: string): Promise<string | null> {
  const attempts = [name, ...NUMBERED_TRIES.map((n) => withNumber(name, n))];
  for (const attempt of attempts) {
    const result: DownloadRenameResult = await renameDownload(id, attempt);
    if (result === "ok") return attempt;
    if (result !== "conflict") return null;
  }
  return null;
}

let modelQueue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const turn = modelQueue.then(work, work);
  modelQueue = turn.catch(() => undefined);
  return turn;
}

const engineLacksRename = (error: unknown) => /has no ac_downloads_rename|unknown command/.test(String(error));

export async function nameByContent(d: Download, finished = new Date()): Promise<string | null> {
  if (!namingOn() || !contentNameEligible(d) || useContentNames.getState().names[d.id]) return null;
  const consent = consentToken();
  const moved = await downloadSettled(d.id);
  if (moved?.ok) return null;
  const now = currentDownload(d.id);
  if (!now || now.path !== d.path || now.filename !== d.filename) return null;
  setThinking(d.id, true);
  try {
    const suggestion = await oneAtATime(() => suggestDownloadName(d.path, d.filename));
    if (suggestion.status === "unavailable") {
      modelReady = false;
      noteDownloadsPanel("contentNameUnavailable", consent);
      return null;
    }
    if (suggestion.status !== "ok") {
      noteDownloadsPanel(suggestion.status === "unreadable" ? "contentNameUnreadable" : "contentNameFailed", consent);
      return null;
    }
    const named = contentFilename(suggestion, d.filename, finished);
    if (!named || named === d.filename) return null;
    const landed = await renameTo(d.id, named);
    if (!landed) {
      noteDownloadsPanel("contentNameFailed", consent);
      return null;
    }
    remember(d.id, { original: d.filename, named: landed, showing: "named" });
    noteDownloadsPanel("contentNamed", consent);
    return landed;
  } catch (error) {
    if (engineLacksRename(error)) engineRenames = false;
    else noteDownloadsPanel("contentNameFailed", consent);
    return null;
  } finally {
    setThinking(d.id, false);
  }
}

export function contentNameToggle(d: Pick<Download, "id" | "filename" | "state">, name: ContentName | undefined): "original" | "named" | null {
  if (!name || d.state !== "finished") return null;
  if (d.filename === name.named) return "original";
  if (d.filename === name.original) return "named";
  return null;
}

export async function toggleContentName(id: string): Promise<boolean> {
  const d = currentDownload(id);
  const name = useContentNames.getState().names[id];
  if (!d || !name) return false;
  const to = contentNameToggle(d, name);
  if (!to) return false;
  const consent = consentToken();
  let result: DownloadRenameResult;
  try {
    result = await renameDownload(id, to === "original" ? name.original : name.named);
  } catch {
    result = "failed";
  }
  if (result !== "ok") {
    warnFor(consent, `[downloads] couldn't switch a download to its ${to} name (${result})`);
    return false;
  }
  remember(id, { ...name, showing: to });
  noteDownloadsPanel(to === "original" ? "contentNameReverted" : "contentNameRestored", consent);
  return true;
}

const live = new Set<string>();

export function noteContentNameEvent(d: Download) {
  if (d.state === "downloading") {
    live.add(d.id);
    if (live.size > LIVE_CAP) live.delete(live.values().next().value!);
    return;
  }
  if (!live.delete(d.id) || d.state !== "finished") return;
  void nameByContent(d);
}

export const contentNamerOffered = () => PLATFORM_FEATURES.namesDownloadsOnDevice && useContentNames.getState().status !== "unsupported";

let started = false;

export function startContentNames() {
  if (started || !PLATFORM_FEATURES.namesDownloadsOnDevice) return;
  started = true;
  useContentNames.setState({ names: readNames() });
  onDownload(noteContentNameEvent);
  void downloadNamerStatus()
    .then((status) => useContentNames.setState({ status }))
    .catch(() => useContentNames.setState({ status: "unsupported" }));
}

export function resetContentNamesForTests(status: DownloadNamerStatus = "available") {
  live.clear();
  engineRenames = true;
  modelReady = true;
  useContentNames.setState({ names: {}, thinking: {}, status });
}
