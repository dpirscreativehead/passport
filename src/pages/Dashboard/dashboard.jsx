import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { ref, onValue } from "firebase/database";
import { database } from "../../firebase/config"; // ← same config the other pages use — adjust the depth if this file sits elsewhere
import "./dashboard.css";

/* =====================================================================
   DASHBOARD — the landing page of DPIRS PassPort
   ---------------------------------------------------------------------
   • Single premium page, 100% READ-ONLY, fully LIVE.
   • Ten Firebase collections stream in at once and merge into one
     de-duplicated dataset (same normalization as Reports).
   • HERO — "campus pulse": animated counter of people out right now,
     expected-back-today, overdue alert, EKG pulse line, live clock.
   • STATS — six KPI cards with count-up numbers, trend sparklines and
     a students/staff split bar.
   • CHARTS — stacked 7/14-day movement bar chart (issued · raised ·
     returned · closed) with hover tooltips + average line, and an
     interactive animated status donut with a live legend.
   • LISTS — "Out on pass" live table (overdue first, due-today /
     overdue filters) + the "Awaiting action" queue.
   • FEED — latest events across every collection.
   • SOURCES — live health of all ten streams + community counts.
   • Print an A4 summary sheet · export an Excel snapshot.
   • Every block reveals one-by-one with smooth staggered rises.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DAY_MS = 86400000;
const OUT_LIMIT = 8;
const ACT_LIMIT = 6;
const FEED_LIMIT = 12;

const TIME_FIELDS = ["createdAt","updatedAt","editedAt","requestedAt","approvedAt","issuedAt","printedAt","returnedAt","rejectedAt","cancelledAt"];

const COLLECTIONS = {
  studentPass:          { path: "studentPass",          scope: "STUDENT", label: "Student gate passes",       defKind: "STUDENT_PASS", defStatus: "ISSUED"    },
  studentRequest:       { path: "studentRequest",       scope: "STUDENT", label: "Pending student requests",  defKind: "DAY_PASS",     defStatus: "REQUESTED" },
  daypass:              { path: "daypass",              scope: "STUDENT", label: "Approved day passes",       defKind: "DAY_PASS",     defStatus: "APPROVED"  },
  rejectedStudentPass:  { path: "rejectedStudentPass",  scope: "STUDENT", label: "Rejected student records",  defKind: "DAY_PASS",     defStatus: "REJECTED"  },
  cancelledStudentPass: { path: "cancelledStudentPass", scope: "STUDENT", label: "Cancelled student records", defKind: "DAY_PASS",     defStatus: "CANCELLED" },
  staffrequests:        { path: "staffrequests",        scope: "STAFF",   label: "Pending staff requests",    defKind: "STAFF_PASS",   defStatus: "REQUESTED" },
  staffpass:            { path: "staffpass",            scope: "STAFF",   label: "Staff passes",              defKind: "STAFF_PASS",   defStatus: "ISSUED"    },
  staffrejected:        { path: "staffrejected",        scope: "STAFF",   label: "Rejected staff records",    defKind: "STAFF_PASS",   defStatus: "REJECTED"  },
  /* optional master directories — safe even if these nodes don't exist */
  students:             { path: "students",             scope: "STUDENT", label: "Student directory",         defKind: "DIRECTORY",    defStatus: "LISTED"    },
  staff:                { path: "staff",                scope: "STAFF",   label: "Staff directory",           defKind: "DIRECTORY",    defStatus: "LISTED"    },
};

const STATUS_META = {
  REQUESTED: { label: "Pending",     icon: "⏳", tone: "amber" },
  APPROVED:  { label: "Approved",    icon: "✓",  tone: "blue"  },
  ISSUED:    { label: "Out on pass", icon: "🎫", tone: "green" },
  RETURNED:  { label: "Returned",    icon: "↩",  tone: "slate" },
  REJECTED:  { label: "Rejected",    icon: "⛔", tone: "red"   },
  CANCELLED: { label: "Cancelled",   icon: "⊘",  tone: "gray"  },
  LISTED:    { label: "Listed",      icon: "📇", tone: "gray"  },
};

const KIND_META = {
  STUDENT_PASS: "Student pass",
  DAY_PASS:     "Day pass",
  STAFF_PASS:   "Staff pass",
  DIRECTORY:    "Directory entry",
};

const DONUT_COLORS = {
  REQUESTED: "#ffd27a",
  APPROVED:  "#9cc8ff",
  ISSUED:    "#a4dd00",
  RETURNED:  "#b2c4dc",
  REJECTED:  "#ff9d9d",
  CANCELLED: "rgba(255, 254, 239, 0.38)",
};

const SRC_SHORT = {
  studentPass:          "Student gate passes",
  studentRequest:       "Student requests",
  daypass:              "Approved day passes",
  rejectedStudentPass:  "Rejected · students",
  cancelledStudentPass: "Cancelled · students",
  staffrequests:        "Staff requests",
  staffpass:            "Staff passes",
  staffrejected:        "Rejected · staff",
};

