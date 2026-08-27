import React, { useState, useEffect, useMemo, useCallback } from "react";
import { LIVE, sbSession, sbSignIn, sbSignUp, sbChangePin, sbSignOut, fetchAll, syncDB } from "./lib/db.js";
import * as XLSX from "xlsx";

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
  { id: "projects", label: "Projects", roles: "*" },
  { id: "attendance", label: "Attendance", roles: "*" },
  { id: "leave", label: "Leave", roles: "*" },
  { id: "cases", label: "Legal Cases", roles: [OWNER, "Legal Associate"] },
  { id: "accounts", label: "Accounts", roles: [OWNER, "Payments"] },
  { id: "calendar", label: "Calendar", roles: "*" },
  { id: "alerts", label: "Alerts", roles: "*" },
  { id: "notifications", label: "Notifications", roles: "*" },
  { id: "directory", label: "Employee Directory", roles: "*" },
  { id: "reports", label: "Reports", roles: [OWNER, "Accounts", "Admin"] },
  { id: "salary", label: "Salary", roles: [OWNER] },
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
const gpsOnce = (opts) => new Promise((res) => {
  navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, err: null }),
    (e) => res({ lat: null, lng: null, err: e.message }),
    opts
  );
});
const getGPS = async () => {
  if (!navigator.geolocation) return { lat: null, lng: null, err: "Location not supported on this device" };
  let r = await gpsOnce({ enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  if (r.lat == null) r = await gpsOnce({ enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
  if (r.lat == null && /denied|permission/i.test(r.err || ""))
    r.err = "Location is blocked for this site — tap the padlock in the address bar → Location → Allow, then retry";
  return r;
};
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

/* ---------- bank statement helpers ---------- */
const inr = (n) => "₹ " + (Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
function parseCSV(text) {
  const rows = []; let row = [], val = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { val += '"'; i++; } else inQ = false; }
      else val += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(val); val = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(val); val = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else val += c;
  }
  row.push(val);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}
const MONTHS3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseBankDate(sv) {
  const x = (sv || "").trim();
  let m = x.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = x.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${pad(+m[2])}-${pad(+m[1])}`; } // Indian banks: day first
  m = x.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ,]+(\d{2,4})/);
  if (m) { const mo = MONTHS3[m[2].toLowerCase().slice(0, 3)]; const y = m[3].length === 2 ? "20" + m[3] : m[3]; if (mo) return `${y}-${pad(mo)}-${pad(+m[1])}`; }
  return null;
}
const parseAmt = (sv) => { const n = parseFloat(String(sv || "").replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const H = {
  date: /(transaction\s*date|txn\s*date|^date\b|date\s*\()/i,
  desc: /(particular|narrat|description|remark|detail)/i,
  debit: /(withdraw|debit(?!\s*\/)|\bdr\b(?!\s*\/))/i,
  credit: /(deposit|credit(?!\s*\/)|\bcr\b(?!\s*\/))/i,
  amount: /^amount|amount\s*\(/i,
  drcr: /(dr\s*\/\s*cr|debit\s*\/\s*credit)/i,
  ref: /(ref|chq|cheque|utr)/i,
  balance: /balance/i,
};
/* Indian bank statements bury the table under 10–20 rows of address
   and header text. Find the row that actually names the columns. */
function findHeaderRow(rows) {
  let best = { idx: -1, score: 0 };
  const lim = Math.min(rows.length, 45);
  for (let i = 0; i < lim; i++) {
    const cells = rows[i].map((c) => String(c || "").trim());
    let score = 0;
    if (cells.some((c) => H.date.test(c))) score += 2;
    if (cells.some((c) => H.desc.test(c))) score += 1;
    if (cells.some((c) => H.debit.test(c)) && cells.some((c) => H.credit.test(c))) score += 2;
    if (cells.some((c) => H.amount.test(c)) && cells.some((c) => H.drcr.test(c))) score += 2;
    if (cells.some((c) => H.balance.test(c))) score += 1;
    if (score > best.score) best = { idx: i, score };
  }
  return best.score >= 3 ? best.idx : rows.length > 0 ? 0 : -1;
}
function guessColumns(hdr) {
  const find = (re, after = -1) => hdr.findIndex((h, i) => i > after && re.test(String(h || "")));
  const amount = find(H.amount);
  return {
    date: find(H.date), desc: find(H.desc),
    debit: find(H.debit), credit: find(H.credit),
    amount, drcr: find(H.drcr, amount), // Kotak has a second Dr/Cr for balance — take the one after Amount
    ref: find(H.ref), balance: find(H.balance),
  };
}
const cleanMobile = (v) => String(v || "").replace(/[^0-9]/g, "").slice(-10);
const titleCase = (t) => String(t || "").toLowerCase().replace(/(^|[\s\-/(&.,])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const parseDrCr = (sv) => /d\s*r/i.test(String(sv || "")) ? "Payment" : /c\s*r/i.test(String(sv || "")) ? "Receipt" : null;

/* ---------- salary engine ---------- */
const HR_DEFAULTS = { latesPerHalfDay: 3, leaveUnpaid: true, leaveExtraThreshold: 5, leaveExtraDays: 2 };
const daysInMonth = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(y, m, 0).getDate(); };
const DOW = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

function calcSalary(db, u, ym) {
  const hr = { ...HR_DEFAULTS, ...(db.settings.hr || {}) };
  const dim = daysInMonth(ym);
  const t = today();
  const perDay = (Number(u.salary) || 0) / dim;
  const start = Math.min(dim, Math.max(1, Number(u.salaryStartDay) || 1));
  const beforeStart = false;
  const afterEnd = false;
  const endCap = Number(u.salaryEndDay) ? Math.min(dim, Math.max(1, Number(u.salaryEndDay))) : dim;
  const lastCounted = ym === t.slice(0, 7) ? Number(t.slice(8, 10)) : ym > t.slice(0, 7) ? 0 : dim;
  const upto = Math.min(endCap, lastCounted);
  const offDow = DOW[u.weeklyOff || "Sunday"] ?? 0;
  const days = [];
  let present = 0, absent = 0, leaveDays = 0, lates = 0, offWorked = 0, otMins = 0, graceEaten = 0;
  if (!beforeStart && !afterEnd) {
    for (let d0 = start; d0 <= upto; d0++) {
      const date = `${ym}-${pad(d0)}`;
      const dow = new Date(date + "T00:00:00").getDay();
      const a = db.attendance.find((x) => x.userId === u.id && x.date === date);
      const onLeave = db.leaves.some((l) => l.userId === u.id && l.status === "Approved" && l.from <= date && l.to >= date);
      let status, otToday = 0, lateBy = 0, graceToday = 0;
      if (dow === offDow) {
        if (a) { offWorked++; status = "Weekly off — worked (+1 day)"; } else status = "Weekly off";
      } else if (onLeave) { leaveDays++; status = "Approved leave"; }
      else if (!a) { absent++; status = "Absent"; }
      else {
        present++;
        const inM = minsSinceMidnight(a.inTs), ws = hhmmToMins(u.workStart || "09:30"), grace = Number(u.graceMins) || 0;
        if (inM > ws + grace) { lates++; status = "Present — late"; lateBy = inM - ws; }
        else { status = "Present"; if (inM > ws) { graceEaten += inM - ws; graceToday = inM - ws; } }
        if (a.outTs) { const om = minsSinceMidnight(a.outTs) - hhmmToMins(u.workEnd || "18:30"); if (om > 0) { otMins += om; otToday = om; } }
      }
      days.push({ date, status, inT: a ? fmtTime(a.inTs) : "", outT: a && a.outTs ? fmtTime(a.outTs) : "", ot: otToday, late: lateBy, graceUsed: graceToday });
    }
  }
  const halfDays = Math.floor(lates / (hr.latesPerHalfDay || 3)) * 0.5;
  const leaveDeduct = hr.leaveUnpaid ? leaveDays + (leaveDays >= (hr.leaveExtraThreshold || 5) ? (hr.leaveExtraDays || 2) : 0) : 0;
  const otNetMins = Math.max(0, otMins - graceEaten);
  const otPay = (otNetMins / 60) * (Number(u.incentivePerHour) || 0);
  const base = beforeStart || afterEnd || upto < start ? 0 : (Number(u.salary) || 0) * (upto - start + 1) / dim;
  const dedDays = absent + halfDays + leaveDeduct;
  const net = Math.max(0, base - dedDays * perDay + offWorked * perDay + otPay);
  return { dim, upto, start, perDay, present, absent, leaveDays, leaveDeduct, lates, halfDays, offWorked, otMins, graceEaten, otNetMins, otPay, base, dedDays, net, days };
}

/* ---------- project schedule engine ----------
   A task whose linked (depends-on) tasks are late or incomplete
   cannot start on time; it and its subtasks are pushed forward,
   chains cascade, and everyone connected is notified. */
function cascadeSchedule(d, projectId, actor) {
  const t = today();
  const proj = d.projects.find((p) => p.id === projectId);
  const tasks = d.ptasks.filter((x) => x.projectId === projectId);
  const byId = {}; tasks.forEach((x) => { byId[x.id] = x; });
  const shifted = [];
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    tasks.forEach((x) => {
      if ((x.percent || 0) >= 100 || !(x.dependsOn || []).length) return;
      let minStart = null;
      (x.dependsOn || []).forEach((did) => {
        const dep = byId[did]; if (!dep) return;
        const effEnd = (dep.percent || 0) >= 100 ? dep.end : (dep.end < t ? t : dep.end);
        const ns = addDays(effEnd, 1);
        if (!minStart || ns > minStart) minStart = ns;
      });
      if (minStart && x.start < minStart) {
        const delta = dayDiff(x.start, minStart);
        x.origEnd = x.origEnd || x.end;
        x.start = addDays(x.start, delta);
        x.end = addDays(x.end, delta);
        (x.subtasks || []).forEach((st) => {
          if (st.start) st.start = addDays(st.start, delta);
          if (st.end) st.end = addDays(st.end, delta);
        });
        shifted.push({ x, delta });
        changed = true;
      }
    });
    if (!changed) break;
  }
  if (shifted.length && proj) {
    const audience = [d.users.find((u) => u.role === OWNER)?.id, ...(proj.team || []), ...(proj.contractors || [])];
    shifted.forEach(({ x, delta }) =>
      pushNotify(d, audience, `Project "${proj.name}": "${x.name}" pushed by ${delta} day(s) to ${fmtDate(x.end)} because a linked task is delayed or incomplete`, "Project delay", null));
    d.audit.unshift({ ts: Date.now(), by: actor, action: "Project schedule shifted", detail: `${proj.name}: ${shifted.length} task(s) moved` });
  }
  return shifted.length;
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
      caseTypes: ["Consumer complaint", "Suit for injunction", "Writ petition"],
      ledgers: ["EB / utilities", "Professional fees", "Rent", "Salaries", "Sales advance", "Vendor payment"],
      categories: ["Capital", "Direct expense", "Income", "Indirect expense", "Transfer"],
    },
    locations: [{ id: "LOC1", name: "Head Office — Chennai", lat: 13.0827, lng: 80.2707, radiusM: 250 }],
    holidays: [],
    notifications: [],
    accounts: [],
    entries: [],
    projects: [],
    ptasks: [],
    companies: [],
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
const taskAssignees = (t) => (t.assignees && t.assignees.length ? t.assignees : [t.assignedTo].filter(Boolean));
const mineTask = (t, id) => taskAssignees(t).includes(id);
function pushNotify(d, userIds, text, kind, ref) {
  [...new Set(userIds.filter(Boolean))].forEach((u2) =>
    d.notifications.unshift({ id: uid("n"), userId: u2, ts: Date.now(), text, kind, ref: ref || null, read: false }));
}
const uname = (db, id) => db.users.find((u) => u.id === id)?.name || "—";
const urole = (db, id) => db.users.find((u) => u.id === id)?.role || "";

function buildAlerts(db) {
  const t = today();
  const out = [];
  const push = (sev, type, who, subject, action, ref) => out.push({ id: uid("al"), sev, type, who, subject, action, ref, ts: Date.now() });
  db.users.filter((u) => u.status === "Active" && u.role !== OWNER && u.role !== "Contractor").forEach((u) => {
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
const APP_VERSION = "v2.7 · 22 Aug 2026";
const IS_TOUCH_DEVICE = typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/* In-app webcam window: live preview → capture → JPEG. Used as the primary
   path on laptops (where file inputs open the file explorer, never the camera)
   and as the fallback on phones where the native camera does not open. */
function CameraCapture({ onShot, onClose, facing = "user" }) {
  const vRef = React.useRef(null);
  const [err, setErr] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let st = null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErr("This browser does not allow camera access — use the file option instead");
      return undefined;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false })
      .then((s2) => {
        st = s2;
        if (vRef.current) { vRef.current.srcObject = s2; vRef.current.play().catch(() => {}); setReady(true); }
      })
      .catch((e) => setErr(/denied|permission/i.test(String(e && e.message)) ?
        "Camera permission is blocked for this site — allow it via the padlock/lock icon in the address bar, then try again" :
        (e && e.message) || "The camera could not be started"));
    return () => { if (st) st.getTracks().forEach((tr) => tr.stop()); };
  }, [facing]);
  const snap = () => {
    const v = vRef.current;
    if (!v || !v.videoWidth) return;
    const cv = document.createElement("canvas");
    const w = Math.min(900, v.videoWidth);
    cv.width = w; cv.height = Math.round((w * v.videoHeight) / v.videoWidth);
    cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
    onShot(cv.toDataURL("image/jpeg", 0.7));
    onClose();
  };
  return (
    <Modal title="Take the photograph" onClose={onClose}>
      {err ? <p className="notice">{err}</p> : (
        <>
          <video ref={vRef} playsInline muted style={{ width: "100%", borderRadius: 10, background: "#111", transform: facing === "user" ? "scaleX(-1)" : "none" }} />
          <div className="quick" style={{ marginTop: 12 }}>
            <Btn kind="solid" disabled={!ready} onClick={snap}>{ready ? "Capture photo" : "Starting camera…"}</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

function CameraButton({ label, kind = "ghost", onShot, disabled, facing = "user" }) {
  const ref = React.useRef(null);
  const [cam, setCam] = useState(false);
  const onFile = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try { onShot(await compressImage(f)); } catch { onShot(null); }
  };
  const canLiveCam = typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  return (
    <span className="cambtn">
      <input ref={ref} type="file" accept="image/*" capture={facing}
        style={{ position: "fixed", left: -10000, top: 0, width: 1, height: 1, opacity: 0 }}
        onChange={onFile} />
      <Btn kind={kind} disabled={disabled}
        onClick={() => { if (!IS_TOUCH_DEVICE && canLiveCam) setCam(true); else if (ref.current) ref.current.click(); }}>{label}</Btn>
      {!disabled && (
        <button type="button" className="cam-alt"
          onClick={() => { if (IS_TOUCH_DEVICE && canLiveCam) setCam(true); else if (ref.current) ref.current.click(); }}>
          {IS_TOUCH_DEVICE ? "Camera not opening? Tap here" : "…or choose a saved photo"}
        </button>
      )}
      {cam && <CameraCapture facing={facing} onClose={() => setCam(false)} onShot={onShot} />}
    </span>
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
  const [syncErr, setSyncErr] = useState("");
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
      if (!d.notifications) d.notifications = [];
      if (!d.masters.caseTypes) d.masters.caseTypes = ["Consumer complaint", "Suit for injunction", "Writ petition"];
      if (!d.accounts) d.accounts = [];
      if (!d.entries) d.entries = [];
      if (!d.masters.ledgers) d.masters.ledgers = ["Rent", "Salaries", "Vendor payment"];
      if (!d.masters.categories) d.masters.categories = ["Direct expense", "Income", "Transfer"];
      if (!d.settings.hr) d.settings.hr = { ...HR_DEFAULTS };
      if (!d.projects) d.projects = [];
      if (!d.ptasks) d.ptasks = [];
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

  // contractors land on (and stay in) the Projects area
  useEffect(() => {
    const u = db && me ? db.users.find((x) => x.id === me) : null;
    if (u && u.role === "Contractor" && !["projects", "notifications", "settings"].includes(view)) setView("projects");
  }, [me, view, db]);

  const commit = useCallback((mut, note) => {
    setDb((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      mut(next);
      if (note) next.audit.unshift({ ts: Date.now(), by: note.by || "system", action: note.action, detail: note.detail || "" });
      if (note && me && next.notifications) {
        const actor = prev.users.find((x) => x.id === me);
        const ownerId = prev.users.find((x) => x.role === OWNER)?.id;
        if (actor && ownerId && actor.role !== OWNER) {
          next.notifications.unshift({ id: uid("n"), userId: ownerId, ts: Date.now(), text: `${note.by || actor.name}: ${note.action}${note.detail ? " — " + note.detail : ""}`, kind: "Staff activity", ref: null, read: false });
        }
      }
      if (LIVE) {
        const meUser = me && prev.users.find((u) => u.id === me);
        syncDB(prev, next, meUser ? meUser.role : "").then((errs) => {
          if (errs && errs.length) setSyncErr(errs[0]);
        }).catch((e) => setSyncErr(String(e && e.message || e)));
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
      {syncErr && (
        <div className="sync-err">
          The server did not accept the last change — it may disappear after refresh. Reason: {syncErr}
          <span> · Screenshot this message and send it to the MD.</span>
          <button onClick={() => setSyncErr("")}>×</button>
        </div>
      )}
    </>
  );
  if (!db) return (<><Styles /><div className="boot"><Mark size={40} /><p>Loading workspace…</p></div></>);
  if (!user) return (<><Styles /><Login db={db} commit={commit} onIn={(id) => { setMe(id); try { localStorage.setItem(SESSION_KEY, JSON.stringify(id)); } catch { } }} /></>);
  if (user.mustChangePin) return (<><Styles /><ChangePin user={user} commit={commit} first onDone={() => flash("PIN changed")} /></>);

  const isOwner = user.role === OWNER;
  const isContractor = user.role === "Contractor";
  const contractorViews = ["projects", "notifications", "settings"];
  const myAlerts = isOwner ? alerts : alerts.filter((a) => a.who === user.name);
  const unreadNotifs = (db.notifications || []).filter((x) => x.userId === user.id && !x.read).length;
  const nav = NAV.filter((n) => allowed(n, user.role)).filter((n) => !isContractor || contractorViews.includes(n.id));

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
                {n.id === "notifications" && unreadNotifs > 0 && <em className="pip">{unreadNotifs}</em>}
              </button>
            ))}
          </nav>
          <div className="side-foot">
            <span className="who"><b>{user.name}</b><i>{user.role}</i></span>
            <button className="signout" onClick={signOut}>Sign out</button>
            <p style={{ fontSize: 10, opacity: 0.5, marginTop: 6 }}>{APP_VERSION}</p>
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
            {!isContractor && (
              <button className="top-alert" onClick={() => go("alerts")}>
                Alerts{myAlerts.length > 0 && <em className="pip">{myAlerts.length}</em>}
              </button>
            )}
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
            {view === "notifications" && <Notifications db={db} user={user} commit={commit} go={go} />}
            {view === "accounts" && <Accounts db={db} user={user} commit={commit} flash={flash} />}
            {view === "salary" && <Salary db={db} user={user} commit={commit} flash={flash} />}
            {view === "projects" && <Projects db={db} user={user} commit={commit} flash={flash} />}
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
        if (/already registered/i.test(error.message))
          return setErr("This number already has a PIN — switch to the Sign in tab. Forgot it? Ask the Owner to reset.");
        if (/not registered by the owner/i.test(error.message))
          return setErr("This mobile number has not been added by the Owner yet.");
        return setErr("Could not create the sign-in: " + error.message);
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
        <p className="login-note" style={{ opacity: 0.6, borderTop: "none", paddingTop: 0 }}>{APP_VERSION}</p>
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
        <p className="login-note" style={{ opacity: 0.6, borderTop: "none", paddingTop: 0 }}>{APP_VERSION}</p>
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
  const [emp, setEmp] = useState(null);
  const staff = db.users.filter((u) => u.status === "Active" && u.role !== OWNER && u.role !== "Contractor");
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
        <Stat n={db.tasks.length} label="Total tasks" t="grey" onClick={() => go("tasks", { status: "" })} />
        <Stat n={db.tasks.filter((x) => x.status === "Completed").length} label="Completed tasks" t="green" onClick={() => go("tasks", { status: "Completed" })} />
        <Stat n={db.tasks.filter((x) => x.status === "In Progress").length} label="In progress" t="blue" onClick={() => go("tasks", { status: "In Progress" })} />
        <Stat n={db.tasks.filter((x) => x.status === "Stopped").length} label="Stopped tasks" t="red" onClick={() => go("tasks", { status: "Stopped" })} />
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

      <Panel title="Staff overview" sub="Tap Open for that person's full task list and report" pad={false}>
        <ul className="board">
          {[...staff].sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name)).map((u, i, arr) => {
            const uAll = db.tasks.filter((x) => taskAssignees(x).includes(u.id));
            const uOpen = uAll.filter((x) => x.status !== "Completed");
            const uOver = uAll.filter(isOverdue);
            const a = attFor(db, u.id, t);
            const hdr = i === 0 || arr[i - 1].role !== u.role;
            return (
              <React.Fragment key={u.id}>
                {hdr && <li className="board-row grp-row">{u.role}</li>}
                <li className={`board-row${uOver.length ? " r-orange" : ""}`} onClick={() => setEmp(u.id)} style={{ cursor: "pointer" }}>
                  <div className="board-main">
                    <span className="board-type">{a ? `In ${fmtTime(a.inTs)}` : "Not checked in"}</span>
                    <span className="board-sub">{u.name}</span>
                  </div>
                  <div className="board-meta">
                    <span className="board-who">{uOpen.length} open{uOver.length ? ` · ${uOver.length} overdue` : ""}</span>
                    <span className="board-act">Tap for full report</span>
                  </div>
                  <Btn onClick={(e) => { e.stopPropagation(); setEmp(u.id); }}>Report</Btn>
                </li>
              </React.Fragment>
            );
          })}
        </ul>
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
                  <div><b>{c.caseNo}</b> <i className="sub">{titleCase(c.title)}</i>
                    <i className="sub">{c.court} · {uname(db, c.associate)} · {titleCase(c.nextAction)}</i></div>
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
      {emp && <EmployeeReport db={db} u={db.users.find((x) => x.id === emp)} go={go} onClose={() => setEmp(null)} />}
    </>
  );
}

function EmployeeReport({ db, u, go, onClose }) {
  const ym = today().slice(0, 7);
  const c = calcSalary(db, u, ym);
  const uT = db.tasks.filter((x) => taskAssignees(x).includes(u.id));
  const openT = uT.filter((x) => x.status !== "Completed").sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const lv = db.leaves.filter((l) => l.userId === u.id).slice(0, 6);
  const cs = db.cases.filter((x) => x.associate === u.id && x.stage !== "Disposed");
  return (
    <Modal title={`${u.name} — ${u.role}`} onClose={onClose} wide>
      <div className="kv">
        <div><span>Mobile</span><b>{u.mobile}</b></div>
        <div><span>Email</span><b>{u.email}</b></div>
        <div><span>This month</span><b>{c.present} present · {c.absent} absent · {c.leaveDays} leave · {c.lates} late</b></div>
        <div><span>OT this month</span><b>{(c.otNetMins / 60).toFixed(1)} h</b></div>
        <div><span>Open tasks</span><b>{openT.length} ({uT.filter(isOverdue).length} overdue)</b></div>
        <div><span>Leave balance</span><b>{u.leaveBalance} day(s)</b></div>
      </div>
      <div className="quick" style={{ margin: "10px 0" }}>
        <Btn kind="solid" onClick={() => { onClose(); go("tasks", { who: u.id }); }}>Open full task list</Btn>
      </div>
      <h4>Tasks and delays</h4>
      {openT.length === 0 ? <Empty>No open tasks.</Empty> : (
        <table className="tbl">
          <thead><tr><th>Ref</th><th>Task</th><th>Due</th><th>Status</th><th>Delay</th></tr></thead>
          <tbody>{openT.map((x) => (
            <tr key={x.id} className={isOverdue(x) ? "row-danger" : ""}>
              <td className="mono">{x.ref}</td><td>{x.name}</td><td>{fmtDate(x.due)}</td>
              <td><Badge>{x.status}</Badge></td>
              <td className={isOverdue(x) ? "danger" : ""}>{isOverdue(x) ? dayDiff(x.due, today()) + " day(s) overdue" : "—"}</td>
            </tr>))}
          </tbody>
        </table>
      )}
      {cs.length > 0 && (<>
        <h4>Active matters</h4>
        <ul className="feed">{cs.map((x) => (
          <li key={x.id}><span className="feed-m">{x.caseNo} · {x.stage}</span>{x.title} — next hearing {x.nextHearing ? fmtDate(x.nextHearing) : "not set"}</li>))}
        </ul>
      </>)}
      <h4>Attendance — {ym} (day by day)</h4>
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th>Late by</th><th className="amt">OT mins</th></tr></thead>
          <tbody>{c.days.map((d0) => (
            <tr key={d0.date}>
              <td>{fmtDate(d0.date)}</td>
              <td className={d0.status === "Absent" ? "danger" : ""}>{d0.status}</td>
              <td>{d0.inT || "—"}</td><td>{d0.outT || "—"}</td>
              <td className={d0.late ? "danger" : ""}>{d0.late ? d0.late + " min" : ""}</td>
              <td className="amt">{d0.ot || ""}</td>
            </tr>))}
          </tbody>
        </table>
      </div>
      {lv.length > 0 && (<>
        <h4>Recent leave</h4>
        <table className="tbl">
          <thead><tr><th>Type</th><th>From</th><th>To</th><th>Status</th></tr></thead>
          <tbody>{lv.map((l) => (
            <tr key={l.id}><td>{l.type}</td><td>{fmtDate(l.from)}</td><td>{fmtDate(l.to)}</td><td><Badge>{l.status}</Badge></td></tr>))}
          </tbody>
        </table>
      </>)}
    </Modal>
  );
}

/* ============================ STAFF DASHBOARD ============================ */
function StaffDash({ db, user, go, commit, flash }) {
  const t = today();
  const mine = db.tasks.filter((x) => mineTask(x, user.id));
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
              <div className="tcard-h"><span><b>{c.caseNo}</b><i className="sub">{titleCase(c.title)}</i></span><Badge t={c.nextHearing === t ? "red" : "blue"}>{c.stage}</Badge></div>
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
  const [who, setWho] = useState(preset?.who ?? "");
  const [quick, setQuick] = useState(preset?.quick ?? "");
  const [open, setOpen] = useState(focus?.kind === "task" ? focus.id : null);
  const [creating, setCreating] = useState(false);

  let rows = isOwner ? db.tasks : db.tasks.filter((x) => mineTask(x, user.id));
  rows = rows.filter((x) => {
    if (status && x.status !== status) return false;
    if (who && !taskAssignees(x).includes(who)) return false;
    if (quick === "overdue" && !isOverdue(x)) return false;
    if (quick === "today" && !(x.due === t && x.status !== "Completed")) return false;
    if (quick === "week" && !(x.due >= t && dayDiff(t, x.due) <= 7 && x.status !== "Completed")) return false;
    if (q) {
      const s = (x.ref + x.name + x.entity + x.desc).toLowerCase();
      if (!s.includes(q.toLowerCase())) return false;
    }
    return true;
  }).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));

  const [group, setGroup] = useState("");
  const groupKey = (x) => group === "staff" ? (taskAssignees(x).map((id) => uname(db, id)).join(", ") || "—")
    : group === "status" ? x.status
    : group === "date" ? (x.due ? fmtDate(x.due) : "No date")
    : "";
  const displayRows = group ? [...rows].sort((a, b) => groupKey(a).localeCompare(groupKey(b)) || (a.due || "9999").localeCompare(b.due || "9999")) : rows;

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
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">No grouping</option><option value="staff">Group: staff-wise</option>
            <option value="status">Group: status-wise</option><option value="date">Group: date-wise</option>
          </select>
          {(q || status || who || quick) && <Btn onClick={() => { setQ(""); setStatus(""); setWho(""); setQuick(""); }}>Clear</Btn>}
        </div>
        {isOwner && who && (() => {
          const wT = db.tasks.filter((x) => taskAssignees(x).includes(who));
          const a = attFor(db, who, t);
          return (
            <div className="kv" style={{ borderBottom: "none", paddingTop: 0 }}>
              <div><span>Employee report</span><b>{uname(db, who)} — {urole(db, who)}</b></div>
              <div><span>Attendance today</span><b>{a ? `In ${fmtTime(a.inTs)}${a.outTs ? ` · out ${fmtTime(a.outTs)}` : ""}` : "Not checked in"}</b></div>
              <div><span>Open tasks</span><b>{wT.filter((x) => x.status !== "Completed").length}</b></div>
              <div><span>Overdue</span><b className={wT.filter(isOverdue).length ? "danger" : ""}>{wT.filter(isOverdue).length}</b></div>
              <div><span>Facing issues / stopped</span><b>{wT.filter((x) => x.status === "Facing Issues" || x.status === "Stopped").length}</b></div>
              <div><span>Completed</span><b>{wT.filter((x) => x.status === "Completed").length}</b></div>
            </div>
          );
        })()}
        {rows.length === 0 ? <Empty>No tasks match these filters. Clear them to see everything.</Empty> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Ref</th><th>Task</th><th>Property / company</th><th>Assigned to</th><th>Due</th><th>Status</th><th>Progress</th><th>Last update</th><th></th></tr></thead>
              <tbody>
                {displayRows.map((x, ri) => {
                  const done = x.subtasks.filter((s) => s.done).length;
                  const gk = groupKey(x);
                  const showHdr = group && (ri === 0 || groupKey(displayRows[ri - 1]) !== gk);
                  return (
                    <React.Fragment key={x.id}>
                    {showHdr && <tr className="grp"><td colSpan={9}>{gk}</td></tr>}
                    <tr className={isOverdue(x) ? "row-danger" : ""}>
                      <td className="mono">{x.ref}</td>
                      <td><b>{x.name}</b>{x.extension?.status === "Pending" && <i className="sub warn">Extension requested → {fmtDate(x.extension.newDate)}</i>}</td>
                      <td>{x.entity}</td>
                      <td>{taskAssignees(x).map((id) => uname(db, id)).join(", ")}
                        {taskAssignees(x).length === 1
                          ? <i className="sub">{urole(db, x.assignedTo)}</i>
                          : <i className="sub">Group · {taskAssignees(x).filter((id) => x.completions && x.completions[id]).length}/{taskAssignees(x).length} confirmed complete</i>}</td>
                      <td>{fmtDate(x.due)}{isOverdue(x) && <i className="sub danger">{dayDiff(x.due, t)}d overdue</i>}</td>
                      <td><Badge>{x.status}</Badge></td>
                      <td className="mono">{x.subtasks.length ? `${done}/${x.subtasks.length}` : "—"}</td>
                      <td>{x.updates.length ? fmtStamp(x.updates[0].ts) : "No updates"}</td>
                      <td><Btn onClick={() => setOpen(x.id)}>Open</Btn></td>
                    </tr>
                    </React.Fragment>
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
  const allIds = taskAssignees(task);
  const isMine = allIds.includes(user.id);
  const locked = task.status === "Completed" && !isOwner;
  const ownerId = db.users.find((u) => u.role === OWNER)?.id;
  const [txt, setTxt] = useState("");
  const [chat, setChat] = useState("");
  const [sub, setSub] = useState("");
  const [subDate, setSubDate] = useState(task.due || today());
  const [ext, setExt] = useState({ on: false, date: "", reason: "" });
  const [edit, setEdit] = useState({ on: false, name: task.name, entity: task.entity, due: task.due, assignedTo: task.assignedTo });

  const mutate = (fn, action) => commit((d) => fn(d.tasks.find((x) => x.id === task.id), d), { by: user.name, action, detail: task.ref });
  const others = (tk) => [tk.assignedBy, ownerId, ...taskAssignees(tk)].filter((x) => x !== user.id);

  const addUpdate = (text) => {
    if (!text.trim()) return;
    mutate((tk, d) => {
      tk.updates.unshift({ ts: Date.now(), by: user.name, text });
      pushNotify(d, others(tk), `${user.name} updated ${tk.ref}: ${text.slice(0, 90)}`, "Task update", { kind: "task", id: tk.id });
    }, "Task update added");
    flash("Update added");
  };
  const postChat = () => {
    if (!chat.trim()) return;
    const msg = chat;
    mutate((tk, d) => {
      tk.comments = tk.comments || [];
      tk.comments.unshift({ ts: Date.now(), by: user.name, text: msg });
      pushNotify(d, others(tk), `${user.name} in ${tk.ref} chat: ${msg.slice(0, 90)}`, "Task chat", { kind: "task", id: tk.id });
    }, "Chat message");
    setChat("");
  };
  const setStatus = (st) => {
    mutate((tk, d) => {
      const team = taskAssignees(tk);
      if (st === "Completed" && !isOwner && team.length > 1) {
        tk.completions = tk.completions || {};
        tk.completions[user.id] = Date.now();
        const remaining = team.filter((id) => !tk.completions[id]);
        if (remaining.length === 0) tk.status = "Completed";
        pushNotify(d, others(tk),
          remaining.length === 0
            ? `${tk.ref} is now fully completed — every member has confirmed`
            : `${user.name} marked their part of ${tk.ref} complete (${team.length - remaining.length}/${team.length})`,
          "Task status", { kind: "task", id: tk.id });
      } else {
        tk.status = st;
        if (st === "Completed") {
          tk.completions = tk.completions || {};
          team.forEach((id) => { tk.completions[id] = tk.completions[id] || Date.now(); });
        }
        pushNotify(d, others(tk), `${tk.ref} status set to ${st} by ${user.name}`, "Task status", { kind: "task", id: tk.id });
      }
    }, `Task status: ${st}`);
    flash(!isOwner && allIds.length > 1 && st === "Completed" ? "Your completion is recorded" : `Status set to ${st}`);
  };
  const toggleSub = (id) => mutate((tk) => { const x = tk.subtasks.find((y) => y.id === id); x.done = !x.done; }, "Subtask updated");
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
    mutate((tk, d) => {
      tk.extension = { requested: Date.now(), by: user.name, newDate: ext.date, reason: ext.reason, status: "Pending" };
      tk.status = "Delaying Completion Date";
      pushNotify(d, [tk.assignedBy, ownerId], `${user.name} requested a new completion date for ${tk.ref}: ${fmtDate(ext.date)}`, "Extension", { kind: "task", id: tk.id });
    }, "Extension requested");
    setExt({ on: false, date: "", reason: "" }); flash("Extension request sent to the Owner");
  };
  const decideExt = (ok) => {
    mutate((tk, d) => {
      tk.extension.status = ok ? "Approved" : "Rejected";
      if (ok) { tk.origDue = tk.origDue || tk.due; tk.due = tk.extension.newDate; }
      pushNotify(d, taskAssignees(tk), `Completion-date request for ${tk.ref} was ${ok ? "approved" : "rejected"}`, "Extension", { kind: "task", id: tk.id });
    }, `Extension ${ok ? "approved" : "rejected"}`);
    flash(`Extension ${ok ? "approved" : "rejected"}`);
  };
  const saveEdit = () => {
    if (!edit.name.trim() || !edit.entity.trim()) return flash("Task name and property/company are required");
    mutate((tk, d) => {
      tk.name = edit.name; tk.entity = edit.entity; tk.due = edit.due;
      learn(d, "entities", edit.entity);
    }, "Task edited by Owner");
    setEdit({ ...edit, on: false }); flash("Task details updated");
  };
  const compDone = allIds.filter((id) => task.completions && task.completions[id]).length;

  return (
    <Modal title={`${task.ref} — ${task.name}`} onClose={onClose} wide>
      <div className="kv">
        <div><span>Property / company</span><b>{task.entity}</b></div>
        <div><span>Allocated to</span><b>{allIds.map((id) => uname(db, id)).join(", ")}</b></div>
        <div><span>Assigned by</span><b>{uname(db, task.assignedBy)}</b></div>
        <div><span>Started</span><b>{fmtDate(task.start)}</b></div>
        <div><span>Completion date</span><b>{fmtDate(task.due)}{task.origDue && <i className="sub">was {fmtDate(task.origDue)}</i>}</b></div>
        <div><span>Status</span><b><Badge>{task.status}</Badge></b></div>
      </div>
      {task.desc && <p className="desc">{task.desc}</p>}

      {allIds.length > 1 && (
        <div className="callout">
          <span><b>Group task</b> — counts as completed only when every member confirms ({compDone}/{allIds.length}).<br />
            {allIds.map((id) => `${uname(db, id)} ${task.completions && task.completions[id] ? "✓" : "—"}`).join("  ·  ")}</span>
        </div>
      )}

      {task.extension?.status === "Pending" && (
        <div className="callout">
          <b>Extension requested</b> to {fmtDate(task.extension.newDate)} — {task.extension.reason || "no reason given"}
          {isOwner && <span className="callout-a"><Btn kind="solid" onClick={() => decideExt(true)}>Approve</Btn><Btn onClick={() => decideExt(false)}>Reject</Btn></span>}
        </div>
      )}

      {!locked && (
        <div className="statusbar">
          {TASK_STATUS.map((st) => (
            <button key={st} className={`chip${task.status === st ? " on" : ""}`} onClick={() => setStatus(st)}>
              {st === "Completed" && !isOwner && allIds.length > 1 ? "Mark my part completed" : st}
            </button>
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
              <Field label="Completion date"><input type="date" value={edit.due} onChange={(e) => setEdit({ ...edit, due: e.target.value })} /></Field>
              <Btn kind="solid" onClick={saveEdit}>Save changes</Btn>
            </div>
          )}
        </>
      )}

      <h4>Task chat</h4>
      {!locked && (
        <div className="inline">
          <input placeholder="Message everyone connected to this task…" value={chat} onChange={(e) => setChat(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && postChat()} />
          <Btn kind="solid" onClick={postChat}>Send</Btn>
        </div>
      )}
      {(task.comments || []).length === 0 ? <Empty>No messages yet. Everyone allocated to this task, plus the assignor and the Owner, can chat here.</Empty> : (
        <ul className="feed">{task.comments.map((m, i) => (
          <li key={i}><span className="feed-m">{m.by} · {fmtStamp(m.ts)}</span>{m.text}</li>))}
        </ul>
      )}

      <h4>Subtasks</h4>
      {task.subtasks.length === 0 && <Empty>No subtasks yet. Break the work down if it runs over several days.</Empty>}
      {task.subtasks.map((x) => (
        <label className="subt" key={x.id}>
          <input type="checkbox" checked={x.done} disabled={locked} onChange={() => toggleSub(x.id)} />
          <span className={x.done ? "struck" : ""}>{x.name}</span>
          {x.due && <span className={`subt-due${!x.done && x.due < today() ? " danger" : ""}`}>due {fmtDate(x.due)}</span>}
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
          {task.docs.map((x, i) => (
            <figure key={i}>
              <img src={x.img} alt={`Attached by ${x.by}`} className="thumb-lg" />
              <figcaption>{x.by} · {fmtStamp(x.ts)}<br />{x.lat != null ? `GPS ${x.lat.toFixed(4)}, ${x.lng.toFixed(4)}` : "GPS not captured"}</figcaption>
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

      {isMine && !locked && (
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
      {isOwner && (
        <div className="danger-zone">
          <Btn onClick={() => {
            if (!window.confirm(`Delete ${task.ref} — ${task.name}? This removes it permanently for everyone.`)) return;
            commit((d) => {
              d.tasks = d.tasks.filter((x) => x.id !== task.id);
              pushNotify(d, taskAssignees(task).filter((x) => x !== user.id), `${task.ref} — ${task.name} was deleted by ${user.name}`, "Task deleted", null);
            }, { by: user.name, action: "Task deleted", detail: `${task.ref} ${task.name}` });
            flash("Task deleted"); onClose();
          }}>Delete this task</Btn>
        </div>
      )}
      {locked && <p className="notice">This task is completed and is now read-only for staff. Only the Owner can reopen it or change its status.</p>}
    </Modal>
  );
}

function AssignTask({ db, user, commit, flash, onClose }) {
  const [f, setF] = useState({ entity: "", name: "", desc: "", start: today(), due: addDays(today(), 3) });
  const [picks, setPicks] = useState([]);
  const [subs, setSubs] = useState([]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!f.entity.trim()) return flash("Property / company is required");
    if (!f.name.trim()) return flash("Task name is required");
    if (!picks.length) return flash("Select at least one staff member");
    const ref = "TSK-" + pad(db.tasks.length + 1);
    const idNew = uid("t");
    commit((d) => {
      learn(d, "entities", f.entity);
      d.tasks.push({
        id: idNew, ref, ...f, assignedTo: picks[0], assignees: picks, completions: {},
        priority: "Medium", assignedBy: user.id, created: today(), status: "Not Started",
        subtasks: subs.filter((x) => x.name.trim()).map((x) => ({ id: uid("s"), name: x.name.trim(), due: x.due, done: false })),
        updates: [], comments: [], docs: [], extension: null,
      });
      pushNotify(d, picks.filter((x) => x !== user.id),
        `${user.name} assigned you ${ref} — ${f.name}${picks.length > 1 ? " (group task)" : ""}`,
        "Task assigned", { kind: "task", id: idNew });
    }, { by: user.name, action: "Task assigned", detail: `${ref} to ${picks.map((id) => uname(db, id)).join(", ")}` });
    flash(`${ref} assigned to ${picks.map((id) => uname(db, id)).join(", ")}`); onClose();
  };
  return (
    <Modal title="Assign a task" onClose={onClose}>
      <SmartSelect label="Property / company (required)" value={f.entity} onChange={(v) => setF({ ...f, entity: v })}
        options={db.masters.entities} hint="Anything added under Others appears in this list next time." />
      <Field label="Task name (required)"><input value={f.name} onChange={set("name")} placeholder="e.g. Collect encumbrance certificate" /></Field>
      <Field label="Task description (optional)"><textarea rows={3} value={f.desc} onChange={set("desc")} /></Field>
      <Field label="Task allocated to — select one or more" hint="Selecting several people makes this a group task: it counts as completed only when every member confirms, and everyone shares the task chat.">
        <div className="pick">
          {[...db.users].filter((u) => u.status === "Active").sort((a, b) => a.name.localeCompare(b.name)).map((u) => (
            <label key={u.id} className="check">
              <input type="checkbox" checked={picks.includes(u.id)}
                onChange={(e) => setPicks(e.target.checked ? [...picks, u.id] : picks.filter((x) => x !== u.id))} />
              {u.name} — {u.role}
            </label>
          ))}
        </div>
      </Field>
      <div className="row2">
        <Field label="Start date" hint="Defaults to today"><input type="date" value={f.start} onChange={set("start")} /></Field>
        <Field label="Completion date"><input type="date" value={f.due} onChange={set("due")} /></Field>
      </div>
      <h4>Subtasks with their own completion dates (optional)</h4>
      {subs.map((x, i) => (
        <div className="row2" key={i}>
          <Field label={`Subtask ${i + 1}`}>
            <input value={x.name} onChange={(e) => setSubs(subs.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
          </Field>
          <Field label="Completion date">
            <input type="date" value={x.due} onChange={(e) => setSubs(subs.map((y, j) => (j === i ? { ...y, due: e.target.value } : y)))} />
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
      {!isOwner && (
      <Panel title="Mark attendance" sub={`Reporting location: ${loc.name} · permitted radius ${user.radiusM} m · photo with GPS, date and time is compulsory`}>
        {!me ? (
          <>
            <div className="quick">
              <CameraButton kind="solid" label={busy ? "Saving…" : "Check in — Office (take photo)"} disabled={busy} onShot={(img) => punch("in", "Office", img)} />
              <CameraButton kind="brass" label="Check in (out of office) — take photo" disabled={busy} onShot={(img) => punch("in", "Out of office", img)} />
              <Btn onClick={() => flash("You have not checked in yet today — check in first, and this button will record your check-out")}>Check out (take photo)</Btn>
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
      )}

      {isOwner && (
        <Panel title="Attendance monitoring" sub={`${fmtDate(date)} · tap a photo to verify the face — a missing photo is flagged in alerts`}
          right={<input type="date" value={date} onChange={(e) => setDate(e.target.value)} />}>
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Role</th><th>Status</th><th>In</th><th>Photo</th><th>Distance</th><th>Out</th><th>Hours</th><th>Morning</th><th>Evening</th></tr></thead>
              <tbody>
                {rows.filter(({ u }) => u.role !== OWNER && u.role !== "Contractor").map(({ u, a }) => {
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
                        {a?.inDist != null ? `${a.inDist} m` : a ? "Not captured" : "—"}{a?.mode && a.mode !== "Office" ? " (out of office)" : ""}
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

      {!isOwner && (
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
      )}
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
      pushNotify(d, [d.users.find((x) => x.role === OWNER)?.id],
        `${user.name} applied for ${f.type} leave, ${fmtDate(f.from)} to ${fmtDate(f.to)}`, "Leave", null);
    }, { by: user.name, action: "Leave applied", detail: `${f.type} ${f.from}–${f.to}` });
    setF({ type: "Casual", from: today(), to: today(), reason: "", detail: "", docImg: null });
    flash("Leave request submitted to the Owner");
  };
  const decide = (id, ok) => {
    commit((d) => {
      const l = d.leaves.find((x) => x.id === id);
      l.status = ok ? "Approved" : "Rejected"; l.decidedBy = user.name; l.decidedTs = Date.now();
      if (ok) { const u = d.users.find((x) => x.id === l.userId); u.leaveBalance = Math.max(0, u.leaveBalance - l.days); }
      pushNotify(d, [l.userId], `Your leave (${fmtDate(l.from)} to ${fmtDate(l.to)}) was ${ok ? "approved" : "rejected"} by ${user.name}`, "Leave", null);
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

  const isLegal = user.role === "Legal Associate";
  let rows = isOwner || isLegal ? db.cases : db.cases.filter((c) => c.associate === user.id);
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
      <Panel title="Legal cases" sub={`${rows.length} matter(s)`} right={(isOwner || user.role === "Legal Associate") && <Btn kind="solid" onClick={() => setCreating(true)}>Add case</Btn>}>
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
                  <td><b>{titleCase(c.title)}</b><i className="sub">{c.type}</i></td>
                  <td>{c.court}</td><td>{uname(db, c.associate)}</td>
                  <td><Badge t={c.stage === "Disposed" ? "grey" : "blue"}>{c.stage}</Badge></td>
                  <td>{c.nextHearing ? fmtDate(c.nextHearing) : <Badge t="orange">Not entered</Badge>}</td>
                  <td>{titleCase(c.nextAction)}</td>
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
      x.nextAction = titleCase(f.nextAction); x.orderCopy = f.orderCopy || f.orderFiles.length > 0; x.orderFiles = f.orderFiles;
      learn(d, "caseStages", f.stage); learn(d, "nextActions", f.nextAction);
      pushNotify(d, [d.users.find((u) => u.role === OWNER)?.id, x.associate].filter((id) => id !== user.id),
        `${c.caseNo}: ${f.text.slice(0, 80)}${f.nextHearing ? ` · next hearing ${fmtDate(f.nextHearing)}` : ""}`,
        "Case update", { kind: "case", id: c.id });
    }, { by: user.name, action: "Case updated", detail: c.caseNo });
    flash("Case updated — the Owner's calendar entry moves with the new hearing date");
    setF({ ...f, text: "" });
  };
  const [docLabel, setDocLabel] = useState("Order copy");
  const addDoc = async (e) => {
    const fl = e.target.files[0];
    if (!fl) return;
    e.target.value = "";
    if (fl.size > 4 * 1024 * 1024) return flash("This file is over 4 MB — photograph the pages or compress the PDF and try again");
    let data = null;
    try {
      if (/^image\//.test(fl.type)) data = await compressImage(fl, 1100, 0.75);
      else data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(fl); });
    } catch { data = null; }
    if (!data) return flash("The file could not be read — try a photo or a PDF");
    const lbl = (docLabel || "Document").trim();
    commit((d) => {
      const x = d.cases.find((y) => y.id === c.id);
      x.docs = x.docs || [];
      x.docs.unshift({ ts: Date.now(), by: user.name, name: fl.name, label: lbl, data });
      if (/order|judgment|decree/i.test(lbl)) x.orderCopy = true;
      d.masters.caseDocTypes = d.masters.caseDocTypes || [];
      learn(d, "caseDocTypes", lbl);
      pushNotify(d, [d.users.find((u) => u.role === OWNER)?.id, x.associate].filter((id) => id && id !== user.id),
        `${c.caseNo}: ${lbl} uploaded (${fl.name}) by ${user.name}`, "Case document", { kind: "case", id: c.id });
    }, { by: user.name, action: "Case document uploaded", detail: `${c.caseNo} · ${lbl} · ${fl.name}` });
    flash(`${lbl} attached to the case`);
  };
  return (
    <Modal title={`${c.caseNo} — ${titleCase(c.title)}`} onClose={onClose} wide>
      <div className="kv">
        <div><span>Court</span><b>{c.court}</b></div>
        <div><span>Bench / judge</span><b>{c.bench} · {c.judge}</b></div>
        <div><span>Type / sections</span><b>{c.type} · {c.sections}</b></div>
        <div><span>Petitioner(s)</span><b>{[c.petitioner, ...(c.morePetitioners || [])].filter(Boolean).join("; ")}</b></div>
        <div><span>Respondent(s)</span><b>{[c.respondent, ...(c.moreRespondents || [])].filter(Boolean).join("; ")}</b></div>
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
      <Btn kind="solid" full onClick={save}>Save case update</Btn>

      <h4>Documents on record</h4>
      {!(c.docs || []).length ? <Empty>No files uploaded on this matter yet.</Empty> : (
        <ul className="feed">
          {c.docs.map((d0, i) => (
            <li key={i}>
              <span className="feed-m">{d0.label} · {d0.by} · {fmtStamp(d0.ts)}</span>
              {/^data:image/.test(d0.data) && <img src={d0.data} alt={d0.name} className="thumb-lg" style={{ display: "block", margin: "6px 0" }} />}
              <a href={d0.data} download={d0.name}>{d0.name} — open / download</a>
            </li>
          ))}
        </ul>
      )}
      <div className="row2">
        <SmartSelect label="Document type" value={docLabel} onChange={setDocLabel}
          options={[...new Set(["Order copy", "Judgment", "Petition", "Counter", "Rejoinder", "Evidence", "Vakalat", "Notice", ...(db.masters.caseDocTypes || [])])]}
          hint="Pick a type or add your own under Others — new types join this list automatically." />
        <Field label="Upload the file (image or PDF, up to 4 MB)">
          <input type="file" accept="image/*,application/pdf" onChange={addDoc} />
        </Field>
      </div>

      <h4>Case history</h4>
      {c.updates.length === 0 ? <Empty>No updates recorded on this matter yet.</Empty> : (
        <ul className="feed">{c.updates.map((u, i) => (
          <li key={i}><span className="feed-m">{u.by} · {fmtStamp(u.ts)} · {u.stage}{u.nextAction ? ` · ${u.nextAction}` : ""}</span>{u.text}
            {u.nextHearing && <i className="sub">Next hearing set to {fmtDate(u.nextHearing)}</i>}</li>))}
        </ul>
      )}
      {user.role === OWNER && (
        <div className="danger-zone">
          <Btn onClick={() => {
            if (!window.confirm(`Delete case ${c.caseNo || c.title}? The entire record, updates and documents are removed permanently.`)) return;
            commit((d) => {
              d.cases = d.cases.filter((x) => x.id !== c.id);
              pushNotify(d, [c.associate].filter((x) => x && x !== user.id), `Case ${c.caseNo || c.title} was deleted by ${user.name}`, "Case deleted", null);
            }, { by: user.name, action: "Case deleted", detail: c.caseNo || c.title });
            flash("Case deleted"); onClose();
          }}>Delete this case</Btn>
        </div>
      )}
    </Modal>
  );
}

function AddCase({ db, user, commit, flash, onClose }) {
  const [f, setF] = useState({
    title: "", caseNo: "", type: "", court: "", bench: "", judge: "", sections: "", petitioner: "", respondent: "",
    morePetitioners: [], moreRespondents: [],
    counsel: "", associate: "", entity: "", stage: "Appearance Stage", status: "", lastHearing: "", nextHearing: "",
    nextAction: "", filingDeadline: "", briefingDate: "", conferenceDate: "", priority: "Medium", risk: "Medium",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setList = (k, i, v) => setF({ ...f, [k]: f[k].map((x, j) => (j === i ? v : x)) });
  const save = () => {
    if (!f.caseNo.trim() || !f.title.trim() || !f.associate) return flash("Case number, title and associate are required");
    const ref = "CASE-" + pad(db.cases.length + 1);
    commit((d) => {
      learn(d, "caseTypes", f.type); learn(d, "courts", f.court); learn(d, "judges", f.judge);
      learn(d, "counsels", f.counsel); learn(d, "sections", f.sections); learn(d, "entities", f.entity);
      learn(d, "caseStages", f.stage);
      d.cases.push({
        id: uid("c"), ref, ...f,
        morePetitioners: f.morePetitioners.filter((x) => x.trim()),
        moreRespondents: f.moreRespondents.filter((x) => x.trim()),
        orderCopy: false, orderFiles: [], updates: [],
      });
      pushNotify(d, [f.associate].filter((id) => id !== user.id), `New case assigned to you: ${f.caseNo} — ${f.title}`, "Case assigned", null);
    }, { by: user.name, action: "Case added", detail: f.caseNo });
    flash(`${f.caseNo} added`); onClose();
  };
  return (
    <Modal title="Add a legal case" onClose={onClose} wide>
      <Field label="Case title"><input value={f.title} onChange={set("title")} placeholder="e.g. Revanza Estates v. …" /></Field>
      <div className="row2">
        <Field label="Case number"><input value={f.caseNo} onChange={set("caseNo")} placeholder="OS 214/2024" /></Field>
        <SmartSelect label="Case type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={db.masters.caseTypes || []}
          hint="Anything added under Others joins this list next time." />
      </div>

      <Field label="Petitioner"><input value={f.petitioner} onChange={set("petitioner")} /></Field>
      {f.morePetitioners.map((x, i) => (
        <Field key={"p" + i} label={`Additional petitioner ${i + 2}`}>
          <input value={x} onChange={(e) => setList("morePetitioners", i, e.target.value)} />
        </Field>
      ))}
      <div className="quick" style={{ marginBottom: 13 }}>
        <Btn onClick={() => setF({ ...f, morePetitioners: [...f.morePetitioners, ""] })}>Add another petitioner</Btn>
        {f.morePetitioners.length > 0 && <Btn onClick={() => setF({ ...f, morePetitioners: f.morePetitioners.slice(0, -1) })}>Remove</Btn>}
      </div>

      <Field label="Respondent"><input value={f.respondent} onChange={set("respondent")} /></Field>
      {f.moreRespondents.map((x, i) => (
        <Field key={"r" + i} label={`Additional respondent ${i + 2}`}>
          <input value={x} onChange={(e) => setList("moreRespondents", i, e.target.value)} />
        </Field>
      ))}
      <div className="quick" style={{ marginBottom: 13 }}>
        <Btn onClick={() => setF({ ...f, moreRespondents: [...f.moreRespondents, ""] })}>Add another respondent</Btn>
        {f.moreRespondents.length > 0 && <Btn onClick={() => setF({ ...f, moreRespondents: f.moreRespondents.slice(0, -1) })}>Remove</Btn>}
      </div>

      <SmartSelect label="Court" value={f.court} onChange={(v) => setF({ ...f, court: v })} options={db.masters.courts} />
      <div className="row2">
        <SmartSelect label="Judge" value={f.judge} onChange={(v) => setF({ ...f, judge: v })} options={db.masters.judges} />
        <Field label="Bench"><input value={f.bench} onChange={set("bench")} /></Field>
      </div>
      <SmartSelect label="Applicable sections" value={f.sections} onChange={(v) => setF({ ...f, sections: v })} options={db.masters.sections} />
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
        <SmartSelect label="Stage" value={f.stage} onChange={(v) => setF({ ...f, stage: v })}
          options={[...new Set([...CASE_STAGE, ...db.masters.caseStages])]}
          hint="Add a new stage under Others — it joins this list for next time." />
        <Field label="Next hearing date"><input type="date" value={f.nextHearing} onChange={set("nextHearing")} /></Field>
      </div>
      <Field label="Filing deadline (if any)"><input type="date" value={f.filingDeadline} onChange={set("filingDeadline")} /></Field>
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
    db.tasks.filter((x) => x.due === date && x.status !== "Completed" && (isOwner || mineTask(x, user.id)))
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

function Notifications({ db, user, commit, go }) {
  const mine = (db.notifications || []).filter((n) => n.userId === user.id);
  const unread = mine.filter((n) => !n.read);
  const markAll = () => commit((d) => { d.notifications.forEach((n) => { if (n.userId === user.id) n.read = true; }); });
  const open = (n) => {
    commit((d) => { const x = d.notifications.find((y) => y.id === n.id); if (x) x.read = true; });
    if (n.ref) go(n.ref.kind === "case" ? "cases" : "tasks", null, n.ref);
  };
  return (
    <Panel title="Notifications" sub={`${unread.length} unread`} pad={false}
      right={unread.length > 0 && <Btn onClick={markAll}>Mark all read</Btn>}>
      {mine.length === 0 ? (
        <div className="panel-b"><Empty>Nothing yet. You'll be notified here when tasks are assigned to you, statuses change, someone messages a task chat, cases are updated, and leave is decided.</Empty></div>
      ) : (
        <ul className="board">
          {mine.slice(0, 100).map((n) => (
            <li key={n.id} className={`board-row${n.read ? "" : " r-orange"}`}>
              <div className="board-main">
                <span className="board-type">{n.kind || "Update"} · {fmtStamp(n.ts)}</span>
                <span className="board-sub" style={{ whiteSpace: "normal" }}>{n.text}</span>
              </div>
              {n.ref ? <Btn onClick={() => open(n)}>Open</Btn>
                : !n.read && <Btn onClick={() => commit((d) => { const x = d.notifications.find((y) => y.id === n.id); if (x) x.read = true; })}>Read</Btn>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
    const raw = String(f.mobile || "").trim();
    const mob = cleanMobile(raw);
    if (raw && raw !== "Pending Information" && mob.length !== 10)
      return flash("The mobile number must contain exactly 10 digits — remove +91, spaces or dashes");
    commit((d) => {
      const x = d.users.find((y) => y.id === u.id);
      Object.assign(x, {
        mobile: mob.length === 10 ? mob : "Pending Information", altMobile: f.altMobile, email: f.email, role: f.role, dept: f.dept,
        designation: f.designation, workStart: f.workStart, workEnd: f.workEnd,
        graceMins: Number(f.graceMins), radiusM: Number(f.radiusM), leaveBalance: Number(f.leaveBalance),
        salary: f.salary, salaryType: f.salaryType, incentivePerHour: Number(f.incentivePerHour),
        weeklyOff: f.weeklyOff || "Sunday", salaryStartDay: Number(f.salaryStartDay) || "", salaryEndDay: Number(f.salaryEndDay) || "", name: (f.name || "").trim() || u.name,
        firm: f.firm || "", workType: f.workType || "",
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
      <Field label="Employee name"><input value={f.name} onChange={set("name")} /></Field>
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
          {[OWNER, "Legal Associate", "Engineer", "Drawings", "Executive", "Accounts", "Payments", "Admin", "Contractor"].map((r) => <option key={r}>{r}</option>)}
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
        <Field label="OT charges (₹ per hour)"><input type="number" value={f.incentivePerHour} onChange={set("incentivePerHour")} /></Field>
      </div>
      <div className="row2">
        <Field label="Salary start day (1–31)" hint="The day of every month the salary cycle starts — usually 1"><input type="number" min={1} max={31} value={f.salaryStartDay || ""} onChange={set("salaryStartDay")} /></Field>
        <Field label="Salary end day (1–31)" hint="Blank = up to month end"><input type="number" min={1} max={31} value={f.salaryEndDay || ""} onChange={set("salaryEndDay")} /></Field>
      </div>
      <div className="row2">
        <Field label="Firm / company (for contractors)"><input value={f.firm || ""} onChange={set("firm")} /></Field>
        <Field label="Work type (for contractors)"><input value={f.workType || ""} onChange={set("workType")} placeholder="e.g. Electrical, Civil, Fabrication" /></Field>
      </div>
      <Field label="Weekly off day">
        <select value={f.weeklyOff || "Sunday"} onChange={set("weeklyOff")}>
          {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d0) => <option key={d0}>{d0}</option>)}
        </select>
      </Field>
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
    const mob = cleanMobile(f.mobile);
    if (String(f.mobile || "").trim() && mob.length !== 10)
      return flash("The mobile number must contain exactly 10 digits — remove +91, spaces or dashes");
    if (mob && db.users.some((u) => cleanMobile(u.mobile) === mob)) return flash("That mobile number is already registered to someone else");
    const empCode = "EMP" + pad(db.users.length + 1);
    const id = LIVE ? crypto.randomUUID() : empCode;
    commit((d) => d.users.push({
      id, empCode, name: f.name, role: f.role, dept: f.dept || "—", designation: f.role,
      email: f.email || PENDING, mobile: mob.length === 10 ? mob : PENDING, altMobile: PENDING, manager: "Sushil",
      doj: today(), status: "Active", pin: "1234", mustChangePin: !LIVE, failed: 0, locked: false, logins: [],
      workStart: "09:30", workEnd: "18:30", graceMins: 15, weeklyOff: "Sunday", locationId: "LOC1",
      radiusM: 250, salary: "", salaryType: "Monthly", incentivePerHour: 0, leaveBalance: 12,
    }), { by: user.name, action: "User added", detail: f.name });
    flash(`${f.name} added with temporary PIN 1234`); onClose();
  };
  return (
    <Modal title="Add a user" onClose={onClose}>
      <Field label="Full name"><input value={f.name} onChange={set("name")} /></Field>
      <Field label="Role"><select value={f.role} onChange={set("role")}>
        {["Legal Associate", "Engineer", "Drawings", "Executive", "Accounts", "Payments", "Admin", "Contractor"].map((r) => <option key={r}>{r}</option>)}
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

/* ============================ ACCOUNTS ============================ */
function Accounts({ db, user, commit, flash }) {
  const [tab, setTab] = useState("overview");
  const tabs = [
    ["overview", "Investor overview"], ["banks", "Bank accounts"], ["statement", "Account statement"],
    ["entry", "New entry"], ["import", "Import bank statement"], ["entries", "Receipts & payments"], ["ledger", "Ledger statement"],
  ];
  return (
    <>
      <div className="statusbar" style={{ marginTop: 0 }}>
        {tabs.map(([k, l]) => <button key={k} className={`chip${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "overview" && <AcctOverview db={db} />}
      {tab === "banks" && <BankAccounts db={db} user={user} commit={commit} flash={flash} />}
      {tab === "statement" && <AcctStatement db={db} user={user} />}
      {tab === "entry" && <ManualEntry db={db} user={user} commit={commit} flash={flash} />}
      {tab === "import" && <ImportStatement db={db} user={user} commit={commit} flash={flash} />}
      {tab === "entries" && <EntriesTable db={db} user={user} commit={commit} flash={flash} />}
      {tab === "ledger" && <LedgerStatement db={db} user={user} />}
    </>
  );
}

function AcctOverview({ db }) {
  const accts = db.accounts || [], entries = db.entries || [];
  const month = today().slice(0, 7);
  const inMonth = entries.filter((e) => (e.date || "").slice(0, 7) === month);
  const rec = inMonth.filter((e) => e.type === "Receipt").reduce((a, e) => a + e.amount, 0);
  const pay = inMonth.filter((e) => e.type === "Payment").reduce((a, e) => a + e.amount, 0);
  const liveBal = (a) => (Number(a.balance) || 0)
    + entries.filter((e) => e.accountId === a.id && e.type === "Receipt").reduce((x, e) => x + e.amount, 0)
    - entries.filter((e) => e.accountId === a.id && e.type === "Payment").reduce((x, e) => x + e.amount, 0);
  const totalBal = accts.reduce((a, x) => a + liveBal(x), 0);
  const companies = [...new Set(accts.map((a) => a.company))];
  return (
    <>
      <div className="grid-4">
        <Stat n={inr(totalBal)} label="Cumulative bank balance (all accounts)" t="green" />
        <Stat n={inr(rec)} label="Receipts this month" t="blue" />
        <Stat n={inr(pay)} label="Payments this month" t="orange" />
        <Stat n={inr(rec - pay)} label="Net this month" t={rec - pay >= 0 ? "green" : "red"} />
      </div>
      {accts.length === 0 ? <Panel title="Bank accounts"><Empty>No bank accounts recorded yet. The Payments head adds them under the Bank accounts tab.</Empty></Panel> :
        companies.map((co) => (
          <Panel key={co} title={co || "—"} sub={`${accts.filter((a) => a.company === co).length} account(s)`}>
            <div className="scroll-x">
              <table className="tbl">
                <thead><tr><th>Account name</th><th>Bank</th><th>Branch</th><th>Account no.</th><th>IFSC / RTGS</th><th className="amt">Current balance</th><th className="amt">Receipts (month)</th><th className="amt">Payments (month)</th></tr></thead>
                <tbody>
                  {accts.filter((a) => a.company === co).map((a) => {
                    const em = inMonth.filter((e) => e.accountId === a.id);
                    return (
                      <tr key={a.id}>
                        <td><b>{a.accountName}</b></td><td>{a.bankName}</td><td>{a.branch}</td>
                        <td className="mono">{a.accountNo}</td><td className="mono">{a.ifsc}</td>
                        <td className="amt"><b>{inr(liveBal(a))}</b></td>
                        <td className="amt">{inr(em.filter((e) => e.type === "Receipt").reduce((x, e) => x + e.amount, 0))}</td>
                        <td className="amt">{inr(em.filter((e) => e.type === "Payment").reduce((x, e) => x + e.amount, 0))}</td>
                      </tr>
                    );
                  })}
                  <tr><td colSpan={5}><b>Company total</b></td>
                    <td className="amt"><b>{inr(accts.filter((a) => a.company === co).reduce((x, a) => x + liveBal(a), 0))}</b></td>
                    <td colSpan={2}></td></tr>
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
      <Panel title="Recent entries" sub="Latest 10 across all accounts">
        {entries.length === 0 ? <Empty>No receipts or payments recorded yet.</Empty> : (
          <table className="tbl">
            <thead><tr><th>Date</th><th>Type</th><th>Particulars</th><th>Ledger</th><th className="amt">Amount</th></tr></thead>
            <tbody>
              {[...entries].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 10).map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.date)}</td>
                  <td><Badge t={e.type === "Receipt" ? "green" : "orange"}>{e.type}</Badge></td>
                  <td>{e.desc}</td><td>{e.ledger || <span className="muted">untagged</span>}</td>
                  <td className="amt">{inr(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function Companies({ db, user, commit, flash }) {
  const list = db.companies || [];
  const accts = db.accounts || [];
  const blank = { name: "", address: "", gst: "", pan: "", cin: "", contact: "", notes: "" };
  const [f, setF] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!f.name.trim()) return flash("Company name is required");
    const dupe = list.some((c) => c.id !== f.id && c.name.toLowerCase() === f.name.trim().toLowerCase());
    if (dupe) return flash("A company with this name already exists");
    commit((d) => {
      learn(d, "entities", f.name);
      if (f.id) { const x = d.companies.find((y) => y.id === f.id); Object.assign(x, f, { name: f.name.trim() }); }
      else d.companies.push({ ...f, id: uid("co"), name: f.name.trim() });
    }, { by: user.name, action: f.id ? "Company updated" : "Company added", detail: f.name });
    flash("Saved"); setF(null);
  };
  const del = (c) => {
    if (accts.some((a) => a.company === c.name)) return flash("This company has bank accounts — move or delete those first");
    if (!window.confirm(`Delete company "${c.name}"?`)) return;
    commit((d) => { d.companies = d.companies.filter((x) => x.id !== c.id); },
      { by: user.name, action: "Company deleted", detail: c.name });
    flash("Company deleted");
  };
  return (
    <Panel title="Companies" sub="Master list used across bank accounts and the investor overview — maintained by the Payments head and MD"
      right={<Btn kind="solid" onClick={() => setF({ ...blank })}>Add company</Btn>}>
      {list.length === 0 ? <Empty>No companies yet. Adding a bank account also creates its company here automatically.</Empty> : (
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th>Company</th><th>GST</th><th>PAN</th><th>CIN</th><th>Contact</th><th>Bank accounts</th><th></th></tr></thead>
            <tbody>{[...list].sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b>{c.address && <i className="sub">{c.address.slice(0, 60)}</i>}</td>
                <td className="mono">{c.gst || "—"}</td><td className="mono">{c.pan || "—"}</td><td className="mono">{c.cin || "—"}</td>
                <td>{c.contact || "—"}</td>
                <td>{accts.filter((a) => a.company === c.name).length}</td>
                <td><Btn onClick={() => setF({ ...blank, ...c })}>Edit</Btn><Btn onClick={() => del(c)}>Delete</Btn></td>
              </tr>))}
            </tbody>
          </table>
        </div>
      )}
      {f && (
        <Modal title={f.id ? "Edit company" : "Add company"} onClose={() => setF(null)}>
          <Field label="Company name"><input value={f.name} onChange={set("name")} /></Field>
          <Field label="Registered address"><textarea rows={2} value={f.address} onChange={set("address")} /></Field>
          <div className="row2">
            <Field label="GST number"><input value={f.gst} onChange={set("gst")} /></Field>
            <Field label="PAN"><input value={f.pan} onChange={set("pan")} /></Field>
          </div>
          <div className="row2">
            <Field label="CIN (if company)"><input value={f.cin} onChange={set("cin")} /></Field>
            <Field label="Contact person / number"><input value={f.contact} onChange={set("contact")} /></Field>
          </div>
          <Field label="Notes"><textarea rows={2} value={f.notes} onChange={set("notes")} /></Field>
          <Btn kind="solid" full onClick={save}>Save company</Btn>
        </Modal>
      )}
    </Panel>
  );
}

function AcctStatement({ db, user }) {
  const accts = db.accounts || [], entries = db.entries || [];
  const [sel, setSel] = useState(accts.map((a) => a.id));
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const toggle = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const rows = entries
    .filter((e) => sel.includes(e.accountId))
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.ts || 0) - (b.ts || 0));
  // opening = the accounts' stated opening balances + every entry BEFORE the visible period,
  // so the running column reconciles with the bank's own closing balance
  const opening = accts.filter((a) => sel.includes(a.id)).reduce((x, a) => x + (Number(a.balance) || 0), 0)
    + entries.filter((e) => sel.includes(e.accountId) && from && e.date < from)
      .reduce((x, e) => x + (e.type === "Receipt" ? e.amount : -e.amount), 0);
  let run = opening;
  const lines = rows.map((e) => { run += e.type === "Receipt" ? e.amount : -e.amount; return { ...e, run }; });
  const tRec = rows.filter((e) => e.type === "Receipt").reduce((a, e) => a + e.amount, 0);
  const tPay = rows.filter((e) => e.type === "Payment").reduce((a, e) => a + e.amount, 0);
  const acctName = (id) => { const a = accts.find((x) => x.id === id); return a ? a.accountName : "—"; };
  const single = sel.length === 1 ? accts.find((a) => a.id === sel[0]) : null;
  const dl = () => downloadCSV(`statement-${today()}.csv`,
    [["Date", "Account", "Particulars", "Ledger", "Category", "Receipt", "Payment", "Running", "Source"],
    ...lines.map((e) => [e.date, acctName(e.accountId), e.desc, e.ledger || "", e.category || "", e.type === "Receipt" ? e.amount : "", e.type === "Payment" ? e.amount : "", e.run, e.source]),
    [], ["Opening balance", "", "", "", "", "", "", opening, ""], ["Totals", "", "", "", "", tRec, tPay, "", ""], ["Closing balance", "", "", "", "", "", "", run, ""]],
    [`Revanza — ${single ? `Statement: ${single.company} / ${single.accountName}` : `Combined statement (${sel.length} accounts)`}`,
    `Generated ${new Date().toLocaleString("en-GB")} by ${user.name}`, "Confidential — internal circulation only"]);
  return (
    <Panel title={single ? `Statement — ${single.company} / ${single.accountName}` : `Combined statement — ${sel.length} of ${accts.length} accounts`}
      sub="Tick one account for its individual statement, or several for a combined view. The balance column starts from the account's opening balance plus everything before the chosen period, so it reconciles with the bank's closing balance."
      right={lines.length > 0 && <Btn kind="solid" onClick={dl}>Download CSV</Btn>}>
      <div className="quick" style={{ marginBottom: 12 }}>
        {accts.map((a) => (
          <button key={a.id} className={`chip${sel.includes(a.id) ? " on" : ""}`} onClick={() => toggle(a.id)}>{a.accountName}</button>
        ))}
        {accts.length > 1 && <>
          <Btn onClick={() => setSel(accts.map((a) => a.id))}>All</Btn>
          <Btn onClick={() => setSel([])}>None</Btn>
        </>}
      </div>
      <div className="filters">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {single && (
        <div className="kv" style={{ marginBottom: 6 }}>
          <div><span>Bank</span><b>{single.bankName} · {single.branch}</b></div>
          <div><span>Account no.</span><b className="mono">{single.accountNo}</b></div>
          <div><span>IFSC / RTGS</span><b className="mono">{single.ifsc}</b></div>
          <div><span>Opening balance</span><b>{inr(single.balance)}</b></div>
          <div><span>Closing balance (period)</span><b>{inr(run)}</b></div>
          {single.lastStatementDate && <div><span>Bank's closing ({fmtDate(single.lastStatementDate)})</span><b>{inr(single.lastStatementClosing)}</b></div>}
        </div>
      )}
      {accts.length === 0 ? <Empty>Add bank accounts first.</Empty> :
        lines.length === 0 ? <Empty>No entries for this selection and period.</Empty> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Date</th>{!single && <th>Account</th>}<th>Particulars</th><th>Ledger</th><th className="amt">Receipt</th><th className="amt">Payment</th><th className="amt">{single ? "Bank balance / running" : "Running"}</th></tr></thead>
              <tbody>
                {lines.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtDate(e.date)}</td>
                    {!single && <td>{acctName(e.accountId)}</td>}
                    <td>{e.desc}{e.ref && <i className="sub mono">{e.ref}</i>}</td>
                    <td>{e.ledger || <span className="muted">—</span>}</td>
                    <td className="amt">{e.type === "Receipt" ? inr(e.amount) : ""}</td>
                    <td className="amt">{e.type === "Payment" ? inr(e.amount) : ""}</td>
                    <td className={`amt ${e.run < 0 ? "danger" : ""}`}>{single && e.bal ? e.bal : inr(e.run)}</td>
                  </tr>
                ))}
                <tr><td colSpan={single ? 3 : 4}><b>Opening balance</b></td><td></td><td></td><td className="amt"><b>{inr(opening)}</b></td></tr>
                <tr><td colSpan={single ? 3 : 4}><b>Totals for the period</b></td><td className="amt"><b>{inr(tRec)}</b></td><td className="amt"><b>{inr(tPay)}</b></td><td></td></tr>
                <tr><td colSpan={single ? 3 : 4}><b>Closing balance</b></td><td></td><td></td><td className={`amt ${run < 0 ? "danger" : ""}`}><b>{inr(run)}</b></td></tr>
              </tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}

function BankAccounts({ db, user, commit, flash }) {
  const accts = db.accounts || [];
  const blank = { company: "", accountName: "", accountNo: "", bankName: "", branch: "", ifsc: "", balance: "" };
  const [f, setF] = useState(null); // null = closed, {..., id?} = editing/adding
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!f.company.trim() || !f.accountName.trim() || !f.bankName.trim()) return flash("Company, account name and bank name are required");
    commit((d) => {
      const nm = f.company.trim();
      if (nm && !(d.companies || []).some((c) => c.name.toLowerCase() === nm.toLowerCase()))
        d.companies.push({ id: uid("co"), name: nm, gstin: "", cin: "", pan: "", address: "", notes: "" });
      if (f.id) { const x = d.accounts.find((y) => y.id === f.id); Object.assign(x, f, { balance: parseAmt(f.balance) }); }
      else d.accounts.push({ ...f, id: uid("ba"), balance: parseAmt(f.balance) });
    }, { by: user.name, action: f.id ? "Bank account updated" : "Bank account added", detail: `${f.company} · ${f.accountName}` });
    flash("Saved"); setF(null);
  };
  return (
    <Panel title="Bank accounts" sub="Company, bank and balance details — updated by the Payments head"
      right={<Btn kind="solid" onClick={() => setF({ ...blank })}>Add bank account</Btn>}>
      {accts.length === 0 ? <Empty>No bank accounts yet.</Empty> : (
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th>Company</th><th>Account name</th><th>Bank</th><th>Branch</th><th>Account no.</th><th>IFSC / RTGS</th><th className="amt">Balance</th><th></th></tr></thead>
            <tbody>{accts.map((a) => (
              <tr key={a.id}>
                <td>{a.company}</td><td><b>{a.accountName}</b></td><td>{a.bankName}</td><td>{a.branch}</td>
                <td className="mono">{a.accountNo}</td><td className="mono">{a.ifsc}</td>
                <td className="amt"><b>{inr(a.balance)}</b></td>
                <td><Btn onClick={() => setF({ ...a, balance: String(a.balance) })}>Edit</Btn></td>
              </tr>))}
            </tbody>
          </table>
        </div>
      )}
      {f && (
        <Modal title={f.id ? "Edit bank account" : "Add bank account"} onClose={() => setF(null)}>
          <SmartSelect label="Company name" value={f.company} onChange={(v) => setF({ ...f, company: v })} options={(db.companies || []).map((c) => c.name)} hint="This list is the Accounts company master — separate from the task/property dropdown. New names typed under Others join it automatically." />
          <Field label="Bank account name"><input value={f.accountName} onChange={set("accountName")} placeholder="e.g. Revanza Estates — Current A/c" /></Field>
          <div className="row2">
            <Field label="Bank name"><input value={f.bankName} onChange={set("bankName")} /></Field>
            <Field label="Branch name"><input value={f.branch} onChange={set("branch")} /></Field>
          </div>
          <div className="row2">
            <Field label="Account number"><input value={f.accountNo} onChange={set("accountNo")} inputMode="numeric" /></Field>
            <Field label="IFSC / RTGS code"><input value={f.ifsc} onChange={set("ifsc")} /></Field>
          </div>
          <Field label="Bank balance (₹)"><input value={f.balance} onChange={set("balance")} inputMode="decimal" /></Field>
          <Btn kind="solid" full onClick={save}>Save</Btn>
        </Modal>
      )}
    </Panel>
  );
}

function ManualEntry({ db, user, commit, flash }) {
  const accts = db.accounts || [];
  const [f, setF] = useState({ accountId: "", date: today(), type: "Payment", amount: "", desc: "", ledger: "", category: "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!f.accountId) return flash("Choose a bank account");
    const amt = parseAmt(f.amount);
    if (!amt) return flash("Enter the amount");
    if (!f.desc.trim()) return flash("Enter the particulars (who / what for)");
    commit((d) => {
      learn(d, "ledgers", f.ledger); learn(d, "categories", f.category);
      d.entries.push({ id: uid("e"), accountId: f.accountId, date: f.date, type: f.type, amount: amt, desc: f.desc, ledger: f.ledger, category: f.category, source: "Manual", ref: "", ts: Date.now(), by: user.name });
      pushNotify(d, [d.users.find((u2) => u2.role === OWNER)?.id].filter((id) => id !== user.id),
        `${user.name} recorded a ${f.type.toLowerCase()} of ${inr(amt)} — ${f.desc.slice(0, 60)}`, "Accounts", null);
    }, { by: user.name, action: `${f.type} recorded`, detail: `${inr(amt)} · ${f.desc.slice(0, 40)}` });
    flash(`${f.type} of ${inr(amt)} recorded`);
    setF({ ...f, amount: "", desc: "" });
  };
  if (accts.length === 0) return <Panel title="New entry"><Empty>Add a bank account first, under the Bank accounts tab.</Empty></Panel>;
  return (
    <Panel title="Record a receipt or payment" sub="Manual entry — if the same transaction later arrives in a bank statement import, the statement is treated as accurate and this entry's ledger and category are carried onto it.">
      <div className="row2">
        <Field label="Bank account">
          <select value={f.accountId} onChange={set("accountId")}>
            <option value="">Select</option>
            {accts.map((a) => <option key={a.id} value={a.id}>{a.company} — {a.accountName}</option>)}
          </select>
        </Field>
        <Field label="Type"><select value={f.type} onChange={set("type")}><option>Payment</option><option>Receipt</option></select></Field>
      </div>
      <div className="row2">
        <Field label="Date"><input type="date" value={f.date} onChange={set("date")} /></Field>
        <Field label="Amount (₹)"><input value={f.amount} onChange={set("amount")} inputMode="decimal" /></Field>
      </div>
      <Field label="Particulars"><input value={f.desc} onChange={set("desc")} placeholder="Paid to / received from, and what for" /></Field>
      <div className="row2">
        <SmartSelect label="Ledger name" value={f.ledger} onChange={(v) => setF({ ...f, ledger: v })} options={db.masters.ledgers || []} hint="New entries under Others join the list." />
        <SmartSelect label="Category" value={f.category} onChange={(v) => setF({ ...f, category: v })} options={db.masters.categories || []} />
      </div>
      <Btn kind="solid" full onClick={save}>Record entry</Btn>
    </Panel>
  );
}

function ImportStatement({ db, user, commit, flash }) {
  const accts = db.accounts || [];
  const [accountId, setAccountId] = useState("");
  const [rows, setRows] = useState(null);
  const [hdrIdx, setHdrIdx] = useState(0);
  const [map, setMap] = useState({ date: -1, desc: -1, debit: -1, credit: -1, amount: -1, drcr: -1, ref: -1, balance: -1 });
  const [fname, setFname] = useState("");
  const [det, setDet] = useState(null);
  const [newAcc, setNewAcc] = useState({ company: "", accountName: "" });
  const fileRef = React.useRef(null);

  const loadRows = (r, name) => {
    const clean = r.filter((row) => row.some((c) => String(c || "").trim() !== ""));
    if (clean.length < 2) return flash("Could not read a transaction table from this file");
    const hi = findHeaderRow(clean);
    setRows(clean); setHdrIdx(hi < 0 ? 0 : hi);
    setMap(guessColumns((clean[hi < 0 ? 0 : hi] || []).map((c) => String(c || ""))));
    setFname(name);
    // scrape account details from the preamble above the transaction table
    const pre = clean.slice(0, Math.max(1, (hi < 0 ? 0 : hi) + 1)).flat().map((c) => String(c || "")).join(" | ");
    const g = (re) => { const m = pre.match(re); return m ? String(m[1]).trim() : ""; };
    const bankM = name.match(/pnb|punjab|icici|hdfc|sbi|state bank|axis|kotak|idfc|iob|indian overseas|yes/i);
    setDet({
      accountNo: g(/account\s*(?:no|number)[^0-9]{0,12}(\d{9,18})/i) || g(/\bA\/?C\b[^0-9]{0,12}(\d{9,18})/i),
      ifsc: g(/\b([A-Z]{4}0[A-Z0-9]{6})\b/),
      branch: g(/branch(?:\s*name)?\s*[:\-]\s*([A-Za-z0-9 ,.\-()]{3,40})/i),
      holder: g(/(?:account\s*name|customer\s*name)\s*[:\-]\s*([A-Za-z0-9 &.\-]{3,60})/i),
      bank: bankM ? bankM[0].toUpperCase() : "",
    });
  };
  const createFromStatement = () => {
    if (!newAcc.company.trim()) return flash("Choose or type the company this account belongs to");
    const id = uid("ba");
    commit((d) => {
      const nm = newAcc.company.trim();
      if (!(d.companies || []).some((c) => c.name.toLowerCase() === nm.toLowerCase()))
        d.companies.push({ id: uid("co"), name: nm, gstin: "", cin: "", pan: "", address: "", notes: "" });
      d.accounts.push({
        id, company: nm,
        accountName: newAcc.accountName.trim() || det.holder || `${det.bank || "Bank"} account`,
        accountNo: det.accountNo || "", bankName: det.bank || "", branch: det.branch || "", ifsc: det.ifsc || "", balance: 0,
      });
    }, { by: user.name, action: "Bank account auto-created from statement", detail: `${det.bank} ${det.accountNo || det.ifsc}` });
    setAccountId(id);
    flash("Bank account created from the statement's own details — verify under Bank accounts and set the balance");
  };
  const onFile = (e) => {
    const fl = e.target.files[0];
    if (!fl) return;
    const isExcel = /\.xlsx?$/i.test(fl.name);
    const rd = new FileReader();
    rd.onload = () => {
      try {
        if (isExcel) {
          const wb = XLSX.read(rd.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          loadRows(XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }).map((r) => r.map((c) => String(c ?? ""))), fl.name);
        } else {
          loadRows(parseCSV(String(rd.result)), fl.name);
        }
      } catch (err) { flash("Could not read this file: " + (err.message || "unknown error")); }
    };
    if (isExcel) rd.readAsArrayBuffer(fl); else rd.readAsText(fl);
    e.target.value = "";
  };

  const parsed = useMemo(() => {
    if (!rows || map.date < 0) return [];
    const useAmt = map.amount >= 0 && map.drcr >= 0;
    if (!useAmt && map.debit < 0 && map.credit < 0) return [];
    const out = [];
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const date = parseBankDate(r[map.date]);
      if (!date) continue;
      let type = null, amount = 0;
      if (useAmt) {
        type = parseDrCr(r[map.drcr]);
        amount = parseAmt(r[map.amount]);
        if (!type || !amount) continue;
      } else {
        const dr = map.debit >= 0 ? parseAmt(r[map.debit]) : 0;
        const cr = map.credit >= 0 ? parseAmt(r[map.credit]) : 0;
        if (!dr && !cr) continue;
        type = cr > 0 ? "Receipt" : "Payment";
        amount = cr > 0 ? cr : dr;
      }
      out.push({
        date, type, amount,
        desc: map.desc >= 0 ? String(r[map.desc] || "").trim() : "",
        ref: map.ref >= 0 ? String(r[map.ref] || "").trim() : "",
        bal: map.balance >= 0 ? String(r[map.balance] || "").trim() : "",
      });
    }
    return out;
  }, [rows, map, hdrIdx]);

  const doImport = () => {
    if (!accountId) return flash("Choose which bank account this statement belongs to");
    if (!parsed.length) return flash("No valid rows found — check the column matching below");
    // closing balance = the balance shown against the statement's last date
    let closing = null, closingDate = null;
    const withBal = parsed.filter((p) => p.bal);
    if (withBal.length) {
      const asc = parsed[0].date <= parsed[parsed.length - 1].date; // some banks list newest first
      closingDate = withBal.reduce((m, p) => (p.date > m ? p.date : m), withBal[0].date);
      const sameDay = withBal.filter((p) => p.date === closingDate);
      const pick = asc ? sameDay[sameDay.length - 1] : sameDay[0];
      const n = parseAmt(pick.bal);
      closing = /dr/i.test(pick.bal) ? -Math.abs(n) : n;
    }
    let added = 0, merged = 0, skipped = 0;
    commit((d) => {
      parsed.forEach((p) => {
        const dup = d.entries.find((x) => x.accountId === accountId && x.date === p.date && x.type === p.type && Math.abs(x.amount - p.amount) < 0.005);
        if (dup) {
          if (dup.source === "Manual") {
            d.entries = d.entries.filter((x) => x.id !== dup.id);
            d.entries.push({ id: uid("e"), accountId, ...p, ledger: dup.ledger, category: dup.category, source: "Statement", ts: Date.now(), by: user.name });
            merged++;
          } else skipped++;
        } else {
          d.entries.push({ id: uid("e"), accountId, ...p, ledger: "", category: "", source: "Statement", ts: Date.now(), by: user.name });
          added++;
        }
      });
      if (closing != null) {
        const acct = d.accounts.find((a) => a.id === accountId);
        if (acct) {
          const net = d.entries.filter((e) => e.accountId === accountId)
            .reduce((x, e) => x + (e.type === "Receipt" ? e.amount : -e.amount), 0);
          acct.balance = closing - net; // opening balance back-derived so opening + entries = the bank's closing
          acct.lastStatementClosing = closing;
          acct.lastStatementDate = closingDate;
        }
      }
      pushNotify(d, [d.users.find((u2) => u2.role === OWNER)?.id].filter((id) => id !== user.id),
        `${user.name} imported ${fname || "a bank statement"}: ${added} new, ${merged} matched with manual entries, ${skipped} already on record${closing != null ? ` · balance synchronised to the bank's closing ${inr(closing)}` : ""}`, "Accounts", null);
    }, { by: user.name, action: "Bank statement imported", detail: `${fname} · ${added} new · ${merged} merged · ${skipped} duplicates` });
    flash(`Imported: ${added} new, ${merged} merged, ${skipped} duplicates skipped${closing != null ? ` · account balance set from the bank's closing on ${fmtDate(closingDate)}: ${inr(closing)}` : " · no balance column matched, so the balance was not updated"}`);
    setRows(null); setFname("");
  };

  const hdr = rows ? (rows[hdrIdx] || []).map((h) => String(h || "")) : [];
  const MapSel = ({ k, label }) => (
    <Field label={label}>
      <select value={map[k]} onChange={(e) => setMap({ ...map, [k]: Number(e.target.value) })}>
        <option value={-1}>— not in this file —</option>
        {hdr.map((h, i) => <option key={i} value={i}>{h.trim() || `Column ${i + 1}`}</option>)}
      </select>
    </Field>
  );
  return (
    <Panel title="Import a bank statement"
      sub="Upload the file exactly as the bank gives it — CSV, XLS or XLSX all work (PNB, IOB, Axis, Kotak, Yes, IDFC First, SBI, ICICI, HDFC formats are recognised automatically). Duplicates against manual entries resolve automatically: the statement is kept as accurate and the manual entry's ledger and category are carried over.">
      <Field label="Which bank account is this statement for?">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Select</option>
          {accts.map((a) => <option key={a.id} value={a.id}>{a.company} — {a.accountName} ({a.bankName})</option>)}
        </select>
      </Field>
      <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style={{ display: "none" }} onChange={onFile} />
      <Btn kind="solid" onClick={() => fileRef.current && fileRef.current.click()}>Choose statement file (CSV / XLS / XLSX)</Btn>
      {rows && det && (det.accountNo || det.ifsc) && !accountId && (
        <div className="ext">
          <p className="fhint"><b>Details found inside this statement:</b> {det.bank && `Bank ${det.bank} · `}{det.accountNo && `A/c ${det.accountNo} · `}{det.ifsc && `IFSC ${det.ifsc}`}{det.branch && ` · Branch ${det.branch}`}</p>
          <SmartSelect label="Company this account belongs to" value={newAcc.company} onChange={(v) => setNewAcc({ ...newAcc, company: v })}
            options={(db.companies || []).map((c) => c.name)} />
          <Field label="Account name (how it should appear in the tool)">
            <input value={newAcc.accountName} onChange={(e) => setNewAcc({ ...newAcc, accountName: e.target.value })} placeholder={det.holder || "e.g. Revanza Estates — Current A/c"} />
          </Field>
          <Btn kind="brass" onClick={createFromStatement}>Create this bank account automatically from the statement</Btn>
        </div>
      )}
      {rows && (
        <>
          <h4>Column matching — {fname}</h4>
          <p className="fhint">Table detected from row {hdrIdx + 1}. {parsed.length} valid transaction(s) found. Correct anything wrongly guessed; banks either give separate Withdrawal/Deposit columns, or one Amount column with a DR/CR flag — set whichever pair this file has.</p>
          <div className="row2"><MapSel k="date" label="Date column" /><MapSel k="desc" label="Description / narration column" /></div>
          <div className="row2"><MapSel k="debit" label="Withdrawal / debit column" /><MapSel k="credit" label="Deposit / credit column" /></div>
          <div className="row2"><MapSel k="amount" label="Amount column (single-amount banks)" /><MapSel k="drcr" label="DR / CR column (single-amount banks)" /></div>
          <div className="row2"><MapSel k="ref" label="Reference / cheque / UTR (optional)" /><MapSel k="balance" label="Balance column (optional — shown in statement views)" /></div>
          {parsed.length > 0 && (
            <>
              <h4>Preview (first 8)</h4>
              <table className="tbl">
                <thead><tr><th>Date</th><th>Type</th><th>Particulars</th><th className="amt">Amount</th></tr></thead>
                <tbody>{parsed.slice(0, 8).map((x, i) => (
                  <tr key={i}><td>{fmtDate(x.date)}</td><td><Badge t={x.type === "Receipt" ? "green" : "orange"}>{x.type}</Badge></td><td>{x.desc.slice(0, 60)}</td><td className="amt">{inr(x.amount)}</td></tr>))}
                </tbody>
              </table>
            </>
          )}
          <div style={{ marginTop: 14 }}>
            <Btn kind="solid" full onClick={doImport}>Import {parsed.length} transaction(s)</Btn>
          </div>
        </>
      )}
    </Panel>
  );
}

function EntriesTable({ db, user, commit, flash }) {
  const accts = db.accounts || [], entries = db.entries || [];
  const [acc, setAcc] = useState(""); const [type, setType] = useState(""); const [q, setQ] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [editId, setEditId] = useState(null);
  const acctName = (id) => { const a = accts.find((x) => x.id === id); return a ? a.accountName : "—"; };
  const rows = entries.filter((e) => {
    if (acc && e.accountId !== acc) return false;
    if (type && e.type !== type) return false;
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    if (q && !((e.desc || "") + (e.ledger || "") + (e.category || "") + (e.ref || "")).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const editing = entries.find((e) => e.id === editId);
  const [tag, setTag] = useState({ ledger: "", category: "" });
  const openEdit = (e) => { setEditId(e.id); setTag({ ledger: e.ledger || "", category: e.category || "" }); };
  const quickTag = (e, field, v) => {
    commit((d) => {
      const x = d.entries.find((y) => y.id === e.id);
      x[field] = v;
      if (field === "ledger") learn(d, "ledgers", v); else learn(d, "categories", v);
    }, { by: user.name, action: "Entry tagged", detail: `${field}: ${v}` });
  };
  const saveTag = () => {
    commit((d) => {
      const x = d.entries.find((y) => y.id === editId);
      x.ledger = tag.ledger; x.category = tag.category;
      learn(d, "ledgers", tag.ledger); learn(d, "categories", tag.category);
    }, { by: user.name, action: "Entry tagged", detail: editId });
    setEditId(null); flash("Ledger and category saved");
  };
  const del = (e) => {
    if (e.source !== "Manual") return flash("Statement entries are the bank's record and cannot be deleted here");
    if (!window.confirm("Delete this manual entry?")) return;
    commit((d) => { d.entries = d.entries.filter((x) => x.id !== e.id); }, { by: user.name, action: "Manual entry deleted", detail: `${e.type} ${inr(e.amount)} ${e.desc.slice(0, 30)}` });
    flash("Entry deleted");
  };
  const untagged = entries.filter((e) => !e.ledger).length;
  return (
    <Panel title="Receipts and payments" sub={`${rows.length} entr${rows.length === 1 ? "y" : "ies"}${untagged ? ` · ${untagged} still need a ledger — tap Tag` : ""}`}>
      <div className="filters">
        <input placeholder="Search particulars, ledger, reference…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">All accounts</option>{accts.map((a) => <option key={a.id} value={a.id}>{a.accountName}</option>)}</select>
        <select value={type} onChange={(e) => setType(e.target.value)}><option value="">Both</option><option>Receipt</option><option>Payment</option></select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {rows.length === 0 ? <Empty>No entries match. Record one under New entry, or import a bank statement.</Empty> : (
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th>Date</th><th>Account</th><th>Type</th><th>Particulars</th><th>Ledger</th><th>Category</th><th className="amt">Amount</th><th>Source</th><th></th></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}>
                <td>{fmtDate(e.date)}</td><td>{acctName(e.accountId)}</td>
                <td><Badge t={e.type === "Receipt" ? "green" : "orange"}>{e.type}</Badge></td>
                <td>{e.desc}{e.ref && <i className="sub mono">{e.ref}</i>}</td>
                <td>
                  <select className="cellsel" value={e.ledger || ""}
                    onChange={(ev) => ev.target.value === "__other" ? openEdit(e) : quickTag(e, "ledger", ev.target.value)}>
                    <option value="">—</option>
                    {[...new Set([...(db.masters.ledgers || []), ...(e.ledger ? [e.ledger] : [])])].sort((a, b) => a.localeCompare(b)).map((o) => <option key={o}>{o}</option>)}
                    <option value="__other">Others — add new…</option>
                  </select>
                </td>
                <td>
                  <select className="cellsel" value={e.category || ""}
                    onChange={(ev) => ev.target.value === "__other" ? openEdit(e) : quickTag(e, "category", ev.target.value)}>
                    <option value="">—</option>
                    {[...new Set([...(db.masters.categories || []), ...(e.category ? [e.category] : [])])].sort((a, b) => a.localeCompare(b)).map((o) => <option key={o}>{o}</option>)}
                    <option value="__other">Others — add new…</option>
                  </select>
                </td>
                <td className="amt"><b>{inr(e.amount)}</b></td>
                <td><Badge t={e.source === "Statement" ? "blue" : "grey"}>{e.source}</Badge></td>
                <td><Btn onClick={() => openEdit(e)}>Tag</Btn>{e.source === "Manual" && <Btn onClick={() => del(e)}>Delete</Btn>}</td>
              </tr>))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal title={`Tag entry — ${inr(editing.amount)} · ${fmtDate(editing.date)}`} onClose={() => setEditId(null)}>
          <p className="desc">{editing.desc}</p>
          <SmartSelect label="Ledger name" value={tag.ledger} onChange={(v) => setTag({ ...tag, ledger: v })} options={db.masters.ledgers || []} />
          <SmartSelect label="Category" value={tag.category} onChange={(v) => setTag({ ...tag, category: v })} options={db.masters.categories || []} />
          <Btn kind="solid" full onClick={saveTag}>Save</Btn>
        </Modal>
      )}
    </Panel>
  );
}

function LedgerStatement({ db, user }) {
  const accts = db.accounts || [], entries = db.entries || [];
  const [dim, setDim] = useState("ledger");
  const [val, setVal] = useState("");
  const [acc, setAcc] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const values = [...new Set(entries.map((e) => (dim === "ledger" ? e.ledger : e.category)).filter(Boolean))].sort();
  const rows = entries.filter((e) => {
    if (!val) return false;
    if ((dim === "ledger" ? e.ledger : e.category) !== val) return false;
    if (acc && e.accountId !== acc) return false;
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    return true;
  }).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  let run = 0;
  const lines = rows.map((e) => { run += e.type === "Receipt" ? e.amount : -e.amount; return { ...e, run }; });
  const tRec = rows.filter((e) => e.type === "Receipt").reduce((a, e) => a + e.amount, 0);
  const tPay = rows.filter((e) => e.type === "Payment").reduce((a, e) => a + e.amount, 0);
  const acctName = (id) => { const a = accts.find((x) => x.id === id); return a ? a.accountName : "—"; };
  const dl = () => downloadCSV(`ledger-${val}-${today()}.csv`,
    [["Date", "Account", "Particulars", "Reference", "Receipt", "Payment", "Running balance"],
    ...lines.map((e) => [e.date, acctName(e.accountId), e.desc, e.ref || "", e.type === "Receipt" ? e.amount : "", e.type === "Payment" ? e.amount : "", e.run]),
    [], ["Totals", "", "", "", tRec, tPay, tRec - tPay]],
    [`Revanza — Ledger statement: ${val} (${dim})`, `Generated ${new Date().toLocaleString("en-GB")} by ${user.name}`, "Confidential — internal circulation only"]);
  return (
    <Panel title="Ledger statement" sub="Pick a ledger or category to build its statement, with running balance and CSV download for Excel"
      right={lines.length > 0 && <Btn kind="solid" onClick={dl}>Download CSV</Btn>}>
      <div className="filters">
        <select value={dim} onChange={(e) => { setDim(e.target.value); setVal(""); }}>
          <option value="ledger">By ledger name</option><option value="category">By category</option>
        </select>
        <select value={val} onChange={(e) => setVal(e.target.value)}>
          <option value="">Select {dim}</option>
          {values.map((v) => <option key={v}>{v}</option>)}
        </select>
        <select value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">All accounts</option>{accts.map((a) => <option key={a.id} value={a.id}>{a.accountName}</option>)}</select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {!val ? <Empty>Choose a ledger or category above. Entries must be tagged (Receipts & payments tab → Tag) before they appear here.</Empty> :
        lines.length === 0 ? <Empty>No tagged entries found for "{val}" in this range.</Empty> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Account</th><th>Particulars</th><th className="amt">Receipt</th><th className="amt">Payment</th><th className="amt">Running</th></tr></thead>
              <tbody>
                {lines.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtDate(e.date)}</td><td>{acctName(e.accountId)}</td><td>{e.desc}</td>
                    <td className="amt">{e.type === "Receipt" ? inr(e.amount) : ""}</td>
                    <td className="amt">{e.type === "Payment" ? inr(e.amount) : ""}</td>
                    <td className={`amt ${e.run < 0 ? "danger" : ""}`}>{inr(e.run)}</td>
                  </tr>
                ))}
                <tr><td colSpan={3}><b>Totals</b></td><td className="amt"><b>{inr(tRec)}</b></td><td className="amt"><b>{inr(tPay)}</b></td><td className={`amt ${tRec - tPay < 0 ? "danger" : ""}`}><b>{inr(tRec - tPay)}</b></td></tr>
              </tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}

