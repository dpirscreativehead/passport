import React, { useState, useEffect, useRef, useCallback } from "react";
import { ref, onValue, set, update } from "firebase/database";
import { database } from "../../../firebase/config"; // ← src/firebase/config — adjust the relative path if this component sits elsewhere
import "./StaffPass.css";

/* =====================================================================
   STAFF PASS ISSUE DESK — the gate operator's screen for STAFF passes
   ---------------------------------------------------------------------
   • RFID scanning with the same deliberate rhythm as the student desk:
       – The scanner is LIVE only when the desk is free: no form open,
         nobody typing in the manual box, and no result under review.
       – After EVERY read — a card scan OR a manual Find — the scanner
         PAUSES right away. It re-arms when the operator presses
         [Next Scan] or automatically after 10 seconds.
       – While the operator types in the manual input, the scanner is
         paused: machine-speed keystrokes are swallowed before they
         reach the field. Only real human input ever lands in the box.
   • Any USB / HID reader that "types" the card code fast and finishes
     with ENTER is caught anywhere on the page.
   • Manual fallback: type a Staff ID (or RFID) and press Find.
   • FIXED-HEIGHT layout — the panel never changes height.
   • ONE pass type only (unlike students, no direct issue):
       IN        → [Request Pass] → form (auto-filled name / staff ID /
                    department · out date+time · expected return
                    date+time · reason) → [Send Request] → REQUESTED
       REQUESTED → amber "pending approval" state
                    [Edit Request] → same form, pre-filled → save
                                      updates the pending request
                    [Cancel Request] → withdraws the request instantly
       APPROVED  → [Print Pass] → marks the pass ISSUED in Firebase
                    (slipNo, issuedAt …), sets the staff member OUT in
                    the "staff" collection and prints the 80 mm slip —
                    printing is possible ONLY after approval
       OUT / ON PASS → [Mark In] (closes an issued pass)
   • DATA LIVES IN FIREBASE REALTIME DATABASE:
       · staff master data ← the "staff" node, the exact node the
         StaffManage component maintains — read live via onValue, so
         both sections are always perfectly in sync.
       · pending requests ← the "staffrequests" node. Every request,
         edit, cancellation and return is a targeted write (set /
         update) straight to that node. The Principal's approval page
         reads and decides on this SAME node.
       · approved passes ← the "staffpass" node — the Principal's
         approval page moves an approved request here atomically; this
         desk listens to BOTH nodes live and merges them, so the
         moment the Principal approves or rejects, this panel updates
         instantly, across tabs and devices.
       · rejected requests ← the "staffrejected" node — when the
         Principal rejects the request of the staff member on the
         panel, the operator is notified and the panel reverts to the
         normal options automatically.
   • Every change updates the Staff Manage table instantly:
       request / approval → "Pending" · mark in / cancel → "In"
       printed pass       → "Out"
     staffKey / staffId are kept on every pass — exactly the fields the
     Staff Manage table listens for.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DB_STAFF_PATH    = "staff";          // staff master data — maintained by the StaffManage component
const DB_REQUESTS_PATH = "staffrequests";  // pending requests — this desk writes here; the Principal's approval page decides here
const DB_PASSES_PATH   = "staffpass";      // approved passes — the Principal's approval page moves them here
const DB_REJECTED_PATH = "staffrejected";  // rejected requests — the Principal's approval page moves them here

const SCHOOL_NAME = "De Paul International Residential School, Mysore";      // ← printed on every slip

const ACTIVE_PASS_STATUSES = ["REQUESTED", "APPROVED", "ISSUED"];

const SCAN_COOLDOWN_MS = 10000;   // review pause after a card read OR a manual Find
const MACHINE_GAP_MS = 45;        // keys arriving faster than this are the reader, never a person

const REASON_OPTIONS = [
  "Official duty / school errand",
  "Medical / dental appointment",
  "Not feeling well, going home",
  "Family emergency",
  "Personal work",
  "Bank / government office visit",
];

/* ---------------- small helpers ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const p2 = (n) => String(n).padStart(2, "0");

const normalizeRfid = (v) => String(v || "").trim().toUpperCase().replace(/[\s:\-]/g, "");

const getInitials = (name) =>
  String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("") || "?";

/* Firebase "staff" node ({ "<_id>": { …member } }) → clean array */
function sanitizeStaffList(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  return Object.entries(val).map(([key, s]) => ({
    ...s,
    _id: String(s._id || key),
    rfid: normalizeRfid(s.rfid),
    staffId: String(s.staffId || "").trim(),
    name: String(s.name || "").trim(),
    department: String(s.department || "").trim(),
    status: String(s.status || "").trim().toUpperCase(),
    lastMovement: s.lastMovement || null,
  }));
}

/* Firebase "staffrequests" node ({ "<passId>": { …pass } }) → clean array */
function sanitizePassList(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === "object") {
    return Object.entries(val).map(([key, p]) => ({ ...p, _id: p._id || key }));
  }
  return [];
}

