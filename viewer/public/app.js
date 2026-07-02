"use strict";

const $ = (s, r = document) => r.querySelector(s);

// theme tokens read live from CSS vars so charts repaint correctly on light/dark
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const palette = () => ["--accent", "--cyan", "--amber", "--violet", "--green", "--red", "--faint"].map(cssv);

const state = {
  all: [],
  view: [],
  sort: { key: "ts", dir: -1 },
  filters: { search: "", provider: "", workspace: "", model: "", mode: "", effort: "", since: "", ctx: 0 },
  group: true,
  fields: {},                     // this project's stored-field flags
  enabled: true,                  // is this project tracked
};
// Field-group visible? Defaults to true so a missing/unreachable config shows all.
const has = (g) => state.fields[g] !== false;

// ---------- formatting (locale-aware: honors the viewer's browser locale) ----------
const fmtInt = (n) => (n || 0).toLocaleString();
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
}
const _usd2 = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const _usd3 = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtUsd = (n) => ((n = n || 0) < 10 ? _usd3 : _usd2).format(n);
const _whenFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function fmtWhen(ts) {
  if (!ts) return "—";
  return _whenFmt.format(new Date(ts));
}
function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function fmtBytes(n) {
  n = n || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}
let toastTimer;
function toast(msg) {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.hidden = false; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); setTimeout(() => (t.hidden = true), 300); }, 3200);
}
// Permanently delete records by id (irreversible) — always behind a confirm.
async function delEvents(ids, label) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) return;
  if (!confirm(`Permanently delete ${ids.length} ${label}?\n\nThis removes the record(s) from disk and cannot be undone.`)) return;
  let r = {};
  try {
    r = await (await fetch("/api/events", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })).json();
  } catch {}
  await load();
  toast(`Deleted ${r.removed || 0} record(s) · freed ${fmtBytes(r.bytesFreed)}`);
}
const dayKey = (ts) => (ts || "").slice(0, 10);

// derived accessors used for sorting (null-safe: records may omit disabled groups)
const T_IN = (e) => (e.usage && e.usage.input) || 0;
const T_OUT = (e) => (e.usage && e.usage.output) || 0;
const T_TOTAL = (e) => { const u = e.usage; return u ? (u.input || 0) + (u.output || 0) + (u.cacheCreate || 0) + (u.cacheRead || 0) : 0; };
const COST = (e) => (e.cost && e.cost.total) || 0;

// ---------- config (per project: title/ui + tracking + stored fields) ----------
async function boot() {
  await loadConfig();
  await load();
}
async function loadConfig() {
  let cfg = {};
  try { cfg = await (await fetch("/api/config")).json(); } catch {}
  if (cfg.title) {
    document.title = cfg.title + " · AI Usage Inspector";
    const t = $("#proj"); if (t) t.textContent = cfg.title;
  }
  const ui = cfg.ui || {};
  if (ui.filters) state.filters = { ...state.filters, ...ui.filters };
  if (ui.sort && ui.sort.key) state.sort = ui.sort;
  if (typeof ui.group === "boolean") state.group = ui.group;
  state.fields = cfg.fields || {};
  state.enabled = !cfg.tracking || cfg.tracking.enabled !== false;
  applySettingsVisibility();
}
// Persist a config patch ({tracking} / {fields}) to this project's config.
async function saveConfigPatch(patch) {
  try {
    const cfg = await (await fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    })).json();
    state.fields = cfg.fields || {};
    state.enabled = !cfg.tracking || cfg.tracking.enabled !== false;
    renderSettings();
    applySettingsVisibility();
    apply();
    toast("settings saved");
  } catch { toast("save failed"); }
}
// Reflect disabled field-groups onto the chrome: hide table columns + filters.
function applySettingsVisibility() {
  const grid = $("#grid");
  if (grid) {
    grid.classList.toggle("hide-col-in", !has("tokens"));
    grid.classList.toggle("hide-col-out", !has("tokens"));
    grid.classList.toggle("hide-col-context", !has("context"));
    grid.classList.toggle("hide-col-cost", !has("cost"));
  }
  const eff = $("#ctl-effort"); if (eff) eff.hidden = !has("meta");
  const ctx = $("#ctl-ctx"); if (ctx) ctx.hidden = !has("context");
}

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ui: { filters: state.filters, sort: state.sort, group: state.group } }),
    }).catch(() => {});
  }, 400);
}

