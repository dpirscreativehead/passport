import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { ref, onValue, update } from "firebase/database";
import { database } from "../../../firebase/config"; // ← same config PassIssue uses — adjust the relative path if this component sits at a different depth
import "./RequestManage.css";

/* =====================================================================
   PRINCIPAL'S APPROVAL DESK — Day Pass Requests
   ---------------------------------------------------------------------
   • Live list of the day-pass requests raised at the gate desk (the
     "requested" Firebase node) — ONLY status "REQUESTED" is listed.
   • APPROVE → ONE atomic multi-path write:
       – the request is REMOVED from "requested"
       – the approved pass is MOVED to the NEW "daypass" collection
         (the gate desk reads that node, shows "approved · ready to
         print" and prints the slip)
       – the student's status flips REQUESTED → APPROVED
   • REJECT → ONE atomic multi-path write — NO reason is asked:
       – the request is REMOVED from "requested"
       – the record is MOVED to the NEW "rejectedStudentPass"
         collection and KEPT THERE PERMANENTLY as a record
         (rejectedAt + rejectedBy are stamped automatically)
       – the student's status is restored to IN — but only if the gate
         hadn't already moved them OUT / APPROVED in the meantime
   • Stats bar (all live):
       – Pending requests    → from "requested"
       – Approved today      → from "daypass"  (approvedAt = today)
       – Rejected today      → from "rejectedStudentPass" (rejectedAt = today)
       – Out on pass today   → from the STUDENTS TABLE: how many students
                               are OUT right now, counted only for those
                               whose last movement was TODAY
   • Live search, class filter, sorting, confirm modals with the full
     request details, toasts, loading skeletons and an empty state.
   • Everything syncs in real time from any tab or device.
   ===================================================================== */

/* ---------------- constants ----------------
   ⇩ If your Firebase nodes use different names, change them HERE only. */
const DB_STUDENTS_PATH = "students";             // student master data (status + lastMovement)
const DB_REQUEST_PATH  = "studentRequest";       // PENDING day-pass requests from the gate desk (gate desk writes here)            // pending day-pass requests from the gate desk
const DB_DAYPASS_PATH  = "daypass";              // NEW — approved day passes are moved here on approval
const DB_REJECTED_PATH = "rejectedStudentPass";  // NEW — rejected requests, kept permanently as a record

const SORT_OPTIONS = [  
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "return", label: "Return date" },
  { id: "name",   label: "Name (A–Z)" },
];

const LONG_WAIT_MS = 3 * 60 * 60 * 1000;   // waiting longer than 3 h → amber highlight

/* ---------------- small helpers ---------------- */
const normalizeRfid = (v) => String(v || "").trim().toUpperCase().replace(/[\s:\-]/g, "");

const getInitials = (name) =>
  String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("") || "?";