/* "2025-06-11" and "2025-06-11T14:30" → local Date (no UTC surprises) */
function parseLocal(v) {
  const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function nextHalfHour(hoursAhead = 1) {
  const d = new Date(Date.now() + hoursAhead * 3600000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
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
function fmtFull(v) {
  const d = parseLocal(v);
  if (!d) return String(v || "—");
  return /T\d{2}:\d{2}/.test(String(v))
    ? d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

/* "YYYY-MM-DDTHH:MM" → ["YYYY-MM-DD", "HH:MM"] — for pre-filling the edit form */
function splitDateTime(v) {
  const m = String(v || "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  return m ? [m[1], m[2] || ""] : ["", ""];
}

/* latest still-open pass of this staff member (REQUESTED / APPROVED / ISSUED) */
function findActivePass(passes, member) {
  if (!member) return null;
  const list = (passes || [])
    .filter((p) => (p.staffKey && p.staffKey === member._id) || (p.staffId && p.staffId === member.staffId))
    .filter((p) => ACTIVE_PASS_STATUSES.indexOf(p.status) !== -1)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return list[0] || null;
}

/* what the panel should show for this staff member right now */
function resolveView(member, passes) {
  const pass = findActivePass(passes, member);
  if (pass) {
    if (pass.status === "REQUESTED") return { state: "REQUESTED", pass };
    if (pass.status === "APPROVED") return { state: "APPROVED", pass };
    return { state: "OUT_PASS", pass };            // out on an issued pass
  }
  return member.status === "OUT" ? { state: "OUT", pass: null } : { state: "IN", pass: null };
}

/* write a new presence status back into the Firebase "staff" node —
   the Staff Manage table (live onValue on the same node) flips instantly */
function setStaffStatus(member, status, isoTime) {
  if (!member || !member._id) return Promise.resolve();
  return update(ref(database, `${DB_STAFF_PATH}/${member._id}`), { status, lastMovement: isoTime });
}

/* ---------- slip number + the printed slip (80 mm) ---------- */

/* running slip number for today: SP-YYYYMMDD-001 … */
function makeSlipNo(passes) {
  const d = new Date();
  const today = d.toDateString();
  const n = (passes || []).filter((x) => x.issuedAt && new Date(x.issuedAt).toDateString() === today).length + 1;
  return `SGP-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${String(n).padStart(3, "0")}`;
}

/* ---------- 80 mm thermal slip (printed through a hidden iframe) ---------- */
function printSlip(pass) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const issuedAt = new Date(pass.printedAt || pass.issuedAt || Date.now());

  const rows = [
    ["Name", pass.name],
    ["Department", pass.department],
    ["Staff ID", pass.staffId],
    ["Reason", pass.reason],
    ["Out at", fmtFull(pass.outAt)],
    ["Return by", fmtFull(pass.expectedReturn)],
    ["Approved by", pass.approvedBy || "Principal"],
  ]
    .map(([k, v]) => `<div class="r"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join("");

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Staff Pass ${esc(pass.slipNo || "")}</title><style>` +
    `@page{size:80mm auto;margin:2mm}html,body{margin:0;padding:0}` +
    `body{width:76mm;font-family:"Consolas","Courier New",monospace;color:#000}` +
    `.c{text-align:center}.school{font-size:12px;font-weight:bold;letter-spacing:.4px}` +
    `.slip{font-size:17px;font-weight:bold;letter-spacing:5px;margin:1.5mm 0 .5mm}` +
    `.no{font-size:11px;letter-spacing:1px}.hr{border-top:1px dashed #000;margin:2mm 0}` +
    `.r{display:flex;font-size:11px;line-height:1.55}.k{width:24mm;flex-shrink:0;font-weight:bold}` +
    `.v{flex:1;word-break:break-word}.stamp{font-size:10.5px;line-height:1.6}` +
    `.note{font-size:9.5px;line-height:1.5}.foot{font-size:9.5px;margin-top:1.5mm}` +
    `</style></head><body>` +
    `<div class="c school">${esc(SCHOOL_NAME)}</div>` +
    `<div class="c slip">STAFF GATE PASS</div>` +
    `<div class="c no">${esc(pass.slipNo || "")}</div>` +
    `<div class="hr"></div>${rows}<div class="hr"></div>` +
    `<div class="c stamp">Issued: ${esc(issuedAt.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</div>` +
    `<div class="hr"></div>` +
    `<div class="c foot">— DPIRS PassPort —</div>` +
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

/* ---------- little gate-desk beeps (silent if audio is blocked) ---------- */
let _audioCtx = null;
function beep(ok) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _audioCtx = _audioCtx || new AC();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const t0 = _audioCtx.currentTime;
    const blip = (freq, at, dur) => {
      const o = _audioCtx.createOscillator();
      const g = _audioCtx.createGain();
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.14, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g); g.connect(_audioCtx.destination);
      o.start(t0 + at); o.stop(t0 + at + dur + 0.03);
    };
    if (ok) blip(1250, 0, 0.14);
    else { blip(340, 0, 0.12); blip(340, 0.17, 0.12); }
  } catch { /* no audio available — ignore */ }
}

/* ===================================================================== */

export default function StaffPassIssue() {
  /* ================= STATE ================= */
  const [current, setCurrent] = useState(null);     // staff member shown in the panel
  const [view, setView] = useState(null);           // { state, pass } resolved for current
  const [notFound, setNotFound] = useState(null);   // { type, value } unknown card / ID
  const [scan, setScan] = useState({ status: "ready", code: "" });
  const [manualId, setManualId] = useState("");

  const [manualFocus, setManualFocus] = useState(false);   // operator typing in the manual box → scanner paused
  const [cooldown, setCooldown] = useState(null);          // { endsAt } → review pause after a read
  const [cooldownLeft, setCooldownLeft] = useState(0);     // seconds remaining on the review pause

  const [requestOpen, setRequestOpen] = useState(false);
  const [requestMode, setRequestMode] = useState("new");   // "new" | "edit"
  const [requestForm, setRequestForm] = useState({ outDate: "", outTime: "", returnDate: "", returnTime: "", reason: "" });
  const [requestError, setRequestError] = useState("");

  const [toast, setToast] = useState(null);
  const [clock, setClock] = useState(() => new Date());

  /* ================= REFS ================= */
  const staffListRef  = useRef([]);        // FRESHEST staff list from Firebase (live onValue on "staff")
  const passesListRef = useRef([]);        // FRESHEST merged ACTIVE passes (staffrequests + staffpass), each tagged with its node

  const pendingRef      = useRef([]);      // raw "staffrequests" snapshot (REQUESTED — waiting for the Principal)
  const approvedRef     = useRef([]);      // raw "staffpass" snapshot (APPROVED / ISSUED — the Principal moved them here)
  const seenRejectedRef = useRef(null);    // rejected ids already seen — only NEW rejections notify (null until the first snapshot)

  const currentKeyRef = useRef(null);
  const scanHandlerRef = useRef(null);
  const overlayOpenRef = useRef(false);
  const requestMemberRef = useRef(null);
  const requestPassRef = useRef(null);      // the pass being edited (edit mode)

  const manualFocusRef = useRef(false);     // mirrors manualFocus for the key listener
  const cooldownRef = useRef(false);        // mirrors cooldown for the key listener
  const cooldownTimerRef = useRef(null);    // the 10 s auto re-arm timeout

  const manualInputRef = useRef(null);
  const outDateRef = useRef(null);
  const outTimeRef = useRef(null);
  const returnDateRef = useRef(null);
  const returnTimeRef = useRef(null);
  const reasonRef = useRef(null);

  const toastTimerRef = useRef(null);
  const scanResetRef = useRef(null);

  /* clock — ticks every second */
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  /* the scanner pauses while the request form is open */
  useEffect(() => { overlayOpenRef.current = requestOpen; }, [requestOpen]);

  /* countdown display while the review pause is running */
  useEffect(() => {
    if (!cooldown) { setCooldownLeft(0); return; }
    const tick = () => setCooldownLeft(Math.max(0, Math.ceil((cooldown.endsAt - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 200);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => () => { if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current); }, []);

  /* ================= TOAST ================= */
  const showToast = useCallback((text, type = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  /* ================= SCAN BOX FLASH ================= */
  const setScanResult = useCallback((ok, code) => {
    setScan({ status: ok ? "ok" : "error", code });
    if (scanResetRef.current) clearTimeout(scanResetRef.current);
    scanResetRef.current = setTimeout(() => setScan((s) => ({ ...s, status: "ready" })), 2400);
  }, []);
  useEffect(() => () => { if (scanResetRef.current) clearTimeout(scanResetRef.current); }, []);

  /* ================= SCANNER ARM / PAUSE ================= */
  /* re-arm immediately — used by the [Next Scan] button */
  const armScanner = useCallback(() => {
    if (cooldownTimerRef.current) { clearTimeout(cooldownTimerRef.current); cooldownTimerRef.current = null; }
    cooldownRef.current = false;
    setCooldown(null);
  }, []);

  /* pause the scanner after a result is loaded (card read OR manual Find)
     — [Next Scan] or 10 s re-arms it, so the person on screen can be
     verified without a stray tap replacing them */
  const startCooldown = useCallback(() => {
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    cooldownRef.current = true;
    const endsAt = Date.now() + SCAN_COOLDOWN_MS;
    setCooldown({ endsAt });
    cooldownTimerRef.current = setTimeout(() => {
      cooldownTimerRef.current = null;
      cooldownRef.current = false;
      setCooldown(null);
    }, SCAN_COOLDOWN_MS);
  }, []);

  const handleNextScan = useCallback(() => {
    armScanner();
    setScan((s) => (s.status === "ready" ? s : { status: "ready", code: s.code }));
  }, [armScanner]);

  /* ================= SHOW / REFRESH STAFF MEMBER ================= */
  const showMember = useCallback((member) => {
    currentKeyRef.current = member._id || member.staffId;
    setNotFound(null);
    setCurrent(member);
    setView(resolveView(member, passesListRef.current));
  }, []);

  /* re-resolve the member on the panel from the FRESHEST Firebase snapshots */
  const refreshCurrent = useCallback(() => {
    const key = currentKeyRef.current;
    if (!key) return;
    const staff = staffListRef.current;
    const member = staff.find((s) => s._id === key) || staff.find((s) => s.staffId === key) || null;
    if (!member) { currentKeyRef.current = null; setCurrent(null); setView(null); return; }
    setCurrent(member);
    setView(resolveView(member, passesListRef.current));
  }, []);

  /* ================= FIREBASE REAL-TIME SYNC =================
     Live subscriptions:
       · "staff"         → master data maintained by StaffManage
       · "staffrequests" → REQUESTED passes (waiting for the Principal)
       · "staffpass"     → APPROVED / ISSUED passes (the Principal's
                           approval page moves approvals here)
       · "staffrejected" → REJECTED requests (moved here by the
                           Principal's approval page)
     "staffrequests" + "staffpass" are MERGED into one active-pass list —
     every pass is tagged with the node it lives in (`_node`) so later
     writes (print / mark in) always go to the right place. The moment
     the Principal approves, the request vanishes from "staffrequests"
     and reappears in "staffpass" in the same tick (the Principal's page
     moves it with ONE atomic update) — this panel flips to APPROVED
     instantly, across tabs and devices. When a request is rejected, the
     pass is gone from both active nodes, the panel reverts to the
     normal options and the operator is notified. */
  useEffect(() => {
    const unsubStaff = onValue(
      ref(database, DB_STAFF_PATH),
      (snap) => { staffListRef.current = sanitizeStaffList(snap.val()); refreshCurrent(); },
      (err) => showToast(`⚠ Staff sync error: ${err.message}`, "error")
    );

    const mergePasses = () => {
      passesListRef.current = [
        ...pendingRef.current.map((p) => ({ ...p, _node: DB_REQUESTS_PATH })),
        ...approvedRef.current.map((p) => ({ ...p, _node: DB_PASSES_PATH })),
      ];
      refreshCurrent();
    };

    const unsubRequests = onValue(
      ref(database, DB_REQUESTS_PATH),
      (snap) => { pendingRef.current = sanitizePassList(snap.val()); mergePasses(); },
      () => { pendingRef.current = []; mergePasses(); }   // node absent yet — no requests have been made
    );

    const unsubPasses = onValue(
      ref(database, DB_PASSES_PATH),
      (snap) => { approvedRef.current = sanitizePassList(snap.val()); mergePasses(); },
      () => { approvedRef.current = []; mergePasses(); }  // node absent yet — nothing approved yet
    );

    /* only NEW rejections notify — and only for the staff member
       currently on the panel, so the operator knows why the options
       reverted */
    const unsubRejected = onValue(
      ref(database, DB_REJECTED_PATH),
      (snap) => {
        const list = sanitizePassList(snap.val());
        if (seenRejectedRef.current) {
          const key = currentKeyRef.current;
          const member = key
            ? staffListRef.current.find((s) => s._id === key) || staffListRef.current.find((s) => s.staffId === key)
            : null;
          if (member) {
            list
              .filter((p) => seenRejectedRef.current.indexOf(p._id) === -1)
              .forEach((p) => {
                if ((p.staffKey && p.staffKey === member._id) || (p.staffId && p.staffId === member.staffId)) {
                  beep(false);
                  showToast(`✕ ${member.name}'s pass request was rejected by the Principal.`, "error");
                }
              });
          }
        }
        seenRejectedRef.current = list.map((p) => p._id);
      },
      () => { if (!seenRejectedRef.current) seenRejectedRef.current = []; }
    );

    return () => { unsubStaff(); unsubRequests(); unsubPasses(); unsubRejected(); };
  }, [refreshCurrent, showToast]);

  /* ================= RFID SCAN ================= */
  const handleScan = useCallback((code) => {
    const norm = normalizeRfid(code);
    if (!norm) return;
    setManualId("");                            // clears only stale text — the box can never be focused during a scan
    const member = staffListRef.current.find((s) => normalizeRfid(s.rfid) === norm) || null;

    if (member) {
      showMember(member);
      setScanResult(true, norm);
      beep(true);
    } else {
      currentKeyRef.current = null;
      setCurrent(null); setView(null);
      setNotFound({ type: "rfid", value: norm });
      setScanResult(false, norm);
      beep(false);
      showToast(`⚠ Card ${norm} is not registered — add the staff member first.`, "error");
    }

    /* every read pauses the scanner: [Next Scan] or 10 s re-arms it */
    startCooldown();
  }, [showMember, setScanResult, showToast, startCooldown]);

  useEffect(() => { scanHandlerRef.current = handleScan; }, [handleScan]);

  /* ================= GLOBAL KEY LISTENER =================
     A card read is a fast burst of characters ending with ENTER — human
     typing never matches that timing.
     The scanner is LIVE only when the desk is free:
       • no form open (ours or a manage-section modal),
       • nobody typing in the manual box,
       • no result under review (card read or manual Find).
     In every other situation machine-speed keystrokes are swallowed
     BEFORE they can reach a focused field, and the single character
     that may have slipped into the field before the burst was
     recognised is put back — so the manual box and every form field
     only ever receive real human keyboard input. The reader's ENTER is
     swallowed too, so it can never submit a form or click a button. */
  useEffect(() => {
    let buf = "";            // characters of a possible scan (live mode)
    let lastKeyAt = 0;       // timestamp of the previous keydown
    let fastRun = 0;         // consecutive machine-speed keys while paused
    let pendingLeak = null;  // { el, value } snapshot of a field that may receive a burst's first char
    let resetTimer = null;

    const snapshotFor = (t) => {
      if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return null;
      if (t.readOnly || t.disabled) return null;
      return { el: t, value: t.value };
    };

    /* put a value back into a (React-controlled) input and let React know */
    const restoreLeak = () => {
      const p = pendingLeak;
      pendingLeak = null;
      if (!p || !p.el || !p.el.isConnected) return;
      if (p.el.value === p.value) return;         // nothing actually leaked
      try {
        const proto = p.el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(p.el, p.value); else p.el.value = p.value;
        p.el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch { /* ignore */ }
    };

    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const now = Date.now();
      const gap = now - lastKeyAt;
      lastKeyAt = now;

      const paused =
        overlayOpenRef.current ||
        cooldownRef.current ||
        manualFocusRef.current ||
        !!document.querySelector(".sm-overlay, .stf-overlay");

      /* ---------- scanner paused — protect whatever is focused ---------- */
      if (paused) {
        if (e.key === "Enter") {
          if (fastRun >= 1 && gap > 0 && gap <= 100) {
            e.preventDefault();                   // the reader's ENTER — never submit / never click
            restoreLeak();
          }
          fastRun = 0;
          pendingLeak = null;
          return;
        }
        if (e.key.length === 1) {
          if (e.repeat) { pendingLeak = null; return; }   // human holding a key down
          if (gap > 0 && gap <= MACHINE_GAP_MS) {
            e.preventDefault();                   // machine-speed char — never reaches the field
            fastRun += 1;
            if (fastRun >= 2) restoreLeak();      // burst confirmed → wipe the char that slipped in
            return;
          }
          fastRun = 0;                            // human speed → allow, but keep a snapshot in case
          pendingLeak = snapshotFor(e.target);    // this was the first char of a burst
          return;
        }
        fastRun = 0;                              // Backspace / arrows / Tab … — normal behaviour
        pendingLeak = null;
        return;
      }

      /* ---------- scanner live ---------- */
      if (e.key === "Enter") {
        const code = buf;
        buf = "";
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        if (code.length >= 4 && gap > 0 && gap <= 100) {
          e.preventDefault();
          if (scanHandlerRef.current) scanHandlerRef.current(code);
        } else if (fastRun >= 1 && gap > 0 && gap <= 100) {
          e.preventDefault();                     // machine ENTER of an unreadable burst — swallow it
        }
        fastRun = 0;
        return;
      }

      if (e.key.length === 1) {
        if (e.repeat) return;
        if (/[a-zA-Z0-9]/.test(e.key)) {
          if (gap > 100) { buf = ""; fastRun = 0; }   // too slow → human typing
          fastRun += 1;
          buf += e.key;
          if (resetTimer) clearTimeout(resetTimer);
          resetTimer = setTimeout(() => { buf = ""; }, 400);
        } else {
          buf = "";                               // punctuation breaks the pattern
          if (gap > 100) fastRun = 0;
        }
        return;
      }

      buf = "";
      fastRun = 0;
    };

    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (resetTimer) clearTimeout(resetTimer); };
  }, []);

  /* ================= MANUAL LOOKUP ================= */
  const handleManualSubmit = (e) => {
    e.preventDefault();
    const q = manualId.trim();
    if (!q) { manualInputRef.current?.focus(); return; }

    const staff = staffListRef.current;
    const ql = q.toLowerCase();
    const member =
      staff.find((s) => s.staffId.toLowerCase() === ql) ||
      staff.find((s) => normalizeRfid(s.rfid) === normalizeRfid(q)) ||
      null;

    if (member) {
      showMember(member);
      setManualId("");
      manualInputRef.current?.blur();             // leave the box …
      beep(true);
      /* … and the SAME review pause as a card read */
      startCooldown();
    } else {
      currentKeyRef.current = null;
      setCurrent(null); setView(null);
      setNotFound({ type: "manual", value: q });
      beep(false);
      showToast(`⚠ No staff member found for "${q}".`, "error");
    }
  };

  /* ================= REQUEST PASS (new) ================= */
  const openRequestForm = () => {
    if (!current) return;
    requestMemberRef.current = current;
    requestPassRef.current = null;
    setRequestMode("new");
    setRequestForm({
      outDate: todayStr(),
      outTime: nextHalfHour(0),          // next half-hour boundary from now
      returnDate: todayStr(),
      returnTime: nextHalfHour(1),
      reason: "",
    });
    setRequestError("");
    setRequestOpen(true);
  };

  /* ================= EDIT A PENDING REQUEST ================= */
  const openEditRequest = () => {
    if (!current || !view || !view.pass) return;
    const p = view.pass;
    requestMemberRef.current = current;
    requestPassRef.current = p;
    setRequestMode("edit");
    const [od, ot] = splitDateTime(p.outAt);
    const [rd, rt] = splitDateTime(p.expectedReturn);
    setRequestForm({
      outDate: od || todayStr(),
      outTime: ot || nextHalfHour(0),
      returnDate: rd || todayStr(),
      returnTime: rt || nextHalfHour(1),
      reason: p.reason || "",
    });
    setRequestError("");
    setRequestOpen(true);
  };

  const closeRequest = () => setRequestOpen(false);

  useEffect(() => { if (requestOpen) setTimeout(() => outDateRef.current?.focus(), 60); }, [requestOpen]);

  const handleRequestChange = (e) => {
    setRequestForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    setRequestError("");
  };

  /* ================= SUBMIT (new request OR edited request) ================= */
  const handleSubmitRequest = () => {
    const member = requestMemberRef.current;
    if (!member) { setRequestOpen(false); return; }

    const reason = requestForm.reason.trim();
    const { outDate, outTime, returnDate, returnTime } = requestForm;

    if (!reason) { setRequestError("Please enter the reason for the pass."); return; }
    if (!outDate || !outTime) { setRequestError("Please fill in the out date and time."); return; }
    if (!returnDate || !returnTime) { setRequestError("Please fill in the expected return date and time."); return; }

    const outAt = parseLocal(`${outDate}T${outTime}`);
    const returnAt = parseLocal(`${returnDate}T${returnTime}`);
    if (!outAt || outAt < new Date()) { setRequestError("Out date & time cannot be in the past."); return; }
    if (!returnAt || returnAt <= outAt) { setRequestError("Expected return must be after the out date & time."); return; }

    const nowIso = new Date().toISOString();

    /* ---- EDIT: update the pending request in place ---- */
    if (requestMode === "edit") {
      const editing = requestPassRef.current;
      if (!editing) { setRequestOpen(false); return; }

      const fresh = passesListRef.current.find((p) => p._id === editing._id);
      /* the Principal may have approved it in another tab / on another
         device in the meantime — then there is nothing to edit, just
         refresh the panel */
      if (!fresh || fresh.status !== "REQUESTED") {
        setRequestOpen(false);
        refreshCurrent();
        showToast("This request was already handled — the panel has been refreshed.", "info");
        return;
      }

      update(ref(database, `${DB_REQUESTS_PATH}/${fresh._id}`), {
        reason,
        outAt: `${outDate}T${outTime}`,
        expectedReturn: `${returnDate}T${returnTime}`,
        editedAt: nowIso,
      })
        .then(() => {
          refreshCurrent();
          beep(true);
          showToast(`✓ Pass request for ${member.name} updated — still waiting for the Principal's approval`, "success");
        })
        .catch(() => showToast("⚠ Could not update the request — check your Firebase connection / rules.", "error"));

      setRequestOpen(false);
      return;
    }

    /* ---- NEW: store the request for the Principal ----
       staffKey / staffId are the exact fields the Staff Manage table
       watches — the table flips to "Pending" the moment this is saved. */
    const pass = {
      _id: uid(),
      staffKey: member._id,
      staffId: member.staffId,
      rfid: normalizeRfid(member.rfid),
      name: member.name,
      department: member.department,
      kind: "STAFF_PASS",
      status: "REQUESTED",
      reason,
      outAt: `${outDate}T${outTime}`,
      expectedReturn: `${returnDate}T${returnTime}`,
      authorizedBy: null,
      createdAt: nowIso,
      requestedAt: nowIso,
      approvedAt: null, approvedBy: null,
      issuedAt: null, printedAt: null, returnedAt: null,
      slipNo: null,                     // assigned when the pass is printed
    };

    set(ref(database, `${DB_REQUESTS_PATH}/${pass._id}`), pass)
      .then(() => {
        refreshCurrent();
        beep(true);
        showToast(`✓ Pass request for ${member.name} sent — waiting for the Principal's approval`, "success");
      })
      .catch(() => showToast("⚠ Could not send the request — check your Firebase connection / rules.", "error"));

    setRequestOpen(false);
  };

  /* ================= CANCEL A PENDING REQUEST ================= */
  /* Withdraws the pending request instantly. The pass is marked
     CANCELLED in Firebase (so it also disappears from the Principal's
     approval desk), the live listener re-resolves the panel in the same
     tick and it flips straight back to the normal IN option — no lag,
     no page reload. */
  const handleCancelRequest = () => {
    if (!current || !view || !view.pass) return;

    const fresh = passesListRef.current.find((p) => p._id === view.pass._id) || view.pass;

    /* the Principal may have approved it in another tab / on another
       device in the meantime — then there is nothing to cancel, just
       refresh the panel */
    if (fresh.status !== "REQUESTED") { refreshCurrent(); return; }

    const now = new Date().toISOString();
    update(ref(database, `${DB_REQUESTS_PATH}/${fresh._id}`), { status: "CANCELLED", cancelledAt: now })
      .then(() => {
        refreshCurrent();
        beep(true);
        showToast(`✓ Pass request for ${current.name} cancelled — normal options restored`, "success");
      })
      .catch(() => showToast("⚠ Could not cancel the request — check your Firebase connection / rules.", "error"));
  };

  /* ================= MARK IN ================= */
  const handleMarkIn = () => {
    if (!current) return;
    const now = new Date().toISOString();
    const active = findActivePass(passesListRef.current, current);
    const openPass = active && active.status === "ISSUED" ? active : null;

    /* close the issued pass (if any) and set the staff member IN — two
       targeted Firebase writes; the pass is written back to the node it
       actually lives in (approved passes live in "staffpass" since the
       Principal's page moves them there) and the panel here and the
       Staff Manage table both update live the moment they land */
    const ops = [setStaffStatus(current, "IN", now)];
    if (openPass) {
      ops.push(update(
        ref(database, `${openPass._node || DB_REQUESTS_PATH}/${openPass._id}`),
        { status: "RETURNED", returnedAt: now }
      ));
    }

    Promise.all(ops)
      .then(() => {
        refreshCurrent();
        beep(true);
        showToast(`✓ ${current.name} marked IN${openPass ? " — pass closed" : ""}`, "success");
      })
      .catch(() => showToast("⚠ Could not mark IN — check your Firebase connection / rules.", "error"));
  };

  /* ================= PRINT AN APPROVED PASS =================
     Printing is possible ONLY after the Principal's approval.
     One click: the pass is marked ISSUED in the node it lives in
     ("staffpass"), a slip number is assigned, the staff member is set
     OUT in the "staff" collection (the Staff Manage table flips to
     "Out" instantly) and the 80 mm slip is printed from a hidden
     iframe — a clean standalone document, nothing else from this page.
     The record is saved BEFORE anything is sent to the printer, so the
     pass is never lost even if printing is blocked. */
  const handlePrintApproved = () => {
    if (!current || !view || !view.pass) return;

    /* freshest copy — the state may have changed in another tab meanwhile */
    const fresh = passesListRef.current.find((p) => p._id === view.pass._id) || view.pass;
    if (fresh.status !== "APPROVED") { refreshCurrent(); return; }

    const slipNo = fresh.slipNo || makeSlipNo(passesListRef.current);
    const now = new Date().toISOString();
    const issued = { ...fresh, slipNo, issuedAt: now };

    update(ref(database, `${fresh._node || DB_REQUESTS_PATH}/${fresh._id}`), {
      status: "ISSUED",
      slipNo,
      issuedAt: now,
      issuedBy: "Gate Desk",
      printedAt: now,
    })
      .then(() => setStaffStatus(current, "OUT", now))
      .then(() => {
        printSlip(issued);
        refreshCurrent();
        beep(true);
        showToast(`✓ Pass issued for ${current.name} — slip ${slipNo} · marked OUT`, "success");
      })
      .catch(() => showToast("⚠ Could not issue the pass — check your Firebase connection / rules.", "error"));
  };

  /* ================= ESC closes the open form ================= */
  useEffect(() => {
    if (!requestOpen) return;
    const onEsc = (e) => { if (e.key === "Escape") setRequestOpen(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [requestOpen]);

  /* ================= RENDER ================= */
  const scannerLive = !requestOpen && !cooldown && !manualFocus;
  const requestMember = requestMemberRef.current;
  const pass = view && view.pass;
  const scanFlash = scan.status === "ok" || scan.status === "error";
  const scanTone = scanFlash
    ? (scan.status === "ok" ? "sp-scan-ok" : "sp-scan-error")
    : ((cooldown || manualFocus) ? "sp-scan-paused" : "");

  return (
    <section className="sp">
      {/* ---------- header ---------- */}
      <header className="sp-header">
        <div>
          <h1 className="sp-title"></h1>
          <p className="sp-subtitle"></p>
        </div>

        <div className="sp-live">
          <span className={`sp-live-dot ${scannerLive ? "" : "sp-live-dot-paused"}`} />
          <span className={`sp-live-label ${scannerLive ? "" : "sp-live-label-paused"}`}>
            {scannerLive ? "Scanner ready" : "Scanner paused"}
          </span>
          <span className="sp-live-clock">
            {clock.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })}
            {"  ·  "}
            {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
      </header>

      <div className="sp-card">
        {/* ---------- scanner row (fixed height) ---------- */}
        <div className="sp-scanner">
          <div
            className={`sp-scanbox ${scanTone}`}
            role="status"
            aria-live="polite"
          >
            <span className="sp-scan-icon">
              {scanFlash
                ? (scan.status === "ok" ? "✅" : "⚠️")
                : (cooldown || manualFocus) ? "⏸️" : "📡"}
            </span>
            <div className="sp-scan-text">
              <span className="sp-scan-label">
                {scanFlash
                  ? (scan.status === "ok" ? "Card read" : "Unknown card")
                  : (cooldown || manualFocus) ? "Scanner paused" : "RFID card scan"}
              </span>
              <span className="sp-scan-sub">
                {scan.status === "ok" && (
                  <><code className="sp-scan-code">{scan.code}</code> — staff member loaded below{cooldown ? ` · next scan in ${cooldownLeft}s` : ""}</>
                )}
                {scan.status === "error" && (
                  <><code className="sp-scan-code">{scan.code}</code> — not registered{cooldown ? ` · next scan in ${cooldownLeft}s` : ""}</>
                )}
                {scan.status === "ready" && (cooldown ? (
                  <>Result shown below — press <strong>Next Scan</strong> or wait {cooldownLeft}s</>
                ) : manualFocus ? (
                  <>Paused while you type — only the keyboard fills this box</>
                ) : !scan.code ? "Always live — tap a card on the reader" : (
                  <>Last read — <code className="sp-scan-code">{scan.code}</code></>
                ))}
              </span>
            </div>

            {cooldown && (
              <button type="button" className="sp-btn sp-btn-ghost sp-scan-next" onClick={handleNextScan}>
                Next Scan ▸
              </button>
            )}
          </div>

          <form className="sp-manual" onSubmit={handleManualSubmit}>
            <span className="sp-manual-label">Or enter manually</span>
            <div className="sp-manual-form">
              <input
                ref={manualInputRef}
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                onFocus={() => { manualFocusRef.current = true; setManualFocus(true); }}
                onBlur={() => { manualFocusRef.current = false; setManualFocus(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault(); e.stopPropagation();
                    setManualId("");
                    manualInputRef.current?.blur();   // Esc leaves the box → scanner back live
                  }
                }}
                placeholder="Staff ID (or RFID)…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Staff ID number"
              />
              <button type="submit" className="sp-btn sp-btn-ghost">Find</button>
            </div>
          </form>
        </div>

        {/* ---------- result panel — FIXED height, never changes ---------- */}
        <div className="sp-panel">
          {current && view ? (
            <div className="sp-view">
              {/* staff details — top zone */}
              <div className="sp-details">
                <div className="sp-info">
                  <span className="sp-avatar">{getInitials(current.name)}</span>
                  <div className="sp-identity">
                    <div className="sp-name-row">
                      <h3 className="sp-name">{current.name}</h3>
                      <span className={`sp-badge sp-badge-${view.state === "OUT_PASS" ? "out" : view.state.toLowerCase()}`}>
                        {view.state === "OUT_PASS" ? "OUT" : view.state}
                      </span>
                      {view.state === "OUT_PASS" && <span className="sp-chip sp-chip-onpass">ON PASS</span>}
                    </div>
                    <div className="sp-meta">
                      <span className="sp-chip">{current.department}</span>
                      <span className="sp-chip">{current.staffId}</span>
                      <span className="sp-chip sp-chip-mono">{normalizeRfid(current.rfid)}</span>
                    </div>
                  </div>
                  <div className="sp-since">
                    <span className="sp-since-label">Last movement</span>
                    <span className="sp-since-value">{current.lastMovement ? fmtDateTime(current.lastMovement) : "—"}</span>
                  </div>
                </div>

                {/* open pass details (request / approval / issued) */}
                {pass && (
                  <div className={`sp-passinfo sp-passinfo-${pass.status.toLowerCase()}`}>
                    <div className="sp-passinfo-head">
                      <span className="sp-passinfo-title">
                        {pass.status === "REQUESTED" && "⏳ Pass request — pending approval"}
                        {pass.status === "APPROVED" && "✅ Pass approved — ready to print"}
                        {pass.status === "ISSUED" && "🎫 Pass issued"}
                      </span>
                      {pass.slipNo && <span className="sp-passinfo-slip">Slip {pass.slipNo}</span>}
                    </div>
                    <div className="sp-passinfo-grid">
                      <div className="sp-stat sp-stat-reason" title={pass.reason}>
                        <span className="sp-stat-label">Reason</span>
                        <span className="sp-stat-value">{pass.reason}</span>
                      </div>
                      <div className="sp-stat">
                        <span className="sp-stat-label">Out at</span>
                        <span className="sp-stat-value">{fmtExpected(pass.outAt)}</span>
                      </div>
                      <div className="sp-stat">
                        <span className="sp-stat-label">Expected return</span>
                        <span className="sp-stat-value">{fmtExpected(pass.expectedReturn)}</span>
                      </div>
                      {pass.status === "REQUESTED" && (
                        <div className="sp-stat">
                          <span className="sp-stat-label">Requested</span>
                          <span className="sp-stat-value">{fmtDateTime(pass.requestedAt || pass.createdAt)}</span>
                        </div>
                      )}
                      {pass.status === "APPROVED" && (
                        <div className="sp-stat">
                          <span className="sp-stat-label">Approved by</span>
                          <span className="sp-stat-value">{pass.approvedBy || "Principal"}</span>
                        </div>
                      )}
                      {pass.status === "APPROVED" && (
                        <div className="sp-stat">
                          <span className="sp-stat-label">Approved at</span>
                          <span className="sp-stat-value">{fmtDateTime(pass.approvedAt)}</span>
                        </div>
                      )}
                      {pass.status === "ISSUED" && (
                        <div className="sp-stat">
                          <span className="sp-stat-label">Issued</span>
                          <span className="sp-stat-value">{fmtDateTime(pass.issuedAt)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* action zone — reserved height, buttons swap inside it */}
              <div className="sp-actions">
                {view.state === "IN" && (
                  <button className="sp-btn sp-btn-primary sp-btn-xl" onClick={openRequestForm}>
                    <span className="sp-btn-line">📝 Request Pass</span>

                  </button>
                )}

                {view.state === "OUT" && (
                  <button className="sp-btn sp-btn-success sp-btn-xl" onClick={handleMarkIn}>
                    <span className="sp-btn-line">✅ Mark In</span>

                  </button>
                )}

                {view.state === "OUT_PASS" && (
                  <button className="sp-btn sp-btn-success sp-btn-xl" onClick={handleMarkIn}>
                    <span className="sp-btn-line">✅ Mark In</span>

                  </button>
                )}

                {view.state === "REQUESTED" && (
                  <>
                    <div className="sp-action-note">
                      ⏳ A pass has been requested and is waiting for the Principal's approval.

                    </div>
                    <button className="sp-btn sp-btn-ghost sp-btn-xl" onClick={openEditRequest}>
                      <span className="sp-btn-line">✏️ Edit Request</span>

                    </button>
                    <button className="sp-btn sp-btn-danger sp-btn-xl" onClick={handleCancelRequest}>
                      <span className="sp-btn-line">✖ Cancel Request</span>

                    </button>
                  </>
                )}

                {view.state === "APPROVED" && (
                  <button className="sp-btn sp-btn-primary sp-btn-xl" onClick={handlePrintApproved}>
                    <span className="sp-btn-line">🖨 Print Pass</span>

                  </button>
                )}
              </div>
            </div>
          ) : notFound ? (
            /* ---------- unknown card / ID ---------- */
            <div className="sp-center">
              <div className="sp-center-icon sp-center-error">⚠️</div>
              <h3 className="sp-center-title">Staff member not found</h3>
              <p className="sp-center-sub">
                No staff member is registered with {notFound.type === "rfid" ? "RFID card" : "ID"}{" "}
                <strong>{notFound.value}</strong>.
              </p>
              <p className="sp-center-hint">Register the staff member on the Staff page first, then scan again.</p>
            </div>
          ) : (
            /* ---------- idle ---------- */
            <div className="sp-center">
              <div className="sp-center-icon">👔</div>
              <h3 className="sp-center-title">Waiting for a card</h3>


            </div>
          )}
        </div>
      </div>

      {/* datalist shared by the request form */}
      <datalist id="sp-reason-options">
        {REASON_OPTIONS.map((r) => <option key={r} value={r} />)}
      </datalist>

      {/* ---------- request / edit pass modal ---------- */}
      {requestOpen && requestMember && (
        <div className="sp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRequest(); }}>
          <div className="sp-modal" role="dialog" aria-modal="true" aria-label={requestMode === "edit" ? "Edit pass request" : "Request pass"}>
            <div className="sp-modal-head">
              <h2>{requestMode === "edit" ? "✏️ Edit Pass Request" : "📝 Request Pass"}</h2>
              <button className="sp-modal-close" onClick={closeRequest} aria-label="Close">×</button>
            </div>

            <div className="sp-modal-body">
              {/* auto-filled, read-only identity of the staff member */}
              <div className="sp-modal-member">
                <span className="sp-modal-avatar">{getInitials(requestMember.name)}</span>
                <div className="sp-modal-member-text">
                  <strong>{requestMember.name}</strong>
                  <span>{requestMember.department} · {requestMember.staffId}</span>
                </div>
              </div>

              <div className="sp-modal-fields">
                <div className="sp-field-row">
                  <div className="sp-field">
                    <label htmlFor="sp-out-date">Out date *</label>
                    <input
                      id="sp-out-date" ref={outDateRef} name="outDate" type="date" min={todayStr()}
                      value={requestForm.outDate} onChange={handleRequestChange}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); outTimeRef.current?.focus(); } }}
                      className="sp-input"
                    />
                  </div>
                  <div className="sp-field">
                    <label htmlFor="sp-out-time">Out time *</label>
                    <input
                      id="sp-out-time" ref={outTimeRef} name="outTime" type="time"
                      value={requestForm.outTime} onChange={handleRequestChange}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); returnDateRef.current?.focus(); } }}
                      className="sp-input"
                    />
                  </div>
                </div>

                <div className="sp-field-row">
                  <div className="sp-field">
                    <label htmlFor="sp-return-date">Expected return date *</label>
                    <input
                      id="sp-return-date" ref={returnDateRef} name="returnDate" type="date"
                      min={requestForm.outDate || todayStr()}
                      value={requestForm.returnDate} onChange={handleRequestChange}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); returnTimeRef.current?.focus(); } }}
                      className="sp-input"
                    />
                  </div>
                  <div className="sp-field">
                    <label htmlFor="sp-return-time">Expected return time *</label>
                    <input
                      id="sp-return-time" ref={returnTimeRef} name="returnTime" type="time"
                      value={requestForm.returnTime} onChange={handleRequestChange}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); reasonRef.current?.focus(); } }}
                      className="sp-input"
                    />
                  </div>
                </div>

                <div className="sp-field">
                  <label htmlFor="sp-reason">Reason for pass *</label>
                  <input
                    id="sp-reason" ref={reasonRef} name="reason" list="sp-reason-options"
                    value={requestForm.reason} onChange={handleRequestChange}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSubmitRequest(); } }}
                    placeholder="e.g. Official duty / medical appointment" autoComplete="off" className="sp-input"
                  />
                </div>
              </div>

              {requestError && <div className="sp-alert sp-alert-error">⚠ {requestError}</div>}


            </div>

            <div className="sp-modal-footer">
              <button className="sp-btn sp-btn-ghost" onClick={closeRequest}>Cancel</button>
              <button className="sp-btn sp-btn-primary" onClick={handleSubmitRequest}>
                {requestMode === "edit" ? "💾 Save Changes" : "📨 Send Request"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- toast ---------- */}
      {toast && (
        <div key={toast.id} className={`sp-toast sp-toast-${toast.type}`}>{toast.text}</div>
      )}
    </section>
  );
}