/* ============================ PROJECTS ============================ */
const Prog = ({ pct }) => (
  <span className="bar-t" style={{ display: "inline-block", width: 110, verticalAlign: "middle" }}>
    <span className={`bar-f ${pct >= 100 ? "f-green" : pct > 0 ? "f-blue" : "f-grey"}`} style={{ width: Math.min(100, pct) + "%" }} />
  </span>
);

function Projects({ db, user, commit, flash }) {
  const canBuild = user.role === OWNER || user.role === "Engineer";
  const [openP, setOpenP] = useState(null);
  const [creating, setCreating] = useState(false);
  const visible = (db.projects || []).filter((pj) =>
    canBuild || (pj.team || []).includes(user.id) || (pj.contractors || []).includes(user.id));
  const proj = (db.projects || []).find((pj) => pj.id === openP);
  const pct = (pj) => {
    const ts = (db.ptasks || []).filter((x) => x.projectId === pj.id);
    return ts.length ? Math.round(ts.reduce((a, x) => a + (x.percent || 0), 0) / ts.length) : 0;
  };
  if (proj) return <ProjectDetail proj={proj} db={db} user={user} commit={commit} flash={flash} onBack={() => setOpenP(null)} canBuild={canBuild} />;
  return (
    <>
      <Panel title="Projects" sub={user.role === "Contractor" ? "Your assigned project work" : "Layout and site execution projects"}
        right={canBuild && <Btn kind="solid" onClick={() => setCreating(true)}>New project</Btn>}>
        {visible.length === 0 ? <Empty>{canBuild ? "No projects yet — create the first one." : "No projects assigned to you yet."}</Empty> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Project</th><th>Property / company</th><th>Dates</th><th>Team</th><th>Progress</th><th></th></tr></thead>
              <tbody>{visible.map((pj) => {
                const p0 = pct(pj);
                const overdue = pj.end && pj.end < today() && p0 < 100;
                return (
                  <tr key={pj.id} className={overdue ? "row-danger" : ""}>
                    <td><b>{pj.name}</b>{pj.desc && <i className="sub">{pj.desc.slice(0, 60)}</i>}</td>
                    <td>{pj.entity}</td>
                    <td>{fmtDate(pj.start)} → {fmtDate(pj.end)}{overdue && <i className="sub danger">past end date</i>}</td>
                    <td>{(pj.team || []).length + (pj.contractors || []).length} people</td>
                    <td><Prog pct={p0} /> <span className="mono">{p0}%</span></td>
                    <td><Btn onClick={() => setOpenP(pj.id)}>Open</Btn></td>
                  </tr>
                );
              })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {creating && <NewProject db={db} user={user} commit={commit} flash={flash} onClose={() => setCreating(false)} />}
    </>
  );
}

function PickPeople({ db, roles, picks, setPicks, label, hint }) {
  const list = [...db.users].filter((u) => u.status === "Active" && roles.includes(u.role))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Field label={label} hint={hint}>
      <div className="pick">
        {list.length === 0 && <p className="fhint">No one with the right role yet — add them in Employee Directory.</p>}
        {list.map((u) => (
          <label key={u.id} className="check">
            <input type="checkbox" checked={picks.includes(u.id)}
              onChange={(e) => setPicks(e.target.checked ? [...picks, u.id] : picks.filter((x) => x !== u.id))} />
            {u.name} — {u.role}{u.firm ? ` (${u.firm})` : ""}
          </label>
        ))}
      </div>
    </Field>
  );
}

function NewProject({ db, user, commit, flash, onClose }) {
  const [f, setF] = useState({ name: "", entity: "", desc: "", start: today(), end: addDays(today(), 60) });
  const [team, setTeam] = useState([]);
  const [contractors, setContractors] = useState([]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!f.name.trim() || !f.entity.trim()) return flash("Project name and property/company are required");
    const id = uid("pj");
    commit((d) => {
      learn(d, "entities", f.entity);
      d.projects.push({ id, ref: "PRJ-" + pad(d.projects.length + 1), ...f, team, contractors, createdBy: user.id, status: "In Progress", created: today() });
      pushNotify(d, [...team, ...contractors].filter((x) => x !== user.id), `You have been added to project "${f.name}"`, "Project", null);
    }, { by: user.name, action: "Project created", detail: f.name });
    flash("Project created — now add its tasks"); onClose();
  };
  return (
    <Modal title="New project" onClose={onClose} wide>
      <Field label="Project name"><input value={f.name} onChange={set("name")} placeholder="e.g. Karinilam layout — infrastructure" /></Field>
      <SmartSelect label="Property / company" value={f.entity} onChange={(v) => setF({ ...f, entity: v })} options={db.masters.entities} />
      <Field label="Description (optional)"><textarea rows={2} value={f.desc} onChange={set("desc")} /></Field>
      <div className="row2">
        <Field label="Start date"><input type="date" value={f.start} onChange={set("start")} /></Field>
        <Field label="Target end date"><input type="date" value={f.end} onChange={set("end")} /></Field>
      </div>
      <PickPeople db={db} roles={[OWNER, "Engineer", "Drawings", "Executive", "Admin", "Accounts", "Payments", "Legal Associate"]}
        picks={team} setPicks={setTeam} label="Project team (staff and engineers)" />
      <PickPeople db={db} roles={["Contractor"]} picks={contractors} setPicks={setContractors}
        label="Contractors" hint="Contractors sign in like staff but can see only their project work. Add them first in Employee Directory with role Contractor." />
      <Btn kind="solid" full onClick={save}>Create project</Btn>
    </Modal>
  );
}

