import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ref, onValue, set, update, remove } from "firebase/database";
import { database } from "../../../firebase/config"; // ← src/firebase/config — adjust the relative path if this component sits deeper (e.g. "../../firebase/config")
import "./StudentManage.css";

/* =====================================================================
   STUDENT MANAGE — student master data sheet  (REAL-TIME STATUS)
   ---------------------------------------------------------------------
   • Excel-style inline editing — click any cell, type, Enter saves ·
     Esc cancels · Tab moves to the next cell
   • Full undo / redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) — undo/redo only
     ever touches master data; presence statuses always stay live
   • "Add Student" modal with RFID "Tap Card" capture
   • Bulk CSV import
   • Smart search across Name / ID No / Class / RFID / Status
   • Paginated data sheet: 50 rows per page, newest students on top
   • DATA LIVES IN FIREBASE REALTIME DATABASE  ← node "students"
       Stored per student: Name, ID No, Class, RFID No, Status
       (+ internal _id / createdAt / lastMovement used for the key,
        the "newest first" ordering and the live status overlay)
       · an onValue listener keeps this sheet in sync in REAL TIME —
         changes made here, in another tab, or by any other component
         or device appear in the table instantly (live update)
       · every add / edit / delete / import / undo / redo is a
         targeted write (set / update / remove) straight to Firebase,
         so this page can never clobber someone else's change
   • REAL-TIME STATUS SYNC
       The Status column is resolved on every render:
         · passes (Firebase "passes" node, plus the legacy
           sms_passes_v1 localStorage store the Pass desk still uses):
               active REQUESTED pass → “Requested” (amber, waiting
                                        for the Principal)
               active APPROVED  pass → “Approved”  (blue, ready to
                                        print at the gate)
               active ISSUED    pass → “Out”       (out on the
                                        printed day pass)
         · the student's own status field in Firebase (In / Out)
       Rows whose status just changed flash blue for a moment.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DB_STUDENTS_PATH = "students";       // Firebase Realtime Database node for students
const DB_PASSES_PATH   = "passes";         // Firebase node for gate passes (status overlay) — rename if your Pass desk uses another node
const STORAGE_KEY      = "sms_students_v1"; // legacy — no longer the source of truth (kept only for the harmless wrap below)
const PASSES_KEY       = "sms_passes_v1";  // legacy localStorage passes — still watched so older Pass-desk components stay live

const PAGE_SIZE = 50;                       // rows per page (fixed)
const EMPTY_FORM = { rfid: "", studentId: "", name: "", className: "" };

/* ---------- student status — set by the system, never asked ---------- */
const STATUS_VALUES = ["IN", "OUT", "REQUESTED", "APPROVED"];   // searchable
const DEFAULT_STATUS = "IN";                // every student starts as "In"
const STATUS_META = {
  IN:        { label: "In",        cls: "sm-status-in" },
  OUT:       { label: "Out",       cls: "sm-status-out" },
  REQUESTED: { label: "Requested", cls: "sm-status-requested" },
  APPROVED:  { label: "Approved",  cls: "sm-status-approved" },
};

/* a pass in one of these states overrides the plain student status */
const ACTIVE_PASS_STATUSES = ["REQUESTED", "APPROVED", "ISSUED"];

const EDITABLE_FIELDS = ["name", "studentId", "className", "rfid"];   // status is read-only
const FIELD_LABELS = { name: "Name", studentId: "ID No", className: "Class", rfid: "RFID No" };

const CSV_FIELDS = ["rfid", "studentId", "name", "className"];        // status is NOT a CSV column
const CSV_HEADER_MAP = {
  rfid: "rfid", "rfid no": "rfid", "rfidno": "rfid", "rfid number": "rfid",
  card: "rfid", "card no": "rfid", "card number": "rfid",
  id: "studentId", "id no": "studentId", "idno": "studentId",
  "student id": "studentId", "studentid": "studentId", "admission no": "studentId",
  name: "name", "student name": "name", "full name": "name",
  class: "className", classname: "className", "class name": "className",
  grade: "className", division: "className",
};

const SAMPLE_CSV = [
  "RFID No,ID No,Name,Class",
  "04A2918F,STU-1042,Aaron Mathew,IX A",
  "52BC7D31,STU-2048,Anna Jose,VIII A",
  "9F3E5A02,STU-3071,David Paul,X B",
  "C71D4B9E,STU-4105,Maria Thomas,VII C",
].join("\n");

/* ---------------- LEGACY SAME-TAB NOTIFIER (localStorage) ----------------
   Kept ONLY so writes the (older) Pass Issue desk makes to the legacy
   sms_passes_v1 localStorage store in THIS tab are picked up instantly
   for the Status overlay. Students themselves now come from Firebase. */
const STORE_EVENT = "sms:stores-changed";

function installStoreNotifier() {
  if (typeof window === "undefined" || window.__smsStoreNotifier) return;
  window.__smsStoreNotifier = true;
  try {
    const proto = window.Storage && window.Storage.prototype;
    if (!proto || !proto.setItem) return;
    const origSetItem = proto.setItem;
    let scheduled = false;
    proto.setItem = function (key, value) {
      const res = origSetItem.call(this, key, value);
      if (key === STORAGE_KEY || key === PASSES_KEY) {
        if (!scheduled) {
          scheduled = true;
          setTimeout(() => {
            scheduled = false;
            try { window.dispatchEvent(new CustomEvent(STORE_EVENT)); } catch { /* ignore */ }
          }, 0);
        }
      }
      return res;
    };
  } catch { /* wrapping blocked — the 150 ms poll still keeps us live */ }
}
installStoreNotifier();

