import React, { useState, useEffect, useMemo, useRef } from "react";
import { ref, onValue } from "firebase/database";
import { database } from "../../../firebase/config"; // ← same config the other pages use — adjust the depth if this file sits elsewhere
import "./principaldashboard.css";

/* =====================================================================
   PRINCIPAL DASHBOARD — DPIRS PassPort
   ---------------------------------------------------------------------
   • 100% READ-ONLY, fully LIVE — identical data engine to the main
     dashboard (ten Firebase streams merged + de-duplicated).
   • ORDER: HERO (campus pulse) → 4 KPI boxes → LATEST PASSES (newest
     on top — NOT overdue / return-date based) → MOVEMENT ACTIVITY →
     STATUS DISTRIBUTION → LIVE SOURCES. That's all — nothing extra.
   • Mobile-first: the ticking clock is isolated so the page does NOT
     re-render every second; relative times refresh every 30s instead.
   • Table rows become touch-friendly stacked cards on phones, the
     donut + legend are tap-interactive, and the chart defaults to
     7 days on small screens.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DAY_MS = 86400000;
const LATEST_LIMIT = 8; // rows shown before "Show all"

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

/* ---------------- record normalization (same as main dashboard) ---------------- */
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

/* ---------------- ISOLATED live clock ----------------
   The seconds tick lives here alone — the whole page no longer
   re-renders every second. That is the single biggest smoothness
   win on phones.                                                    */
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="pd-clock">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
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
    <svg className="pd-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} className={`pd-spark-area pd-sa-${tone}`} />
      <path d={d} className={`pd-spark-line pd-sl-${tone}`} pathLength="1" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.4" className={`pd-spark-dot pd-sd-${tone}`} />
    </svg>
  );
}

/* ---------------- students / staff split bar ---------------- */
function SplitBar({ a, b }) {
  const total = a + b || 1;
  return (
    <div className="pd-split">
      <div className="pd-split-bar">
        <span className="pd-split-a" style={{ width: `${(a / total) * 100}%` }} />
        <span className="pd-split-b" style={{ width: `${(b / total) * 100}%` }} />
      </div>
      <span className="pd-split-note">{a} students · {b} staff</span>
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
    <section className="pd-card pd-chartcard">
      <div className="pd-card-head">
        <div>
          <h3 className="pd-card-title">📈 Movement activity</h3>
          <p className="pd-card-sub">issued · raised · returned · closed — per day</p>
        </div>
        <div className="pd-chart-tools">
          <span className="pd-peak">peak <b>{peak.total}</b> · {peak.label}</span>
          <div className="pd-toggle">
            <button type="button" className={mode === 7 ? "pd-tog-on" : ""} onClick={() => onMode(7)}>7 d</button>
            <button type="button" className={mode === 14 ? "pd-tog-on" : ""} onClick={() => onMode(14)}>14 d</button>
          </div>
        </div>
      </div>
      <div className="pd-chart">
        <div className="pd-chartarea">
          {avg > 0 && (
            <div className="pd-avgline" style={{ bottom: `${(avg / max) * 100}%` }}>
              <span className="pd-avgchip">avg {avgLabel}</span>
            </div>
          )}
          {days.map((d, i) => (
            <div key={d.key} className={`pd-barcol${i === 0 ? " pd-edge-l" : ""}${i === days.length - 1 ? " pd-edge-r" : ""}`}>
              <div className="pd-bartip">
                <span className="pd-bartip-date">{d.label}{d.isToday ? " · today" : ""}</span>
                <span className="pd-bartip-n">{d.total} movement{d.total === 1 ? "" : "s"}</span>
                <span className="pd-bartip-brk">🎫 {d.issued} issued · ⏳ {d.raised} raised</span>
                <span className="pd-bartip-brk">↩ {d.returned} returned · ⛔ {d.closed} closed</span>
              </div>
              {d.total > 0 ? (
                <div
                  className={`pd-barstack${d.isToday ? " pd-barstack-today" : ""}`}
                  style={{ height: `${Math.max((d.total / max) * 100, 4)}%`, animationDelay: `${(0.70 + i * 0.045).toFixed(2)}s` }}
                >
                  {d.issued   > 0 && <span className="pd-seg pd-seg-issued"   style={{ height: `${(d.issued   / d.total) * 100}%` }} />}
                  {d.raised   > 0 && <span className="pd-seg pd-seg-raised"   style={{ height: `${(d.raised   / d.total) * 100}%` }} />}
                  {d.returned > 0 && <span className="pd-seg pd-seg-returned" style={{ height: `${(d.returned / d.total) * 100}%` }} />}
                  {d.closed   > 0 && <span className="pd-seg pd-seg-closed"   style={{ height: `${(d.closed   / d.total) * 100}%` }} />}
                </div>
              ) : (
                <div className="pd-barzero" />
              )}
              {d.total > 0 && <span className="pd-bar-n" style={{ bottom: `calc(${Math.max((d.total / max) * 100, 4)}% + 6px)` }}>{d.total}</span>}
            </div>
          ))}
        </div>
        <div className="pd-barlabels">
          {days.map((d) => (
            <div key={d.key} className={`pd-barlab${d.isToday ? " pd-barlab-today" : ""}`}>
              <span className="pd-barlab-dow">{d.dow}</span>
              <span className="pd-barlab-day">{d.day}</span>
            </div>
          ))}
        </div>
        <div className="pd-chartlegend">
          <span className="pd-cl"><i style={{ background: "#a4dd00" }} /> issued</span>
          <span className="pd-cl"><i style={{ background: "#ffd27a" }} /> raised</span>
          <span className="pd-cl"><i style={{ background: "#9cc8ff" }} /> returned</span>
          <span className="pd-cl"><i style={{ background: "#ff9d9d" }} /> closed</span>
        </div>
      </div>
    </section>
  );
}

