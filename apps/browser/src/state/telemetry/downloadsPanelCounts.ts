import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

const NO_COUNTS = {
  downloads_panel_press_closes: 0,
  downloads_panel_held_opens: 0,
  download_archives_opened: 0,
  download_content_names: 0,
  download_content_names_unreadable: 0,
  download_content_names_failed: 0,
  download_content_names_unavailable: 0,
  download_content_name_reverts: 0,
  download_content_name_restores: 0,
};
let counts = { ...NO_COUNTS };

const KEYS = {
  pressClose: "downloads_panel_press_closes",
  heldOpen: "downloads_panel_held_opens",
  archiveOpen: "download_archives_opened",
  contentNamed: "download_content_names",
  contentNameUnreadable: "download_content_names_unreadable",
  contentNameFailed: "download_content_names_failed",
  contentNameUnavailable: "download_content_names_unavailable",
  contentNameReverted: "download_content_name_reverts",
  contentNameRestored: "download_content_name_restores",
} as const;

export const noteDownloadsPanel = (event: keyof typeof KEYS, consent?: ConsentToken | null) => countFor(consent, () => void counts[KEYS[event]]++, { [KEYS[event]]: 1 });

export function takeDownloadsPanelCounts() {
  const taken = counts;
  counts = { ...NO_COUNTS };
  return taken;
}