// Sync the on-screen controls to current state (after options are built).
function reflect() {
  const f = state.filters;
  $("#f-search").value = f.search || "";
  $("#f-provider").value = f.provider || "";
  $("#f-workspace").value = f.workspace || "";
  $("#f-model").value = f.model || "";
  $("#f-mode").value = f.mode || "";
  $("#f-effort").value = f.effort || "";
  $("#f-since").value = f.since || "";
  $("#f-ctx").value = f.ctx || 0;
  $("#f-ctx-v").textContent = String(f.ctx || 0);
  $("#f-group").checked = state.group;
}

// ---------- load ----------
async function load() {
  const res = await fetch("/api/events");
  state.all = await res.json();
  buildFilterOptions();
  reflect();
  apply();
}

function uniq(key) {
  return [...new Set(state.all.map((e) => e[key]).filter(Boolean))].sort();
}
function fillSelect(id, values, label) {
  const el = $(id);
  el.innerHTML = `<option value="">all ${label}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
}
function buildFilterOptions() {
  fillSelect("#f-provider", uniq("provider"), "providers");
  fillSelect("#f-workspace", uniq("workspace"), "workspaces");
  fillSelect("#f-model", uniq("model"), "models");
  fillSelect("#f-mode", uniq("permissionMode"), "modes");
  fillSelect("#f-effort", [...new Set(state.all.map((e) => e.effortLevel).filter(Boolean))].sort(), "efforts");
}

// ---------- filtering ----------
function apply() {
  const f = state.filters;
  const q = f.search.toLowerCase();
  state.view = state.all.filter((e) => {
    if (f.provider && (e.provider || "claude") !== f.provider) return false;
    if (f.workspace && e.workspace !== f.workspace) return false;
    if (f.model && e.model !== f.model) return false;
    if (f.mode && e.permissionMode !== f.mode) return false;
    if (f.effort && e.effortLevel !== f.effort) return false;
    if (f.since && dayKey(e.ts) < f.since) return false;
    if (f.ctx && (e.contextFillPct || 0) < f.ctx) return false;
    if (q) {
      const hay = ((e.promptPreview || "") + " " + (e.responsePreview || "") + " " + (e.slug || "") + " " + (e.workspace || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  renderStats();
  renderCharts();
  renderTable();
  const r = state.all.length ? `${fmtWhen(state.all[state.all.length - 1].ts)} → ${fmtWhen(state.all[0].ts)}` : "no data";
  $("#meta-range").textContent = `${state.view.length}/${state.all.length} prompts · ${r}`;
  const del = $("#f-del");
  if (del) { del.textContent = `delete shown (${state.view.length})`; del.disabled = state.view.length === 0; }
  persist();
}

// ---------- stats ----------
function renderStats() {
  const v = state.view;
  const prompts = v.length;
  const tin = v.reduce((a, e) => a + T_IN(e), 0);
  const tout = v.reduce((a, e) => a + T_OUT(e), 0);
  const ttot = v.reduce((a, e) => a + T_TOTAL(e), 0);
  const cost = v.reduce((a, e) => a + COST(e), 0);
  const avgCtx = prompts ? v.reduce((a, e) => a + (e.contextFillPct || 0), 0) / prompts : 0;
  const dur = v.reduce((a, e) => a + (e.durationMs || 0), 0);
  const subs = v.reduce((a, e) => a + (e.counts ? e.counts.subagentCalls : 0), 0);
  const respRecs = v.filter((e) => e.firstResponseMs != null);
  const avgResp = respRecs.length ? respRecs.reduce((a, e) => a + e.firstResponseMs, 0) / respRecs.length : 0;

  const byModel = tally(v, (e) => e.model, () => 1);
  const topModel = topKey(byModel);
  const byWs = tally(v, (e) => e.workspace, () => 1);
  const topWs = topKey(byWs);

  // ordered by what matters most for hands-on work; $ is an estimate, kept last.
  // Cards for disabled field-groups are omitted.
  const cards = [];
  if (has("tokens")) cards.push({ label: "tokens · total", val: fmtTok(ttot), sub: `${fmtTok(tin)} in · ${fmtTok(tout)} out`, cls: "accent" });
  cards.push({ label: "prompts", val: fmtInt(prompts), sub: `${subs} subagent calls`, cls: "" });
  if (has("context")) cards.push({ label: "avg context", val: avgCtx.toFixed(1) + "<small>%</small>", sub: "of window filled", cls: "amber", bar: avgCtx });
  if (has("timing")) cards.push({ label: "active time", val: fmtDur(dur), sub: "summed turn duration", cls: "" });
  if (has("timing") && respRecs.length) cards.push({ label: "avg first response", val: fmtDur(avgResp), sub: "prompt → first reply", cls: "" });
  cards.push({ label: "top model", val: shortModel(topModel), sub: topModel ? byModel[topModel] + " prompts" : "—", cls: "" });
  cards.push({ label: "busiest workspace", val: esc(topWs || "—"), sub: topWs ? byWs[topWs] + " prompts" : "—", cls: "" });
  if (has("cost")) cards.push({ label: "est. cost", val: fmtUsd(cost), sub: prompts ? `${fmtUsd(cost / prompts)} / prompt` : "—", cls: "cost" });
  $("#stats").innerHTML = cards
    .map(
      (c) => `<div class="stat ${c.cls}" style="--bar:${c.bar || 0}%">
        <div class="label">${c.label}</div>
        <div class="val">${c.val}</div>
        <div class="sub">${c.sub}</div></div>`
    )
    .join("");
}
function tally(arr, keyFn, valFn) {
  const m = {};
  for (const e of arr) { const k = keyFn(e) || "—"; m[k] = (m[k] || 0) + valFn(e); }
  return m;
}
const topKey = (m) => Object.keys(m).sort((a, b) => m[b] - m[a])[0] || "";
const shortModel = (m) => (m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "") : "—");

// ---------- charts ----------
function renderCharts() {
  const v = state.view;
  // time series by day
  const days = {};
  for (const e of v) {
    const k = dayKey(e.ts); if (!k) continue;
    days[k] = days[k] || { tok: 0, cost: 0, n: 0 };
    days[k].tok += T_TOTAL(e); days[k].cost += COST(e); days[k].n++;
  }
  const keys = Object.keys(days).sort();
  const tok = keys.map((k) => days[k].tok);
  const cost = keys.map((k) => days[k].cost);

  const modelCount = tally(v, (e) => shortModel(e.model), () => 1);
  const modeCount = tally(v, (e) => e.permissionMode, () => 1);

  // skills invoked across the filtered view
  const skillCount = {};
  for (const e of v) for (const s of e.skills || []) skillCount[s] = (skillCount[s] || 0) + 1;
  const skillsUsed = Object.keys(skillCount).length;

  // context distribution (10 buckets)
  const buckets = new Array(10).fill(0);
  for (const e of v) { const b = Math.min(9, Math.floor((e.contextFillPct || 0) / 10)); buckets[b]++; }

  const cards = [];
  if (has("tokens")) cards.push(`<div class="card span2">
      <h3>tokens over time <b>${fmtTok(tok.reduce((a, b) => a + b, 0))}</b></h3>
      ${areaChart(keys, tok, cssv("--accent"))}
    </div>`);
  if (has("context")) cards.push(`<div class="card"><h3>context fill distribution</h3>${histogram(buckets)}</div>`);
  cards.push(`<div class="card"><h3>permission mode</h3>${donut(modeCount, (x) => x + " prompts")}</div>`);
  cards.push(`<div class="card"><h3>prompts by model</h3>${donut(modelCount, (x) => x + " prompts")}</div>`);
  if (has("skills") && skillsUsed) cards.push(`<div class="card"><h3>skills invoked <b>${skillsUsed}</b></h3>${donut(skillCount, (x) => x + "×")}</div>`);
  if (has("cost")) cards.push(`<div class="card"><h3>est. cost / day <b class="cost-b">${fmtUsd(cost.reduce((a, b) => a + b, 0))}</b></h3>${barChart(keys, cost, cssv("--faint"), (x) => fmtUsd(x))}</div>`);
  $("#charts").innerHTML = cards.join("");
}

function axisLabels(keys) {
  if (!keys.length) return "";
  const first = keys[0].slice(5), last = keys[keys.length - 1].slice(5);
  return `<div class="legend" style="justify-content:space-between"><span>${first}</span><span>${last}</span></div>`;
}

function areaChart(keys, vals, color) {
  const W = 640, H = 150, n = vals.length;
  if (!n) return emptyChart();
  const max = Math.max(...vals, 1);
  const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (val) => H - (val / max) * (H - 12) - 4;
  let line = vals.map((val, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1)},${H} L${x(0)},${H} Z`;
  const dots = n <= 60 ? vals.map((val, i) => `<circle cx="${x(i)}" cy="${y(val)}" r="2.4" fill="${color}"/>`).join("") : "";
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:150px">
    <defs><linearGradient id="ag" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.32"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#ag)"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2"/>${dots}
  </svg>${axisLabels(keys)}`;
}

function barChart(keys, vals, color, fmt) {
  const n = vals.length; if (!n) return emptyChart();
  const max = Math.max(...vals, 0.0001);
  const bars = vals
    .map((val, i) => {
      const h = (val / max) * 86;
      return `<div title="${keys[i]} · ${fmt(val)}" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px">
        <div style="width:100%;max-width:22px;height:${h}px;min-height:2px;background:${color};border-radius:3px 3px 0 0;opacity:.85"></div></div>`;
    })
    .join("");
  return `<div style="display:flex;align-items:flex-end;gap:3px;height:96px">${bars}</div>${axisLabels(keys)}`;
}

function donut(map, fmt) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return emptyChart();
  const PAL = palette();
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = entries
    .map(([k, v], i) => {
      const frac = v / total, len = frac * C, col = PAL[i % PAL.length];
      const seg = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${col}" stroke-width="16"
        stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
        transform="rotate(-90 70 70)"/>`;
      off += len; return seg;
    })
    .join("");
  const legend = entries
    .map(([k, v], i) => `<span><i style="background:${PAL[i % PAL.length]}"></i>${esc(k)} · ${fmt(v)}</span>`)
    .join("");
  return `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
    <svg viewBox="0 0 140 140" style="width:128px;height:128px;flex:0 0 auto">${arcs}
      <text x="70" y="66" text-anchor="middle" fill="${cssv("--text")}" font-family="var(--display)" font-size="20" font-weight="600">${entries.length}</text>
      <text x="70" y="84" text-anchor="middle" fill="${cssv("--muted")}" font-family="var(--mono)" font-size="8" letter-spacing="1">TYPES</text>
    </svg><div class="legend" style="flex:1">${legend}</div></div>`;
}

