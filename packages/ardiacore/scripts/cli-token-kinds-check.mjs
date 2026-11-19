#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { session, sleep } from "../../../scripts/lib/instance.mjs";

const usage = `usage: cli-token-kinds-check.mjs <Ardia.app>
Checks the two kinds of token connection in one hidden instance with two windows, over the real token server (no
DevTools port): the ardia command's token (kind cli) gets every method and target, including Browser.setDownloadBehavior,
a chrome:// page and the browser target; a plugin credential minted for window 1 (engine.cliPluginCredential, kind
plugin) sees and attaches only window 1's web pages, is refused a chrome:// attach, Browser.setDownloadBehavior,
DOM.setFileInputFiles, cookies, Target.createTarget and window 2's page, isn't written to ArdiaControl.json and can't
read /ardia/active; revoking it closes its socket and a new connection with it is refused. A plugin gets exactly its
allowlist (one allowed and one refused method per domain), Runtime only in its own isolated world (main world refused,
no universal access), no Network method and no Network, console or main-world context event; when its tab moves to
another window, a command in flight answers tab_out_of_scope and the session is detached. The CLI answers a page's
showOpenFilePicker, showSaveFilePicker and showDirectoryPicker with Ardia.answerFilePicker (no dialog opens), and a
plugin is refused that command. The app's file eval runs
through its perf probe, so a release build works.`;
const [appArg] = process.argv.slice(2);
if (!appArg || appArg === "-h" || appArg === "--help") {
  console.log(usage);
  process.exit(appArg ? 0 : 64);
}
const app = resolve(appArg);
if (app.startsWith("/Applications/")) throw new Error("never an installed app");

const work = mkdtempSync(join(tmpdir(), "ac-token-kinds-"));
const data = join(work, "d");
mkdirSync(data);

const PICKERS = `<button id=open style="position:fixed;left:0;top:40px;width:200px;height:40px">open</button>
<button id=save style="position:fixed;left:0;top:90px;width:200px;height:40px">save</button>
<button id=dir style="position:fixed;left:0;top:140px;width:200px;height:40px">dir</button>
<script>
const report = (p) => p.then((v) => (window.picked = v), (e) => (window.picked = "error:" + e.name));
open.onclick = () => report(showOpenFilePicker().then(async ([h]) => "open:" + h.name + ":" + (await (await h.getFile()).text())));
save.onclick = () => report(showSaveFilePicker().then(async (h) => { const w = await h.createWritable(); await w.write("saved by the page"); await w.close(); return "save:" + h.name; }));
dir.onclick = () => report(showDirectoryPicker().then(async (d) => { const names = []; for await (const [n] of d.entries()) names.push(n); return "dir:" + names.sort().join(","); }));
</script>`;
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>${req.url.slice(1)}</title><input type=file id=f>${PICKERS}`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

writeFileSync(join(data, "session.json"), JSON.stringify(session({
  settings: { cliControl: true },
  windows: [{ id: "w1" }, { id: "w2" }],
  tabs: [{ id: "t1", windowId: "w1", url: `${origin}/one` }, { id: "t3", windowId: "w1", url: `${origin}/three` }, { id: "t2", windowId: "w2", url: `${origin}/two` }],
})));
writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
writeFileSync(join(data, "perf-probe"), "");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const until = async (what, fn, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const v = await fn().catch(() => null);
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};
let evals = 0;
const appEval = async (body) => {
  const id = `k${process.pid}-${++evals}`;
  writeFileSync(join(data, "dev-eval.js"), `// ${id}\n${body}`);
  return until(`eval ${id}`, async () => {
    const out = JSON.parse(readFileSync(join(data, "dev-eval-result.json"), "utf8"));
    if (out.id !== id) return null;
    writeFileSync(join(data, "dev-eval-result.json"), JSON.stringify({ id }));
    if (out.error) throw new Error(out.error);
    return { value: out.result };
  }).then((r) => r.value);
};

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 1;
    const waiting = new Map();
    const events = [];
    ws.onopen = () => resolve({
      ws, events,
      closed: new Promise((r) => ws.addEventListener("close", r)),
      raw: (id, method, params = {}, sessionId) => new Promise((done) => {
        waiting.set(id, done);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => waiting.delete(id) && done({ error: { message: "timed out" } }), 15000);
      }),
      send: (method, params = {}, sessionId) => new Promise((done) => {
        const id = next++;
        waiting.set(id, done);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => waiting.delete(id) && done({ error: { message: "timed out" } }), 15000);
      }),
    });
    ws.onerror = () => reject(new Error("websocket refused"));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else events.push(m);
    };
  });
}
const refused = (reply) => !!reply.error;
const text = (reply) => (reply.error ? reply.error.message : JSON.stringify(reply.result).slice(0, 120));

