import assert from "node:assert/strict";
import { test } from "node:test";

const { noteCdpCommands, noteCliEngineTotals, noteWindowlessPages, takeCliCounts } = await import("./cliCounts.ts");

const windowless = (counts) => [counts.windowless_pages_given_geometry, counts.windowless_pages_missing_geometry];

test("the engine's running totals of windowless pages turn into counts since the last take", () => {
  noteWindowlessPages(undefined);
  assert.deepEqual(windowless(takeCliCounts()), [0, 0]);
  noteWindowlessPages({ given: 3, missed: 0 });
  noteWindowlessPages({ given: 3, missed: 0 });
  noteWindowlessPages({ given: 5, missed: 1 });
  assert.deepEqual(windowless(takeCliCounts()), [5, 1]);
  assert.deepEqual(windowless(takeCliCounts()), [0, 0]);
});

test("a status that arrives out of order never counts a page twice or takes one back", () => {
  noteWindowlessPages({ given: 8, missed: 1 });
  noteWindowlessPages({ given: 7, missed: 1 });
  noteWindowlessPages({ given: 8, missed: 2 });
  assert.deepEqual(windowless(takeCliCounts()), [3, 1]);
});

test("the token connection's commands by domain turn into counts since the last take", () => {
  takeCliCounts();
  noteCdpCommands(undefined);
  noteCdpCommands({ dom: 2, browser: 1, other: 0 });
  noteCdpCommands({ dom: 5, browser: 1, other: 3 });
  noteCdpCommands({ dom: 4, browser: 1, other: 3 });
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_cdp_commands_dom, counts.cli_cdp_commands_browser, counts.cli_cdp_commands_other, counts.cli_cdp_commands_page], [5, 1, 3, 0]);
  noteCdpCommands({ dom: 6, browser: 1, other: 3, page: 1 });
  const next = takeCliCounts();
  assert.deepEqual([next.cli_cdp_commands_dom, next.cli_cdp_commands_page], [1, 1]);
});

test("plugin credential totals from the engine turn into counts since the last take", () => {
  takeCliCounts();
  noteCliEngineTotals({ pluginCredentials: { minted: 2, revoked: 1, refused: 4 } });
  noteCliEngineTotals({ pluginCredentials: { minted: 3, revoked: 1, refused: 3 } });
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_plugin_credentials_minted, counts.cli_plugin_credentials_revoked, counts.cli_plugin_commands_refused], [3, 1, 4]);
});

test("file picker answers the engine counts turn into counts since the last take", () => {
  takeCliCounts();
  noteCliEngineTotals({ filePickerAnswers: { armed: 3, used: 2 } });
  noteCliEngineTotals({ filePickerAnswers: { armed: 4, used: 2 } });
  const counts = takeCliCounts();
  assert.deepEqual([counts.cli_file_picker_answers_armed, counts.cli_file_picker_answers_used], [4, 2]);
});
