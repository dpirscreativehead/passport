import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ref, onValue, update, set, remove } from "firebase/database";
import { database } from "../../firebase/config"; // ← same import style as the other components — adjust if this file sits at a different depth
import "./data.css";

/* =====================================================================
   MASTER ADMIN — full database control centre  (+ OVERDUE CENTER)
   ---------------------------------------------------------------------
   • ONE live listener on the database ROOT keeps everything in sync.
   • Sidebar with ALL collections (auto-discovered, grouped, counted).
   • Per-collection data sheet: smart columns, live search, sortable
     headers, pagination, status pills and formatted dates.
   • View / Edit / Add / Delete for every record (single + bulk).
   • CLEANUP BY DATE (stored / updated before a chosen date).
   • BACKUP (full structured JSON download) + RESTORE (merge upload
     without duplication — existing records untouched by default).
   • ⚠ OVERDUE CENTER — a separate management view for issued passes
     whose expected return has passed (same rule as the dashboard):
       – ✓ MARK IN      → every copy of the pass closed as RETURNED
                          (returnedAt stamped) and the linked student /
                          staff master record set back to IN with a
                          fresh lastMovement — exactly like the gate desk
       – 📅 CHANGE DATE  → correct the expected return on every copy of
                          the record (editedAt stamped); a future date
                          removes it from the overdue list instantly
       – 🗑 DELETE       → removes ALL TRACES: every copy of the pass
                          matched by record key, _id and slipNo across
                          every collection, plus (optional, default on)
                          resetting the linked person's status to In so
                          nobody stays stuck "Out" for a deleted pass
       – bulk Mark In / bulk Delete with typed DELETE confirmation
   ===================================================================== */

/* ---------------- constants ---------------- */
const PAGE_SIZE = 25;          // rows per page
const MAX_DATA_COLUMNS = 6;    // dynamic columns shown next to the Record column
const WRITE_CHUNK = 300;       // records per multi-path write (bulk operations)

const OVERDUE_ID = "__overdue__";   // sentinel "collection" id → the overdue view

const KIND_LABELS = {
  STUDENT_PASS: "Student pass",
  DAY_PASS: "Day pass",
  STAFF_PASS: "Staff pass",
};

/* column order for the data sheet (the Record column already shows "name") */
const COLUMN_PRIORITY = [
  "studentId", "staffId", "className", "department", "email", "role",
  "rfid", "status", "kind", "slipNo", "reason", "goingWith",
  "createdAt", "requestedAt", "approvedAt", "issuedAt", "rejectedAt",
  "cancelledAt", "returnedAt", "lastMovement", "outAt", "expectedReturn",
];

/* status pill colours (any collection) */
const STATUS_STYLES = {
  IN: "ma-pill-green", ACTIVE: "ma-pill-green",
  APPROVED: "ma-pill-blue", ISSUED: "ma-pill-blue",
  REQUESTED: "ma-pill-amber", PENDING: "ma-pill-amber",
  OUT: "ma-pill-red", REJECTED: "ma-pill-red",
  CANCELLED: "ma-pill-gray", RETURNED: "ma-pill-gray",
};

/* collections that get EXTRA warnings before destructive actions */
const MASTER_COLLECTIONS = ["students", "staff", "users"];

/* sidebar groups — every other node found lands in "Other collections" */
const GROUPS = [
  { id: "people",  label: "People",         icon: "👥", members: ["students", "staff", "users"] },
  { id: "student", label: "Student passes", icon: "🎒", members: ["studentPass", "studentRequest", "requested", "daypass", "rejectedStudentPass", "cancelledStudentPass"] },
  { id: "staffp",  label: "Staff passes",   icon: "🧑‍🏫", members: ["staffrequests", "staffpass", "staffrejected"] },
];

const KNOWN_COLLECTIONS = {
  students:             { label: "Students",              icon: "🎓", desc: "Student master data" },
  staff:                { label: "Staff",                 icon: "👔", desc: "Staff master data" },
  users:                { label: "Users",                 icon: "👤", desc: "App user accounts" },
  studentPass:          { label: "Issued Student Passes", icon: "🎫", desc: "Issued directly at the gate desk" },
  studentRequest:       { label: "Day-Pass Requests",     icon: "⏳", desc: "Pending — waiting for the Principal" },
  requested:            { label: "Requests (legacy)",     icon: "⏳", desc: "Legacy request node" },
  daypass:              { label: "Approved Day Passes",   icon: "✅", desc: "Approved by the Principal" },
  rejectedStudentPass:  { label: "Rejected (students)",   icon: "⛔", desc: "Rejected request records" },
  cancelledStudentPass: { label: "Cancelled (students)",  icon: "🚫", desc: "Cancelled request records" },
  staffrequests:        { label: "Staff Pass Requests",   icon: "⏳", desc: "Pending — waiting for the Principal" },
  staffpass:            { label: "Approved Staff Passes", icon: "✅", desc: "Approved by the Principal" },
  staffrejected:        { label: "Rejected (staff)",      icon: "⛔", desc: "Rejected staff records" },
  passes:               { label: "Passes (legacy)",       icon: "🎟️", desc: "Legacy pass records" },
};

