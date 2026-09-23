import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ref, onValue } from "firebase/database";
import { database } from "../../../firebase/config"; // ← same import style as StaffPassIssue — adjust if this file sits elsewhere
import "./StaffPassList.css";

/* =====================================================================
   STAFF PASS LIST — the complete STAFF pass record book
   ---------------------------------------------------------------------
   • Merges ALL staff pass records from Firebase into ONE live list:
       – "staffrequests" → REQUESTED / CANCELLED  (pending queue)
       – "staffpass"     → APPROVED / ISSUED / RETURNED (approved history)
       – "staffrejected" → REJECTED (declined requests)
     Every record is tagged with `_node` (its Firebase source node).
   • LIVE — three onValue listeners keep everything in sync across tabs
     and devices the instant anything changes. Because the Principal's
     approval page MOVES records (same _id) between nodes atomically,
     a record followed in the detail modal updates live, mid-view.
   • Live stats: total passes · today's movements · currently out
     (+ overdue) · pending · returned today · rejected.
   • Search (name / staff ID / department / reason / RFID / slip no /
     approver), status filter chips with live counts, department
     filter, date-range filter (today / 7 d / 30 d / all), FULL
     sorting (newest, oldest, name A–Z / Z–A, department, out time,
     expected return, status-grouped) and CSV export of exactly what
     is on screen.
   • Click any record → a CENTERED detail modal showing EVERY Firebase
     field: staff identity, pass details, approval, issue & slip,
     return, rejection / cancellation, record metadata and the full
     event timeline. Esc / backdrop-click closes · body scroll locks.
   • Loading skeletons, empty states, toasts and a live clock — the
     same rhythm as the rest of the system.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DB_REQUESTS_PATH = "staffrequests"; // pending queue (gate desk writes here)
const DB_PASSES_PATH   = "staffpass";     // approved / issued / returned history
const DB_REJECTED_PATH = "staffrejected"; // rejected requests

const PAGE_SIZE = 20;

const STATUS_ORDER = ["REQUESTED", "APPROVED", "ISSUED", "RETURNED", "CANCELLED", "REJECTED"];

const STATUS_TABS = [
  { key: "ALL",       label: "All records" },
  { key: "REQUESTED", label: "Pending"     },
  { key: "APPROVED",  label: "Approved"    },
  { key: "ISSUED",    label: "Out on pass"},
  { key: "RETURNED",  label: "Returned"   },
  { key: "CANCELLED", label: "Cancelled"  },
  { key: "REJECTED",  label: "Rejected"   },
];

/* ---------------- small helpers ---------------- */
const getInitials = (name) =>
  String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("") || "?";

/* Firebase node ({ "<passId>": { …pass } }) → clean array */
function sanitizePassList(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === "object") {
    return Object.entries(val).map(([key, p]) => ({ ...p, _id: p._id || key }));
  }
  return [];
}

/* "2025-06-11" / "2025-06-11T14:30" → local Date (no UTC surprises) */
function parseLocal(v) {
  const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}

/* ISO timestamps → "hh:mm · dd Mon" */
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`;
}

/* local "YYYY-MM-DD[THH:MM]" → full readable date */
function fmtFull(v) {
  const d = parseLocal(v);
  if (!d) return "—";
  return /T\d{2}:\d{2}/.test(String(v))
    ? d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d)) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} m`;
  if (m > 0) return `${m} min`;
  return "less than a minute";
}

/* status badge meta */
function statusMeta(status) {
  switch (String(status || "").toUpperCase()) {
    case "REQUESTED": return { label: "Pending",     cls: "requested", icon: "⏳" };
    case "APPROVED":  return { label: "Approved",    cls: "approved",  icon: "✓" };
    case "ISSUED":    return { label: "Out on pass", cls: "issued",    icon: "🎫" };
    case "RETURNED":  return { label: "Returned",    cls: "returned",  icon: "🏠" };
    case "CANCELLED": return { label: "Cancelled",   cls: "cancelled", icon: "✕" };
    case "REJECTED":  return { label: "Rejected",    cls: "rejected",  icon: "⛔" };
    default:          return { label: status || "Unknown", cls: "unknown", icon: "•" };
  }
}