function ProjectDetail({ proj, db, user, commit, flash, onBack, canBuild }) {
  const isContractor = user.role === "Contractor";
  const tasks = (db.ptasks || []).filter((x) => x.projectId === proj.id)
    .filter((x) => !isContractor || (x.assignees || []).includes(user.id))
    .sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  const [openT, setOpenT] = useState(null);
  const [adding, setAdding] = useState(false);
  const cur = tasks.find((x) => x.id === openT);
  const nameOf = (id) => uname(db, id) === "—" ? "Team" : uname(db, id);
  const recalc = () => {
    let n = 0;
    commit((d) => { n = cascadeSchedule(d, proj.id, user.name); }, null);
    flash(n ? `${n} task(s) rescheduled from linked delays — everyone connected has been notified` : "Schedule checked — nothing needs to move");
  };
  return (
    <>
      <Panel title={`${proj.ref} — ${proj.name}`} sub={`${proj.entity} · ${fmtDate(proj.start)} → ${fmtDate(proj.end)}`}
        right={<><Btn onClick={onBack}>← All projects</Btn>{canBuild && <Btn onClick={recalc}>Recalculate schedule</Btn>}{canBuild && <Btn kind="solid" onClick={() => setAdding(true)}>Add task</Btn>}</>}>
        {proj.desc && <p className="desc">{proj.desc}</p>}
        <p className="fhint">Team: {(proj.team || []).map(nameOf).join(", ") || "—"} · Contractors: {(proj.contractors || []).map((id) => nameOf(id)).join(", ") || "—"}</p>
        {tasks.length === 0 ? <Empty>{canBuild ? "No tasks yet. Add the first — e.g. Light poles, with subtasks like civil work, bolt fixing, erection, commissioning." : "No tasks assigned to you in this project yet."}</Empty> : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Task</th><th>Allocated to</th><th>Start</th><th>End</th><th>Linked to</th><th>Progress</th><th></th></tr></thead>
              <tbody>{tasks.map((x) => {
                const overdue = x.end < today() && (x.percent || 0) < 100;
                return (
                  <tr key={x.id} className={overdue ? "row-danger" : ""}>
                    <td><b>{x.name}</b>{(x.subtasks || []).length > 0 && <i className="sub">{x.subtasks.filter((st) => st.done).length}/{x.subtasks.length} subtasks done</i>}</td>
                    <td>{(x.assignees || []).map(nameOf).join(", ") || "—"}</td>
                    <td>{fmtDate(x.start)}</td>
                    <td>{fmtDate(x.end)}{x.origEnd && x.origEnd !== x.end && <i className="sub warn">was {fmtDate(x.origEnd)}</i>}{overdue && <i className="sub danger">overdue</i>}</td>
                    <td>{(x.dependsOn || []).map((id) => (db.ptasks.find((y) => y.id === id) || {}).name).filter(Boolean).join(", ") || "—"}</td>
                    <td><Prog pct={x.percent || 0} /> <span className="mono">{x.percent || 0}%</span></td>
                    <td><Btn onClick={() => setOpenT(x.id)}>Open</Btn></td>
                  </tr>
                );
              })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {cur && <PTaskModal task={cur} proj={proj} db={db} user={user} commit={commit} flash={flash} canBuild={canBuild} onClose={() => setOpenT(null)} />}
      {adding && <NewPTask proj={proj} db={db} user={user} commit={commit} flash={flash} onClose={() => setAdding(false)} />}
    </>
  );
}

function NewPTask({ proj, db, user, commit, flash, onClose }) {
  const [f, setF] = useState({ name: "", desc: "", start: today(), end: addDays(today(), 7) });
  const [assignees, setAssignees] = useState([]);
  const [deps, setDeps] = useState([]);
  const [subs, setSubs] = useState([]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const existing = (db.ptasks || []).filter((x) => x.projectId === proj.id);
  const people = [...(proj.team || []), ...(proj.contractors || [])];
  const save = () => {
    if (!f.name.trim()) return flash("Task name is required");
    const id = uid("pt");
    commit((d) => {
      d.ptasks.push({
        id, projectId: proj.id, ...f, assignees, dependsOn: deps, percent: 0, status: "Not Started",
        subtasks: subs.filter((x) => x.name.trim()).map((x) => ({ id: uid("ps"), name: x.name.trim(), start: x.start, end: x.end, percent: 0, done: false })),
        updates: [], docs: [],
      });
      pushNotify(d, assignees.filter((x) => x !== user.id), `New project task for you in "${proj.name}": ${f.name}`, "Project task", null);
      cascadeSchedule(d, proj.id, user.name);
    }, { by: user.name, action: "Project task added", detail: `${proj.name} · ${f.name}` });
    flash("Task added"); onClose();
  };
  return (
    <Modal title={`Add task — ${proj.name}`} onClose={onClose} wide>
      <Field label="Task name"><input value={f.name} onChange={set("name")} placeholder="e.g. Light poles" /></Field>
      <Field label="Description (optional)"><textarea rows={2} value={f.desc} onChange={set("desc")} /></Field>
      <div className="row2">
        <Field label="Start date"><input type="date" value={f.start} onChange={set("start")} /></Field>
        <Field label="End date"><input type="date" value={f.end} onChange={set("end")} /></Field>
      </div>
      <Field label="Allocated to" hint="Project team members and contractors">
        <div className="pick">
          {people.length === 0 && <p className="fhint">Add team members / contractors to the project first.</p>}
          {people.map((id) => (
            <label key={id} className="check">
              <input type="checkbox" checked={assignees.includes(id)}
                onChange={(e) => setAssignees(e.target.checked ? [...assignees, id] : assignees.filter((x) => x !== id))} />
              {uname(db, id) === "—" ? "Team member" : uname(db, id)}
            </label>
          ))}
        </div>
      </Field>
      {existing.length > 0 && (
        <Field label="Linked to (depends on)" hint="If a linked task is delayed or incomplete, this task and its subtasks are pushed forward automatically and everyone is notified.">
          <div className="pick">
            {existing.map((x) => (
              <label key={x.id} className="check">
                <input type="checkbox" checked={deps.includes(x.id)}
                  onChange={(e) => setDeps(e.target.checked ? [...deps, x.id] : deps.filter((y) => y !== x.id))} />
                {x.name} (ends {fmtDate(x.end)})
              </label>
            ))}
          </div>
        </Field>
      )}
      <h4>Subtasks (e.g. civil work, bolt fixing, erection, commissioning)</h4>
      {subs.map((x, i) => (
        <div className="row2" key={i}>
          <Field label={`Subtask ${i + 1}`}><input value={x.name} onChange={(e) => setSubs(subs.map((y, j) => j === i ? { ...y, name: e.target.value } : y))} /></Field>
          <div className="row2">
            <Field label="Start"><input type="date" value={x.start} onChange={(e) => setSubs(subs.map((y, j) => j === i ? { ...y, start: e.target.value } : y))} /></Field>
            <Field label="End"><input type="date" value={x.end} onChange={(e) => setSubs(subs.map((y, j) => j === i ? { ...y, end: e.target.value } : y))} /></Field>
          </div>
        </div>
      ))}
      <div className="quick" style={{ marginBottom: 14 }}>
        <Btn onClick={() => setSubs([...subs, { name: "", start: f.start, end: f.end }])}>Add a subtask</Btn>
        {subs.length > 0 && <Btn onClick={() => setSubs(subs.slice(0, -1))}>Remove last</Btn>}
      </div>
      <Btn kind="solid" full onClick={save}>Add task</Btn>
    </Modal>
  );
}

function PTaskModal({ task, proj, db, user, commit, flash, canBuild, onClose }) {
  const isAssignee = (task.assignees || []).includes(user.id);
  const canUpdate = canBuild || isAssignee;
  const [txt, setTxt] = useState("");
  const [dates, setDates] = useState({ on: false, start: task.start, end: task.end });
  const nameOf = (id) => uname(db, id) === "—" ? "Team" : uname(db, id);
  const mutate = (fn, action, note = true) =>
    commit((d) => {
      const x = d.ptasks.find((y) => y.id === task.id);
      fn(x, d);
      cascadeSchedule(d, proj.id, user.name);
    }, note ? { by: user.name, action, detail: `${proj.name} · ${task.name}` } : null);

  const setPct = (v) => {
    const pv = Math.max(0, Math.min(100, Number(v) || 0));
    mutate((x, d) => {
      x.percent = pv;
      x.status = pv >= 100 ? "Completed" : pv > 0 ? "In Progress" : "Not Started";
      pushNotify(d, [d.users.find((u2) => u2.role === OWNER)?.id, ...(proj.team || []), ...(task.assignees || [])].filter((id) => id !== user.id),
        `"${task.name}" in ${proj.name} is now ${pv}% (${user.name})`, "Project progress", null);
    }, `Progress ${pv}%`);
    flash(`Progress set to ${pv}%`);
  };
  const setSub = (sid, patch) => mutate((x) => {
    const st = x.subtasks.find((y) => y.id === sid);
    Object.assign(st, patch);
    if (patch.done !== undefined) st.percent = patch.done ? 100 : st.percent;
  }, "Subtask updated");
  const addUpdate = (text) => {
    if (!text.trim()) return;
    mutate((x, d) => {
      x.updates.unshift({ ts: Date.now(), by: user.name, text });
      pushNotify(d, [d.users.find((u2) => u2.role === OWNER)?.id, ...(proj.team || [])].filter((id) => id !== user.id),
        `${user.name} on "${task.name}": ${text.slice(0, 80)}`, "Project update", null);
    }, "Project task update");
    flash("Update posted");
  };
  const addPhoto = async (img) => {
    if (!img) return flash("The photo could not be read");
    const g = await getGPS();
    mutate((x) => x.docs.unshift({ ts: Date.now(), by: user.name, img, lat: g.lat, lng: g.lng }), "Site photo attached");
    flash(g.lat != null ? "Photo attached with GPS, date and time" : "Photo attached — GPS unavailable");
  };
  const saveDates = () => {
    mutate((x, d) => {
      x.origEnd = x.origEnd || x.end;
      x.start = dates.start; x.end = dates.end;
      pushNotify(d, [d.users.find((u2) => u2.role === OWNER)?.id, ...(proj.team || []), ...(task.assignees || [])].filter((id) => id !== user.id),
        `Dates for "${task.name}" changed to ${fmtDate(dates.start)} → ${fmtDate(dates.end)} by ${user.name}`, "Project schedule", null);
    }, "Task dates changed");
    setDates({ ...dates, on: false }); flash("Dates saved — linked tasks rescheduled if needed");
  };
  const subAvg = (task.subtasks || []).length
    ? Math.round(task.subtasks.reduce((a, x) => a + (x.percent || 0), 0) / task.subtasks.length) : null;

  return (
    <Modal title={task.name} onClose={onClose} wide>
      <div className="kv">
        <div><span>Project</span><b>{proj.name}</b></div>
        <div><span>Allocated to</span><b>{(task.assignees || []).map(nameOf).join(", ") || "—"}</b></div>
        <div><span>Dates</span><b>{fmtDate(task.start)} → {fmtDate(task.end)}{task.origEnd && task.origEnd !== task.end && <i className="sub warn">originally {fmtDate(task.origEnd)}</i>}</b></div>
        <div><span>Linked to</span><b>{(task.dependsOn || []).map((id) => (db.ptasks.find((y) => y.id === id) || {}).name).filter(Boolean).join(", ") || "—"}</b></div>
        <div><span>Status</span><b><Badge t={(task.percent || 0) >= 100 ? "green" : task.end < today() ? "red" : "blue"}>{(task.percent || 0) >= 100 ? "Completed" : task.end < today() ? "Overdue" : task.status || "In Progress"}</Badge></b></div>
        <div><span>Progress</span><b>{task.percent || 0}%{subAvg != null && ` (subtasks average ${subAvg}%)`}</b></div>
      </div>
      {task.desc && <p className="desc">{task.desc}</p>}

      {canUpdate && (
        <>
          <h4>Update completion</h4>
          <div className="quick">
            {[10, 25, 50, 75, 90, 100].map((v) => (
              <button key={v} className={`chip${(task.percent || 0) === v ? " on" : ""}`} onClick={() => setPct(v)}>{v}%</button>
            ))}
            <input type="number" min={0} max={100} defaultValue={task.percent || 0} style={{ maxWidth: 90 }}
              onKeyDown={(e) => e.key === "Enter" && setPct(e.target.value)} onBlur={(e) => Number(e.target.value) !== (task.percent || 0) && setPct(e.target.value)} />
          </div>
        </>
      )}

      {canBuild && (
        <>
          {!dates.on ? <div style={{ marginTop: 10 }}><Btn onClick={() => setDates({ ...dates, on: true })}>Change dates</Btn></div> : (
            <div className="ext">
              <div className="row2">
                <Field label="Start"><input type="date" value={dates.start} onChange={(e) => setDates({ ...dates, start: e.target.value })} /></Field>
                <Field label="End"><input type="date" value={dates.end} onChange={(e) => setDates({ ...dates, end: e.target.value })} /></Field>
              </div>
              <Btn kind="solid" onClick={saveDates}>Save dates</Btn>
            </div>
          )}
        </>
      )}

      <h4>Subtasks</h4>
      {(task.subtasks || []).length === 0 ? <Empty>No subtasks defined.</Empty> :
        task.subtasks.map((st) => (
          <div className="subt" key={st.id} style={{ gap: 10 }}>
            <input type="checkbox" checked={!!st.done} disabled={!canUpdate} onChange={(e) => setSub(st.id, { done: e.target.checked })} />
            <span className={st.done ? "struck" : ""} style={{ flex: 1 }}>{st.name}<i className="sub">{fmtDate(st.start)} → {fmtDate(st.end)}</i></span>
            {canUpdate ? (
              <input type="number" min={0} max={100} value={st.percent || 0} style={{ maxWidth: 70 }}
                onChange={(e) => setSub(st.id, { percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
            ) : <span className="mono">{st.percent || 0}%</span>}
            <span className="mono">%</span>
          </div>
        ))}

      <h4>Site photos with GPS</h4>
      {(task.docs || []).length === 0 ? <Empty>No photographs yet.</Empty> : (
        <div className="thumbs">
          {task.docs.map((x, i) => (
            <figure key={i}>
              <img src={x.img} alt={`By ${x.by}`} className="thumb-lg" />
              <figcaption>{x.by} · {fmtStamp(x.ts)}<br />{x.lat != null ? `GPS ${x.lat.toFixed(4)}, ${x.lng.toFixed(4)}` : "GPS not captured"}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {canUpdate && <CameraButton label="Add site photo — GPS, date and time stamped" facing="environment" onShot={addPhoto} />}

      <h4>Updates</h4>
      {canUpdate && <>
        <VoiceNote flash={flash} onText={(t) => addUpdate("Voice note (transcribed): " + t)} />
        <div className="inline">
          <textarea rows={2} placeholder="Progress, issues, material status…" value={txt} onChange={(e) => setTxt(e.target.value)} />
          <Btn kind="solid" onClick={() => { addUpdate(txt); setTxt(""); }}>Post</Btn>
        </div>
      </>}
      {(task.updates || []).length === 0 ? <Empty>No updates yet.</Empty> : (
        <ul className="feed">{task.updates.map((u, i) => (
          <li key={i}><span className="feed-m">{u.by} · {fmtStamp(u.ts)}</span>{u.text}</li>))}
        </ul>
      )}
    </Modal>
  );
}

/* ============================ SALARY ============================ */
function Salary({ db, user, commit, flash }) {
  const [ym, setYm] = useState(today().slice(0, 7));
  const [openId, setOpenId] = useState(null);
  const hr = { ...HR_DEFAULTS, ...(db.settings.hr || {}) };
  const [pol, setPol] = useState(hr);
  const staff = db.users.filter((u) => u.status === "Active" && u.role !== OWNER && u.role !== "Contractor");
  const calcs = staff.map((u) => ({ u, c: calcSalary(db, u, ym) }));
  const isCurrent = ym === today().slice(0, 7);
  const savePol = () => {
    commit((d) => {
      d.settings.hr = {
        latesPerHalfDay: Number(pol.latesPerHalfDay) || 3,
        leaveUnpaid: !!pol.leaveUnpaid,
        leaveExtraThreshold: Number(pol.leaveExtraThreshold) || 5,
        leaveExtraDays: Number(pol.leaveExtraDays) || 2,
      };
    }, { by: user.name, action: "HR policy updated", detail: "" });
    flash("Policy saved — all figures recalculated");
  };
  const dl = () => downloadCSV(`salary-${ym}.csv`,
    [["Employee", "Role", "Monthly salary", "Days counted", "Present", "Absent", "Leave days", "Leave deducted (days)", "Lates", "Half-days from lates", "Off-days worked (+1 each)", "OT net (hours)", "OT pay", "Total deduction (days)", "Net payable"],
    ...calcs.map(({ u, c }) => [u.name, u.role, u.salary || 0, c.upto ? c.upto - c.start + 1 : 0, c.present, c.absent, c.leaveDays, c.leaveDeduct, c.lates, c.halfDays, c.offWorked, (c.otNetMins / 60).toFixed(2), Math.round(c.otPay), c.dedDays, Math.round(c.net)])],
    [`Revanza — Salary sheet ${ym}`, `Generated ${new Date().toLocaleString("en-GB")} by ${user.name}`, "Confidential — Owner only"]);
  const cur = calcs.find((x) => x.u.id === openId);
  return (
    <>
      <Panel title="HR policy" sub="These rules drive the calculation for every month. Change and save to recalculate.">
        <div className="row2">
          <Field label="Lates that make a half-day deduction"><input type="number" value={pol.latesPerHalfDay} onChange={(e) => setPol({ ...pol, latesPerHalfDay: e.target.value })} /></Field>
          <Field label="Grace period" hint="Set per employee in the Directory. Minutes used within grace are not deducted from salary — they reduce OT minutes instead."><input readOnly value="Per employee (Directory → Manage)" /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={!!pol.leaveUnpaid} onChange={(e) => setPol({ ...pol, leaveUnpaid: e.target.checked })} /> Approved leave is deducted from salary (loss of pay)</label>
        <div className="row2">
          <Field label="If leave in the month reaches (days)…"><input type="number" value={pol.leaveExtraThreshold} onChange={(e) => setPol({ ...pol, leaveExtraThreshold: e.target.value })} /></Field>
          <Field label="…deduct this many extra days"><input type="number" value={pol.leaveExtraDays} onChange={(e) => setPol({ ...pol, leaveExtraDays: e.target.value })} /></Field>
        </div>
        <p className="fhint">Fixed rules: daily rate = monthly salary ÷ actual days in the month · absence without approved leave deducts a full day · a weekly-off day worked adds one full day (not 1.5) · OT is paid per minute after the person's work-end time at their OT rate, minus any grace minutes they used in the mornings.</p>
        <Btn kind="solid" onClick={savePol}>Save policy</Btn>
      </Panel>

      <Panel title={`Salary sheet — ${ym}`} sub={isCurrent ? "Current month: calculated up to today; figures grow as the month runs." : "Full month."}
        right={<><input type="month" value={ym} onChange={(e) => setYm(e.target.value)} /><Btn kind="solid" onClick={dl}>Download CSV</Btn></>}>
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th>Employee</th><th className="amt">Salary</th><th>Present</th><th>Absent</th><th>Leave</th><th>Lates</th><th>Off worked</th><th className="amt">OT (h)</th><th className="amt">OT pay</th><th className="amt">Deducted (days)</th><th className="amt">Net payable</th><th></th></tr></thead>
            <tbody>
              {calcs.map(({ u, c }) => (
                <tr key={u.id} onClick={() => setOpenId(u.id)} style={{ cursor: "pointer" }}>
                  <td><b>{u.name}</b><i className="sub">{u.role}</i></td>
                  <td className="amt">{Number(u.salary) ? inr(u.salary) : <span className="muted">not set</span>}</td>
                  <td>{c.present}</td>
                  <td className={c.absent ? "danger" : ""}>{c.absent}</td>
                  <td>{c.leaveDays}{c.leaveDeduct > c.leaveDays && <i className="sub danger">+{c.leaveDeduct - c.leaveDays} extra</i>}</td>
                  <td>{c.lates}{c.halfDays > 0 && <i className="sub danger">−{c.halfDays} day</i>}</td>
                  <td>{c.offWorked}</td>
                  <td className="amt">{(c.otNetMins / 60).toFixed(1)}{c.graceEaten > 0 && <i className="sub">−{c.graceEaten}m grace</i>}</td>
                  <td className="amt">{inr(Math.round(c.otPay))}</td>
                  <td className="amt">{c.dedDays}</td>
                  <td className="amt"><b>{Number(u.salary) ? inr(Math.round(c.net)) : "—"}</b></td>
                  <td><Btn onClick={() => setOpenId(u.id)}>Details</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fhint">Salaries, OT rates, salary start/end dates, work hours, grace minutes and the weekly off day are all set per employee in Employee Directory → Manage.</p>
      </Panel>

      {cur && (
        <Modal title={`${cur.u.name} — ${ym}`} onClose={() => setOpenId(null)} wide>
          <div className="kv">
            <div><span>Monthly salary</span><b>{inr(cur.u.salary)}</b></div>
            <div><span>Per-day rate (÷{cur.c.dim} days)</span><b>{inr(Math.round(cur.c.perDay))}</b></div>
            <div><span>Base (days counted)</span><b>{inr(Math.round(cur.c.base))}</b></div>
            <div><span>Deductions</span><b className={cur.c.dedDays ? "danger" : ""}>{cur.c.dedDays} day(s) = {inr(Math.round(cur.c.dedDays * cur.c.perDay))}</b></div>
            <div><span>Off-days worked</span><b>+{inr(Math.round(cur.c.offWorked * cur.c.perDay))}</b></div>
            <div><span>OT</span><b>{(cur.c.otNetMins / 60).toFixed(1)} h × {inr(cur.u.incentivePerHour)} = {inr(Math.round(cur.c.otPay))}</b></div>
            <div><span>Net payable</span><b>{inr(Math.round(cur.c.net))}</b></div>
          </div>
          <h4>Day-by-day register</h4>
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th>Late by</th><th>Grace used</th><th className="amt">OT mins</th></tr></thead>
              <tbody>{cur.c.days.map((d0) => (
                <tr key={d0.date}>
                  <td>{fmtDate(d0.date)}</td>
                  <td className={d0.status === "Absent" ? "danger" : ""}>{d0.status}</td>
                  <td>{d0.inT || "—"}</td><td>{d0.outT || "—"}</td>
                  <td className={d0.late ? "danger" : ""}>{d0.late ? d0.late + " min" : ""}</td>
                  <td>{d0.graceUsed ? d0.graceUsed + " min" : ""}</td>
                  <td className="amt">{d0.ot || ""}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
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

.amt{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.grp td{background:var(--brass-s);font-weight:600;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#6D4D11;padding:5px 10px}
.cambtn{display:inline-flex;flex-direction:column;gap:2px;align-items:flex-start}
.cam-alt{background:none;border:none;color:#8A6A1F;font-size:11px;cursor:pointer;padding:0;text-decoration:underline}
.sync-err{position:fixed;left:12px;right:12px;bottom:12px;z-index:99;background:#7A1F1F;color:#fff;padding:12px 16px;border-radius:10px;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
.sync-err button{float:right;background:none;border:none;color:#fff;font-size:16px;cursor:pointer}
.grp-row{background:var(--brass-s);font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#6D4D11;font-weight:600}
.cellsel{min-width:130px;padding:5px 6px;font-size:12px}
.pick{max-height:190px;overflow:auto;border:1px solid var(--line);border-radius:2px;padding:4px 12px;background:#fff}
.pick .check{margin-bottom:0;border-bottom:1px solid var(--line2);padding:7px 0}
.pick .check:last-child{border-bottom:0}

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
