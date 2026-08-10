import React, { useState, useEffect, useMemo, useCallback } from "react";
import { LIVE, sbSession, sbSignIn, sbSignUp, sbChangePin, sbSignOut, fetchAll, syncDB } from "./lib/db.js";

/* ============================================================
   REVANZA OFFICE TASK MANAGER — working prototype console
   Single-file React app. Data persists in the browser's localStorage.
   PROTOTYPE ONLY — see the banner in Settings. Not secure storage.
   ============================================================ */

const DB_KEY = "rotm:db:v2";
const SESSION_KEY = "rotm:session:v1";

/* ---------- date / util helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const addDays = (isoStr, n) => {
  const d = new Date(isoStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return iso(d);
};
const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
const fmtDate = (s) =>
  s ? new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");
const fmtStamp = (ts) =>
  ts ? new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 9);
const minsSinceMidnight = (ts) => {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
};
const hhmmToMins = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
function haversine(la1, lo1, la2, lo2) {
  const R = 6371000,
    t = Math.PI / 180;
  const dLa = (la2 - la1) * t,
    dLo = (lo2 - lo1) * t;
  const a =
    Math.sin(dLa / 2) ** 2 + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dLo / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/* ---------- roles & navigation ---------- */
const OWNER = "Owner / Super Admin";
const NAV = [
  { id: "dashboard", label: "Dashboard", roles: "*" },
  { id: "tasks", label: "Tasks", roles: "*" },
  { id: "attendance", label: "Attendance", roles: "*" },
  { id: "leave", label: "Leave", roles: "*" },
  { id: "cases", label: "Legal Cases", roles: [OWNER, "Legal Associate"] },
  { id: "calendar", label: "Calendar", roles: "*" },
  { id: "alerts", label: "Alerts", roles: "*" },
  { id: "directory", label: "Employee Directory", roles: "*" },
  { id: "reports", label: "Reports", roles: [OWNER, "Accounts", "Admin"] },
  { id: "audit", label: "Audit Log", roles: [OWNER] },
  { id: "settings", label: "Settings", roles: "*" },
];
const allowed = (item, role) => item.roles === "*" || item.roles.includes(role);

const TASK_STATUS = ["Not Started", "In Progress", "Facing Issues", "Stopped", "Delaying Completion Date", "Completed"];
const CASE_STAGE = ["Appearance Stage", "Counter Stage", "Enquiry Stage", "Trial", "Order Stage", "Disposed"];
const NEXT_ACTIONS = ["Appearance", "Briefing", "Conference", "Discussion"];
const STATUS_TONE = {
  Completed: "green", Present: "green", Approved: "green", "On Track": "green",
  Pending: "yellow", "Due Soon": "yellow",
  "Facing Issues": "orange", Late: "orange", Delayed: "orange", "Delaying Completion Date": "orange",
  Overdue: "red", Absent: "red", Stopped: "red", Critical: "red", Rejected: "red",
  "In Progress": "blue", Scheduled: "blue", "On Leave": "blue",
  "Not Started": "grey", Inactive: "grey", Archived: "grey",
};
const tone = (s) => STATUS_TONE[s] || "grey";

/* self-learning dropdowns: anything typed under "Others" joins the master list */
const learn = (d, key, v) => {
  const t = (v || "").trim();
  if (t && !d.masters[key].some((x) => x.toLowerCase() === t.toLowerCase())) d.masters[key].push(t);
};
const getGPS = () =>
  new Promise((res) => {
    if (!navigator.geolocation) return res({ lat: null, lng: null, err: "Geolocation unsupported" });
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, err: null }),
      (e) => res({ lat: null, lng: null, err: e.message }),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
function compressImage(file, maxW = 420, q = 0.6) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(cv.toDataURL("image/jpeg", q));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ---------- seed data ---------- */
const SEED_USERS = [
  ["Sushil", OWNER, "Management", "md@revanza.in", "9841344444"],
  ["Bala", "Engineer", "Engineering", "", ""],
  ["Govind", "Drawings", "Drawings", "", ""],
  ["Mariya", "Executive", "Operations", "", ""],
  ["Mrithula", "Legal Associate", "Legal", "legal@revanza.in", ""],
  ["Prathik", "Legal Associate", "Legal", "legal3@revanza.in", ""],
  ["Praveen", "Legal Associate", "Legal", "legal@oylo.in", ""],
  ["Prem", "Payments", "Accounts", "info@thefuel.in", "9514300000"],
  ["Rajashekar", "Engineer", "Engineering", "", ""],
  ["Senthil", "Executive", "Operations", "", ""],
  ["Shivani", "Legal Associate", "Legal", "legal2@revanza.in", ""],
  ["Sneka", "Admin", "Administration", "", ""],
  ["Sontha", "Admin", "Administration", "", ""],
  ["Vijay", "Accounts", "Accounts", "vijay@thefuel.in", "9841498198"],
  ["Vinoth", "Executive", "Operations", "", ""],
];
const PENDING = "Pending Information";

function seedDB() {
  const users = SEED_USERS.map((u, i) => ({
    id: "EMP" + pad(i + 1),
    name: u[0],
    role: u[1],
    dept: u[2],
    email: u[3] || PENDING,
    mobile: u[4] || PENDING,
    altMobile: PENDING,
    designation: u[1],
    manager: u[1] === OWNER ? "—" : "Sushil",
    doj: "",
    status: "Active",
    pin: "1234",
    mustChangePin: true,
    failed: 0,
    locked: false,
    logins: [],
    workStart: "09:30",
    workEnd: "18:30",
    graceMins: 15,
    weeklyOff: "Sunday",
    locationId: "LOC1",
    radiusM: 250,
    salary: u[1] === OWNER ? "" : "",
    salaryType: "Monthly",
    incentivePerHour: 0,
    leaveBalance: 12,
  }));
  const by = (n) => users.find((u) => u.name === n).id;
  const t = today();
  const mk = (o) => ({
    subtasks: [], updates: [], comments: [], docs: [], extension: null,
    priority: "Medium", status: "Not Started", created: t, ...o,
  });
  const tasks = [
    mk({ id: uid("t"), ref: "TSK-001", name: "Patta transfer — Sholinganallur plot", entity: "Revanza Estates",
      desc: "Follow up with Tahsildar office and collect updated patta extract.", assignedBy: by("Sushil"),
      assignedTo: by("Praveen"), start: addDays(t, -6), due: addDays(t, -2), status: "Facing Issues", priority: "High",
      subtasks: [{ id: uid("s"), name: "Collect parent documents", done: true }, { id: uid("s"), name: "File application", done: true }, { id: uid("s"), name: "Collect extract", done: false }] }),
    mk({ id: uid("t"), ref: "TSK-002", name: "Structural drawing revision — Tower B", entity: "Revanza Constructions",
      desc: "Incorporate consultant markups into Rev-3 and issue for approval.", assignedBy: by("Sushil"),
      assignedTo: by("Govind"), start: addDays(t, -3), due: t, status: "In Progress", priority: "High",
      subtasks: [{ id: uid("s"), name: "Update column schedule", done: true }, { id: uid("s"), name: "Issue Rev-3", done: false }] }),
    mk({ id: uid("t"), ref: "TSK-003", name: "Site inspection — Perungudi boundary wall", entity: "Perungudi Site",
      desc: "Photograph boundary wall progress and record encroachment, if any.", assignedBy: by("Sushil"),
      assignedTo: by("Rajashekar"), start: t, due: addDays(t, 1), status: "In Progress" }),
    mk({ id: uid("t"), ref: "TSK-004", name: "Vendor payment release — August", entity: "The Fuel",
      desc: "Verify invoices and release approved vendor payments.", assignedBy: by("Sushil"),
      assignedTo: by("Prem"), start: addDays(t, -1), due: addDays(t, 2), status: "In Progress", priority: "Medium" }),
    mk({ id: uid("t"), ref: "TSK-005", name: "GST reconciliation — Q1", entity: "Revanza Estates",
      desc: "Reconcile 2B with books and list mismatches.", assignedBy: by("Sushil"),
      assignedTo: by("Vijay"), start: addDays(t, -10), due: addDays(t, -4), status: "Stopped", priority: "High" }),
    mk({ id: uid("t"), ref: "TSK-006", name: "Tenant documentation — Anna Nagar unit", entity: "Revanza Estates",
      desc: "Prepare lease deed draft and collect KYC.", assignedBy: by("Sushil"),
      assignedTo: by("Senthil"), start: addDays(t, -2), due: addDays(t, 3) }),
    mk({ id: uid("t"), ref: "TSK-007", name: "Court fee payment — OS 214/2024", entity: "Revanza Estates",
      desc: "Pay court fee and file receipt.", assignedBy: by("Sushil"), assignedTo: by("Mrithula"),
      start: addDays(t, -1), due: t, status: "In Progress", priority: "High" }),
    mk({ id: uid("t"), ref: "TSK-008", name: "Office asset register update", entity: "Revanza Estates",
      desc: "Tag and list all office assets with photographs.", assignedBy: by("Sushil"),
      assignedTo: by("Sneka"), start: t, due: addDays(t, 6), priority: "Low" }),
  ];
  const cs = (o) => ({ updates: [], risk: "Medium", priority: "Medium", orderCopy: false, orderFiles: [], ...o });
  const cases = [
    cs({ id: uid("c"), ref: "CASE-001", title: "Revanza Estates v. K. Manoharan", caseNo: "OS 214/2024",
      type: "Suit for injunction", court: "City Civil Court, Chennai", bench: "IV Addl.", judge: "Presiding Judge",
      sections: "Or.39 R.1 & 2 CPC", petitioner: "Revanza Estates Pvt Ltd", respondent: "K. Manoharan",
      counsel: "M/s Rajan & Associates", associate: by("Praveen"), entity: "Revanza Estates",
      stage: "Counter Stage", status: "Awaiting counter", lastHearing: addDays(t, -9), nextHearing: t,
      nextAction: "Counter to be filed; brief counsel by morning", filingDeadline: addDays(t, 2),
      briefingDate: t, conferenceDate: "", priority: "High", risk: "High" }),
    cs({ id: uid("c"), ref: "CASE-002", title: "Revanza Constructions v. Corporation of Chennai", caseNo: "WP 8821/2025",
      type: "Writ petition", court: "Madras High Court", bench: "Single Bench", judge: "Hon'ble Judge",
      sections: "Art. 226", petitioner: "Revanza Constructions", respondent: "Corporation of Chennai",
      counsel: "M/s Iyer & Co", associate: by("Mrithula"), entity: "Revanza Constructions",
      stage: "Trial", status: "Part-heard", lastHearing: addDays(t, -4), nextHearing: addDays(t, 1),
      nextAction: "Appearance and continuation of arguments", filingDeadline: "", briefingDate: t,
      conferenceDate: addDays(t, 1), priority: "High", risk: "Medium" }),
    cs({ id: uid("c"), ref: "CASE-003", title: "S. Lakshmi v. Revanza Estates", caseNo: "CC 62/2025",
      type: "Consumer complaint", court: "District Consumer Commission, Chennai", bench: "—", judge: "President",
      sections: "S.35 CP Act", petitioner: "S. Lakshmi", respondent: "Revanza Estates Pvt Ltd",
      counsel: "M/s Rajan & Associates", associate: by("Shivani"), entity: "Revanza Estates",
      stage: "Enquiry Stage", status: "Evidence stage", lastHearing: addDays(t, -20), nextHearing: "",
      nextAction: "Next hearing date to be ascertained from cause list", filingDeadline: "",
      briefingDate: "", conferenceDate: "", priority: "Medium", risk: "Medium" }),
    cs({ id: uid("c"), ref: "CASE-004", title: "Revanza Estates v. Sub-Registrar, Sholinganallur", caseNo: "WP 11204/2025",
      type: "Writ petition", court: "Madras High Court", bench: "Single Bench", judge: "Hon'ble Judge",
      sections: "Art. 226", petitioner: "Revanza Estates Pvt Ltd", respondent: "Sub-Registrar",
      counsel: "M/s Iyer & Co", associate: by("Prathik"), entity: "Revanza Estates",
      stage: "Order Stage", status: "Order reserved", lastHearing: addDays(t, -2), nextHearing: addDays(t, 6),
      nextAction: "Await pronouncement; upload order copy on receipt", filingDeadline: "",
      briefingDate: "", conferenceDate: "", priority: "Medium", risk: "Low" }),
  ];
  const attendance = [
    { id: uid("a"), userId: by("Praveen"), date: t, mode: "Office", inTs: new Date().setHours(9, 22, 0, 0), inDist: 40, inPhoto: null, outTs: null,
      morningUpdate: { ts: new Date().setHours(10, 5, 0, 0), text: "Tahsildar office follow-up scheduled at 11:30.", plan: "Collect patta extract", issues: "File not traceable in section" }, eveningUpdate: null },
    { id: uid("a"), userId: by("Govind"), date: t, mode: "Office", inTs: new Date().setHours(9, 58, 0, 0), inDist: 90, inPhoto: null, outTs: null, morningUpdate: null, eveningUpdate: null },
    { id: uid("a"), userId: by("Rajashekar"), date: t, mode: "Site", inTs: new Date().setHours(9, 10, 0, 0), inDist: 3100, inPhoto: null, outTs: null,
      morningUpdate: { ts: new Date().setHours(10, 12, 0, 0), text: "At Perungudi site.", plan: "Wall progress photos", issues: "" }, eveningUpdate: null },
    { id: uid("a"), userId: by("Vijay"), date: t, mode: "Office", inTs: new Date().setHours(9, 30, 0, 0), inDist: 12, inPhoto: null, outTs: null, morningUpdate: null, eveningUpdate: null },
  ];
  const leaves = [
    { id: uid("l"), userId: by("Sneka"), type: "Casual", from: addDays(t, 2), to: addDays(t, 3), days: 2,
      reason: "Family function", doc: false, status: "Pending", applied: Date.now() - 7200000 },
    { id: uid("l"), userId: by("Vinoth"), type: "Medical", from: t, to: t, days: 1,
      reason: "Fever", doc: false, status: "Pending", applied: Date.now() - 3600000 },
  ];
  return {
    users, tasks, cases, attendance, leaves,
    masters: {
      entities: ["Perungudi Site", "Revanza Constructions", "Revanza Estates", "The Fuel"],
      courts: ["City Civil Court, Chennai", "District Consumer Commission, Chennai", "Madras High Court"],
      judges: ["Hon'ble Judge", "President", "Presiding Judge"],
      counsels: ["M/s Iyer & Co", "M/s Rajan & Associates"],
      sections: ["Art. 226", "Or.39 R.1 & 2 CPC", "S.35 CP Act"],
      caseStages: [],
      nextActions: [...NEXT_ACTIONS],
      leaveReasons: ["Family function", "Medical", "Personal work", "Travel"],
    },
    locations: [{ id: "LOC1", name: "Head Office — Chennai", lat: 13.0827, lng: 80.2707, radiusM: 250 }],
    holidays: [],
    audit: [{ ts: Date.now(), by: "system", action: "Workspace created", detail: "Seed users and sample records loaded" }],
    settings: { morningDue: "10:30", ownerEmail: "md@revanza.in" },
  };
}

/* ---------- storage (browser localStorage — works on any host) ---------- */
async function loadDB() {
  try {
    const r = localStorage.getItem(DB_KEY);
    return r ? JSON.parse(r) : null;
  } catch { return null; }
}
async function saveDB(db) {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { console.error("save failed", e); }
}

/* ---------- derived logic ---------- */
const isOverdue = (t) => t.status !== "Completed" && t.due && t.due < today();
const openTasks = (tasks) => tasks.filter((t) => t.status !== "Completed");
const attFor = (db, userId, date) => db.attendance.find((a) => a.userId === userId && a.date === date);
const uname = (db, id) => db.users.find((u) => u.id === id)?.name || "—";
const urole = (db, id) => db.users.find((u) => u.id === id)?.role || "";

