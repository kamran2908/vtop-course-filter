// VTOP Course Page Filter - click watcher (isolated world, can talk to the extension).
// When you click a download/link in the Course Materials table, it tells background.js
// which subject, faculty and material that row belongs to, so the file can be renamed.
(function () {
  "use strict";
  if (window.__vtopDlWatcher) return;
  window.__vtopDlWatcher = true;

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // Text of an element with line breaks preserved (innerText in browsers; HTML fallback elsewhere).
  function textOf(el) {
    if (!el) return "";
    if (typeof el.innerText === "string") return el.innerText;
    return el.innerHTML
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|tr|td)>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&");
  }

  function isMaterialsTable(table) {
    const h = table && table.tHead;
    if (!h) return false;
    const t = h.textContent.toLowerCase();
    return t.includes("uploaded by") && t.includes("material detail");
  }

  function colIndex(table, re) {
    const rows = table.tHead ? table.tHead.rows : [];
    for (let r = rows.length - 1; r >= 0; r--) {
      const cells = rows[r].cells;
      for (let i = 0; i < cells.length; i++) if (re.test(cells[i].textContent)) return i;
    }
    return -1;
  }

  // "20701 - DHIVYAA C R - SCOPE   02-11-2026"  ->  "DHIVYAA C R"
  function parseFaculty(txt) {
    const lines = String(txt || "")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let line = lines.find((l) => !/^\d{2}-\d{2}-\d{4}$/.test(l)) || "";
    line = line.replace(/\s*\d{2}-\d{2}-\d{4}.*$/, "").trim();
    const parts = line.split(/\s+-\s+/);
    if (parts.length && /^\d+$/.test(parts[0])) parts.shift(); // employee id
    if (parts.length > 1 && /^[A-Z&]{2,8}$/.test(parts[parts.length - 1])) parts.pop(); // school
    return parts.join(" - ");
  }

  // "Fall Semester 2026-27 / BCSE303L - Operating Systems - TH"  ->  "Operating Systems"
  function parseSubject(txt) {
    const re = /\b[A-Z]{3,5}\d{3,4}[A-Z]?\s+-\s+(.+)$/;
    const lines = String(txt || "").split(/\n/).map((l) => l.trim());
    const candidates = lines.concat([lines.join(" ")]);
    for (const line of candidates) {
      const m = line.match(re);
      if (!m) continue;
      const parts = m[1].split(/\s+-\s+/);
      if (parts.length > 1 && /^[A-Z]{1,4}$/.test(parts[parts.length - 1])) parts.pop(); // TH / LO / ETH
      const s = parts.join(" - ").trim();
      if (s) return s;
    }
    return "";
  }

  // Fallback: the course chosen in VTOP's own (hidden) dropdown.
  function subjectFromSelect() {
    const sels = document.getElementsByTagName("select");
    for (let i = 0; i < sels.length; i++) {
      const o0 = sels[i].options[0];
      if (!o0 || !o0.textContent.includes("Registered Courses")) continue;
      const opt = sels[i].options[sels[i].selectedIndex];
      if (!opt || !opt.value) return "";
      const parts = opt.textContent.trim().split(" - ");
      const k = parts.findIndex((p) => /^[A-Z]{3,5}\d{3,4}[A-Z]?$/.test(p.trim()));
      return k >= 0 && parts[k + 1] ? parts[k + 1].trim() : "";
    }
    return "";
  }

  document.addEventListener(
    "click",
    (e) => {
      try {
        if (localStorage.getItem("vtopFilter.rename") === "0") return; // user switched it off
        const target = e.target;
        if (!target || !target.closest) return;
        if (!target.closest("a, button, input, i, svg, img, [onclick]")) return;
        const td = target.closest("td");
        if (!td) return;
        const tr = td.parentElement;
        const table = td.closest("table");
        if (!tr || !table || !tr.parentElement || tr.parentElement.tagName !== "TBODY") return;
        if (!isMaterialsTable(table)) return;

        const cells = tr.cells;
        const iCourse = colIndex(table, /course detail/i);
        const iMat = colIndex(table, /material detail/i);
        const iBy = colIndex(table, /uploaded by/i);
        if (iMat < 0 || iBy < 0 || !cells[iBy]) return;

        const faculty = parseFaculty(textOf(cells[iBy]));
        const subject =
          (iCourse >= 0 && cells[iCourse] ? parseSubject(textOf(cells[iCourse])) : "") ||
          subjectFromSelect();
        const matLine =
          String(textOf(cells[iMat]) || "")
            .split(/\n/)
            .map((l) => l.trim())
            .find(Boolean) || "";

        const p = chrome.runtime.sendMessage({
          type: "vtopDlCtx",
          ctx: { subject, faculty, mat: norm(matLine) },
        });
        if (p && p.catch) p.catch(() => {});
      } catch (err) {
        // extension reloaded or page changed: ignore silently
      }
    },
    true // capture phase: runs before VTOP's own click handler starts the download
  );
})();
