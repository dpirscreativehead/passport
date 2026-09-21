import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { ref, onValue } from "firebase/database";
import { database } from "../../firebase/config"; // ← same config the other pages use — adjust if this file sits at a different depth
import "./reports.css";

/* =====================================================================
   REPORTS & ANALYTICS — one smart console over EVERY Firebase collection
   ---------------------------------------------------------------------
   • TEN collections merged into one live, de-duplicated dataset:
       Students — studentPass · studentRequest · daypass ·
                  rejectedStudentPass · cancelledStudentPass (+ students)
       Staff    — staffrequests · staffpass · staffrejected (+ staff)
     The two directory nodes are optional — if they don't exist they
     simply report 0 records (onValue on a missing node returns null).
   • SCOPE — Everything / Students / Staff quick chips + a Collection
     dropdown with live record counts for every source.
   • DATE — All time / Today / Yesterday / 7 d / 30 d / CUSTOM range
     (from → to pickers) + a "date basis" selector (last activity /
     raised / issued / returned).
   • SMART SEARCH — every field at once, plus tokens:
       name:john  class:10a  dept:science  id:dp23  status:pending
       type:staff  slip:dp-20250611-001  source:daypass  scope:staff
   • SORT — dropdown (all options) AND clickable table headers.
   • TABLE — clean & minimal: # · Person · Status · ID No.
     Click any row → the FULL record modal (every Firebase field,
     durations, overdue state, live timeline, print).
   • PRINT — full A4-landscape report (filter summary + stats + the
     entire filtered table) AND a per-record A4 detail sheet.
   • EXPORT — Excel (.xls) of exactly what is on screen, with a
     title block, filter summary and stats strip.
   • READ-ONLY — this page never writes to Firebase.
   ===================================================================== */

/* ---------------- constants ---------------- */
const PAGE_SIZE   = 25;
const DAY_MS      = 86400000;
const TIME_FIELDS = ["createdAt","updatedAt","editedAt","requestedAt","approvedAt","issuedAt","printedAt","returnedAt","rejectedAt","cancelledAt"];

const COLLECTIONS = {
  studentPass:          { path: "studentPass",          scope: "STUDENT", label: "Student gate passes",     defKind: "STUDENT_PASS", defStatus: "ISSUED"    },
  studentRequest:       { path: "studentRequest",       scope: "STUDENT", label: "Pending student requests",defKind: "DAY_PASS",     defStatus: "REQUESTED" },
  daypass:              { path: "daypass",              scope: "STUDENT", label: "Approved day passes",    defKind: "DAY_PASS",     defStatus: "APPROVED"  },
  rejectedStudentPass:  { path: "rejectedStudentPass",  scope: "STUDENT", label: "Rejected student records",defKind: "DAY_PASS",     defStatus: "REJECTED"  },
  cancelledStudentPass: { path: "cancelledStudentPass", scope: "STUDENT", label: "Cancelled student records",defKind: "DAY_PASS",    defStatus: "CANCELLED" },
  staffrequests:        { path: "staffrequests",        scope: "STAFF",   label: "Pending staff requests", defKind: "STAFF_PASS",   defStatus: "REQUESTED" },
  staffpass:            { path: "staffpass",            scope: "STAFF",   label: "Staff passes",           defKind: "STAFF_PASS",   defStatus: "ISSUED"    },
  staffrejected:        { path: "staffrejected",        scope: "STAFF",   label: "Rejected staff records", defKind: "STAFF_PASS",   defStatus: "REJECTED"  },
  /* optional master directories — safe even if these nodes don't exist */
  students:             { path: "students",             scope: "STUDENT", label: "Student directory",      defKind: "DIRECTORY",    defStatus: "LISTED"    },
  staff:                { path: "staff",                scope: "STAFF",   label: "Staff directory",        defKind: "DIRECTORY",    defStatus: "LISTED"    },
};

const STATUS_ORDER = ["REQUESTED","APPROVED","ISSUED","RETURNED","REJECTED","CANCELLED","LISTED"];

const STATUS_META = {
  REQUESTED: { label: "Pending",   verb: "Raised",    icon: "⏳", tone: "amber" },
  APPROVED:  { label: "Approved",  verb: "Approved",  icon: "✓",  tone: "blue"  },
  ISSUED:    { label: "Issued",    verb: "Issued",    icon: "🎫", tone: "green" },
  RETURNED:  { label: "Returned",  verb: "Returned",  icon: "↩",  tone: "slate" },
  REJECTED:  { label: "Rejected",  verb: "Rejected",  icon: "⛔", tone: "red"   },
  CANCELLED: { label: "Cancelled", verb: "Cancelled", icon: "⊘",  tone: "gray"  },
  LISTED:    { label: "Listed",    verb: "Listed",    icon: "📇", tone: "gray"  },
};

const KIND_META = {
  STUDENT_PASS: "Student pass",
  DAY_PASS:     "Day pass",
  STAFF_PASS:   "Staff pass",
  DIRECTORY:    "Directory entry",
};

const SOURCE_GROUPS = [
  { group: "Overview", options: [
    { id: "ALL",         label: "All collections"      },
    { id: "STUDENT_ALL", label: "All student records"  },
    { id: "STAFF_ALL",   label: "All staff records"    },
  ]},
  { group: "Student collections", options: [
    { id: "studentPass",          label: "studentPass · gate passes"  },
    { id: "studentRequest",       label: "studentRequest · pending"   },
    { id: "daypass",              label: "daypass · approved"         },
    { id: "rejectedStudentPass",  label: "rejectedStudentPass"        },
    { id: "cancelledStudentPass", label: "cancelledStudentPass"       },
    { id: "students",             label: "students · directory"       },
  ]},
  { group: "Staff collections", options: [
    { id: "staffrequests", label: "staffrequests · pending" },
    { id: "staffpass",     label: "staffpass · passes"      },
    { id: "staffrejected", label: "staffrejected"           },
    { id: "staff",         label: "staff · directory"       },
  ]},
];

const SORT_OPTIONS = [
  { id: "newest",       label: "Newest activity"              },
  { id: "oldest",       label: "Oldest activity"              },
  { id: "name-asc",     label: "Name A → Z"                   },
  { id: "name-desc",    label: "Name Z → A"                   },
  { id: "group-asc",    label: "Class / Dept A → Z"           },
  { id: "group-desc",   label: "Class / Dept Z → A"           },
  { id: "status",       label: "Status (grouped)"             },
  { id: "return-asc",   label: "Expected return — soonest"    },
  { id: "return-desc",  label: "Expected return — latest"     },
  { id: "issued-desc",  label: "Recently issued"              },
];

const DATE_MODES = [
  { id: "ALL",       label: "All time"        },
  { id: "TODAY",     label: "Today"           },
  { id: "YESTERDAY", label: "Yesterday"       },
  { id: "WEEK",      label: "Last 7 days"     },
  { id: "MONTH",     label: "Last 30 days"    },
  { id: "CUSTOM",    label: "Custom range…"   },
];

const DATE_FIELDS = [
  { id: "activity", label: "Last activity" },
  { id: "raised",   label: "Date raised"   },
  { id: "issued",   label: "Date issued"   },
  { id: "returned", label: "Date returned" },
];
const DATE_FIELD_LABELS = { activity: "last activity", raised: "date raised", issued: "date issued", returned: "date returned" };

