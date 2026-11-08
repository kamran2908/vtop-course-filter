(function () {
  "use strict";

  // Runs in the page's MAIN world (see manifest "world": "MAIN"), so window.jQuery
  // and VTOP's DataTables are directly reachable. No script-injection bridge needed.
  if (window.__vtopFilterActive) return;
  window.__vtopFilterActive = true;

  const UI_ID = "vtop-custom-course-filter";
  const POLL_MS = 40; // safety-net poll; the real triggers are ajaxComplete + DOM mutations
  const GIVE_UP_MS = 15000;
  const STALE_MS = 3000; // max time to ignore the previous subject's table
  const DT_GRACE_MS = 1500; // max wait for DataTables to attach before falling back
  const log = (...a) => console.debug("[VTOP Filter]", ...a);

  const state = {
    sem: "",
    subj: "",
    fac: "ALL",
    subjQ: "",
    facQ: "",
    courses: {}, // { semester: [{value, label}] }
    sems: [],
    faculty: [], // [{name, count}]
    facCol: 3, // index of the "Uploaded By" column (auto-detected)
    native: null, // VTOP's own course <select>
    loadTs: 0,
    timer: null,
    hooked: false,
    hookTable: null,
    pending: null, // in-flight "wait for the new table" job
    cache: new Map(), // subject value -> faculty list (instant re-selection)
  };

  const $ = (id) => document.getElementById(id);
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  /* ------------------------------------------------------------------ */
  /*  Tiny persistent cache: faculty names per subject + last semester   */
  /*  (stored only in this browser's localStorage; nothing is sent out)  */
  /* ------------------------------------------------------------------ */
  const LS_KEY = "vtopFilter.v1";
  const CACHE_TTL = 14 * 24 * 3600 * 1000;
  const CACHE_MAX = 80;
  let persist = { sem: "", fac: {} };
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (o && typeof o === "object") persist = { sem: o.sem || "", fac: o.fac || {} };
  } catch (e) {}
  const savePersist = debounce(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(persist));
    } catch (e) {}
  }, 300);
  function cacheGet(subj) {
    const e = persist.fac[subj];
    if (!e || !Array.isArray(e.f) || Date.now() - e.t > CACHE_TTL) return null;
    return e.f.map((x) => ({ name: x[0], count: x[1] }));
  }
  function cacheSet(subj, list) {
    persist.fac[subj] = { t: Date.now(), f: list.map((f) => [f.name, f.count]) };
    const keys = Object.keys(persist.fac);
    if (keys.length > CACHE_MAX) {
      keys
        .sort((a, b) => persist.fac[a].t - persist.fac[b].t)
        .slice(0, keys.length - CACHE_MAX)
        .forEach((k) => delete persist.fac[k]);
    }
    savePersist();
  }
  function setBusy(on) {
    const b = $("vtop-busy");
    if (b) b.style.display = on ? "block" : "none";
  }

  /* ------------------------------------------------------------------ */
  /*  Keep the UI alive when VTOP swaps its DOM (cheap, debounced)       */
  /* ------------------------------------------------------------------ */
  let scanTimer = null;
  new MutationObserver(() => {
    if (state.pending) tryExtract(); // table just landed? extract right now
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      ensureUI();
    }, 40);
  }).observe(document.body, { childList: true, subtree: true });
  ensureUI();
  hookAjax();

  // Know the exact moment VTOP's AJAX finishes (its success handler has already inserted
  // the HTML and initialised DataTables by the time ajaxComplete fires).
  function hookAjax() {
    const j = window.jQuery || window.$;
    if (!j || !j.fn) return;
    try {
      j(document).ajaxSend(() => {
        if (state.pending) state.pending.sent++;
      });
      j(document).ajaxComplete(() => {
        setTimeout(() => {
          const p = state.pending;
          if (p) {
            p.done++;
            if (p.sent > 0 && p.done >= p.sent) p.ajaxDone = true;
            tryExtract();
          }
          ensureUI();
        }, 0);
      });
    } catch (e) {}
  }

  function ensureUI() {
    const ui = $(UI_ID);
    if (ui && state.native && state.native.isConnected) return; // all good
    if (ui) ui.remove(); // orphaned by an AJAX swap
    const sel = findCourseDropdown();
    if (sel) initExtension(sel);
  }

  function findCourseDropdown() {
    const selects = document.getElementsByTagName("select");
    for (let i = 0; i < selects.length; i++) {
      const o = selects[i].options[0];
      if (o && o.textContent.includes("Registered Courses")) return selects[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /*  DataTables helpers                                                 */
  /* ------------------------------------------------------------------ */
  function getDT() {
    for (const k of ["jQuery", "$"]) {
      const j = window[k];
      if (j && j.fn && j.fn.dataTable && j.fn.dataTable.isDataTable) return j.fn.dataTable;
    }
    if (window.DataTable && window.DataTable.isDataTable) return window.DataTable;
    return null;
  }

  // Returns the API of an ALREADY-initialised table. Never initialises one itself
  // (calling .DataTable() early is what produced duplicate "Show entries"/"Search" boxes).
  function getApi(table) {
    const dt = getDT();
    if (!dt) return null;
    try {
      if (dt.isDataTable(table)) return new dt.Api(table);
    } catch (e) {}
    return null;
  }

  function isMaterialsHead(t) {
    const h = t.tHead;
    if (!h) return false;
    const x = h.textContent.toLowerCase(); // textContent: no forced layout, unlike innerText
    return x.includes("uploaded by") && x.includes("material detail");
  }

  function findMaterialsTable() {
    const dt = getDT();
    if (dt && Array.isArray(dt.settings)) {
      for (let i = dt.settings.length - 1; i >= 0; i--) {
        const t = dt.settings[i] && dt.settings[i].nTable;
        if (t && t.isConnected && isMaterialsHead(t)) return t;
      }
    }
    const tables = document.getElementsByTagName("table");
    for (let i = tables.length - 1; i >= 0; i--) {
      const t = tables[i];
      if (!t.tBodies.length || t.querySelector("table")) continue; // skip scroll-head clones / layout tables
      if (isMaterialsHead(t)) return t;
    }
    return null;
  }

  function facultyColumn(table) {
    const rows = table.tHead ? table.tHead.rows : [];
    for (let r = rows.length - 1; r >= 0; r--) {
      const cells = rows[r].cells;
      for (let i = 0; i < cells.length; i++) {
        if (/uploaded\s*by/i.test(cells[i].textContent)) return i;
      }
    }
    return 3;
  }

  /* ------------------------------------------------------------------ */
  /*  Faculty text cleaning (single source of truth for list AND filter) */
  /* ------------------------------------------------------------------ */
  function cleanFaculty(v) {
    if (v == null) return "";
    let s = typeof v === "string" ? v : v.innerHTML !== undefined ? v.innerHTML : String(v);
    s = s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|tr|td)>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&");
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // drop the DD-MM-YYYY upload date (and anything after it)
      const line = lines[i].replace(/\s*\d{2}-\d{2}-\d{4}.*$/, "").replace(/\s+/g, " ").trim();
      if (line) return /no data/i.test(line) ? "" : line;
    }
    return "";
  }

  function rowFaculty(settings, i, data, idx) {
    const ao = settings.aoData[i];
    if (!ao) return "";
    const raw = ao._aData;
    let v;
    if (Array.isArray(raw)) v = raw[idx];
    else if (data) v = data[idx];
    else v = ao.anCells && ao.anCells[idx] ? ao.anCells[idx].innerHTML : "";
    return cleanFaculty(v);
  }

  /* ------------------------------------------------------------------ */
  /*  Semester parsing                                                   */
  /* ------------------------------------------------------------------ */
  function semWeight(s) {
    const m = s.match(/(\d{4})-\d{2}/);
    const y = m ? parseInt(m[1], 10) : 0;
    const l = s.toLowerCase();
    let t = 0;
    if (l.includes("summer")) t = 3;
    else if (l.includes("winter")) t = 2;
    else if (l.includes("fall")) t = 1;
    if (l.includes("inter")) t += 0.5;
    return y * 10 + t;
  }

  function parseOptions(sel) {
    const data = {};
    let selSem = "";
    let selVal = "";
    const opts = sel.options;
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i];
      const text = opt.textContent.trim();
      if (!opt.value || text.includes("-- Registered Courses --")) continue;
      const parts = text.split(" - ");
      if (parts.length < 3) continue;
      const sem = parts[0].trim();
      if (!data[sem]) data[sem] = [];
      data[sem].push({ value: opt.value, label: parts.slice(1).join(" - ").trim() });
      if (opt.selected) {
        selSem = sem;
        selVal = opt.value;
      }
    }
    return { data, selSem, selVal };
  }

  /* ------------------------------------------------------------------ */
  /*  UI                                                                 */
  /* ------------------------------------------------------------------ */
  function initExtension(native) {
    state.native = native;
    const parsed = parseOptions(native);
    state.courses = parsed.data;
    state.sems = Object.keys(parsed.data).sort((a, b) => semWeight(b) - semWeight(a));

    const inData = () =>
      state.courses[state.sem] && state.courses[state.sem].some((c) => c.value === state.subj);

    if (parsed.selVal) {
      // VTOP re-rendered its select with a course already chosen
      if (parsed.selVal !== state.subj) {
        state.fac = "ALL";
        state.facQ = "";
        state.faculty = [];
      }
      state.sem = parsed.selSem;
      state.subj = parsed.selVal;
    } else if (state.subj && inData() && (Date.now() - state.loadTs < 20000 || findMaterialsTable())) {
      // AJAX swap wiped our UI mid-load: restore silently (no change event => no double load)
      native.value = state.subj;
    } else {
      state.subj = "";
      state.fac = "ALL";
      state.facQ = "";
      state.faculty = [];
      if (!state.courses[state.sem]) state.sem = "";
    }

    // Save a click: pre-select the last-used semester, else the newest one
    if (!state.sem || !state.courses[state.sem]) {
      state.sem = persist.sem && state.courses[persist.sem] ? persist.sem : state.sems[0] || "";
    }

    native.style.display = "none";
    const sib = native.nextElementSibling;
    if (sib && /select2|chosen|bootstrap-select|ms-parent/.test(sib.className || "")) {
      sib.style.display = "none";
    }

    const box = document.createElement("div");
    box.id = UI_ID;
    box.style.cssText =
      "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:16px;" +
      "background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;margin:8px 0 12px;width:100%;" +
      "box-sizing:border-box;flex:1 1 100%;font-family:inherit;box-shadow:0 1px 2px rgba(0,0,0,.05);";

    const selCss =
      "width:100%;height:36px;padding:6px 10px;border:1px solid #94a3b8;border-radius:4px;background:#fff;";
    const lblCss = "font-weight:600;font-size:12px;color:#334155;margin:0;";
    const inCss =
      "width:55%;padding:3px 8px;font-size:12px;border:1px solid #cbd5e1;border-radius:4px;";
    const head = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;";

    box.innerHTML = `
      <div style="display:flex;flex-direction:column;justify-content:flex-end;">
        <label style="${lblCss}margin-bottom:6px;">1. Select Semester (Recent First)</label>
        <select id="vtop-sem-select" class="form-control" style="${selCss}">
          <option value="">-- Choose Semester --</option>
        </select>
      </div>
      <div style="display:flex;flex-direction:column;">
        <div style="${head}">
          <label style="${lblCss}">2. Select Subject</label>
          <input type="text" id="vtop-subj-search" placeholder="Search code or title..." style="${inCss}" disabled />
        </div>
        <select id="vtop-subj-select" class="form-control" style="${selCss}" disabled>
          <option value="">-- Select Semester First --</option>
        </select>
      </div>
      <div style="display:flex;flex-direction:column;">
        <div style="${head}">
          <label style="${lblCss}">3. Filter by Faculty</label>
          <input type="text" id="vtop-fac-search" placeholder="Search faculty..." style="${inCss}" disabled />
        </div>
        <select id="vtop-fac-select" class="form-control" style="${selCss}" disabled>
          <option value="ALL">-- Select Subject First --</option>
        </select>
      </div>
      <div id="vtop-busy" style="display:none;grid-column:1/-1;height:3px;border-radius:2px;
        background:linear-gradient(90deg,transparent,#3b82f6,transparent);background-size:40% 100%;
        background-repeat:no-repeat;animation:vtopSlide 1s linear infinite;"></div>
      <label style="grid-column:1/-1;display:flex;align-items:center;gap:6px;margin:0;font-size:12px;color:#475569;cursor:pointer;">
        <input type="checkbox" id="vtop-rename-toggle" checked />
        Rename downloads as Subject_Faculty_FileName (turn off to keep VTOP's original names)
      </label>
      <style>@keyframes vtopSlide{0%{background-position:-40% 0}100%{background-position:140% 0}}@media (max-width:900px){#vtop-custom-course-filter{grid-template-columns:minmax(0,1fr) !important}}</style>`;

    native.parentNode.insertBefore(box, native);

    const semSel = $("vtop-sem-select");
    const subjSel = $("vtop-subj-select");
    const subjSearch = $("vtop-subj-search");
    const facSel = $("vtop-fac-select");
    const facSearch = $("vtop-fac-search");

    const renameBox = $("vtop-rename-toggle");
    try {
      renameBox.checked = localStorage.getItem("vtopFilter.rename") !== "0";
    } catch (e) {}
    renameBox.addEventListener("change", () => {
      try {
        localStorage.setItem("vtopFilter.rename", renameBox.checked ? "1" : "0");
      } catch (e) {}
    });

    const frag = document.createDocumentFragment();
    state.sems.forEach((sem) => {
      const o = document.createElement("option");
      o.value = sem;
      o.textContent = `${sem} (${state.courses[sem].length} Courses)`;
      frag.appendChild(o);
    });
    semSel.appendChild(frag);

    if (state.sem && state.courses[state.sem]) {
      semSel.value = state.sem;
      subjSearch.disabled = false;
      subjSearch.value = state.subjQ;
      renderSubjects();
      if (state.subj) {
        const c = state.faculty.length ? state.faculty : cacheGet(state.subj);
        if (c && c.length) {
          state.faculty = c;
          facSel.disabled = false;
          facSearch.disabled = false;
          facSearch.value = state.facQ;
          renderFaculty();
        } else {
          facSel.innerHTML = '<option value="ALL">Loading materials...</option>';
        }
        waitForTable(null);
      }
    }

    semSel.addEventListener("change", () => {
      state.sem = semSel.value;
      if (state.sem) {
        persist.sem = state.sem;
        savePersist();
      }
      state.subj = "";
      state.fac = "ALL";
      state.subjQ = "";
      state.facQ = "";
      state.faculty = [];
      subjSearch.value = "";
      facSearch.value = "";
      facPlaceholder("-- Select Subject First --");
      if (!state.sem) {
        subjSel.innerHTML = '<option value="">-- Select Semester First --</option>';
        subjSel.disabled = true;
        subjSearch.disabled = true;
        return;
      }
      subjSearch.disabled = false;
      renderSubjects();
    });

    subjSearch.addEventListener(
      "input",
      debounce(() => {
        state.subjQ = subjSearch.value;
        renderSubjects();
      }, 100)
    );

    subjSel.addEventListener("change", () => {
      const val = subjSel.value;
      if (!val) return;
      state.subj = val;
      state.fac = "ALL";
      state.facQ = "";
      facSearch.value = "";

      // Seen this subject before? Show its faculty instantly while VTOP loads the table.
      const cached = cacheGet(val);
      if (cached) {
        state.faculty = cached;
        facSel.disabled = false;
        facSearch.disabled = false;
        renderFaculty();
      } else {
        state.faculty = [];
        facPlaceholder("Loading materials...");
      }

      const stale = findMaterialsTable(); // previous subject's table; must not be scraped
      state.loadTs = Date.now();
      native.value = val;
      waitForTable(stale); // arm BEFORE dispatching so ajaxSend is counted
      // ONE native bubbling event: fires VTOP's inline onchange and any jQuery handlers exactly once.
      native.dispatchEvent(new Event("change", { bubbles: true }));
    });

    facSearch.addEventListener(
      "input",
      debounce(() => {
        state.facQ = facSearch.value;
        renderFaculty();
        applyFilter();
      }, 120)
    );

    facSel.addEventListener("change", () => {
      state.fac = facSel.value;
      applyFilter();
    });
  }

  function facPlaceholder(text) {
    const facSel = $("vtop-fac-select");
    const facSearch = $("vtop-fac-search");
    if (!facSel || !facSearch) return;
    facSel.innerHTML = "";
    const o = document.createElement("option");
    o.value = "ALL";
    o.textContent = text;
    facSel.appendChild(o);
    facSel.disabled = true;
    facSearch.disabled = true;
  }

  function renderSubjects() {
    const sel = $("vtop-subj-select");
    if (!sel) return;
    const list = state.courses[state.sem] || [];
    const tokens = state.subjQ.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = tokens.length
      ? list.filter((c) => {
          const l = c.label.toLowerCase();
          return tokens.every((t) => l.includes(t));
        })
      : list;

    const frag = document.createDocumentFragment();
    const def = document.createElement("option");
    def.value = "";
    def.textContent = filtered.length
      ? `-- Choose Subject (${filtered.length} shown) --`
      : "-- No matching subjects --";
    frag.appendChild(def);
    filtered.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.value;
      o.textContent = c.label;
      frag.appendChild(o);
    });
    sel.replaceChildren(frag);
    sel.disabled = false;
    sel.value = filtered.some((c) => c.value === state.subj) ? state.subj : "";
  }

  function renderFaculty() {
    const sel = $("vtop-fac-select");
    if (!sel) return;
    const q = state.facQ.trim().toLowerCase();
    const list = q ? state.faculty.filter((f) => f.name.toLowerCase().includes(q)) : state.faculty;

    // keep the current pick if it still matches; otherwise jump to first match while searching
    if (!list.some((f) => f.name === state.fac)) {
      state.fac = q && list.length ? list[0].name : "ALL";
    }

    const frag = document.createDocumentFragment();
    const all = document.createElement("option");
    all.value = "ALL";
    all.textContent = `All Faculty (${list.length} of ${state.faculty.length} shown)`;
    frag.appendChild(all);
    list.forEach((f) => {
      const o = document.createElement("option");
      o.value = f.name;
      o.textContent = `${f.name} (${f.count} files)`;
      frag.appendChild(o);
    });
    sel.replaceChildren(frag);
    sel.value = state.fac;
  }

  /* ------------------------------------------------------------------ */
  /*  Waiting for VTOP's AJAX table, then extracting ALL faculty         */
  /* ------------------------------------------------------------------ */
  function waitForTable(stale) {
    clearInterval(state.timer);
    state.pending = { stale, t0: Date.now(), foundAt: 0, sent: 0, done: 0, ajaxDone: false };
    setBusy(true);
    state.timer = setInterval(tryExtract, POLL_MS);
    tryExtract();
  }

  function stopWaiting() {
    clearInterval(state.timer);
    state.timer = null;
    state.pending = null;
    setBusy(false);
  }

  function tryExtract() {
    const p = state.pending;
    if (!p) return;
    const now = Date.now();
    const table = findMaterialsTable();

    // Ignore the OLD subject's table until VTOP swaps it (or its AJAX finished / 3 s passed)
    if (table && (table !== p.stale || p.ajaxDone || now - p.t0 >= STALE_MS)) {
      if (!p.foundAt) p.foundAt = now;
      const api = getApi(table);
      if (api || now - p.foundAt >= DT_GRACE_MS) {
        stopWaiting();
        finishExtraction(table, api);
        return;
      }
    }
    if (now - p.t0 >= GIVE_UP_MS) {
      stopWaiting();
      facPlaceholder("No materials found");
    }
  }

  function finishExtraction(table, api) {
    state.facCol = facultyColumn(table);
    let counts = null;
    let method = "";

    // 1) DataTables in-memory data: every row of every page, no DOM paging involved
    if (api) {
      try {
        counts = new Map();
        const s = api.settings()[0];
        for (let i = 0; i < s.aoData.length; i++) {
          const f = rowFaculty(s, i, null, state.facCol);
          if (f) counts.set(f, (counts.get(f) || 0) + 1);
        }
        method = "datatables-api";
      } catch (e) {
        counts = null;
      }
    }
    // 2) DataTables not reachable from JS: page through it once, synchronously
    if (!counts || !counts.size) {
      counts = crawlPagination(table, state.facCol);
      if (counts && counts.size) method = "pagination-crawl";
    }
    // 3) Plain, un-paginated table
    if (!counts || !counts.size) {
      counts = new Map();
      const rows = table.tBodies[0] ? table.tBodies[0].rows : [];
      for (let i = 0; i < rows.length; i++) {
        const c = rows[i].cells[state.facCol];
        if (!c) continue;
        const f = cleanFaculty(c.innerHTML);
        if (f) counts.set(f, (counts.get(f) || 0) + 1);
      }
      method = "dom-rows";
    }
    log("faculty extracted via", method, "->", counts.size, "unique");

    state.faculty = Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    if (state.subj) cacheSet(state.subj, state.faculty);

    const facSel = $("vtop-fac-select");
    const facSearch = $("vtop-fac-search");
    if (!facSel || !facSearch) return;
    if (!state.faculty.length) {
      facPlaceholder("No materials found");
      return;
    }
    facSel.disabled = false;
    facSearch.disabled = false;
    facSearch.value = state.facQ;
    if (state.fac !== "ALL" && !state.faculty.some((f) => f.name === state.fac)) state.fac = "ALL";
    renderFaculty();
    if (state.fac !== "ALL") applyFilter();
  }

  // Fallback: click Next through every page (all synchronous => nothing paints, no flicker),
  // collect the faculty column, then return to page 1.
  function crawlPagination(table, idx) {
    const wrap =
      table.closest(".dataTables_wrapper, .dt-container") ||
      (table.id && document.getElementById(table.id + "_wrapper"));
    const pag = wrap && wrap.querySelector(".dataTables_paginate, .dt-paging");
    if (!pag) return null;

    const btn = (cls) =>
      pag.querySelector(`.paginate_button.${cls}, .dt-paging-button.${cls}`);
    const off = (b) =>
      !b ||
      b.classList.contains("disabled") ||
      (b.parentElement && b.parentElement.classList.contains("disabled")) ||
      b.getAttribute("aria-disabled") === "true";
    const click = (b) => (b.tagName === "A" || b.tagName === "BUTTON" ? b : b.querySelector("a") || b).click();
    const goFirst = () => {
      const f = btn("first");
      if (f && !off(f)) return click(f);
      let g = 0;
      while (!off(btn("previous")) && g++ < 500) click(btn("previous"));
    };

    try {
      goFirst();
      const counts = new Map();
      let pages = 0;
      do {
        const rows = table.tBodies[0] ? table.tBodies[0].rows : [];
        for (let i = 0; i < rows.length; i++) {
          const c = rows[i].cells[idx];
          if (!c) continue;
          const f = cleanFaculty(c.innerHTML);
          if (f) counts.set(f, (counts.get(f) || 0) + 1);
        }
        pages++;
        const nx = btn("next");
        if (off(nx)) break;
        click(nx);
      } while (pages < 500);
      goFirst();
      return counts;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Filtering the table (across ALL pages)                             */
  /* ------------------------------------------------------------------ */
  function ensureHook() {
    if (state.hooked) return;
    const dt = getDT();
    if (!dt || !dt.ext || !Array.isArray(dt.ext.search)) return;
    // Registered once; DataTables calls this for every row of every page on each draw.
    dt.ext.search.push(function (settings, data, dataIndex) {
      if (state.fac === "ALL" || settings.nTable !== state.hookTable) return true;
      return rowFaculty(settings, dataIndex, data, state.facCol) === state.fac;
    });
    state.hooked = true;
  }

  function applyFilter() {
    if (state.pending) return; // table still loading; finishExtraction re-applies the pick
    const table = findMaterialsTable();
    if (!table) return;

    const api = getApi(table);
    if (api) {
      try {
        state.hookTable = table;
        ensureHook();
        if (state.hooked) {
          api.draw(); // re-filters every page and resets to page 1
          return;
        }
      } catch (e) {}
    }

    // Fallback: drive DataTables' own search box
    const wrap = table.closest(".dataTables_wrapper, .dt-container") || document;
    const input = wrap.querySelector(".dataTables_filter input, .dt-search input");
    if (input) {
      input.value = state.fac === "ALL" ? "" : state.fac;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("keyup", { bubbles: true }));
    }
  }
})();