/* ---------------- small helpers ---------------- */
const p2 = (n) => String(n).padStart(2, "0");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const prettifyKey = (k) =>
  String(k || "").replace(/[_\-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "?";

const getInitials = (name) =>
  String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("") || "?";

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?/;
const isDateString = (v) => typeof v === "string" && DATE_RE.test(v.trim());

/* "2025-06-11" / "2025-06-11T14:30" → local Date (no UTC surprises) */
function parseLocalDate(v) {
  const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}

function startOfTodayMs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

/* is this pass record overdue right now? — same rule as the dashboard:
   status ISSUED and expectedReturn BEFORE the start of today */
function isOverdueRecord(rec) {
  if (!rec || typeof rec !== "object") return false;
  if (String(rec.status || "").toUpperCase() !== "ISSUED") return false;
  const d = parseLocalDate(rec.expectedReturn);
  if (!d) return false;
  return d.getTime() < startOfTodayMs();
}

/* "3 d" · "2 d 6 h" · "5 h" — how far past the expected return */
function overdueByLabel(ms) {
  const diff = Date.now() - ms;
  if (!(diff > 0)) return "—";
  const mins = Math.floor(diff / 60000);
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return h % 24 > 0 ? `${d} d ${h % 24} h` : `${d} d`;
  if (h > 0) return `${h} h`;
  return `${Math.max(1, mins)} min`;
}

/* dates shown smart: "2025-06-11" → date only · with time → date + time */
function fmtWhen(v) {
  if (v === null || v === undefined || v === "") return "—";
  let d;
  let hasTime = true;
  if (typeof v === "number") {
    d = new Date(v);
  } else {
    const s = String(v).trim();
    if (!isDateString(s)) return s;
    hasTime = /[T ]\d{2}:\d{2}/.test(s);
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
      d = new Date(s);
    } else {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
      d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    }
  }
  if (isNaN(d)) return String(v);
  return hasTime
    ? `${d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

const cellText = (v) => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

const toEditable = (v) =>
  v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);

/* keep the original type when an edited value is saved back */
function fromEditable(text, orig) {
  if (orig !== null && orig !== undefined && typeof orig === "object") {
    try { return JSON.parse(text); } catch { throw new Error("invalid JSON"); }
  }
  if (typeof orig === "number") {
    const n = Number(text);
    return String(text).trim() !== "" && !isNaN(n) ? n : text;
  }
  if (typeof orig === "boolean") return text === "true";
  if (orig === null) return text === "" ? null : text;
  return text;
}

/* latest "stored / updated" timestamp of a record — schedule fields
   (expectedReturn / outAt) never count; records with no timestamp are
   never eligible for the date cleanup */
const TS_EXCLUDE = new Set(["expectedreturn", "outat"]);
function recordTimestamp(rec) {
  if (!rec || typeof rec !== "object") return null;
  let max = null;
  Object.entries(rec).forEach(([k, v]) => {
    const kl = String(k).toLowerCase();
    if (kl === "_key" || TS_EXCLUDE.has(kl)) return;
    let t = NaN;
    if (typeof v === "string" && isDateString(v)) {
      const s = v.trim();
      if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
        t = Date.parse(s);
      } else {
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
        if (m) t = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
      }
    } else if (typeof v === "number" && v > 1e12 && v < 4e12 && /(at|time|stamp|date)$/i.test(k)) {
      t = v;                                     // epoch-milliseconds field
    }
    if (!isNaN(t) && (max === null || t > max)) max = t;
  });
  return max;
}

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

/* download any payload as a pretty JSON file → returns the byte size */
function downloadJson(filename, payload) {
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return blob.size;
}

const stampNow = () => {
  const d = new Date();
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
};

/* ===================================================================== */

export default function MasterAdmin() {
  /* ================= LIVE DATA ================= */
  const [dbData, setDbData] = useState(null);        // raw snapshot of the whole database root
  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState("");
  const [lastSync, setLastSync] = useState(null);

  /* ================= UI STATE ================= */
  const [activeCol, setActiveCol] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ field: "__activity", dir: "desc" });
  const [selected, setSelected] = useState(() => new Set());

  const [detail, setDetail] = useState(null);        // { col, key } — record viewer
  const [editState, setEditState] = useState(null);  // { col, key, entries, err }
  const [addState, setAddState] = useState(null);    // { col, key, usesId, entries, err }
  const [delOne, setDelOne] = useState(null);        // { col, key }
  const [delBulkOpen, setDelBulkOpen] = useState(false);
  const [cleanup, setCleanup] = useState({ open: false, date: "", report: null, checked: {}, protectedCount: 0 });
  const [restore, setRestore] = useState({ open: false, fileName: "", preview: [], freshTotal: 0, dupTotal: 0, invalid: 0, overwrite: false, done: null });
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  /* ---------- overdue center state ---------- */
  const [ovSearch, setOvSearch] = useState("");
  const [ovScope, setOvScope] = useState("ALL");                       // ALL | STUDENT | STAFF
  const [ovSort, setOvSort] = useState({ field: "expected", dir: "asc" });
  const [ovDate, setOvDate] = useState(null);        // { entry, date, time, err } — change expected return
  const [ovDelete, setOvDelete] = useState(null);    // { entries, resetPerson, traces }
  const [ovMarkIn, setOvMarkIn] = useState(null);    // { entries }

  /* ================= REFS ================= */
  const toastTimerRef = useRef(null);
  const restoreFileRef = useRef(null);
  const restoreDataRef = useRef(null);               // parsed backup, kept out of state
  const headCheckRef = useRef(null);                 // table header checkbox (indeterminate state)

  const dbUrl = useMemo(() => {
    try { return (database.app && database.app.options && database.app.options.databaseURL) || ""; } catch { return ""; }
  }, []);

  /* ================= TOAST ================= */
  const showToast = useCallback((text, type = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  /* ================= LIVE ROOT SYNC =================
     ONE listener on the database root: every collection, record and
     count on this page is derived from this single live snapshot. */
  useEffect(() => {
    const unsub = onValue(
      ref(database),
      (snap) => {
        const val = snap.val();
        setDbData(val && typeof val === "object" && !Array.isArray(val) ? val : {});
        setDbError("");
        setReady(true);
        setLastSync(new Date());
      },
      (err) => {
        setDbError(err.message || "permission denied");
        setReady(true);
      }
    );
    return () => unsub();
  }, []);

  /* ================= SMALL HELPERS ================= */
  const labelOf = useCallback((colId) => (KNOWN_COLLECTIONS[colId] ? KNOWN_COLLECTIONS[colId].label : prettifyKey(colId)), []);

  const recName = useCallback((r) => {
    if (!r) return "";
    if (r._scalar !== undefined) return cellText(r._scalar);
    const cand = r.name || r.studentId || r.staffId || r.email || r.displayName || r.title || r.reason || r.slipNo;
    return cand ? String(cand) : "";
  }, []);

  /* ================= DERIVED: COLLECTIONS ================= */
  const collections = useMemo(() => {
    const src = dbData || {};
    const list = [];
    Object.keys(src).forEach((id) => {
      const node = src[id];
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const known = KNOWN_COLLECTIONS[id];
      list.push({
        id,
        count: Object.keys(node).length,
        label: known ? known.label : prettifyKey(id),
        icon: known ? known.icon : "🗂️",
        desc: known ? known.desc : "Collection found in the database",
      });
    });
    list.sort((a, b) => a.label.localeCompare(b.label));
    return list;
  }, [dbData]);

  const grouped = useMemo(() => {
    const knownIds = new Set();
    const groups = GROUPS.map((g) => {
      g.members.forEach((m) => knownIds.add(m));
      return { ...g, items: collections.filter((c) => g.members.indexOf(c.id) !== -1) };
    });
    groups.push({ id: "other", label: "Other collections", icon: "🗂️", items: collections.filter((c) => !knownIds.has(c.id)) });
    return groups.filter((g) => g.items.length > 0);
  }, [collections]);

  const totalRecords = useMemo(() => collections.reduce((a, c) => a + c.count, 0), [collections]);

  /* keep a valid active collection (default: students) — the overdue
     view is a sentinel and is always valid */
  useEffect(() => {
    if (!ready || collections.length === 0) return;
    if (activeCol === OVERDUE_ID) return;
    if (!collections.some((c) => c.id === activeCol)) {
      const preferred = collections.find((c) => c.id === "students") || collections[0];
      setActiveCol(preferred.id);
      setSelected(new Set());
      setPage(1);
    }
  }, [ready, collections, activeCol]);

  const inOverdue = activeCol === OVERDUE_ID;
  const activeMeta = useMemo(() => collections.find((c) => c.id === activeCol) || null, [collections, activeCol]);
  const isMasterActive = MASTER_COLLECTIONS.indexOf(activeCol) !== -1;

  /* ================= DERIVED: RECORDS ================= */
  const records = useMemo(() => {
    if (!activeCol || !dbData || !dbData[activeCol]) return [];
    return Object.entries(dbData[activeCol]).map(([key, rec]) => {
      if (rec && typeof rec === "object" && !Array.isArray(rec)) return { ...rec, _key: key };
      return { _key: key, _scalar: rec };            // non-object value — still manageable
    });
  }, [dbData, activeCol]);

  const tsMap = useMemo(() => {
    const m = new Map();
    records.forEach((r) => m.set(r._key, recordTimestamp(r)));
    return m;
  }, [records]);

  /* smart columns: priority fields first, then the most frequent fields */
  const dataCols = useMemo(() => {
    if (records.length === 0) return [];
    const freq = new Map();
    records.slice(0, 300).forEach((r) =>
      Object.keys(r).forEach((k) => { if (k !== "_key" && k !== "_scalar") freq.set(k, (freq.get(k) || 0) + 1); })
    );
    const prio = COLUMN_PRIORITY.filter((f) => freq.has(f));
    const rest = [...freq.keys()].filter((k) => prio.indexOf(k) === -1)
      .sort((a, b) => (freq.get(b) - freq.get(a)) || a.localeCompare(b));
    return [...prio, ...rest].slice(0, MAX_DATA_COLUMNS);
  }, [records]);

  /* ================= FILTER · SORT · PAGINATE (collection view) ================= */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = records;
    if (q) {
      list = records.filter((r) => {
        if (String(r._key).toLowerCase().includes(q)) return true;
        for (const k in r) {
          if (k === "_key") continue;
          const v = r[k];
          const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
          if (s.toLowerCase().includes(q)) return true;
        }
        return false;
      });
    }
    const dir = sort.dir === "asc" ? 1 : -1;
    const field = sort.field;
    if (!field) return list;
    return [...list].sort((a, b) => {
      let va, vb;
      if (field === "__activity") {
        va = tsMap.get(a._key) || 0;
        vb = tsMap.get(b._key) || 0;
      } else {
        va = a[field];
        vb = b[field];
        if (!(typeof va === "number" && typeof vb === "number")) {
          va = va === null || va === undefined ? "" : String(va).toLowerCase();
          vb = vb === null || vb === undefined ? "" : String(vb).toLowerCase();
        }
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [records, search, sort, tsMap]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

  const toggleSort = (field) =>
    setSort((s) => (s.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" }));

  /* ================= ⚠ OVERDUE CENTER — data ================= */
  /* every issued pass across EVERY collection whose expected return is
     before today — de-duplicated by _id (a pass that exists in more than
     one collection is ONE overdue entry; its copies are its "traces") */
  const overdueList = useMemo(() => {
    if (!dbData) return [];
    const seen = new Set();
    const list = [];
    Object.entries(dbData).forEach(([colId, node]) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      Object.entries(node).forEach(([key, r]) => {
        if (!r || typeof r !== "object" || Array.isArray(r)) return;
        if (!isOverdueRecord(r)) return;
        const id = String(r._id || `${colId}/${key}`);
        if (seen.has(id)) return;                    // a copy of an already-listed pass
        seen.add(id);
        const kind = String(r.kind || "").toUpperCase();
        const scope =
          kind === "STAFF_PASS" ? "STAFF" :
          (kind === "STUDENT_PASS" || kind === "DAY_PASS") ? "STUDENT" :
          (r.staffKey || (r.staffId && !r.studentId)) ? "STAFF" :
          (r.studentKey || r.studentId) ? "STUDENT" :
          /^staff/i.test(colId) ? "STAFF" : "STUDENT";
        const exp = parseLocalDate(r.expectedReturn);
        const outRaw = r.outAt || r.printedAt || r.issuedAt || r.createdAt;
        const outD = outRaw ? new Date(outRaw) : null;
        list.push({
          uid: `${colId}::${key}`,
          col: colId, key, rec: r, _id: id,
          name: String(r.name || r.fullName || r.studentName || r.staffName || "Unknown").trim(),
          group: String(r.className || r.class || r.department || "").trim() || "—",
          ident: r.studentId || r.staffId || "",
          scope,
          expectedMs: exp ? exp.getTime() : 0,
          outMs: outD && !isNaN(outD) ? outD.getTime() : 0,
        });
      });
    });
    return list;
  }, [dbData]);

  const ovStats = useMemo(() => {
    let students = 0, staff = 0, longestMs = Infinity;
    overdueList.forEach((e) => {
      if (e.scope === "STAFF") staff++; else students++;
      if (e.expectedMs < longestMs) longestMs = e.expectedMs;
    });
    return { students, staff, longest: overdueList.length ? overdueByLabel(longestMs) : "—" };
  }, [overdueList]);

  /* every copy of this pass across the whole database — matched by record
     key, _id and (when present) slip number. Master collections are never
     touched by trace operations. */
  const findTraces = useCallback((entry) => {
    const traces = [];
    if (!dbData) return traces;
    const rec = entry.rec || {};
    const id = rec._id ? String(rec._id) : null;
    const slip = rec.slipNo ? String(rec.slipNo) : null;
    Object.entries(dbData).forEach(([colId, node]) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      if (MASTER_COLLECTIONS.indexOf(colId) !== -1) return;   // passes never live in master data
      Object.entries(node).forEach(([k, r]) => {
        if (!r || typeof r !== "object" || Array.isArray(r)) return;
        if ((colId === entry.col && k === entry.key) ||
            (id && r._id && String(r._id) === id) ||
            (slip && String(r.slipNo || "") === slip)) {
          traces.push({ col: colId, key: k, rec: r });
        }
      });
    });
    return traces;
  }, [dbData]);

  /* the student / staff master record this pass belongs to */
  const findLinkedPerson = useCallback((rec) => {
    if (!dbData || !rec) return null;
    const tryKeys = [];
    if (rec.studentKey) tryKeys.push({ col: "students", key: String(rec.studentKey) });
    if (rec.staffKey) tryKeys.push({ col: "staff", key: String(rec.staffKey) });
    for (const t of tryKeys) {
      const node = dbData[t.col];
      if (node && typeof node === "object" && t.key in node) return { ...t, rec: node[t.key] };
    }
    if (rec.studentId) {
      const students = dbData.students || {};
      for (const [k, s] of Object.entries(students)) {
        if (s && typeof s === "object" && String(s.studentId || "") === String(rec.studentId)) {
          return { col: "students", key: k, rec: s };
        }
      }
    }
    if (rec.staffId) {
      const staff = dbData.staff || {};
      for (const [k, s] of Object.entries(staff)) {
        if (s && typeof s === "object" && String(s.staffId || "") === String(rec.staffId)) {
          return { col: "staff", key: k, rec: s };
        }
      }
    }
    return null;
  }, [dbData]);

  /* ---------- overdue: filter · sort · paginate ---------- */
  const ovFiltered = useMemo(() => {
    const q = ovSearch.trim().toLowerCase();
    let list = overdueList;
    if (ovScope !== "ALL") list = list.filter((e) => e.scope === ovScope);
    if (q) {
      list = list.filter((e) =>
        [e.name, e.ident, e.group, e.rec.reason, e.rec.slipNo, e._id, e.key]
          .some((v) => String(v || "").toLowerCase().includes(q))
      );
    }
    const dir = ovSort.dir === "asc" ? 1 : -1;
    const field = ovSort.field;
    return [...list].sort((a, b) => {
      let va, vb;
      if (field === "expected") { va = a.expectedMs; vb = b.expectedMs; }
      else if (field === "out") { va = a.outMs; vb = b.outMs; }
      else { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [overdueList, ovSearch, ovScope, ovSort]);

  const ovTotalPages = Math.max(1, Math.ceil(ovFiltered.length / PAGE_SIZE));
  const ovPageRows = useMemo(() => ovFiltered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [ovFiltered, page]);

  const toggleOvSort = (field) =>
    setOvSort((s) => (s.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" }));

  /* ---------- shared pager (collection view + overdue view) ---------- */
  const activeTotalPages = inOverdue ? ovTotalPages : totalPages;
  const pageItems = useMemo(() => getPageItems(page, activeTotalPages), [page, activeTotalPages]);
  useEffect(() => { if (page > activeTotalPages) setPage(activeTotalPages); }, [page, activeTotalPages]);

  const activeRows = inOverdue ? ovPageRows : pageRows;
  const activeFilteredRows = inOverdue ? ovFiltered : filtered;
  const rowId = (r) => (inOverdue ? r.uid : r._key);
  const totalActiveRecords = inOverdue ? overdueList.length : records.length;
  const isSearchActive = inOverdue ? !!ovSearch.trim() : !!search.trim();

  const startIdx = activeFilteredRows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endIdx = Math.min(page * PAGE_SIZE, activeFilteredRows.length);
  const goPage = (p) => setPage(Math.min(Math.max(1, p), activeTotalPages));

  /* ================= SELECTION (shared, works in both views) ================= */
  const allPageSelected = activeRows.length > 0 && activeRows.every((r) => selected.has(rowId(r)));
  const somePageSelected = activeRows.some((r) => selected.has(rowId(r))) && !allPageSelected;
  useEffect(() => {
    if (headCheckRef.current) headCheckRef.current.indeterminate = somePageSelected;
  }, [somePageSelected, allPageSelected, activeRows]);

  const toggleOne = (key) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });
  const togglePage = () => setSelected((prev) => {
    const n = new Set(prev);
    if (allPageSelected) activeRows.forEach((r) => n.delete(rowId(r)));
    else activeRows.forEach((r) => n.add(rowId(r)));
    return n;
  });
  const selectAllFiltered = () => setSelected(new Set(activeFilteredRows.map(rowId)));
  const clearSelection = () => setSelected(new Set());

  const selectedNames = useMemo(() => {
    if (activeCol === OVERDUE_ID) return overdueList.filter((e) => selected.has(e.uid)).map((e) => e.name);
    return records.filter((r) => selected.has(r._key)).map((r) => recName(r) || r._key);
  }, [activeCol, overdueList, records, selected, recName]);

  /* auto-close the bulk modal if the selection disappears */
  useEffect(() => {
    if (delBulkOpen && selected.size === 0 && !busy) setDelBulkOpen(false);
  }, [delBulkOpen, selected, busy]);

  /* politely close overdue modals whose records vanished (handled elsewhere) */
  useEffect(() => {
    if (busy) return;
    const exists = (col, key) => !!(dbData && dbData[col] && typeof dbData[col] === "object" && (key in dbData[col]));
    const gone = (st) => st && (
      st.entries
        ? st.entries.some((e) => !exists(e.col, e.key))
        : !exists(st.entry.col, st.entry.key)
    );
    if (gone(ovDelete)) { setOvDelete(null); showToast("This record changed — it may have been handled elsewhere.", "info"); }
    if (gone(ovMarkIn)) { setOvMarkIn(null); showToast("This record changed — it may have been handled elsewhere.", "info"); }
    if (gone(ovDate)) { setOvDate(null); showToast("This record changed — it may have been handled elsewhere.", "info"); }
  }, [dbData, busy, ovDelete, ovMarkIn, ovDate, showToast]);

  /* ================= FRESH SNAPSHOTS FOR OPEN MODALS ================= */
  const detailRec = useMemo(() => {
    if (!detail) return null;
    const node = dbData && dbData[detail.col];
    if (!node || typeof node !== "object" || !(detail.key in node)) return null;
    return node[detail.key];
  }, [detail, dbData]);

  const delOneRec = useMemo(() => {
    if (!delOne) return null;
    const node = dbData && dbData[delOne.col];
    if (!node || typeof node !== "object" || !(delOne.key in node)) return null;
    return node[delOne.key];
  }, [delOne, dbData]);

  /* linked people shown inside the overdue delete modal */
  const ovPersons = useMemo(() => {
    if (!ovDelete) return [];
    const out = [];
    const seen = new Set();
    ovDelete.entries.forEach((e) => {
      const p = findLinkedPerson(e.rec);
      if (!p) return;
      const id = `${p.col}/${p.key}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ ...p, status: String((p.rec && p.rec.status) || "—").toUpperCase() });
    });
    return out;
  }, [ovDelete, findLinkedPerson]);

  /* ================= MODAL PLUMBING ================= */
  const closeAllModals = useCallback(() => {
    setDetail(null);
    setEditState(null);
    setAddState(null);
    setDelOne(null);
    setDelBulkOpen(false);
    setOvDate(null);
    setOvDelete(null);
    setOvMarkIn(null);
    setConfirmText("");
    restoreDataRef.current = null;
    setRestore({ open: false, fileName: "", preview: [], freshTotal: 0, dupTotal: 0, invalid: 0, overwrite: false, done: null });
    setCleanup({ open: false, date: "", report: null, checked: {}, protectedCount: 0 });
  }, []);

  const backdrop = (e) => { if (e.target === e.currentTarget && !busy) closeAllModals(); };

  /* Esc closes whatever is open */
  useEffect(() => {
    const anyOpen = detail || editState || addState || delOne || delBulkOpen || cleanup.open || restore.open || ovDate || ovDelete || ovMarkIn;
    if (!anyOpen) return;
    const onKey = (e) => { if (e.key === "Escape" && !busy) closeAllModals(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, editState, addState, delOne, delBulkOpen, cleanup, restore, ovDate, ovDelete, ovMarkIn, busy, closeAllModals]);

  const openCollection = useCallback((colId) => {
    setActiveCol(colId);
    setSearch("");
    setOvSearch("");
    setPage(1);
    setSelected(new Set());
    setSort({ field: "__activity", dir: "desc" });
  }, []);

  const openOverdue = useCallback(() => {
    setActiveCol(OVERDUE_ID);
    setSearch("");
    setOvSearch("");
    setOvScope("ALL");
    setPage(1);
    setSelected(new Set());
    setSort({ field: "__activity", dir: "desc" });
    setOvSort({ field: "expected", dir: "asc" });
  }, []);

  /* ================= CELL RENDERING ================= */
  const renderCell = (r, field) => {
    const v = r[field];
    if (v === undefined || v === null) return <span className="ma-muted">—</span>;
    if (field === "status") {
      const cls = STATUS_STYLES[String(v).toUpperCase()] || "ma-pill-gray";
      return <span className={`ma-pill ${cls}`}>{String(v)}</span>;
    }
    if (typeof v === "string" && isDateString(v)) return <span className="ma-date" title={v}>{fmtWhen(v)}</span>;
    if (field === "rfid" || field === "slipNo" || field === "studentId" || field === "staffId") {
      return <code className="ma-mono">{cellText(v)}</code>;
    }
    if (typeof v === "boolean") {
      return <span className={v ? "ma-bool ma-bool-yes" : "ma-bool ma-bool-no"}>{v ? "Yes" : "No"}</span>;
    }
    const text = cellText(v);
    return <span className="ma-cell-text" title={text}>{text}</span>;
  };

  /* key-value sheet used by the viewer and the delete modal */
  const renderKvList = (raw, max = Infinity) => {
    if (raw === null || raw === undefined) return null;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const entries = Object.entries(raw).slice(0, max);
      const more = Object.keys(raw).length - entries.length;
      return (
        <div className="ma-kv-list">
          {entries.map(([k, v]) => (
            <div className="ma-kv" key={k}>
              <span className="ma-kv-label">{prettifyKey(k)}</span>
              {v !== null && typeof v === "object"
                ? <pre className="ma-kv-json">{JSON.stringify(v, null, 2)}</pre>
                : <span className="ma-kv-value">{typeof v === "string" && isDateString(v) ? fmtWhen(v) : cellText(v)}</span>}
            </div>
          ))}
          {more > 0 && (
            <div className="ma-kv ma-kv-more">
              <span className="ma-kv-label">…</span>
              <span className="ma-kv-value">+{more} more field(s) — open the record to see everything</span>
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="ma-kv-list">
        <div className="ma-kv"><span className="ma-kv-label">Value</span><span className="ma-kv-value">{cellText(raw)}</span></div>
      </div>
    );
  };

  /* shared field editor for the Edit and Add modals */
  const renderFieldEditor = (entries, { nameEditable, onText, onName, onRemove }) => (
    <div className="ma-field-list">
      {entries.map((e, i) => {
        const isJson = e.orig !== null && e.orig !== undefined && typeof e.orig === "object";
        return (
          <div className="ma-field-row" key={i}>
            <div className="ma-field-name">
              {nameEditable(e) ? (
                <input value={e.name} onChange={(ev) => onName(i, ev.target.value)} placeholder="field name" spellCheck={false} />
              ) : (
                <span title={e.name}>{prettifyKey(e.name)}</span>
              )}
              {isJson && <em className="ma-field-type">JSON</em>}
            </div>
            {isJson ? (
              <textarea className="ma-input" rows={3} value={e.text} onChange={(ev) => onText(i, ev.target.value)} spellCheck={false} />
            ) : (
              <input className="ma-input" value={e.text} onChange={(ev) => onText(i, ev.target.value)} spellCheck={false} placeholder="value" />
            )}
            <button type="button" className="ma-field-del" onClick={() => onRemove(i)} title="Remove this field">✕</button>
          </div>
        );
      })}
    </div>
  );

  /* ================= EDIT RECORD ================= */
  const startEdit = useCallback((col, key, raw) => {
    let entries;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const { _key, _scalar, ...rest } = raw;
      entries = Object.keys(rest).map((k) => ({ name: k, text: toEditable(rest[k]), orig: rest[k], isNew: false }));
    } else {
      entries = [{ name: "value", text: toEditable(raw), orig: raw, scalar: true, isNew: false }];
    }
    setConfirmText("");
    setDetail(null);
    setEditState({ col, key, entries, err: "" });
  }, []);

  const editText = (i, text) => setEditState((s) => (s ? { ...s, err: "", entries: s.entries.map((e, j) => (j === i ? { ...e, text } : e)) } : s));
  const editName = (i, name) => setEditState((s) => (s ? { ...s, err: "", entries: s.entries.map((e, j) => (j === i ? { ...e, name } : e)) } : s));
  const editRemove = (i) => setEditState((s) => (s ? { ...s, err: "", entries: s.entries.filter((_, j) => j !== i) } : s));
  const editAddField = () => setEditState((s) => (s ? { ...s, err: "", entries: [...s.entries, { name: "", text: "", orig: undefined, isNew: true }] } : s));

  const saveEdit = async () => {
    if (!editState) return;
    const scalarEntry = editState.entries.length === 1 && editState.entries[0].scalar ? editState.entries[0] : null;
    const obj = {};
    const seen = new Set();
    let scalarVal;

    if (scalarEntry) {
      try { scalarVal = fromEditable(scalarEntry.text, scalarEntry.orig); }
      catch { setEditState((s) => ({ ...s, err: "The value must be valid JSON." })); return; }
    } else {
      for (const e of editState.entries) {
        const name = String(e.name || "").trim();
        if (!name) {
          if (e.isNew && String(e.text).trim() === "") continue;   // silently drop empty new rows
          setEditState((s) => ({ ...s, err: "Every field needs a name." })); return;
        }
        if (name === "_key") { setEditState((s) => ({ ...s, err: "“_key” is the record key — it cannot be a field." })); return; }
        if (seen.has(name)) { setEditState((s) => ({ ...s, err: `Duplicate field name: “${name}”.` })); return; }
        seen.add(name);
        try { obj[name] = fromEditable(e.text, e.orig); }
        catch { setEditState((s) => ({ ...s, err: `“${prettifyKey(name)}” must be valid JSON.` })); return; }
      }
      if (Object.keys(obj).length === 0) {
        setEditState((s) => ({ ...s, err: "A record needs at least one field — use Delete to remove the record." }));
        return;
      }
    }

    setBusy(true);
    try {
      await set(ref(database, `${editState.col}/${editState.key}`), scalarEntry ? scalarVal : obj);
      showToast(`✓ Record ${editState.key} saved`, "success");
      setEditState(null);
    } catch (err) {
      setEditState((s) => ({ ...s, err: err.message || "Could not save — check Firebase connection / rules." }));
    } finally { setBusy(false); }
  };

  /* ================= ADD RECORD ================= */
  const openAdd = useCallback(() => {
    if (!activeCol || activeCol === OVERDUE_ID) return;
    const freq = new Map();
    records.slice(0, 200).forEach((r) =>
      Object.keys(r).forEach((k) => { if (k !== "_key" && k !== "_scalar") freq.set(k, (freq.get(k) || 0) + 1); })
    );
    const seed = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
      .filter((k) => k !== "_id").slice(0, 6);
    setConfirmText("");
    setAddState({
      col: activeCol,
      key: uid(),
      usesId: freq.has("_id"),
      entries: seed.map((f) => ({ name: f, text: "", orig: undefined, isNew: true })),
      err: "",
    });
  }, [activeCol, records]);

  const addText = (i, text) => setAddState((s) => (s ? { ...s, err: "", entries: s.entries.map((e, j) => (j === i ? { ...e, text } : e)) } : s));
  const addName = (i, name) => setAddState((s) => (s ? { ...s, err: "", entries: s.entries.map((e, j) => (j === i ? { ...e, name } : e)) } : s));
  const addRemove = (i) => setAddState((s) => (s ? { ...s, err: "", entries: s.entries.filter((_, j) => j !== i) } : s));
  const addFieldRow = () => setAddState((s) => (s ? { ...s, err: "", entries: [...s.entries, { name: "", text: "", orig: undefined, isNew: true }] } : s));

  const saveAdd = async () => {
    if (!addState) return;
    const obj = {};
    const seen = new Set();
    for (const e of addState.entries) {
      const name = String(e.name || "").trim();
      const text = e.text;
      if (!name && String(text).trim() === "") continue;           // skip fully empty rows
      if (!name) { setAddState((s) => ({ ...s, err: "Every field needs a name." })); return; }
      if (name === "_key") { setAddState((s) => ({ ...s, err: "“_key” cannot be used as a field name." })); return; }
      if (seen.has(name)) { setAddState((s) => ({ ...s, err: `Duplicate field name: “${name}”.` })); return; }
      seen.add(name);
      if (String(text) !== "") obj[name] = text;                   // new values are saved as text
    }
    if (Object.keys(obj).length === 0) { setAddState((s) => ({ ...s, err: "Add at least one field with a value." })); return; }
    if (addState.usesId && !obj._id) obj._id = addState.key;       // keep the collection's _id convention

    setBusy(true);
    try {
      await set(ref(database, `${addState.col}/${addState.key}`), obj);
      showToast(`✓ Record added to ${labelOf(addState.col)}`, "success");
      setSearch(addState.key);                                     // jump straight to the new record
      setPage(1);
      setAddState(null);
    } catch (err) {
      setAddState((s) => ({ ...s, err: err.message || "Could not add — check Firebase connection / rules." }));
    } finally { setBusy(false); }
  };

  /* ================= DELETE (single) ================= */
  const doDeleteOne = async () => {
    if (!delOne || busy) return;
    setBusy(true);
    try {
      await remove(ref(database, `${delOne.col}/${delOne.key}`));
      showToast(`🗑 Record ${delOne.key} deleted from ${labelOf(delOne.col)}`, "success");
      setSelected((prev) => { const n = new Set(prev); n.delete(delOne.key); return n; });
      if (detail && detail.col === delOne.col && detail.key === delOne.key) setDetail(null);
      setDelOne(null);
    } catch (err) {
      showToast(`⚠ Could not delete — ${err.message || "check Firebase connection / rules"}`, "error");
    } finally { setBusy(false); }
  };

  /* ================= DELETE (bulk — typed confirmation) ================= */
  const doBulkDelete = async () => {
    if (busy || confirmText !== "DELETE" || !activeCol || activeCol === OVERDUE_ID || selected.size === 0) return;
    const keys = Array.from(selected);
    setBusy(true);
    try {
      for (let i = 0; i < keys.length; i += WRITE_CHUNK) {
        const part = {};
        keys.slice(i, i + WRITE_CHUNK).forEach((k) => { part[`${activeCol}/${k}`] = null; });
        await update(ref(database), part);
      }
      showToast(`🗑 ${keys.length} record(s) deleted from ${labelOf(activeCol)}`, "success");
      setSelected(new Set());
      setDelBulkOpen(false);
      setConfirmText("");
    } catch (err) {
      showToast(`⚠ Bulk delete failed — ${err.message || "check Firebase connection / rules"}`, "error");
    } finally { setBusy(false); }
  };

  /* ================= ⚠ OVERDUE ACTIONS ================= */

  /* ---- MARK IN (single — one click, exactly like the gate desk) ----
     every copy of the pass → RETURNED (+ returnedAt) and the linked
     person's master record → IN (+ fresh lastMovement)               */
  const markInOne = async (entry) => {
    if (busy) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const updates = {};
      findTraces(entry).forEach((t) => {
        updates[`${t.col}/${t.key}/status`] = "RETURNED";
        updates[`${t.col}/${t.key}/returnedAt`] = now;
      });
      const person = findLinkedPerson(entry.rec);
      if (person) {
        updates[`${person.col}/${person.key}/status`] = "IN";
        updates[`${person.col}/${person.key}/lastMovement`] = now;
      }
      await update(ref(database), updates);
      showToast(`✓ ${entry.name} marked IN — pass closed as returned`, "success");
    } catch (err) {
      showToast(`⚠ Could not mark in — ${err.message || "check Firebase connection / rules"}`, "error");
    } finally { setBusy(false); }
  };

  /* ---- MARK IN (bulk — confirmed first) ---- */
  const doOvMarkIn = async () => {
    const st = ovMarkIn;
    if (!st || busy) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const updates = {};
      st.entries.forEach((e) => {
        findTraces(e).forEach((t) => {
          updates[`${t.col}/${t.key}/status`] = "RETURNED";
          updates[`${t.col}/${t.key}/returnedAt`] = now;
        });
        const person = findLinkedPerson(e.rec);
        if (person) {
          updates[`${person.col}/${person.key}/status`] = "IN";
          updates[`${person.col}/${person.key}/lastMovement`] = now;
        }
      });
      const keys = Object.keys(updates);
      for (let i = 0; i < keys.length; i += WRITE_CHUNK) {
        const part = {};
        keys.slice(i, i + WRITE_CHUNK).forEach((k) => { part[k] = updates[k]; });
        await update(ref(database), part);
      }
      showToast(`✓ ${st.entries.length} pass(es) marked returned — people set back to In`, "success");
      setSelected(new Set());
      setOvMarkIn(null);
    } catch (err) {
      showToast(`⚠ Mark in failed — ${err.message || "check Firebase connection / rules"}`, "error");
    } finally { setBusy(false); }
  };

  /* ---- CHANGE EXPECTED RETURN ---- */
  const openChangeDate = (entry) => {
    const m = String(entry.rec.expectedReturn || "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
    setConfirmText("");
    setOvDate({ entry, date: m ? m[1] : "", time: m && m[2] ? m[2] : "18:00", err: "" });
  };

  const doChangeDate = async () => {
    const st = ovDate;
    if (!st || busy) return;
    if (!st.date || !st.time) { setOvDate((s) => ({ ...s, err: "Please fill in both the date and the time." })); return; }
    setBusy(true);
    try {
      const value = `${st.date}T${st.time}`;
      const now = new Date().toISOString();
      const updates = {};
      findTraces(st.entry).forEach((t) => {
        updates[`${t.col}/${t.key}/expectedReturn`] = value;
        updates[`${t.col}/${t.key}/editedAt`] = now;
      });
      await update(ref(database), updates);
      showToast(`✓ Expected return updated for ${st.entry.name} — ${fmtWhen(value)}`, "success");
      setOvDate(null);
    } catch (err) {
      setOvDate((s) => ({ ...s, err: err.message || "Could not save — check Firebase connection / rules." }));
    } finally { setBusy(false); }
  };

  /* ---- DELETE (single + bulk, all traces, typed confirmation) ---- */
  const openOvDelete = useCallback((entries) => {
    const list = (entries || []).filter(Boolean);
    if (list.length === 0) return;
    const seen = new Set();
    const traces = [];
    list.forEach((e) => findTraces(e).forEach((t) => {
      const id = `${t.col}/${t.key}`;
      if (seen.has(id)) return;
      seen.add(id);
      traces.push(t);
    }));
    setConfirmText("");
    setOvDelete({ entries: list, resetPerson: true, traces });
  }, [findTraces]);

  const doOvDelete = async () => {
    const st = ovDelete;
    if (!st || busy || confirmText !== "DELETE") return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const updates = {};
      /* re-find the traces FRESH — the data may have changed since the
         modal opened; deleting a path that no longer exists is a no-op */
      const seen = new Set();
      st.entries.forEach((e) => findTraces(e).forEach((t) => {
        const id = `${t.col}/${t.key}`;
        if (seen.has(id)) return;
        seen.add(id);
        updates[`${t.col}/${t.key}`] = null;                 // remove every copy of the pass
      }));
      if (st.resetPerson) {
        st.entries.forEach((e) => {
          const person = findLinkedPerson(e.rec);
          if (person && String((person.rec && person.rec.status) || "").toUpperCase() !== "IN") {
            updates[`${person.col}/${person.key}/status`] = "IN";      // nobody stays stuck "Out"
            updates[`${person.col}/${person.key}/lastMovement`] = now;
          }
        });
      }
      const keys = Object.keys(updates);
      for (let i = 0; i < keys.length; i += WRITE_CHUNK) {
        const part = {};
        keys.slice(i, i + WRITE_CHUNK).forEach((k) => { part[k] = updates[k]; });
        await update(ref(database), part);
      }
      showToast(`🗑 Deleted ${seen.size} record(s) — all traces of ${st.entries.length} overdue pass(es) removed`, "success");
      setSelected(new Set());
      setOvDelete(null);
      setConfirmText("");
    } catch (err) {
      showToast(`⚠ Delete failed — ${err.message || "check Firebase connection / rules"}`, "error");
    } finally { setBusy(false); }
  };

  /* ================= CLEANUP BY DATE ================= */
  const openCleanup = () => {
    setConfirmText("");
    setCleanup({ open: true, date: "", report: null, checked: {}, protectedCount: 0 });
  };

  const analyzeCleanup = () => {
    if (!cleanup.date || !dbData) return;
    const [y, m, d] = cleanup.date.split("-").map(Number);
    const cutoff = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const report = [];
    let protectedCount = 0;
    Object.entries(dbData).forEach(([colId, node]) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const doomed = [];
      Object.entries(node).forEach(([key, rec]) => {
        const ts = recordTimestamp(rec && typeof rec === "object" ? rec : null);
        if (ts === null) { protectedCount++; return; }              // no timestamp → protected
        if (ts < cutoff) doomed.push({ key, rec });
      });
      if (doomed.length > 0) report.push({ colId, doomed });
    });
    report.sort((a, b) => b.doomed.length - a.doomed.length);
    const checked = {};
    report.forEach((r) => { checked[r.colId] = true; });
    setCleanup((s) => ({ ...s, report, checked, protectedCount }));
  };

  const toggleCleanupCol = (colId) =>
    setCleanup((s) => ({ ...s, checked: { ...s.checked, [colId]: !s.checked[colId] } }));

  const cleanupDoomedTotal = useMemo(() => {
    if (!cleanup.report) return 0;
    let t = 0;
    cleanup.report.forEach((r) => { if (cleanup.checked[r.colId]) t += r.doomed.length; });
    return t;
  }, [cleanup]);

  const runCleanup = async () => {
    if (busy || confirmText !== "DELETE" || !cleanup.report) return;
    const paths = [];
    cleanup.report.forEach((r) => {
      if (cleanup.checked[r.colId]) r.doomed.forEach((d) => paths.push(`${r.colId}/${d.key}`));
    });
    if (paths.length === 0) return;
    setBusy(true);
    try {
      for (let i = 0; i < paths.length; i += WRITE_CHUNK) {
        const part = {};
        paths.slice(i, i + WRITE_CHUNK).forEach((p) => { part[p] = null; });
        await update(ref(database), part);
      }
      showToast(`🧹 Cleanup complete — ${paths.length} record(s) deleted`, "success");
      setSelected(new Set());
      closeAllModals();
    } catch (err) {
      showToast(`⚠ Cleanup failed — ${err.message || "check Firebase connection / rules"}`, "error");
    } finally { setBusy(false); }
  };

  /* ================= BACKUP ================= */
  const handleBackup = () => {
    if (!dbData || Object.keys(dbData).length === 0) {
      showToast("⚠ The database is empty — nothing to back up.", "error");
      return;
    }
    const counts = {};
    let total = 0;
    Object.entries(dbData).forEach(([c, node]) => {
      const n = node && typeof node === "object" && !Array.isArray(node) ? Object.keys(node).length : 1;
      counts[c] = n;
      total += n;
    });
    const payload = {
      app: "DPIRS PassPort",
      kind: "passport-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      totalRecords: total,
      collections: counts,
      data: dbData,
    };
    const size = downloadJson(`passport-backup-${stampNow()}.json`, payload);
    showToast(`✓ Backup downloaded — ${collections.length} collection(s) · ${total} record(s) · ${(size / 1024).toFixed(1)} KB`, "success");
  };

  /* ================= RESTORE (merge, no duplication) ================= */
  const openRestorePicker = () => restoreFileRef.current?.click();

  const handleRestoreFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.json$/i.test(file.name)) { showToast("⚠ Please select a .json backup file.", "error"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try { parsed = JSON.parse(String(reader.result || "")); }
      catch { showToast("⚠ The file is not valid JSON.", "error"); return; }

      /* accept a PassPort backup file, or a plain { collection: { id: record } } object */
      let cols = null;
      if (parsed && parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
        cols = parsed.data;
      } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const allCols = Object.entries(parsed).every(([, v]) => v === null || (v && typeof v === "object" && !Array.isArray(v)));
        if (allCols) cols = parsed;
      }
      if (!cols) { showToast("⚠ Unrecognised backup structure — expected a PassPort backup file.", "error"); return; }

      const preview = [];
      let freshTotal = 0, dupTotal = 0, invalid = 0;
      Object.entries(cols).forEach(([colId, recs]) => {
        if (!recs || typeof recs !== "object" || Array.isArray(recs)) return;
        const current = (dbData && dbData[colId]) || {};
        let fresh = 0, dup = 0;
        Object.entries(recs).forEach(([key, rec]) => {
          if (rec === null || typeof rec !== "object" || Array.isArray(rec) || /[.#$/[\]]/.test(key)) { invalid++; return; }
          if (Object.prototype.hasOwnProperty.call(current, key)) dup++; else fresh++;
        });
        freshTotal += fresh;
        dupTotal += dup;
        preview.push({ colId, label: labelOf(colId), total: Object.keys(recs).length, fresh, dup });
      });
      if (preview.length === 0) { showToast("⚠ The backup file contains no restorable records.", "error"); return; }

      restoreDataRef.current = cols;
      setConfirmText("");
      setRestore({ open: true, fileName: file.name, preview, freshTotal, dupTotal, invalid, overwrite: false, done: null });
    };
    reader.onerror = () => showToast("⚠ Could not read the selected file.", "error");
    reader.readAsText(file);
  };

  const doRestore = async () => {
    const cols = restoreDataRef.current;
    if (!cols || busy || confirmText !== "RESTORE") return;
    setBusy(true);
    try {
      const updates = {};
      let added = 0, overwritten = 0, skipped = 0;
      Object.entries(cols).forEach(([colId, recs]) => {
        if (!recs || typeof recs !== "object" || Array.isArray(recs)) return;
        const current = (dbData && dbData[colId]) || {};
        Object.entries(recs).forEach(([key, rec]) => {
          if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return;
          if (/[.#$/[\]]/.test(key)) return;
          const exists = Object.prototype.hasOwnProperty.call(current, key);
          if (exists && !restore.overwrite) { skipped++; return; }   // merge without duplication
          updates[`${colId}/${key}`] = rec;
          if (exists) overwritten++; else added++;
        });
      });
      const keys = Object.keys(updates);
      for (let i = 0; i < keys.length; i += WRITE_CHUNK) {
        const part = {};
        keys.slice(i, i + WRITE_CHUNK).forEach((k) => { part[k] = updates[k]; });
        await update(ref(database), part);
      }
      showToast(`✓ Restore complete — ${added} added · ${overwritten} overwritten · ${skipped} duplicate(s) skipped`, "success");
      setConfirmText("");
      setRestore((s) => ({ ...s, done: { added, overwritten, skipped } }));
    } catch (err) {
      showToast(`⚠ Restore failed — ${err.message || "check Firebase connection / rules"}`, "error");
    } finally { setBusy(false); }
  };

  /* ================= EXPORTS ================= */
  const exportCollection = () => {
    if (!activeCol || !dbData || !dbData[activeCol]) return;
    const node = dbData[activeCol];
    const count = Object.keys(node).length;
    const size = downloadJson(`${activeCol}-${stampNow()}.json`, {
      collection: activeCol,
      exportedAt: new Date().toISOString(),
      count,
      data: node,
    });
    showToast(`✓ ${labelOf(activeCol)} exported — ${count} record(s) · ${(size / 1024).toFixed(1)} KB`, "success");
  };

  const exportSelected = () => {
    if (activeCol === OVERDUE_ID) {
      const data = {};
      overdueList.filter((e) => selected.has(e.uid)).forEach((e) => { data[e.key] = e.rec; });
      const n = Object.keys(data).length;
      if (n === 0) return;
      downloadJson(`overdue-selection-${stampNow()}.json`, {
        kind: "passport-overdue-selection",
        exportedAt: new Date().toISOString(),
        count: n,
        data,
      });
      showToast(`✓ ${n} selected overdue pass(es) exported`, "success");
      return;
    }
    const data = {};
    records.filter((r) => selected.has(r._key)).forEach((r) => {
      const { _key, ...rest } = r;
      data[_key] = rest;
    });
    if (Object.keys(data).length === 0) return;
    downloadJson(`${activeCol}-selection-${stampNow()}.json`, {
      collection: activeCol,
      exportedAt: new Date().toISOString(),
      count: Object.keys(data).length,
      data,
    });
    showToast(`✓ ${Object.keys(data).length} selected record(s) exported`, "success");
  };

  const exportOverdue = () => {
    if (ovFiltered.length === 0) { showToast("⚠ No overdue records to export.", "error"); return; }
    const data = ovFiltered.map((e) => ({
      ...e.rec,
      _overdueBy: overdueByLabel(e.expectedMs),
      _collection: e.col,
    }));
    const size = downloadJson(`overdue-passes-${stampNow()}.json`, {
      kind: "passport-overdue-export",
      exportedAt: new Date().toISOString(),
      count: data.length,
      data,
    });
    showToast(`✓ ${data.length} overdue pass(es) exported · ${(size / 1024).toFixed(1)} KB`, "success");
  };

  /* ================= RENDER ================= */
  return (
    <section className="ma">
      {/* ---------- header ---------- */}
      <header className="ma-header">
        <div className="ma-brand">
          <div className="ma-logo">🛡️</div>
          <div>
            <h1 className="ma-title">Master Admin</h1>
            <p className="ma-sub">Full database control — view · edit · delete · overdue · backup · restore</p>
          </div>
        </div>

        <div className="ma-live">
          <span className="ma-live-dot" />
          <span className="ma-live-text">Live</span>
          <span className="ma-live-meta">
            {ready ? `${collections.length} collections · ${totalRecords} records` : "connecting…"}
            {lastSync ? ` · synced ${lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
          </span>
        </div>

        <div className="ma-actions">
          <button
            type="button"
            className={`ma-btn ${overdueList.length > 0 ? "ma-btn-danger" : "ma-btn-ghost"}`}
            onClick={openOverdue}
            title="Issued passes past their expected return"
          >
            ⚠ Overdue{overdueList.length > 0 ? ` · ${overdueList.length}` : ""}
          </button>
          <button type="button" className="ma-btn ma-btn-warn" onClick={openCleanup}>🧹 Cleanup by date</button>
          <button type="button" className="ma-btn ma-btn-ghost" onClick={openRestorePicker}>♻️ Restore backup</button>
          <button type="button" className="ma-btn ma-btn-primary" onClick={handleBackup} disabled={!ready}>💾 Backup database</button>
          <input ref={restoreFileRef} type="file" accept=".json,application/json" className="ma-file-hidden" onChange={handleRestoreFile} />
        </div>
      </header>

      {ready && (
        <div className="ma-notice">
          ⚠ Master data zone — every change on this page writes straight to the live database. Destructive actions ask for a typed confirmation.
        </div>
      )}
      {dbError && (
        <div className="ma-error-banner">
          ⚠ Could not read the database — {dbError}. This page needs read access to the database root (check your Firebase rules).
        </div>
      )}

      <div className="ma-body">
        {/* ---------- sidebar: overdue center + all collections ---------- */}
        <aside className="ma-side">
          <div className="ma-side-stats">
            <div className="ma-stat">
              <span className="ma-stat-num">{collections.length}</span>
              <span className="ma-stat-label">Collections</span>
            </div>
            <div className="ma-stat">
              <span className="ma-stat-num">{totalRecords}</span>
              <span className="ma-stat-label">Records</span>
            </div>
            
          </div>

          <div className="ma-group">
            <div className="ma-group-label">⚠ Action center</div>
            <button
              type="button"
              className={`ma-col-item ma-col-overdue ${activeCol === OVERDUE_ID ? "active" : ""}`}
              onClick={openOverdue}
              title="Issued passes past their expected return — mark in, fix the date or delete"
            >
              <span className="ma-col-icon">⚠️</span>
              <span className="ma-col-name">Overdue passes</span>
              <span className={`ma-col-count ${overdueList.length > 0 ? "ma-col-count-red" : ""}`}>{overdueList.length}</span>
            </button>
          </div>

          {grouped.map((g) => (
            <div className="ma-group" key={g.id}>
              <div className="ma-group-label">{g.icon} {g.label}</div>
              {g.items.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`ma-col-item ${c.id === activeCol ? "active" : ""}`}
                  onClick={() => openCollection(c.id)}
                  title={c.desc}
                >
                  <span className="ma-col-icon">{c.icon}</span>
                  <span className="ma-col-name">{c.label}</span>
                  <span className="ma-col-count">{c.count}</span>
                </button>
              ))}
            </div>
          ))}

          {dbUrl && <div className="ma-dburl" title={dbUrl}>{dbUrl}</div>}
        </aside>

        {/* ---------- main panel ---------- */}
        <main className="ma-main">
          {!ready ? (
            <div className="ma-table-wrap">
              {[0, 1, 2, 3, 4, 5].map((i) => <div className="ma-skeleton" key={i} />)}
            </div>
          ) : collections.length === 0 ? (
            <div className="ma-table-wrap">
              <div className="ma-empty">
                <div className="ma-empty-icon">🗄️</div>
                <h3>No collections found</h3>
                <p>The database is empty or no top-level collections could be read.</p>
              </div>
            </div>
          ) : activeCol === OVERDUE_ID ? (
            /* ==========================================================
               ⚠ OVERDUE CENTER — dedicated management view
               ========================================================== */
            <>
              <div className="ma-col-head ma-col-head-overdue">
                <span className="ma-col-head-icon ma-col-head-icon-red">⚠️</span>
                <div className="ma-col-head-text">
                  <div className="ma-col-head-row">
                    <h2>Overdue passes</h2>
                    <span className="ma-chip ma-chip-red">{overdueList.length} overdue</span>
                  </div>
                  <p>Issued passes past their expected return — mark the person back in, correct the expected return, or remove the record with all its traces.</p>
                </div>
              </div>

              <div className="ma-ov-stats">
                <div className="ma-ov-stat">
                  <span className="ma-ov-num ma-ov-red">{overdueList.length}</span>
                  <span className="ma-ov-lab">Overdue</span>
                </div>
                <div className="ma-ov-stat">
                  <span className="ma-ov-num">{ovStats.students}</span>
                  <span className="ma-ov-lab">Students</span>
                </div>
                <div className="ma-ov-stat">
                  <span className="ma-ov-num">{ovStats.staff}</span>
                  <span className="ma-ov-lab">Staff</span>
                </div>
                <div className="ma-ov-stat">
                  <span className="ma-ov-num ma-ov-red">{ovStats.longest}</span>
                  <span className="ma-ov-lab">Longest overdue</span>
                </div>
              </div>

              <div className="ma-toolbar">
                <div className="ma-searchbox">
                  <span className="ma-search-icon">🔍</span>
                  <input
                    value={ovSearch}
                    onChange={(e) => { setOvSearch(e.target.value); setPage(1); }}
                    placeholder="Search overdue — name, ID, reason, slip no…"
                    aria-label="Search overdue records"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {ovSearch && (
                    <button type="button" className="ma-search-clear" onClick={() => { setOvSearch(""); setPage(1); }} aria-label="Clear search">×</button>
                  )}
                </div>

                <div className="ma-fchips">
                  <button type="button" className={`ma-fchip ${ovScope === "ALL" ? "ma-fchip-on" : ""}`} onClick={() => { setOvScope("ALL"); setPage(1); }}>
                    All <span className="ma-fchip-n">{overdueList.length}</span>
                  </button>
                  <button type="button" className={`ma-fchip ${ovScope === "STUDENT" ? "ma-fchip-on" : ""}`} onClick={() => { setOvScope("STUDENT"); setPage(1); }}>
                    Students <span className="ma-fchip-n">{ovStats.students}</span>
                  </button>
                  <button type="button" className={`ma-fchip ${ovScope === "STAFF" ? "ma-fchip-on" : ""}`} onClick={() => { setOvScope("STAFF"); setPage(1); }}>
                    Staff <span className="ma-fchip-n">{ovStats.staff}</span>
                  </button>
                </div>

                <div className="ma-toolbar-actions">
                  <button type="button" className="ma-btn ma-btn-ghost" onClick={exportOverdue}>⬇ Export overdue</button>
                </div>
              </div>

              {selected.size > 0 && (
                <div className="ma-bulkbar">
                  <span className="ma-bulkbar-count">{selected.size} selected</span>
                  <button type="button" className="ma-btn ma-btn-ghost ma-btn-sm" onClick={selectAllFiltered}>
                    Select all {ovFiltered.length} shown
                  </button>
                  <button type="button" className="ma-btn ma-btn-ghost ma-btn-sm" onClick={clearSelection}>Clear</button>
                  <span className="ma-bulkbar-spacer" />
                  <button type="button" className="ma-btn ma-btn-ghost ma-btn-sm" onClick={exportSelected}>⬇ Export selected</button>
                  <button
                    type="button"
                    className="ma-btn ma-btn-markin ma-btn-sm"
                    onClick={() => setOvMarkIn({ entries: overdueList.filter((e) => selected.has(e.uid)) })}
                  >
                    ✓ Mark In selected
                  </button>
                  <button
                    type="button"
                    className="ma-btn ma-btn-danger ma-btn-sm"
                    onClick={() => openOvDelete(overdueList.filter((e) => selected.has(e.uid)))}
                  >
                    🗑 Delete selected
                  </button>
                </div>
              )}

              <div className="ma-table-wrap">
                {overdueList.length === 0 ? (
                  <div className="ma-empty">
                    <div className="ma-empty-icon">✅</div>
                    <h3>No overdue passes</h3>
                    <p>Every issued pass is within its expected return time — all clear.</p>
                  </div>
                ) : ovFiltered.length === 0 ? (
                  <div className="ma-empty">
                    <div className="ma-empty-icon">🔍</div>
                    <h3>No matching overdue records</h3>
                    <p>Nothing matches your search or filter.</p>
                    <div className="ma-empty-actions">
                      <button type="button" className="ma-btn ma-btn-ghost" onClick={() => { setOvSearch(""); setOvScope("ALL"); setPage(1); }}>Clear search &amp; filter</button>
                    </div>
                  </div>
                ) : (
                  <table className="ma-table">
                    <thead>
                      <tr>
                        <th className="ma-th ma-th-check">
                          <input
                            ref={headCheckRef}
                            type="checkbox"
                            checked={allPageSelected}
                            onChange={togglePage}
                            title="Select all records on this page"
                            aria-label="Select all on page"
                          />
                        </th>
                        <th
                          className={`ma-th ma-th-sortable ${ovSort.field === "name" ? "ma-th-sorted" : ""}`}
                          onClick={() => toggleOvSort("name")}
                          title="Click to sort"
                        >
                          Person<span className="ma-sort">{ovSort.field === "name" ? (ovSort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                        </th>
                        <th className="ma-th">Class / Dept</th>
                        <th className="ma-th">Type</th>
                        <th
                          className={`ma-th ma-th-sortable ${ovSort.field === "out" ? "ma-th-sorted" : ""}`}
                          onClick={() => toggleOvSort("out")}
                          title="Click to sort"
                        >
                          Out since<span className="ma-sort">{ovSort.field === "out" ? (ovSort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                        </th>
                        <th
                          className={`ma-th ma-th-sortable ${ovSort.field === "expected" ? "ma-th-sorted" : ""}`}
                          onClick={() => toggleOvSort("expected")}
                          title="Click to sort — most overdue first by default"
                        >
                          Expected return<span className="ma-sort">{ovSort.field === "expected" ? (ovSort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                        </th>
                        <th className="ma-th">Lives in</th>
                        <th className="ma-th ma-th-actions">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ovPageRows.map((e) => (
                        <tr key={e.uid} className={selected.has(e.uid) ? "ma-row-selected" : ""}>
                          <td className="ma-td ma-td-check">
                            <input
                              type="checkbox"
                              checked={selected.has(e.uid)}
                              onChange={() => toggleOne(e.uid)}
                              aria-label="Select record"
                            />
                          </td>

                          <td
                            className="ma-td ma-td-record"
                            onClick={() => setDetail({ col: e.col, key: e.key })}
                            title="Click to view the full record"
                          >
                            <div className="ma-record">
                              <span className="ma-avatar">{getInitials(e.name)}</span>
                              <div className="ma-record-text">
                                <span className="ma-record-name">{e.name}</span>
                                <code className="ma-record-key">{e.ident || e.rec.slipNo || e.key}</code>
                              </div>
                            </div>
                          </td>

                          <td className="ma-td"><span className="ma-cell-text" title={e.group}>{e.group}</span></td>
                          <td className="ma-td">
                            <span className="ma-pill ma-pill-gray">{KIND_LABELS[String(e.rec.kind || "").toUpperCase()] || "Pass"}</span>
                          </td>
                          <td className="ma-td">
                            <span className="ma-date">{e.outMs ? fmtWhen(new Date(e.outMs).toISOString()) : "—"}</span>
                          </td>
                          <td className="ma-td">
                            <span className="ma-date">{fmtWhen(e.rec.expectedReturn)}</span>
                            <span className="ma-ovtag">overdue by {overdueByLabel(e.expectedMs)}</span>
                          </td>
                          <td className="ma-td">
                            <code className="ma-mono" title={e.col}>{labelOf(e.col)}</code>
                          </td>
                          <td className="ma-td ma-td-actions">
                            <button
                              type="button"
                              className="ma-act-markin"
                              disabled={busy}
                              onClick={() => markInOne(e)}
                              title="Mark as returned — the person is set back to In"
                            >
                              ✓ Mark In
                            </button>
                            <button
                              type="button"
                              className="ma-act ma-act-date"
                              onClick={() => openChangeDate(e)}
                              title="Change the expected return date & time"
                            >
                              📅
                            </button>
                            <button
                              type="button"
                              className="ma-act ma-act-del"
                              onClick={() => openOvDelete([e])}
                              title="Delete this pass with all its traces"
                            >
                              🗑
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          ) : !activeMeta ? (
            <div className="ma-table-wrap">
              {[0, 1, 2, 3, 4, 5].map((i) => <div className="ma-skeleton" key={i} />)}
            </div>
          ) : (
            /* ==========================================================
               COLLECTION VIEW (unchanged behaviour)
               ========================================================== */
            <>
              {/* collection header */}
              <div className="ma-col-head">
                <span className="ma-col-head-icon">{activeMeta.icon}</span>
                <div className="ma-col-head-text">
                  <div className="ma-col-head-row">
                    <h2>{activeMeta.label}</h2>
                    <span className="ma-chip">{activeMeta.count} record{activeMeta.count === 1 ? "" : "s"}</span>
                    {isMasterActive && <span className="ma-chip ma-chip-warn">Master data — handle with care</span>}
                  </div>
                  <p>{activeMeta.desc} · node <code>{activeCol}</code></p>
                </div>
              </div>

              {/* toolbar */}
              <div className="ma-toolbar">
                <div className="ma-searchbox">
                  <span className="ma-search-icon">🔍</span>
                  <input
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                    placeholder={`Search in ${activeMeta.label} — any field or record key…`}
                    aria-label="Search records"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {search && (
                    <button type="button" className="ma-search-clear" onClick={() => { setSearch(""); setPage(1); }} aria-label="Clear search">×</button>
                  )}
                </div>
                <div className="ma-toolbar-actions">
                  <button type="button" className="ma-btn ma-btn-primary" onClick={openAdd}>＋ Add record</button>
                  <button type="button" className="ma-btn ma-btn-ghost" onClick={exportCollection}>⬇ Export</button>
                </div>
              </div>

              {/* bulk bar */}
              {selected.size > 0 && (
                <div className="ma-bulkbar">
                  <span className="ma-bulkbar-count">{selected.size} selected</span>
                  <button type="button" className="ma-btn ma-btn-ghost ma-btn-sm" onClick={selectAllFiltered}>
                    Select all {filtered.length} shown
                  </button>
                  <button type="button" className="ma-btn ma-btn-ghost ma-btn-sm" onClick={clearSelection}>Clear</button>
                  <span className="ma-bulkbar-spacer" />
                  <button type="button" className="ma-btn ma-btn-ghost ma-btn-sm" onClick={exportSelected}>⬇ Export selected</button>
                  <button
                    type="button"
                    className="ma-btn ma-btn-danger ma-btn-sm"
                    onClick={() => { setConfirmText(""); setDelBulkOpen(true); }}
                  >
                    🗑 Delete selected
                  </button>
                </div>
              )}

              {/* table */}
              <div className="ma-table-wrap">
                {records.length === 0 ? (
                  <div className="ma-empty">
                    <div className="ma-empty-icon">{activeMeta.icon}</div>
                    <h3>No records yet</h3>
                    <p>This collection is empty.</p>
                    <div className="ma-empty-actions">
                      <button type="button" className="ma-btn ma-btn-primary" onClick={openAdd}>＋ Add record</button>
                    </div>
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="ma-empty">
                    <div className="ma-empty-icon">🔍</div>
                    <h3>No matching records</h3>
                    <p>Nothing in {activeMeta.label} matches “{search}”.</p>
                    <div className="ma-empty-actions">
                      <button type="button" className="ma-btn ma-btn-ghost" onClick={() => { setSearch(""); setPage(1); }}>Clear search</button>
                    </div>
                  </div>
                ) : (
                  <table className="ma-table">
                    <thead>
                      <tr>
                        <th className="ma-th ma-th-check">
                          <input
                            ref={headCheckRef}
                            type="checkbox"
                            checked={allPageSelected}
                            onChange={togglePage}
                            title="Select all records on this page"
                            aria-label="Select all on page"
                          />
                        </th>
                        <th className="ma-th">Record</th>
                        {dataCols.map((f) => (
                          <th
                            key={f}
                            className={`ma-th ma-th-sortable ${sort.field === f ? "ma-th-sorted" : ""}`}
                            onClick={() => toggleSort(f)}
                            title="Click to sort"
                          >
                            {prettifyKey(f)}<span className="ma-sort">{sort.field === f ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                          </th>
                        ))}
                        <th
                          className={`ma-th ma-th-sortable ${sort.field === "__activity" ? "ma-th-sorted" : ""}`}
                          onClick={() => toggleSort("__activity")}
                          title="Latest stored / updated timestamp — click to sort"
                        >
                          Last activity<span className="ma-sort">{sort.field === "__activity" ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
                        </th>
                        <th className="ma-th ma-th-actions">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((r) => {
                        const ts = tsMap.get(r._key);
                        return (
                          <tr key={r._key} className={selected.has(r._key) ? "ma-row-selected" : ""}>
                            <td className="ma-td ma-td-check">
                              <input
                                type="checkbox"
                                checked={selected.has(r._key)}
                                onChange={() => toggleOne(r._key)}
                                aria-label="Select record"
                              />
                            </td>

                            <td
                              className="ma-td ma-td-record"
                              onClick={() => setDetail({ col: activeCol, key: r._key })}
                              title="Click to view the full record"
                            >
                              <div className="ma-record">
                                <span className="ma-avatar">{getInitials(recName(r) || r._key)}</span>
                                <div className="ma-record-text">
                                  <span className="ma-record-name">{recName(r) || r._key}</span>
                                  <code className="ma-record-key" title={r._key}>{r._key}</code>
                                </div>
                              </div>
                            </td>

                            {dataCols.map((f) => (
                              <td className="ma-td" key={f}>{renderCell(r, f)}</td>
                            ))}

                            <td className="ma-td">
                              {ts != null
                                ? <span className="ma-date">{fmtWhen(ts)}</span>
                                : <span className="ma-muted">no date</span>}
                            </td>

                            <td className="ma-td ma-td-actions">
                              <button type="button" className="ma-act ma-act-view" onClick={() => setDetail({ col: activeCol, key: r._key })} title="View record">👁</button>
                              <button type="button" className="ma-act ma-act-edit" onClick={() => startEdit(activeCol, r._key, r)} title="Edit record">✏️</button>
                              <button type="button" className="ma-act ma-act-del" onClick={() => { setConfirmText(""); setDelOne({ col: activeCol, key: r._key }); }} title="Delete record">🗑</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}

          {/* ---------- shared footer: counts + pagination (both views) ---------- */}
          {ready && collections.length > 0 && (
            <footer className="ma-foot">
              <span className="ma-showing">
                Showing <strong>{startIdx}–{endIdx}</strong> of <strong>{activeFilteredRows.length}</strong> record(s)
                {isSearchActive ? ` matching · ${totalActiveRecords} total` : ` · ${PAGE_SIZE} / page`}
              </span>
              <nav className="ma-pager" aria-label="Pagination">
                <button type="button" className="ma-pager-btn" onClick={() => goPage(1)} disabled={page === 1} title="First page">«</button>
                <button type="button" className="ma-pager-btn" onClick={() => goPage(page - 1)} disabled={page === 1} title="Previous page">‹</button>
                {pageItems.map((p, idx) =>
                  p === "…" ? (
                    <span key={`e${idx}`} className="ma-pager-ellipsis">…</span>
                  ) : (
                    <button
                      type="button"
                      key={p}
                      className={`ma-pager-btn ${p === page ? "ma-pager-active" : ""}`}
                      onClick={() => goPage(p)}
                    >
                      {p}
                    </button>
                  )
                )}
                <button type="button" className="ma-pager-btn" onClick={() => goPage(page + 1)} disabled={page === activeTotalPages} title="Next page">›</button>
                <button type="button" className="ma-pager-btn" onClick={() => goPage(activeTotalPages)} disabled={page === activeTotalPages} title="Last page">»</button>
              </nav>
            </footer>
          )}
        </main>
      </div>

      {/* ---------- record viewer ---------- */}
      {detail && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal" role="dialog" aria-modal="true" aria-label="Record details">
            <div className="ma-modal-head">
              <h3>📄 Record details</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              {detailRec ? (
                <>
                  <div className="ma-detail-id">
                    <span className="ma-avatar">{getInitials(recName(detailRec) || detail.key)}</span>
                    <div>
                      <strong>{recName(detailRec) || detail.key}</strong>
                      <code>{labelOf(detail.col)} · {detail.key}</code>
                    </div>
                  </div>
                  {renderKvList(detailRec)}
                </>
              ) : (
                <div className="ma-modal-note">This record no longer exists — it may have been deleted.</div>
              )}
            </div>
            {detailRec && (
              <div className="ma-modal-foot">
                <button
                  type="button"
                  className="ma-btn ma-btn-danger"
                  onClick={() => { setConfirmText(""); setDelOne({ col: detail.col, key: detail.key }); }}
                >
                  🗑 Delete
                </button>
                <span className="ma-foot-spacer" />
                <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals}>Close</button>
                <button type="button" className="ma-btn ma-btn-primary" onClick={() => startEdit(detail.col, detail.key, detailRec)}>✏️ Edit record</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------- edit record ---------- */}
      {editState && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal ma-modal-wide" role="dialog" aria-modal="true" aria-label="Edit record">
            <div className="ma-modal-head">
              <h3>✏️ Edit record — {labelOf(editState.col)}</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              <div className="ma-edit-meta">
                <span>Collection</span><strong>{labelOf(editState.col)}</strong>
                <span>Key</span><code>{editState.key}</code>
              </div>
              <p className="ma-modal-hint">
                Saving writes this record straight to Firebase. Edit the values, remove fields you no
                longer need or add new ones — existing field names are locked to keep the data shape intact.
                JSON fields must stay valid JSON.
              </p>
              {renderFieldEditor(editState.entries, { nameEditable: (e) => !!e.isNew, onText: editText, onName: editName, onRemove: editRemove })}
              <button type="button" className="ma-btn ma-btn-ghost ma-btn-sm" onClick={editAddField}>＋ Add field</button>
              {editState.err && <p className="ma-form-error">⚠ {editState.err}</p>}
            </div>
            <div className="ma-modal-foot">
              <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals} disabled={busy}>Cancel</button>
              <span className="ma-foot-spacer" />
              <button type="button" className="ma-btn ma-btn-primary" onClick={saveEdit} disabled={busy}>
                {busy ? "Saving…" : "💾 Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- add record ---------- */}
      {addState && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal ma-modal-wide" role="dialog" aria-modal="true" aria-label="Add record">
            <div className="ma-modal-head">
              <h3>＋ Add record — {labelOf(addState.col)}</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              <div className="ma-edit-meta">
                <span>Collection</span><strong>{labelOf(addState.col)}</strong>
                <span>Record key</span><code>{addState.key} (auto)</code>
              </div>
              <p className="ma-modal-hint">
                Values are saved as text.
                {addState.usesId ? " The record’s _id is set to the key automatically, matching this collection’s convention." : ""}
              </p>
              {renderFieldEditor(addState.entries, { nameEditable: () => true, onText: addText, onName: addName, onRemove: addRemove })}
              <button type="button" className="ma-btn ma-btn-ghost ma-btn-sm" onClick={addFieldRow}>＋ Add field</button>
              {addState.err && <p className="ma-form-error">⚠ {addState.err}</p>}
            </div>
            <div className="ma-modal-foot">
              <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals} disabled={busy}>Cancel</button>
              <span className="ma-foot-spacer" />
              <button type="button" className="ma-btn ma-btn-primary" onClick={saveAdd} disabled={busy}>
                {busy ? "Saving…" : "💾 Save record"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- delete single (collection view) ---------- */}
      {delOne && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal ma-modal-danger" role="dialog" aria-modal="true" aria-label="Delete record">
            <div className="ma-modal-head">
              <h3>🗑 Delete this record?</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              <div className="ma-detail-id">
                <span className="ma-avatar">{getInitials(delOneRec ? (recName(delOneRec) || delOne.key) : delOne.key)}</span>
                <div>
                  <strong>{delOneRec ? (recName(delOneRec) || delOne.key) : delOne.key}</strong>
                  <code>{labelOf(delOne.col)} · {delOne.key}</code>
                </div>
              </div>
              {delOneRec ? renderKvList(delOneRec, 8) : (
                <div className="ma-modal-note">This record no longer exists in the database.</div>
              )}
              {MASTER_COLLECTIONS.indexOf(delOne.col) !== -1 && (
                <div className="ma-warn-box">
                  ⚠ This is <strong>master data</strong> — pass records that link to it will lose their reference.
                </div>
              )}
              <p className="ma-modal-warn">
                This permanently removes the record from <strong>{labelOf(delOne.col)}</strong>.
              </p>
            </div>
            <div className="ma-modal-foot">
              <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals} disabled={busy}>Cancel</button>
              <span className="ma-foot-spacer" />
              <button type="button" className="ma-btn ma-btn-danger" onClick={doDeleteOne} disabled={busy}>
                {busy ? "Deleting…" : "🗑 Delete record"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- bulk delete (collection view — typed confirmation) ---------- */}
      {delBulkOpen && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal ma-modal-danger" role="dialog" aria-modal="true" aria-label="Bulk delete">
            <div className="ma-modal-head">
              <h3>🗑 Delete {selected.size} record(s)?</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              <div className="ma-detail-id">
                <span className="ma-avatar">{getInitials(labelOf(activeCol))}</span>
                <div>
                  <strong>{selected.size} record(s) from {labelOf(activeCol)}</strong>
                  <code>{activeCol}</code>
                </div>
              </div>
              {selectedNames.length > 0 && (
                <p className="ma-sample-line">
                  {selectedNames.slice(0, 6).join(", ")}
                  {selectedNames.length > 6 ? ` … +${selectedNames.length - 6} more` : ""}
                </p>
              )}
              {isMasterActive && (
                <div className="ma-warn-box">
                  ⚠ You are deleting <strong>master data</strong> ({labelOf(activeCol)}). Pass records that link to
                  these records will lose their reference. Consider taking a backup first.
                </div>
              )}
              <div className="ma-confirm-line">
                <span className="ma-confirm-label">Type <code>DELETE</code> to confirm</span>
                <input
                  className="ma-input ma-confirm-input"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="DELETE"
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <p className="ma-tip">💡 Tip: use <strong>Backup database</strong> in the header first — a backup can restore anything removed by mistake.</p>
            </div>
            <div className="ma-modal-foot">
              <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals} disabled={busy}>Cancel</button>
              <span className="ma-foot-spacer" />
              <button type="button" className="ma-btn ma-btn-danger" onClick={doBulkDelete} disabled={busy || confirmText !== "DELETE"}>
                {busy ? "Deleting…" : `🗑 Delete ${selected.size} record(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- ⚠ OVERDUE: bulk MARK IN confirm ---------- */}
      {ovMarkIn && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal" role="dialog" aria-modal="true" aria-label="Mark people in">
            <div className="ma-modal-head">
              <h3>✓ Mark {ovMarkIn.entries.length} person{ovMarkIn.entries.length === 1 ? "" : "s"} in?</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              <div className="ma-detail-id">
                <span className="ma-avatar">✓</span>
                <div>
                  <strong>{ovMarkIn.entries.length} overdue pass(es) will be closed</strong>
                  <code>overdue center</code>
                </div>
              </div>
              {selectedNames.length > 0 && (
                <p className="ma-sample-line">
                  {selectedNames.slice(0, 6).join(", ")}
                  {selectedNames.length > 6 ? ` … +${selectedNames.length - 6} more` : ""}
                </p>
              )}
              <div className="ma-kv-list">
                <div className="ma-kv">
                  <span className="ma-kv-label">Passes</span>
                  <span className="ma-kv-value">every copy of each pass is closed as <strong>RETURNED</strong> (returnedAt stamped now)</span>
                </div>
                <div className="ma-kv">
                  <span className="ma-kv-label">People</span>
                  <span className="ma-kv-value">each linked student / staff master record is set back to <strong>IN</strong> with a fresh last movement</span>
                </div>
              </div>
              <p className="ma-modal-hint">Use this when the people have already returned but their passes were never closed at the gate desk.</p>
            </div>
            <div className="ma-modal-foot">
              <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals} disabled={busy}>Cancel</button>
              <span className="ma-foot-spacer" />
              <button type="button" className="ma-btn ma-btn-markin" onClick={doOvMarkIn} disabled={busy}>
                {busy ? "Working…" : `✓ Mark In ${ovMarkIn.entries.length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- ⚠ OVERDUE: change expected return ---------- */}
      {ovDate && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal" role="dialog" aria-modal="true" aria-label="Change expected return">
            <div className="ma-modal-head">
              <h3>📅 Change expected return</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              <div className="ma-detail-id">
                <span className="ma-avatar">{getInitials(ovDate.entry.name)}</span>
                <div>
                  <strong>{ovDate.entry.name}</strong>
                  <code>{ovDate.entry.group} · {labelOf(ovDate.entry.col)}</code>
                </div>
              </div>

              <div className="ma-kv-list">
                <div className="ma-kv">
                  <span className="ma-kv-label">Current expected</span>
                  <span className="ma-kv-value">{fmtWhen(ovDate.entry.rec.expectedReturn)} · <strong className="ma-ov-red-text">overdue by {overdueByLabel(ovDate.entry.expectedMs)}</strong></span>
                </div>
                <div className="ma-kv">
                  <span className="ma-kv-label">Out since</span>
                  <span className="ma-kv-value">{ovDate.entry.outMs ? fmtWhen(new Date(ovDate.entry.outMs).toISOString()) : "—"}</span>
                </div>
                <div className="ma-kv">
                  <span className="ma-kv-label">Reason</span>
                  <span className="ma-kv-value">{ovDate.entry.rec.reason || "—"}</span>
                </div>
              </div>

              <div className="ma-cleanup-form">
                <label>
                  New expected return — date &amp; time
                  <div className="ma-daterow">
                    <input
                      type="date"
                      className="ma-input"
                      value={ovDate.date}
                      onChange={(e) => setOvDate((s) => ({ ...s, date: e.target.value, err: "" }))}
                    />
                    <input
                      type="time"
                      className="ma-input"
                      value={ovDate.time}
                      onChange={(e) => setOvDate((s) => ({ ...s, time: e.target.value, err: "" }))}
                    />
                  </div>
                </label>
              </div>

              {ovDate.date && ovDate.time && (() => {
                const nd = parseLocalDate(`${ovDate.date}T${ovDate.time}`);
                if (!nd) return null;
                return nd.getTime() >= startOfTodayMs() ? (
                  <div className="ma-resolve ma-resolve-ok">✓ From this date the pass is no longer overdue — it leaves the overdue list immediately.</div>
                ) : (
                  <div className="ma-resolve ma-resolve-bad">⚠ This date is still before today — the record stays overdue.</div>
                );
              })()}

              <p className="ma-modal-hint">
                The new date is written to <strong>every copy</strong> of this record (editedAt stamped). The person’s
                status is not changed — use <strong>Mark In</strong> for that.
              </p>

              {ovDate.err && <p className="ma-form-error">⚠ {ovDate.err}</p>}
            </div>
            <div className="ma-modal-foot">
              <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals} disabled={busy}>Cancel</button>
              <span className="ma-foot-spacer" />
              <button type="button" className="ma-btn ma-btn-primary" onClick={doChangeDate} disabled={busy || !ovDate.date || !ovDate.time}>
                {busy ? "Saving…" : "💾 Save new date"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- ⚠ OVERDUE: delete (all traces — typed confirmation) ---------- */}
      {ovDelete && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal ma-modal-danger" role="dialog" aria-modal="true" aria-label="Delete overdue pass">
            <div className="ma-modal-head">
              <h3>🗑 Delete {ovDelete.entries.length} overdue pass{ovDelete.entries.length === 1 ? "" : "es"} — all traces?</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              {ovDelete.entries.length === 1 ? (
                <div className="ma-detail-id">
                  <span className="ma-avatar">{getInitials(ovDelete.entries[0].name)}</span>
                  <div>
                    <strong>{ovDelete.entries[0].name}</strong>
                    <code>{ovDelete.entries[0].group} · overdue by {overdueByLabel(ovDelete.entries[0].expectedMs)}</code>
                  </div>
                </div>
              ) : (
                <>
                  <div className="ma-detail-id">
                    <span className="ma-avatar">⚠️</span>
                    <div>
                      <strong>{ovDelete.entries.length} overdue passes selected</strong>
                      <code>all traces will be removed</code>
                    </div>
                  </div>
                  {selectedNames.length > 0 && (
                    <p className="ma-sample-line">
                      {selectedNames.slice(0, 6).join(", ")}
                      {selectedNames.length > 6 ? ` … +${selectedNames.length - 6} more` : ""}
                    </p>
                  )}
                </>
              )}

              <p className="ma-summary-line">
                <strong>{ovDelete.traces.length}</strong> record(s) will be deleted — every copy of {ovDelete.entries.length === 1 ? "this pass" : "these passes"} found anywhere in the database:
              </p>

              <div className="ma-trace-list">
                {ovDelete.traces.map((t) => (
                  <div className="ma-trace" key={`${t.col}/${t.key}`}>
                    <span className="ma-trace-icon">🗂</span>
                    <span className="ma-trace-col">{labelOf(t.col)}</span>
                    <code className="ma-trace-key" title={t.key}>{t.key}</code>
                    <span className="ma-trace-name">{recName(t.rec) || "—"}</span>
                  </div>
                ))}
              </div>

              {ovPersons.length > 0 && (
                <>
                  <p className="ma-summary-line">Linked people found in the master data:</p>
                  <div className="ma-ppl">
                    {ovPersons.map((p) => (
                      <span className="ma-ppl-person" key={`${p.col}/${p.key}`}>
                        👤 {recName(p.rec) || p.key} · <span className={p.status === "OUT" ? "ma-ov-red-text" : ""}>{p.status}</span>
                      </span>
                    ))}
                  </div>
                </>
              )}

              <label className="ma-check-line">
                <input
                  type="checkbox"
                  checked={ovDelete.resetPerson}
                  onChange={(e) => setOvDelete((s) => (s ? { ...s, resetPerson: e.target.checked } : s))}
                />
                <span>
                  <strong>Reset linked people to status “In”</strong>
                  <span>Their “Out” status came from this pass — with the pass gone, leaving them “Out” would be confusing. Recommended.</span>
                </span>
              </label>

              <div className="ma-confirm-line">
                <span className="ma-confirm-label">Type <code>DELETE</code> to permanently remove {ovDelete.traces.length} record(s)</span>
                <input
                  className="ma-input ma-confirm-input"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="DELETE"
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <p className="ma-tip">💡 Tip: use <strong>Backup database</strong> in the header first — a backup can restore anything removed by mistake.</p>
            </div>
            <div className="ma-modal-foot">
              <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals} disabled={busy}>Cancel</button>
              <span className="ma-foot-spacer" />
              <button type="button" className="ma-btn ma-btn-danger" onClick={doOvDelete} disabled={busy || confirmText !== "DELETE"}>
                {busy ? "Deleting…" : `🗑 Delete ${ovDelete.traces.length} record(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- cleanup by date ---------- */}
      {cleanup.open && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal ma-modal-wide" role="dialog" aria-modal="true" aria-label="Cleanup old data">
            <div className="ma-modal-head">
              <h3>🧹 Cleanup old data</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              <p className="ma-modal-hint">
                Deletes every record whose latest <strong>stored / updated</strong> timestamp
                (createdAt, requestedAt, approvedAt, issuedAt, editedAt, lastMovement …) is <strong>before</strong> the chosen
                date. Scheduled times such as <code>expectedReturn</code> and <code>outAt</code> never count, and records
                without any timestamp are never touched.
              </p>

              <div className="ma-cleanup-form">
                <label>
                  Delete data stored / updated before
                  <input
                    type="date"
                    className="ma-input"
                    value={cleanup.date}
                    onChange={(e) => setCleanup((s) => ({ ...s, date: e.target.value, report: null }))}
                  />
                </label>
                <button type="button" className="ma-btn ma-btn-primary" onClick={analyzeCleanup} disabled={!cleanup.date}>
                  Analyze
                </button>
              </div>

              {cleanup.report && (
                cleanup.report.length === 0 ? (
                  <p className="ma-summary-line">✓ Nothing to delete — no record was stored or updated before this date.</p>
                ) : (
                  <>
                    <p className="ma-summary-line">
                      <strong>{cleanupDoomedTotal}</strong> record(s) selected for deletion
                      {cleanup.protectedCount > 0 && (
                        <> · <strong>{cleanup.protectedCount}</strong> record(s) without timestamps will be skipped (protected)</>
                      )}
                    </p>
                    <div className="ma-mini-table">
                      {cleanup.report.map((r) => (
                        <label className="ma-cl-row" key={r.colId}>
                          <input
                            type="checkbox"
                            checked={!!cleanup.checked[r.colId]}
                            onChange={() => toggleCleanupCol(r.colId)}
                          />
                          <span className="ma-cl-name">{labelOf(r.colId)}</span>
                          <code className="ma-cl-node">{r.colId}</code>
                          <span className="ma-cl-count">{r.doomed.length} to delete</span>
                          <span
                            className="ma-cl-sample"
                            title={r.doomed.map((d) => recName(d.rec) || d.key).join(", ")}
                          >
                            {r.doomed.slice(0, 3).map((d) => recName(d.rec) || d.key).join(", ")}
                            {r.doomed.length > 3 ? " …" : ""}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="ma-confirm-line">
                      <span className="ma-confirm-label">Type <code>DELETE</code> to permanently remove {cleanupDoomedTotal} record(s)</span>
                      <input
                        className="ma-input ma-confirm-input"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder="DELETE"
                        autoFocus
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </div>
                    <p className="ma-tip">💡 Tip: use <strong>Backup database</strong> in the header first.</p>
                  </>
                )
              )}
            </div>
            <div className="ma-modal-foot">
              <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals} disabled={busy}>Cancel</button>
              <span className="ma-foot-spacer" />
              <button
                type="button"
                className="ma-btn ma-btn-danger"
                onClick={runCleanup}
                disabled={busy || confirmText !== "DELETE" || cleanupDoomedTotal === 0}
              >
                {busy ? "Working…" : `🧹 Delete ${cleanupDoomedTotal} record(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- restore backup ---------- */}
      {restore.open && (
        <div className="ma-overlay" onMouseDown={backdrop}>
          <div className="ma-modal ma-modal-wide" role="dialog" aria-modal="true" aria-label="Restore backup">
            <div className="ma-modal-head">
              <h3>♻️ Restore backup</h3>
              <button type="button" className="ma-modal-close" onClick={closeAllModals} aria-label="Close">×</button>
            </div>
            <div className="ma-modal-body">
              {restore.done ? (
                <div className="ma-restore-done">
                  <div className="ma-restore-done-icon">✅</div>
                  Restore complete
                  <span>{restore.done.added} added · {restore.done.overwritten} overwritten · {restore.done.skipped} duplicate(s) skipped</span>
                </div>
              ) : (
                <>
                  <div className="ma-file-line">📁 {restore.fileName}</div>
                  <div className="ma-mini-table">
                    <div className="ma-rs-row ma-rs-head">
                      <span>Collection</span><span></span>
                      <span className="ma-rs-num">In backup</span>
                      <span className="ma-rs-num">New</span>
                      <span className="ma-rs-num">Existing</span>
                    </div>
                    {restore.preview.map((p) => (
                      <div className="ma-rs-row" key={p.colId}>
                        <span className="ma-rs-name">{p.label}</span>
                        <code className="ma-cl-node">{p.colId}</code>
                        <span className="ma-rs-num">{p.total}</span>
                        <span className="ma-rs-num ma-rs-new">{p.fresh}</span>
                        <span className="ma-rs-num ma-rs-dup">{p.dup}</span>
                      </div>
                    ))}
                  </div>

                  {restore.invalid > 0 && (
                    <p className="ma-form-error">⚠ {restore.invalid} invalid record(s) in the file will be skipped.</p>
                  )}

                  <label className="ma-check-line">
                    <input
                      type="checkbox"
                      checked={restore.overwrite}
                      onChange={(e) => setRestore((s) => ({ ...s, overwrite: e.target.checked }))}
                    />
                    <span>
                      <strong>Overwrite existing records</strong> with the backup versions
                      <span>
                        Off (recommended) = merge only — existing records are left untouched and duplicates are
                        skipped, so nothing is replaced and nothing is duplicated.
                      </span>
                    </span>
                  </label>

                  <p className="ma-modal-hint">Restore never deletes anything — it only writes records from the backup file back into the database.</p>

                  <div className="ma-confirm-line">
                    <span className="ma-confirm-label">Type <code>RESTORE</code> to confirm</span>
                    <input
                      className="ma-input ma-confirm-input"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="RESTORE"
                      autoFocus
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                </>
              )}
            </div>
            <div className="ma-modal-foot">
              {restore.done ? (
                <>
                  <span className="ma-foot-spacer" />
                  <button type="button" className="ma-btn ma-btn-primary" onClick={closeAllModals}>Done</button>
                </>
              ) : (
                <>
                  <button type="button" className="ma-btn ma-btn-ghost" onClick={closeAllModals} disabled={busy}>Cancel</button>
                  <span className="ma-foot-spacer" />
                  <button
                    type="button"
                    className="ma-btn ma-btn-primary"
                    onClick={doRestore}
                    disabled={busy || confirmText !== "RESTORE"}
                  >
                    {busy ? "Restoring…" : `♻️ Restore ${restore.overwrite ? restore.freshTotal + restore.dupTotal : restore.freshTotal} record(s)`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------- toast ---------- */}
      {toast && (
        <div key={toast.id} className={`ma-toast ma-toast-${toast.type}`}>{toast.text}</div>
      )}
    </section>
  );
}