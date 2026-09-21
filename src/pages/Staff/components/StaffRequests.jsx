import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ref, onValue, update, remove, get } from "firebase/database";
import { database } from "../../../firebase/config"; // ← same import style as StaffPassIssue — adjust if this file sits elsewhere
import "./StaffRequests.css";

/* =====================================================================
   PRINCIPAL · STAFF PASS APPROVALS
   ---------------------------------------------------------------------
   • LIVE queue of staff pass requests sent from the gate desk
     (Firebase Realtime Database node "staffrequests").
   • Only REQUESTED passes are displayed:
       – CANCELLED requests are never shown and (by default) are
         auto-deleted from "staffrequests", keeping the node a clean
         pending queue. Set AUTO_CLEAN_CANCELLED = false to keep them
         in the database (still hidden from the list).
   • APPROVE → the request is written to "staffpass" with status
     "APPROVED" (+ approvedAt / approvedBy) and removed from
     "staffrequests" — ONE ATOMIC multi-path update, so a request can
     never be lost or duplicated mid-move.
   • REJECT  → optional reason, then the request is written to
     "staffrejected" with status "REJECTED" (+ rejectedAt / rejectedBy /
     rejectionReason) and removed from "staffrequests" — same atomic move.
   • Every decision re-reads the FRESHEST database record first, so a
     request cancelled or already handled (another tab / another
     principal device / the gate desk) can never be decided twice.
   • Live stats: pending count · approved today · rejected today.
   • Oldest-first FIFO queue with live waiting-time badges, search,
     loading skeletons, empty states, toasts and an Esc-to-close modal.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DB_REQUESTS_PATH = "staffrequests"; // pending requests (gate desk writes here)
const DB_APPROVED_PATH = "staffpass";     // approved passes live here after approval
const DB_REJECTED_PATH = "staffrejected"; // rejected requests live here after rejection

const PRINCIPAL_NAME = "Principal";       // stored in approvedBy / rejectedBy

const AUTO_CLEAN_CANCELLED = true;        // delete CANCELLED requests from "staffrequests"
                                          // (they are always hidden from the list either way)

/* ---------------- small helpers ---------------- */
const p2 = (n) => String(n).padStart(2, "0");

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

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d)) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/* live "waiting 12 min" badge → amber after 30 min, red after 2 h */
function waitLabel(iso, now) {
  const t = new Date(iso);
  if (!iso || isNaN(t)) return null;
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return { text: "just now", tone: "" };
  if (mins < 60) return { text: `waiting ${mins} min`, tone: mins >= 30 ? "long" : "" };
  const h = Math.floor(mins / 60);
  return { text: `waiting ${h} h ${p2(mins % 60)} m`, tone: h >= 2 ? "urgent" : "long" };
}

/* ===================================================================== */