/* ---------------- helpers ---------------- */
const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// "04:a2:19:8f" and "04A2198F" are treated as the same card
const normalizeRfid = (v) =>
  String(v || "").trim().toUpperCase().replace(/[\s:\-]/g, "");

// "in" / "In" / "IN" → "IN" · anything missing or unknown → "IN" (default)
const normalizeStatus = (v) => {
  const s = String(v || "").trim().toUpperCase();
  return STATUS_VALUES.includes(s) ? s : DEFAULT_STATUS;
};

const getInitials = (name) =>
  String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("") || "?";

/* page numbers for the pager —  1 … 4 5 6 … 20  */
function getPageItems(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const items = [1];
  if (current > 3) items.push("…");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) items.push(i);
  if (current < total - 2) items.push("…");
  items.push(total);
  return items;
}

/* tiny CSV parser — handles quoted fields, embedded commas and CRLF */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const src = String(text || "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

/* read + sanitize the students stored in Firebase
   ({ "<_id>": { …student } } → clean array, defaults applied) */
function sanitizeStudents(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  const now = Date.now();
  return Object.entries(val).map(([key, s], i) => ({
    ...s,
    _id: String(s._id || key),
    rfid: normalizeRfid(s.rfid),
    studentId: String(s.studentId || "").trim(),
    name: String(s.name || "").trim(),
    className: String(s.className || "").trim(),
    status: normalizeStatus(s.status),          // missing / invalid → "IN"
    lastMovement: s.lastMovement || null,
    createdAt: s.createdAt || new Date(now - i * 60000).toISOString(),
  }));
}

/* Firebase passes node → array (absent node → []) */
function sanitizePasses(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "object") return Object.values(val);
  return [];
}