execFileSync("open", ["-g", "-n", "--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${data}`, app]);
const controlFile = join(data, "Chromium", "ArdiaControl.json");
let pid = null;
try {
  await until("ArdiaControl.json", async () => existsSync(controlFile) && statSync(controlFile).size > 0, 90000);
  const control = JSON.parse(readFileSync(controlFile, "utf8"));
  pid = control.pid;
  const base = `ws://127.0.0.1:${control.port}${control.browser}`;

  const cli = await connect(`${base}?token=${control.token}`);
  const urlsOf = async (c) => ((await c.send("Target.getTargets")).result?.targetInfos ?? []).filter((t) => t.type === "page").map((t) => t);
  const pages = await until("both windows' pages", async () => {
    const all = await urlsOf(cli);
    const one = all.find((t) => t.url === `${origin}/one`), two = all.find((t) => t.url === `${origin}/two`);
    return one && two ? { one, two } : null;
  });
  const chrome = await cli.send("Target.createTarget", { url: "chrome://version", background: true });
  const chromeSession = chrome.result && (await cli.send("Target.attachToTarget", { targetId: chrome.result.targetId, flatten: true }));
  check("cli: a chrome:// page attaches", !!chromeSession?.result?.sessionId, text(chromeSession ?? chrome));
  const cliDownloads = await cli.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") });
  check("cli: Browser.setDownloadBehavior answers", !refused(cliDownloads), text(cliDownloads));
  const cliBrowser = await cli.send("Target.attachToBrowserTarget");
  check("cli: the browser target attaches", !!cliBrowser.result?.sessionId, text(cliBrowser));
  const cliTwo = await cli.send("Target.attachToTarget", { targetId: pages.two.targetId, flatten: true });
  check("cli: a page in either window attaches", !!cliTwo.result?.sessionId, text(cliTwo));

  const minted = await appEval(`return ac.engine.call("engine.cliPluginCredential", { tabId: "t1" })`);
  check("a plugin credential is minted for window 1", !!minted?.credential && !!minted?.id, JSON.stringify(minted ?? null).replace(/"credential":"[^"]+"/, '"credential":"…"'));
  check("the plugin credential isn't in ArdiaControl.json", !readFileSync(controlFile, "utf8").includes(minted.credential));
  const active = await fetch(`http://127.0.0.1:${control.port}/ardia/active?token=${encodeURIComponent(minted.credential)}`).then((r) => r.status, () => 0);
  check("the plugin credential can't read /ardia/active", active !== 200, String(active));

  const plugin = await connect(`${base}?token=${encodeURIComponent(minted.credential)}`);
  const seen = (await urlsOf(plugin)).map((t) => t.url);
  check("plugin: Target.getTargets is filtered to window 1's web pages", seen.includes(`${origin}/one`) && !seen.includes(`${origin}/two`) && seen.every((u) => u.startsWith(origin)), seen.join(" "));
  const own = await plugin.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true });
  const ps = own.result?.sessionId;
  check("plugin: window 1's page attaches", !!ps, text(own));
  const other = await plugin.send("Target.attachToTarget", { targetId: pages.two.targetId, flatten: true });
  check("plugin: window 2's page is refused", refused(other), text(other));
  const chromeAttach = await plugin.send("Target.attachToTarget", { targetId: chrome.result.targetId, flatten: true });
  check("plugin: a chrome:// attach is refused", refused(chromeAttach), text(chromeAttach));

  await plugin.send("Runtime.enable", {}, ps);
  await plugin.send("Page.enable", {}, ps);
  const frameId = (await plugin.send("Page.getFrameTree", {}, ps)).result?.frameTree?.frame?.id;
  const world = await plugin.send("Page.createIsolatedWorld", { frameId, worldName: "ardia-plugin", grantUniveralAccess: true }, ps);
  const isolated = world.result?.executionContextId;
  check("plugin: Page.createIsolatedWorld answers with its context", Number.isInteger(isolated), text(world));
  const inWorld = await plugin.send("Runtime.evaluate", { expression: "document.title", contextId: isolated, returnByValue: true }, ps);
  check("plugin: Runtime.evaluate in its isolated world reads the page", inWorld.result?.result?.value === "one", text(inWorld));
  const mainWorld = await plugin.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, ps);
  check("plugin: Runtime.evaluate in the main world is refused", refused(mainWorld) && /main world/.test(mainWorld.error?.message ?? ""), text(mainWorld));
  const otherContext = await plugin.send("Runtime.evaluate", { expression: "1", contextId: isolated + 1000 }, ps);
  check("plugin: a context it didn't create is refused", refused(otherContext), text(otherContext));
  const crossOrigin = `http://localhost:${server.address().port}/two`;
  const universal = await plugin.send("Runtime.evaluate", { expression: `fetch(${JSON.stringify(crossOrigin)}).then(() => "fetched", () => "blocked")`, contextId: isolated, awaitPromise: true, returnByValue: true }, ps);
  check("plugin: its isolated world has no universal access (a cross-origin fetch stays blocked)", universal.result?.result?.value === "blocked", text(universal));

  const allowed = [
    ["DOM.getDocument", {}],
    ["Accessibility.getFullAXTree", {}],
    ["Page.getLayoutMetrics", {}],
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }],
    ["Emulation.setFocusEmulationEnabled", { enabled: true }],
    ["Target.getTargetInfo", { targetId: pages.one.targetId }],
  ];
  for (const [method, params] of allowed) {
    const reply = await plugin.send(method, params, method.startsWith("Target.") ? undefined : ps);
    check(`plugin: ${method} answers`, !refused(reply), text(reply));
  }
  const refusedHere = [
    ["DOM.setFileInputFiles", { files: [join(work, "x")], backendNodeId: 1 }, ps],
    ["Accessibility.queryAXTree", { backendNodeId: 1 }, ps],
    ["Page.printToPDF", {}, ps],
    ["Page.addScriptToEvaluateOnNewDocument", { source: "1" }, ps],
    ["Page.startScreencast", {}, ps],
    ["Page.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") }, ps],
    ["Input.dispatchDragEvent", { type: "dragEnter", x: 1, y: 1, data: { items: [], dragOperationsMask: 1 } }, ps],
    ["Emulation.setDeviceMetricsOverride", { width: 1, height: 1, deviceScaleFactor: 1, mobile: false }, ps],
    ["Target.createTarget", { url: `${origin}/three` }],
    ["Target.setDiscoverTargets", { discover: true }],
    ["Target.activateTarget", { targetId: pages.one.targetId }],
    ["Target.closeTarget", { targetId: pages.one.targetId }],
    ["Target.attachToBrowserTarget", {}],
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
    ["Network.enable", {}, ps],
    ["Network.getCookies", {}, ps],
    ["Network.enableDeviceBoundSessions", { enable: true }, ps],
    ["Network.deleteDeviceBoundSession", { key: { site: origin, id: "x" } }, ps],
    ["Fetch.enable", {}, ps],
    ["Storage.getCookies", {}],
    ["IO.read", { handle: "1" }],
    ["Tracing.start", {}],
    ["Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") }],
    ["Overlay.highlightNode", { highlightConfig: {}, backendNodeId: 1 }, ps],
    ["Ardia.answerFilePicker", { kind: "open", paths: ["/etc/hosts"] }, ps],
  ];
  for (const [method, params, sessionId] of refusedHere) {
    const reply = await plugin.send(method, params, sessionId);
    check(`plugin: ${method} is refused`, refused(reply) && /plugin/.test(reply.error?.message ?? ""), text(reply));
  }

  await cli.send("Runtime.evaluate", { expression: "console.log('main world'); location.reload()" }, cliTwo.result?.sessionId);
  const csOne = (await cli.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true })).result?.sessionId;
  await cli.send("Network.enable", {}, csOne);
  await cli.send("Runtime.evaluate", { expression: "console.log('main world'); fetch(location.href)" }, csOne);
  await sleep(1500);
  const leaked = plugin.events.filter((e) => e.method?.startsWith("Network.") || e.method === "Runtime.consoleAPICalled");
  check("plugin: no Network or console event reaches it", leaked.length === 0, leaked.map((e) => e.method).join(" "));
  const mainContexts = plugin.events.filter((e) => e.method === "Runtime.executionContextCreated" && e.params?.context?.id !== isolated);
  check("plugin: no main-world execution context is announced to it", mainContexts.length === 0, mainContexts.map((e) => e.params?.context?.name).join(" "));

  const folder = join(work, "picked");
  mkdirSync(folder);
  writeFileSync(join(folder, "a.txt"), "from the ardia command");
  writeFileSync(join(folder, "b.txt"), "b");
  const cs = (await cli.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true })).result?.sessionId;
  const click = async (id) => {
    await cli.send("Runtime.evaluate", { expression: "window.picked = null" }, cs);
    const box = (await cli.send("Runtime.evaluate", { expression: `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`, returnByValue: true }, cs)).result?.result?.value ?? [0, 0];
    for (const type of ["mousePressed", "mouseReleased"]) await cli.send("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, cs);
    return until(`the ${id} picker`, async () => (await cli.send("Runtime.evaluate", { expression: "window.picked", returnByValue: true }, cs)).result?.result?.value ?? null, 15000).catch((e) => String(e.message));
  };
  const arm = (kind, paths) => cli.send("Ardia.answerFilePicker", { kind, paths }, cs);
  const armedOpen = await arm("open", [join(folder, "a.txt")]);
  check("cli: Ardia.answerFilePicker arms an answer", !refused(armedOpen), text(armedOpen));
  check("cli: showOpenFilePicker takes the answered file", (await click("open")) === "open:a.txt:from the ardia command");
  await arm("save", [join(folder, "out.txt")]);
  const saved = await click("save");
  check("cli: showSaveFilePicker takes the answered path and the page writes it", saved === "save:out.txt" && existsSync(join(folder, "out.txt")) && readFileSync(join(folder, "out.txt"), "utf8") === "saved by the page", saved);
  await arm("directory", [folder]);
  const listed = await click("dir");
  check("cli: showDirectoryPicker takes the answered folder without a permission prompt", listed === "dir:a.txt,b.txt,out.txt", listed);
  await arm("open", []);
  check("cli: an empty answer cancels the picker", (await click("open")) === "error:AbortError");
  const wrongKind = await arm("save", [join(folder, "x.txt")]);
  const unanswered = await click("open").then((v) => v, () => null);
  check("cli: an answer of another kind leaves the picker alone", !refused(wrongKind) && unanswered !== "open:x.txt", String(unanswered));

  await arm("open", [join(folder, "a.txt")]);
  await cli.send("Page.reload", {}, cs);
  await until("page one reloaded", async () => (await cli.send("Runtime.evaluate", { expression: "document.readyState === 'complete' && !!document.getElementById('open')", returnByValue: true }, cs)).result?.result?.value);
  const afterNavigation = await click("open").then((v) => v, () => null);
  check("cli: an answer armed before a navigation isn't used by the new document", afterNavigation !== "open:a.txt:from the ardia command", String(afterNavigation));
  const slow = cli.raw(424242, "Runtime.evaluate", { expression: "new Promise((r) => setTimeout(() => r(1), 1500))", awaitPromise: true }, cs);
  const duplicate = await cli.raw(424242, "Ardia.answerFilePicker", { kind: "open", paths: [join(folder, "a.txt")] }, cs);
  check("cli: Ardia.answerFilePicker with a pending command's id is refused", /still waiting/.test(duplicate.error?.message ?? ""), text(duplicate));
  await slow;

  const frameAgain = (await plugin.send("Page.getFrameTree", {}, ps)).result?.frameTree?.frame?.id;
  const worldAgain = (await plugin.send("Page.createIsolatedWorld", { frameId: frameAgain, worldName: "ardia-plugin" }, ps)).result?.executionContextId;
  const inFlight = plugin.send("Runtime.evaluate", { expression: "new Promise(() => {})", contextId: worldAgain, awaitPromise: true }, ps);
  await appEval(`ac.actions.moveTabToWindow("t1", "w2"); return true`);
  const cut = await Promise.race([inFlight, sleep(8000).then(() => ({ error: { message: "no answer" } }))]);
  check("plugin: a command in flight when its tab leaves the window answers tab_out_of_scope", (cut.error?.message ?? "").startsWith("ardia: tab_out_of_scope"), text(cut));
  const detached = await until("the detach event", async () => plugin.events.find((e) => e.method === "Target.detachedFromTarget" && e.params?.sessionId === ps) ?? null, 8000).catch(() => null);
  check("plugin: its session on the moved tab is detached with Target.detachedFromTarget", !!detached);
  const afterMove = await plugin.send("DOM.getDocument", {}, ps);
  check("plugin: the moved tab's session takes no more commands", refused(afterMove), text(afterMove));
  const seenAfterMove = (await urlsOf(plugin)).map((t) => t.url);
  check("plugin: Target.getTargets no longer lists the moved tab", !seenAfterMove.includes(`${origin}/one`), seenAfterMove.join(" "));

  const cliCookies = await cli.send("Network.getCookies", {}, cliTwo.result?.sessionId);
  check("cli: still gets everything after a plugin connected (Network.getCookies)", !refused(cliCookies), text(cliCookies));

  const pluginAlive = await plugin.send("Target.getTargets");
  check("plugin: its browser connection stays open after the detach", !refused(pluginAlive), text(pluginAlive));
  const revoked = await appEval(`return ac.engine.call("engine.cliPluginCredential", { revoke: ${JSON.stringify(minted.id)} })`);
  const closedInTime = await Promise.race([plugin.closed.then(() => true), sleep(5000).then(() => false)]);
  check("revoking the credential closes its connection", revoked?.revoked === true && closedInTime, JSON.stringify(revoked));
  const again = await connect(`${base}?token=${encodeURIComponent(minted.credential)}`).then(() => "accepted", () => "refused");
  check("a revoked credential can't connect again", again === "refused", again);
  const cliAlive = await cli.send("Browser.getVersion");
  check("cli: its connection is untouched by the revoke", !refused(cliAlive), text(cliAlive));
  cli.ws.close();
} finally {
  server.close();
  if (pid) try { process.kill(pid); } catch {}
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