/* ---------------- smart-search support ---------------- */
const FIELD_TOKENS  = new Set(["name","class","dept","department","id","rfid","reason","slip","status","type","kind","who","going","source","scope"]);
const STATUS_ALIASES = {
  pending: "REQUESTED", requested: "REQUESTED", waiting: "REQUESTED",
  approved: "APPROVED",
  issued: "ISSUED", out: "ISSUED", printed: "ISSUED",
  returned: "RETURNED", back: "RETURNED", in: "RETURNED",
  rejected: "REJECTED",
  cancelled: "CANCELLED", canceled: "CANCELLED",
  listed: "LISTED", directory: "LISTED",
};
const TYPE_ALIASES  = { student: "STUDENT_PASS", day: "DAY_PASS", staff: "STAFF_PASS", directory: "DIRECTORY", dir: "DIRECTORY" };
const SCOPE_ALIASES = { student: "STUDENT", staff: "STAFF" };

/* ---------------- small helpers ---------------- */
const normalizeRfid = (v) => String(v || "").trim().toUpperCase().replace(/[\s:\-]/g, "");
const compact       = (s)  => String(s || "").toLowerCase().replace(/[\s\-_]+/g, "");
const getInitials   = (name) =>
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

function fmtDateTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return "—";
  return `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`;
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
function fmtFullLocal(v) {
  const d = parseLocal(v);
  if (!d) return "—";
  return /T\d{2}:\d{2}/.test(String(v))
    ? d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
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
function fmtDuration(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} m`;
  if (m > 0) return `${m} min`;
  return "less than a minute";
}
function fmtGoingWith(r) {
  if (!r.goingWith) return "—";
  return r.goingWithName ? `${r.goingWith} · ${r.goingWithName}` : r.goingWith;
}
const trunc = (s, n) => { const v = String(s ?? ""); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
const esc   = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug  = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* ---------------- source helpers ---------------- */
function sourceLabel(id) {
  switch (id) {
    case "ALL":         return "All collections";
    case "STUDENT_ALL": return "All student records";
    case "STAFF_ALL":   return "All staff records";
    default:            return (COLLECTIONS[id] || {}).label || id;
  }
}
function inSource(r, id) {
  if (id === "ALL")         return true;
  if (id === "STUDENT_ALL") return r.scope === "STUDENT";
  if (id === "STAFF_ALL")   return r.scope === "STAFF";
  return r.source === id;
}
function sourceScopeOf(id) {
  if (id === "ALL")         return "ALL";
  if (id === "STUDENT_ALL") return "STUDENT";
  if (id === "STAFF_ALL")   return "STAFF";
  return (COLLECTIONS[id] || {}).scope || "ALL";
}

/* ---------------- record normalization ---------------- */
function normalizeRecord(raw, key, sourceId) {
  const cfg = COLLECTIONS[sourceId];
  const p = raw && typeof raw === "object" ? raw : {};
  const kindRaw   = String(p.kind   || "").toUpperCase();
  const statusRaw = String(p.status || "").toUpperCase();
  const kind   = KIND_META[kindRaw]   ? kindRaw   : cfg.defKind;
  const status = STATUS_META[statusRaw] ? statusRaw : cfg.defStatus;

  const className  = String(p.className  || p.class || "").trim();
  const department = String(p.department || p.dept  || "").trim();
  const scope = cfg.scope;

  return {
    ...p,
    _id: String(p._id || key),
    source: sourceId, scope, kind, status,
    name: String(p.name || p.fullName || p.staffName || p.studentName || "Unknown").trim(),
    studentId: String(p.studentId || p.studentID || "").trim(),
    staffId:   String(p.staffId   || p.staffID   || p.employeeId || "").trim(),
    idNo: String(p.studentId || p.studentID || p.staffId || p.staffID || p.employeeId || "").trim() || "—",
    className, department,
    group: scope === "STAFF" ? (department || className || "—") : (className || department || "—"),
    rfid: normalizeRfid(p.rfid),
    reason: String(p.reason || ""),
    expectedReturn: p.expectedReturn || null,
    outAt: p.outAt || null,
    slipNo: p.slipNo ? String(p.slipNo) : null,
    goingWith: p.goingWith ? String(p.goingWith) : "",
    goingWithName: p.goingWithName ? String(p.goingWithName) : "",
    authorizedBy:  p.authorizedBy  ? String(p.authorizedBy)  : "",
    approvedBy:    p.approvedBy    ? String(p.approvedBy)    : "",
    rejectedBy:    p.rejectedBy    ? String(p.rejectedBy)    : "",
    issuedBy:      p.issuedBy      ? String(p.issuedBy)      : "",
    rejectionReason: p.rejectionReason ? String(p.rejectionReason) : "",
    createdAt: p.createdAt || null, updatedAt: p.updatedAt || null, editedAt: p.editedAt || null,
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

/* ---------------- time logic ---------------- */
function activityTime(r) {
  return TIME_FIELDS.reduce((max, f) => Math.max(max, tsMs(r[f])), 0);
}
function statusTimeValue(r) {
  switch (r.status) {
    case "RETURNED":  return r.returnedAt  || r.printedAt  || r.issuedAt || r.createdAt || null;
    case "REJECTED":  return r.rejectedAt  || r.requestedAt || r.createdAt || null;
    case "CANCELLED": return r.cancelledAt || r.requestedAt || r.createdAt || null;
    case "ISSUED":    return r.printedAt   || r.issuedAt    || r.createdAt || null;
    case "APPROVED":  return r.approvedAt  || r.createdAt   || null;
    case "LISTED":    return r.updatedAt   || r.createdAt   || null;
    default:          return r.requestedAt || r.createdAt   || null;   /* REQUESTED */
  }
}
function dateBasisMs(r, field) {
  switch (field) {
    case "raised":   return tsMs(r.requestedAt || r.createdAt);
    case "issued":   return tsMs(r.printedAt || r.issuedAt);
    case "returned": return tsMs(r.returnedAt);
    default:         return activityTime(r);
  }
}
function dateRange(mode, from, to) {
  if (mode === "ALL") return null;
  const t0 = startOfToday().getTime();
  if (mode === "TODAY")     return { from: t0,              to: t0 + DAY_MS - 1   };
  if (mode === "YESTERDAY") return { from: t0 - DAY_MS,     to: t0 - 1            };
  if (mode === "WEEK")      return { from: t0 - 6 * DAY_MS, to: Infinity          };
  if (mode === "MONTH")     return { from: t0 - 29 * DAY_MS,to: Infinity          };
  if (mode === "CUSTOM") {
    let f = from ? parseLocal(from) : null;
    let t = to   ? parseLocal(to)   : null;
    if (f && t && f.getTime() > t.getTime()) [f, t] = [t, f];
    return { from: f ? f.getTime() : 0, to: t ? t.getTime() + DAY_MS - 1 : Infinity };
  }
  return null;
}
function dateRangeLabel(mode, from, to) {
  switch (mode) {
    case "TODAY":     return "Today";
    case "YESTERDAY": return "Yesterday";
    case "WEEK":      return "Last 7 days";
    case "MONTH":     return "Last 30 days";
    case "CUSTOM":    return (from || to) ? `${from || "start"} → ${to || "today"}` : "Custom range";
    default:          return "All time";
  }
}

/* ---------------- smart search ---------------- */
function parseQuery(q) {
  return String(q || "").trim().toLowerCase()
    .split(/\s+/).filter(Boolean)
    .map((tok) => {
      const m = tok.match(/^([a-z]+):(.*)$/);
      if (m && FIELD_TOKENS.has(m[1])) return { field: m[1] === "kind" || m[1] === "department" ? (m[1] === "kind" ? "type" : "dept") : m[1], value: m[2] };
      return { field: null, value: tok };
    });
}
function resolveAlias(v, map) {
  if (!v) return null;
  const keys = Object.keys(map);
  const exact = keys.find((k) => k === v);
  if (exact) return map[exact];
  const hits = keys.filter((k) => k.startsWith(v));
  return hits.length === 1 ? map[hits[0]] : null;
}
function fieldTarget(r, field) {
  switch (field) {
    case "name":   return r.name;
    case "class":  return r.className || r.department;
    case "dept":   return r.department || r.className;
    case "id":     return `${r.idNo} ${r.studentId} ${r.staffId}`;
    case "rfid":   return r.rfid;
    case "reason": return r.reason;
    case "slip":   return r.slipNo || "";
    case "who":    return [r.authorizedBy, r.approvedBy, r.rejectedBy, r.issuedBy].filter(Boolean).join(" ");
    case "going":  return fmtGoingWith(r);
    case "source": return `${r.source} ${(COLLECTIONS[r.source] || {}).label || ""}`;
    case "scope":  return r.scope;
    default:       return "";
  }
}
function searchHaystack(r) {
  const bits = [
    r.name, r.idNo, r.studentId, r.staffId, r.className, r.department, r.group, r.rfid, r.reason, r.slipNo,
    (STATUS_META[r.status] || {}).label, r.status,
    (KIND_META[r.kind] || {}), r.kind,
    r.scope === "STAFF" ? "staff" : "student",
    r.authorizedBy, r.approvedBy, r.rejectedBy, r.issuedBy, fmtGoingWith(r),
    (COLLECTIONS[r.source] || {}).label, r.source,
    compact(r.className), compact(r.idNo), compact(r.slipNo), compact(r.department),
  ];
  if (r.status === "ISSUED")    bits.push("out", "printed");
  if (r.status === "RETURNED")  bits.push("back", "in", "returned");
  if (r.status === "REQUESTED") bits.push("pending", "waiting");
  const t = activityTime(r) ? new Date(activityTime(r)) : null;
  if (t && !isNaN(t)) {
    bits.push(t.toLocaleDateString(), t.toLocaleDateString([], { day: "2-digit", month: "short" }),
              t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }
  return bits.filter(Boolean).join(" ").toLowerCase();
}
function tokenMatches(r, tok) {
  if (tok.field && !tok.value) return true;
  if (tok.field === "status") { const s = resolveAlias(tok.value, STATUS_ALIASES); return !!s && r.status === s; }
  if (tok.field === "type")   { const k = resolveAlias(tok.value, TYPE_ALIASES);   return !!k && r.kind === k;   }
  if (tok.field === "scope")  { const s = resolveAlias(tok.value, SCOPE_ALIASES);  return !!s && r.scope === s;  }
  if (tok.field) {
    const target = String(fieldTarget(r, tok.field) || "").toLowerCase();
    const cv = compact(tok.value);
    return target.includes(tok.value) || (cv !== "" && compact(target).includes(cv));
  }
  return searchHaystack(r).includes(tok.value);
}
const matchesQuery = (r, tokens) => tokens.every((t) => tokenMatches(r, t));

/* ---------------- sorters ---------------- */
const retMs = (r) => { const d = parseLocal(r.expectedReturn); return d ? d.getTime() : Infinity; };
const SORTERS = {
  newest:        (a, b) => activityTime(b) - activityTime(a),
  oldest:        (a, b) => activityTime(a) - activityTime(b),
  "name-asc":    (a, b) => a.name.localeCompare(b.name) || activityTime(b) - activityTime(a),
  "name-desc":   (a, b) => b.name.localeCompare(a.name) || activityTime(b) - activityTime(a),
  "group-asc":   (a, b) => (a.group || "").localeCompare(b.group || "") || a.name.localeCompare(b.name),
  "group-desc":  (a, b) => (b.group || "").localeCompare(a.group || "") || a.name.localeCompare(b.name),
  status:        (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || activityTime(b) - activityTime(a),
  "return-asc":  (a, b) => retMs(a) - retMs(b),
  "return-desc": (a, b) => retMs(b) - retMs(a),
  "issued-desc": (a, b) => tsMs(b.printedAt || b.issuedAt) - tsMs(a.printedAt || a.issuedAt),
};

/* ---------------- timeline ---------------- */
function timelineOf(r) {
  const items = [];
  const push = (icon, label, iso, note) => {
    if (!iso) return;
    const t = new Date(iso);
    if (isNaN(t)) return;
    items.push({ icon, label, note: note || null, at: t });
  };
  if (r.kind === "DIRECTORY") {
    push("📇", "Directory record created", r.createdAt);
    push("✏️", "Last updated", r.updatedAt || r.editedAt);
  } else {
    push("📝", r.kind === "STUDENT_PASS" ? "Pass created at the gate desk" : "Request raised", r.requestedAt || r.createdAt);
    push("✓",  r.approvedBy ? `Approved by ${r.approvedBy}` : "Approved", r.approvedAt);
    push("🎫", "Issued & slip printed", r.printedAt || r.issuedAt,
      [r.slipNo ? `slip ${r.slipNo}` : null, r.issuedBy ? `by ${r.issuedBy}` : null].filter(Boolean).join(" · ") || null);
    push("↩",  "Returned — marked IN", r.returnedAt);
    push("⛔", r.rejectedBy ? `Rejected by ${r.rejectedBy}` : "Rejected", r.rejectedAt, r.rejectionReason || null);
    push("⊘",  "Cancelled — withdrawn", r.cancelledAt);
  }
  items.sort((a, b) => a.at - b.at);
  return items;
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

/* ---------- print ONE record — A4 portrait detail sheet ---------- */
function printOne(r) {
  const meta = STATUS_META[r.status] || { label: r.status, icon: "" };
  const row = (k, v) => (v === null || v === undefined || String(v).trim() === "" || v === "—") ? ""
    : `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;

  const rows = [
    row("Scope", r.scope === "STAFF" ? "Staff" : "Student"),
    row("Record type", KIND_META[r.kind] || r.kind),
    row("Status", `${meta.label}${isOverdue(r) ? " — OVERDUE" : ""}`),
    row("Name", r.name),
    row(r.scope === "STAFF" ? "Department" : "Class", r.group !== "—" ? r.group : null),
    row("ID number", r.idNo !== "—" ? r.idNo : null),
    row("RFID", r.rfid || null),
    row("Reason", r.reason || null),
    row("Going with", fmtGoingWith(r)),
    row("Expected return", fmtExpected(r.expectedReturn)),
    row("Out at", r.outAt ? fmtFullLocal(r.outAt) : null),
    row("Raised / created", fmtStamp(r.requestedAt || r.createdAt)),
    row("Authorized by", r.authorizedBy || null),
    row("Approved by", r.approvedBy || null),
    row("Approved at", fmtStamp(r.approvedAt)),
    row("Slip number", r.slipNo || null),
    row("Issued at", fmtStamp(r.printedAt || r.issuedAt)),
    row("Issued by", r.issuedBy || null),
    row("Returned at", fmtStamp(r.returnedAt)),
    row("Rejected by", r.rejectedBy || null),
    row("Rejected at", fmtStamp(r.rejectedAt)),
    row("Rejection reason", r.rejectionReason || null),
    row("Cancelled at", fmtStamp(r.cancelledAt)),
    row("Source collection", `${r.source}${COLLECTIONS[r.source] ? ` — ${COLLECTIONS[r.source].label}` : ""}`),
    row("Record ID", r._id),
  ].join("");

  const tl = timelineOf(r).map((t) =>
    `<li><span class="ti">${t.icon}</span><span class="tl"><strong>${esc(t.label)}</strong>${t.note ? `<em> — ${esc(t.note)}</em>` : ""}</span><span class="ta">${esc(t.at.toLocaleString())}</span></li>`
  ).join("");

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Record — ${esc(r.name)}</title><style>` +
    `@page{size:A4;margin:14mm}html,body{margin:0;padding:0}` +
    `body{font-family:"Segoe UI",Arial,sans-serif;color:#141710}` +
    `.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2.5px solid #6f9a00;padding-bottom:8px;margin-bottom:12px}` +
    `h1{font-size:17px;margin:0;color:#2e3520}` +
    `.stamp{font-size:11px;color:#444;text-align:right;line-height:1.5}` +
    `table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px}` +
    `th{width:44mm;text-align:left;background:#f0f3e2;border:1px solid #d7dce0;padding:6px 8px;font-weight:600}` +
    `td{border:1px solid #d7dce0;padding:6px 8px;word-break:break-word}` +
    `tr:nth-child(even) td{background:#fafbf4}` +
    `h2{font-size:12px;margin:0 0 8px;color:#2e3520;text-transform:uppercase;letter-spacing:.6px}` +
    `ul{list-style:none;margin:0;padding:0}` +
    `li{display:flex;gap:10px;padding:6px 0;border-bottom:1px dashed #d7dce0;font-size:11.5px;align-items:baseline}` +
    `.ti{width:22px;flex-shrink:0}.tl{flex:1}.ta{color:#666;font-size:10.5px;white-space:nowrap}em{color:#666;font-style:italic}` +
    `.foot{margin-top:12px;font-size:10px;color:#666;text-align:center}` +
    `</style></head><body>` +
    `<div class="head"><h1>PASSPORT · RECORD DETAIL SHEET</h1><span class="stamp">Printed ${esc(new Date().toLocaleString())}</span></div>` +
    `<table>${rows}</table>` +
    (tl ? `<h2>Timeline</h2><ul>${tl}</ul>` : "") +
    `<div class="foot">— DPIRS PassPort · record detail report —</div>` +
    `</body></html>`;

  printHtml(html);
}

/* ---------- tiny presentational helpers ---------- */
function Field({ label, value, mono, dim, tone, note, wide, children }) {
  return (
    <div className={`rp-field${wide ? " rp-field-wide" : ""}${tone === "bad" ? " rp-field-bad" : ""}`}>
      <span className="rp-field-label">{label}</span>
      <span className={`rp-field-value${mono ? " rp-mono" : ""}${dim ? " rp-field-dim" : ""}`}>{children || value || "—"}</span>
      {note && <span className="rp-field-note">“{note}”</span>}
    </div>
  );
}
const typeCls = (kind) => kind === "STUDENT_PASS" ? "student" : kind === "DAY_PASS" ? "day" : kind === "STAFF_PASS" ? "staff" : "dir";

/* ===================================================================== */

export default function Reports() {
  /* ================= LIVE DATA ================= */
  const [data, setData]           = useState({});   // { [sourceId]: records[] }
  const [ready, setReady]         = useState({});   // { [sourceId]: true }
  const [syncError, setSyncError] = useState("");

  /* ================= UI STATE ================= */
  const [clock, setClock]           = useState(() => new Date());
  const [search, setSearch]         = useState("");
  const [sourceId, setSourceId]     = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [groupFilter, setGroupFilter]   = useState("ALL");
  const [dateMode, setDateMode]     = useState("ALL");
  const [dateField, setDateField]   = useState("activity");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo]     = useState("");
  const [sortBy, setSortBy]         = useState("newest");
  const [limit, setLimit]           = useState(PAGE_SIZE);
  const [detailId, setDetailId]     = useState(null);
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

  /* ================= MERGED DATASET (de-duplicated by _id) ================= */
  const allRecords = useMemo(() => {
    const byId = new Map();
    Object.values(data).flat().forEach((r) => {
      const prev = byId.get(r._id);
      if (!prev || activityTime(r) > activityTime(prev)) byId.set(r._id, r);
    });
    return [...byId.values()];
  }, [data]);

  const sourceCounts = useMemo(() => {
    const c = { ALL: allRecords.length, STUDENT_ALL: 0, STAFF_ALL: 0 };
    Object.keys(COLLECTIONS).forEach((k) => (c[k] = 0));
    allRecords.forEach((r) => {
      if (c[r.source] != null) c[r.source]++;
      if (r.scope === "STUDENT") c.STUDENT_ALL++;
      else if (r.scope === "STAFF") c.STAFF_ALL++;
    });
    return c;
  }, [allRecords]);

  /* the currently-selected dataset (source/scope only) */
  const dataset = useMemo(() => allRecords.filter((r) => inSource(r, sourceId)), [allRecords, sourceId]);

  const scopeActive       = sourceScopeOf(sourceId);
  const groupHeadLabel    = scopeActive === "STAFF" ? "Department" : scopeActive === "STUDENT" ? "Class" : "Class / Dept";
  const groupSelectLabel  = scopeActive === "STAFF" ? "All departments" : scopeActive === "STUDENT" ? "All classes" : "All classes & departments";

  /* ================= STATS (on the dataset) ================= */
  const stats = useMemo(() => {
    const t0 = startOfToday().getTime();
    let today = 0, out = 0, pending = 0, returned = 0, rejected = 0, cancelled = 0;
    dataset.forEach((r) => {
      if (activityTime(r) >= t0) today++;
      if (r.status === "ISSUED") out++;
      else if (r.status === "REQUESTED") pending++;
      else if (r.status === "RETURNED") returned++;
      else if (r.status === "REJECTED") rejected++;
      else if (r.status === "CANCELLED") cancelled++;
    });
    return { total: dataset.length, today, out, pending, returned, rejected, cancelled };
  }, [dataset]);

  const statusCounts = useMemo(() => {
    const c = { ALL: dataset.length };
    STATUS_ORDER.forEach((s) => (c[s] = 0));
    dataset.forEach((r) => { if (c[r.status] != null) c[r.status]++; });
    return c;
  }, [dataset]);

  const groups = useMemo(() => {
    const set = new Set();
    dataset.forEach((r) => { const g = r.group; if (g && g !== "—") set.add(g); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [dataset]);

  /* ================= FILTER → SEARCH → SORT ================= */
  const searchTokens = useMemo(() => parseQuery(search), [search]);

  const filtered = useMemo(() => {
    let list = dataset;
    if (statusFilter !== "ALL") list = list.filter((r) => r.status === statusFilter);
    if (groupFilter  !== "ALL") list = list.filter((r) => r.group   === groupFilter);

    const range = dateRange(dateMode, customFrom, customTo);
    if (range) list = list.filter((r) => { const t = dateBasisMs(r, dateField); return t >= range.from && t <= range.to; });

    if (searchTokens.length) list = list.filter((r) => matchesQuery(r, searchTokens));

    return [...list].sort(SORTERS[sortBy] || SORTERS.newest);
  }, [dataset, statusFilter, groupFilter, dateMode, dateField, customFrom, customTo, searchTokens, sortBy]);

  const shown = useMemo(() => filtered.slice(0, limit), [filtered, limit]);

  useEffect(() => { setLimit(PAGE_SIZE); }, [search, sourceId, statusFilter, groupFilter, dateMode, dateField, customFrom, customTo, sortBy]);
  useEffect(() => { setGroupFilter("ALL"); }, [sourceId]);

  /* ================= FILTER HELPERS ================= */
  const filtersClean = statusFilter === "ALL" && groupFilter === "ALL" && dateMode === "ALL" && !search.trim();
  const filtersActive = !filtersClean;

  const resetAll = useCallback(() => {
    setSearch(""); setStatusFilter("ALL"); setGroupFilter("ALL");
    setDateMode("ALL"); setCustomFrom(""); setCustomTo("");
  }, []);

  const solo = (patch) => {
    resetAll();
    if (patch.status) setStatusFilter(patch.status);
    if (patch.date)   setDateMode(patch.date);
  };
  const isSolo = (patch) => {
    const cur  = { status: statusFilter, date: dateMode, group: groupFilter, q: search.trim() };
    const want = { status: "ALL", date: "ALL", group: "ALL", q: "", ...patch };
    return cur.status === want.status && cur.date === want.date && cur.group === want.group && cur.q === want.q;
  };

  const statCards = [
    { key: "total",     icon: "🗂️", label: "Total records",  value: stats.total,    tone: "lime",  active: filtersClean,                    apply: resetAll },
    { key: "today",     icon: "📅", label: "Today",          value: stats.today,    tone: "blue",   active: isSolo({ date: "TODAY" }),       apply: () => solo({ date: "TODAY" }) },
    { key: "out",       icon: "🚶", label: "Out on pass",    value: stats.out,      tone: "green",  active: isSolo({ status: "ISSUED" }),    apply: () => solo({ status: "ISSUED" }) },
    { key: "pending",   icon: "⏳", label: "Pending",        value: stats.pending,  tone: "amber",  active: isSolo({ status: "REQUESTED" }), apply: () => solo({ status: "REQUESTED" }) },
    { key: "returned",  icon: "↩",  label: "Returned",       value: stats.returned, tone: "slate",  active: isSolo({ status: "RETURNED" }),  apply: () => solo({ status: "RETURNED" }) },
    
  ];

  /* ================= DETAIL MODAL (live) ================= */
  const closeDetail = useCallback(() => setDetailId(null), []);
  const live = useMemo(() => (detailId ? allRecords.find((r) => r._id === detailId) || null : null), [detailId, allRecords]);

  useEffect(() => {
    if (!live) return;
    const onKey = (e) => { if (e.key === "Escape") closeDetail(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [live, closeDetail]);

  const dur = useMemo(() => {
    if (!live) return {};
    const out = parseLocal(live.outAt);
    const ret = parseLocal(live.expectedReturn);
    const planned = out && ret ? ret - out : null;
    let actual = null;
    if (live.issuedAt) {
      const end = live.returnedAt ? new Date(live.returnedAt) : clock;
      const a = end - new Date(live.issuedAt);
      if (!isNaN(a) && a >= 0) actual = a;
    }
    let overdueMs = null;
    if (live.status === "ISSUED" && ret) { const over = clock - ret.getTime(); if (over > 0) overdueMs = over; }
    return { planned, actual, overdueMs };
  }, [live, clock]);

  /* ================= EXPORT — EXCEL (.xls) ================= */
  const exportExcel = () => {
    if (!filtered.length) { showToast("Nothing to export — the current report shows no records.", "error"); return; }

    const headers = ["#","Name","Scope","Type","Status","Class / Dept","ID No","RFID","Slip No","Reason","Going With","Expected Return",
      "Raised","Approved","Issued / Printed","Returned","Rejected","Cancelled","Authorized By","Approved By","Issued By","Rejected By",
      "Rejection Reason","Source Collection","Record ID"];

    const rowsHtml = filtered.map((r, i) => {
      const cells = [
        i + 1, r.name, r.scope === "STAFF" ? "Staff" : "Student",
        KIND_META[r.kind] || r.kind, (STATUS_META[r.status] || {}).label || r.status,
        r.group, r.idNo, r.rfid || "—", r.slipNo || "—", r.reason || "—",
        fmtGoingWith(r), fmtExpected(r.expectedReturn),
        fmtStamp(r.requestedAt || r.createdAt), fmtStamp(r.approvedAt), fmtStamp(r.printedAt || r.issuedAt),
        fmtStamp(r.returnedAt), fmtStamp(r.rejectedAt), fmtStamp(r.cancelledAt),
        r.authorizedBy || "—", r.approvedBy || "—", r.issuedBy || "—", r.rejectedBy || "—",
        r.rejectionReason || "—", (COLLECTIONS[r.source] || {}).label || r.source, r._id,
      ];
      return "<tr>" + cells.map((c) => `<td>${esc(c)}</td>`).join("") + "</tr>";
    }).join("");

    const N = headers.length;
    const title = `DPIRS PassPort — ${sourceLabel(sourceId)} report`;
    const metaLine = `Generated ${new Date().toLocaleString()}  ·  ${filtered.length} record${filtered.length === 1 ? "" : "s"}  ·  Status: ${statusFilter === "ALL" ? "All" : STATUS_META[statusFilter].label}  ·  Date: ${dateRangeLabel(dateMode, customFrom, customTo)} (by ${DATE_FIELD_LABELS[dateField]})${groupFilter !== "ALL" ? `  ·  ${groupHeadLabel}: ${groupFilter}` : ""}${search.trim() ? `  ·  Search: "${search.trim()}"` : ""}  ·  Sorted: ${(SORT_OPTIONS.find((o) => o.id === sortBy) || {}).label || sortBy}`;
    const statLine = `Total ${stats.total}  ·  Today ${stats.today}  ·  Out now ${stats.out}  ·  Pending ${stats.pending}  ·  Returned ${stats.returned}  ·  Rejected ${stats.rejected}  ·  Cancelled ${stats.cancelled}`;

    const html =
      `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
      `<head><meta charset="UTF-8" />` +
      `<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Report</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->` +
      `<style>td,th{mso-number-format:"\\@";border:1px solid #c9cfb6;padding:5px 8px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;vertical-align:top;text-align:left}` +
      `th{background:#2e3520;color:#fffeef;font-weight:700}` +
      `.t{background:#2e3520;color:#fffeef;font-size:14px;font-weight:800;text-align:center}` +
      `.m{color:#4a5138;font-size:10px;text-align:center}` +
      `</style></head><body><table>` +
      `<tr><td class="t" colspan="${N}">${esc(title)}</td></tr>` +
      `<tr><td class="m" colspan="${N}">${esc(metaLine)}</td></tr>` +
      `<tr><td class="m" colspan="${N}">${esc(statLine)}</td></tr>` +
      `<tr><td colspan="${N}"></td></tr>` +
      `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>` +
      rowsHtml +
      `</table></body></html>`;

    const blob = new Blob(["\uFEFF" + html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-${slug(sourceLabel(sourceId))}-${todayStr()}.xls`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(`✓ Exported ${filtered.length} record${filtered.length === 1 ? "" : "s"} to Excel (current report)`);
  };

  /* ================= PRINT — full report (A4 landscape) ================= */
  const printFullReport = () => {
    if (!filtered.length) { showToast("No records to print — the current report is empty.", "error"); return; }

    const bodyRows = filtered.map((r, i) => {
      const meta = STATUS_META[r.status] || {};
      return `<tr>` +
        `<td class="n">${i + 1}</td>` +
        `<td class="nm">${esc(r.name)}</td>` +
        `<td>${esc(KIND_META[r.kind] || r.kind)}</td>` +
        `<td class="st-${r.status.toLowerCase()}">${esc(`${meta.icon || ""} ${meta.label || r.status}`)}${isOverdue(r) ? " · OVERDUE" : ""}</td>` +
        `<td>${esc(r.group)}</td>` +
        `<td class="m">${esc(r.idNo)}</td>` +
        `<td class="m">${esc(r.slipNo || "—")}</td>` +
        `<td class="rs">${esc(trunc(r.reason || "—", 60))}</td>` +
        `<td>${esc(fmtExpected(r.expectedReturn))}</td>` +
        `<td>${esc(fmtStamp(statusTimeValue(r)))}</td>` +
        `</tr>`;
    }).join("");

    const statBoxes = [
      ["Total records", stats.total], ["Today", stats.today], ["Out now", stats.out], ["Pending", stats.pending],
      ["Returned", stats.returned], ["Rejected", stats.rejected], ["Cancelled", stats.cancelled],
    ].map(([k, v]) => `<div class="bx"><span class="bx-n">${v}</span><span class="bx-l">${esc(k)}</span></div>`).join("");

    const metaBits = [
      `Source: ${sourceLabel(sourceId)}`,
      `Status: ${statusFilter === "ALL" ? "All" : STATUS_META[statusFilter].label}`,
      `Date: ${dateRangeLabel(dateMode, customFrom, customTo)} (by ${DATE_FIELD_LABELS[dateField]})`,
      ...(groupFilter !== "ALL" ? [`${groupHeadLabel}: ${groupFilter}`] : []),
      ...(search.trim() ? [`Search: "${search.trim()}"`] : []),
      `Sort: ${(SORT_OPTIONS.find((o) => o.id === sortBy) || {}).label || sortBy}`,
    ];

    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(sourceLabel(sourceId))} — Report</title><style>` +
      `@page{size:A4 landscape;margin:10mm}html,body{margin:0;padding:0}` +
      `body{font-family:"Segoe UI",Arial,sans-serif;color:#141710}` +
      `.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2.5px solid #6f9a00;padding-bottom:8px;margin-bottom:10px}` +
      `h1{font-size:18px;margin:0;color:#2e3520}` +
      `.stamp{font-size:10px;color:#555;text-align:right;line-height:1.5}` +
      `.meta{font-size:10.5px;color:#333;background:#f2f5e6;border:1px solid #dfe4c8;border-radius:6px;padding:7px 10px;margin-bottom:10px}` +
      `.statrow{display:flex;gap:6px;margin-bottom:12px}` +
      `.bx{flex:1;border:1px solid #dfe4c8;border-radius:6px;padding:6px 8px;text-align:center;background:#fafbf4}` +
      `.bx-n{display:block;font-size:16px;font-weight:800;color:#4c6b00}` +
      `.bx-l{display:block;font-size:8.5px;text-transform:uppercase;letter-spacing:.5px;color:#7a8164}` +
      `table{width:100%;border-collapse:collapse;font-size:9.5px}` +
      `th{background:#2e3520;color:#fffeef;padding:6px 7px;text-align:left;font-size:8.5px;text-transform:uppercase;letter-spacing:.5px}` +
      `td{border:1px solid #dfe4c8;padding:5px 7px;vertical-align:top}` +
      `tr:nth-child(even) td{background:#f7f9ee}` +
      `.n{text-align:right;color:#888;width:16px}.m{font-family:Consolas,monospace;font-size:9px}` +
      `.nm{font-weight:700}.rs{max-width:150px}` +
      `.issued{color:#0c7a43;font-weight:700}.approved{color:#1d5fbf;font-weight:700}.requested{color:#a06800;font-weight:700}` +
      `.returned,.listed{color:#4b5563;font-weight:700}.rejected{color:#c02626;font-weight:700}.cancelled{color:#6b7280;font-weight:700}` +
      `.foot{margin-top:10px;font-size:9px;color:#777;text-align:center}` +
      `</style></head><body>` +
      `<div class="head"><div><h1>DPIRS PassPort — ${esc(sourceLabel(sourceId))}</h1></div>` +
      `<div class="stamp">Generated ${esc(new Date().toLocaleString())}<br/>${filtered.length} record${filtered.length === 1 ? "" : "s"} · Reports console</div></div>` +
      `<div class="meta"><strong>Report filters —</strong> ${metaBits.map(esc).join(" &nbsp;·&nbsp; ")}</div>` +
      `<div class="statrow">${statBoxes}</div>` +
      `<table><thead><tr><th class="n">#</th><th>Name</th><th>Type</th><th>Status</th><th>Class / Dept</th><th>ID No</th><th>Slip No</th><th>Reason</th><th>Expected Return</th><th>Last Activity</th></tr></thead>` +
      `<tbody>${bodyRows}</tbody></table>` +
      `<div class="foot">— DPIRS PassPort · report generated from the Reports console —</div>` +
      `</body></html>`;

    printHtml(html);
    showToast(`🖨 Printing the report — ${filtered.length} record${filtered.length === 1 ? "" : "s"}, summary + full table…`);
  };

  /* ================= MODAL RENDER (portal → document.body) ================= */
  const renderModal = () => {
    if (!live) return null;
    const meta = STATUS_META[live.status] || STATUS_META.REQUESTED;
    const tl = timelineOf(live);
    return createPortal(
      <div className="rp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDetail(); }}>
        <div className="rp-modal" role="dialog" aria-modal="true" aria-label={`Record — ${live.name}`}>
          <button type="button" className="rp-modal-x" onClick={closeDetail} aria-label="Close details" autoFocus>✕</button>

          <div className="rp-modal-head">
            <span className="rp-avatar rp-avatar-lg" style={{ background: avatarGradient(live.name) }}>{getInitials(live.name)}</span>
            <div className="rp-modal-id">
              <h3>{live.name}</h3>
              <div className="rp-modal-chips">
                <span className="rp-chip">{live.group}</span>
                <span className="rp-chip rp-chip-mono">{live.idNo}</span>
                {live.rfid && <span className="rp-chip rp-chip-mono rp-chip-soft">RFID {live.rfid}</span>}
                {live.slipNo && <span className="rp-chip rp-chip-mono rp-chip-soft">{live.slipNo}</span>}
              </div>
              <div className="rp-modal-badges">
                <span className={`rp-type rp-type-${typeCls(live.kind)}`}>{KIND_META[live.kind] || live.kind}</span>
                <span className={`rp-badge rp-badge-${meta.tone}`}>{meta.icon} {meta.label}</span>
                {isOverdue(live) && <span className="rp-tag rp-tag-overdue">Overdue</span>}
              </div>
            </div>
          </div>

          <div className="rp-modal-body">
            <div className="rp-grid">
              <Field wide label="Reason" value={live.reason || "No reason recorded"} />
              <Field label="Expected return">
                {fmtExpected(live.expectedReturn)}
                {isTodayDate(live.expectedReturn) && <span className="rp-tag rp-tag-today">Today</span>}
                {isOverdue(live) && <span className="rp-tag rp-tag-overdue">Overdue</span>}
              </Field>
              {live.scope === "STUDENT"
                ? <Field label="Going with" value={fmtGoingWith(live)} dim={!live.goingWith} />
                : <Field label="Out at" value={fmtFullLocal(live.outAt)} dim={!live.outAt} />}
              {dur.planned   != null && <Field label="Planned duration" value={fmtDuration(dur.planned)} />}
              {dur.actual    != null && <Field label={live.status === "RETURNED" ? "Total time out" : "Out so far"} value={fmtDuration(dur.actual)} />}
              {dur.overdueMs != null && <Field label="Overdue by" value={fmtDuration(dur.overdueMs)} tone="bad" />}
              {live.authorizedBy && <Field label="Authorized by" value={live.authorizedBy} />}
              {live.approvedBy   && <Field label="Approved by" value={live.approvedBy} />}
              {live.issuedBy     && <Field label="Issued by" value={live.issuedBy} />}
              {live.rejectedBy   && <Field label="Rejected by" value={live.rejectedBy} note={live.rejectionReason} />}
              <Field label="Raised at" value={fmtStamp(live.requestedAt || live.createdAt)} />
              <Field label="Last activity" value={fmtStamp(activityTime(live) ? new Date(activityTime(live)) : null)} />
              <Field label="Source collection" value={`${live.source}${COLLECTIONS[live.source] ? ` · ${COLLECTIONS[live.source].label}` : ""}`} mono />
              <Field label="Record ID" value={live._id} mono />
            </div>

            {tl.length > 0 && (
              <>
                <h4 className="rp-timeline-title">Record timeline</h4>
                <ol className="rp-timeline">
                  {tl.map((it, idx) => (
                    <li key={idx} className={`rp-tl-item ${idx === tl.length - 1 ? "rp-tl-current" : ""}`} style={{ animationDelay: `${Math.min(idx * 70, 420)}ms` }}>
                      <span className="rp-tl-dot">{it.icon}</span>
                      <div className="rp-tl-body">
                        <span className="rp-tl-label">{it.label}</span>
                        {it.note && <span className="rp-tl-note">{it.note}</span>}
                        <span className="rp-tl-time">
                          {it.at.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} · {timeAgo(it.at)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>

          <footer className="rp-modal-foot">
            <span className="rp-modal-hint">Updates live while open · Esc to close</span>
            <div className="rp-modal-footbtns">
              <button type="button" className="rp-btn rp-btn-ghost" onClick={closeDetail}>Close</button>
              <button type="button" className="rp-btn rp-btn-primary" onClick={() => { printOne(live); showToast("🖨 Sending the record sheet to the printer…"); }}>🖨 Print record</button>
            </div>
          </footer>
        </div>
      </div>,
      document.body
    );
  };

  /* ================= SORTABLE TABLE HEADER ================= */
  const SortTh = ({ ids, children }) => {
    const on = ids.includes(sortBy);
    const arrow = on ? ((sortBy.endsWith("-desc") || sortBy === "oldest") ? "▾" : "▴") : "↕";
    return (
      <th className={`rp-th-sort ${on ? "rp-th-on" : ""}`} scope="col" title="Click to sort"
          onClick={() => setSortBy(sortBy === ids[0] ? ids[1] : ids[0])}>
        {children}<span className="rp-th-arrow">{arrow}</span>
      </th>
    );
  };

  /* ================= RENDER ================= */
  return (
    <section className="rp-page">
      {/* ---------- header ---------- */}
      <header className="rp-header">
        <div className="rp-heading">
          
        </div>
        <div className="rp-header-right">
          
          <div className="rp-actions">
            <button type="button" className="rp-btn rp-btn-light" onClick={printFullReport} disabled={loading || !filtered.length}>🖨 Print report</button>
            <button type="button" className="rp-btn rp-btn-primary" onClick={exportExcel} disabled={loading || !filtered.length}>⬇ Export Excel</button>
          </div>
        </div>
      </header>

      {/* ---------- stats (clickable quick filters) ---------- */}
      {loading ? (
        <div className="rp-stats">
          {[0, 1, 2, 3, 4,].map((i) => <div key={i} className="rp-skelstat" style={{ animationDelay: `${i * 70}ms` }} />)}
        </div>
      ) : (
        <div className="rp-stats">
          {statCards.map((s) => (
            <button type="button" key={s.key}
              className={`rp-stat rp-stat-${s.tone} ${s.active ? "rp-stat-on" : ""}`}
              onClick={s.apply}
              title={s.active ? "This quick view is active" : `Show ${s.label.toLowerCase()}`}>
              <span className="rp-stat-icon">{s.icon}</span>
              <span className="rp-stat-nums">
                <span className="rp-stat-value">{s.value}</span>
                <span className="rp-stat-label">{s.label}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ---------- controls ---------- */}
      <div className="rp-card rp-controls">
        {/* row 1 — search · sort · date basis */}
        <div className="rp-toolbar">
          <div className="rp-search">
            <span className="rp-search-icon" aria-hidden="true">🔍</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Search everything — name, ID, class, dept, reason, slip… try "status:pending" or "type:staff"'
              spellCheck={false}
              aria-label="Search records"
            />
            {search && <button type="button" className="rp-search-clear" onClick={() => setSearch("")} aria-label="Clear search">✕</button>}
          </div>

          <label className="rp-select">
            <span className="rp-select-label">Sort by</span>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort records">
              {SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>

          <label className="rp-select">
            <span className="rp-select-label">Date basis</span>
            <select value={dateField} onChange={(e) => setDateField(e.target.value)} aria-label="Which date the filter uses">
              {DATE_FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
        </div>

        {/* row 2 — scope chips · collection · class/dept · date */}
        <div className="rp-filterrow">
          <div className="rp-scope">
            <span className="rp-select-label">Scope</span>
            <div className="rp-scopechips">
              {[{ id: "ALL", label: "Everything" }, { id: "STUDENT", label: "Students" }, { id: "STAFF", label: "Staff" }].map((c) => (
                <button key={c.id} type="button"
                  className={`rp-scopechip ${scopeActive === c.id ? "rp-scopechip-on" : ""}`}
                  onClick={() => setSourceId(c.id === "ALL" ? "ALL" : c.id === "STUDENT" ? "STUDENT_ALL" : "STAFF_ALL")}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <label className={`rp-select ${sourceId !== "ALL" ? "rp-select-on" : ""}`}>
            <span className="rp-select-label">Collection</span>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Data source">
              {SOURCE_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}{sourceCounts[o.id] !== undefined ? ` (${sourceCounts[o.id]})` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className={`rp-select ${groupFilter !== "ALL" ? "rp-select-on" : ""}`}>
            <span className="rp-select-label">{groupHeadLabel}</span>
            <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} aria-label={`Filter by ${groupHeadLabel.toLowerCase()}`}>
              <option value="ALL">{groupSelectLabel}</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>

          <label className={`rp-select ${dateMode !== "ALL" ? "rp-select-on" : ""}`}>
            <span className="rp-select-label">Date range</span>
            <select value={dateMode} onChange={(e) => setDateMode(e.target.value)} aria-label="Filter by date">
              {DATE_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </div>

        {/* row 3 — status chips (single line) with live counts */}
        <div className="rp-statuschips">
          <button type="button" className={`rp-schip ${statusFilter === "ALL" ? "rp-schip-on" : ""}`} onClick={() => setStatusFilter("ALL")}>
            All statuses <span className="rp-schip-n">{statusCounts.ALL}</span>
          </button>
          {STATUS_ORDER.map((s) => (
            <button key={s} type="button" className={`rp-schip ${statusFilter === s ? "rp-schip-on" : ""}`} onClick={() => setStatusFilter(s)}>
              {STATUS_META[s].label} <span className="rp-schip-n">{statusCounts[s] ?? 0}</span>
            </button>
          ))}
          <div className="rp-filtermeta">
            <span className="rp-count">{loading ? "Loading…" : `${filtered.length} of ${dataset.length} shown`}</span>
            {filtersActive && <button type="button" className="rp-clear" onClick={resetAll}>Clear ✕</button>}
          </div>
        </div>

        {/* custom date range — appears only when "Custom range…" is chosen */}
        {dateMode === "CUSTOM" && (
          <div className="rp-custom">
            <span className="rp-custom-label">From</span>
            <input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} aria-label="From date" />
            <span className="rp-custom-arrow">→</span>
            <span className="rp-custom-label">To</span>
            <input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} aria-label="To date" />
            {(customFrom || customTo) && (
              <button type="button" className="rp-custom-clear" onClick={() => { setCustomFrom(""); setCustomTo(""); }}>clear</button>
            )}
            {!customFrom && !customTo && <span className="rp-custom-hint">pick a from / to date — the report filters live</span>}
          </div>
        )}

        {/* smart-search token hints */}
        <div className="rp-smart">
          <span className="rp-smart-label">Smart search</span>
          {["name:", "class:", "dept:", "id:", "status:pending", "type:staff", "slip:", "source:daypass"].map((t) => (
            <button key={t} type="button" className="rp-smart-chip" onClick={() => setSearch((s) => `${s.trim()} ${t}`.trim())}>{t}</button>
          ))}
          <span className="rp-smart-hint"></span>
        </div>
      </div>

      {/* ---------- report table (minimal — details on click) ---------- */}
      <div className="rp-card rp-table-card">
        <div className="rp-card-head">
          <div>
            <h3 className="rp-card-title">
                  Report data <span className="rp-count-badge">{loading ? "…" : `${filtered.length} record${filtered.length === 1 ? "" : "s"}`}</span>
            </h3>
            <div className="rp-reportmeta">
              <strong>{sourceLabel(sourceId)}</strong>
              {" · Status: "}{statusFilter === "ALL" ? "All" : STATUS_META[statusFilter].label}
              {" · Date: "}{dateRangeLabel(dateMode, customFrom, customTo)} (by {DATE_FIELD_LABELS[dateField]})
              {groupFilter !== "ALL" ? ` · ${groupHeadLabel}: ${groupFilter}` : ""}
              {search.trim() ? ` · Search: “${search.trim()}”` : ""}
              {" · Sorted: "}{(SORT_OPTIONS.find((o) => o.id === sortBy) || {}).label || sortBy}
            </div>
          </div>
          <span className="rp-rowhint">Click any row for the full record →</span>
        </div>

        <div className="rp-table-wrap">
          {loading ? (
            <div className="rp-skelwrap">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="rp-skelrow" style={{ animationDelay: `${i * 70}ms` }} />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rp-empty">
              <div className="rp-empty-icon">{dataset.length === 0 ? "🗃️" : "🔍"}</div>
              <h3>{dataset.length === 0 ? "No records in this collection yet" : "No matching records"}</h3>
              <p>
                {dataset.length === 0
                  ? "Records appear here automatically the moment they are created in any connected collection."
                  : "Nothing matches the current search / filters. Try clearing them, or search a different field (e.g. name: or slip:)."}
              </p>
              {dataset.length > 0 && (
                <button type="button" className="rp-btn rp-btn-ghost" onClick={resetAll}>Clear search &amp; filters</button>
              )}
            </div>
          ) : (
            <table className="rp-table">
              <thead>
                <tr>
                  <th className="rp-col-num">#</th>
                  <SortTh ids={["name-asc", "name-desc"]}>Person</SortTh>
                  <th>Status</th>
                  <th>ID No</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const meta = STATUS_META[r.status] || STATUS_META.REQUESTED;
                  return (
                    <tr key={r._id}
                      className={detailId === r._id ? "rp-row-open" : ""}
                      style={{ animationDelay: `${Math.min(i * 26, 300)}ms` }}
                      onClick={() => setDetailId(r._id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetailId(r._id); } }}
                      tabIndex={0} role="button" aria-label={`View record — ${r.name}`}
                    >
                      <td className="rp-td-num">{i + 1}</td>
                      <td>
                        <div className="rp-user-cell">
                          <span className="rp-avatar" style={{ background: avatarGradient(r.name) }}>{getInitials(r.name)}</span>
                          <div className="rp-user-text">
                            <span className="rp-user-name" title={r.name}>{r.name}</span>
                            <span className="rp-user-sub">{r.scope === "STAFF" ? "Staff" : "Student"}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`rp-badge rp-badge-${meta.tone}`}>{meta.icon} {meta.label}</span>
                        {isOverdue(r) && <span className="rp-tag rp-tag-overdue">Overdue</span>}
                      </td>
                      <td className="rp-mono">{r.idNo}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {!loading && filtered.length > shown.length && (
          <div className="rp-more">
            <button type="button" className="rp-more-btn" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, filtered.length - shown.length)} more · {filtered.length - shown.length} remaining
            </button>
          </div>
        )}
      </div>

      {/* ---------- detail modal ---------- */}
      {renderModal()}

      {/* ---------- toast ---------- */}
      <div aria-live="polite">
        {toast && (
          <div key={toast.id} className={`rp-toast rp-toast-${toast.type}`}>
            <span className="rp-toast-dot" />
            <span>{toast.text}</span>
          </div>
        )}
      </div>
    </section>
  );
}