/* "2025-06-11" and "2025-06-11T14:30" → local Date (no UTC surprises) */
function parseLocal(v) {
  const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`;
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

function timeAgo(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
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

function isTodayIso(v) {
  if (!v) return false;
  const d = new Date(v);
  return !isNaN(d) && d.toDateString() === new Date().toDateString();
}

/* "Going with" — Parent needs no name · Guardian / Staff show their name */
function fmtGoingWith(p) {
  if (!p) return "—";
  const who = String(p.goingWith || "").trim();
  if (!who) return "—";
  const name = String(p.goingWithName || "").trim();
  return name ? `${who} · ${name}` : who;
}

/* deterministic avatar colour per student name */
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#6366f1,#8b5cf6)",
  "linear-gradient(135deg,#0ea5e9,#2563eb)",
  "linear-gradient(135deg,#10b981,#059669)",
  "linear-gradient(135deg,#f59e0b,#ea580c)",
  "linear-gradient(135deg,#ec4899,#db2777)",
  "linear-gradient(135deg,#14b8a6,#0d9488)",
  "linear-gradient(135deg,#f43f5e,#be123c)",
];
const avatarGradient = (name) =>
  AVATAR_GRADIENTS[Math.abs(String(name || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % AVATAR_GRADIENTS.length];

/* ---------------- Firebase nodes → clean data ---------------- */

/* "requested" node → array (all statuses — only REQUESTED is listed) */
function sanitizeRequests(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  return Object.entries(val)
    .map(([key, r]) => ({
      ...r,
      _id: String((r && r._id) || key),
      studentKey: String((r && r.studentKey) || ""),
      studentId: String((r && r.studentId) || "—"),
      rfid: normalizeRfid(r && r.rfid),
      name: String((r && r.name) || "Unknown student"),
      className: String((r && r.className) || "—"),
      status: String((r && r.status) || "REQUESTED").toUpperCase(),
      reason: String((r && r.reason) || "—"),
      expectedReturn: (r && r.expectedReturn) || null,
      createdAt: (r && r.createdAt) || null,
      requestedAt: (r && r.requestedAt) || (r && r.createdAt) || null,
    }))
    .filter((r) => r._id);
}

/* "daypass" / "rejectedStudentPass" nodes → array */
function sanitizePasses(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  return Object.entries(val)
    .map(([key, p]) => ({
      ...p,
      _id: String((p && p._id) || key),
      status: String((p && p.status) || "").toUpperCase(),
    }))
    .filter((p) => p && p._id);
}

/* "students" node → { <studentKey>: { status, lastMovement } } — the table
   the "Out on pass today" stat is counted from */
function sanitizeStudents(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return {};
  const map = {};
  Object.entries(val).forEach(([key, s]) => {
    if (s && typeof s === "object") {
      map[key] = {
        status: String(s.status || "IN").toUpperCase(),
        lastMovement: s.lastMovement || null,
      };
    }
  });
  return map;
}

/* ===================================================================== */

export default function RequestManage() {
  /* ================= LIVE DATA ================= */
  const [requests, setRequests]     = useState([]);   // "requested" node
  const [daypasses, setDaypasses]   = useState([]);   // "daypass" node — approved passes
  const [rejected, setRejected]     = useState([]);   // "rejectedStudentPass" node — records
  const [studentsMap, setStudentsMap] = useState({}); // "students" node → { status, lastMovement }
  const [synced, setSynced]         = useState(false);

  /* ================= UI STATE ================= */
  const [clock, setClock] = useState(() => new Date());
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("newest");
  const [modal, setModal] = useState(null);           // { type: "approve" | "reject", request }
  const [approveBy, setApproveBy] = useState("Principal");
  const [rejectReason, setRejectReason] = useState("");   // rejection reason — OPTIONAL, never required
  const [approveReturn, setApproveReturn] = useState({ date: "", time: "" }); // expected return (date + time) — pre-filled from the request, editable at approval
  const [modalError, setModalError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

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

  /* ================= FIREBASE REAL-TIME SYNC ================= */
  useEffect(() => {
    const unsubs = [
      onValue(ref(database, DB_REQUEST_PATH),
        (snap) => { setRequests(sanitizeRequests(snap.val())); setSynced(true); },
        (err) => { setSynced(true); showToast(`⚠ Could not read day-pass requests: ${err.message}`, "error"); }),
      onValue(ref(database, DB_DAYPASS_PATH),
        (snap) => setDaypasses(sanitizePasses(snap.val())),
        () => { /* node absent / not readable — requests still work */ }),
      onValue(ref(database, DB_REJECTED_PATH),
        (snap) => setRejected(sanitizePasses(snap.val())),
        () => { /* node absent / not readable — requests still work */ }),
      onValue(ref(database, DB_STUDENTS_PATH),
        (snap) => setStudentsMap(sanitizeStudents(snap.val())),
        () => { /* node absent / not readable — approvals still work */ }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [showToast]);

  /* ================= DERIVED DATA ================= */

  /* ONLY genuinely pending requests are ever listed */
  const pending = useMemo(
    () => requests.filter((r) => r.status === "REQUESTED"),
    [requests]
  );

  const classes = useMemo(
    () => [...new Set(pending.map((r) => r.className).filter((c) => c && c !== "—"))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [pending]
  );

  /* studentKey → still-open approved/issued pass — warns when a student
     with a pending request already has an active day pass in "daypass" */
  const activeApprovedByStudent = useMemo(() => {
    const map = {};
    daypasses.forEach((p) => {
      if ((p.status === "APPROVED" || p.status === "ISSUED") && p.studentKey) map[p.studentKey] = p;
    });
    return map;
  }, [daypasses]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = pending;
    if (classFilter !== "ALL") list = list.filter((r) => r.className === classFilter);
    if (q) {
      list = list.filter((r) =>
        [r.name, r.studentId, r.rfid, r.className, r.reason]
          .some((f) => String(f || "").toLowerCase().includes(q))
      );
    }
    const ts = (r) => new Date(r.requestedAt || r.createdAt || 0).getTime();
    const returnTs = (r) => { const d = parseLocal(r.expectedReturn); return d ? d.getTime() : Infinity; };
    const sorters = {
      newest: (a, b) => ts(b) - ts(a),
      oldest: (a, b) => ts(a) - ts(b),
      return: (a, b) => returnTs(a) - returnTs(b),
      name:   (a, b) => a.name.localeCompare(b.name),
    };
    return [...list].sort(sorters[sortBy] || sorters.newest);
  }, [pending, search, classFilter, sortBy]);

  /* ---------------- stats ----------------
     "Out on pass today" is counted from the STUDENTS TABLE: students whose
     status is OUT right now AND whose last movement was today.           */
  const stats = useMemo(() => {
    const approvedToday = daypasses.filter((p) => p.approvedAt && isTodayIso(p.approvedAt)).length;
    const rejectedToday = rejected.filter((r) => r.rejectedAt && isTodayIso(r.rejectedAt)).length;
    const outToday = Object.values(studentsMap)
      .filter((s) => s.status === "OUT" && isTodayIso(s.lastMovement)).length;
    return { pending: pending.length, approvedToday, rejectedToday, outToday };
  }, [pending, daypasses, rejected, studentsMap]);

  /* ================= MODAL ================= */
    const openApprove = (request) => {
    setApproveBy("Principal");
    /* pre-fill the editable return date + time from the request itself */
    const m = String(request.expectedReturn || "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
    setApproveReturn({ date: (m && m[1]) || "", time: (m && m[2]) || "" });
    setModalError("");
    setModal({ type: "approve", request });
  };
    const openReject = (request) => {
    setModalError("");
    setRejectReason("");                           // reason starts empty every time — it is optional
    setModal({ type: "reject", request });
  };

  const closeModal = useCallback(() => {
    if (!busy) { setModal(null); setModalError(""); }
  }, [busy]);

  /* ESC closes · backdrop scroll lock */
  useEffect(() => {
    if (!modal) return;
    const onKey = (e) => { if (e.key === "Escape") closeModal(); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [modal, closeModal]);

  /* if the request is withdrawn at the gate while its modal is open,
     close the modal politely (never while a decision is being saved) */
  useEffect(() => {
    if (!modal || busy) return;
    const stillPending = requests.some((r) => r._id === modal.request._id && r.status === "REQUESTED");
    if (!stillPending) {
      setModal(null);
      showToast("This request is no longer pending — it may have been withdrawn at the gate desk.", "error");
    }
  }, [requests, modal, busy, showToast]);

  /* ================= APPROVE =================
     ONE atomic multi-path write:
       · the request LEAVES "requested"
       · the approved pass is MOVED into the NEW "daypass" collection —
         the gate desk reads that node and shows "ready to print"
       · the student's status follows the workflow (REQUESTED → APPROVED) */
  const handleApprove = async () => {
    if (!modal || modal.type !== "approve") return;
    const request = modal.request;
    const who = approveBy.trim();
    if (!who) { setModalError("Please enter who is approving this pass (e.g. Principal)."); return; }
    if (!approveReturn.date || !approveReturn.time) { setModalError("Please fill in the expected return date and time."); return; }

    setBusy(true);
    try {
            const now = new Date().toISOString();
      /* date + time stored TOGETHER in the one expectedReturn field —
         the Principal may adjust them before approving */
      const approvedPass = {
        ...request,
        status: "APPROVED",
        expectedReturn: `${approveReturn.date}T${approveReturn.time}`,
        approvedAt: now,
        approvedBy: who,
      };

      const updates = {
        [`${DB_REQUEST_PATH}/${request._id}`]: null,          // removed from requests…
        [`${DB_DAYPASS_PATH}/${request._id}`]: approvedPass,  // …moved into the daypass collection
      };
      if (request.studentKey) updates[`${DB_STUDENTS_PATH}/${request.studentKey}/status`] = "APPROVED";

      await update(ref(database), updates);

      setModal(null);
      showToast(`✓ Day pass approved for ${request.name} — moved to the Day Pass collection, ready to print at the gate`, "success");
    } catch (err) {
      setModalError(`Could not approve the request — ${err.message}. Please check the connection and try again.`);
    } finally {
      setBusy(false);
    }
  };

  /* ================= REJECT (NO reason asked) =================
     ONE atomic multi-path write:
       · the request LEAVES "requested" (gone from the pending list)
       · the record is MOVED into the NEW "rejectedStudentPass"
         collection and KEPT there permanently as a record
         (rejectedAt + rejectedBy are stamped automatically)
       · the student's status — which the request had set to REQUESTED —
         is restored to IN, but only if the gate hadn't already moved
         them OUT / APPROVED in the meantime */
    const handleReject = async () => {
    if (!modal || modal.type !== "reject") return;
    const request = modal.request;
    const reasonNote = rejectReason.trim();        // OPTIONAL — rejecting without a reason is perfectly fine

    setBusy(true);
    try {
      const now = new Date().toISOString();
      const rejectedRecord = {
        ...request,
        status: "REJECTED",
        rejectedAt: now,
        rejectedBy: "Principal",
        rejectionReason: reasonNote || null,       // saved only when the Principal actually typed one
      };

      const updates = {
        [`${DB_REQUEST_PATH}/${request._id}`]: null,            // removed from requests…
        [`${DB_REJECTED_PATH}/${request._id}`]: rejectedRecord, // …kept as a permanent record
      };
      if (request.studentKey && studentsMap[request.studentKey] && studentsMap[request.studentKey].status === "REQUESTED") {
        updates[`${DB_STUDENTS_PATH}/${request.studentKey}/status`] = "IN";
      }

      await update(ref(database), updates);

      setModal(null);
      showToast(`✓ Request from ${request.name} rejected — record saved and removed from the pending list`, "success");
    } catch (err) {
      setModalError(`Could not reject the request — ${err.message}. Please try again.`);
    } finally {
      setBusy(false);
    }
  };

  /* ================= RENDER ================= */
  const loading = !synced;

  return (
    <section className="rm">
      {/* ---------- header ---------- */}
      <header className="rm-header">
        <div className="rm-heading">
          
          <div>
            
          </div>
        </div>
        <div className="rm-live">
          <span className="rm-live-dot" />
          <span className="rm-live-text">Live</span>
          <span className="rm-live-sep">·</span>
          <span className="rm-clock">
            {clock.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })}
            {" · "}
            {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
      </header>

      {/* ---------- stats ---------- */}
      <div className="rm-stats">
        <div className="rm-stat rm-stat-amber">
          <span className="rm-stat-icon">⏳</span>
          <div>
            <span className="rm-stat-value">{loading ? "—" : stats.pending}</span>
            <span className="rm-stat-label">Pending requests</span>
          </div>
        </div>
        <div className="rm-stat rm-stat-green">
          <span className="rm-stat-icon">✅</span>
          <div>
            <span className="rm-stat-value">{stats.approvedToday}</span>
            <span className="rm-stat-label">Approved today</span>
          </div>
        </div>
        <div className="rm-stat rm-stat-red">
          <span className="rm-stat-icon">⛔</span>
          <div>
            <span className="rm-stat-value">{stats.rejectedToday}</span>
            <span className="rm-stat-label">Rejected today</span>
          </div>
        </div>
        <div className="rm-stat rm-stat-blue">
          <span className="rm-stat-icon">🎫</span>
          <div>
            <span className="rm-stat-value">{loading ? "—" : stats.outToday}</span>
            <span className="rm-stat-label">Out on pass today</span>
          </div>
        </div>
      </div>

      {/* ---------- toolbar ---------- */}
      <div className="rm-toolbar">
        <div className="rm-search">
          <span className="rm-search-icon">🔍</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search student, ID, class or reason…"
            spellCheck={false}
            aria-label="Search requests"
          />
          {search && (
            <button type="button" className="rm-search-clear" onClick={() => setSearch("")} aria-label="Clear search">✕</button>
          )}
        </div>

        <div className="rm-filters">
          <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} aria-label="Filter by class">
            <option value="ALL">All classes</option>
            {classes.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort requests">
            {SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>

        <div className="rm-count">
          {loading ? "Loading…" : `${visible.length} of ${stats.pending} shown`}
        </div>
      </div>

      {/* ---------- list / loading / empty ---------- */}
      {loading ? (
        <div className="rm-skeletons">
          {[0, 1, 2].map((i) => (
            <div className="rm-skeleton" key={i}>
              <div className="rm-sk rm-sk-row" />
              <div className="rm-sk rm-sk-line" />
              <div className="rm-sk rm-sk-line short" />
              <div className="rm-sk rm-sk-foot" />
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rm-empty">
          <div className="rm-empty-icon">{pending.length === 0 ? "✨" : "🔍"}</div>
          <h3>{pending.length === 0 ? "All caught up" : "No matching requests"}</h3>
          <p>
            {pending.length === 0
              ? "There are no pending day-pass requests right now. New requests raised at the gate desk will appear here instantly."
              : "No pending request matches your search or filter. Try clearing them."}
          </p>
          {pending.length > 0 && (
            <button type="button" className="rm-btn rm-btn-ghost" onClick={() => { setSearch(""); setClassFilter("ALL"); }}>
              Clear search &amp; filters
            </button>
          )}
        </div>
      ) : (
        <div className="rm-list">
          {visible.map((r, i) => {
            const active = activeApprovedByStudent[r.studentKey];
            const longWait = r.requestedAt && (Date.now() - new Date(r.requestedAt).getTime()) > LONG_WAIT_MS;
            return (
              <article
                className={`rm-card ${longWait ? "rm-card-waiting" : ""}`}
                key={r._id}
                style={{ animationDelay: `${Math.min(i * 45, 270)}ms` }}
              >
                {/* student identity */}
                <div className="rm-card-top">
                  <div className="rm-who">
                    <span className="rm-avatar" style={{ background: avatarGradient(r.name) }}>{getInitials(r.name)}</span>
                    <div className="rm-identity">
                      <h3 className="rm-name" title={r.name}>{r.name}</h3>
                      <div className="rm-chips">
                        <span className="rm-chip">{r.className}</span>
                        <span className="rm-chip rm-chip-mono">{r.studentId}</span>
                        {r.rfid && <span className="rm-chip rm-chip-mono rm-chip-soft">RFID {r.rfid}</span>}
                      </div>
                    </div>
                  </div>
                  <div className={`rm-wait ${longWait ? "rm-wait-long" : ""}`} title={`Requested ${fmtDateTime(r.requestedAt)}`}>
                    <span className="rm-wait-dot" />
                    <span className="rm-wait-time">{timeAgo(r.requestedAt)}</span>
                  </div>
                </div>

                {/* full request details */}
                <div className="rm-card-details">
                  <div className="rm-detail">
                    <span className="rm-detail-label">Reason for day pass</span>
                    <p className="rm-detail-reason-text">{r.reason}</p>
                  </div>
                  <div className="rm-detail-grid">
                    <div className="rm-detail">
                      <span className="rm-detail-label">Expected return</span>
                      <span className="rm-detail-value">
                        {fmtExpected(r.expectedReturn)}
                        {isTodayDate(r.expectedReturn) && <span className="rm-tag rm-tag-today">Today</span>}
                        {isOverdueDate(r.expectedReturn) && <span className="rm-tag rm-tag-overdue">Overdue</span>}
                      </span>
                    </div>
                    <div className="rm-detail">
                      <span className="rm-detail-label">Requested at</span>
                      <span className="rm-detail-value">{fmtDateTime(r.requestedAt)}</span>
                    </div>
                     {r.goingWith && (
                      <div className="rm-detail">
                        <span className="rm-detail-label">Going with</span>
                        <span className="rm-detail-value">{fmtGoingWith(r)}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* active-pass warning */}
                {active && (
                  <div className="rm-card-warn">
                    ⚠ This student already has an active day pass ({active.status === "ISSUED" ? "issued" : "approved, awaiting print"}
                    {active.slipNo ? ` · slip ${active.slipNo}` : ""}). Please verify before approving.
                  </div>
                )}

                {/* actions */}
                <div className="rm-card-actions">
                  <button type="button" className="rm-btn rm-btn-reject" onClick={() => openReject(r)}>✕ Reject</button>
                  <button type="button" className="rm-btn rm-btn-approve" onClick={() => openApprove(r)}>✓ Approve</button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* ---------- confirm modal ---------- */}
      {modal && (
        <div
          className="rm-modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className={`rm-modal rm-modal-${modal.type}`} role="dialog" aria-modal="true" aria-labelledby="rm-modal-title">
            <div className="rm-modal-head">
              <span className="rm-modal-badge">{modal.type === "approve" ? "✓" : "✕"}</span>
              <div>
                <h3 id="rm-modal-title">
                  {modal.type === "approve" ? "Approve this day pass?" : "Reject this request?"}
                </h3>
                <p>
                  {modal.type === "approve"
                    ? "On approval the request moves into the Day Pass collection and the gate desk can print the slip immediately."
                    : "The request is removed from the pending list and kept in the rejected records. The student's status is restored to IN."}
                </p>
              </div>
            </div>

            <div className="rm-modal-summary">
              <div className="rm-ms-row"><span>Student</span><strong>{modal.request.name}</strong></div>
              <div className="rm-ms-row"><span>Class</span><strong>{modal.request.className}</strong></div>
              <div className="rm-ms-row"><span>ID No</span><strong>{modal.request.studentId}</strong></div>
              <div className="rm-ms-row"><span>Reason</span><strong>{modal.request.reason}</strong></div>
              {modal.request.goingWith && <div className="rm-ms-row"><span>Going with</span><strong>{fmtGoingWith(modal.request)}</strong></div>}
              <div className="rm-ms-row"><span>Expected return</span><strong>{fmtExpected(modal.request.expectedReturn)}</strong></div>
              <div className="rm-ms-row"><span>Requested</span><strong>{fmtDateTime(modal.request.requestedAt)}</strong></div>
            </div>

                        {modal.type === "approve" && (
              <div className="rm-modal-form">
                <label className="rm-field">
                  <span>Approved by</span>
                  <input
                    autoFocus
                    value={approveBy}
                    onChange={(e) => { setApproveBy(e.target.value); setModalError(""); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleApprove(); } }}
                    placeholder="e.g. Principal"
                  />
                </label>
                <label className="rm-field">
                  <span>Expected return — date &amp; time</span>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="date"
                      value={approveReturn.date}
                      onChange={(e) => { setApproveReturn((v) => ({ ...v, date: e.target.value })); setModalError(""); }}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <input
                      type="time"
                      value={approveReturn.time}
                      onChange={(e) => { setApproveReturn((v) => ({ ...v, time: e.target.value })); setModalError(""); }}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                  </div>
                </label>
                {modalError && <p className="rm-modal-error">⚠ {modalError}</p>}
              </div>
            )}
                        {modal.type === "reject" && (
              <div className="rm-modal-form">
                <label className="rm-field">
                  <span>Reason for rejection (optional — not required)</span>
                  <input
                    value={rejectReason}
                    onChange={(e) => { setRejectReason(e.target.value); setModalError(""); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleReject(); } }}
                    placeholder="Optional — leave empty to reject directly"
                  />
                </label>
                {modalError && <p className="rm-modal-error">⚠ {modalError}</p>}
              </div>
            )}

            <div className="rm-modal-foot">
              <button type="button" className="rm-btn rm-btn-ghost" onClick={closeModal} disabled={busy}>Cancel</button>
              {modal.type === "approve" ? (
                <button
                  type="button"
                  className="rm-btn rm-btn-approve"
                  onClick={handleApprove}
                  disabled={busy}
                >
                  {busy ? "Please wait…" : "Approve"}
                </button>
              ) : (
                <button
                  type="button"
                  className="rm-btn rm-btn-reject-solid"
                  onClick={handleReject}
                  disabled={busy}
                  autoFocus
                >
                  {busy ? "Please wait…" : "Reject request"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------- toast ---------- */}
      <div aria-live="polite">
        {toast && (
          <div key={toast.id} className={`rm-toast rm-toast-${toast.type}`}>
            <span className="rm-toast-icon">{toast.type === "success" ? "✓" : "⚠"}</span>
            <span>{toast.text}</span>
          </div>
        )}
      </div>
    </section>
  );
}