export default function PrincipalStaffApprovals() {
  /* ================= STATE ================= */
  const [requests, setRequests] = useState([]);        // pending REQUESTED passes
  const [approvedToday, setApprovedToday] = useState(0);
  const [rejectedToday, setRejectedToday] = useState(0);

  const [loading, setLoading] = useState(true);        // until the first snapshot
  const [syncError, setSyncError] = useState("");

  const [search, setSearch] = useState("");
  const [busyIds, setBusyIds] = useState([]);          // ids with a decision in flight

  const [rejecting, setRejecting] = useState(null);    // pass in the reject modal
  const [rejectNote, setRejectNote] = useState("");
  const [rejectBusy, setRejectBusy] = useState(false);
  const rejectNoteRef = useRef(null);

  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  const [clock, setClock] = useState(() => new Date());

  /* clock — ticks every second (also refreshes the waiting badges) */
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

  const markBusy = useCallback((id) => setBusyIds((b) => (b.includes(id) ? b : [...b, id])), []);
  const clearBusy = useCallback((id) => setBusyIds((b) => b.filter((x) => x !== id)), []);

  /* ================= LIVE FIREBASE SYNC ================= */
  useEffect(() => {
    /* pending queue — the ONLY statuses shown are REQUESTED */
    const unsubRequests = onValue(
      ref(database, DB_REQUESTS_PATH),
      (snap) => {
        const all = sanitizePassList(snap.val());

        /* housekeeping: CANCELLED requests are never displayed and
           (by default) removed from the node so it stays a clean queue */
        if (AUTO_CLEAN_CANCELLED) {
          all
            .filter((p) => String(p.status || "").toUpperCase() === "CANCELLED")
            .forEach((p) => {
              remove(ref(database, `${DB_REQUESTS_PATH}/${p._id}`)).catch(() => {});
            });
        }

        /* still-pending requests only, oldest first (fair FIFO queue) */
        setRequests(
          all
            .filter((p) => String(p.status || "").toUpperCase() === "REQUESTED")
            .sort((a, b) => new Date(a.requestedAt || a.createdAt || 0) - new Date(b.requestedAt || b.createdAt || 0))
        );
        setLoading(false);
      },
      (err) => { setSyncError(err.message); setLoading(false); }
    );

    /* approved today — live from "staffpass" */
    const unsubApproved = onValue(
      ref(database, DB_APPROVED_PATH),
      (snap) => setApprovedToday(sanitizePassList(snap.val()).filter((p) => isToday(p.approvedAt)).length),
      () => {}
    );

    /* rejected today — live from "staffrejected" */
    const unsubRejected = onValue(
      ref(database, DB_REJECTED_PATH),
      (snap) => setRejectedToday(sanitizePassList(snap.val()).filter((p) => isToday(p.rejectedAt)).length),
      () => {}
    );

    return () => { unsubRequests(); unsubApproved(); unsubRejected(); };
  }, []);

  /* ================= SEARCH ================= */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter((p) =>
      [p.name, p.staffId, p.department, p.reason, p.rfid]
        .some((v) => String(v || "").toLowerCase().includes(q))
    );
  }, [requests, search]);

  /* ================= APPROVE =================
     Atomic move: staffrequests/<id> → staffpass/<id> (status APPROVED).
     A single multi-path update performs the write AND the delete
     together — the request can never exist in both places, or neither. */
  const handleApprove = async (pass) => {
    if (busyIds.includes(pass._id)) return;
    markBusy(pass._id);
    try {
      /* freshest check — the desk may have cancelled / edited it */
      const snap = await get(ref(database, `${DB_REQUESTS_PATH}/${pass._id}`));
      if (!snap.exists() || String(snap.val()?.status || "").toUpperCase() !== "REQUESTED") {
        showToast(`⚠ ${pass.name}'s request was already handled or withdrawn — nothing to approve.`, "info");
        return;                                   // live listener refreshes the list by itself
      }

      const now = new Date().toISOString();
      const approved = {
        ...snap.val(),
        status: "APPROVED",
        authorizedBy: PRINCIPAL_NAME,
        approvedBy: PRINCIPAL_NAME,
        approvedAt: now,
      };

      await update(ref(database), {
        [`${DB_APPROVED_PATH}/${pass._id}`]: approved,   // → staffpass
        [`${DB_REQUESTS_PATH}/${pass._id}`]: null,       // ← removed from staffrequests
      });

      showToast(`✓ Pass approved for ${pass.name} — moved to Staff Passes`, "success");
    } catch (err) {
      showToast(`⚠ Could not approve — ${err.message || "check Firebase connection / rules"}`, "error");
    } finally {
      clearBusy(pass._id);
    }
  };

  /* ================= REJECT ================= */
  const openReject = (pass) => { setRejecting(pass); setRejectNote(""); };
  const closeReject = () => { if (!rejectBusy) setRejecting(null); };

  const handleReject = async () => {
    const pass = rejecting;
    if (!pass || rejectBusy) return;
    setRejectBusy(true);
    try {
      const snap = await get(ref(database, `${DB_REQUESTS_PATH}/${pass._id}`));
      if (!snap.exists() || String(snap.val()?.status || "").toUpperCase() !== "REQUESTED") {
        showToast(`⚠ ${pass.name}'s request was already handled or withdrawn — nothing to reject.`, "info");
        setRejecting(null);
        return;
      }

      const now = new Date().toISOString();
      const rejected = {
        ...snap.val(),
        status: "REJECTED",
        rejectedBy: PRINCIPAL_NAME,
        rejectedAt: now,
        rejectionReason: rejectNote.trim() || null,
      };

      await update(ref(database), {
        [`${DB_REJECTED_PATH}/${pass._id}`]: rejected,   // → staffrejected
        [`${DB_REQUESTS_PATH}/${pass._id}`]: null,       // ← removed from staffrequests
      });

      showToast(`✕ Pass request from ${pass.name} rejected`, "info");
      setRejecting(null);
    } catch (err) {
      showToast(`⚠ Could not reject — ${err.message || "check Firebase connection / rules"}`, "error");
    } finally {
      setRejectBusy(false);
    }
  };

  /* Esc closes the reject modal */
  useEffect(() => {
    if (!rejecting) return;
    const onEsc = (e) => { if (e.key === "Escape" && !rejectBusy) setRejecting(null); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [rejecting, rejectBusy]);

  useEffect(() => { if (rejecting) setTimeout(() => rejectNoteRef.current?.focus(), 60); }, [rejecting]);

  /* ================= RENDER ================= */
  const isBusy = (id) => busyIds.includes(id);

  return (
    <section className="pa">
      {/* ---------- header ---------- */}
      

      {/* ---------- live stats ---------- */}
      <div className="pa-stats">
        <div className="pa-stat">
          <span className="pa-stat-num">{loading ? "…" : requests.length}</span>
          <span className="pa-stat-label">Pending requests</span>
        </div>
        <div className="pa-stat pa-stat-approved">
          <span className="pa-stat-num">{approvedToday}</span>
          <span className="pa-stat-label">Approved today</span>
        </div>
        <div className="pa-stat pa-stat-rejected">
          <span className="pa-stat-num">{rejectedToday}</span>
          <span className="pa-stat-label">Rejected today</span>
        </div>
      </div>

      {/* ---------- toolbar ---------- */}
      <div className="pa-toolbar">
        <div className="pa-searchbox">
          <span className="pa-search-icon">🔎</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, staff ID, department or reason…"
            aria-label="Search requests"
            spellCheck={false}
            autoComplete="off"
          />
          {search && (
            <button type="button" className="pa-search-clear" onClick={() => setSearch("")} aria-label="Clear search">×</button>
          )}
        </div>
        {!loading && (
          <span className="pa-count">
            {search ? `${visible.length} of ${requests.length}` : `${requests.length}`} pending
          </span>
        )}
      </div>

      {/* ---------- request list ---------- */}
      <div className="pa-list">
        {loading ? (
          <>
            <div className="pa-skeleton" />
            <div className="pa-skeleton" />
            <div className="pa-skeleton" />
          </>
        ) : visible.length === 0 ? (
          <div className="pa-empty">
            <div className="pa-empty-icon">{search ? "🔎" : "✅"}</div>
            <h3>{search ? "No matching requests" : "No pending requests"}</h3>
            <p>
              {search
                ? `Nothing matches "${search}". Try a different name, staff ID or reason.`
                : ""}
            </p>
          </div>
        ) : (
          visible.map((pass) => {
            const wait = waitLabel(pass.requestedAt || pass.createdAt, clock);
            const busy = isBusy(pass._id);
            return (
              <article key={pass._id} className="pa-card">
                <div className="pa-card-top">
                  <span className="pa-avatar">{getInitials(pass.name)}</span>
                  <div className="pa-who">
                    <div className="pa-name-row">
                      <h3 className="pa-name">{pass.name || "Unknown staff"}</h3>
                      {wait && <span className={`pa-wait ${wait.tone ? `pa-wait-${wait.tone}` : ""}`}>{wait.text}</span>}
                    </div>
                    <div className="pa-meta">
                      <span className="pa-chip">{pass.department || "—"}</span>
                      {pass.staffId && <span className="pa-chip">{pass.staffId}</span>}
                      {pass.rfid && <span className="pa-chip pa-chip-mono">{pass.rfid}</span>}
                    </div>
                    <p className="pa-reason" title={pass.reason}>"{pass.reason || "No reason given"}"</p>
                  </div>
                </div>

                <div className="pa-card-grid">
                  <div className="pa-cell">
                    <span className="pa-cell-label">Out at</span>
                    <span className="pa-cell-value">{fmtExpected(pass.outAt)}</span>
                  </div>
                  <div className="pa-cell">
                    <span className="pa-cell-label">Expected return</span>
                    <span className="pa-cell-value">{fmtExpected(pass.expectedReturn)}</span>
                  </div>
                  <div className="pa-cell">
                    <span className="pa-cell-label">Requested</span>
                    <span className="pa-cell-value">{fmtDateTime(pass.requestedAt || pass.createdAt)}</span>
                  </div>
                </div>

                <div className="pa-card-actions">
                  <button type="button" className="pa-btn pa-btn-approve" disabled={busy} onClick={() => handleApprove(pass)}>
                    {busy ? "Approving…" : "✓ Approve"}
                  </button>
                  <button type="button" className="pa-btn pa-btn-reject" disabled={busy} onClick={() => openReject(pass)}>
                    ✕ Reject
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      {/* ---------- reject modal ---------- */}
      {rejecting && (
        <div
          className="pa-overlay"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !rejectBusy) setRejecting(null); }}
        >
          <div className="pa-modal" role="dialog" aria-modal="true" aria-label="Reject pass request">
            <div className="pa-modal-head">
              <h2>✕ Reject Pass Request</h2>
              <button type="button" className="pa-modal-close" onClick={closeReject} aria-label="Close">×</button>
            </div>

            <div className="pa-modal-body">
              <div className="pa-modal-member">
                <span className="pa-avatar">{getInitials(rejecting.name)}</span>
                <div className="pa-modal-member-text">
                  <strong>{rejecting.name}</strong>
                  <span>{rejecting.department || "—"} · {rejecting.staffId || "—"}</span>
                </div>
              </div>

              <div className="pa-modal-grid">
                <div className="pa-cell">
                  <span className="pa-cell-label">Reason given</span>
                  <span className="pa-cell-value">{rejecting.reason || "—"}</span>
                </div>
                <div className="pa-cell">
                  <span className="pa-cell-label">Out at</span>
                  <span className="pa-cell-value">{fmtExpected(rejecting.outAt)}</span>
                </div>
                <div className="pa-cell">
                  <span className="pa-cell-label">Expected return</span>
                  <span className="pa-cell-value">{fmtExpected(rejecting.expectedReturn)}</span>
                </div>
              </div>

              <div className="pa-field">
                <label htmlFor="pa-reject-note">Reason for rejection (optional)</label>
                <textarea
                  id="pa-reject-note"
                  ref={rejectNoteRef}
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                  rows={3}
                  placeholder="e.g. Duty scheduled at that time."
                  disabled={rejectBusy}
                />
              </div>

              
            </div>

            <div className="pa-modal-footer">
              <button type="button" className="pa-btn pa-btn-ghost" disabled={rejectBusy} onClick={closeReject}>
                Keep Pending
              </button>
              <button type="button" className="pa-btn pa-btn-reject" disabled={rejectBusy} onClick={handleReject}>
                {rejectBusy ? "Rejecting…" : "✕ Confirm Reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- toast ---------- */}
      {toast && (
        <div key={toast.id} className={`pa-toast pa-toast-${toast.type}`}>{toast.text}</div>
      )}
    </section>
  );
}