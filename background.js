// VTOP Course Page Filter - download renamer (service worker)
// Renames files downloaded from VTOP's Course Materials table:
//   FALLSEM2026-27_VL_BCSE303L_00100_TH_2026-11-02_Module-6.pdf
//   ->  Operating Systems_DHIVYAA C R_Module-6.pdf
// It only touches a download if (a) it comes from vtop.vit.ac.in and (b) you clicked in the
// materials table within the last 20 seconds. Everything else is left alone.

"use strict";

const TTL = 20000; // how long a clicked row stays "valid" for matching a download
const MAX_QUEUE = 30;

// Serialise access to the stored queue so rapid clicks/downloads cannot overwrite each other.
let chain = Promise.resolve();
function run(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

async function getQueue() {
  const o = await chrome.storage.session.get("q");
  return Array.isArray(o.q) ? o.q : [];
}
function setQueue(q) {
  return chrome.storage.session.set({ q });
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Remove characters Windows/macOS don't allow in file names, tidy spaces.
function cleanPart(s, max) {
  let t = String(s || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (max && t.length > max) t = t.slice(0, max).trim();
  return t.replace(/[. ]+$/, "");
}

// "FALLSEM2026-27_VL_BCSE303L_00100_TH_2026-11-02_Module-6 (2).pdf" -> "Module-6.pdf"
function stripPrefix(name) {
  let n = String(name || "").replace(/\s*\(\d+\)(?=\.[^.]+$)/, ""); // drop browser's " (2)"
  let m = n.match(
    /^[A-Za-z]+\d{4}-\d{2}_[A-Za-z]+_[A-Za-z0-9]+_\d+_[A-Za-z]+_\d{4}-\d{2}-\d{2}_(.+)$/
  );
  if (m) return m[1];
  // looser fallback: semester code ... upload date _ real name
  m = n.match(/^[A-Za-z]+\d{4}-\d{2}_.*?_\d{4}-\d{2}-\d{2}_(.+)$/);
  if (m) return m[1];
  return n; // unknown pattern: keep as is
}

function buildName(subject, faculty, real) {
  const dot = real.lastIndexOf(".");
  const ext = dot > 0 && real.length - dot <= 8 ? real.slice(dot) : "";
  const base = dot > 0 && ext ? real.slice(0, dot) : real;
  const parts = [cleanPart(subject, 60), cleanPart(faculty, 60), cleanPart(base, 120)].filter(Boolean);
  return parts.join("_") + ext;
}

// Content script tells us which row was just clicked.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "vtopDlCtx" && sender.id === chrome.runtime.id && msg.ctx) {
    const c = msg.ctx;
    const ctx = {
      subject: String(c.subject || "").slice(0, 200),
      faculty: String(c.faculty || "").slice(0, 200),
      mat: String(c.mat || "").slice(0, 200),
      t: Date.now(),
    };
    run(async () => {
      const q = (await getQueue()).filter((e) => ctx.t - e.t < TTL);
      q.push(ctx);
      await setQueue(q.slice(-MAX_QUEUE));
    });
  }
  sendResponse({ ok: true });
  return false;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const src = `${item.finalUrl || ""} ${item.url || ""} ${item.referrer || ""}`;
  if (!/vtop\.vit\.ac\.in/i.test(src)) return; // not a VTOP download: do nothing

  let answered = false;
  const done = (o) => {
    if (answered) return;
    answered = true;
    try {
      if (o) suggest(o);
      else suggest();
    } catch (e) {}
  };

  run(async () => {
    const now = Date.now();
    const q = (await getQueue()).filter((e) => now - e.t < TTL);
    if (!q.length) {
      await setQueue(q);
      return done(); // no recent click in the materials table: leave the name alone
    }

    const original = String(item.filename || "").split(/[\\/]/).pop();
    const real = stripPrefix(original);
    const key = norm(real.replace(/\.[^.]+$/, ""));

    // Prefer the clicked row whose material name matches the file; else the oldest click.
    let idx = q.findIndex((e) => e.mat && e.mat === key);
    if (idx < 0) idx = q.findIndex((e) => e.mat && key && (key.includes(e.mat) || e.mat.includes(key)));
    if (idx < 0) idx = 0;

    const ctx = q.splice(idx, 1)[0];
    await setQueue(q);

    const filename = buildName(ctx.subject, ctx.faculty, real);
    done(filename ? { filename, conflictAction: "uniquify" } : undefined);
  }).catch(() => done());

  return true; // we answer asynchronously
});