function buildAlerts(db) {
  const t = today();
  const out = [];
  const push = (sev, type, who, subject, action, ref) => out.push({ id: uid("al"), sev, type, who, subject, action, ref, ts: Date.now() });
  db.users.filter((u) => u.status === "Active" && u.role !== OWNER).forEach((u) => {
    const a = attFor(db, u.id, t);
    const onLeave = db.leaves.some((l) => l.status === "Approved" && l.from <= t && l.to >= t && l.userId === u.id);
    if (onLeave) return;
    if (!a) push("Critical", "Attendance not marked", u.name, "No check-in recorded today", "Call / remind", null);
    else {
      if (a.inTs && minsSinceMidnight(a.inTs) > hhmmToMins(u.workStart) + u.graceMins)
        push("Attention", "Late arrival", u.name, `Checked in at ${fmtTime(a.inTs)}`, "Review", null);
      if (a.inDist > u.radiusM && a.mode === "Office")
        push("Attention", "Location mismatch", u.name, `${a.inDist} m from reporting location`, "Verify", null);
      if (!a.inPhoto)
        push("Attention", "Attendance photo missing", u.name, "Check-in recorded without a photograph", "Photo verification required", null);
      const hasOpen = db.tasks.some((x) => x.assignedTo === u.id && x.status !== "Completed");
      if (!a.morningUpdate && hasOpen && new Date().getHours() >= 10)
        push("Critical", "Morning update missing", u.name, `Due by ${db.settings.morningDue}`, "Remind", null);
      if (!a.outTs && new Date().getHours() >= 19) push("Attention", "Check-out not marked", u.name, "Still checked in", "Remind", null);
    }
  });
  db.tasks.forEach((tk) => {
    if (isOverdue(tk)) push("Critical", "Overdue task", uname(db, tk.assignedTo), `${tk.ref} — ${tk.name}`, `${dayDiff(tk.due, t)} day(s) overdue`, { kind: "task", id: tk.id });
    else if (tk.due === t && tk.status !== "Completed") push("Attention", "Task due today", uname(db, tk.assignedTo), `${tk.ref} — ${tk.name}`, "Confirm completion", { kind: "task", id: tk.id });
    if (tk.status === "Facing Issues") push("Attention", "Task facing issues", uname(db, tk.assignedTo), `${tk.ref} — ${tk.name}`, "Assistance required", { kind: "task", id: tk.id });
    if (tk.status === "Stopped") push("Critical", "Task stopped", uname(db, tk.assignedTo), `${tk.ref} — ${tk.name}`, "Owner decision needed", { kind: "task", id: tk.id });
    if (tk.extension?.status === "Pending") push("Attention", "Extension requested", uname(db, tk.assignedTo), `${tk.ref} → ${fmtDate(tk.extension.newDate)}`, "Approve or reject", { kind: "task", id: tk.id });
  });
  db.cases.forEach((c) => {
    if (c.nextHearing === t) push("Critical", "Case listed today", uname(db, c.associate), `${c.caseNo} — ${c.court}`, c.nextAction || "Appearance", { kind: "case", id: c.id });
    else if (c.nextHearing === addDays(t, 1)) push("Attention", "Case listed tomorrow", uname(db, c.associate), `${c.caseNo} — ${c.court}`, "Briefing required", { kind: "case", id: c.id });
    if (!c.nextHearing && c.stage !== "Disposed") push("Attention", "No next hearing date", uname(db, c.associate), `${c.caseNo}`, "Ascertain from cause list", { kind: "case", id: c.id });
    if (c.stage === "Order Stage" && !c.orderCopy) push("Attention", "Order copy not uploaded", uname(db, c.associate), `${c.caseNo}`, "Upload order copy", { kind: "case", id: c.id });
    if (c.filingDeadline && c.filingDeadline >= t && dayDiff(t, c.filingDeadline) <= 3)
      push("Critical", "Filing deadline approaching", uname(db, c.associate), `${c.caseNo} — ${fmtDate(c.filingDeadline)}`, "File in time", { kind: "case", id: c.id });
  });
  db.leaves.filter((l) => l.status === "Pending").forEach((l) =>
    push("Attention", "Leave request pending", uname(db, l.userId), `${l.type} · ${fmtDate(l.from)} – ${fmtDate(l.to)}`, "Approve or reject", null));
  const rank = { Critical: 0, Attention: 1 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

/* ---------- CSV ---------- */
function downloadCSV(filename, rows, meta) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = meta.map((m) => esc(m)).join(",");
  const body = rows.map((r) => r.map(esc).join(",")).join("\n");
  const blob = new Blob([head + "\n\n" + body], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ============================ UI PRIMITIVES ============================ */
const Mark = ({ size = 30 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="20" cy="20" r="19" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" strokeWidth="0.6" opacity="0.6" />
    <text x="20" y="26.5" textAnchor="middle" fontFamily="Newsreader, Georgia, serif" fontSize="19" fill="currentColor">R</text>
  </svg>
);
const Badge = ({ children, t }) => <span className={`badge b-${t || tone(children)}`}>{children}</span>;
const Btn = ({ children, onClick, kind = "ghost", type = "button", disabled, full }) => (
  <button type={type} className={`btn b-${kind}${full ? " full" : ""}`} onClick={onClick} disabled={disabled}>{children}</button>
);
const Field = ({ label, children, hint }) => (
  <label className="field"><span className="flabel">{label}</span>{children}{hint && <span className="fhint">{hint}</span>}</label>
);
const Panel = ({ title, sub, right, children, pad = true }) => (
  <section className="panel">
    {(title || right) && (
      <header className="panel-h">
        <div><h2>{title}</h2>{sub && <p>{sub}</p>}</div>
        <div className="panel-r">{right}</div>
      </header>
    )}
    <div className={pad ? "panel-b" : ""}>{children}</div>
  </section>
);
const Stat = ({ n, label, t, onClick }) => (
  <button className={`stat s-${t || "grey"}`} onClick={onClick} disabled={!onClick}>
    <span className="stat-n">{n}</span><span className="stat-l">{label}</span>
  </button>
);
const Empty = ({ children }) => <p className="empty">{children}</p>;
function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <header className="modal-h"><h3>{title}</h3><button className="x" onClick={onClose} aria-label="Close">×</button></header>
        <div className="modal-b">{children}</div>
      </div>
    </div>
  );
}
const Bars = ({ data }) => {
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <div className="bars">
      {data.map((d) => (
        <div className="bar-row" key={d.k}>
          <span className="bar-k">{d.k}</span>
          <span className="bar-t"><span className={`bar-f f-${d.t || "blue"}`} style={{ width: (d.v / max) * 100 + "%" }} /></span>
          <span className="bar-v">{d.v}</span>
        </div>
      ))}
    </div>
  );
};

/* Dropdown with an "Others" option — new entries join the list for next time */
function SmartSelect({ label, value, onChange, options, hint }) {
  const opts = [...new Set(options)].sort((a, b) => a.localeCompare(b));
  const [other, setOther] = useState(Boolean(value) && !opts.includes(value));
  return (
    <Field label={label} hint={hint}>
      {!other ? (
        <select value={opts.includes(value) ? value : ""}
          onChange={(e) => { if (e.target.value === "__other") { setOther(true); onChange(""); } else onChange(e.target.value); }}>
          <option value="">Select</option>
          {opts.map((o) => <option key={o}>{o}</option>)}
          <option value="__other">Others — add a new entry…</option>
        </select>
      ) : (
        <div className="inline">
          <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder="Type the new entry" />
          <Btn onClick={() => { setOther(false); onChange(""); }}>List</Btn>
        </div>
      )}
    </Field>
  );
}

/* Opens the device camera (front camera on phones), compresses the shot */
function CameraButton({ label, kind = "ghost", onShot, disabled }) {
  const ref = React.useRef(null);
  return (
    <>
      <input ref={ref} type="file" accept="image/*" capture="user" style={{ display: "none" }}
        onChange={async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try { onShot(await compressImage(f)); } catch { onShot(null); }
          e.target.value = "";
        }} />
      <Btn kind={kind} disabled={disabled} onClick={() => ref.current && ref.current.click()}>{label}</Btn>
    </>
  );
}

/* Voice note → text via the browser's speech recognition (works in Chrome) */
function VoiceNote({ onText, flash }) {
  const [rec, setRec] = useState(null);
  const [live, setLive] = useState("");
  const finalRef = React.useRef("");
  const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) return <p className="fhint">Voice notes need Chrome or the Android app's browser — this browser does not support speech recognition.</p>;
  const start = () => {
    const r = new SR();
    r.lang = "en-IN"; r.interimResults = true; r.continuous = true;
    finalRef.current = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalRef.current += t;
        else interim += t;
      }
      setLive(finalRef.current + interim);
    };
    r.onerror = () => { setRec(null); flash("Voice capture stopped — check microphone permission"); };
    r.onend = () => setRec(null);
    r.start(); setRec(r);
  };
  const stop = () => {
    rec && rec.stop();
    const text = (finalRef.current || live).trim();
    if (text) onText(text);
    setLive("");
  };
  return (
    <div className="voice">
      {!rec
        ? <Btn onClick={start}>Record a voice note</Btn>
        : <><Btn kind="solid" onClick={stop}>Stop and save as text</Btn><span className="rec-live">{live || "Listening…"}</span></>}
    </div>
  );
}

/* ============================ APP ============================ */
export default function App() {
  const [db, setDb] = useState(null);
  const [me, setMe] = useState(null);
  const [view, setView] = useState("dashboard");
  const [navOpen, setNavOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [focus, setFocus] = useState(null); // {kind,id} deep link
  const [preset, setPreset] = useState(null); // filter preset from a clicked card

  useEffect(() => {
    (async () => {
      if (LIVE) {
        const s = await sbSession();
        if (s) {
          const d = await fetchAll();
          setDb(d);
          const u = d.users.find((x) => x.authId === s.user.id);
          if (u && u.status === "Active") setMe(u.id);
        }
        return;
      }
      let d = await loadDB();
      if (!d) { d = seedDB(); await saveDB(d); }
      setDb(d);
      try {
        const sv = localStorage.getItem(SESSION_KEY);
        const u = sv && d.users.find((x) => x.id === JSON.parse(sv));
        if (u && u.status === "Active") setMe(u.id);
      } catch { /* no session */ }
    })();
  }, []);

  // live mode: pull everyone else's changes every 45 s and on window focus
  useEffect(() => {
    if (!LIVE || !me) return;
    const refresh = async () => { try { setDb(await fetchAll()); } catch { /* offline */ } };
    const iv = setInterval(refresh, 45000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(iv); window.removeEventListener("focus", refresh); };
  }, [me]);

  const commit = useCallback((mut, note) => {
    setDb((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      mut(next);
      if (note) next.audit.unshift({ ts: Date.now(), by: note.by || "system", action: note.action, detail: note.detail || "" });
      if (LIVE) {
        const meUser = me && prev.users.find((u) => u.id === me);
        syncDB(prev, next, meUser ? meUser.role : "");
      } else saveDB(next);
      return next;
    });
  }, [me]);
  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2600); };

  const user = db && me ? db.users.find((u) => u.id === me) : null;
  const alerts = useMemo(() => (db ? buildAlerts(db) : []), [db]);

  const signOut = async () => {
    if (LIVE) { try { await sbSignOut(); } catch { } }
    else { try { localStorage.removeItem(SESSION_KEY); } catch { } }
    setMe(null); setView("dashboard");
  };
  const go = (v, p = null, f = null) => { setView(v); setPreset(p); setFocus(f); setNavOpen(false); };

  if (LIVE && !me) return (
    <>
      <Styles />
      <LiveLogin onIn={async () => {
        const d = await fetchAll();
        setDb(d);
        const s = await sbSession();
        const u = s && d.users.find((x) => x.authId === s.user.id);
        if (u && u.status === "Active") setMe(u.id);
        else setToast("Signed in, but no active profile is linked to this number. Ask the Owner.");
      }} />
      {toast && <div className="toast">{toast}</div>}
    </>
  );
  if (!db) return (<><Styles /><div className="boot"><Mark size={40} /><p>Loading workspace…</p></div></>);
  if (!user) return (<><Styles /><Login db={db} commit={commit} onIn={(id) => { setMe(id); try { localStorage.setItem(SESSION_KEY, JSON.stringify(id)); } catch { } }} /></>);
  if (user.mustChangePin) return (<><Styles /><ChangePin user={user} commit={commit} first onDone={() => flash("PIN changed")} /></>);

  const isOwner = user.role === OWNER;
  const myAlerts = isOwner ? alerts : alerts.filter((a) => a.who === user.name);
  const nav = NAV.filter((n) => allowed(n, user.role));

  return (
    <>
      <Styles />
      <div className="app">
        <aside className={`side${navOpen ? " open" : ""}`}>
          <div className="brand">
            <span className="brand-mark"><Mark /></span>
            <span className="brand-txt"><b>Revanza</b><i>Office Task Manager</i></span>
          </div>
          <nav>
            {nav.map((n) => (
              <button key={n.id} className={`nav${view === n.id ? " on" : ""}`} onClick={() => go(n.id)}>
                {n.label}
                {n.id === "alerts" && myAlerts.length > 0 && <em className="pip">{myAlerts.length}</em>}
              </button>
            ))}
          </nav>
          <div className="side-foot">
            <span className="who"><b>{user.name}</b><i>{user.role}</i></span>
            <button className="signout" onClick={signOut}>Sign out</button>
          </div>
        </aside>
        {navOpen && <div className="side-scrim" onClick={() => setNavOpen(false)} />}

        <main>
          <header className="top">
            <button className="burger" onClick={() => setNavOpen((v) => !v)} aria-label="Menu">☰</button>
            <div className="top-t">
              <h1>{NAV.find((n) => n.id === view)?.label}</h1>
              <p>{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
            </div>
            <button className="top-alert" onClick={() => go("alerts")}>
              Alerts{myAlerts.length > 0 && <em className="pip">{myAlerts.length}</em>}
            </button>
          </header>

          <div className="canvas">
            {view === "dashboard" && (isOwner
              ? <OwnerDash db={db} alerts={alerts} go={go} commit={commit} user={user} flash={flash} />
              : <StaffDash db={db} user={user} go={go} commit={commit} flash={flash} />)}
            {view === "tasks" && <Tasks db={db} user={user} commit={commit} flash={flash} preset={preset} focus={focus} />}
            {view === "attendance" && <Attendance db={db} user={user} commit={commit} flash={flash} />}
            {view === "leave" && <Leave db={db} user={user} commit={commit} flash={flash} />}
            {view === "cases" && <Cases db={db} user={user} commit={commit} flash={flash} preset={preset} focus={focus} />}
            {view === "calendar" && <CalendarView db={db} user={user} go={go} />}
            {view === "alerts" && <Alerts alerts={myAlerts} go={go} />}
            {view === "directory" && <Directory db={db} user={user} commit={commit} flash={flash} />}
            {view === "reports" && <Reports db={db} user={user} />}
            {view === "audit" && <AuditLog db={db} />}
            {view === "settings" && <Settings db={db} user={user} commit={commit} flash={flash} />}
          </div>
        </main>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

/* ============================ LOGIN ============================ */
function LiveLogin({ onIn }) {
  const [tab, setTab] = useState("in");
  const [mobile, setMobile] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault(); setErr("");
    const m = mobile.trim();
    if (!/^\d{10}$/.test(m)) return setErr("Enter the 10-digit registered mobile number.");
    if (!/^\d{4}$/.test(pin)) return setErr("The PIN must be exactly 4 digits.");
    setBusy(true);
    if (tab === "in") {
      const { error } = await sbSignIn(m, pin);
      setBusy(false);
      if (error) return setErr("Sign-in failed. Check the number and PIN — or, if you have never created a PIN, use 'First time here'.");
      await onIn();
    } else {
      if (pin !== pin2) { setBusy(false); return setErr("The two PINs do not match."); }
      const { error } = await sbSignUp(m, pin);
      if (error) {
        setBusy(false);
        return setErr(/registered/i.test(error.message)
          ? "This mobile number has not been added by the Owner yet."
          : "Could not create the sign-in: " + error.message);
      }
      const r2 = await sbSignIn(m, pin);
      setBusy(false);
      if (r2.error) return setErr("Your PIN was created — now use the Sign in tab.");
      await onIn();
    }
  };
  return (
    <div className="login">
      <div className="login-card">
        <div className="login-brand"><Mark size={44} /><h1>Revanza</h1><p>Office Task Manager</p></div>
        <div className="statusbar" style={{ marginTop: 0 }}>
          <button className={`chip${tab === "in" ? " on" : ""}`} onClick={() => { setTab("in"); setErr(""); }}>Sign in</button>
          <button className={`chip${tab === "up" ? " on" : ""}`} onClick={() => { setTab("up"); setErr(""); }}>First time — create my PIN</button>
        </div>
        <form onSubmit={submit}>
          <Field label="Registered mobile number">
            <input inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="10-digit mobile number" autoComplete="username" />
          </Field>
          <Field label="4-digit PIN">
            <input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value)} placeholder="••••" autoComplete={tab === "in" ? "current-password" : "new-password"} />
          </Field>
          {tab === "up" && (
            <Field label="Confirm PIN">
              <input type="password" inputMode="numeric" maxLength={4} value={pin2} onChange={(e) => setPin2(e.target.value)} placeholder="••••" />
            </Field>
          )}
          {err && <p className="err">{err}</p>}
          <Btn kind="solid" type="submit" full disabled={busy}>{busy ? "Please wait…" : tab === "in" ? "Sign in" : "Create PIN and sign in"}</Btn>
        </form>
        <p className="login-note">
          Only mobile numbers added by the Owner can sign in. First-time users choose their own PIN.
          Forgot your PIN? Ask the Owner to reset it.
        </p>
      </div>
    </div>
  );
}

