import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

export type CliInstallReason = "auto" | "settings" | "upgrade";

const NONE = {
  cli_pill_shows: 0,
  cli_pill_compact_shows: 0,
  cli_auto_installs: 0,
  cli_auto_install_failures: 0,
  cli_auto_enables: 0,
  cli_upgrades: 0,
  cli_upgrade_failures: 0,
  cli_settings_installs: 0,
  cli_settings_install_failures: 0,
  windowless_pages_given_geometry: 0,
  windowless_pages_missing_geometry: 0,
  cli_cdp_commands_target: 0,
  cli_cdp_commands_page: 0,
  cli_cdp_commands_runtime: 0,
  cli_cdp_commands_dom: 0,
  cli_cdp_commands_input: 0,
  cli_cdp_commands_network: 0,
  cli_cdp_commands_emulation: 0,
  cli_cdp_commands_browser: 0,
  cli_cdp_commands_storage: 0,
  cli_cdp_commands_fetch: 0,
  cli_cdp_commands_accessibility: 0,
  cli_cdp_commands_other: 0,
  cli_plugin_credentials_minted: 0,
  cli_plugin_credentials_revoked: 0,
  cli_plugin_commands_refused: 0,
  cli_file_picker_answers_armed: 0,
  cli_file_picker_answers_used: 0,
};

export const CDP_COMMAND_DOMAINS = ["target", "page", "runtime", "dom", "input", "network", "emulation", "browser", "storage", "fetch", "accessibility", "other"] as const;
export type CdpCommandDomain = (typeof CDP_COMMAND_DOMAINS)[number];
export type CdpCommandsByDomain = Partial<Record<CdpCommandDomain, number>>;

const FIELDS = {
  auto: ["cli_auto_installs", "cli_auto_install_failures"],
  upgrade: ["cli_upgrades", "cli_upgrade_failures"],
  settings: ["cli_settings_installs", "cli_settings_install_failures"],
} as const;

let counts = { ...NONE };
let windowlessSeen = { given: 0, missed: 0 };
const PLUGIN_TOTALS = { minted: "cli_plugin_credentials_minted", revoked: "cli_plugin_credentials_revoked", refused: "cli_plugin_commands_refused" } as const;
let pluginSeen = { minted: 0, revoked: 0, refused: 0 };
let pickerSeen = { armed: 0, used: 0 };
let cdpCommandsSeen: Record<CdpCommandDomain, number> = Object.fromEntries(CDP_COMMAND_DOMAINS.map((domain) => [domain, 0])) as Record<CdpCommandDomain, number>;

export const noteCliInstall = (reason: CliInstallReason, ok: boolean, consent?: ConsentToken | null) => countFor(consent, () => void counts[FIELDS[reason][ok ? 0 : 1]]++, { [FIELDS[reason][ok ? 0 : 1]]: 1 });
export function noteCliPillShown(compact: boolean) {
  counts.cli_pill_shows++;
  if (compact) counts.cli_pill_compact_shows++;
}
export const noteCliAutoEnabled = () => void counts.cli_auto_enables++;

export function noteWindowlessPages(totals: { given: number; missed: number } | undefined) {
  if (!totals) return;
  const given = Number(totals.given) || 0, missed = Number(totals.missed) || 0;
  counts.windowless_pages_given_geometry += Math.max(0, given - windowlessSeen.given);
  counts.windowless_pages_missing_geometry += Math.max(0, missed - windowlessSeen.missed);
  windowlessSeen = { given: Math.max(given, windowlessSeen.given), missed: Math.max(missed, windowlessSeen.missed) };
}

export function noteCdpCommands(totals: CdpCommandsByDomain | undefined) {
  if (!totals) return;
  for (const domain of CDP_COMMAND_DOMAINS) {
    const total = Number(totals[domain]) || 0;
    counts[`cli_cdp_commands_${domain}`] += Math.max(0, total - cdpCommandsSeen[domain]);
    cdpCommandsSeen[domain] = Math.max(total, cdpCommandsSeen[domain]);
  }
}

export function notePluginTotals(totals: Partial<Record<keyof typeof PLUGIN_TOTALS, number>> | undefined) {
  if (!totals) return;
  for (const key of Object.keys(PLUGIN_TOTALS) as (keyof typeof PLUGIN_TOTALS)[]) {
    const total = Number(totals[key]) || 0;
    counts[PLUGIN_TOTALS[key]] += Math.max(0, total - pluginSeen[key]);
    pluginSeen[key] = Math.max(total, pluginSeen[key]);
  }
}

export function notePickerAnswers(totals: { armed?: number; used?: number } | undefined) {
  if (!totals) return;
  const armed = Number(totals.armed) || 0, used = Number(totals.used) || 0;
  counts.cli_file_picker_answers_armed += Math.max(0, armed - pickerSeen.armed);
  counts.cli_file_picker_answers_used += Math.max(0, used - pickerSeen.used);
  pickerSeen = { armed: Math.max(armed, pickerSeen.armed), used: Math.max(used, pickerSeen.used) };
}

export function noteCliEngineTotals(status: { windowlessPages?: { given: number; missed: number }; commandsByDomain?: CdpCommandsByDomain; pluginCredentials?: Partial<Record<keyof typeof PLUGIN_TOTALS, number>>; filePickerAnswers?: { armed?: number; used?: number } }) {
  noteWindowlessPages(status.windowlessPages);
  noteCdpCommands(status.commandsByDomain);
  notePluginTotals(status.pluginCredentials);
  notePickerAnswers(status.filePickerAnswers);
}

export function takeCliCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