/* ---------------- small helpers ---------------- */
const getInitials = (name) =>
  String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("") || "?";

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#6366f1,#8b5cf6)", "linear-gradient(135deg,#0ea5e9,#2563eb)",
  "linear-gradient(135deg,#10b981,#059669)", "linear-gradient(135deg,#f59e0b,#ea580c)",
  "linear-gradient(135deg,#ec4899,#db2777)", "linear-gradient(135deg,#14b8a6,#0d9488)",
  "linear-gradient(135deg,#f43f5e,#be123c)",
];
const avatarGradient = (name) =>
  AVATAR_GRADIENTS[Math.abs(String(name || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % AVATAR_GRADIENTS.length];

const kindCls = (kind) => kind === "STUDENT_PASS" ? "student" : kind === "DAY_PASS" ? "day" : kind === "STAFF_PASS" ? "staff" : "dir";

function parseLocal(v) {
  const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function tsMs(v) { if (!v) return 0; const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; }
const inTs = (v, a, b) => { const t = tsMs(v); return t >= a && t < b; };

function timeAgo(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return "—";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h > 1 ? "s" : ""} ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}
function fmtStamp(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtExpected(v) {
  const d = parseLocal(v);
  if (!d) return "—";
  return /T\d{2}:\d{2}/.test(String(v))
    ? `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`
    : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}
function isTodayDate(v) {
  const d = parseLocal(v);
  if (!d) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function isOverdueDate(v) {
  const d = parseLocal(v);
  if (!d) return false;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  return d < t0;
}
const isOverdue = (r) => r.status === "ISSUED" && isOverdueDate(r.expectedReturn);

const trunc = (s, n) => { const v = String(s ?? ""); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------------- record normalization (same as Reports) ---------------- */
function normalizeRecord(raw, key, sourceId) {
  const cfg = COLLECTIONS[sourceId];
  const p = raw && typeof raw === "object" ? raw : {};
  const kindRaw   = String(p.kind   || "").toUpperCase();
  const statusRaw = String(p.status || "").toUpperCase();
  const kind   = KIND_META[kindRaw]   ? kindRaw   : cfg.defKind;
  const status = STATUS_META[statusRaw] ? statusRaw : cfg.defStatus;
  const className  = String(p.className  || p.class || "").trim();
  const department = String(p.department || p.dept  || "").trim();
  return {
    ...p,
    _id: String(p._id || key),
    source: sourceId, scope: cfg.scope, kind, status,
    name: String(p.name || p.fullName || p.staffName || p.studentName || "Unknown").trim(),
    className, department,
    group: cfg.scope === "STAFF" ? (department || className || "—") : (className || department || "—"),
    reason: String(p.reason || ""),
    expectedReturn: p.expectedReturn || null,
    outAt: p.outAt || null,
    slipNo: p.slipNo ? String(p.slipNo) : null,
    approvedBy: p.approvedBy ? String(p.approvedBy) : "",
    rejectionReason: p.rejectionReason ? String(p.rejectionReason) : "",
    createdAt: p.createdAt || null, updatedAt: p.updatedAt || null,
    requestedAt: p.requestedAt || null, approvedAt: p.approvedAt || null,
    issuedAt: p.issuedAt || null, printedAt: p.printedAt || null,
    returnedAt: p.returnedAt || null, rejectedAt: p.rejectedAt || null, cancelledAt: p.cancelledAt || null,
  };
}
function sanitizeNode(val, sourceId) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  return Object.entries(val)
    .map(([key, raw]) => normalizeRecord(raw, key, sourceId))
    .filter((r) => r && r._id);
}
function activityTime(r) {
  return TIME_FIELDS.reduce((max, f) => Math.max(max, tsMs(r[f])), 0);
}

/* ---------------- count-up (premium number animation) ---------------- */
function useCountUp(target, duration = 750) {
  const [display, setDisplay] = useState(0);
  const ref = useRef({ from: 0, raf: 0 });
  useEffect(() => {
    const to = Number(target) || 0;
    if (ref.current.raf) cancelAnimationFrame(ref.current.raf);
    const from = ref.current.from;
    if (from === to) { setDisplay(to); return; }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      const v = Math.round(from + (to - from) * e);
      ref.current.from = v;
      setDisplay(v);
      if (p < 1) ref.current.raf = requestAnimationFrame(step);
      else ref.current.raf = 0;
    };
    ref.current.raf = requestAnimationFrame(step);
    return () => { if (ref.current.raf) cancelAnimationFrame(ref.current.raf); ref.current.raf = 0; };
  }, [target, duration]);
  return display;
}
function CountUp({ value, className }) {
  const v = useCountUp(value);
  return <span className={className}>{v.toLocaleString()}</span>;
}

/* ---------------- sparkline ---------------- */
function Spark({ data, tone }) {
  const W = 100, H = 32, PAD = 3;
  const max = Math.max(...data, 1);
  const n = data.length;
  const pts = data.map((v, i) => [
    PAD + (i / Math.max(n - 1, 1)) * (W - 2 * PAD),
    H - PAD - (v / max) * (H - 2 * PAD),
  ]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${d} L${W - PAD} ${H} L${PAD} ${H} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg className="db-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} className={`db-spark-area db-sa-${tone}`} />
      <path d={d} className={`db-spark-line db-sl-${tone}`} pathLength="1" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.4" className={`db-spark-dot db-sd-${tone}`} />
    </svg>
  );
}

/* ---------------- students / staff split bar ---------------- */
function SplitBar({ a, b }) {
  const total = a + b || 1;
  return (
    <div className="db-split">
      <div className="db-split-bar">
        <span className="db-split-a" style={{ width: `${(a / total) * 100}%` }} />
        <span className="db-split-b" style={{ width: `${(b / total) * 100}%` }} />
      </div>
      <span className="db-split-note">{a} students · {b} staff</span>
    </div>
  );
}

/* ---------------- stacked movement bar chart ---------------- */
function ActivityChart({ days, mode, onMode }) {
  const max = Math.max(...days.map((d) => d.total), 1);
  const totalSum = days.reduce((a, d) => a + d.total, 0);
  const avg = totalSum / days.length;
  const avgLabel = avg > 0 && avg < 10 ? Math.round(avg * 10) / 10 : Math.round(avg);
  const peak = days.reduce((p, d) => (d.total > p.total ? d : p), days[0]);
  return (
    <section className="db-card db-chartcard">
      <div className="db-card-head">
        <div>
          <h3 className="db-card-title">📈 Movement activity</h3>
          <p className="db-card-sub">issued · raised · returned · closed — per day</p>
        </div>
        <div className="db-chart-tools">
          <span className="db-peak">peak <b>{peak.total}</b> · {peak.label}</span>
          <div className="db-toggle">
            <button type="button" className={mode === 7 ? "db-tog-on" : ""} onClick={() => onMode(7)}>7 d</button>
            <button type="button" className={mode === 14 ? "db-tog-on" : ""} onClick={() => onMode(14)}>14 d</button>
          </div>
        </div>
      </div>
      <div className="db-chart">
        <div className="db-chartarea">
          {avg > 0 && (
            <div className="db-avgline" style={{ bottom: `${(avg / max) * 100}%` }}>
              <span className="db-avgchip">avg {avgLabel}</span>
            </div>
          )}
          {days.map((d, i) => (
            <div key={d.key} className={`db-barcol${i === 0 ? " db-edge-l" : ""}${i === days.length - 1 ? " db-edge-r" : ""}`}>
              <div className="db-bartip">
                <span className="db-bartip-date">{d.label}{d.isToday ? " · today" : ""}</span>
                <span className="db-bartip-n">{d.total} movement{d.total === 1 ? "" : "s"}</span>
                <span className="db-bartip-brk">🎫 {d.issued} issued · ⏳ {d.raised} raised</span>
                <span className="db-bartip-brk">↩ {d.returned} returned · ⛔ {d.closed} closed</span>
              </div>
              {d.total > 0 ? (
                <div
                  className={`db-barstack${d.isToday ? " db-barstack-today" : ""}`}
                  style={{ height: `${Math.max((d.total / max) * 100, 4)}%`, animationDelay: `${(0.62 + i * 0.045).toFixed(2)}s` }}
                >
                  {d.issued   > 0 && <span className="db-seg db-seg-issued"   style={{ height: `${(d.issued   / d.total) * 100}%` }} />}
                  {d.raised   > 0 && <span className="db-seg db-seg-raised"   style={{ height: `${(d.raised   / d.total) * 100}%` }} />}
                  {d.returned > 0 && <span className="db-seg db-seg-returned" style={{ height: `${(d.returned / d.total) * 100}%` }} />}
                  {d.closed   > 0 && <span className="db-seg db-seg-closed"   style={{ height: `${(d.closed   / d.total) * 100}%` }} />}
                </div>
              ) : (
                <div className="db-barzero" />
              )}
              {d.total > 0 && <span className="db-bar-n" style={{ bottom: `calc(${Math.max((d.total / max) * 100, 4)}% + 6px)` }}>{d.total}</span>}
            </div>
          ))}
        </div>
        <div className="db-barlabels">
          {days.map((d) => (
            <div key={d.key} className={`db-barlab${d.isToday ? " db-barlab-today" : ""}`}>
              <span className="db-barlab-dow">{d.dow}</span>
              <span className="db-barlab-day">{d.day}</span>
            </div>
          ))}
        </div>
        <div className="db-chartlegend">
          <span className="db-cl"><i style={{ background: "#a4dd00" }} /> issued</span>
          <span className="db-cl"><i style={{ background: "#ffd27a" }} /> raised</span>
          <span className="db-cl"><i style={{ background: "#9cc8ff" }} /> returned</span>
          <span className="db-cl"><i style={{ background: "#ff9d9d" }} /> closed</span>
        </div>
      </div>
    </section>
  );
}

/* ---------------- animated interactive donut ---------------- */
function StatusDonut({ dist, total, active, onHover, on }) {
  const R = 64;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const segs = dist.filter((s) => s.count > 0).map((s, i) => {
    const len = total > 0 ? (s.count / total) * C : 0;
    const seg = { ...s, len, rot: (acc / C) * 360, i };
    acc += len;
    return seg;
  });
  const activeSeg = active ? dist.find((s) => s.id === active) : null;
  return (
    <div className={`db-donutwrap${on ? " db-donut-on" : ""}`}>
      <svg viewBox="0 0 180 180" className="db-donut" role="img" aria-label="Status distribution of all records">
        <circle cx="90" cy="90" r={R} className="db-donut-track" />
        <g transform="rotate(-90 90 90)">
          {segs.map((s) => (
            <circle
              key={s.id}
              cx="90" cy="90" r={R}
              className={`db-donut-seg${active && active !== s.id ? " db-seg-dim" : ""}`}
              transform={`rotate(${s.rot} 90 90)`}
              style={{ stroke: DONUT_COLORS[s.id], "--seg": `${s.len}px`, "--rest": `${C - s.len}px`, "--d": `${(0.15 + s.i * 0.09).toFixed(2)}s` }}
              onMouseEnter={() => onHover(s.id)}
              onMouseLeave={() => onHover(null)}
            />
          ))}
        </g>
      </svg>
      <div className="db-donut-center">
        <span className="db-donut-n">{activeSeg ? activeSeg.count.toLocaleString() : <CountUp value={total} />}</span>
        <span className="db-donut-l">{activeSeg ? (STATUS_META[activeSeg.id] || {}).label || activeSeg.id : "total records"}</span>
      </div>
    </div>
  );
}

/* ---------------- printing (hidden iframe) ---------------- */
function printHtml(html) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(iframe);
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) { iframe.remove(); return; }
    const remove = () => { try { iframe.remove(); } catch (e) { /* ignore */ } };
    try { win.focus(); win.print(); } catch (e) { remove(); return; }
    win.onafterprint = remove;
    setTimeout(remove, 60000);
  };
  iframe.srcdoc = html;
}