/* ---------------- animated interactive donut (hover + TAP) ---------------- */
function StatusDonut({ dist, total, active, onHover, onSelect, on, canHover }) {
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
    <div className={`pd-donutwrap${on ? " pd-donut-on" : ""}`}>
      <svg viewBox="0 0 180 180" className="pd-donut" role="img" aria-label="Status distribution of all records">
        <circle cx="90" cy="90" r={R} className="pd-donut-track" />
        <g transform="rotate(-90 90 90)">
          {segs.map((s) => (
            <circle
              key={s.id}
              cx="90" cy="90" r={R}
              className={`pd-donut-seg${active && active !== s.id ? " pd-seg-dim" : ""}`}
              transform={`rotate(${s.rot} 90 90)`}
              style={{ stroke: DONUT_COLORS[s.id], "--seg": `${s.len}px`, "--rest": `${C - s.len}px`, "--d": `${(0.15 + s.i * 0.09).toFixed(2)}s` }}
              onMouseEnter={canHover ? () => onHover(s.id) : undefined}
              onMouseLeave={canHover ? () => onHover(null) : undefined}
              onClick={() => onSelect(s.id)}
            />
          ))}
        </g>
      </svg>
      <div className="pd-donut-center">
        <span className="pd-donut-n">{activeSeg ? activeSeg.count.toLocaleString() : <CountUp value={total} />}</span>
        <span className="pd-donut-l">{activeSeg ? (STATUS_META[activeSeg.id] || {}).label || activeSeg.id : "total records"}</span>
      </div>
    </div>
  );
}

/* ===================================================================== */