/* planned / actual durations + overdue state for a record */
function recordDurations(pass, now) {
  const out = parseLocal(pass.outAt);
  const ret = parseLocal(pass.expectedReturn);
  const planned = out && ret ? ret - out : null;

  let actual = null;
  if (pass.issuedAt) {
    const end = pass.returnedAt ? new Date(pass.returnedAt) : now;
    if (!isNaN(end)) actual = end - new Date(pass.issuedAt);
  }

  let overdueMs = null;
  if (pass.status === "ISSUED" && ret) {
    const over = now - ret.getTime();
    if (over > 0) overdueMs = over;
  }

  return { planned, actual, overdueMs };
}

/* full event timeline built from every timestamp on the record */
function timelineOf(pass) {
  const items = [];
  const push = (icon, label, iso, note) => {
    if (!iso) return;
    const t = new Date(iso);
    if (isNaN(t)) return;
    items.push({ icon, label, at: t, note: note || null });
  };

  push("📝", "Request created", pass.createdAt === pass.requestedAt ? null : pass.createdAt);
  push("📤", "Sent for approval", pass.requestedAt);
  push("✏️", "Request edited", pass.editedAt);
  push("✅", "Approved", pass.approvedAt, pass.approvedBy ? `by ${pass.approvedBy}` : null);
  push("🎫", "Pass issued & printed", pass.issuedAt,
    [pass.slipNo ? `slip ${pass.slipNo}` : null, pass.issuedBy ? `by ${pass.issuedBy}` : null]
      .filter(Boolean).join(" · ") || null);
  if (pass.printedAt && pass.printedAt !== pass.issuedAt) push("🖨", "Slip printed", pass.printedAt);
  push("🏠", "Returned — marked IN", pass.returnedAt);
  push("🚫", "Cancelled", pass.cancelledAt, "withdrawn at the gate desk");
  push("⛔", "Rejected", pass.rejectedAt,
    [pass.rejectedBy ? `by ${pass.rejectedBy}` : null, pass.rejectionReason ? `— “${pass.rejectionReason}”` : null]
      .filter(Boolean).join(" ") || null);

  items.sort((a, b) => a.at - b.at);
  return items;
}

/* ---------- print ONE record (A4 summary, hidden iframe) ---------- */
function printRecord(pass) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const meta = statusMeta(pass.status);

  const rows = [
    ["Status", `${meta.label} (${pass.status || "—"})`],
    ["Name", pass.name],
    ["Staff ID", pass.staffId],
    ["Department", pass.department],
    ["RFID", pass.rfid],
    ["Reason", pass.reason],
    ["Out at", fmtFull(pass.outAt)],
    ["Expected return", fmtFull(pass.expectedReturn)],
    ["Requested at", pass.requestedAt ? new Date(pass.requestedAt).toLocaleString() : ""],
    ["Approved by", pass.approvedBy],
    ["Approved at", pass.approvedAt ? new Date(pass.approvedAt).toLocaleString() : ""],
    ["Slip number", pass.slipNo],
    ["Issued at", pass.issuedAt ? new Date(pass.issuedAt).toLocaleString() : ""],
    ["Issued by", pass.issuedBy],
    ["Returned at", pass.returnedAt ? new Date(pass.returnedAt).toLocaleString() : ""],
    ["Rejected by", pass.rejectedBy],
    ["Rejection reason", pass.rejectionReason],
    ["Cancelled at", pass.cancelledAt ? new Date(pass.cancelledAt).toLocaleString() : ""],
    ["Record ID", pass._id],
    ["Firebase source", pass._node],
  ]
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("");

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Staff Pass Record — ${esc(pass.name || "")}</title><style>` +
    `@page{size:A4;margin:14mm}html,body{margin:0;padding:0}` +
    `body{font-family:"Segoe UI",Arial,sans-serif;color:#111}` +
    `.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #222;padding-bottom:6px;margin-bottom:12px}` +
    `h1{font-size:17px;margin:0}.stamp{font-size:11px;color:#444}` +
    `table{width:100%;border-collapse:collapse;font-size:12px}` +
    `th{width:42mm;text-align:left;background:#f2f4f8;border:1px solid #d7dce6;padding:6px 8px;font-weight:600}` +
    `td{border:1px solid #d7dce6;padding:6px 8px;word-break:break-word}` +
    `tr:nth-child(even) td{background:#fafbfd}` +
    `.foot{margin-top:10px;font-size:10px;color:#666;text-align:center}` +
    `</style></head><body>` +
    `<div class="head"><h1>STAFF PASS RECORD</h1><span class="stamp">Printed ${esc(new Date().toLocaleString())}</span></div>` +
    `<table>${rows}</table>` +
    `<div class="foot">— DPIRS PassPort · staff pass record sheet —</div>` +
    `</body></html>`;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(iframe);
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) { iframe.remove(); return; }
    const remove = () => { try { iframe.remove(); } catch (err) { /* ignore */ } };
    try { win.focus(); win.print(); } catch (err) { remove(); return; }
    win.onafterprint = remove;
    setTimeout(remove, 60000);
  };
  iframe.srcdoc = html;
}