function histogram(buckets) {
  const max = Math.max(...buckets, 1);
  const cHot = cssv("--accent"), cWarn = cssv("--amber"), cCool = cssv("--cyan"), cLabel = cssv("--faint");
  const bars = buckets
    .map((c, i) => {
      const h = (c / max) * 92, hot = i >= 8 ? cHot : i >= 5 ? cWarn : cCool;
      return `<div title="${i * 10}–${i * 10 + 10}% · ${c}" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px">
        <div style="width:100%;height:${h}px;min-height:${c ? 2 : 0}px;background:${hot};border-radius:3px 3px 0 0"></div>
        <span style="font-family:var(--mono);font-size:8px;color:${cLabel}">${i * 10}</span></div>`;
    })
    .join("");
  return `<div style="display:flex;align-items:flex-end;gap:3px;height:118px">${bars}</div>`;
}

const emptyChart = () => `<div style="height:120px;display:grid;place-items:center;color:var(--faint);font-family:var(--mono);font-size:11px">no data in range</div>`;

// ---------- table ----------
function sorted() {
  const { key, dir } = state.sort;
  const accessor = { _in: T_IN, _out: T_OUT, _cost: COST }[key] || ((e) => e[key]);
  return [...state.view].sort((a, b) => {
    let x = accessor(a), y = accessor(b);
    if (typeof x === "string") return x.localeCompare(y) * dir;
    return ((x || 0) - (y || 0)) * dir;
  });
}