/* read the (legacy) gate desk's pass records from localStorage */
function readPasses() {
  try {
    const a = JSON.parse(localStorage.getItem(PASSES_KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/* master-data snapshots (undo / redo) must never roll the gate's presence
   statuses back — statuses are overlaid from the live Firebase copy on
   restore. `live` is the freshest list from the onValue listener. */
function overlayLiveStatuses(list, live) {
  const byId = new Map((live || []).map((s) => [s._id, s]));
  return list.map((s) => {
    const cur = byId.get(s._id);
    return cur ? { ...s, status: cur.status, lastMovement: cur.lastMovement } : s;
  });
}

export default function StudentManage() {
  /* ================= STATE ================= */
  const [students, setStudents] = useState([]);        // live copy of Firebase "students"
  const [dbLoaded, setDbLoaded] = useState(false);     // first Firebase snapshot arrived?
  const [passes, setPasses] = useState(readPasses);    // legacy localStorage passes (status overlay)
  const [fbPasses, setFbPasses] = useState([]);        // Firebase "passes" (status overlay)
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [editing, setEditing] = useState(null);        // { id, field }
  const [editValue, setEditValue] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [captureMode, setCaptureMode] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [toast, setToast] = useState(null);

  const [undoStack, setUndoStack] = useState([]);      // [{ students, label }]
  const [redoStack, setRedoStack] = useState([]);

  const [flash, setFlash] = useState({});              // { studentId: true } → row just changed status

  /* ================= REFS ================= */
  const studentsRef = useRef(students);
  useEffect(() => { studentsRef.current = students; }, [students]);

  const lastPassesRawRef = useRef(localStorage.getItem(PASSES_KEY)); // legacy pass change detector

  const editingRef = useRef(null);
  const editValueRef = useRef("");

  const fileRef = useRef(null);
  const rfidInputRef = useRef(null);
  const idInputRef = useRef(null);
  const nameInputRef = useRef(null);
  const classInputRef = useRef(null);

  const bufferRef = useRef("");            // RFID keystroke buffer (tap card)
  const bufferTimerRef = useRef(null);
  const toastTimerRef = useRef(null);
  const flashTimerRef = useRef(null);
  const prevStatusRef = useRef(null);      // studentId → status key shown last render

  /* ================= TOAST ================= */
  const showToast = useCallback((text, type = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 3800);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  /* ================= FIREBASE REAL-TIME SYNC =================
     One live subscription to the "students" node replaces all the old
     polling: the very first snapshot loads the sheet, and every later
     change — made here, in another tab, or by any other component or
     device — arrives instantly and the table re-renders by itself. */
  useEffect(() => {
    const unsubStudents = onValue(
      ref(database, DB_STUDENTS_PATH),
      (snap) => {
        const fresh = sanitizeStudents(snap.val());
        studentsRef.current = fresh;
        setStudents(fresh);
        setDbLoaded(true);
      },
      (err) => {
        setDbLoaded(true);
        showToast(`⚠ Firebase sync error: ${err.message}`, "error");
      }
    );
    /* optional live feed of gate passes for the Status overlay */
    const unsubPasses = onValue(
      ref(database, DB_PASSES_PATH),
      (snap) => setFbPasses(sanitizePasses(snap.val())),
      () => { /* node absent / not readable — the base statuses still work */ }
    );
    return () => { unsubStudents(); unsubPasses(); };
  }, [showToast]);

  /* ================= LEGACY PASS SYNC (localStorage) =================
     The (older) Pass Issue desk may still write sms_passes_v1 to
     localStorage; keep watching it so the Status overlay stays live
     for both the legacy and the Firebase pass stores. */
  const syncFromStore = useCallback(() => {
    const rawP = localStorage.getItem(PASSES_KEY);
    if (rawP === lastPassesRawRef.current) return;
    lastPassesRawRef.current = rawP;
    setPasses(readPasses());
  }, []);

  useEffect(() => {
    const sync = () => syncFromStore();

    const onStorage = (e) => {
      if (!e.key || e.key === PASSES_KEY) sync();
    };
    const onVisibility = () => { if (document.visibilityState === "visible") sync(); };

    window.addEventListener(STORE_EVENT, sync);            // same-tab, instant
    window.addEventListener("storage", onStorage);         // cross-tab, instant
    window.addEventListener("focus", sync);
    window.addEventListener("sms:students-changed", sync); // optional extras
    window.addEventListener("sms:passes-changed", sync);   //   (harmless if never fired)
    document.addEventListener("visibilitychange", onVisibility);
    const poll = setInterval(sync, 150);                   // safety net

    return () => {
      window.removeEventListener(STORE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", sync);
      window.removeEventListener("sms:students-changed", sync);
      window.removeEventListener("sms:passes-changed", sync);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(poll);
    };
  }, [syncFromStore]);

  /* ================= DERIVED STATUS (live) =================
     both pass sources (legacy localStorage + Firebase) are merged, then
     the newest ACTIVE pass per student is found by _id or studentId */
  const allPasses = useMemo(
    () => [...(passes || []), ...(fbPasses || [])],
    [passes, fbPasses]
  );

  const activePassMap = useMemo(() => {
    const m = new Map();
    allPasses.forEach((p) => {
      if (ACTIVE_PASS_STATUSES.indexOf(p.status) === -1) return;
      const put = (key) => {
        if (!key) return;
        const prev = m.get(key);
        if (!prev || new Date(p.createdAt || 0) >= new Date(prev.createdAt || 0)) m.set(key, p);
      };
      put(p.studentKey ? "id:" + p.studentKey : null);
      put(p.studentId ? "sid:" + p.studentId : null);
    });
    return m;
  }, [allPasses]);

  /* what the Status column shows right now — the gate desk's truth:
       active REQUESTED pass → REQUESTED (waiting for the Principal)
       active APPROVED  pass → APPROVED  (ready to print at the gate)
       active ISSUED    pass → OUT       (out on a printed day pass)
       otherwise          → student.status in Firebase (IN / OUT)      */
  const resolveStatus = useCallback((student) => {
    const pass = activePassMap.get("id:" + student._id) || activePassMap.get("sid:" + student.studentId) || null;
    if (pass) {
      if (pass.status === "REQUESTED") return { key: "REQUESTED", pass };
      if (pass.status === "APPROVED") return { key: "APPROVED", pass };
      return { key: "OUT", pass };            // ISSUED → out on a day pass
    }
    return { key: normalizeStatus(student.status), pass: null };
  }, [activePassMap]);

  /* flash rows whose visible status just changed (e.g. the gate desk
     issued a pass) so the update is easy to spot */
  useEffect(() => {
    const next = new Map();
    students.forEach((s) => next.set(s._id, resolveStatus(s).key));
    const prev = prevStatusRef.current;
    if (prev) {
      const changed = [];
      next.forEach((v, k) => { if (prev.has(k) && prev.get(k) !== v) changed.push(k); });
      if (changed.length > 0) {
        setFlash((f) => {
          const nf = { ...f };
          changed.forEach((k) => { nf[k] = true; });
          return nf;
        });
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlash({}), 1800);
      }
    }
    prevStatusRef.current = next;
  }, [students, resolveStatus]);

  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);

  /* ================= DERIVED (filter · sort · paginate) ================= */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = students;
    if (q) {
      const qn = normalizeRfid(q);
      const qs = q.toUpperCase();                 // for status matching
      list = students.filter((s) => {
        if (s.name.toLowerCase().includes(q)) return true;
        if (s.studentId.toLowerCase().includes(q)) return true;
        if (s.className.toLowerCase().includes(q)) return true;
        if (normalizeRfid(s.rfid).includes(qn)) return true;
        const st = resolveStatus(s).key;         // "in", "out", "requested", "approved"…
        return st.includes(qs) || STATUS_META[st].label.toUpperCase().includes(qs);
      });
    }
    /* newest first */
    return [...list].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [students, search, resolveStatus]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  const pageRows = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  );

  const pageItems = useMemo(() => getPageItems(page, totalPages), [page, totalPages]);

  /* keep the page number valid when the list shrinks */
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const startIdx = filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endIdx = Math.min(page * PAGE_SIZE, filtered.length);
  const goPage = (p) => setPage(Math.min(Math.max(1, p), totalPages));

  /* ================= UNDO / REDO HISTORY ================= */
  const pushHistory = useCallback((label) => {
    /* snapshot the FRESHEST committed Firebase state (pre-change) */
    setUndoStack((st) => [...st.slice(-49), { students: [...studentsRef.current], label }]);
    setRedoStack([]);
  }, []);

  /* write a full snapshot back to Firebase as ONE atomic multi-path
     update: every snapshot student is (re)written, and any student that
     was added after the snapshot is removed (null deletes that node) */
  const applySnapshot = useCallback((list) => {
    const current = studentsRef.current;
    const restored = overlayLiveStatuses(list, current);   // statuses stay live
    const keepIds = new Set(restored.map((s) => s._id));
    const updates = {};
    restored.forEach((s) => { updates[s._id] = s; });
    current.forEach((s) => { if (!keepIds.has(s._id)) updates[s._id] = null; });
    if (Object.keys(updates).length === 0) return;
    return update(ref(database, DB_STUDENTS_PATH), updates);
  }, []);

  const cancelEdit = useCallback(() => {
    editingRef.current = null;
    setEditing(null);
  }, []);

  /* ================= INLINE (EXCEL-LIKE) EDITING ================= */
  const commitEdit = useCallback(() => {
    const ed = editingRef.current;
    if (!ed) return;
    const raw = editValueRef.current;
    editingRef.current = null;
    setEditing(null);

    const { id, field } = ed;
    const value = field === "rfid" ? normalizeRfid(raw) : String(raw || "").trim();

    /* always validate against the FRESHEST Firebase copy, so a status the
       gate desk wrote in the meantime is preserved — never overwritten */
    const fresh = studentsRef.current;
    const student = fresh.find((s) => s._id === id);
    if (!student) return;

    const original = field === "rfid"
      ? normalizeRfid(student.rfid)
      : String(student[field] ?? "").trim();
    if (value === original) return;                     // nothing changed

    if (!value) {
      showToast(`⚠ ${FIELD_LABELS[field]} cannot be empty — change reverted.`, "error");
      return;
    }
    if (field === "rfid") {
      const dup = fresh.find((s) => s._id !== id && normalizeRfid(s.rfid) === value);
      if (dup) { showToast(`⚠ RFID "${value}" is already used by ${dup.name} — change reverted.`, "error"); return; }
    }
    if (field === "studentId") {
      const dup = fresh.find((s) => s._id !== id && s.studentId.toLowerCase() === value.toLowerCase());
      if (dup) { showToast(`⚠ ID No "${value}" already exists (${dup.name}) — change reverted.`, "error"); return; }
    }

    pushHistory(`Edit — ${student.name}`);
    /* targeted write: only this ONE field of this ONE student changes */
    update(ref(database, `${DB_STUDENTS_PATH}/${id}`), { [field]: value })
      .then(() => showToast(`✓ ${FIELD_LABELS[field]} updated for ${student.name}`, "success"))
      .catch(() => showToast("⚠ Could not save the change — check your Firebase connection / rules.", "error"));
  }, [pushHistory, showToast]);

  const beginEdit = useCallback((id, field, initial) => {
    commitEdit();                                       // save any pending cell first
    editingRef.current = { id, field };
    editValueRef.current = initial;
    setEditing({ id, field });
    setEditValue(initial);
  }, [commitEdit]);

  const handleCellClick = (student, field) => {
    if (editing && editing.id === student._id && editing.field === field) return;
    const initial = field === "rfid" ? normalizeRfid(student.rfid) : String(student[field] ?? "");
    beginEdit(student._id, field, initial);
  };

  const handleEditChange = (e) => {
    editValueRef.current = e.target.value;
    setEditValue(e.target.value);
  };

  /* Tab moves to the next editable cell, exactly like a spreadsheet */
  const commitAndMove = (dir, rowId, field) => {
    const rowIndex = pageRows.findIndex((s) => s._id === rowId);
    const fieldIndex = EDITABLE_FIELDS.indexOf(field);
    let nextField = fieldIndex + dir;
    let nextRow = rowIndex;
    if (nextField >= EDITABLE_FIELDS.length) { nextField = 0; nextRow = rowIndex + 1; }
    else if (nextField < 0) { nextField = EDITABLE_FIELDS.length - 1; nextRow = rowIndex - 1; }
    commitEdit();
    if (nextRow < 0 || nextRow >= pageRows.length) return;
    const target = pageRows[nextRow];
    const fName = EDITABLE_FIELDS[nextField];
    const initial = fName === "rfid" ? normalizeRfid(target.rfid) : String(target[fName] ?? "");
    beginEdit(target._id, fName, initial);
  };

  const isEditing = (s, field) => editing && editing.id === s._id && editing.field === field;

  const renderEditor = (field) => (
    <input
      className={`sm-cell-input ${field === "rfid" ? "sm-cell-input-mono" : ""}`}
      value={editValue}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={handleEditChange}
      onBlur={commitEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
        else if (e.key === "Tab") {
          e.preventDefault();
          commitAndMove(e.shiftKey ? -1 : 1, editing.id, editing.field);
        }
      }}
      spellCheck={false}
      autoComplete="off"
    />
  );

  /* live status pill — resolved fresh from the students + passes stores */
  const renderStatus = (s) => {
    const r = resolveStatus(s);
    const meta = STATUS_META[r.key];
    const title =
      r.key === "REQUESTED" ? "Day pass requested — waiting for the Principal's approval" :
      r.key === "APPROVED"  ? "Day pass approved — ready to be printed" :
      (r.key === "OUT" && r.pass)
        ? `Out on a day pass${r.pass.slipNo ? " — slip " + r.pass.slipNo : ""}`
        : `Status: ${meta.label}`;
    return (
      <span className={`sm-status ${meta.cls}`} title={title}>
        <span className="sm-status-dot" aria-hidden="true" />
        {meta.label}
      </span>
    );
  };

  /* ================= UNDO / REDO ================= */
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) { showToast("Nothing left to undo.", "info"); return; }
    const last = undoStack[undoStack.length - 1];
    const current = [...studentsRef.current];

    setUndoStack((st) => st.slice(0, -1));
    setRedoStack((st) => [...st, { students: current, label: last.label }]);
    /* restore master data only — presence statuses stay as the gate desk set them */
    Promise.resolve(applySnapshot(last.students))
      .catch(() => showToast("⚠ Undo could not be saved — check your Firebase connection / rules.", "error"));
    cancelEdit();
    showToast(`↩ Undone: ${last.label}`, "info");
  }, [undoStack, cancelEdit, showToast, applySnapshot]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) { showToast("Nothing to redo.", "info"); return; }
    const next = redoStack[redoStack.length - 1];
    const current = [...studentsRef.current];

    setRedoStack((st) => st.slice(0, -1));
    setUndoStack((st) => [...st, { students: current, label: next.label }]);
    Promise.resolve(applySnapshot(next.students))
      .catch(() => showToast("⚠ Redo could not be saved — check your Firebase connection / rules.", "error"));
    cancelEdit();
    showToast(`↪ Redone: ${next.label}`, "info");
  }, [redoStack, cancelEdit, showToast, applySnapshot]);

  /* ================= ADD-STUDENT MODAL ================= */
  const openModal = useCallback(() => {
    commitEdit();
    setForm(EMPTY_FORM);
    setFormError("");
    setCaptureMode(false);
    setModalOpen(true);
    setTimeout(() => rfidInputRef.current?.focus(), 60);
  }, [commitEdit]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setCaptureMode(false);
    setForm(EMPTY_FORM);
    setFormError("");
    clearTimeout(bufferTimerRef.current);
    bufferRef.current = "";
  }, []);

  const startCapture = () => {
    setFormError("");
    setCaptureMode(true);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  };

  const stopCapture = () => setCaptureMode(false);

  /* a scanned card code lands in the RFID field automatically */
  const applyCapturedRfid = useCallback((rawCode) => {
    const code = normalizeRfid(rawCode);
    if (!code) return;
    setForm((f) => ({ ...f, rfid: code }));
    setFormError("");
    setCaptureMode(false);
    clearTimeout(bufferTimerRef.current);
    bufferRef.current = "";
    setTimeout(() => idInputRef.current?.focus(), 50);
  }, []);

  const handleFormChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
    setFormError("");
  };

  const handleAdd = () => {
    const rfid = normalizeRfid(form.rfid);
    const studentId = form.studentId.trim();
    const name = form.name.trim();
    const className = form.className.trim();

    if (!rfid || !studentId || !name || !className) {
      setFormError("All fields are required — RFID No, ID No, Name and Class.");
      return;
    }
    const fresh = studentsRef.current;          // freshest — dup checks never go stale
    const dupRfid = fresh.find((s) => normalizeRfid(s.rfid) === rfid);
    if (dupRfid) {
      setFormError(`RFID "${rfid}" is already assigned to ${dupRfid.name} (${dupRfid.studentId}).`);
      return;
    }
    const dupId = fresh.find((s) => s.studentId.toLowerCase() === studentId.toLowerCase());
    if (dupId) {
      setFormError(`ID No "${studentId}" already exists (${dupId.name}).`);
      return;
    }

    const newStudent = {
      _id: uid(),
      rfid, studentId, name, className,
      status: DEFAULT_STATUS,        // ← always "In", never asked in the form
      lastMovement: null,
      createdAt: new Date().toISOString(),     // newest → appears at the top
    };

    pushHistory(`Add — ${name}`);
    set(ref(database, `${DB_STUDENTS_PATH}/${newStudent._id}`), newStudent)
      .then(() => showToast(`✓ ${name} added`, "success"))
      .catch(() => showToast("⚠ Could not add the student — check your Firebase connection / rules.", "error"));
    closeModal();
    setPage(1);
  };

  /* ================= CSV IMPORT ================= */
  const triggerImport = () => {
    commitEdit();
    fileRef.current?.click();
  };

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";                        // allow picking the same file again
    if (!file) return;
    if (!/\.(csv|txt)$/i.test(file.name)) {
      showToast("⚠ Please select a valid .csv file.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => importCsv(String(reader.result || ""));
    reader.onerror = () => showToast("⚠ Could not read the selected file.", "error");
    reader.readAsText(file);
  };

  const importCsv = (text) => {
    const rows = parseCsv(text);
    if (rows.length === 0) { showToast("⚠ The CSV file is empty.", "error"); return; }

    /* header detection → flexible column order */
    const first = rows[0].map((c) => String(c).trim().toLowerCase());
    const hasHeader = first.some((c) => CSV_HEADER_MAP[c]);
    let col = { rfid: 0, studentId: 1, name: 2, className: 3 };   // fallback order

    if (hasHeader) {
      col = { rfid: -1, studentId: -1, name: -1, className: -1 };
      first.forEach((h, i) => {
        const key = CSV_HEADER_MAP[h];
        if (key && col[key] === -1) col[key] = i;
      });
      rows.shift();
      const missing = CSV_FIELDS.filter((f) => col[f] === -1);
      if (missing.length) {
        showToast(`⚠ CSV header is missing column(s): ${missing.join(", ")}. Expected: RFID No, ID No, Name, Class.`, "error");
        return;
      }
    }

    const freshList = studentsRef.current;      // freshest — gate statuses preserved
    const rfidSet = new Set(freshList.map((s) => normalizeRfid(s.rfid)));
    const idSet = new Set(freshList.map((s) => s.studentId.toLowerCase()));
    const now = Date.now();
    const toAdd = [];
    let duplicates = 0;
    let invalid = 0;

    rows.forEach((r, i) => {
      const rfid = normalizeRfid(r[col.rfid]);
      const studentId = String(r[col.studentId] ?? "").trim();
      const name = String(r[col.name] ?? "").trim();
      const className = String(r[col.className] ?? "").trim();

      if (!rfid || !studentId || !name || !className) { invalid++; return; }
      if (rfidSet.has(rfid) || idSet.has(studentId.toLowerCase())) { duplicates++; return; }

      rfidSet.add(rfid);
      idSet.add(studentId.toLowerCase());
      toAdd.push({
        _id: uid(),
        rfid, studentId, name, className,
        status: DEFAULT_STATUS,        // ← always "In", CSV never asks for status
        lastMovement: null,
        createdAt: new Date(now + (rows.length - i)).toISOString(),  // keep CSV order top → bottom
      });
    });

    if (toAdd.length > 0) {
      pushHistory(`Import — ${toAdd.length} student(s)`);
      const payload = {};
      toAdd.forEach((s) => { payload[s._id] = s; });
      update(ref(database, DB_STUDENTS_PATH), payload)   // one atomic multi-path write
        .then(() => {
          let msg = `✓ Imported ${toAdd.length} student(s)`;
          if (duplicates) msg += ` · ${duplicates} duplicate(s) skipped`;
          if (invalid) msg += ` · ${invalid} invalid row(s)`;
          showToast(msg, "success");
        })
        .catch(() => showToast("⚠ Import failed — check your Firebase connection / rules.", "error"));
      setPage(1);
    } else {
      showToast(`⚠ No students imported — ${duplicates} duplicate(s) and ${invalid} invalid row(s) found.`, "error");
    }
  };

  /* ================= DELETE (with confirm) ================= */
  const requestDelete = (student) => {
    commitEdit();
    setDeleteTarget(student);
  };

  const performDelete = () => {
    if (!deleteTarget) return;
    pushHistory(`Delete — ${deleteTarget.name}`);
    remove(ref(database, `${DB_STUDENTS_PATH}/${deleteTarget._id}`))
      .then(() => showToast(`🗑 ${deleteTarget.name} deleted — press Ctrl+Z to undo.`, "success"))
      .catch(() => showToast("⚠ Could not delete — check your Firebase connection / rules.", "error"));
    if (editing && editing.id === deleteTarget._id) cancelEdit();
    setDeleteTarget(null);
  };

  /* ================= SEARCH ================= */
  const handleSearchChange = (e) => { setSearch(e.target.value); setPage(1); };
  const clearSearch = () => { setSearch(""); setPage(1); };

  /* ================= GLOBAL KEYBOARD ================= */
  useEffect(() => {
    const onKey = (e) => {
      /* --- Add-student modal is open --- */
      if (modalOpen) {
        if (e.key === "Escape") {
          if (captureMode) setCaptureMode(false);
          else closeModal();
          return;
        }
        if (captureMode) {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          const t = e.target;
          if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
          if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
            bufferRef.current += e.key;
            clearTimeout(bufferTimerRef.current);
            bufferTimerRef.current = setTimeout(() => { bufferRef.current = ""; }, 600);
            return;
          }
          if (e.key === "Enter") {
            const code = bufferRef.current;
            bufferRef.current = "";
            clearTimeout(bufferTimerRef.current);
            if (code.length >= 4) { e.preventDefault(); applyCapturedRfid(code); }
          }
        }
        return;
      }

      /* --- delete confirmation is open --- */
      if (deleteTarget) {
        if (e.key === "Escape") setDeleteTarget(null);
        return;
      }

      /* --- a cell is being edited → let the input behave natively --- */
      if (editing) return;

      /* --- undo / redo (skip while typing in the search box) --- */
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) { e.preventDefault(); handleUndo(); }
        else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); handleRedo(); }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(bufferTimerRef.current);
    };
  }, [modalOpen, captureMode, deleteTarget, editing, handleUndo, handleRedo, applyCapturedRfid, closeModal]);

  /* ================= RENDER ================= */
  return (
    <div className="sm">
      {/* ---------- header + toolbar ---------- */}
      <header className="sm-header">
        <div className="sm-toolbar">
          <div className="sm-search">
            <span className="sm-search-icon">🔍</span>
            <input
              placeholder="Search name, ID, class, RFID or status…"
              value={search}
              onChange={handleSearchChange}
              autoComplete="off"
              spellCheck={false}
            />
            {search && (
              <button className="sm-search-clear" onClick={clearSearch} aria-label="Clear search" title="Clear search">×</button>
            )}
          </div>

          <button className="sm-btn sm-btn-primary" onClick={openModal}>
            ＋ Add Student
          </button>
          <button className="sm-btn sm-btn-ghost" onClick={triggerImport} title="Bulk import students from a CSV file">
            📥 Import CSV
          </button>

          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sm-file-hidden"
            onChange={handleFileChange}
          />
        </div>
      </header>

      {/* ---------- data sheet ---------- */}
      <div className="sm-card">
        <div className="sm-table-scroll">
          <table className="sm-table">
            <thead>
              <tr>
                <th scope="col" className="sm-th sm-th-sl">Sl. No</th>
                <th scope="col" className="sm-th sm-th-name">Name</th>
                <th scope="col" className="sm-th sm-th-id">ID No</th>
                <th scope="col" className="sm-th sm-th-class">Class</th>
                <th scope="col" className="sm-th sm-th-rfid">RFID No</th>
                <th scope="col" className="sm-th sm-th-status" title="In · Out · Requested · Approved">Status</th>
                <th scope="col" className="sm-th sm-th-actions">Actions</th>
              </tr>
            </thead>

            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="sm-td sm-empty-cell">
                    {!dbLoaded ? (
                      <div className="sm-empty">
                        <div className="sm-empty-icon">🎓</div>
                        <p className="sm-empty-title">Loading students…</p>
                        <p className="sm-empty-sub">Fetching live data from Firebase.</p>
                      </div>
                    ) : students.length === 0 ? (
                      <div className="sm-empty">
                        <div className="sm-empty-icon">🎓</div>
                        <p className="sm-empty-title">No students yet</p>
                        <p className="sm-empty-sub">
                          Add your first student, import a CSV file, or download the sample CSV to see the format.
                        </p>
                        <div className="sm-empty-actions">
                          <button className="sm-btn sm-btn-primary" onClick={openModal}>＋ Add Student</button>
                          <button className="sm-btn sm-btn-ghost" onClick={triggerImport}>📥 Import CSV</button>
                        </div>
                      </div>
                    ) : (
                      <div className="sm-empty">
                        <div className="sm-empty-icon">🔍</div>
                        <p className="sm-empty-title">No matches found</p>
                        <p className="sm-empty-sub">No student matches “{search}”.</p>
                        <div className="sm-empty-actions">
                          <button className="sm-btn sm-btn-ghost" onClick={clearSearch}>Clear search</button>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                pageRows.map((s, i) => (
                  <tr
                    key={s._id}
                    className={`sm-row ${editing && editing.id === s._id ? "sm-row-editing" : ""} ${
                      flash[s._id] && !(editing && editing.id === s._id) ? "sm-row-flash" : ""
                    }`}
                  >
                    <td className="sm-td sm-td-sl">{(page - 1) * PAGE_SIZE + i + 1}</td>

                    {/* Name */}
                    <td
                      className={`sm-td sm-td-name sm-editable ${isEditing(s, "name") ? "sm-td-editing" : ""}`}
                      onClick={() => handleCellClick(s, "name")}
                      title="Click to edit"
                    >
                      {isEditing(s, "name") ? renderEditor("name") : (
                        <div className="sm-name-cell">
                          <span className="sm-avatar">{getInitials(s.name)}</span>
                          <span className="sm-name-text">{s.name}</span>
                        </div>
                      )}
                    </td>

                    {/* ID No */}
                    <td
                      className={`sm-td sm-td-id sm-editable ${isEditing(s, "studentId") ? "sm-td-editing" : ""}`}
                      onClick={() => handleCellClick(s, "studentId")}
                      title="Click to edit"
                    >
                      {isEditing(s, "studentId") ? renderEditor("studentId") : (
                        <span className="sm-id-text">{s.studentId}</span>
                      )}
                    </td>

                    {/* Class */}
                    <td
                      className={`sm-td sm-td-class sm-editable ${isEditing(s, "className") ? "sm-td-editing" : ""}`}
                      onClick={() => handleCellClick(s, "className")}
                      title="Click to edit"
                    >
                      {isEditing(s, "className") ? renderEditor("className") : (
                        <span className="sm-class-badge">{s.className}</span>
                      )}
                    </td>

                    {/* RFID No */}
                    <td
                      className={`sm-td sm-td-rfid sm-editable ${isEditing(s, "rfid") ? "sm-td-editing" : ""}`}
                      onClick={() => handleCellClick(s, "rfid")}
                      title="Click to edit"
                    >
                      {isEditing(s, "rfid") ? renderEditor("rfid") : (
                        <code className="sm-rfid-chip">{normalizeRfid(s.rfid)}</code>
                      )}
                    </td>

                    {/* Status — real-time, synced from the Pass Issue desk */}
                    <td className="sm-td sm-td-status">
                      {renderStatus(s)}
                    </td>

                    {/* Actions */}
                    <td className="sm-td sm-td-actions">
                      <button
                        className="sm-del-btn"
                        onClick={() => requestDelete(s)}
                        title="Delete student"
                        aria-label={`Delete ${s.name}`}
                      >
                        🗑
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* ---------- footer: live · counts · undo/redo · pagination ---------- */}
        <footer className="sm-footer">
          <div className="sm-footer-left">
            <span
              className="sm-live-chip"
              title="The Status column updates in real time from the Pass Issue desk and the approval desk — issue a pass there and the row here changes instantly."
            >
              <span className="sm-live-dot" aria-hidden="true" />
              Live
            </span>

            <span className="sm-showing">
              {search.trim() ? (
                <>Showing <strong>{startIdx}–{endIdx}</strong> of <strong>{filtered.length}</strong> match{filtered.length === 1 ? "" : "es"} · from {students.length} total</>
              ) : (
                <>Showing <strong>{startIdx}–{endIdx}</strong> of <strong>{students.length}</strong> student{students.length === 1 ? "" : "s"} · {PAGE_SIZE} / page</>
              )}
            </span>

            <div className="sm-history">
              <button
                className="sm-icon-btn"
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                title="Undo (Ctrl+Z)"
                aria-label="Undo"
              >
                ↩
              </button>
              <button
                className="sm-icon-btn"
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                title="Redo (Ctrl+Shift+Z)"
                aria-label="Redo"
              >
                ↪
              </button>
            </div>
          </div>

          <nav className="sm-pager" aria-label="Pagination">
            <button className="sm-pager-btn" onClick={() => goPage(1)} disabled={page === 1} title="First page">«</button>
            <button className="sm-pager-btn" onClick={() => goPage(page - 1)} disabled={page === 1} title="Previous page">‹</button>
            {pageItems.map((p, idx) =>
              p === "…" ? (
                <span key={`e${idx}`} className="sm-pager-ellipsis">…</span>
              ) : (
                <button
                  key={p}
                  className={`sm-pager-btn ${p === page ? "sm-pager-active" : ""}`}
                  onClick={() => goPage(p)}
                >
                  {p}
                </button>
              )
            )}
            <button className="sm-pager-btn" onClick={() => goPage(page + 1)} disabled={page === totalPages} title="Next page">›</button>
            <button className="sm-pager-btn" onClick={() => goPage(totalPages)} disabled={page === totalPages} title="Last page">»</button>
          </nav>
        </footer>
      </div>

      {/* ---------- add student modal ---------- */}
      {modalOpen && (
        <div className="sm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="sm-modal" role="dialog" aria-modal="true" aria-label="Add student">
            <div className="sm-modal-head">
              <h2>➕ Add Student</h2>
              <button className="sm-modal-close" onClick={closeModal} aria-label="Close">×</button>
            </div>

            <div className="sm-modal-body">
              <p className="sm-modal-hint">
                Fill in the details below, or press “Tap Card” and scan the RFID card on the reader.
              </p>

              <div className="sm-modal-fields">
                <div className="sm-field">
                  <label htmlFor="sm-form-rfid">RFID No *</label>
                  <div className="sm-rfid-row">
                    <input
                      id="sm-form-rfid"
                      ref={rfidInputRef}
                      name="rfid"
                      value={form.rfid}
                      onChange={handleFormChange}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        if (captureMode && normalizeRfid(e.currentTarget.value)) {
                          applyCapturedRfid(e.currentTarget.value);
                          return;
                        }
                        idInputRef.current?.focus();
                      }}
                      placeholder="e.g. 04A2918F"
                      autoComplete="off"
                      spellCheck={false}
                      className={`sm-input ${captureMode ? "sm-input-capturing" : ""}`}
                    />
                    <button
                      type="button"
                      className={`sm-capture-btn ${captureMode ? "sm-capture-active" : ""}`}
                      onClick={captureMode ? stopCapture : startCapture}
                      title="Tap the RFID card on the reader to auto-fill this field"
                    >
                      {captureMode ? "✕ Cancel" : "📡 Tap Card"}
                    </button>
                  </div>
                  {captureMode && (
                    <span className="sm-capture-hint">📡 Tap the RFID card on the reader now…</span>
                  )}
                </div>

                <div className="sm-field">
                  <label htmlFor="sm-form-id">ID No *</label>
                  <input
                    id="sm-form-id"
                    ref={idInputRef}
                    name="studentId"
                    value={form.studentId}
                    onChange={handleFormChange}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); nameInputRef.current?.focus(); } }}
                    placeholder="e.g. STU-1042"
                    autoComplete="off"
                    className="sm-input"
                  />
                </div>

                <div className="sm-field">
                  <label htmlFor="sm-form-name">Full Name *</label>
                  <input
                    id="sm-form-name"
                    ref={nameInputRef}
                    name="name"
                    value={form.name}
                    onChange={handleFormChange}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); classInputRef.current?.focus(); } }}
                    placeholder="e.g. Anna Jose"
                    autoComplete="off"
                    className="sm-input"
                  />
                </div>

                <div className="sm-field">
                  <label htmlFor="sm-form-class">Class *</label>
                  <input
                    id="sm-form-class"
                    ref={classInputRef}
                    name="className"
                    value={form.className}
                    onChange={handleFormChange}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
                    placeholder="e.g. VIII A"
                    autoComplete="off"
                    className="sm-input"
                  />
                </div>
              </div>

              {formError && <div className="sm-alert sm-alert-error">⚠ {formError}</div>}
            </div>

            <div className="sm-modal-footer">
              <button className="sm-btn sm-btn-ghost" onClick={closeModal}>Cancel</button>
              <button className="sm-btn sm-btn-primary" onClick={handleAdd}>＋ Add Student</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- delete confirmation ---------- */}
      {deleteTarget && (
        <div className="sm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setDeleteTarget(null); }}>
          <div className="sm-confirm" role="alertdialog" aria-modal="true">
            <div className="sm-confirm-icon">🗑</div>
            <h3 className="sm-confirm-title">Delete student?</h3>
            <p className="sm-confirm-text">
              <strong>{deleteTarget.name}</strong> ({deleteTarget.studentId} · {deleteTarget.className}) will be
              removed from the list. You can undo this with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.
            </p>
            <div className="sm-confirm-actions">
              <button className="sm-btn sm-btn-ghost" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="sm-btn sm-btn-danger" onClick={performDelete}>🗑 Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- toast ---------- */}
      {toast && (
        <div key={toast.id} className={`sm-toast sm-toast-${toast.type}`}>{toast.text}</div>
      )}
    </div>
  );
}