/* ---------- tiny presentational helpers ---------- */
function Field({ label, value, mono, tone }) {
  return (
    <div className={`spl-field${tone ? ` spl-field-${tone}` : ""}`}>
      <span className="spl-field-label">{label}</span>
      <span className={`spl-field-value${mono ? " spl-mono" : ""}`}>{value || "—"}</span>
    </div>
  );
}

function Section({ icon, title, children }) {
  return (
    <section className="spl-msection">
      <h3 className="spl-msection-title"><span className="spl-msection-icon">{icon}</span>{title}</h3>
      <div className="spl-msection-grid">{children}</div>
    </section>
  );
}

/* ===================================================================== */

export default function StaffPassList() {
  /* ================= STATE ================= */
  const [requests, setRequests] = useState([]);   // "staffrequests" snapshot
  const [passes, setPasses] = useState([]);      // "staffpass" snapshot
  const [rejected, setRejected] = useState([]);  // "staffrejected" snapshot
  const [nodeReady, setNodeReady] = useState({ r: false, p: false, j: false });

  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [deptFilter, setDeptFilter] = useState("ALL");
  const [dateFilter, setDateFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("newest");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [detailId, setDetailId] = useState(null); // the record shown in the centered modal

  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const [clock, setClock] = useState(() => new Date());

  /* clock — ticks every second (keeps "out so far" / overdue live) */
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  /* ================= TOAST ================= */
  const showToast = useCallback((text, type = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  /* ================= LIVE FIREBASE SYNC ================= */
  useEffect(() => {
    const markReady = (k) => setNodeReady((s) => (s[k] ? s : { ...s, [k]: true }));

    const unsubR = onValue(ref(database, DB_REQUESTS_PATH),
      (snap) => { setRequests(sanitizePassList(snap.val())); markReady("r"); },
      (err) => { setSyncError(err.message); markReady("r"); });

    const unsubP = onValue(ref(database, DB_PASSES_PATH),
      (snap) => { setPasses(sanitizePassList(snap.val())); markReady("p"); },
      (err) => { setSyncError(err.message); markReady("p"); });

    const unsubJ = onValue(ref(database, DB_REJECTED_PATH),
      (snap) => { setRejected(sanitizePassList(snap.val())); markReady("j"); },
      (err) => { setSyncError(err.message); markReady("j"); });

    return () => { unsubR(); unsubP(); unsubJ(); };
  }, []);

  useEffect(() => {
    if (nodeReady.r && nodeReady.p && nodeReady.j) setLoading(false);
  }, [nodeReady]);

  /* ================= MERGED LIVE LIST ================= */
  const all = useMemo(() => [
    ...requests.map((p) => ({ ...p, _node: DB_REQUESTS_PATH })),
    ...passes.map((p) => ({ ...p, _node: DB_PASSES_PATH })),
    ...rejected.map((p) => ({ ...p, _node: DB_REJECTED_PATH })),
  ].map((p) => ({ ...p, status: String(p.status || "").toUpperCase() })), [requests, passes, rejected]);

  /* the open modal follows its record LIVE (it keeps the same _id
     even when the Principal moves it between nodes) */
  const detail = useMemo(
    () => (detailId ? all.find((p) => p._id === detailId) || null : null),
    [all, detailId]
  );

  /* ================= LIVE STATS ================= */
  const stats = useMemo(() => {
    let out = 0, pending = 0, overdue = 0, movementsToday = 0, returnedToday = 0, rejectedCount = 0;
    all.forEach((p) => {
      if (p.status === "ISSUED") {
        out += 1;
        const ret = parseLocal(p.expectedReturn);
        if (ret && ret < clock) overdue += 1;
      }
      if (p.status === "REQUESTED") pending += 1;
      if (p.status === "REJECTED") rejectedCount += 1;
      if (isToday(p.returnedAt)) { returnedToday += 1; movementsToday += 1; }
      if (isToday(p.issuedAt)) movementsToday += 1;
    });
    return { total: all.length, out, overdue, pending, movementsToday, returnedToday, rejectedCount };
  }, [all, clock]);

  /* status counts for the filter chips */
  const statusCounts = useMemo(() => {
    const c = { ALL: all.length, REQUESTED: 0, APPROVED: 0, ISSUED: 0, RETURNED: 0, CANCELLED: 0, REJECTED: 0 };
    all.forEach((p) => { if (c[p.status] != null) c[p.status] += 1; });
    return c;
  }, [all]);

  /* departments present in the data (for the filter dropdown) */
  const departments = useMemo(() => {
    const set = new Set();
    all.forEach((p) => { const d = String(p.department || "").trim(); if (d) set.add(d); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [all]);

  /* ================= FILTER ================= */
  const filtered = useMemo(() => {
    let list = all;

    if (statusFilter !== "ALL") list = list.filter((p) => p.status === statusFilter);

    if (deptFilter !== "ALL") list = list.filter((p) => String(p.department || "").trim() === deptFilter);

    if (dateFilter !== "ALL") {
      const n = new Date();
      const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      let from;
      if (dateFilter === "TODAY")      from = startOfDay(n);
      else if (dateFilter === "7D")    from = startOfDay(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 6));
      else if (dateFilter === "30D")   from = startOfDay(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 29));
      if (from) {
        list = list.filter((p) => {
          const t = new Date(p.requestedAt || p.createdAt || 0);
          return !isNaN(t) && t >= from;
        });
      }
    }

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((p) =>
        [p.name, p.staffId, p.department, p.reason, p.rfid, p.slipNo,
         p.rejectionReason, p.approvedBy, p.rejectedBy]
          .some((v) => String(v || "").toLowerCase().includes(q))
      );
    }

    return list;
  }, [all, statusFilter, deptFilter, dateFilter, search]);

  /* ================= SORT — every type ================= */
  const sorted = useMemo(() => {
    const list = [...filtered];
    const ts    = (p) => { const t = new Date(p.requestedAt || p.createdAt || 0).getTime(); return isNaN(t) ? 0 : t; };
    const outTs = (p) => { const d = parseLocal(p.outAt); return d ? d.getTime() : 0; };
    const retTs = (p) => { const d = parseLocal(p.expectedReturn); return d ? d.getTime() : 0; };
    const name  = (p) => String(p.name || "").toLowerCase();
    const dept  = (p) => String(p.department || "").toLowerCase();

    switch (sortBy) {
      case "newest":      list.sort((a, b) => ts(b) - ts(a)); break;
      case "oldest":      list.sort((a, b) => ts(a) - ts(b)); break;
      case "name-asc":    list.sort((a, b) => name(a).localeCompare(name(b)) || ts(b) - ts(a)); break;
      case "name-desc":   list.sort((a, b) => name(b).localeCompare(name(a)) || ts(b) - ts(a)); break;
      case "dept-asc":    list.sort((a, b) => dept(a).localeCompare(dept(b)) || name(a).localeCompare(name(b))); break;
      case "out-desc":    list.sort((a, b) => outTs(b) - outTs(a)); break;
      case "out-asc":     list.sort((a, b) => outTs(a) - outTs(b)); break;
      case "return-desc": list.sort((a, b) => retTs(b) - retTs(a)); break;
      case "return-asc":  list.sort((a, b) => retTs(a) - retTs(b)); break;
      case "status":      list.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || ts(b) - ts(a)); break;
      default: break;
    }
    return list;
  }, [filtered, sortBy]);

  /* ================= PAGINATE ================= */
  const visible = useMemo(() => sorted.slice(0, visibleCount), [sorted, visibleCount]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, statusFilter, deptFilter, dateFilter, sortBy]);

  /* ================= MODAL ================= */
  const closeDetail = useCallback(() => setDetailId(null), []);

  /* Esc closes · body scroll locks while open */
  useEffect(() => {
    if (!detail) return;
    const onEsc = (e) => { if (e.key === "Escape") setDetailId(null); };
    window.addEventListener("keydown", onEsc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onEsc);
      document.body.style.overflow = prev;
    };
  }, [detail]);

  /* ================= ACTIONS ================= */
  const clearFilters = useCallback(() => {
    setSearch("");
    setStatusFilter("ALL");
    setDeptFilter("ALL");
    setDateFilter("ALL");
  }, []);

  const exportCsv = useCallback(() => {
    if (!sorted.length) { showToast("Nothing to export with the current filters.", "info"); return; }

    const headers = [
      "Name", "Staff ID", "Department", "RFID",
      "Status", "Reason", "Out At", "Expected Return",
      "Requested At", "Approved By", "Approved At",
      "Slip No", "Issued At", "Returned At",
      "Rejected By", "Rejected At", "Rejection Reason",
      "Cancelled At", "Record ID", "Source Node",
    ];
    const rows = sorted.map((p) => [
      p.name, p.staffId, p.department, p.rfid,
      statusMeta(p.status).label, p.reason, fmtFull(p.outAt), fmtFull(p.expectedReturn),
      p.requestedAt ? new Date(p.requestedAt).toLocaleString() : "",
      p.approvedBy, p.approvedAt ? new Date(p.approvedAt).toLocaleString() : "",
      p.slipNo, p.issuedAt ? new Date(p.issuedAt).toLocaleString() : "",
      p.returnedAt ? new Date(p.returnedAt).toLocaleString() : "",
      p.rejectedBy, p.rejectedAt ? new Date(p.rejectedAt).toLocaleString() : "",
      p.rejectionReason, p.cancelledAt ? new Date(p.cancelledAt).toLocaleString() : "",
      p._id, p._node,
    ]);

    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `staff-pass-records-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`✓ Exported ${sorted.length} record(s) to CSV`, "success");
  }, [sorted, showToast]);

  const handlePrintRecord = useCallback(() => {
    if (!detail) return;
    printRecord(detail);
    showToast("🖨 Sending the record summary to the printer…", "info");
  }, [detail, showToast]);

  const filtersActive = !!search || statusFilter !== "ALL" || deptFilter !== "ALL" || dateFilter !== "ALL";

  /* ================= RENDER ================= */
  return (
    <section className="spl">
      {/* ---------- header ---------- */}
      

      {/* ---------- live stats ---------- */}
      <div className="spl-stats">
        
        <div className="spl-stat spl-stat-moves">
          <span className="spl-stat-icon">📊</span>
          <div>
            <span className="spl-stat-num">{stats.movementsToday}</span>
            <span className="spl-stat-label">Today's movements</span>
          </div>
        </div>
        <div className="spl-stat spl-stat-out">
          <span className="spl-stat-icon">🚶</span>
          <div>
            <span className="spl-stat-num">{stats.out}</span>
            <span className="spl-stat-label">Currently out</span>
            {stats.overdue > 0 && <span className="spl-stat-sub">⚠ {stats.overdue} overdue</span>}
          </div>
        </div>
        <div className="spl-stat spl-stat-pending">
          <span className="spl-stat-icon">⏳</span>
          <div>
            <span className="spl-stat-num">{stats.pending}</span>
            <span className="spl-stat-label">Pending requests</span>
          </div>
        </div>
        <div className="spl-stat spl-stat-ret">
          <span className="spl-stat-icon">🏠</span>
          <div>
            <span className="spl-stat-num">{stats.returnedToday}</span>
            <span className="spl-stat-label">Returned today</span>
          </div>
        </div>
        <div className="spl-stat spl-stat-rej">
          <span className="spl-stat-icon">⛔</span>
          <div>
            <span className="spl-stat-num">{stats.rejectedCount}</span>
            <span className="spl-stat-label">Rejected</span>
          </div>
        </div>
      </div>

      {/* ---------- toolbar ---------- */}
      <div className="spl-toolbar">
        <div className="spl-searchbox">
          <span className="spl-search-icon">🔎</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, staff ID, department, reason, RFID or slip no…"
            aria-label="Search pass records"
            spellCheck={false}
            autoComplete="off"
          />
          {search && (
            <button type="button" className="spl-search-clear" onClick={() => setSearch("")} aria-label="Clear search">×</button>
          )}
        </div>

        <div className="spl-controls">
          <select
            className="spl-select"
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
            aria-label="Filter by department"
          >
            <option value="ALL">All departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>

          <select
            className="spl-select"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            aria-label="Filter by date range"
          >
            <option value="ALL">All time</option>
            <option value="TODAY">Today</option>
            <option value="7D">Last 7 days</option>
            <option value="30D">Last 30 days</option>
          </select>

          <select
            className="spl-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            aria-label="Sort records"
          >
            <option value="newest">Sort · Newest first</option>
            <option value="oldest">Sort · Oldest first</option>
            <option value="name-asc">Sort · Name A → Z</option>
            <option value="name-desc">Sort · Name Z → A</option>
            <option value="dept-asc">Sort · Department A → Z</option>
            <option value="out-desc">Sort · Out time (latest)</option>
            <option value="out-asc">Sort · Out time (earliest)</option>
            <option value="return-desc">Sort · Expected return (latest)</option>
            <option value="return-asc">Sort · Expected return (earliest)</option>
            <option value="status">Sort · Status (grouped)</option>
          </select>

          <button type="button" className="spl-btn spl-btn-ghost" onClick={exportCsv}>⬇ Export CSV</button>
        </div>
      </div>

      {/* ---------- status filter chips ---------- */}
      <div className="spl-statuschips" role="tablist" aria-label="Filter by status">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={statusFilter === tab.key}
            className={`spl-chipbtn ${statusFilter === tab.key ? "spl-chipbtn-active" : ""}`}
            onClick={() => setStatusFilter(tab.key)}
          >
            {tab.label}
            <span className="spl-chipbtn-count">{statusCounts[tab.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* ---------- count row ---------- */}
      <div className="spl-countrow">
        <span className="spl-count">
          {loading
            ? "Loading records…"
            : `Showing ${visible.length} of ${sorted.length} record${sorted.length === 1 ? "" : "s"}${filtered.length !== all.length ? ` (of ${all.length} total)` : ""}`}
        </span>
        {filtersActive && (
          <button type="button" className="spl-clear-filters" onClick={clearFilters}>
            Clear all filters ×
          </button>
        )}
      </div>

      {/* ---------- record list ---------- */}
      <div className="spl-list">
        {loading ? (
          <>
            <div className="spl-skeleton" />
            <div className="spl-skeleton" />
            <div className="spl-skeleton" />
            <div className="spl-skeleton" />
          </>
        ) : visible.length === 0 ? (
          <div className="spl-empty">
            <div className="spl-empty-icon">{filtersActive ? "🔎" : "📋"}</div>
            <h3>{filtersActive ? "No matching records" : "No pass records yet"}</h3>
            <p>
              {filtersActive
                ? "Nothing matches the current search or filters. Try clearing them."
                : "Requests, approvals, issued passes, returns, cancellations and rejections will appear here automatically."}
            </p>
          </div>
        ) : (
          visible.map((pass) => {
            const meta = statusMeta(pass.status);
            const dur = recordDurations(pass, clock);
            return (
              <article
                key={pass._id}
                className={`spl-row ${detailId === pass._id ? "spl-row-active" : ""}`}
                onClick={() => setDetailId(pass._id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetailId(pass._id); }
                }}
                role="button"
                tabIndex={0}
                aria-label={`View pass record for ${pass.name || "unknown staff"}`}
              >
                <span className="spl-avatar">{getInitials(pass.name)}</span>

                <div className="spl-row-main">
                  <div className="spl-row-titlerow">
                    <h3 className="spl-row-name">{pass.name || "Unknown staff"}</h3>
                    <span className="spl-type">STAFF PASS</span>
                    <span className={`spl-status spl-status-${meta.cls}`}>{meta.icon} {meta.label}</span>
                    {dur.overdueMs !== null && (
                      <span className="spl-overdue">⚠ overdue {fmtDuration(dur.overdueMs)}</span>
                    )}
                  </div>
                  <div className="spl-row-meta">
                    {pass.department && <span className="spl-chip">{pass.department}</span>}
                    {pass.staffId && <span className="spl-chip">{pass.staffId}</span>}
                    {pass.rfid && <span className="spl-chip spl-chip-mono">{pass.rfid}</span>}
                    {pass.slipNo && <span className="spl-chip spl-chip-slip">{pass.slipNo}</span>}
                  </div>
                  <p className="spl-row-reason" title={pass.reason}>“{pass.reason || "No reason given"}”</p>
                </div>

                <div className="spl-row-times">
                  <div className="spl-time">
                    <span className="spl-time-label">Out at</span>
                    <span className="spl-time-value">{fmtFull(pass.outAt)}</span>
                  </div>
                  <div className="spl-time">
                    <span className="spl-time-label">Expected return</span>
                    <span className="spl-time-value">{fmtFull(pass.expectedReturn)}</span>
                  </div>
                  <div className="spl-time">
                    <span className="spl-time-label">{pass.status === "RETURNED" ? "Returned" : "Requested"}</span>
                    <span className="spl-time-value">
                      {pass.status === "RETURNED"
                        ? fmtDateTime(pass.returnedAt)
                        : fmtDateTime(pass.requestedAt || pass.createdAt)}
                    </span>
                  </div>
                </div>

                <span className="spl-row-view" aria-hidden="true">View ▸</span>
              </article>
            );
          })
        )}
      </div>

      {/* ---------- load more ---------- */}
      {!loading && visibleCount < sorted.length && (
        <div className="spl-loadmore-wrap">
          <button type="button" className="spl-loadmore" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
            Load {Math.min(PAGE_SIZE, sorted.length - visibleCount)} more · {sorted.length - visibleCount} remaining
          </button>
        </div>
      )}

      {/* ---------- centered detail modal ---------- */}
      {detail && (() => {
        const meta = statusMeta(detail.status);
        const dur = recordDurations(detail, clock);
        const timeline = timelineOf(detail);
        return (
          <div
            className="spl-overlay"
            onMouseDown={(e) => { if (e.target === e.currentTarget) closeDetail(); }}
          >
            <div className="spl-modal" role="dialog" aria-modal="true" aria-label={`Pass record — ${detail.name || "unknown staff"}`}>
              <header className="spl-modal-head">
                <span className="spl-avatar spl-avatar-lg">{getInitials(detail.name)}</span>
                <div className="spl-modal-id">
                  <h2 className="spl-modal-name">{detail.name || "Unknown staff"}</h2>
                  <div className="spl-modal-badges">
                    <span className={`spl-status spl-status-lg spl-status-${meta.cls}`}>{meta.icon} {meta.label}</span>
                    <span className="spl-nodetag" title="Firebase source node">db: {detail._node}</span>
                  </div>
                </div>
                <button type="button" className="spl-modal-close" onClick={closeDetail} aria-label="Close record">×</button>
              </header>

              <div className="spl-modal-body">
                {/* identity chips */}
                <div className="spl-modal-chips">
                  {detail.kind && <span className="spl-chip">{detail.kind}</span>}
                  {detail.department && <span className="spl-chip">🏫 {detail.department}</span>}
                  {detail.staffId && <span className="spl-chip">🆔 {detail.staffId}</span>}
                  {detail.rfid && <span className="spl-chip spl-chip-mono">📶 {detail.rfid}</span>}
                  {detail.slipNo && <span className="spl-chip spl-chip-slip">🎫 {detail.slipNo}</span>}
                </div>

                {/* reason */}
                <div className="spl-reasonbox">
                  <span className="spl-reasonbox-label">Reason for the pass</span>
                  <p className="spl-reasonbox-text">“{detail.reason || "No reason given"}”</p>
                </div>

                {/* key times */}
                <div className="spl-modal-grid">
                  <Field label="Out at" value={fmtFull(detail.outAt)} />
                  <Field label="Expected return" value={fmtFull(detail.expectedReturn)} />
                  <Field label="Planned duration" value={fmtDuration(dur.planned)} />
                  {dur.actual !== null && (
                    <Field
                      label={detail.status === "RETURNED" ? "Total time out" : "Out so far"}
                      value={fmtDuration(dur.actual)}
                    />
                  )}
                  {dur.overdueMs !== null && <Field label="Overdue by" value={fmtDuration(dur.overdueMs)} tone="bad" />}
                </div>

                {/* sections — every Firebase field */}
                <Section icon="🧑‍🏫" title="Staff details">
                  <Field label="Name" value={detail.name} />
                  <Field label="Staff ID" value={detail.staffId} />
                  <Field label="Department" value={detail.department} />
                  <Field label="RFID card" value={detail.rfid} mono />
                  <Field label="Staff record key" value={detail.staffKey} mono />
                </Section>

                <Section icon="✅" title="Approval">
                  <Field label="Approved by" value={detail.approvedBy} />
                  <Field label="Approved at" value={fmtDateTime(detail.approvedAt)} />
                  <Field label="Authorized by" value={detail.authorizedBy} />
                  <Field label="Requested at" value={fmtDateTime(detail.requestedAt || detail.createdAt)} />
                </Section>

                <Section icon="🎫" title="Issue & slip">
                  <Field label="Slip number" value={detail.slipNo} mono />
                  <Field label="Issued at" value={fmtDateTime(detail.issuedAt)} />
                  <Field label="Issued by" value={detail.issuedBy} />
                  <Field label="Printed at" value={fmtDateTime(detail.printedAt)} />
                </Section>

                <Section icon="🏠" title="Return">
                  <Field label="Returned at" value={fmtDateTime(detail.returnedAt)} />
                  <Field label="Total time out" value={dur.actual !== null ? fmtDuration(dur.actual) : "—"} />
                </Section>

                {detail.status === "REJECTED" && (
                  <Section icon="⛔" title="Rejection">
                    <Field label="Rejected by" value={detail.rejectedBy} />
                    <Field label="Rejected at" value={fmtDateTime(detail.rejectedAt)} />
                    <Field label="Reason for rejection" value={detail.rejectionReason || "No reason recorded"} tone="bad" />
                  </Section>
                )}

                {detail.status === "CANCELLED" && (
                  <Section icon="🚫" title="Cancellation">
                    <Field label="Cancelled at" value={fmtDateTime(detail.cancelledAt)} />
                    <Field label="Cancelled by" value="Gate desk (withdrawn before approval)" />
                  </Section>
                )}

                <Section icon="🗄" title="Record metadata">
                  <Field label="Record ID" value={detail._id} mono />
                  <Field label="Firebase source" value={detail._node} mono />
                  <Field label="Created at" value={fmtDateTime(detail.createdAt)} />
                  <Field label="Last edited" value={fmtDateTime(detail.editedAt)} />
                </Section>

                {/* timeline */}
                {timeline.length > 0 && (
                  <section className="spl-timeline">
                    <h3 className="spl-timeline-title">🕘 Timeline</h3>
                    <ol className="spl-timeline-list">
                      {timeline.map((t, i) => (
                        <li key={i} className="spl-timeline-item">
                          <span className="spl-timeline-dot">{t.icon}</span>
                          <div className="spl-timeline-text">
                            <span className="spl-timeline-label">{t.label}</span>
                            {t.note && <span className="spl-timeline-note">{t.note}</span>}
                          </div>
                          <span className="spl-timeline-at">
                            {t.at.toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </div>

              <footer className="spl-modal-footer">
                <span className="spl-modal-hint">This record updates live while the window is open · Esc to close</span>
                <div className="spl-modal-footer-btns">
                  <button type="button" className="spl-btn spl-btn-ghost" onClick={handlePrintRecord}>🖨 Print record</button>
                  <button type="button" className="spl-btn spl-btn-primary" onClick={closeDetail}>Close</button>
                </div>
              </footer>
            </div>
          </div>
        );
      })()}

      {/* ---------- toast ---------- */}
      {toast && (
        <div key={toast.id} className={`spl-toast spl-toast-${toast.type}`}>{toast.text}</div>
      )}
    </section>
  );
}