function ctxBar(pct) {
  const cls = pct >= 80 ? "hot" : pct >= 50 ? "warn" : "";
  return `<span class="ctxbar"><span class="track"><span class="fill ${cls}" style="width:${Math.min(100, pct)}%"></span></span><b class="mono">${(pct || 0).toFixed(0)}%</b></span>`;
}

function rowHtml(e) {
  const chip = has("skills") && e.skills && e.skills.length
    ? `<span class="skill-chip" title="skills: ${esc(e.skills.join(", "))}">▸ ${e.skills.length}</span> ` : "";
  const prov = e.provider || "claude";
  return `<tr class="row" data-id="${esc(e.id)}">
    <td class="mono muted col-when">${fmtWhen(e.ts)}</td>
    <td class="col-provider"><span class="tag prov-${esc(prov)}">${esc(prov)}</span></td>
    <td class="ws col-workspace">${esc(e.workspace)}</td>
    <td class="mono col-model">${shortModel(e.model)}</td>
    <td class="col-mode"><span class="tag ${esc(e.permissionMode)}">${esc(e.permissionMode)}</span></td>
    <td class="num col-in">${fmtTok(T_IN(e))}</td>
    <td class="num col-out">${fmtTok(T_OUT(e))}</td>
    <td class="num col-context">${ctxBar(e.contextFillPct)}</td>
    <td class="num cost-cell col-cost">${fmtUsd(COST(e))}</td>
    <td class="prompt-cell col-prompt">${chip}${esc(e.promptPreview)}</td>
  </tr>`;
}

