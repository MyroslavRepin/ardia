import { create } from "zustand";
import {
  downloadNamerStatus,
  onDownload,
  renameDownloadFile,
  suggestDownloadName,
  type Download,
  type DownloadNamerStatus,
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

export type ContentName = { original: string; named: string; showing: "named" | "original"; folder: string };

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
    const { original, named, showing, folder } = entry;
    if (typeof original !== "string" || typeof named !== "string" || typeof folder !== "string" || (showing !== "named" && showing !== "original")) continue;
    names[id] = { original, named, showing, folder };
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
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const shownName = (name: ContentName) => (name.showing === "named" ? name.named : name.original);

let renamesFiles = true;
let modelReady = true;

export function contentNameEligible(d: Download): boolean {
  if (d.state !== "finished" || !d.path || !d.filename || d.dangerous || d.offTheRecord) return false;
  if (d.id.startsWith(WEBKIT_DOWNLOAD)) return false;
  return downloadSession(useBrowser.getState(), d) === null;
}

const namingOn = () =>
  PLATFORM_FEATURES.namesDownloadsOnDevice &&
  renamesFiles &&
  modelReady &&
  useContentNames.getState().status !== "unsupported" &&
  useBrowser.getState().settings.nameDownloadsByContent;

function showFile(id: string, path: string) {
  const d = currentDownload(id);
  if (d) useBrowser.getState().upsertDownload({ ...d, path, filename: path.slice(path.lastIndexOf("/") + 1) });
}

async function renameTo(path: string, name: string): Promise<string | null> {
  const attempts = [name, ...NUMBERED_TRIES.map((n) => withNumber(name, n))];
  for (const attempt of attempts) {
    const result = await renameDownloadFile(path, attempt);
    if (result.ok) return result.path;
    if (result.reason !== "exists") return null;
  }
  return null;
}

let modelQueue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const turn = modelQueue.then(work, work);
  modelQueue = turn.catch(() => undefined);
  return turn;
}

const appLacksRename = (error: unknown) => /renameFile/.test(String(error));

export async function nameByContent(d: Download, finished = new Date()): Promise<string | null> {
  if (!namingOn() || !contentNameEligible(d) || useContentNames.getState().names[d.id]) return null;
  const consent = consentToken();
  await downloadSettled(d.id);
  const file = currentDownload(d.id);
  if (!file || file.state !== "finished" || !file.path) return null;
  setThinking(d.id, true);
  try {
    const suggestion = await oneAtATime(() => suggestDownloadName(file.path, file.filename));
    if (suggestion.status === "unavailable") {
      modelReady = false;
      noteDownloadsPanel("contentNameUnavailable", consent);
      return null;
    }
    if (suggestion.status !== "ok") {
      noteDownloadsPanel(suggestion.status === "unreadable" ? "contentNameUnreadable" : "contentNameFailed", consent);
      return null;
    }
    const named = contentFilename(suggestion, file.filename, finished);
    if (!named || named === file.filename) return null;
    if (currentDownload(d.id)?.path !== file.path) return null;
    const landed = await renameTo(file.path, named);
    if (!landed) {
      noteDownloadsPanel("contentNameFailed", consent);
      return null;
    }
    const landedName = landed.slice(landed.lastIndexOf("/") + 1);
    remember(d.id, { original: file.filename, named: landedName, showing: "named", folder: folderOf(landed) });
    showFile(d.id, landed);
    noteDownloadsPanel("contentNamed", consent);
    return landedName;
  } catch (error) {
    if (appLacksRename(error)) renamesFiles = false;
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
  let landed: string | null = null;
  let reason = "failed";
  try {
    const result = await renameDownloadFile(d.path, to === "original" ? name.original : name.named);
    if (result.ok) landed = result.path;
    else reason = result.reason;
  } catch {
    landed = null;
  }
  if (!landed) {
    warnFor(consent, `[downloads] couldn't switch a download to its ${to} name (${reason})`);
    return false;
  }
  remember(id, { ...name, showing: to, folder: folderOf(landed) });
  showFile(id, landed);
  noteDownloadsPanel(to === "original" ? "contentNameReverted" : "contentNameRestored", consent);
  return true;
}

function keepShownName(d: Download) {
  const name = useContentNames.getState().names[d.id];
  if (!name || d.state !== "finished" || !d.path) return;
  const path = `${name.folder}/${shownName(name)}`;
  if (d.path !== path) showFile(d.id, path);
}

const live = new Set<string>();

export function noteContentNameEvent(d: Download) {
  if (d.state === "downloading") {
    live.add(d.id);
    if (live.size > LIVE_CAP) live.delete(live.values().next().value!);
    return;
  }
  keepShownName(d);
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
  renamesFiles = true;
  modelReady = true;
  useContentNames.setState({ names: {}, thinking: {}, status });
}