export default function PrincipalDashboard() {
  /* ================= LIVE DATA ================= */
  const [data, setData]           = useState({});
  const [ready, setReady]         = useState({});
  const [syncError, setSyncError] = useState("");

  /* ================= UI STATE ================= */
  /* phones start on the lighter 7-day chart */
  const [chartMode, setChartMode] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches ? 7 : 14
  );
  const [showAllLatest, setShowAllLatest] = useState(false);
  const [activeStatus, setActiveStatus]   = useState(null);
  const [donutOn, setDonutOn]             = useState(false);

  /* gentle 30s heartbeat — keeps "x min ago" labels fresh without
     re-rendering the whole page every second                    */
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 30000);
    return () => clearInterval(t);
  }, []);

  /* real pointers get hover; touch gets tap-to-toggle */
  const canHover = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches,
    []
  );

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
    raised:   dayStats.map((d) => d.raised),
    issued:   dayStats.map((d) => d.issued),
  }), [dayStats]);
  const peakIssued = Math.max(...sparks.issued, 0);

  /* ================= KPI STATS ================= */
  const stats = useMemo(() => {
    const t0 = startOfToday().getTime();
    let out = 0, outStudents = 0, outStaff = 0, pending = 0,
        returnedToday = 0, issuedToday = 0, overdue = 0, expectedToday = 0, newToday = 0;
    passes.forEach((r) => {
      const act = activityTime(r);
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
        default: break;
      }
    });
    return { total: passes.length, out, outStudents, outStaff, pending,
             returnedToday, issuedToday, overdue, expectedToday, newToday };
  }, [passes]);

  /* ================= STATUS DISTRIBUTION ================= */
  const statusDist = useMemo(() => {
    const order = ["REQUESTED", "APPROVED", "ISSUED", "RETURNED", "REJECTED", "CANCELLED"];
    const counts = {}; order.forEach((s) => (counts[s] = 0));
    passes.forEach((r) => { if (counts[r.status] != null) counts[r.status]++; });
    return order.map((s) => ({ id: s, count: counts[s] }));
  }, [passes]);

  /* ================= LATEST PASSES — newest on top =================
     Same live card design as "Out on pass", but ordered purely by the
     most recent activity — NOT by overdue / expected-return date.     */
  const latestList = useMemo(
    () => passes
      .map((r) => ({ ...r, _at: activityTime(r) }))   /* precompute once — cheap renders */
      .sort((a, b) => b._at - a._at),
    [passes]
  );
  const latestShown = showAllLatest ? latestList : latestList.slice(0, LATEST_LIMIT);

  /* ================= LIVE SOURCES ================= */
  const srcRows = useMemo(() => Object.entries(SRC_SHORT).map(([id, label]) => ({
    id, label, scope: COLLECTIONS[id].scope, count: (data[id] || []).length, live: !!ready[id],
  })), [data, ready]);

  /* ================= STAT CARDS (the 4 boxes — unchanged) ================= */
  const statCards = [
    { icon: "🚶", tone: "green", label: "Out on pass",       value: stats.out,         note: `${stats.expectedToday} expected back today`,   split: { a: stats.outStudents, b: stats.outStaff } },
    { icon: "⏳", tone: "amber", label: "Pending approvals", value: stats.pending,     note: `+${stats.newToday} raised today`,              spark: sparks.raised },
    { icon: "⚠️", tone: "red",   label: "Overdue",           value: stats.overdue,     note: stats.overdue > 0 ? "⚠ attention needed now" : "✓ all passes on time", alert: stats.overdue > 0 },
    { icon: "🎫", tone: "blue",  label: "Issued today",      value: stats.issuedToday, note: `peak ${peakIssued}/day · 14 d`,                spark: sparks.issued },
  ];

  /* ================= RENDER ================= */
  const dateLabel = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="pd-page">
      <div className="pd-wrap">

        {loading ? (
          <>
            <div className="pd-skelhero" />
            <div className="pd-stats">
              {[0, 1, 2, 3].map((i) => <div key={i} className="pd-skelstat" />)}
            </div>
            <div className="pd-skelcard pd-skellist" />
            <div className="pd-charts">
              <div className="pd-skelcard pd-skelchart" />
              <div className="pd-skelcard pd-skeldonut" />
            </div>
            <div className="pd-skelcard pd-skelsrc" />
          </>
        ) : (
          <>

            {/* ============ HERO — CAMPUS PULSE (unchanged) ============ */}
            <section className="pd-hero">
              <svg className="pd-hero-pulse" viewBox="0 0 600 60" preserveAspectRatio="none" aria-hidden="true">
                <path d="M0 30 H55 L70 30 L82 10 L96 50 L108 30 H170 L184 30 L196 14 L210 46 L222 30 H285 L299 30 L311 8 L327 52 L339 30 H400 L414 30 L426 16 L440 44 L452 30 H515 L529 30 L541 12 L555 48 L567 30 H600" />
              </svg>

              <div className="pd-hero-main">
                <span className="pd-hero-eyebrow"><span className="pd-live-dot" /> live overview · {dateLabel}</span>
                <h2 className="pd-hero-big">
                  <CountUp value={stats.out} className="pd-hero-num" />
                  <span className="pd-hero-rest">{stats.out === 1 ? "person is" : "people are"} out on pass right now</span>
                </h2>
                <p className="pd-hero-sub">
                  {stats.outStudents} student{stats.outStudents === 1 ? "" : "s"} · {stats.outStaff} staff · {stats.expectedToday} expected back today
                </p>
                {stats.overdue > 0 && (
                  <div className="pd-hero-alert">⚠ {stats.overdue} overdue — attention needed</div>
                )}
              </div>

              <div className="pd-hero-metrics">
                <div className="pd-hero-tile">
                  <span className="pd-hero-tile-v pd-t-amber"><CountUp value={stats.pending} /></span>
                  <span className="pd-hero-tile-l">⏳ Awaiting approval</span>
                </div>
                <div className="pd-hero-tile">
                  <span className="pd-hero-tile-v pd-t-lime"><CountUp value={stats.issuedToday} /></span>
                  <span className="pd-hero-tile-l">🎫 Issued today</span>
                </div>
                <div className="pd-hero-tile">
                  <span className="pd-hero-tile-v pd-t-slate"><CountUp value={stats.returnedToday} /></span>
                  <span className="pd-hero-tile-l">↩ Returned today</span>
                </div>
              </div>

              <div className="pd-hero-side">
                <div className="pd-live">
                  <span className={`pd-live-dot${syncError ? " pd-live-dot-error" : ""}`} />
                  <span className="pd-live-text">{syncError ? "sync issue" : "live"}</span>
                  <span className="pd-live-sep">·</span>
                  <LiveClock />
                </div>
                <span className="pd-hero-ro">auto-syncing · read-only</span>
              </div>
            </section>

            {/* ============ 4 KPI BOXES (unchanged) ============ */}
            <div className="pd-stats">
              {statCards.map((c) => (
                <div key={c.label} className={`pd-stat pd-stat-${c.tone}${c.alert ? " pd-stat-alert" : ""}`}>
                  <div className="pd-stat-head">
                    <span className="pd-stat-icon">{c.icon}</span>
                    <div className="pd-stat-nums">
                      <span className="pd-stat-value"><CountUp value={c.value} /></span>
                      <span className="pd-stat-label">{c.label}</span>
                    </div>
                  </div>
                  <div className="pd-stat-foot">
                    <span className={`pd-stat-note${c.alert ? " pd-stat-note-bad" : ""}${!c.alert && c.tone === "red" ? " pd-stat-note-ok" : ""}`}>{c.note}</span>
                    {c.spark ? <Spark data={c.spark} tone={c.tone} /> : null}
                    {c.split ? <SplitBar a={c.split.a} b={c.split.b} /> : null}
                  </div>
                </div>
              ))}
            </div>

            {/* ============ LATEST PASSES — newest on top ============ */}
            <section className="pd-card pd-latest">
              <div className="pd-card-head">
                <div>
                  <h3 className="pd-card-title">🕒 Latest passes <span className="pd-count-badge">{latestList.length}</span></h3>
                  <p className="pd-card-sub">every pass as it happens · newest on top</p>
                </div>
              </div>

              {latestShown.length ? (
                <div className="pd-tablewrap">
                  <table className="pd-table">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th className="pd-hide-sm">Type</th>
                        <th>Status</th>
                        <th>Latest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {latestShown.map((r) => {
                        const meta = STATUS_META[r.status] || {};
                        return (
                          <tr key={r._id}>
                            <td className="pd-td-person">
                              <div className="pd-user">
                                <span className="pd-avatar" style={{ background: avatarGradient(r.name) }}>{getInitials(r.name)}</span>
                                <div className="pd-user-text">
                                  <span className="pd-user-name">{r.name}</span>
                                  <span className="pd-user-sub">
                                    {r.group}
                                    <span className="pd-only-sm"> · {KIND_META[r.kind] || r.kind}</span>
                                  </span>
                                </div>
                              </div>
                            </td>
                            <td className="pd-hide-sm">
                              <span className={`pd-type pd-type-${kindCls(r.kind)}`}>{KIND_META[r.kind] || r.kind}</span>
                            </td>
                            <td className="pd-td-status">
                              <span className={`pd-badge pd-badge-${meta.tone}`}>{meta.icon} {meta.label || r.status}</span>
                            </td>
                            <td className="pd-td-when">
                              <span className="pd-when-main">{timeAgo(r._at)}</span>
                              {r.status === "ISSUED" && r.expectedReturn ? (
                                <span className="pd-when-sub">back {fmtExpected(r.expectedReturn)}</span>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="pd-empty">
                  <div className="pd-empty-icon">✓</div>
                  <h3>No passes yet</h3>
                  <p>Nothing has synced just now — the newest passes will appear here the moment they happen.</p>
                </div>
              )}

              {latestList.length > LATEST_LIMIT && (
                <div className="pd-more">
                  <button type="button" onClick={() => setShowAllLatest((v) => !v)}>
                    {showAllLatest ? "Show less" : `Show all ${latestList.length}`}
                  </button>
                </div>
              )}
            </section>

            {/* ============ MOVEMENT ACTIVITY + STATUS DISTRIBUTION ============ */}
            <div className="pd-charts">
              <ActivityChart days={days} mode={chartMode} onMode={setChartMode} />

              <section className="pd-card pd-donutcard">
                <div className="pd-card-head">
                  <div>
                    <h3 className="pd-card-title">🎯 Status distribution</h3>
                    <p className="pd-card-sub">every pass record by current state</p>
                  </div>
                </div>
                <div className="pd-donutbody">
                  <StatusDonut
                    dist={statusDist}
                    total={passes.length}
                    active={activeStatus}
                    onHover={setActiveStatus}
                    onSelect={(id) => setActiveStatus((cur) => (cur === id ? null : id))}
                    on={donutOn}
                    canHover={canHover}
                  />
                  <ul className="pd-legend">
                    {statusDist.map((s) => (
                      <li
                        key={s.id}
                        className={`pd-leg-row${activeStatus === s.id ? " pd-leg-row-on" : ""}`}
                        onMouseEnter={canHover ? () => setActiveStatus(s.id) : undefined}
                        onMouseLeave={canHover ? () => setActiveStatus(null) : undefined}
                        onClick={() => setActiveStatus((cur) => (cur === s.id ? null : s.id))}
                      >
                        <span className="pd-leg-dot" style={{ background: DONUT_COLORS[s.id] }} />
                        <span className="pd-leg-label">{(STATUS_META[s.id] || {}).icon} {(STATUS_META[s.id] || {}).label || s.id}</span>
                        <span className="pd-leg-count">{s.count.toLocaleString()}</span>
                        <span className="pd-leg-pct">{passes.length ? Math.round((s.count / passes.length) * 100) : 0}%</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            </div>

            {/* ============ LIVE SOURCES ============ */}
            <section className="pd-card pd-srccard">
              <div className="pd-card-head">
                <div>
                  <h3 className="pd-card-title">📡 Live sources</h3>
                  <p className="pd-card-sub">every stream, health-checked in real time</p>
                </div>
                <span className="pd-src-sync">{readyCount}/{Object.keys(COLLECTIONS).length} synced</span>
              </div>
              <div className="pd-srcbody">
                <div className="pd-community">
                  <div className="pd-comm">
                    <span className="pd-comm-n">{community.students.toLocaleString()}</span>
                    <span className="pd-comm-l">students</span>
                  </div>
                  <div className="pd-comm">
                    <span className="pd-comm-n">{community.staff.toLocaleString()}</span>
                    <span className="pd-comm-l">staff</span>
                  </div>
                  <div className="pd-comm">
                    <span className="pd-comm-n"><CountUp value={passes.length} /></span>
                    <span className="pd-comm-l">pass records</span>
                  </div>
                </div>

                <ul className="pd-srcs">
                  {srcRows.map((s, i) => (
                    <li key={s.id} style={{ animationDelay: `${(0.78 + i * 0.04).toFixed(2)}s` }}>
                      <span className={`pd-src-dot${s.live ? "" : " pd-src-dot-wait"}`} />
                      <span className="pd-src-label">{s.label}</span>
                      <span className={`pd-src-scope ${s.scope === "STAFF" ? "pd-src-scope-stf" : "pd-src-scope-stu"}`}>
                        {s.scope === "STAFF" ? "STF" : "STU"}
                      </span>
                      <span className="pd-src-count">{s.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>

                {syncError && <div className="pd-syncerr">⚠ Sync issue — {syncError}</div>}
              </div>
            </section>

          </>
        )}
      </div>
    </div>
  );
}