function renderTable() {
  const rows = sorted();
  $("#empty").hidden = rows.length > 0;
  const body = $("#rows");
  if (!state.group) { body.innerHTML = rows.map(rowHtml).join(""); markSort(); return; }

  // group by session, keep current sort order of first appearance
  const groups = new Map();
  for (const e of rows) {
    if (!groups.has(e.sessionId)) groups.set(e.sessionId, []);
    groups.get(e.sessionId).push(e);
  }
  let html = "";
  for (const [sid, items] of groups) {
    const head = items[0];
    const cost = items.reduce((a, e) => a + COST(e), 0);
    const costPart = has("cost") ? `${fmtUsd(cost)} · ` : "";
    html += `<tr class="group"><td colspan="99">
      <b>${esc(head.workspace)}</b> · ${esc(head.slug || sid.slice(0, 8))}
      <span class="gstats">${items.length} prompts · ${costPart}session ${esc(sid.slice(0, 8))}</span>
    </td></tr>`;
    html += items.map(rowHtml).join("");
  }
  body.innerHTML = html;
  markSort();
}

function markSort() {
  document.querySelectorAll(".grid th.sortable").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === state.sort.key);
    th.classList.toggle("asc", th.dataset.sort === state.sort.key && state.sort.dir === 1);
  });
}

// ---------- markdown preview (zero-dep, XSS-safe: escape first, then format) ----------
// Inline operates on already-escaped text, so injected tags are ours only.
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}
const splitRow = (s) => s.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");

