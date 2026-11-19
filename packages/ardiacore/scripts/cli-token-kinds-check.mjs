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
read /ardia/active; revoking it closes its socket and a new connection with it is refused. The CLI answers a page's
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
  tabs: [{ id: "t1", windowId: "w1", url: `${origin}/one` }, { id: "t2", windowId: "w2", url: `${origin}/two` }],
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
  check("plugin: Target.getTargets shows window 1's page only", seen.includes(`${origin}/one`) && seen.every((u) => u === `${origin}/one`), seen.join(" "));
  const own = await plugin.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true });
  const ran = own.result && (await plugin.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, own.result.sessionId));
  check("plugin: window 1's page attaches and runs script", ran?.result?.result?.value === "one", text(ran ?? own));
  const other = await plugin.send("Target.attachToTarget", { targetId: pages.two.targetId, flatten: true });
  check("plugin: window 2's page is refused", refused(other), text(other));
  const chromeAttach = await plugin.send("Target.attachToTarget", { targetId: chrome.result.targetId, flatten: true });
  check("plugin: a chrome:// attach is refused", refused(chromeAttach), text(chromeAttach));
  for (const [method, params, sessionId] of [
    ["Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") }],
    ["Target.createTarget", { url: `${origin}/three` }],
    ["Target.attachToBrowserTarget", {}],
    ["Network.getCookies", {}, own.result?.sessionId],
    ["Storage.getCookies", {}],
    ["DOM.setFileInputFiles", { files: [join(work, "x")], backendNodeId: 1 }, own.result?.sessionId],
    ["Page.navigate", { url: "chrome://settings" }, own.result?.sessionId],
  ]) {
    const reply = await plugin.send(method, params, sessionId);
    check(`plugin: ${method} is refused`, refused(reply) && /plugin/.test(reply.error?.message ?? ""), text(reply));
  }
  const pickerAnswer = await plugin.send("Ardia.answerFilePicker", { kind: "open", paths: ["/etc/hosts"] }, own.result?.sessionId);
  check("plugin: Ardia.answerFilePicker is refused", refused(pickerAnswer) && /plugin/.test(pickerAnswer.error?.message ?? ""), text(pickerAnswer));

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

  const cliCookies = await cli.send("Network.getCookies", {}, cliTwo.result?.sessionId);
  check("cli: still gets everything after a plugin connected (Network.getCookies)", !refused(cliCookies), text(cliCookies));

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
