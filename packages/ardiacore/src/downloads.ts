export type DownloadState = "downloading" | "finished" | "failed" | "cancelled";

export type Download = {
  id: string;
  url: string;
  filename: string;
  path: string;
  state: DownloadState;
  paused: boolean;
  dangerous?: boolean;
  received: number;
  total: number;
  speed: number;
  mimeType: string;
  profile?: string;
  offTheRecord?: boolean;
  staging?: string | null;
  startTime?: number;
};

export type DownloadSettings = { folder: string; askWhereToSave: boolean; managed: boolean };

export type DownloadFileRename = { ok: true; path: string } | { ok: false; reason: "exists" | "missing" | "invalid" | "failed" };

export type DownloadNameSuggestion =
  | { status: "ok"; category: string; title: string; date: string }
  | { status: "unavailable" | "unreadable" | "failed" };

export type DownloadNamerStatus = "available" | "unavailable" | "unsupported";