function renderMd(src) {
  if (!src || !src.trim()) return `<p class="md-empty muted">— empty —</p>`;
  const L = esc(src).replace(/\r\n?/g, "\n").split("\n");
  let html = "", i = 0;
  const isBlockStart = (s) => /^\s*(#{1,6}\s|```|>|([-*+]|\d+\.)\s)/.test(s);
  while (i < L.length) {
    const line = L[i];
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim(); const code = []; i++;
      while (i < L.length && !/^\s*```\s*$/.test(L[i])) { code.push(L[i]); i++; }
      i++;
      html += `<pre class="md-code"${lang ? ` data-lang="${lang}"` : ""}><code>${code.join("\n")}</code></pre>`;
      continue;
    }
    // GFM table: row with pipes followed by a |---|:--| separator
    if (line.includes("|") && i + 1 < L.length && L[i + 1].includes("-") && /^[\s|:-]+$/.test(L[i + 1]) && L[i + 1].includes("|")) {
      const head = splitRow(line);
      const al = splitRow(L[i + 1]).map((c) => { c = c.trim(); const l = c.startsWith(":"), r = c.endsWith(":"); return l && r ? "center" : r ? "right" : l ? "left" : ""; });
      i += 2; const rows = [];
      while (i < L.length && L[i].includes("|") && L[i].trim() !== "") { rows.push(splitRow(L[i])); i++; }
      const cell = (c, j, tag) => `<${tag}${al[j] ? ` style="text-align:${al[j]}"` : ""}>${mdInline((c || "").trim())}</${tag}>`;
      html += `<table class="md-table"><thead><tr>${head.map((c, j) => cell(c, j, "th")).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => cell(r[j], j, "td")).join("")}</tr>`).join("")}</tbody></table>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const lv = h[1].length; html += `<h${lv} class="md-h">${mdInline(h[2].trim())}</h${lv}>`; i++; continue; }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { html += `<hr class="md-hr"/>`; i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = []; while (i < L.length && /^\s*>\s?/.test(L[i])) { buf.push(L[i].replace(/^\s*>\s?/, "")); i++; }
      html += `<blockquote class="md-quote">${mdInline(buf.join(" ").trim())}</blockquote>`; continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line); const items = [];
      while (i < L.length && /^\s*([-*+]|\d+\.)\s+/.test(L[i])) { items.push(L[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")); i++; }
      const tag = ordered ? "ol" : "ul";
      html += `<${tag} class="md-list">${items.map((it) => `<li>${mdInline(it.trim())}</li>`).join("")}</${tag}>`;
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para = [];
    while (i < L.length && L[i].trim() !== "" && !isBlockStart(L[i]) && !L[i].includes("|")) { para.push(L[i]); i++; }
    if (para.length) html += `<p class="md-p">${mdInline(para.join("\n")).replace(/\n/g, "<br/>")}</p>`;
    else { html += `<p class="md-p">${mdInline(line)}</p>`; i++; }
  }
  return html;
}

// rendered + raw view with a toggle
function detailBlock(kind, label, chars, text) {
  return `<div class="block ${kind}">
    <div class="bh"><span>${label}</span><span class="bh-r"><button class="md-toggle" data-raw type="button">raw</button>${fmtInt(chars)} chars</span></div>
    <div class="md">${renderMd(text)}</div>
    <pre class="raw" hidden>${esc(text) || '<span class="muted">— empty —</span>'}</pre>
  </div>`;
}

// ---------- drawer ----------
async function openDrawer(id) {
  const drawer = $("#drawer");
  drawer.hidden = false;
  $("#drawer-panel").innerHTML = `<div class="muted mono" style="padding:40px">loading…</div>`;
  let e;
  try { e = await (await fetch("/api/event/" + encodeURIComponent(id))).json(); } catch { e = null; }
  if (!e || !e.id) { $("#drawer-panel").innerHTML = `<div class="muted mono" style="padding:40px">not found</div>`; return; }
  const u = e.usage || {}, c = e.cost || {}, k = e.counts || {};
  // meta spans (omit when the `meta`/`timing` group is stripped)
  const meta = [`<span>${fmtWhen(e.ts)}</span>`, `<span>${esc(e.model)}</span>`,
    `<span class="tag ${esc(e.permissionMode)}">${esc(e.permissionMode)}</span>`];
  if (e.effortLevel) meta.push(`<span>effort: ${esc(e.effortLevel)}</span>`);
  if (e.durationMs != null) meta.push(`<span>${fmtDur(e.durationMs)}</span>`);
  if (e.firstResponseMs != null) meta.push(`<span>1st reply ${fmtDur(e.firstResponseMs)}</span>`);
  if (e.gitBranch) meta.push(`<span>${esc(e.gitBranch)}</span>`);
  if (e.cliVersion) meta.push(`<span>v${esc(e.cliVersion)}</span>`);
  if (e.serviceTier || e.speed) meta.push(`<span>${esc(e.serviceTier || "")}/${esc(e.speed || "")}</span>`);
  // dgrid cells, each gated on its field group + presence
  const cells = [];
  if (has("cost") && e.cost) cells.push(`<div><div class="k">cost</div><div class="v accent">${fmtUsd(c.total)}</div></div>`);
  if (has("context") && e.contextFillPct != null) cells.push(`<div><div class="k">context</div><div class="v">${(e.contextFillPct||0).toFixed(1)}% <span class="muted" style="font-size:11px">${fmtTok(e.contextTokens)}/${fmtTok(e.contextMax)}</span></div></div>`);
  if (has("timing") && e.firstResponseMs != null) cells.push(`<div><div class="k">first response</div><div class="v">${fmtDur(e.firstResponseMs)}</div></div>`);
  if (has("tokens") && e.usage) cells.push(
    `<div><div class="k">input</div><div class="v">${fmtInt(u.input)}</div></div>`,
    `<div><div class="k">output</div><div class="v">${fmtInt(u.output)}</div></div>`,
    `<div><div class="k">cache write</div><div class="v">${fmtInt(u.cacheCreate)}</div></div>`,
    `<div><div class="k">cache read</div><div class="v">${fmtInt(u.cacheRead)}</div></div>`);
  if (has("counts") && e.counts) cells.push(
    `<div><div class="k">api calls</div><div class="v">${k.apiCalls} <span class="muted" style="font-size:11px">+${k.subagentCalls} sub</span></div></div>`,
    `<div><div class="k">tools / think</div><div class="v">${k.toolCalls} / ${k.thinkingBlocks}</div></div>`);
  const costBreakdown = has("cost") && e.cost
    ? `<div class="block"><div class="bh"><span>cost breakdown · USD</span></div><pre>input  ${fmtUsd(c.input)}
output ${fmtUsd(c.output)}
cache write ${fmtUsd(c.cacheWrite)}
cache read  ${fmtUsd(c.cacheRead)}
──────────────
total  ${fmtUsd(c.total)}</pre></div>` : "";
  $("#drawer-panel").innerHTML = `
    <div class="dhead"><span class="deyebrow">prompt detail</span><span class="dhead-actions"><button class="btn danger ddel" data-del="${esc(e.id)}">delete</button><button class="btn ghost dclose" data-close>✕ close</button></span></div>
    <h2>${esc(e.workspace)} <span class="muted" style="font-family:var(--mono);font-size:13px">/ ${esc(e.slug || "")}</span></h2>
    <div class="dmeta">${meta.join("")}</div>
    ${has("skills") && e.skills && e.skills.length ? `<div class="dskills"><span class="dskills-k">skills</span>${e.skills.map((s) => `<span class="skill-tag">${esc(s)}</span>`).join("")}</div>` : ""}
    ${cells.length ? `<div class="dgrid">${cells.join("")}</div>` : ""}
    ${textBlock("prompt", "prompt", e.promptChars, e.prompt)}
    ${textBlock("response", "response", e.responseChars, e.response)}
    ${costBreakdown}`;
}
// Render a prompt/response block, or a stub when the text group is disabled.
function textBlock(kind, label, chars, text) {
  if (text != null) return detailBlock(kind, label, chars, text);
  return `<div class="block ${kind}"><div class="bh"><span>${label}</span><span>${fmtInt(chars)} chars</span></div>
    <div class="md md-empty muted">— text not stored (the “text” field group is off for this project) —</div></div>`;
}
function closeDrawer() { $("#drawer").hidden = true; }

// ---------- settings panel (this project only) ----------
const FIELD_META = [
  ["text", "prompt & response text", "the full prompt/response (largest + most sensitive)"],
  ["tokens", "token usage", "input / output / cache token counts"],
  ["cost", "estimated cost", "per-prompt USD estimate"],
  ["context", "context fill", "context window occupancy %"],
  ["timing", "timing", "duration + first-response latency"],
  ["skills", "skills", "skills invoked per prompt"],
  ["counts", "tool counts", "api / subagent / tool / thinking counts"],
  ["meta", "metadata", "git branch, cli version, slug, tier, effort"],
];
function renderSettings() {
  const panel = $("#settings-panel");
  const title = (document.getElementById("proj") || {}).textContent || "this project";
  const fieldRows = FIELD_META.map(([g, name, desc]) => `<div class="set-row">
      <label class="set-toggle"><input type="checkbox" data-field="${g}" ${has(g) ? "checked" : ""} />
        <span class="set-name">${esc(name)}<small>${esc(desc)}</small></span></label>
    </div>`).join("");
  panel.innerHTML = `
    <div class="dhead"><span class="deyebrow">settings</span><button class="btn ghost" data-settings-close>✕ close</button></div>
    <h2 style="font-family:var(--display);font-weight:500;font-size:20px;margin:0 0 16px">${esc(title)}</h2>
    <section class="set-sec">
      <h3 class="set-h">tracking</h3>
      <div class="set-row">
        <label class="set-toggle"><input type="checkbox" data-enabled ${state.enabled ? "checked" : ""} />
          <span class="set-name">record this project<small>uncheck to stop recording new prompts here</small></span></label>
      </div>
    </section>
    <section class="set-sec">
      <h3 class="set-h">stored fields</h3>
      <p class="set-note">Disabled groups are stripped before writing (smaller files, more privacy). Already-stored data is not changed; changes apply from the next prompt.</p>
      ${fieldRows}
    </section>
    <p class="set-foot mono">.ai-usage/config.json</p>`;
}
function openSettings() {
  $("#settings-drawer").hidden = false;
  renderSettings();
  loadConfig().then(renderSettings); // refresh from disk
}
function closeSettings() { $("#settings-drawer").hidden = true; }

// ---------- theme (light / dark, persisted; default = system) ----------
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("cu-theme", t); } catch {}
  const b = $("#theme"); if (b) b.textContent = t === "light" ? "☾" : "☀";
  if (state.all.length) renderCharts(); // SVGs bake colors → repaint
}
function initTheme() {
  let t; try { t = localStorage.getItem("cu-theme"); } catch {}
  setTheme(t || document.documentElement.getAttribute("data-theme") || "dark");
}

// ---------- events ----------
function bind() {
  $("#f-search").addEventListener("input", (e) => { state.filters.search = e.target.value; apply(); });
  const map = { "#f-provider": "provider", "#f-workspace": "workspace", "#f-model": "model", "#f-mode": "mode", "#f-effort": "effort", "#f-since": "since" };
  for (const [sel, key] of Object.entries(map)) $(sel).addEventListener("change", (e) => { state.filters[key] = e.target.value; apply(); });
  $("#f-ctx").addEventListener("input", (e) => { state.filters.ctx = +e.target.value; $("#f-ctx-v").textContent = e.target.value; apply(); });
  $("#f-group").addEventListener("change", (e) => { state.group = e.target.checked; renderTable(); persist(); });
  $("#f-clear").addEventListener("click", () => {
    state.filters = { search: "", provider: "", workspace: "", model: "", mode: "", effort: "", since: "", ctx: 0 };
    document.querySelectorAll(".ctl select").forEach((s) => (s.value = ""));
    $("#f-search").value = ""; $("#f-since").value = ""; $("#f-ctx").value = 0; $("#f-ctx-v").textContent = "0";
    apply();
  });
  $("#f-del").addEventListener("click", () => delEvents(state.view.map((e) => e.id), "prompt(s) shown"));
  $("#refresh").addEventListener("click", load);
  $("#theme").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    setTheme(cur === "light" ? "dark" : "light");
  });
  $("#settings").addEventListener("click", openSettings);
  $("#settings-drawer").addEventListener("click", (e) => {
    if (e.target.dataset.settingsClose !== undefined) closeSettings();
  });
  $("#settings-drawer").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.enabled !== undefined) {
      saveConfigPatch({ tracking: { enabled: t.checked } });
    } else if (t.dataset.field !== undefined) {
      saveConfigPatch({ fields: { [t.dataset.field]: t.checked } });
    }
  });
  document.querySelectorAll(".grid th.sortable").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === "ts" ? -1 : -1 };
      renderTable();
      persist();
    })
  );
  $("#rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr.row"); if (tr) openDrawer(tr.dataset.id);
  });
  $("#drawer").addEventListener("click", async (e) => {
    if (e.target.dataset.close !== undefined) return closeDrawer();
    if (e.target.dataset.del !== undefined) {
      const id = e.target.dataset.del;
      closeDrawer();
      await delEvents([id], "this prompt");
      return;
    }
    if (e.target.dataset.raw !== undefined) {
      const block = e.target.closest(".block"); if (!block) return;
      const raw = block.classList.toggle("show-raw");
      e.target.textContent = raw ? "rendered" : "raw";
      block.querySelector(".md").hidden = raw;
      block.querySelector(".raw").hidden = !raw;
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); closeSettings(); } });
}

bind();
initTheme();
boot();
