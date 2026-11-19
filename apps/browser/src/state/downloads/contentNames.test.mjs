import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { useBrowser } = await import("../browser/store.ts");
const { contentDate, contentFilename, extensionOf, isoDay, slug, withNumber } = await import("./contentName.ts");
const { contentNameToggle, nameByContent, noteContentNameEvent, resetContentNamesForTests, toggleContentName, useContentNames } = await import("./contentNames.ts");
const { downloadMenuItems } = await import("./downloadMenu.ts");
const { takeDownloadsPanelCounts } = await import("../telemetry/downloadsPanelCounts.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const FINISHED = new Date(2026, 10, 19, 15, 30);
const download = (id, extra = {}) => ({
  id, url: `https://dl.example/${id}`, filename: "scan0042.pdf", path: `/Users/me/Downloads/scan0042.pdf`, state: "finished", paused: false, received: 10, total: 10, speed: 0, mimeType: "application/pdf", profile: "", ...extra,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let renames;
function engineRenames(answer = () => "ok") {
  renames = [];
  globalThis.acTestRenameFile = ({ path, name }) => {
    renames.push(name);
    const result = answer(name);
    return result === "ok" ? { ok: true, path: `${path.slice(0, path.lastIndexOf("/"))}/${name}` } : { ok: false, reason: result };
  };
}
const suggests = (reply) => (globalThis.acTestSuggestDownloadName = () => reply);
const INVOICE = { status: "ok", category: "Invoice", title: "Acme Cloud Hosting — October", date: "2026-10-31" };

beforeEach(() => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  S().createWindow({ url: "https://a.example/" });
  S().updateSettings({ nameDownloadsByContent: true });
  resetContentNamesForTests("available");
  engineRenames();
  suggests(INVOICE);
  takeDownloadsPanelCounts();
});

test("a name keeps the extension, compound ones included, and ignores dots that aren't one", () => {
  assert.equal(extensionOf("report.PDF"), ".PDF");
  assert.equal(extensionOf("backup.tar.gz"), ".tar.gz");
  assert.equal(extensionOf("README"), "");
  assert.equal(extensionOf(".zshrc"), "");
  assert.equal(extensionOf("v1.2 notes final"), "");
});

test("a title becomes a short ASCII slug cut at a word", () => {
  assert.equal(slug("Acme Cloud Hosting — October"), "acme-cloud-hosting-october");
  assert.equal(slug("Résumé: Zoë Müller"), "resume-zoe-muller");
  assert.equal(slug("one two three four five six seven eight nine ten eleven twelve"), "one-two-three-four-five-six-seven-eight-nine-ten");
  assert.equal(slug("!!!"), "");
});

test("a date from the content is used only when it's real and plausible", () => {
  assert.equal(contentDate("2026-10-31", FINISHED), "2026-10-31");
  assert.equal(contentDate("2026-02-30", FINISHED), "2026-11-19");
  assert.equal(contentDate("3024-01-01", FINISHED), "2026-11-19");
  assert.equal(contentDate("", FINISHED), "2026-11-19");
  assert.equal(contentDate("October 31", FINISHED), "2026-11-19");
});

test("the name is date_category_title.ext, with an unknown category as other", () => {
  assert.equal(contentFilename(INVOICE, "scan0042.PDF", FINISHED), "2026-10-31_invoice_acme-cloud-hosting-october.pdf");
  assert.equal(contentFilename({ ...INVOICE, category: "spaceship", date: "" }, "x.pdf", FINISHED), "2026-11-19_other_acme-cloud-hosting-october.pdf");
  assert.equal(contentFilename({ ...INVOICE, title: "…" }, "x.pdf", FINISHED), null);
  assert.equal(withNumber("2026-10-31_invoice_acme.pdf", 2), "2026-10-31_invoice_acme-2.pdf");
  assert.equal(contentFilename({ ...INVOICE, title: "ACME Cloud Hosting Invoice" }, "x.pdf", FINISHED), "2026-10-31_invoice_acme-cloud-hosting.pdf", "the category isn't said twice");
  assert.equal(contentFilename({ ...INVOICE, title: "Invoice" }, "x.pdf", FINISHED), "2026-10-31_invoice_invoice.pdf");
});

test("a download that finishes while Ardia watches is renamed on disk and remembers its original name", async () => {
  noteContentNameEvent(download("d1", { state: "downloading" }));
  S().upsertDownload(download("d1"));
  noteContentNameEvent(download("d1"));
  await flush();
  const named = `2026-10-31_invoice_acme-cloud-hosting-october.pdf`;
  assert.deepEqual(renames, [named]);
  assert.equal(S().downloads.find((d) => d.id === "d1").filename, named);
  assert.equal(S().downloads.find((d) => d.id === "d1").path, `/Users/me/Downloads/${named}`);
  assert.deepEqual(useContentNames.getState().names.d1, { original: "scan0042.pdf", named, showing: "named", folder: "/Users/me/Downloads" });
  assert.deepEqual(useContentNames.getState().thinking, {});
  assert.equal(takeDownloadsPanelCounts().download_content_names, 1);
});

test("history the engine replays at launch is never renamed", async () => {
  S().upsertDownload(download("old"));
  noteContentNameEvent(download("old"));
  await flush();
  assert.deepEqual(renames, []);
});

test("a taken name gets a number, and any other refusal leaves the file alone", async () => {
  engineRenames((name) => (name.endsWith("october.pdf") ? "exists" : "ok"));
  S().upsertDownload(download("d2"));
  assert.equal(await nameByContent(download("d2"), FINISHED), "2026-10-31_invoice_acme-cloud-hosting-october-2.pdf");
  engineRenames(() => "failed");
  S().upsertDownload(download("d3"));
  assert.equal(await nameByContent(download("d3"), FINISHED), null);
  assert.equal(takeDownloadsPanelCounts().download_content_names_failed, 1);
});

test("nothing is renamed when the setting is off, the file is private or dangerous, or the model can't read it", async () => {
  S().updateSettings({ nameDownloadsByContent: false });
  S().upsertDownload(download("off"));
  assert.equal(await nameByContent(download("off"), FINISHED), null);
  S().updateSettings({ nameDownloadsByContent: true });
  for (const extra of [{ offTheRecord: true }, { dangerous: true }, { id: "wk-1" }]) {
    assert.equal(await nameByContent(download(extra.id ?? "skip", extra), FINISHED), null);
  }
  suggests({ status: "unreadable" });
  S().upsertDownload(download("zip"));
  assert.equal(await nameByContent(download("zip"), FINISHED), null);
  assert.deepEqual(renames, []);
  assert.equal(takeDownloadsPanelCounts().download_content_names_unreadable, 1);
});

test("an unavailable model or an app without file renames stops quietly for the rest of the launch", async () => {
  suggests({ status: "unavailable" });
  S().upsertDownload(download("a"));
  assert.equal(await nameByContent(download("a"), FINISHED), null);
  suggests(INVOICE);
  S().upsertDownload(download("b"));
  assert.equal(await nameByContent(download("b"), FINISHED), null, "the model said it can't, so the next one isn't asked");
  resetContentNamesForTests("available");
  delete globalThis.acTestRenameFile;
  S().upsertDownload(download("c"));
  assert.equal(await nameByContent(download("c"), FINISHED), null);
  assert.equal(takeDownloadsPanelCounts().download_content_names_failed, 0, "an older app isn't a failure");
});

test("the arrow switches the file between the original and the suggested name", async () => {
  S().upsertDownload(download("d4"));
  const named = await nameByContent(download("d4"), FINISHED);
  const d = () => S().downloads.find((x) => x.id === "d4");
  assert.equal(contentNameToggle(d(), useContentNames.getState().names.d4), "original");
  assert.equal(await toggleContentName("d4"), true);
  assert.equal(d().filename, "scan0042.pdf");
  assert.equal(d().path, "/Users/me/Downloads/scan0042.pdf");
  assert.equal(useContentNames.getState().names.d4.showing, "original");
  assert.equal(contentNameToggle(d(), useContentNames.getState().names.d4), "named");
  assert.equal(await toggleContentName("d4"), true);
  assert.equal(d().filename, named);
  const counts = takeDownloadsPanelCounts();
  assert.equal(counts.download_content_name_reverts, 1);
  assert.equal(counts.download_content_name_restores, 1);
  S().upsertDownload({ ...d(), filename: "renamed-in-finder.pdf" });
  assert.equal(contentNameToggle(d(), useContentNames.getState().names.d4), null, "a name changed elsewhere offers no switch");
});

test("history the engine replays after a relaunch shows the name the file has now", async () => {
  S().upsertDownload(download("d5"));
  const named = await nameByContent(download("d5"), FINISHED);
  S().upsertDownload(download("d5"));
  noteContentNameEvent(download("d5"));
  assert.equal(S().downloads.find((x) => x.id === "d5").filename, named, "the engine still says scan0042.pdf; the row keeps the file's name");
  assert.equal(S().downloads.find((x) => x.id === "d5").path, `/Users/me/Downloads/${named}`);
});

test("the context menu offers the switch for a renamed file", () => {
  const base = { held: false, downloading: false, paused: false, opensWhenDone: false, fileExists: true };
  const titles = (state) => downloadMenuItems(state).map((item) => item.title).filter(Boolean);
  assert.ok(titles({ ...base, nameSwitch: "original" }).includes("Use Original Name"));
  assert.ok(titles({ ...base, nameSwitch: "named" }).includes("Use Suggested Name"));
  assert.ok(!titles(base).some((t) => t.startsWith("Use ")));
  assert.equal(isoDay(FINISHED), "2026-11-19");
});