function Login({ db, commit, onIn }) {
  const [mobile, setMobile] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [showDemo, setShowDemo] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    setErr("");
    const u = db.users.find((x) => x.mobile === mobile.trim());
    if (!u) return setErr("No user is registered against that mobile number.");
    if (u.status !== "Active") return setErr("This account is deactivated. Contact the Owner.");
    if (u.locked) return setErr("Account locked after repeated failed attempts. Ask the Owner to reset the PIN.");
    if (u.pin !== pin) {
      commit((d) => {
        const x = d.users.find((y) => y.id === u.id);
        x.failed += 1;
        if (x.failed >= 5) x.locked = true;
      }, { by: u.name, action: "Failed sign-in", detail: `Mobile ${mobile}` });
      return setErr(`Incorrect PIN. ${4 - u.failed} attempt(s) left before the account locks.`);
    }
    commit((d) => {
      const x = d.users.find((y) => y.id === u.id);
      x.failed = 0;
      x.logins.unshift({ ts: Date.now(), agent: navigator.userAgent.slice(0, 60) });
      x.logins = x.logins.slice(0, 20);
    }, { by: u.name, action: "Signed in", detail: "" });
    onIn(u.id);
  };

  const demoIn = (id) => {
    const u = db.users.find((x) => x.id === id);
    commit((d) => {
      const x = d.users.find((y) => y.id === id);
      x.logins.unshift({ ts: Date.now(), agent: "Role preview (demo)" });
    }, { by: u.name, action: "Signed in (role preview)", detail: "" });
    onIn(id);
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-brand"><Mark size={44} /><h1>Revanza</h1><p>Office Task Manager</p></div>
        <form onSubmit={submit}>
          <Field label="Registered mobile number">
            <input inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="10-digit mobile number" autoComplete="username" />
          </Field>
          <Field label="4-digit PIN">
            <input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value)} placeholder="••••" autoComplete="current-password" />
          </Field>
          {err && <p className="err">{err}</p>}
          <Btn kind="solid" type="submit" full>Sign in</Btn>
        </form>
        <p className="login-note">
          Demo sign-in: <b>9841344444</b> (Sushil, Owner) with PIN <b>1234</b>. Other staff records still show
          their mobile number as “Pending Information”, so use role preview below until the Owner fills them in.
        </p>
        <button className="linkish" onClick={() => setShowDemo((v) => !v)}>{showDemo ? "Hide" : "Preview another role"}</button>
        {showDemo && (
          <div className="demo-list">
            {[...db.users].sort((a, b) => (a.role === OWNER ? -1 : b.role === OWNER ? 1 : a.name.localeCompare(b.name)))
              .map((u) => (
                <button key={u.id} onClick={() => demoIn(u.id)}>
                  <b>{u.name}</b> — {u.role}
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangePin({ user, commit, first, onDone, onClose }) {
  const [a, setA] = useState(""); const [b, setB] = useState(""); const [old, setOld] = useState(""); const [err, setErr] = useState("");
  const save = async (e) => {
    e.preventDefault();
    if (!first && !LIVE && old !== user.pin) return setErr("Current PIN is incorrect.");
    if (!/^\d{4}$/.test(a)) return setErr("The PIN must be exactly 4 digits.");
    if (a !== b) return setErr("The two PINs do not match.");
    if (!LIVE && a === "1234") return setErr("Choose a PIN other than the temporary one.");
    if (LIVE) {
      const { error } = await sbChangePin(a);
      if (error) return setErr(error.message);
    }
    commit((d) => { const u = d.users.find((x) => x.id === user.id); if (!LIVE) u.pin = a; u.mustChangePin = false; },
      { by: user.name, action: "PIN changed", detail: "" });
    onDone && onDone(); onClose && onClose();
  };
  const body = (
    <form onSubmit={save} className="pin-form">
      {first && <p className="notice">You are signed in with a temporary PIN. Set a new one to continue.</p>}
      {!first && !LIVE && <Field label="Current PIN"><input type="password" maxLength={4} inputMode="numeric" value={old} onChange={(e) => setOld(e.target.value)} /></Field>}
      <Field label="New 4-digit PIN"><input type="password" maxLength={4} inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} /></Field>
      <Field label="Confirm new PIN"><input type="password" maxLength={4} inputMode="numeric" value={b} onChange={(e) => setB(e.target.value)} /></Field>
      {err && <p className="err">{err}</p>}
      <Btn kind="solid" type="submit" full>Save new PIN</Btn>
    </form>
  );
  if (!first) return body;
  return (
    <div className="login"><div className="login-card">
      <div className="login-brand"><Mark size={44} /><h1>Set your PIN</h1><p>{user.name} · {user.role}</p></div>
      {body}
    </div></div>
  );
}

/* ============================ OWNER DASHBOARD ============================ */
function OwnerDash({ db, alerts, go, commit, user, flash }) {
  const t = today();
  const staff = db.users.filter((u) => u.status === "Active" && u.role !== OWNER);
  const present = staff.filter((u) => attFor(db, u.id, t));
  const onLeave = staff.filter((u) => db.leaves.some((l) => l.userId === u.id && l.status === "Approved" && l.from <= t && l.to >= t));
  const absent = staff.filter((u) => !attFor(db, u.id, t) && !onLeave.includes(u));
  const late = present.filter((u) => { const a = attFor(db, u.id, t); return a.inTs && minsSinceMidnight(a.inTs) > hhmmToMins(u.workStart) + u.graceMins; });
  const noMorning = staff.filter((u) => { const a = attFor(db, u.id, t); return a && !a.morningUpdate; });
  const open = openTasks(db.tasks);
  const over = db.tasks.filter(isOverdue);
  const dueToday = db.tasks.filter((x) => x.due === t && x.status !== "Completed");
  const issues = db.tasks.filter((x) => x.status === "Facing Issues" || x.status === "Stopped");
  const delaying = db.tasks.filter((x) => x.status === "Delaying Completion Date");
  const yest = addDays(t, -1);
  const reminderQueue = staff
    .filter((u) => !onLeave.includes(u))
    .map((u) => {
      const a = attFor(db, u.id, t);
      const ya = attFor(db, u.id, yest);
      const miss = [];
      if (!a) miss.push("attendance not marked this morning");
      else if (!a.morningUpdate) miss.push("morning task update not submitted");
      if (ya && !ya.eveningUpdate) miss.push("yesterday evening's task update not submitted");
      return miss.length ? { u, miss } : null;
    })
    .filter(Boolean);
  const listedToday = db.cases.filter((c) => c.nextHearing === t);
  const listedTom = db.cases.filter((c) => c.nextHearing === addDays(t, 1));
  const noDate = db.cases.filter((c) => !c.nextHearing && c.stage !== "Disposed");
  const pendingLeave = db.leaves.filter((l) => l.status === "Pending");

  const byStatus = TASK_STATUS.map((s) => ({ k: s, v: db.tasks.filter((x) => x.status === s).length, t: tone(s) }));
  const ageing = [
    { k: "1–3 days", v: over.filter((x) => dayDiff(x.due, t) <= 3).length, t: "orange" },
    { k: "4–7 days", v: over.filter((x) => { const d = dayDiff(x.due, t); return d > 3 && d <= 7; }).length, t: "orange" },
    { k: "8–15 days", v: over.filter((x) => { const d = dayDiff(x.due, t); return d > 7 && d <= 15; }).length, t: "red" },
    { k: "16–30 days", v: over.filter((x) => { const d = dayDiff(x.due, t); return d > 15 && d <= 30; }).length, t: "red" },
    { k: "30+ days", v: over.filter((x) => dayDiff(x.due, t) > 30).length, t: "red" },
  ];
  const byEmp = staff.map((u) => ({ k: u.name, v: db.tasks.filter((x) => x.assignedTo === u.id && x.status !== "Completed").length, t: "blue" }))
    .filter((d) => d.v > 0).sort((a, b) => b.v - a.v);

  const summaryText = () => {
    const L = [
      `REVANZA — DAILY OWNER SUMMARY · ${fmtDate(t)}`, "",
      "ATTENDANCE",
      `Present ${present.length} · Absent ${absent.length} · On leave ${onLeave.length} · Late ${late.length}`,
      absent.length ? `Not checked in: ${absent.map((u) => u.name).join(", ")}` : "All staff checked in.",
      "", "TASK UPDATES",
      `Morning updates missing: ${noMorning.length ? noMorning.map((u) => u.name).join(", ") : "none"}`,
      `Overdue ${over.length} · Due today ${dueToday.length} · Facing issues/stopped ${issues.length} · Delaying completion ${delaying.length}`,
      "", "LEGAL MATTERS",
      `Listed today ${listedToday.length} · Listed tomorrow ${listedTom.length} · Without next hearing date ${noDate.length}`,
      ...listedToday.map((c) => `  · ${c.caseNo} — ${c.court} — ${c.nextAction}`),
      "", "LEAVE",
      `Pending approval ${pendingLeave.length}`,
    ];
    return L.join("\n");
  };

  return (
    <>
      <div className="grid-4">
        <Stat n={present.length} label="Present today" t="green" onClick={() => go("attendance")} />
        <Stat n={absent.length} label="Not checked in" t="red" onClick={() => go("attendance")} />
        <Stat n={onLeave.length} label="On leave" t="blue" onClick={() => go("leave")} />
        <Stat n={late.length} label="Late arrivals" t="orange" onClick={() => go("attendance")} />
        <Stat n={open.length} label="Active tasks" t="blue" onClick={() => go("tasks", { status: "" })} />
        <Stat n={over.length} label="Overdue tasks" t="red" onClick={() => go("tasks", { quick: "overdue" })} />
        <Stat n={dueToday.length} label="Due today" t="yellow" onClick={() => go("tasks", { quick: "today" })} />
        <Stat n={delaying.length} label="Delaying completion" t="orange" onClick={() => go("tasks", { status: "Delaying Completion Date" })} />
        <Stat n={db.cases.filter((c) => c.stage !== "Disposed").length} label="Active cases" t="blue" onClick={() => go("cases")} />
        <Stat n={listedToday.length} label="Listed today" t="red" onClick={() => go("cases", { quick: "today" })} />
        <Stat n={listedTom.length} label="Listed tomorrow" t="orange" onClick={() => go("cases", { quick: "tomorrow" })} />
        <Stat n={pendingLeave.length} label="Leave to approve" t="yellow" onClick={() => go("leave")} />
      </div>

      <Panel title="Today’s priority actions" sub="Ordered by severity. Everything here needs a decision or a nudge." pad={false}>
        {alerts.length === 0 ? <div className="panel-b"><Empty>Nothing outstanding. The board is clear.</Empty></div> : (
          <ul className="board">
            {alerts.slice(0, 14).map((a) => (
              <li key={a.id} className={`board-row r-${a.sev === "Critical" ? "red" : "orange"}`}>
                <div className="board-main">
                  <span className="board-type">{a.type}</span>
                  <span className="board-sub">{a.subject}</span>
                </div>
                <div className="board-meta">
                  <span className="board-who">{a.who}</span>
                  <span className="board-act">{a.action}</span>
                </div>
                {a.ref && <Btn onClick={() => go(a.ref.kind === "task" ? "tasks" : "cases", null, a.ref)}>Open</Btn>}
                {!a.ref && a.type.startsWith("Leave") && <Btn onClick={() => go("leave")}>Open</Btn>}
                {!a.ref && !a.type.startsWith("Leave") && <Btn onClick={() => go("attendance")}>Open</Btn>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="two">
        <Panel title="Daily update status" sub={`Morning updates are due by ${db.settings.morningDue}`}>
          <table className="tbl">
            <thead><tr><th>Employee</th><th>Check-in</th><th>Morning</th><th>Evening</th></tr></thead>
            <tbody>
              {staff.map((u) => {
                const a = attFor(db, u.id, t);
                return (
                  <tr key={u.id}>
                    <td><b>{u.name}</b><i className="sub">{u.role}</i></td>
                    <td>{a ? fmtTime(a.inTs) : <Badge>Absent</Badge>}</td>
                    <td>{a?.morningUpdate ? <Badge t="green">Submitted</Badge> : <Badge t="red">Missing</Badge>}</td>
                    <td>{a?.eveningUpdate ? <Badge t="green">Submitted</Badge> : <Badge t="grey">Pending</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
        <Panel title="Upcoming court matters" sub="Next 15 days">
          {db.cases.filter((c) => c.nextHearing && c.nextHearing >= t && dayDiff(t, c.nextHearing) <= 15)
            .sort((a, b) => a.nextHearing.localeCompare(b.nextHearing)).length === 0
            ? <Empty>No matters listed in the next 15 days.</Empty>
            : db.cases.filter((c) => c.nextHearing && c.nextHearing >= t && dayDiff(t, c.nextHearing) <= 15)
              .sort((a, b) => a.nextHearing.localeCompare(b.nextHearing)).map((c) => (
                <div className="hearing" key={c.id} onClick={() => go("cases", null, { kind: "case", id: c.id })}>
                  <span className={`hd ${c.nextHearing === t ? "now" : ""}`}>{fmtDate(c.nextHearing).slice(0, 6)}</span>
                  <div><b>{c.caseNo}</b> <i className="sub">{c.title}</i>
                    <i className="sub">{c.court} · {uname(db, c.associate)} · {c.nextAction}</i></div>
                </div>
              ))}
        </Panel>
      </div>

      <div className="two">
        <Panel title="Tasks by status"><Bars data={byStatus} /></Panel>
        <Panel title="Overdue ageing"><Bars data={ageing} /></Panel>
      </div>
      <Panel title="Open tasks by employee">{byEmp.length ? <Bars data={byEmp} /> : <Empty>No open tasks.</Empty>}</Panel>

      <Panel title="11:30 AM reminder run" sub="In the live build these go out automatically by email and WhatsApp at 11:30. This prototype shows exactly who would receive one and why — nothing is actually sent.">
        {reminderQueue.length === 0 ? <Empty>No one is due a reminder — everyone has checked in and updated.</Empty> :
          reminderQueue.map(({ u, miss }) => (
            <div className="leave-row" key={u.id}>
              <div>
                <b>{u.name}</b>
                <i className="sub">To: {u.email !== PENDING ? u.email : "email pending"} · WhatsApp: {u.mobile !== PENDING ? u.mobile : "number pending"}</i>
                <i className="sub">"You have {miss.join("; ")}. Please update immediately."</i>
              </div>
              {(u.email === PENDING && u.mobile === PENDING) && <Badge t="red">No contact on file</Badge>}
            </div>
          ))}
      </Panel>

      <Panel title="Daily owner summary" sub={`Would be emailed to ${db.settings.ownerEmail} each evening`}
        right={<Btn onClick={() => { navigator.clipboard?.writeText(summaryText()); flash("Summary copied"); }}>Copy</Btn>}>
        <pre className="summary">{summaryText()}</pre>
      </Panel>
    </>
  );
}

/* ============================ STAFF DASHBOARD ============================ */
function StaffDash({ db, user, go, commit, flash }) {
  const t = today();
  const mine = db.tasks.filter((x) => x.assignedTo === user.id);
  const a = attFor(db, user.id, t);
  const myCases = db.cases.filter((c) => c.associate === user.id);
  const [modal, setModal] = useState(null);

  return (
    <>
      <div className="grid-4">
        <Stat n={mine.filter((x) => x.status !== "Completed").length} label="My active tasks" t="blue" onClick={() => go("tasks")} />
        <Stat n={mine.filter((x) => x.due === t && x.status !== "Completed").length} label="Due today" t="yellow" onClick={() => go("tasks", { quick: "today" })} />
        <Stat n={mine.filter(isOverdue).length} label="Overdue" t="red" onClick={() => go("tasks", { quick: "overdue" })} />
        <Stat n={mine.filter((x) => x.status === "Completed").length} label="Completed" t="green" onClick={() => go("tasks", { status: "Completed" })} />
        {user.role === "Legal Associate" && <>
          <Stat n={myCases.filter((c) => c.stage !== "Disposed").length} label="My cases" t="blue" onClick={() => go("cases")} />
          <Stat n={myCases.filter((c) => c.nextHearing === t).length} label="Listed today" t="red" onClick={() => go("cases", { quick: "today" })} />
          <Stat n={myCases.filter((c) => c.nextHearing === addDays(t, 1)).length} label="Listed tomorrow" t="orange" onClick={() => go("cases", { quick: "tomorrow" })} />
        </>}
        <Stat n={user.leaveBalance} label="Leave balance" t="grey" onClick={() => go("leave")} />
      </div>

      <Panel title="Today" sub={a ? `Checked in at ${fmtTime(a.inTs)}${a.outTs ? ` · checked out at ${fmtTime(a.outTs)}` : ""}` : "You have not marked attendance yet"}>
        <div className="quick">
          <Btn kind="solid" onClick={() => go("attendance")}>{!a ? "Mark attendance" : a.outTs ? "View attendance" : "Check out"}</Btn>
          <Btn kind={a?.morningUpdate ? "ghost" : "brass"} onClick={() => setModal("morning")}>
            {a?.morningUpdate ? "Morning update submitted" : "Submit morning update"}
          </Btn>
          <Btn kind={a?.eveningUpdate ? "ghost" : "brass"} onClick={() => setModal("evening")}>
            {a?.eveningUpdate ? "Evening update submitted" : "Submit evening update"}
          </Btn>
          <Btn onClick={() => go("leave")}>Apply for leave</Btn>
          <Btn onClick={() => go("calendar")}>My calendar</Btn>
        </div>
        {!a && <p className="notice">Check in first — daily updates attach to the day’s attendance record.</p>}
      </Panel>

      <Panel title="My tasks" sub="In order of urgency">
        {mine.filter((x) => x.status !== "Completed").length === 0 ? <Empty>No open tasks assigned to you.</Empty> :
          mine.filter((x) => x.status !== "Completed")
            .sort((x, y) => (x.due || "9999").localeCompare(y.due || "9999"))
            .map((tk) => {
              const done = tk.subtasks.filter((s) => s.done).length;
              return (
                <div className="tcard" key={tk.id} onClick={() => go("tasks", null, { kind: "task", id: tk.id })}>
                  <div className="tcard-h">
                    <span><b>{tk.name}</b><i className="sub">{tk.ref} · {tk.entity}</i></span>
                    <Badge>{tk.status}</Badge>
                  </div>
                  <div className="tcard-m">
                    <span className={isOverdue(tk) ? "danger" : ""}>Due {fmtDate(tk.due)}{isOverdue(tk) ? ` · ${dayDiff(tk.due, t)}d overdue` : ""}</span>
                    <span>{tk.subtasks.length ? `${done}/${tk.subtasks.length} subtasks` : "No subtasks"}</span>
                    <span>{tk.updates.length} update(s)</span>
                  </div>
                </div>
              );
            })}
      </Panel>

      {user.role === "Legal Associate" && (
        <Panel title="My matters">
          {myCases.length === 0 ? <Empty>No matters assigned to you.</Empty> : myCases.map((c) => (
            <div className="tcard" key={c.id} onClick={() => go("cases", null, { kind: "case", id: c.id })}>
              <div className="tcard-h"><span><b>{c.caseNo}</b><i className="sub">{c.title}</i></span><Badge t={c.nextHearing === t ? "red" : "blue"}>{c.stage}</Badge></div>
              <div className="tcard-m"><span>{c.court}</span><span>Next hearing {fmtDate(c.nextHearing)}</span></div>
            </div>
          ))}
        </Panel>
      )}

      {modal && <DailyUpdate kind={modal} db={db} user={user} commit={commit} flash={flash} onClose={() => setModal(null)} />}
    </>
  );
}

function DailyUpdate({ kind, db, user, commit, flash, onClose }) {
  const t = today();
  const a = attFor(db, user.id, t);
  const [f, setF] = useState({ text: "", plan: "", issues: "", done: "", pending: "", next: "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!a) { flash("Mark attendance before submitting an update"); return onClose(); }
    commit((d) => {
      const rec = d.attendance.find((x) => x.id === a.id);
      if (kind === "morning") rec.morningUpdate = { ts: Date.now(), text: f.text, plan: f.plan, issues: f.issues };
      else rec.eveningUpdate = { ts: Date.now(), done: f.done, pending: f.pending, issues: f.issues, next: f.next };
    }, { by: user.name, action: `${kind === "morning" ? "Morning" : "Evening"} update submitted`, detail: "" });
    flash("Update submitted"); onClose();
  };
  return (
    <Modal title={kind === "morning" ? "Morning update" : "Evening update"} onClose={onClose}>
      {kind === "morning" ? <>
        <Field label="What you are working on today"><textarea rows={3} value={f.text} onChange={set("text")} /></Field>
        <Field label="Expected output by end of day"><textarea rows={2} value={f.plan} onChange={set("plan")} /></Field>
        <Field label="Issues or assistance required" hint="Leave blank if none"><textarea rows={2} value={f.issues} onChange={set("issues")} /></Field>
      </> : <>
        <Field label="Work completed"><textarea rows={3} value={f.done} onChange={set("done")} /></Field>
        <Field label="Work still pending"><textarea rows={2} value={f.pending} onChange={set("pending")} /></Field>
        <Field label="Delays or issues"><textarea rows={2} value={f.issues} onChange={set("issues")} /></Field>
        <Field label="Next action"><textarea rows={2} value={f.next} onChange={set("next")} /></Field>
      </>}
      <Btn kind="solid" full onClick={save}>Submit update</Btn>
    </Modal>
  );
}

/* ============================ TASKS ============================ */
function Tasks({ db, user, commit, flash, preset, focus }) {
  const isOwner = user.role === OWNER;
  const t = today();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(preset?.status ?? "");
  const [who, setWho] = useState("");
  const [quick, setQuick] = useState(preset?.quick ?? "");
  const [open, setOpen] = useState(focus?.kind === "task" ? focus.id : null);
  const [creating, setCreating] = useState(false);

  let rows = isOwner ? db.tasks : db.tasks.filter((x) => x.assignedTo === user.id);
  rows = rows.filter((x) => {
    if (status && x.status !== status) return false;
    if (who && x.assignedTo !== who) return false;
    if (quick === "overdue" && !isOverdue(x)) return false;
    if (quick === "today" && !(x.due === t && x.status !== "Completed")) return false;
    if (quick === "week" && !(x.due >= t && dayDiff(t, x.due) <= 7 && x.status !== "Completed")) return false;
    if (q) {
      const s = (x.ref + x.name + x.entity + x.desc).toLowerCase();
      if (!s.includes(q.toLowerCase())) return false;
    }
    return true;
  }).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));

  const task = db.tasks.find((x) => x.id === open);

  return (
    <>
      <Panel title={isOwner ? "Task monitoring" : "My tasks"} sub={`${rows.length} record(s)`}
        right={<Btn kind="solid" onClick={() => setCreating(true)}>Assign task</Btn>}>
        <div className="filters">
          <input placeholder="Search reference, task, property…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>{TASK_STATUS.map((s) => <option key={s}>{s}</option>)}
          </select>
          {isOwner && (
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">All employees</option>
              {[...db.users].sort((a, b) => a.name.localeCompare(b.name)).map((u) => (
                <option key={u.id} value={u.id}>{u.name} — {u.role}</option>))}
            </select>
          )}
          <select value={quick} onChange={(e) => setQuick(e.target.value)}>
            <option value="">Any due date</option><option value="overdue">Overdue</option>
            <option value="today">Due today</option><option value="week">Due this week</option>
          </select>
          {(q || status || who || quick) && <Btn onClick={() => { setQ(""); setStatus(""); setWho(""); setQuick(""); }}>Clear</Btn>}
        </div>
        {rows.length === 0 ? <Empty>No tasks match these filters. Clear them to see everything.</Empty> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Ref</th><th>Task</th><th>Property / company</th><th>Assigned to</th><th>Due</th><th>Status</th><th>Progress</th><th>Last update</th><th></th></tr></thead>
              <tbody>
                {rows.map((x) => {
                  const done = x.subtasks.filter((s) => s.done).length;
                  return (
                    <tr key={x.id} className={isOverdue(x) ? "row-danger" : ""}>
                      <td className="mono">{x.ref}</td>
                      <td><b>{x.name}</b>{x.extension?.status === "Pending" && <i className="sub warn">Extension requested → {fmtDate(x.extension.newDate)}</i>}</td>
                      <td>{x.entity}</td>
                      <td>{uname(db, x.assignedTo)}<i className="sub">{urole(db, x.assignedTo)}</i></td>
                      <td>{fmtDate(x.due)}{isOverdue(x) && <i className="sub danger">{dayDiff(x.due, t)}d overdue</i>}</td>
                      <td><Badge>{x.status}</Badge></td>
                      <td className="mono">{x.subtasks.length ? `${done}/${x.subtasks.length}` : "—"}</td>
                      <td>{x.updates.length ? fmtStamp(x.updates[0].ts) : "No updates"}</td>
                      <td><Btn onClick={() => setOpen(x.id)}>Open</Btn></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {task && <TaskDetail task={task} db={db} user={user} commit={commit} flash={flash} onClose={() => setOpen(null)} />}
      {creating && <AssignTask db={db} user={user} commit={commit} flash={flash} onClose={() => setCreating(false)} />}
    </>
  );
}

function TaskDetail({ task, db, user, commit, flash, onClose }) {
  const isOwner = user.role === OWNER;
  const mine = task.assignedTo === user.id;
  const locked = task.status === "Completed" && !isOwner;
  const [txt, setTxt] = useState("");
  const [sub, setSub] = useState("");
  const [subDate, setSubDate] = useState(task.due || today());
  const [ext, setExt] = useState({ on: false, date: "", reason: "" });
  const [edit, setEdit] = useState({ on: false, name: task.name, entity: task.entity, due: task.due, assignedTo: task.assignedTo });

  const mutate = (fn, action) => commit((d) => fn(d.tasks.find((x) => x.id === task.id), d), { by: user.name, action, detail: task.ref });

  const addUpdate = (text) => {
    if (!text.trim()) return;
    mutate((tk) => tk.updates.unshift({ ts: Date.now(), by: user.name, text }), "Task update added");
    flash("Update added");
  };
  const setStatus = (s) => { mutate((tk) => { tk.status = s; }, `Task status set to ${s}`); flash(`Status set to ${s}`); };
  const toggleSub = (id) => mutate((tk) => { const s = tk.subtasks.find((y) => y.id === id); s.done = !s.done; }, "Subtask updated");
  const addSub = () => {
    if (!sub.trim()) return;
    mutate((tk) => tk.subtasks.push({ id: uid("s"), name: sub, due: subDate, done: false }), "Subtask added");
    setSub("");
  };
  const addPhoto = async (img) => {
    if (!img) return flash("The photo could not be read");
    const g = await getGPS();
    mutate((tk) => tk.docs.unshift({ ts: Date.now(), by: user.name, img, lat: g.lat, lng: g.lng }), "Photo attached");
    flash(g.lat != null ? "Photo attached with GPS, date and time" : "Photo attached — GPS unavailable, time recorded");
  };
  const requestExt = () => {
    if (!ext.date) return flash("Choose a new completion date");
    mutate((tk) => {
      tk.extension = { requested: Date.now(), newDate: ext.date, reason: ext.reason, status: "Pending" };
      tk.status = "Delaying Completion Date";
    }, "Extension requested");
    setExt({ on: false, date: "", reason: "" }); flash("Extension request sent to the Owner");
  };
  const decideExt = (ok) => {
    mutate((tk) => {
      tk.extension.status = ok ? "Approved" : "Rejected";
      if (ok) { tk.origDue = tk.origDue || tk.due; tk.due = tk.extension.newDate; }
    }, `Extension ${ok ? "approved" : "rejected"}`);
    flash(`Extension ${ok ? "approved" : "rejected"}`);
  };
  const saveEdit = () => {
    if (!edit.name.trim() || !edit.entity.trim()) return flash("Task name and property/company are required");
    mutate((tk, d) => {
      tk.name = edit.name; tk.entity = edit.entity; tk.due = edit.due; tk.assignedTo = edit.assignedTo;
      learn(d, "entities", edit.entity);
    }, "Task edited by Owner");
    setEdit({ ...edit, on: false }); flash("Task details updated");
  };

  return (
    <Modal title={`${task.ref} — ${task.name}`} onClose={onClose} wide>
      <div className="kv">
        <div><span>Property / company</span><b>{task.entity}</b></div>
        <div><span>Assigned to</span><b>{uname(db, task.assignedTo)} — {urole(db, task.assignedTo)}</b></div>
        <div><span>Assigned by</span><b>{uname(db, task.assignedBy)}</b></div>
        <div><span>Started</span><b>{fmtDate(task.start)}</b></div>
        <div><span>Completion date</span><b>{fmtDate(task.due)}{task.origDue && <i className="sub">was {fmtDate(task.origDue)}</i>}</b></div>
        <div><span>Status</span><b><Badge>{task.status}</Badge></b></div>
      </div>
      {task.desc && <p className="desc">{task.desc}</p>}

      {task.extension?.status === "Pending" && (
        <div className="callout">
          <b>Extension requested</b> to {fmtDate(task.extension.newDate)} — {task.extension.reason || "no reason given"}
          {isOwner && <span className="callout-a"><Btn kind="solid" onClick={() => decideExt(true)}>Approve</Btn><Btn onClick={() => decideExt(false)}>Reject</Btn></span>}
        </div>
      )}

      {!locked && (
        <div className="statusbar">
          {TASK_STATUS.map((s) => (
            <button key={s} className={`chip${task.status === s ? " on" : ""}`} onClick={() => setStatus(s)}>{s}</button>
          ))}
        </div>
      )}
      {task.status === "Completed" && isOwner &&
        <p className="notice">This task is completed. Only you can reopen it — pick another status above.</p>}

      {isOwner && (
        <>
          {!edit.on ? <Btn onClick={() => setEdit({ ...edit, on: true })}>Edit task details</Btn> : (
            <div className="ext">
              <Field label="Task name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <SmartSelect label="Property / company" value={edit.entity} onChange={(v) => setEdit({ ...edit, entity: v })} options={db.masters.entities} />
              <div className="row2">
                <Field label="Completion date"><input type="date" value={edit.due} onChange={(e) => setEdit({ ...edit, due: e.target.value })} /></Field>
                <Field label="Reassign to">
                  <select value={edit.assignedTo} onChange={(e) => setEdit({ ...edit, assignedTo: e.target.value })}>
                    {[...db.users].filter((u) => u.status === "Active").sort((a, b) => a.name.localeCompare(b.name))
                      .map((u) => <option key={u.id} value={u.id}>{u.name} — {u.role}</option>)}
                  </select>
                </Field>
              </div>
              <Btn kind="solid" onClick={saveEdit}>Save changes</Btn>
            </div>
          )}
        </>
      )}

      <h4>Subtasks</h4>
      {task.subtasks.length === 0 && <Empty>No subtasks yet. Break the work down if it runs over several days.</Empty>}
      {task.subtasks.map((s) => (
        <label className="subt" key={s.id}>
          <input type="checkbox" checked={s.done} disabled={locked} onChange={() => toggleSub(s.id)} />
          <span className={s.done ? "struck" : ""}>{s.name}</span>
          {s.due && <span className={`subt-due${!s.done && s.due < today() ? " danger" : ""}`}>due {fmtDate(s.due)}</span>}
        </label>
      ))}
      {!locked && (
        <div className="inline">
          <input placeholder="Add a subtask" value={sub} onChange={(e) => setSub(e.target.value)} />
          <input type="date" value={subDate} onChange={(e) => setSubDate(e.target.value)} style={{ maxWidth: 150 }} />
          <Btn onClick={addSub}>Add</Btn>
        </div>
      )}

      <h4>Photos with GPS</h4>
      {task.docs.length === 0 ? <Empty>No photographs attached to this task.</Empty> : (
        <div className="thumbs">
          {task.docs.map((d, i) => (
            <figure key={i}>
              <img src={d.img} alt={`Attached by ${d.by}`} className="thumb-lg" />
              <figcaption>{d.by} · {fmtStamp(d.ts)}<br />{d.lat != null ? `GPS ${d.lat.toFixed(4)}, ${d.lng.toFixed(4)}` : "GPS not captured"}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {!locked && <CameraButton label="Add photo — GPS, date and time are stamped automatically" onShot={addPhoto} />}

      <h4>Progress updates</h4>
      {!locked && <>
        <VoiceNote flash={flash} onText={(t) => addUpdate("Voice note (transcribed): " + t)} />
        <div className="inline">
          <textarea rows={2} placeholder="What changed since the last update?" value={txt} onChange={(e) => setTxt(e.target.value)} />
          <Btn kind="solid" onClick={() => { addUpdate(txt); setTxt(""); }}>Post</Btn>
        </div>
      </>}
      {task.updates.length === 0 ? <Empty>No updates recorded against this task.</Empty> : (
        <ul className="feed">{task.updates.map((u, i) => (
          <li key={i}><span className="feed-m">{u.by} · {fmtStamp(u.ts)}</span>{u.text}</li>))}
        </ul>
      )}

      {mine && !locked && (
        <>
          <h4>Completion date</h4>
          {!ext.on ? <Btn onClick={() => setExt({ ...ext, on: true })}>Request a new completion date</Btn> : (
            <div className="ext">
              <Field label="Proposed date"><input type="date" value={ext.date} onChange={(e) => setExt({ ...ext, date: e.target.value })} /></Field>
              <Field label="Reason"><input value={ext.reason} onChange={(e) => setExt({ ...ext, reason: e.target.value })} /></Field>
              <Btn kind="solid" onClick={requestExt}>Send request</Btn>
            </div>
          )}
        </>
      )}
      {locked && <p className="notice">This task is completed and is now read-only for staff. Only the Owner can reopen it or change its status.</p>}
    </Modal>
  );
}

function AssignTask({ db, user, commit, flash, onClose }) {
  const [f, setF] = useState({ entity: "", name: "", desc: "", assignedTo: "", start: today(), due: addDays(today(), 3) });
  const [subs, setSubs] = useState([]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!f.entity.trim()) return flash("Property / company is required");
    if (!f.name.trim()) return flash("Task name is required");
    if (!f.assignedTo) return flash("Choose who the task is allocated to");
    const ref = "TSK-" + pad(db.tasks.length + 1);
    commit((d) => {
      learn(d, "entities", f.entity);
      d.tasks.push({
        id: uid("t"), ref, ...f, priority: "Medium", assignedBy: user.id, created: today(), status: "Not Started",
        subtasks: subs.filter((s) => s.name.trim()).map((s) => ({ id: uid("s"), name: s.name.trim(), due: s.due, done: false })),
        updates: [], comments: [], docs: [], extension: null,
      });
    }, { by: user.name, action: "Task assigned", detail: `${ref} to ${uname(db, f.assignedTo)}` });
    flash(`${ref} assigned to ${uname(db, f.assignedTo)}`); onClose();
  };
  return (
    <Modal title="Assign a task" onClose={onClose}>
      <SmartSelect label="Property / company (required)" value={f.entity} onChange={(v) => setF({ ...f, entity: v })}
        options={db.masters.entities} hint="Anything added under Others appears in this list next time." />
      <Field label="Task name (required)"><input value={f.name} onChange={set("name")} placeholder="e.g. Collect encumbrance certificate" /></Field>
      <Field label="Task description (optional)"><textarea rows={3} value={f.desc} onChange={set("desc")} /></Field>
      <Field label="Task allocated to (required)">
        <select value={f.assignedTo} onChange={set("assignedTo")}>
          <option value="">Select an employee</option>
          {[...db.users].filter((u) => u.status === "Active").sort((a, b) => a.name.localeCompare(b.name))
            .map((u) => <option key={u.id} value={u.id}>{u.name} — {u.role}</option>)}
        </select>
      </Field>
      <div className="row2">
        <Field label="Start date" hint="Defaults to today"><input type="date" value={f.start} onChange={set("start")} /></Field>
        <Field label="Completion date"><input type="date" value={f.due} onChange={set("due")} /></Field>
      </div>
      <h4>Subtasks with their own completion dates (optional)</h4>
      {subs.map((s, i) => (
        <div className="row2" key={i}>
          <Field label={`Subtask ${i + 1}`}>
            <input value={s.name} onChange={(e) => setSubs(subs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          </Field>
          <Field label="Completion date">
            <input type="date" value={s.due} onChange={(e) => setSubs(subs.map((x, j) => (j === i ? { ...x, due: e.target.value } : x)))} />
          </Field>
        </div>
      ))}
      <div className="quick" style={{ marginBottom: 14 }}>
        <Btn onClick={() => setSubs([...subs, { name: "", due: f.due }])}>Add a subtask</Btn>
        {subs.length > 0 && <Btn onClick={() => setSubs(subs.slice(0, -1))}>Remove last</Btn>}
      </div>
      <Btn kind="solid" full onClick={save}>Assign task</Btn>
    </Modal>
  );
}

/* ============================ ATTENDANCE ============================ */
function Attendance({ db, user, commit, flash }) {
  const isOwner = user.role === OWNER;
  const t = today();
  const [date, setDate] = useState(t);
  const [busy, setBusy] = useState(false);
  const me = attFor(db, user.id, t);
  const loc = db.locations.find((l) => l.id === user.locationId) || db.locations[0];

  const punch = async (kind, mode, photo) => {
    if (!photo) return flash("A photograph is compulsory for attendance — the camera shot did not come through");
    setBusy(true);
    const g = await getGPS();
    const dist = g.lat != null ? haversine(g.lat, g.lng, loc.lat, loc.lng) : null;
    commit((d) => {
      let rec = d.attendance.find((a) => a.userId === user.id && a.date === t);
      if (kind === "in") {
        if (rec) return;
        d.attendance.push({
          id: uid("a"), userId: user.id, date: t, mode, inTs: Date.now(), inLat: g.lat, inLng: g.lng,
          inDist: dist, inPhoto: photo, outTs: null, outPhoto: null, morningUpdate: null, eveningUpdate: null, gpsError: g.err,
        });
      } else if (rec) { rec.outTs = Date.now(); rec.outLat = g.lat; rec.outLng = g.lng; rec.outDist = dist; rec.outPhoto = photo; }
    }, { by: user.name, action: kind === "in" ? "Checked in" : "Checked out", detail: dist != null ? `${dist} m from ${loc.name} · photo on record` : "Photo on record · location unavailable" });
    setBusy(false);
    flash(kind === "in" ? "Checked in — photo, GPS, date and time recorded" : "Checked out — photo and time recorded");
  };

  const hours = (a) => (a?.inTs && a?.outTs ? ((a.outTs - a.inTs) / 3600000).toFixed(1) + " h" : "—");
  const rows = db.users.filter((u) => u.status === "Active").map((u) => ({ u, a: attFor(db, u.id, date) }));

  return (
    <>
      <Panel title="Mark attendance" sub={`Reporting location: ${loc.name} · permitted radius ${user.radiusM} m · photo with GPS, date and time is compulsory`}>
        {!me ? (
          <>
            <div className="quick">
              <CameraButton kind="solid" label={busy ? "Saving…" : "Check in — Office (take photo)"} disabled={busy} onShot={(img) => punch("in", "Office", img)} />
              <CameraButton kind="brass" label="Check in — Site (take photo)" disabled={busy} onShot={(img) => punch("in", "Site", img)} />
            </div>
            <p className="notice">Tapping check-in opens the camera. The photo, your GPS position, and the date and time are all recorded automatically — attendance cannot be marked without the photograph.</p>
          </>
        ) : (
          <>
            <div className="kv">
              <div><span>Check-in</span><b>{fmtTime(me.inTs)} · {me.mode}</b></div>
              <div><span>Distance from location</span><b>{me.inDist != null ? `${me.inDist} m` : "Location unavailable"}</b></div>
              <div><span>Check-out</span><b>{me.outTs ? fmtTime(me.outTs) : "Pending"}</b></div>
              <div><span>Hours</span><b>{hours(me)}</b></div>
            </div>
            <div className="thumbs">
              {me.inPhoto && <figure><img src={me.inPhoto} className="thumb-lg" alt="Check-in" /><figcaption>Check-in · {fmtStamp(me.inTs)}</figcaption></figure>}
              {me.outPhoto && <figure><img src={me.outPhoto} className="thumb-lg" alt="Check-out" /><figcaption>Check-out · {fmtStamp(me.outTs)}</figcaption></figure>}
            </div>
            {me.gpsError && <p className="notice">Location was not captured: {me.gpsError}. The Owner will see this as an unverified check-in.</p>}
            {me.inDist != null && me.inDist > user.radiusM && me.mode === "Office" &&
              <p className="notice warnbox">You are {me.inDist} m from {loc.name}, outside the permitted {user.radiusM} m radius. This is flagged to the Owner.</p>}
            {!me.outTs && <CameraButton kind="solid" label={busy ? "Saving…" : "Check out (take photo)"} disabled={busy} onShot={(img) => punch("out", null, img)} />}
          </>
        )}
      </Panel>

      {isOwner && (
        <Panel title="Attendance monitoring" sub={`${fmtDate(date)} · tap a photo to verify the face — a missing photo is flagged in alerts`}
          right={<input type="date" value={date} onChange={(e) => setDate(e.target.value)} />}>
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Role</th><th>Status</th><th>In</th><th>Photo</th><th>Distance</th><th>Out</th><th>Hours</th><th>Morning</th><th>Evening</th></tr></thead>
              <tbody>
                {rows.filter(({ u }) => u.role !== OWNER).map(({ u, a }) => {
                  const onLeave = db.leaves.some((l) => l.userId === u.id && l.status === "Approved" && l.from <= date && l.to >= date);
                  const late = a?.inTs && minsSinceMidnight(a.inTs) > hhmmToMins(u.workStart) + u.graceMins;
                  const status = onLeave ? "On Leave" : !a ? "Absent" : late ? "Late" : "Present";
                  return (
                    <tr key={u.id}>
                      <td><b>{u.name}</b></td><td>{u.role}</td>
                      <td><Badge>{status}</Badge>{a && !a.outTs && date === t && <i className="sub">Check-out pending</i>}</td>
                      <td>{fmtTime(a?.inTs)}</td>
                      <td>{a?.inPhoto ? <img src={a.inPhoto} className="thumb" alt={`${u.name} check-in`} /> : a ? <Badge t="red">Missing</Badge> : "—"}</td>
                      <td className={a && a.inDist > u.radiusM && a.mode === "Office" ? "danger" : ""}>
                        {a?.inDist != null ? `${a.inDist} m` : a ? "Not captured" : "—"}{a?.mode === "Site" ? " (site)" : ""}
                      </td>
                      <td>{fmtTime(a?.outTs)}</td><td>{hours(a)}</td>
                      <td>{a?.morningUpdate ? <Badge t="green">Yes</Badge> : <Badge t="red">No</Badge>}</td>
                      <td>{a?.eveningUpdate ? <Badge t="green">Yes</Badge> : <Badge t="grey">No</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="My recent attendance">
        {db.attendance.filter((a) => a.userId === user.id).length === 0 ? <Empty>No attendance recorded yet.</Empty> : (
          <table className="tbl">
            <thead><tr><th>Date</th><th>In</th><th>Out</th><th>Hours</th><th>Mode</th></tr></thead>
            <tbody>{db.attendance.filter((a) => a.userId === user.id).sort((a, b) => b.date.localeCompare(a.date)).map((a) => (
              <tr key={a.id}><td>{fmtDate(a.date)}</td><td>{fmtTime(a.inTs)}</td><td>{fmtTime(a.outTs)}</td><td>{hours(a)}</td><td>{a.mode}</td></tr>))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

/* ============================ LEAVE ============================ */
function Leave({ db, user, commit, flash }) {
  const isOwner = user.role === OWNER;
  const [f, setF] = useState({ type: "Casual", from: today(), to: today(), reason: "", detail: "", docImg: null });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const apply = () => {
    if (!f.reason.trim()) return flash("Choose a reason for the leave");
    const days = dayDiff(f.from, f.to) + 1;
    if (days < 1) return flash("The end date cannot be before the start date");
    commit((d) => {
      learn(d, "leaveReasons", f.reason);
      d.leaves.unshift({
        id: uid("l"), userId: user.id, type: f.type, from: f.from, to: f.to,
        reason: f.reason + (f.detail ? ` — ${f.detail}` : ""), days,
        doc: Boolean(f.docImg), docImg: f.docImg, status: "Pending", applied: Date.now(),
      });
    }, { by: user.name, action: "Leave applied", detail: `${f.type} ${f.from}–${f.to}` });
    setF({ type: "Casual", from: today(), to: today(), reason: "", detail: "", docImg: null });
    flash("Leave request submitted to the Owner");
  };
  const decide = (id, ok) => {
    commit((d) => {
      const l = d.leaves.find((x) => x.id === id);
      l.status = ok ? "Approved" : "Rejected"; l.decidedBy = user.name; l.decidedTs = Date.now();
      if (ok) { const u = d.users.find((x) => x.id === l.userId); u.leaveBalance = Math.max(0, u.leaveBalance - l.days); }
    }, { by: user.name, action: `Leave ${ok ? "approved" : "rejected"}`, detail: id });
    flash(`Leave ${ok ? "approved" : "rejected"}`);
  };
  const mine = db.leaves.filter((l) => l.userId === user.id);
  const pending = db.leaves.filter((l) => l.status === "Pending");

  return (
    <>
      {isOwner && (
        <Panel title="Leave approvals" sub={`${pending.length} request(s) awaiting your decision`}>
          {pending.length === 0 ? <Empty>No leave requests are waiting on you.</Empty> : pending.map((l) => (
            <div className="leave-row" key={l.id}>
              <div>
                <b>{uname(db, l.userId)}</b>
                <i className="sub">{l.type} · {fmtDate(l.from)} – {fmtDate(l.to)} · {l.days} day(s)</i>
                <i className="sub">{l.reason}</i>
                {l.type === "Medical" && !l.doc && <i className="sub danger">No prescription attached</i>}
                {l.docImg && <img src={l.docImg} className="thumb-lg" alt="Supporting document" style={{ marginTop: 6 }} />}
              </div>
              <div className="leave-a"><Btn kind="solid" onClick={() => decide(l.id, true)}>Approve</Btn><Btn onClick={() => decide(l.id, false)}>Reject</Btn></div>
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Apply for leave" sub={`Your balance: ${user.leaveBalance} day(s)`}>
        <div className="row2">
          <Field label="Type"><select value={f.type} onChange={set("type")}><option>Casual</option><option>Medical</option><option>Earned</option><option>Loss of pay</option></select></Field>
          <Field label="Days"><input readOnly value={Math.max(0, dayDiff(f.from, f.to) + 1)} /></Field>
        </div>
        <div className="row2">
          <Field label="From"><input type="date" value={f.from} onChange={set("from")} /></Field>
          <Field label="To"><input type="date" value={f.to} onChange={set("to")} /></Field>
        </div>
        <SmartSelect label="Reason" value={f.reason} onChange={(v) => setF({ ...f, reason: v })}
          options={db.masters.leaveReasons} hint="Anything added under Others joins this list next time." />
        <Field label="Additional details (optional)"><textarea rows={2} value={f.detail} onChange={set("detail")} /></Field>
        {f.type === "Medical" && (
          <>
            <CameraButton label={f.docImg ? "Retake prescription photo" : "Attach prescription photo"} onShot={(img) => { setF({ ...f, docImg: img }); flash("Prescription attached"); }} />
            {f.docImg ? <div className="thumbs"><figure><img src={f.docImg} className="thumb-lg" alt="Prescription" /><figcaption>Attached prescription</figcaption></figure></div>
              : <p className="fhint" style={{ marginTop: 8 }}>Medical leave without a prescription is flagged to the Owner as missing a supporting document.</p>}
          </>
        )}
        <Btn kind="solid" full onClick={apply}>Submit request</Btn>
      </Panel>
      <Panel title={isOwner ? "All leave records" : "My leave history"}>
        {(isOwner ? db.leaves : mine).length === 0 ? <Empty>No leave records.</Empty> : (
          <table className="tbl">
            <thead><tr>{isOwner && <th>Employee</th>}<th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th></tr></thead>
            <tbody>{(isOwner ? db.leaves : mine).map((l) => (
              <tr key={l.id}>{isOwner && <td>{uname(db, l.userId)}</td>}<td>{l.type}</td><td>{fmtDate(l.from)}</td><td>{fmtDate(l.to)}</td>
                <td>{l.days}</td><td><Badge>{l.status}</Badge></td></tr>))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

/* ============================ LEGAL CASES ============================ */
function Cases({ db, user, commit, flash, preset, focus }) {
  const isOwner = user.role === OWNER;
  const t = today();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [quick, setQuick] = useState(preset?.quick ?? "");
  const [open, setOpen] = useState(focus?.kind === "case" ? focus.id : null);
  const [creating, setCreating] = useState(false);

  let rows = isOwner ? db.cases : db.cases.filter((c) => c.associate === user.id);
  rows = rows.filter((c) => {
    if (stage && c.stage !== stage) return false;
    if (quick === "today" && c.nextHearing !== t) return false;
    if (quick === "tomorrow" && c.nextHearing !== addDays(t, 1)) return false;
    if (quick === "week" && !(c.nextHearing >= t && dayDiff(t, c.nextHearing) <= 7)) return false;
    if (quick === "nodate" && c.nextHearing) return false;
    if (q && !(c.caseNo + c.title + c.court + c.type).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }).sort((a, b) => (a.nextHearing || "9999").localeCompare(b.nextHearing || "9999"));
  const cs = db.cases.find((c) => c.id === open);

  return (
    <>
      <Panel title="Legal cases" sub={`${rows.length} matter(s)`} right={isOwner && <Btn kind="solid" onClick={() => setCreating(true)}>Add case</Btn>}>
        <div className="filters">
          <input placeholder="Search case number, title, court…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">All stages</option>{CASE_STAGE.map((s) => <option key={s}>{s}</option>)}</select>
          <select value={quick} onChange={(e) => setQuick(e.target.value)}>
            <option value="">Any hearing date</option><option value="today">Listed today</option>
            <option value="tomorrow">Listed tomorrow</option><option value="week">Next 7 days</option>
            <option value="nodate">No next hearing date</option>
          </select>
        </div>
        {rows.length === 0 ? <Empty>No matters match these filters.</Empty> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Case no.</th><th>Title</th><th>Court</th><th>Associate</th><th>Stage</th><th>Next hearing</th><th>Next action</th><th></th></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id} className={c.nextHearing === t ? "row-danger" : ""}>
                  <td className="mono">{c.caseNo}</td>
                  <td><b>{c.title}</b><i className="sub">{c.type}</i></td>
                  <td>{c.court}</td><td>{uname(db, c.associate)}</td>
                  <td><Badge t={c.stage === "Disposed" ? "grey" : "blue"}>{c.stage}</Badge></td>
                  <td>{c.nextHearing ? fmtDate(c.nextHearing) : <Badge t="orange">Not entered</Badge>}</td>
                  <td>{c.nextAction}</td>
                  <td><Btn onClick={() => setOpen(c.id)}>Open</Btn></td>
                </tr>))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {cs && <CaseDetail c={cs} db={db} user={user} commit={commit} flash={flash} onClose={() => setOpen(null)} />}
      {creating && <AddCase db={db} user={user} commit={commit} flash={flash} onClose={() => setCreating(false)} />}
    </>
  );
}

function CaseDetail({ c, db, user, commit, flash, onClose }) {
  const [f, setF] = useState({
    text: "", stage: c.stage, nextHearing: c.nextHearing || "", nextAction: c.nextAction || "",
    orderCopy: c.orderCopy, orderFiles: c.orderFiles || [],
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const stageOptions = [...new Set([...CASE_STAGE, ...db.masters.caseStages])];
  const save = () => {
    if (!f.text.trim()) return flash("Record what happened in court");
    commit((d) => {
      const x = d.cases.find((y) => y.id === c.id);
      x.updates.unshift({ ts: Date.now(), by: user.name, text: f.text, stage: f.stage, nextHearing: f.nextHearing, nextAction: f.nextAction });
      x.lastHearing = today(); x.stage = f.stage; x.nextHearing = f.nextHearing;
      x.nextAction = f.nextAction; x.orderCopy = f.orderCopy || f.orderFiles.length > 0; x.orderFiles = f.orderFiles;
      learn(d, "caseStages", f.stage); learn(d, "nextActions", f.nextAction);
    }, { by: user.name, action: "Case updated", detail: c.caseNo });
    flash("Case updated — the Owner's calendar entry moves with the new hearing date");
    setF({ ...f, text: "" });
  };
  const attachOrder = (e) => {
    const fl = e.target.files[0];
    if (!fl) return;
    setF({ ...f, orderFiles: [...f.orderFiles, `${fl.name} · attached ${fmtStamp(Date.now())}`], orderCopy: true });
    e.target.value = "";
  };
  return (
    <Modal title={`${c.caseNo} — ${c.title}`} onClose={onClose} wide>
      <div className="kv">
        <div><span>Court</span><b>{c.court}</b></div>
        <div><span>Bench / judge</span><b>{c.bench} · {c.judge}</b></div>
        <div><span>Type / sections</span><b>{c.type} · {c.sections}</b></div>
        <div><span>Petitioner</span><b>{c.petitioner}</b></div>
        <div><span>Respondent</span><b>{c.respondent}</b></div>
        <div><span>Counsel</span><b>{c.counsel}</b></div>
        <div><span>Associate</span><b>{uname(db, c.associate)}</b></div>
        <div><span>Last hearing</span><b>{fmtDate(c.lastHearing)}</b></div>
        <div><span>Next hearing</span><b>{c.nextHearing ? fmtDate(c.nextHearing) : "Not entered"}</b></div>
        <div><span>Filing deadline</span><b>{c.filingDeadline ? fmtDate(c.filingDeadline) : "—"}</b></div>
        <div><span>Order copy</span><b>{c.orderCopy ? "On record" : "Not uploaded"}</b></div>
        <div><span>Risk</span><b>{c.risk}</b></div>
      </div>
      {(c.orderFiles || []).length > 0 && (
        <><h4>Order copies on record</h4>
          <ul className="feed">{c.orderFiles.map((n, i) => <li key={i}>{n}</li>)}</ul></>
      )}

      <h4>Add a case update</h4>
      <VoiceNote flash={flash} onText={(t) => setF({ ...f, text: (f.text ? f.text + " " : "") + t })} />
      <Field label="What happened today"><textarea rows={3} value={f.text} onChange={set("text")} placeholder="Order passed / adjourned / counter filed…" /></Field>
      <div className="row2">
        <SmartSelect label="Current status of the matter" value={f.stage} onChange={(v) => setF({ ...f, stage: v })} options={stageOptions} />
        <Field label="Next hearing date"><input type="date" value={f.nextHearing} onChange={set("nextHearing")} /></Field>
      </div>
      <SmartSelect label="Next course of action" value={f.nextAction} onChange={(v) => setF({ ...f, nextAction: v })}
        options={db.masters.nextActions} hint="Discussion, Conference, Briefing, Appearance — or add your own under Others." />
      <Field label="Attach current order copy" hint="In this prototype the file name and time are recorded, not the file itself.">
        <input type="file" onChange={attachOrder} />
      </Field>
      {f.orderFiles.length > (c.orderFiles || []).length &&
        <p className="fhint">{f.orderFiles.length - (c.orderFiles || []).length} new file(s) will be recorded when you save.</p>}
      <Btn kind="solid" full onClick={save}>Save case update</Btn>

      <h4>Case history</h4>
      {c.updates.length === 0 ? <Empty>No updates recorded on this matter yet.</Empty> : (
        <ul className="feed">{c.updates.map((u, i) => (
          <li key={i}><span className="feed-m">{u.by} · {fmtStamp(u.ts)} · {u.stage}{u.nextAction ? ` · ${u.nextAction}` : ""}</span>{u.text}
            {u.nextHearing && <i className="sub">Next hearing set to {fmtDate(u.nextHearing)}</i>}</li>))}
        </ul>
      )}
    </Modal>
  );
}

function AddCase({ db, user, commit, flash, onClose }) {
  const [f, setF] = useState({
    title: "", caseNo: "", type: "", court: "", bench: "", judge: "", sections: "", petitioner: "", respondent: "",
    counsel: "", associate: "", entity: "", stage: "Appearance Stage", status: "", lastHearing: "", nextHearing: "",
    nextAction: "", filingDeadline: "", briefingDate: "", conferenceDate: "", priority: "Medium", risk: "Medium",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!f.caseNo.trim() || !f.title.trim() || !f.associate) return flash("Case number, title and associate are required");
    const ref = "CASE-" + pad(db.cases.length + 1);
    commit((d) => {
      learn(d, "courts", f.court); learn(d, "judges", f.judge); learn(d, "counsels", f.counsel);
      learn(d, "sections", f.sections); learn(d, "entities", f.entity);
      d.cases.push({ id: uid("c"), ref, ...f, orderCopy: false, orderFiles: [], updates: [] });
    }, { by: user.name, action: "Case added", detail: f.caseNo });
    flash(`${f.caseNo} added`); onClose();
  };
  return (
    <Modal title="Add a legal case" onClose={onClose} wide>
      <div className="row2">
        <Field label="Case number"><input value={f.caseNo} onChange={set("caseNo")} placeholder="OS 214/2024" /></Field>
        <Field label="Case type"><input value={f.type} onChange={set("type")} /></Field>
      </div>
      <Field label="Case title"><input value={f.title} onChange={set("title")} /></Field>
      <SmartSelect label="Court" value={f.court} onChange={(v) => setF({ ...f, court: v })} options={db.masters.courts} />
      <div className="row2">
        <SmartSelect label="Judge" value={f.judge} onChange={(v) => setF({ ...f, judge: v })} options={db.masters.judges} />
        <Field label="Bench"><input value={f.bench} onChange={set("bench")} /></Field>
      </div>
      <SmartSelect label="Applicable sections" value={f.sections} onChange={(v) => setF({ ...f, sections: v })} options={db.masters.sections} />
      <div className="row2">
        <Field label="Petitioner"><input value={f.petitioner} onChange={set("petitioner")} /></Field>
        <Field label="Respondent"><input value={f.respondent} onChange={set("respondent")} /></Field>
      </div>
      <SmartSelect label="Counsel" value={f.counsel} onChange={(v) => setF({ ...f, counsel: v })} options={db.masters.counsels} />
      <SmartSelect label="Property or company" value={f.entity} onChange={(v) => setF({ ...f, entity: v })} options={db.masters.entities} />
      <Field label="Legal associate responsible">
        <select value={f.associate} onChange={set("associate")}>
          <option value="">Select</option>
          {db.users.filter((u) => u.role === "Legal Associate").sort((a, b) => a.name.localeCompare(b.name))
            .map((u) => <option key={u.id} value={u.id}>{u.name} — {u.role}</option>)}
        </select>
      </Field>
      <div className="row2">
        <Field label="Stage"><select value={f.stage} onChange={set("stage")}>{CASE_STAGE.map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Next hearing date"><input type="date" value={f.nextHearing} onChange={set("nextHearing")} /></Field>
      </div>
      <div className="row2">
        <Field label="Filing deadline"><input type="date" value={f.filingDeadline} onChange={set("filingDeadline")} /></Field>
        <Field label="Risk level"><select value={f.risk} onChange={set("risk")}><option>High</option><option>Medium</option><option>Low</option></select></Field>
      </div>
      <Field label="Next course of action"><input value={f.nextAction} onChange={set("nextAction")} /></Field>
      <Btn kind="solid" full onClick={save}>Add case</Btn>
    </Modal>
  );
}

/* ============================ CALENDAR ============================ */
function CalendarView({ db, user, go }) {
  const isOwner = user.role === OWNER;
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const first = new Date(cursor.y, cursor.m, 1);
  const startPad = (first.getDay() + 6) % 7;
  const daysIn = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysIn; d++) cells.push(iso(new Date(cursor.y, cursor.m, d)));

  const events = (date) => {
    const out = [];
    db.cases.filter((c) => c.nextHearing === date && (isOwner || c.associate === user.id))
      .forEach((c) => out.push({ t: "hearing", label: c.caseNo, id: c.id, kind: "case" }));
    db.tasks.filter((x) => x.due === date && x.status !== "Completed" && (isOwner || x.assignedTo === user.id))
      .forEach((x) => out.push({ t: "task", label: x.ref, id: x.id, kind: "task" }));
    db.leaves.filter((l) => l.status === "Approved" && l.from <= date && l.to >= date && (isOwner || l.userId === user.id))
      .forEach((l) => out.push({ t: "leave", label: uname(db, l.userId), id: l.id, kind: "leave" }));
    return out;
  };
  const shift = (n) => setCursor((c) => { const d = new Date(c.y, c.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });

  return (
    <Panel title={first.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
      sub="Hearings, task completion dates and approved leave"
      right={<><Btn onClick={() => shift(-1)}>‹</Btn><Btn onClick={() => shift(1)}>›</Btn></>}>
      <div className="cal-h">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d}>{d}</span>)}</div>
      <div className="cal">
        {cells.map((date, i) => (
          <div key={i} className={`cell${date === today() ? " now" : ""}${!date ? " blank" : ""}`}>
            {date && <>
              <span className="cell-d">{Number(date.slice(-2))}</span>
              {events(date).map((e, j) => (
                <button key={j} className={`ev e-${e.t}`} onClick={() => e.kind !== "leave" && go(e.kind === "case" ? "cases" : "tasks", null, { kind: e.kind, id: e.id })}>
                  {e.label}
                </button>
              ))}
            </>}
          </div>
        ))}
      </div>
      <div className="legend"><span className="e-hearing">Court hearing</span><span className="e-task">Task due</span><span className="e-leave">Leave</span></div>
    </Panel>
  );
}

/* ============================ ALERTS / AUDIT / DIRECTORY / REPORTS / SETTINGS ============================ */
function Alerts({ alerts, go }) {
  const groups = ["Critical", "Attention"];
  return (
    <>
      {groups.map((g) => {
        const list = alerts.filter((a) => a.sev === g);
        return (
          <Panel key={g} title={g === "Critical" ? "Critical" : "Needs attention"} sub={`${list.length} item(s)`} pad={false}>
            {list.length === 0 ? <div className="panel-b"><Empty>Nothing here.</Empty></div> : (
              <ul className="board">
                {list.map((a) => (
                  <li key={a.id} className={`board-row r-${g === "Critical" ? "red" : "orange"}`}>
                    <div className="board-main"><span className="board-type">{a.type}</span><span className="board-sub">{a.subject}</span></div>
                    <div className="board-meta"><span className="board-who">{a.who}</span><span className="board-act">{a.action}</span></div>
                    {a.ref && <Btn onClick={() => go(a.ref.kind === "task" ? "tasks" : "cases", null, a.ref)}>Open</Btn>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      })}
    </>
  );
}

function AuditLog({ db }) {
  return (
    <Panel title="Audit log" sub={`${db.audit.length} entries · newest first`}>
      <table className="tbl">
        <thead><tr><th>When</th><th>By</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>{db.audit.slice(0, 200).map((a, i) => (
          <tr key={i}><td>{fmtStamp(a.ts)}</td><td>{a.by}</td><td>{a.action}</td><td>{a.detail}</td></tr>))}
        </tbody>
      </table>
    </Panel>
  );
}

function Directory({ db, user, commit, flash }) {
  const isOwner = user.role === OWNER;
  const [edit, setEdit] = useState(null);
  const [adding, setAdding] = useState(false);
  const sorted = [...db.users].sort((a, b) => (a.role === OWNER ? -1 : b.role === OWNER ? 1 : a.name.localeCompare(b.name)));
  return (
    <>
      <Panel title="Employee directory" sub={`${db.users.length} people`} right={isOwner && <Btn kind="solid" onClick={() => setAdding(true)}>Add user</Btn>}>
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Email</th><th>Mobile</th><th>Status</th>{isOwner && <th></th>}</tr></thead>
            <tbody>{sorted.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b><i className="sub mono">{u.empCode || u.id}</i></td><td>{u.role}</td><td>{u.dept}</td>
                <td className={u.email === PENDING ? "muted" : ""}>{u.email}</td>
                <td className={u.mobile === PENDING ? "muted" : ""}>{u.mobile}</td>
                <td><Badge t={u.status === "Active" ? "green" : "grey"}>{u.status}</Badge>{u.locked && <Badge t="red">Locked</Badge>}</td>
                {isOwner && <td><Btn onClick={() => setEdit(u.id)}>Manage</Btn></td>}
              </tr>))}
            </tbody>
          </table>
        </div>
      </Panel>
      {edit && <EditUser u={db.users.find((x) => x.id === edit)} db={db} user={user} commit={commit} flash={flash} onClose={() => setEdit(null)} />}
      {adding && <AddUser db={db} user={user} commit={commit} flash={flash} onClose={() => setAdding(false)} />}
    </>
  );
}

function EditUser({ u, db, user, commit, flash, onClose }) {
  const [f, setF] = useState({ ...u });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    commit((d) => {
      const x = d.users.find((y) => y.id === u.id);
      Object.assign(x, {
        mobile: f.mobile, altMobile: f.altMobile, email: f.email, role: f.role, dept: f.dept,
        designation: f.designation, workStart: f.workStart, workEnd: f.workEnd,
        graceMins: Number(f.graceMins), radiusM: Number(f.radiusM), leaveBalance: Number(f.leaveBalance),
        salary: f.salary, salaryType: f.salaryType, incentivePerHour: Number(f.incentivePerHour),
      });
    }, { by: user.name, action: "User record updated", detail: u.name });
    flash("Saved"); onClose();
  };
  const resetPin = () => {
    if (LIVE) return flash("In live mode, reset a staff PIN from the Supabase dashboard: Authentication → Users → select the user → update password (their new PIN + the app suffix — see the README)");
    commit((d) => { const x = d.users.find((y) => y.id === u.id); x.pin = "1234"; x.mustChangePin = true; x.locked = false; x.failed = 0; },
      { by: user.name, action: "PIN reset", detail: u.name });
    flash(`${u.name}'s PIN reset to 1234 — they must change it at next sign-in`);
  };
  const toggle = () => {
    commit((d) => { const x = d.users.find((y) => y.id === u.id); x.status = x.status === "Active" ? "Inactive" : "Active"; },
      { by: user.name, action: "User status changed", detail: u.name });
    flash("Status changed"); onClose();
  };
  return (
    <Modal title={`${u.name} — ${u.role}`} onClose={onClose} wide>
      <div className="row2">
        <Field label="Mobile number" hint="This is the sign-in ID"><input value={f.mobile} onChange={set("mobile")} /></Field>
        <Field label="Alternate mobile"><input value={f.altMobile} onChange={set("altMobile")} /></Field>
      </div>
      <div className="row2">
        <Field label="Official email"><input value={f.email} onChange={set("email")} /></Field>
        <Field label="Designation"><input value={f.designation} onChange={set("designation")} /></Field>
      </div>
      <div className="row2">
        <Field label="Role"><select value={f.role} onChange={set("role")}>
          {[OWNER, "Legal Associate", "Engineer", "Drawings", "Executive", "Accounts", "Payments", "Admin"].map((r) => <option key={r}>{r}</option>)}
        </select></Field>
        <Field label="Department"><input value={f.dept} onChange={set("dept")} /></Field>
      </div>
      <div className="row2">
        <Field label="Work start"><input type="time" value={f.workStart} onChange={set("workStart")} /></Field>
        <Field label="Work end"><input type="time" value={f.workEnd} onChange={set("workEnd")} /></Field>
      </div>
      <div className="row2">
        <Field label="Grace period (minutes)"><input type="number" value={f.graceMins} onChange={set("graceMins")} /></Field>
        <Field label="Attendance radius (metres)"><input type="number" value={f.radiusM} onChange={set("radiusM")} /></Field>
      </div>
      <div className="row2">
        <Field label="Leave balance (days)"><input type="number" value={f.leaveBalance} onChange={set("leaveBalance")} /></Field>
        <Field label="Extra-hours incentive (₹/hour)"><input type="number" value={f.incentivePerHour} onChange={set("incentivePerHour")} /></Field>
      </div>
      <div className="row2">
        <Field label="Salary" hint="Visible to the Owner only"><input value={f.salary} onChange={set("salary")} /></Field>
        <Field label="Salary type"><select value={f.salaryType} onChange={set("salaryType")}><option>Monthly</option><option>Daily</option><option>Contract</option></select></Field>
      </div>
      <Btn kind="solid" full onClick={save}>Save changes</Btn>
      <div className="danger-zone">
        <Btn onClick={resetPin}>Reset PIN to 1234</Btn>
        <Btn onClick={toggle}>{u.status === "Active" ? "Deactivate user" : "Reactivate user"}</Btn>
      </div>
      <h4>Recent sign-ins</h4>
      {u.logins.length === 0 ? <Empty>No sign-ins recorded.</Empty> : (
        <ul className="feed">{u.logins.slice(0, 6).map((l, i) => (
          <li key={i}><span className="feed-m">{fmtStamp(l.ts)}</span>{l.agent}</li>))}</ul>
      )}
    </Modal>
  );
}

function AddUser({ db, user, commit, flash, onClose }) {
  const [f, setF] = useState({ name: "", role: "Executive", dept: "", email: "", mobile: "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!f.name.trim()) return flash("A name is required");
    if (f.mobile && db.users.some((u) => u.mobile === f.mobile)) return flash("That mobile number is already registered");
    const empCode = "EMP" + pad(db.users.length + 1);
    const id = LIVE ? crypto.randomUUID() : empCode;
    commit((d) => d.users.push({
      id, empCode, name: f.name, role: f.role, dept: f.dept || "—", designation: f.role,
      email: f.email || PENDING, mobile: f.mobile || PENDING, altMobile: PENDING, manager: "Sushil",
      doj: today(), status: "Active", pin: "1234", mustChangePin: true, failed: 0, locked: false, logins: [],
      workStart: "09:30", workEnd: "18:30", graceMins: 15, weeklyOff: "Sunday", locationId: "LOC1",
      radiusM: 250, salary: "", salaryType: "Monthly", incentivePerHour: 0, leaveBalance: 12,
    }), { by: user.name, action: "User added", detail: f.name });
    flash(`${f.name} added with temporary PIN 1234`); onClose();
  };
  return (
    <Modal title="Add a user" onClose={onClose}>
      <Field label="Full name"><input value={f.name} onChange={set("name")} /></Field>
      <Field label="Role"><select value={f.role} onChange={set("role")}>
        {["Legal Associate", "Engineer", "Drawings", "Executive", "Accounts", "Payments", "Admin"].map((r) => <option key={r}>{r}</option>)}
      </select></Field>
      <Field label="Department"><input value={f.dept} onChange={set("dept")} /></Field>
      <Field label="Official email"><input value={f.email} onChange={set("email")} /></Field>
      <Field label="Mobile number" hint="Used as the sign-in ID. Leave blank to keep it pending.">
        <input value={f.mobile} onChange={set("mobile")} inputMode="numeric" /></Field>
      <Btn kind="solid" full onClick={save}>Add user</Btn>
    </Modal>
  );
}

function Reports({ db, user }) {
  const t = today();
  const meta = (title) => [`Revanza Office Task Manager — ${title}`, `Generated ${new Date().toLocaleString("en-GB")} by ${user.name}`, "Confidential — internal circulation only"];
  const reports = [
    {
      name: "Daily attendance", desc: "Check-in, check-out, distance and update status for today.",
      run: () => downloadCSV(`attendance-${t}.csv`, [["Employee", "Role", "Status", "Check-in", "Distance (m)", "Check-out", "Morning update", "Evening update"],
      ...db.users.filter((u) => u.role !== OWNER).map((u) => {
        const a = attFor(db, u.id, t);
        return [u.name, u.role, a ? "Present" : "Absent", fmtTime(a?.inTs), a?.inDist ?? "", fmtTime(a?.outTs), a?.morningUpdate ? "Yes" : "No", a?.eveningUpdate ? "Yes" : "No"];
      })], meta("Daily attendance report")),
    },
    {
      name: "All tasks", desc: "Every task with owner, dates, status and progress.",
      run: () => downloadCSV(`tasks-${t}.csv`, [["Ref", "Task", "Property/Company", "Assigned to", "Assigned by", "Start", "Due", "Status", "Priority", "Subtasks done", "Updates"],
      ...db.tasks.map((x) => [x.ref, x.name, x.entity, uname(db, x.assignedTo), uname(db, x.assignedBy), x.start, x.due, x.status, x.priority,
      `${x.subtasks.filter((s) => s.done).length}/${x.subtasks.length}`, x.updates.length])], meta("Task report")),
    },
    {
      name: "Overdue tasks", desc: "Open tasks past their completion date, with ageing.",
      run: () => downloadCSV(`overdue-${t}.csv`, [["Ref", "Task", "Assigned to", "Due", "Days overdue", "Status"],
      ...db.tasks.filter(isOverdue).map((x) => [x.ref, x.name, uname(db, x.assignedTo), x.due, dayDiff(x.due, t), x.status])], meta("Overdue task report")),
    },
    {
      name: "Legal cases", desc: "Full case register with stage, hearing dates and counsel.",
      run: () => downloadCSV(`cases-${t}.csv`, [["Case no.", "Title", "Court", "Judge", "Counsel", "Associate", "Stage", "Last hearing", "Next hearing", "Next action", "Risk"],
      ...db.cases.map((c) => [c.caseNo, c.title, c.court, c.judge, c.counsel, uname(db, c.associate), c.stage, c.lastHearing, c.nextHearing, c.nextAction, c.risk])], meta("Legal case report")),
    },
    {
      name: "Upcoming hearings", desc: "Matters listed in the next 30 days.",
      run: () => downloadCSV(`hearings-${t}.csv`, [["Date", "Case no.", "Court", "Associate", "Stage", "Next action"],
      ...db.cases.filter((c) => c.nextHearing && c.nextHearing >= t && dayDiff(t, c.nextHearing) <= 30)
        .sort((a, b) => a.nextHearing.localeCompare(b.nextHearing))
        .map((c) => [c.nextHearing, c.caseNo, c.court, uname(db, c.associate), c.stage, c.nextAction])], meta("Upcoming hearing report")),
    },
    {
      name: "Leave register", desc: "All leave applications and their decisions.",
      run: () => downloadCSV(`leave-${t}.csv`, [["Employee", "Type", "From", "To", "Days", "Status", "Decided by"],
      ...db.leaves.map((l) => [uname(db, l.userId), l.type, l.from, l.to, l.days, l.status, l.decidedBy || ""])], meta("Leave report")),
    },
  ];
  return (
    <Panel title="Reports" sub="Downloads as CSV, which opens directly in Excel. Each file carries the title, generation stamp and confidentiality notice.">
      <div className="rep">
        {reports.map((r) => (
          <div className="rep-row" key={r.name}>
            <div><b>{r.name}</b><i className="sub">{r.desc}</i></div>
            <Btn kind="solid" onClick={r.run}>Download</Btn>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Settings({ db, user, commit, flash }) {
  const isOwner = user.role === OWNER;
  const [loc, setLoc] = useState(db.locations[0]);
  const saveLoc = () => {
    commit((d) => { const l = d.locations[0]; l.name = loc.name; l.lat = Number(loc.lat); l.lng = Number(loc.lng); l.radiusM = Number(loc.radiusM); },
      { by: user.name, action: "Reporting location updated", detail: loc.name });
    flash("Reporting location saved");
  };
  const useHere = () => navigator.geolocation?.getCurrentPosition((p) => {
    setLoc({ ...loc, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) });
    flash("Coordinates filled from your current position");
  }, () => flash("Could not read your location"));
  const reset = () => {
    if (LIVE) return flash("Reset is disabled in live mode — the data is shared by the whole office");
    if (!window.confirm("This clears all tasks, cases, attendance and leave, and restores the sample data. Continue?")) return;
    const fresh = seedDB(); saveDB(fresh); window.location.reload();
  };
  return (
    <>
      <Panel title="Change your PIN"><ChangePin user={user} commit={commit} onDone={() => flash("PIN changed")} /></Panel>
      {isOwner && (
        <Panel title="Reporting location" sub="Attendance is measured against this point">
          <Field label="Location name"><input value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} /></Field>
          <div className="row2">
            <Field label="Latitude"><input value={loc.lat} onChange={(e) => setLoc({ ...loc, lat: e.target.value })} /></Field>
            <Field label="Longitude"><input value={loc.lng} onChange={(e) => setLoc({ ...loc, lng: e.target.value })} /></Field>
          </div>
          <Field label="Permitted radius (metres)"><input type="number" value={loc.radiusM} onChange={(e) => setLoc({ ...loc, radiusM: e.target.value })} /></Field>
          <div className="quick"><Btn onClick={useHere}>Use my current position</Btn><Btn kind="solid" onClick={saveLoc}>Save location</Btn></div>
        </Panel>
      )}
      <Panel title="About this build">
        {LIVE ? (
          <p className="notice">
            <b>Live mode.</b> Data is shared across the whole office through your Supabase project, sign-in is real
            authentication, and access rules are enforced by the database itself: payroll is Owner-only, legal cases are
            visible only to the Owner and Legal Associates, staff can only write their own attendance and leave, and
            completed tasks are locked against staff changes at the server. Still pending as server work: WhatsApp,
            email and OTP sending, and Google Calendar sync. Staff PIN resets are done from the Supabase dashboard
            (Authentication → Users).
          </p>
        ) : (
          <p className="notice warnbox">
            <b>Demo mode — do not load real employee, salary or case data.</b> Everything is stored unencrypted in this
            browser only and is not shared between devices. Add the two Supabase environment variables (see the README)
            and this same build switches into live shared mode with real sign-in.
          </p>
        )}
        {isOwner && <div className="danger-zone"><Btn onClick={reset}>Reset workspace to sample data</Btn></div>}
      </Panel>
    </>
  );
}

/* ============================ STYLES ============================ */
function Styles() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;500;600&family=Inter+Tight:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box}
:root{
  --ink:#171A20; --ink2:#2B303A; --paper:#F4F3EF; --card:#FFF; --line:#E2E0D8; --line2:#EFEDE6;
  --brass:#9A6E1F; --brass-s:#F3E9D4; --muted:#767C89;
  --green:#2E7D53; --yellow:#B08307; --orange:#C05F1C; --red:#B3261E; --blue:#2C5FA8; --grey:#7A8091;
  --sans:'Inter Tight',system-ui,-apple-system,'Segoe UI',sans-serif;
  --serif:'Newsreader',Georgia,'Times New Roman',serif;
}
body{margin:0}
.app,.login,.boot{font-family:var(--sans);color:var(--ink);-webkit-font-smoothing:antialiased}
button,input,select,textarea{font-family:inherit;font-size:14px;color:inherit}
h1,h2,h3,h4{margin:0;font-weight:600}
.mono{font-variant-numeric:tabular-nums;letter-spacing:.01em}

/* boot + login */
.boot{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--paper);color:var(--brass)}
.boot p{color:var(--muted);font-size:13px}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--ink);padding:24px 16px}
.login-card{width:100%;max-width:390px;background:var(--card);border-radius:2px;padding:32px 28px;box-shadow:0 24px 60px rgba(0,0,0,.35)}
.login-brand{text-align:center;margin-bottom:26px;color:var(--brass)}
.login-brand h1{font-family:var(--serif);font-size:30px;letter-spacing:.02em;color:var(--ink);margin-top:8px}
.login-brand p{margin:2px 0 0;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.login-note{font-size:11.5px;line-height:1.55;color:var(--muted);margin:18px 0 8px;padding-top:14px;border-top:1px solid var(--line2)}
.linkish{background:none;border:0;padding:0;color:var(--brass);font-size:12px;font-weight:600;cursor:pointer;text-decoration:underline}
.demo-list{margin-top:10px;max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:2px}
.demo-list button{display:block;width:100%;text-align:left;padding:9px 12px;background:none;border:0;border-bottom:1px solid var(--line2);cursor:pointer;font-size:12.5px}
.demo-list button:hover{background:var(--brass-s)}
.err{color:var(--red);font-size:12.5px;margin:0 0 12px}
.pin-form .notice{margin-top:0}

/* shell */
.app{display:flex;min-height:100vh;background:var(--paper)}
.side{width:224px;flex:0 0 224px;background:var(--ink);color:#D9D6CE;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:10px;padding:20px 18px 18px;color:var(--brass);border-bottom:1px solid rgba(255,255,255,.08)}
.brand-txt{display:flex;flex-direction:column;line-height:1.2}
.brand-txt b{font-family:var(--serif);font-size:19px;color:#F3F1EA;font-weight:500;letter-spacing:.01em}
.brand-txt i{font-style:normal;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#8C9099}
.side nav{padding:10px 0;flex:1;overflow:auto}
.nav{display:flex;align-items:center;justify-content:space-between;width:100%;text-align:left;background:none;border:0;padding:9px 18px;color:#B6B9C0;font-size:13.5px;cursor:pointer;border-left:2px solid transparent}
.nav:hover{color:#fff;background:rgba(255,255,255,.04)}
.nav.on{color:#fff;border-left-color:var(--brass);background:rgba(154,110,31,.14);font-weight:600}
.pip{font-style:normal;background:var(--red);color:#fff;font-size:10px;font-weight:700;border-radius:9px;padding:1px 6px;margin-left:6px}
.side-foot{padding:14px 18px;border-top:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;gap:8px}
.who{display:flex;flex-direction:column;line-height:1.3}
.who b{color:#F3F1EA;font-size:13px}
.who i{font-style:normal;font-size:11px;color:#8C9099}
.signout{background:none;border:1px solid rgba(255,255,255,.18);color:#D9D6CE;padding:6px;border-radius:2px;font-size:12px;cursor:pointer}
.signout:hover{background:rgba(255,255,255,.07)}
.side-scrim{display:none}
main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:12px;padding:16px 24px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.top-t{flex:1;min-width:0}
.top-t h1{font-family:var(--serif);font-size:22px;font-weight:500}
.top-t p{margin:1px 0 0;font-size:11.5px;color:var(--muted)}
.top-alert{background:none;border:1px solid var(--line);border-radius:2px;padding:7px 11px;font-size:12.5px;cursor:pointer;display:flex;align-items:center}
.burger{display:none;background:none;border:0;font-size:20px;cursor:pointer}
.canvas{padding:20px 24px 60px;display:flex;flex-direction:column;gap:16px;max-width:1240px;width:100%}

/* panels */
.panel{background:var(--card);border:1px solid var(--line);border-radius:2px}
.panel-h{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line2)}
.panel-h h2{font-family:var(--serif);font-size:17px;font-weight:500}
.panel-h p{margin:2px 0 0;font-size:11.5px;color:var(--muted)}
.panel-r{display:flex;gap:6px;flex-shrink:0}
.panel-b{padding:16px 18px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
h4{font-family:var(--serif);font-size:14px;font-weight:600;margin:20px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--line2)}

/* stats */
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stat{display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--grey);border-radius:2px;padding:12px 14px;cursor:pointer}
.stat:disabled{cursor:default}
.stat:not(:disabled):hover{background:#FCFBF8;border-color:var(--brass)}
.stat-n{font-family:var(--serif);font-size:26px;line-height:1;font-variant-numeric:tabular-nums}
.stat-l{font-size:11.5px;color:var(--muted)}
.s-green{border-left-color:var(--green)}.s-red{border-left-color:var(--red)}.s-yellow{border-left-color:var(--yellow)}
.s-orange{border-left-color:var(--orange)}.s-blue{border-left-color:var(--blue)}.s-grey{border-left-color:var(--grey)}

/* the day board — signature element */
.board{list-style:none;margin:0;padding:0}
.board-row{display:flex;align-items:center;gap:14px;padding:11px 18px 11px 15px;border-bottom:1px solid var(--line2);border-left:3px solid transparent}
.board-row:last-child{border-bottom:0}
.r-red{border-left-color:var(--red)}.r-orange{border-left-color:var(--orange)}
.board-main{flex:1;min-width:0;display:flex;flex-direction:column}
.board-type{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.board-sub{font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.board-meta{display:flex;flex-direction:column;text-align:right;flex-shrink:0}
.board-who{font-size:13px;font-weight:600}
.board-act{font-size:11.5px;color:var(--muted)}

/* tables */
.scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:0 10px 7px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--line2);vertical-align:top}
.tbl tr:last-child td{border-bottom:0}
.tbl tbody tr:hover{background:#FCFBF8}
.row-danger td{background:#FDF6F5}
.row-danger:hover td{background:#FBEFED}
.sub{display:block;font-style:normal;font-size:11px;color:var(--muted);margin-top:1px}
.sub.warn{color:var(--orange)}
.danger{color:var(--red)}
.muted{color:var(--muted);font-style:italic}

/* badges + buttons */
.badge{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:2px;border:1px solid;white-space:nowrap;margin-right:4px}
.b-green{color:var(--green);border-color:#BEDCC9;background:#EDF6F1}
.b-yellow{color:var(--yellow);border-color:#E5D49B;background:#FBF5E3}
.b-orange{color:var(--orange);border-color:#EBC4A5;background:#FCF1E9}
.b-red{color:var(--red);border-color:#E8BFBC;background:#FBEEED}
.b-blue{color:var(--blue);border-color:#BCCCE6;background:#EDF2FA}
.b-grey{color:var(--grey);border-color:#D6D9DF;background:#F4F5F7}
.btn{border-radius:2px;padding:6px 12px;font-size:12.5px;font-weight:500;cursor:pointer;border:1px solid var(--line);background:var(--card)}
.btn:hover:not(:disabled){border-color:var(--ink2)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.full{width:100%;padding:10px}
.btn.b-solid{background:var(--ink);color:#fff;border-color:var(--ink)}
.btn.b-solid:hover:not(:disabled){background:#000}
.btn.b-brass{background:var(--brass-s);border-color:#E0CDA4;color:#6D4D11}
.quick{display:flex;flex-wrap:wrap;gap:8px}

/* forms */
.field{display:block;margin-bottom:13px}
.flabel{display:block;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:5px;font-weight:600}
.fhint{display:block;font-size:11px;color:var(--muted);margin-top:4px}
input,select,textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:2px;background:#fff}
input:focus,select:focus,textarea:focus{outline:2px solid var(--brass);outline-offset:-1px;border-color:var(--brass)}
textarea{resize:vertical}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.filters input{flex:2;min-width:180px}
.filters select{flex:1;min-width:140px}
.inline{display:flex;gap:8px;align-items:flex-start;margin:8px 0}
.check{display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px}
.check input{width:auto}

/* misc blocks */
.empty{font-size:12.5px;color:var(--muted);font-style:italic;margin:6px 0}
.notice{font-size:12px;line-height:1.6;color:var(--ink2);background:#FAF8F2;border-left:2px solid var(--brass);padding:10px 12px;margin:12px 0}
.warnbox{background:#FBEEED;border-left-color:var(--red)}
.summary{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11.5px;line-height:1.7;white-space:pre-wrap;margin:0;color:var(--ink2)}
.kv{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 16px;padding:14px 0;border-bottom:1px solid var(--line2)}
.kv div{display:flex;flex-direction:column}
.kv span{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.kv b{font-size:13px;font-weight:500;margin-top:2px}
.desc{font-size:13.5px;line-height:1.6;color:var(--ink2)}
.callout{background:#FBF5E3;border:1px solid #E5D49B;padding:11px 13px;font-size:13px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.callout-a{display:flex;gap:6px}
.statusbar{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.chip{border:1px solid var(--line);background:#fff;border-radius:20px;padding:5px 12px;font-size:12px;cursor:pointer}
.chip:hover{border-color:var(--ink2)}
.chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.subt{display:flex;gap:9px;align-items:center;font-size:13px;padding:6px 0;border-bottom:1px solid var(--line2)}
.subt input{width:auto}
.struck{text-decoration:line-through;color:var(--muted)}
.feed{list-style:none;margin:8px 0 0;padding:0}
.feed li{border-left:2px solid var(--line);padding:0 0 12px 12px;font-size:13px;line-height:1.55}
.feed-m{display:block;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.ext{background:#FAF8F2;padding:12px;margin-top:8px}
.tcard{border:1px solid var(--line);border-radius:2px;padding:11px 13px;margin-bottom:8px;cursor:pointer}
.tcard:hover{border-color:var(--brass);background:#FCFBF8}
.tcard-h{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.tcard-h b{font-size:13.5px}
.tcard-m{display:flex;flex-wrap:wrap;gap:14px;font-size:11.5px;color:var(--muted);margin-top:7px}
.hearing{display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--line2);cursor:pointer}
.hearing:hover{background:#FCFBF8}
.hd{font-family:var(--serif);font-size:12px;background:var(--brass-s);color:#6D4D11;padding:4px 7px;height:fit-content;white-space:nowrap}
.hd.now{background:var(--red);color:#fff}
.hearing b{font-size:13px}
.leave-row{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--line2);flex-wrap:wrap}
.leave-a{display:flex;gap:6px;align-items:flex-start}
.rep-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line2)}
.rep-row:last-child{border-bottom:0}
.danger-zone{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--line2)}

/* photos + voice */
.thumb{width:36px;height:36px;object-fit:cover;border-radius:2px;border:1px solid var(--line);display:block}
.thumb-lg{width:112px;height:112px;object-fit:cover;border:1px solid var(--line);border-radius:2px;display:block}
.thumbs{display:flex;flex-wrap:wrap;gap:12px;margin:10px 0}
.thumbs figure{margin:0}
.thumbs figcaption{font-size:10px;color:var(--muted);max-width:112px;margin-top:3px;line-height:1.4}
.voice{margin:6px 0 10px}
.rec-live{font-size:12px;color:var(--red);margin-left:10px;font-style:italic}
.subt-due{margin-left:auto;font-size:11px;color:var(--muted);white-space:nowrap}

/* charts */
.bars{display:flex;flex-direction:column;gap:7px}
.bar-row{display:grid;grid-template-columns:120px 1fr 32px;gap:10px;align-items:center;font-size:12px}
.bar-k{color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-t{background:var(--line2);height:14px;border-radius:1px;overflow:hidden}
.bar-f{display:block;height:100%}
.f-green{background:var(--green)}.f-red{background:var(--red)}.f-yellow{background:var(--yellow)}
.f-orange{background:var(--orange)}.f-blue{background:var(--blue)}.f-grey{background:var(--grey)}
.bar-v{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}

/* calendar */
.cal-h,.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:1px}
.cal-h{margin-bottom:1px}
.cal-h span{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:center;padding:4px 0;font-weight:600}
.cal{background:var(--line2)}
.cell{background:#fff;min-height:78px;padding:5px;display:flex;flex-direction:column;gap:2px}
.cell.blank{background:#FBFAF7}
.cell.now{background:#FAF8F2;box-shadow:inset 0 0 0 2px var(--brass)}
.cell-d{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.ev{font-size:10px;border:0;border-left:2px solid;padding:2px 4px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:1px}
.e-hearing{border-color:var(--red);background:#FBEEED;color:var(--red)}
.e-task{border-color:var(--blue);background:#EDF2FA;color:var(--blue)}
.e-leave{border-color:var(--grey);background:#F4F5F7;color:var(--grey)}
.legend{display:flex;gap:14px;margin-top:12px;font-size:11px}
.legend span{border-left:2px solid;padding-left:6px}

/* modal + toast */
.scrim{position:fixed;inset:0;background:rgba(23,26,32,.5);display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;z-index:50}
.modal{background:#fff;width:100%;max-width:520px;border-radius:2px;box-shadow:0 24px 60px rgba(0,0,0,.28)}
.modal.wide{max-width:760px}
.modal-h{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:15px 20px;border-bottom:1px solid var(--line)}
.modal-h h3{font-family:var(--serif);font-size:17px;font-weight:500}
.x{background:none;border:0;font-size:24px;line-height:1;cursor:pointer;color:var(--muted)}
.modal-b{padding:18px 20px 24px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 18px;border-radius:2px;font-size:13px;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.3)}

@media (max-width:900px){
  .two,.grid-4,.kv,.row2{grid-template-columns:1fr 1fr}
  .kv{grid-template-columns:1fr 1fr}
  .two{grid-template-columns:1fr}
}
@media (max-width:640px){
  .side{position:fixed;left:0;top:0;z-index:40;transform:translateX(-100%);transition:transform .22s ease}
  .side.open{transform:none;box-shadow:0 0 40px rgba(0,0,0,.4)}
  .side-scrim{display:block;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:35}
  .burger{display:block}
  .canvas{padding:14px 12px 60px}
  .top{padding:12px 14px}
  .top-t h1{font-size:18px}
  .grid-4{grid-template-columns:1fr 1fr}
  .kv,.row2{grid-template-columns:1fr}
  .board-row{flex-wrap:wrap;gap:6px}
  .board-meta{text-align:left;flex-direction:row;gap:8px;align-items:baseline}
  .bar-row{grid-template-columns:88px 1fr 28px}
  .cell{min-height:58px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`}</style>
  );
}