/* ===================================================================== */

export default function Dashboard() {
  /* ================= LIVE DATA ================= */
  const [data, setData]           = useState({});
  const [ready, setReady]         = useState({});
  const [syncError, setSyncError] = useState("");

  /* ================= UI STATE ================= */
  const [clock, setClock]           = useState(() => new Date());
  const [chartMode, setChartMode]   = useState(14);
  const [outFilter, setOutFilter]   = useState("all");
  const [showAllOut, setShowAllOut] = useState(false);
  const [activeStatus, setActiveStatus] = useState(null);
  const [donutOn, setDonutOn]       = useState(false);
  const [toast, setToast]           = useState(null);
  const toastTimerRef = useRef(null);

  /* ================= CLOCK ================= */
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

  /* ================= FIREBASE — 10 live read-only subscriptions ================= */
  useEffect(() => {
    setSyncError("");
    const unsubs = Object.entries(COLLECTIONS).map(([id, cfg]) =>
      onValue(ref(database, cfg.path),
        (snap) => { setData((prev) => ({ ...prev, [id]: sanitizeNode(snap.val(), id) })); setReady((prev) => ({ ...prev, [id]: true })); },
        (err)   => { setSyncError(err.message); setReady((prev) => ({ ...prev, [id]: true })); })
    );
    return () => unsubs.forEach((u) => u());
  }, []);

  const loading = useMemo(() => Object.keys(COLLECTIONS).some((k) => !ready[k]), [ready]);
  const readyCount = useMemo(() => Object.keys(COLLECTIONS).filter((k) => ready[k]).length, [ready]);

  /* donut draw-in — one beat after the data lands */
  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => setDonutOn(true), 90);
    return () => clearTimeout(t);
  }, [loading]);

  /* ================= MERGED DATASET (de-duplicated) ================= */
  const allRecords = useMemo(() => {
    const byId = new Map();
    Object.values(data).flat().forEach((r) => {
      const prev = byId.get(r._id);
      if (!prev || activityTime(r) > activityTime(prev)) byId.set(r._id, r);
    });
    return [...byId.values()];
  }, [data]);

  /* movement records only — directories feed the community block instead */
  const passes = useMemo(() => allRecords.filter((r) => r.kind !== "DIRECTORY"), [allRecords]);
  const community = useMemo(() => ({
    students: (data.students || []).length,
    staff:    (data.staff    || []).length,
  }), [data]);

  /* ================= 14-DAY HISTORY (chart + sparklines) ================= */
  const dayStats = useMemo(() => {
    const t0 = startOfToday().getTime();
    const out = [];
    for (let i = 13; i >= 0; i--) {
      const start = t0 - i * DAY_MS;
      const end = start + DAY_MS;
      let issued = 0, raised = 0, returned = 0, closed = 0;
      passes.forEach((r) => {
        if (inTs(r.printedAt || r.issuedAt, start, end)) issued++;
        if (inTs(r.requestedAt || r.createdAt, start, end)) raised++;
        if (inTs(r.returnedAt, start, end)) returned++;
        if (inTs(r.rejectedAt, start, end) || inTs(r.cancelledAt, start, end)) closed++;
      });
      const d = new Date(start);
      out.push({
        key: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
        total: issued + raised + returned + closed,
        issued, raised, returned, closed,
        dow: d.toLocaleDateString([], { weekday: "short" }),
        day: d.getDate(),
        label: d.toLocaleDateString([], { day: "2-digit", month: "short" }),
        isToday: i === 0,
      });
    }
    return out;
  }, [passes]);

  const days   = chartMode === 7 ? dayStats.slice(-7) : dayStats;
  const sparks = useMemo(() => ({
    activity: dayStats.map((d) => d.total),
    raised:   dayStats.map((d) => d.raised),
    issued:   dayStats.map((d) => d.issued),
    returned: dayStats.map((d) => d.returned),
  }), [dayStats]);
  const peakIssued  = Math.max(...sparks.issued, 0);
  const avgReturnedRaw = sparks.returned.reduce((a, b) => a + b, 0) / 14;
  const avgReturned = avgReturnedRaw > 0 && avgReturnedRaw < 10 ? Math.round(avgReturnedRaw * 10) / 10 : Math.round(avgReturnedRaw);

  /* ================= KPI STATS ================= */
  const stats = useMemo(() => {
    const t0 = startOfToday().getTime();
    let out = 0, outStudents = 0, outStaff = 0, pending = 0, ready = 0,
        returnedToday = 0, issuedToday = 0, overdue = 0, expectedToday = 0,
        activityToday = 0, newToday = 0;
    passes.forEach((r) => {
      const act = activityTime(r);
      if (act >= t0) activityToday++;
      if (tsMs(r.printedAt || r.issuedAt) >= t0) issuedToday++;
      if (tsMs(r.returnedAt) >= t0) returnedToday++;
      switch (r.status) {
        case "ISSUED":
          out++;
          r.scope === "STAFF" ? outStaff++ : outStudents++;
          if (isTodayDate(r.expectedReturn)) expectedToday++;
          if (isOverdue(r)) overdue++;
          break;
        case "REQUESTED": pending++; if (act >= t0) newToday++; break;
        case "APPROVED":  ready++; break;
        default: break;
      }
    });
    return { total: passes.length, out, outStudents, outStaff, pending, ready,
             returnedToday, issuedToday, overdue, expectedToday, activityToday, newToday };
  }, [passes]);

  /* ================= STATUS DISTRIBUTION ================= */
  const statusDist = useMemo(() => {
    const order = ["REQUESTED", "APPROVED", "ISSUED", "RETURNED", "REJECTED", "CANCELLED"];
    const counts = {}; order.forEach((s) => (counts[s] = 0));
    passes.forEach((r) => { if (counts[r.status] != null) counts[r.status]++; });
    return order.map((s) => ({ id: s, count: counts[s] }));
  }, [passes]);

  /* ================= OUT ON PASS + ACTION QUEUE ================= */
  const retMs = (r) => { const d = parseLocal(r.expectedReturn); return d ? d.getTime() : Infinity; };
  const outList = useMemo(
    () => passes.filter((r) => r.status === "ISSUED").sort((a, b) => retMs(a) - retMs(b)),
    [passes]
  );
  const actionList = useMemo(
    () => passes.filter((r) => r.status === "REQUESTED" || r.status === "APPROVED")
                .sort((a, b) => activityTime(b) - activityTime(a)),
    [passes]
  );

  const outTodayN   = useMemo(() => outList.filter((r) => isTodayDate(r.expectedReturn)).length, [outList]);
  const outOverdueN = useMemo(() => outList.filter(isOverdue).length, [outList]);
  const outFiltered = useMemo(() => {
    if (outFilter === "today")   return outList.filter((r) => isTodayDate(r.expectedReturn));
    if (outFilter === "overdue") return outList.filter(isOverdue);
    return outList;
  }, [outList, outFilter]);
  const outShown    = showAllOut ? outFiltered : outFiltered.slice(0, OUT_LIMIT);
  const actionShown = actionList.slice(0, ACT_LIMIT);
  useEffect(() => { setShowAllOut(false); }, [outFilter]);

  /* ================= ACTIVITY FEED ================= */
  const feed = useMemo(() => {
    const evts = [];
    passes.forEach((r) => {
      const push = (tone, icon, verb, iso, note) => {
        const t = tsMs(iso);
        if (t) evts.push({ key: `${r._id}-${verb}`, tone, icon, verb, name: r.name, note: note || null, at: t, kind: r.kind, scope: r.scope });
      };
      push("amber",  "📝", "Request raised",     r.requestedAt || r.createdAt);
      push("blue",   "✓",  "Approved",           r.approvedAt, r.approvedBy ? `by ${r.approvedBy}` : null);
      push("green",  "🎫", "Pass issued",        r.printedAt || r.issuedAt, r.slipNo ? `slip ${r.slipNo}` : null);
      push("slate",  "↩",  "Returned · IN",      r.returnedAt);
      push("red",    "⛔", "Rejected",           r.rejectedAt, r.rejectionReason ? trunc(r.rejectionReason, 42) : null);
      push("gray",   "⊘",  "Cancelled",          r.cancelledAt);
    });
    evts.sort((a, b) => b.at - a.at);
    return evts.slice(0, FEED_LIMIT);
  }, [passes]);

  /* ================= LIVE SOURCES ================= */
  const srcRows = useMemo(() => Object.entries(SRC_SHORT).map(([id, label]) => ({
    id, label, scope: COLLECTIONS[id].scope, count: (data[id] || []).length, live: !!ready[id],
  })), [data, ready]);

  /* ================= STAT CARDS ================= */
  const statCards = [    
    { icon: "🚶", tone: "green", label: "Out on pass",       value: stats.out,            note: `${stats.expectedToday} expected back today`,   split: { a: stats.outStudents, b: stats.outStaff } },
    { icon: "⏳", tone: "amber", label: "Pending approvals", value: stats.pending,        note: `+${stats.newToday} raised today`,              spark: sparks.raised },
    { icon: "⚠️", tone: "red",   label: "Overdue",           value: stats.overdue,        note: stats.overdue > 0 ? "⚠ attention needed now" : "✓ all passes on time", alert: stats.overdue > 0 },
    { icon: "🎫", tone: "blue",  label: "Issued today",      value: stats.issuedToday,    note: `peak ${peakIssued}/day · 14 d`,                spark: sparks.issued },
  ];

  const outTs = (r) => r.outAt || r.printedAt || r.issuedAt || r.createdAt;

  /* ================= PRINT — A4 summary sheet ================= */
  const printSummary = () => {
    if (!passes.length) { showToast("No data to print yet — the live sync hasn't delivered any records.", "error"); return; }

    const boxes = [
      ["Total records", passes.length], ["Out on pass", stats.out], ["Pending", stats.pending],
      ["Overdue", stats.overdue], ["Issued today", stats.issuedToday], ["Returned today", stats.returnedToday],
    ].map(([k, v]) => `<div class="bx"><span class="bx-n">${v}</span><span class="bx-l">${esc(k)}</span></div>`).join("");

    const outRows = outList.map((r, i) => {
      const flag = isOverdue(r) ? '<td class="f-bad">OVERDUE</td>'
                : isTodayDate(r.expectedReturn) ? '<td class="f-ok">Due today</td>' : "<td></td>";
      return `<tr><td class="n">${i + 1}</td><td class="nm">${esc(r.name)}</td><td>${esc(r.group)}</td><td>${esc(KIND_META[r.kind] || r.kind)}</td><td>${esc(fmtStamp(outTs(r)))}</td><td>${esc(fmtExpected(r.expectedReturn))}</td>${flag}</tr>`;
    }).join("") || `<tr><td colspan="7" class="none">Nobody is out on pass right now.</td></tr>`;

    const actRows = actionList.map((r, i) =>
      `<tr><td class="n">${i + 1}</td><td class="nm">${esc(r.name)}</td><td>${esc(r.group)}</td><td>${esc(KIND_META[r.kind] || r.kind)}</td><td class="rs">${esc(trunc(r.reason || "—", 80))}</td><td>${esc(fmtStamp(r.requestedAt || r.createdAt))}</td><td>${esc((STATUS_META[r.status] || {}).label || r.status)}</td></tr>`
    ).join("") || `<tr><td colspan="7" class="none">Queue is empty — nothing awaiting action.</td></tr>`;

    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Dashboard summary</title><style>` +
      `@page{size:A4;margin:14mm}html,body{margin:0;padding:0}` +
      `body{font-family:"Segoe UI",Arial,sans-serif;color:#141710}` +
      `.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2.5px solid #6f9a00;padding-bottom:8px;margin-bottom:12px}` +
      `h1{font-size:17px;margin:0;color:#2e3520}.stamp{font-size:11px;color:#444;text-align:right;line-height:1.5}` +
      `.statrow{display:flex;gap:6px;margin-bottom:14px}` +
      `.bx{flex:1;border:1px solid #dfe4c8;border-radius:6px;padding:6px 8px;text-align:center;background:#fafbf4}` +
      `.bx-n{display:block;font-size:16px;font-weight:800;color:#4c6b00}.bx-l{display:block;font-size:8.5px;text-transform:uppercase;letter-spacing:.5px;color:#7a8164}` +
      `h2{font-size:12px;margin:0 0 8px;color:#2e3520;text-transform:uppercase;letter-spacing:.6px}` +
      `table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px}` +
      `th{background:#2e3520;color:#fffeef;padding:6px 8px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.5px}` +
      `td{border:1px solid #dfe4c8;padding:6px 8px;vertical-align:top}` +
      `tr:nth-child(even) td{background:#f7f9ee}` +
      `.n{text-align:right;color:#888;width:16px}.nm{font-weight:700}.rs{max-width:170px}` +
      `.f-bad{color:#c02626;font-weight:800}.f-ok{color:#4c6b00;font-weight:700}.none{text-align:center;color:#888;font-style:italic;padding:14px}` +
      `.foot{margin-top:10px;font-size:10px;color:#777;text-align:center}` +
      `</style></head><body>` +
      `<div class="head"><h1>DPIRS PassPort — Dashboard summary</h1><span class="stamp">Printed ${esc(new Date().toLocaleString())}<br/>${passes.length} records · live snapshot</span></div>` +
      `<div class="statrow">${boxes}</div>` +
      `<h2>Out on pass now — ${outList.length}</h2>` +
      `<table><thead><tr><th class="n">#</th><th>Name</th><th>Class / Dept</th><th>Type</th><th>Out since</th><th>Expected return</th><th>Flag</th></tr></thead><tbody>${outRows}</tbody></table>` +
      `<h2>Awaiting action — ${actionList.length}</h2>` +
      `<table><thead><tr><th class="n">#</th><th>Name</th><th>Class / Dept</th><th>Type</th><th>Reason</th><th>Raised</th><th>Status</th></tr></thead><tbody>${actRows}</tbody></table>` +
      `<div class="foot">— DPIRS PassPort · dashboard snapshot · read-only —</div>` +
      `</body></html>`;

    printHtml(html);
    showToast("🖨 Printing the dashboard summary…");
  };

  /* ================= EXPORT — Excel snapshot (.xls) ================= */
  const exportSnapshot = () => {
    if (!passes.length) { showToast("Nothing to export yet — no records have synced.", "error"); return; }

    const NC = 7;
    const outRows = outList.map((r, i) =>
      "<tr>" + [i + 1, r.name, r.group, KIND_META[r.kind] || r.kind, fmtStamp(outTs(r)), fmtExpected(r.expectedReturn),
        isOverdue(r) ? "OVERDUE" : isTodayDate(r.expectedReturn) ? "Due today" : ""]
        .map((c) => `<td>${esc(c)}</td>`).join("") + "</tr>"
    ).join("");
    const actRows = actionList.map((r, i) =>
      "<tr>" + [i + 1, r.name, r.group, KIND_META[r.kind] || r.kind, trunc(r.reason || "—", 90),
        fmtStamp(r.requestedAt || r.createdAt), (STATUS_META[r.status] || {}).label || r.status]
        .map((c) => `<td>${esc(c)}</td>`).join("") + "</tr>"
    ).join("");

    const metaLine = `Generated ${new Date().toLocaleString()} · live snapshot · ${community.students} students / ${community.staff} staff in directory`;
    const statLine = `Total ${passes.length} · Out ${stats.out} · Pending ${stats.pending} · Ready ${stats.ready} · Overdue ${stats.overdue} · Issued today ${stats.issuedToday} · Returned today ${stats.returnedToday}`;

    const html =
      `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
      `<head><meta charset="UTF-8" />` +
      `<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Dashboard</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->` +
      `<style>td,th{mso-number-format:"\\@";border:1px solid #c9cfb6;padding:5px 8px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;vertical-align:top;text-align:left}` +
      `th{background:#2e3520;color:#fffeef;font-weight:700}` +
      `.t{background:#2e3520;color:#fffeef;font-size:14px;font-weight:800;text-align:center}` +
      `.h{background:#3a4226;color:#fffeef;font-weight:800;text-align:left}` +
      `.m{color:#4a5138;font-size:10px;text-align:center}` +
      `</style></head><body><table>` +
      `<tr><td class="t" colspan="${NC}">DPIRS PassPort — Dashboard snapshot</td></tr>` +
      `<tr><td class="m" colspan="${NC}">${esc(metaLine)}</td></tr>` +
      `<tr><td class="m" colspan="${NC}">${esc(statLine)}</td></tr>` +
      `<tr><td colspan="${NC}"></td></tr>` +
      `<tr><td class="h" colspan="${NC}">Out on pass now — ${outList.length}</td></tr>` +
      `<tr>${["#", "Name", "Class / Dept", "Type", "Out since", "Expected return", "Flag"].map((h) => `<th>${esc(h)}</th>`).join("")}</tr>` +
      (outRows || `<tr><td colspan="${NC}">Nobody is out on pass right now.</td></tr>`) +
      `<tr><td colspan="${NC}"></td></tr>` +
      `<tr><td class="h" colspan="${NC}">Awaiting action — ${actionList.length}</td></tr>` +
      `<tr>${["#", "Name", "Class / Dept", "Type", "Reason", "Raised", "Status"].map((h) => `<th>${esc(h)}</th>`).join("")}</tr>` +
      (actRows || `<tr><td colspan="${NC}">Queue is empty.</td></tr>`) +
      `</table></body></html>`;

    const blob = new Blob(["\uFEFF" + html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dashboard-snapshot-${todayStr()}.xls`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(`✓ Snapshot exported — ${passes.length} records, out-now + action queue`);
  };

  /* ================= RENDER ================= */
  const dateLabel = clock.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const clockLabel = clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className="db-page">
      <div className="db-wrap">

        {/* ============ HEADER ============ */}
        <header className="db-header">
          <div className="db-heading">
            
          </div>
          
        </header>

        {loading ? (
          <div className="db-skelhero" />
        ) : (
          /* ============ HERO — CAMPUS PULSE ============ */
          <section className="db-hero">
            <svg className="db-hero-pulse" viewBox="0 0 600 60" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 30 H55 L70 30 L82 10 L96 50 L108 30 H170 L184 30 L196 14 L210 46 L222 30 H285 L299 30 L311 8 L327 52 L339 30 H400 L414 30 L426 16 L440 44 L452 30 H515 L529 30 L541 12 L555 48 L567 30 H600" />
            </svg>

            <div className="db-hero-main">
              <span className="db-hero-eyebrow"><span className="db-live-dot" /> live overview · {dateLabel}</span>
              <h2 className="db-hero-big">
                <CountUp value={stats.out} className="db-hero-num" />
                <span className="db-hero-rest">{stats.out === 1 ? "person is" : "people are"} out on pass right now</span>
              </h2>
              <p className="db-hero-sub">
                {stats.outStudents} student{stats.outStudents === 1 ? "" : "s"} · {stats.outStaff} staff · {stats.expectedToday} expected back today
              </p>
              {stats.overdue > 0 && (
                <div className="db-hero-alert">⚠ {stats.overdue} overdue — attention needed</div>
              )}
            </div>

            <div className="db-hero-metrics">
              <div className="db-hero-tile">
                <span className="db-hero-tile-v db-t-amber"><CountUp value={stats.pending} /></span>
                <span className="db-hero-tile-l">⏳ Awaiting approval</span>
              </div>
              <div className="db-hero-tile">
                <span className="db-hero-tile-v db-t-lime"><CountUp value={stats.issuedToday} /></span>
                <span className="db-hero-tile-l">🎫 Issued today</span>
              </div>
              <div className="db-hero-tile">
                <span className="db-hero-tile-v db-t-slate"><CountUp value={stats.returnedToday} /></span>
                <span className="db-hero-tile-l">↩ Returned today</span>
              </div>
            </div>

            <div className="db-hero-side">
              <div className="db-live">
                <span className={`db-live-dot${syncError ? " db-live-dot-error" : ""}`} />
                <span className="db-live-text">{syncError ? "sync issue" : "live"}</span>
                <span className="db-live-sep">·</span>
                <span className="db-clock">{clockLabel}</span>
              </div>
              <span className="db-hero-ro">auto-syncing · read-only</span>
            </div>
          </section>
        )}

        {/* ============ STATS ============ */}
        {loading ? (
          <div className="db-stats">
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="db-skelstat" />)}
          </div>
        ) : (
          <div className="db-stats">
            {statCards.map((c) => (
              <div key={c.label} className={`db-stat db-stat-${c.tone}${c.alert ? " db-stat-alert" : ""}`}>
                <div className="db-stat-head">
                  <span className="db-stat-icon">{c.icon}</span>
                  <div className="db-stat-nums">
                    <span className="db-stat-value"><CountUp value={c.value} /></span>
                    <span className="db-stat-label">{c.label}</span>
                  </div>
                </div>
                <div className="db-stat-foot">
                  <span className={`db-stat-note${c.alert ? " db-stat-note-bad" : ""}${!c.alert && c.tone === "red" ? " db-stat-note-ok" : ""}`}>{c.note}</span>
                  {c.spark ? <Spark data={c.spark} tone={c.tone} /> : null}
                  {c.split ? <SplitBar a={c.split.a} b={c.split.b} /> : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ============ CHARTS ============ */}
        {loading ? (
          <div className="db-charts">
            <div className="db-skelcard db-skelchart" />
            <div className="db-skelcard db-skeldonut" />
          </div>
        ) : (
          <div className="db-charts">
            <ActivityChart days={days} mode={chartMode} onMode={setChartMode} />

            <section className="db-card db-donutcard">
              <div className="db-card-head">
                <div>
                  <h3 className="db-card-title">🎯 Status distribution</h3>
                  <p className="db-card-sub">every pass record by current state</p>
                </div>
              </div>
              <div className="db-donutbody">
                <StatusDonut dist={statusDist} total={passes.length} active={activeStatus} onHover={setActiveStatus} on={donutOn} />
                <ul className="db-legend">
                  {statusDist.map((s) => (
                    <li
                      key={s.id}
                      className={`db-leg-row${activeStatus === s.id ? " db-leg-row-on" : ""}`}
                      onMouseEnter={() => setActiveStatus(s.id)}
                      onMouseLeave={() => setActiveStatus(null)}
                    >
                      <span className="db-leg-dot" style={{ background: DONUT_COLORS[s.id] }} />
                      <span className="db-leg-label">{(STATUS_META[s.id] || {}).icon} {(STATUS_META[s.id] || {}).label || s.id}</span>
                      <span className="db-leg-count">{s.count.toLocaleString()}</span>
                      <span className="db-leg-pct">{passes.length ? Math.round((s.count / passes.length) * 100) : 0}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          </div>
        )}

        {/* ============ OUT NOW + ACTION QUEUE ============ */}
        {loading ? (
          <div className="db-lists">
            <div className="db-skelcard db-skellist" />
            <div className="db-skelcard db-skellist2" />
          </div>
        ) : (
          <div className="db-lists">
            <section className="db-card db-outcard">
              <div className="db-card-head">
                <div>
                  <h3 className="db-card-title">🚶 Out on pass — live <span className="db-count-badge">{outList.length}</span></h3>
                  <p className="db-card-sub">ordered by expected return · overdue first</p>
                </div>
                <div className="db-chips">
                  <button type="button" className={`db-chip${outFilter === "all" ? " db-chip-on" : ""}`} onClick={() => setOutFilter("all")}>
                    All <span className="db-chip-n">{outList.length}</span>
                  </button>
                  <button type="button" className={`db-chip${outFilter === "today" ? " db-chip-on" : ""}`} onClick={() => setOutFilter("today")}>
                    Due today <span className="db-chip-n">{outTodayN}</span>
                  </button>
                  <button type="button" className={`db-chip${outFilter === "overdue" ? " db-chip-on" : ""}`} onClick={() => setOutFilter("overdue")}>
                    Overdue <span className="db-chip-n">{outOverdueN}</span>
                  </button>
                </div>
              </div>

              {outShown.length ? (
                <div className="db-tablewrap">
                  <table className="db-table">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th className="db-hide-sm">Type</th>
                        <th>Out since</th>
                        <th>Expected return</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outShown.map((r) => (
                        <tr key={r._id} className={isOverdue(r) ? "db-row-overdue" : undefined}>
                          <td>
                            <div className="db-user">
                              <span className="db-avatar" style={{ background: avatarGradient(r.name) }}>{getInitials(r.name)}</span>
                              <div className="db-user-text">
                                <span className="db-user-name">{r.name}</span>
                                <span className="db-user-sub">{r.group}</span>
                              </div>
                            </div>
                          </td>
                          <td className="db-hide-sm">
                            <span className={`db-type db-type-${kindCls(r.kind)}`}>{KIND_META[r.kind] || r.kind}</span>
                          </td>
                          <td>{timeAgo(outTs(r))}</td>
                          <td>
                            {fmtExpected(r.expectedReturn)}
                            {isOverdue(r) && <span className="db-tag db-tag-overdue">overdue</span>}
                            {!isOverdue(r) && isTodayDate(r.expectedReturn) && <span className="db-tag db-tag-today">today</span>}
                            {!r.expectedReturn && <span className="db-tag db-tag-none">not set</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="db-empty">
                  <div className="db-empty-icon">✓</div>
                  <h3>{outFilter === "all" ? "Everyone is back" : outFilter === "overdue" ? "No overdue passes" : "Nothing due today"}</h3>
                  <p>{outFilter === "all" ? "No passes are currently out — the campus is fully checked in." : "Nothing matches this filter right now."}</p>
                </div>
              )}

              {outFiltered.length > OUT_LIMIT && (
                <div className="db-more">
                  <button type="button" onClick={() => setShowAllOut((v) => !v)}>
                    {showAllOut ? "Show less" : `Show all ${outFiltered.length}`}
                  </button>
                </div>
              )}
            </section>

            <section className="db-card db-actcard">
              <div className="db-card-head">
                <div>
                  <h3 className="db-card-title">⏳ Awaiting action <span className="db-count-badge db-count-amber">{actionList.length}</span></h3>
                  <p className="db-card-sub">requests to approve · passes ready to issue</p>
                </div>
                <span className="db-act-legend">{stats.pending} pending · {stats.ready} ready</span>
              </div>

              {actionShown.length ? (
                <ul className="db-acts">
                  {actionShown.map((r) => (
                    <li key={r._id} className="db-act">
                      <span className="db-avatar db-avatar-sm" style={{ background: avatarGradient(r.name) }}>{getInitials(r.name)}</span>
                      <div className="db-act-info">
                        <span className="db-act-name">{r.name}<span className="db-act-group">{r.group}</span></span>
                        <span className="db-act-reason">{r.reason ? `“${trunc(r.reason, 52)}”` : "No reason recorded"}</span>
                        <span className="db-act-meta">raised {timeAgo(r.requestedAt || r.createdAt)} · {KIND_META[r.kind] || r.kind}</span>
                      </div>
                      {r.status === "REQUESTED"
                        ? <span className="db-badge db-badge-amber">⏳ Pending</span>
                        : <span className="db-badge db-badge-blue">✓ Ready</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="db-empty">
                  <div className="db-empty-icon">✓</div>
                  <h3>Queue is clear</h3>
                  <p>No requests are waiting — inbox zero across students and staff.</p>
                </div>
              )}

              {actionList.length > ACT_LIMIT && (
                <div className="db-act-foot">
                  <span>{actionList.length} in queue</span>
                  <span>review in the requests console</span>
                </div>
              )}
            </section>
          </div>
        )}

        {/* ============ FEED + SOURCES ============ */}
        {loading ? (
          <div className="db-bottom">
            <div className="db-skelcard db-skelfeed" />
            <div className="db-skelcard db-skelsrc" />
          </div>
        ) : (
          <div className="db-bottom">
            <section className="db-card db-feedcard">
              <div className="db-card-head">
                <div>
                  <h3 className="db-card-title">📡 Latest activity</h3>
                  <p className="db-card-sub">every event, newest first — across all collections</p>
                </div>
              </div>
              {feed.length ? (
                <ul className="db-feed">
                  {feed.map((e, i) => (
                    <li key={e.key} className="db-feed-row" style={{ animationDelay: `${(0.88 + i * 0.045).toFixed(2)}s` }}>
                      <span className={`db-feed-ic db-ic-${e.tone}`}>{e.icon}</span>
                      <div className="db-feed-body">
                        <span className="db-feed-text">
                          <strong>{e.verb}</strong> — {e.name}{e.note ? <em> · {e.note}</em> : null}
                        </span>
                        <span className="db-feed-meta">{KIND_META[e.kind] || e.kind} · {e.scope === "STAFF" ? "staff" : "student"}</span>
                      </div>
                      <span className="db-feed-time">{timeAgo(e.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="db-empty">
                  <div className="db-empty-icon">📡</div>
                  <h3>No activity yet</h3>
                  <p>Events will appear here the moment anything happens in any collection.</p>
                </div>
              )}
            </section>

            <section className="db-card db-srccard">
              <div className="db-card-head">
                <div>
                  <h3 className="db-card-title">🔌 Live sources</h3>
                  <p className="db-card-sub">Firebase real-time stream · read-only</p>
                </div>
                <span className="db-src-sync">{syncError ? "⚠ error" : `${readyCount}/10 synced`}</span>
              </div>
              <div className="db-srcbody">
                <div className="db-community">
                  <div className="db-comm"><span className="db-comm-n"><CountUp value={community.students} /></span><span className="db-comm-l">students</span></div>
                  <div className="db-comm"><span className="db-comm-n"><CountUp value={community.staff} /></span><span className="db-comm-l">staff</span></div>
                  <div className="db-comm"><span className="db-comm-n"><CountUp value={passes.length} /></span><span className="db-comm-l">pass records</span></div>
                </div>
                <ul className="db-srcs">
                  {srcRows.map((s) => (
                    <li key={s.id}>
                      <span className={`db-src-dot${s.live ? "" : " db-src-dot-wait"}`} />
                      <span className="db-src-label">{s.label}</span>
                      <span className={`db-src-scope${s.scope === "STAFF" ? " db-src-scope-stf" : " db-src-scope-stu"}`}>{s.scope === "STAFF" ? "STF" : "STU"}</span>
                      <span className="db-src-count">{s.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
                {syncError && <div className="db-syncerr">⚠ {syncError}</div>}
              </div>
            </section>
          </div>
        )}
        

      </div>
      

      {/* toast */}
      {toast && (
        <div key={toast.id} className={`db-toast db-toast-${toast.type}`} role="status" aria-live="polite">
          <span className="db-toast-dot" />
          {toast.text}
        </div>
      )}
    </div>
  );
}