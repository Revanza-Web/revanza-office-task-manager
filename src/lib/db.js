/* ============================================================
   Data layer. If VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are
   set, the app runs in LIVE mode: real sign-in, shared data,
   server-enforced permissions. Without them it stays a local demo.
   ============================================================ */
import { createClient } from "@supabase/supabase-js";

const url = "https://okwvvmohafnmgkmptigg.supabase.co";
const anon = "sb_publishable_k-ZWRKnnKDWeqv3wEylV2g_GO9-8DFt";
export const LIVE = Boolean(url && anon);
export const supabase = LIVE ? createClient(url, anon) : null;

const PENDING = "Pending Information";
const OWNER = "Owner / Super Admin";

/* Sign-in identity: Supabase auth accounts keyed on the mobile number.
   The fixed suffix only satisfies the minimum password length —
   the real secret is the user's PIN. Recommend 6-digit PINs later. */
const emailFor = (mobile) => `${mobile}@revanza.in`;
const pwFor = (pin) => `${pin}@Rvz#26`;

export async function sbSession() {
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}
export async function sbSignIn(mobile, pin) {
  const { error } = await supabase.auth.signInWithPassword({ email: emailFor(mobile), password: pwFor(pin) });
  return { error };
}
export async function sbSignUp(mobile, pin) {
  const { error } = await supabase.auth.signUp({ email: emailFor(mobile), password: pwFor(pin) });
  return { error };
}
export async function sbChangePin(pin) {
  const { error } = await supabase.auth.updateUser({ password: pwFor(pin) });
  return { error };
}
export async function sbSignOut() {
  await supabase.auth.signOut();
}

const PROFILE_CORE = ["id", "authId", "mobile", "name", "role", "status"];
const PAY_KEYS = ["salary", "salaryType", "incentivePerHour"];
const stripKeys = (obj, keys) => {
  const o = { ...obj };
  keys.forEach((k) => delete o[k]);
  return o;
};

export async function fetchAll() {
  const q = (t, mod) => {
    let s = supabase.from(t).select("*");
    if (mod) s = mod(s);
    return s.then((r) => r.data || []);
  };
  const [pr, pay, tk, cs, at, lv, ms, lc, st, au] = await Promise.all([
    q("profiles"), q("payroll"), q("tasks"), q("cases"), q("attendance"), q("leaves"),
    q("masters"), q("locations"), q("app_settings"),
    q("audit", (s) => s.order("ts", { ascending: false }).limit(300)),
  ]);
  const payMap = Object.fromEntries(pay.map((p) => [p.profile_id, p.data || {}]));
  const users = pr.map((r) => ({
    // defaults first, stored data wins
    email: PENDING, altMobile: PENDING, dept: "—", designation: r.role, manager: "Sushil",
    workStart: "09:30", workEnd: "18:30", graceMins: 15, weeklyOff: "Sunday",
    locationId: "LOC1", radiusM: 250, leaveBalance: 12, logins: [],
    mustChangePin: false, failed: 0, locked: false, pin: "",
    salary: "", salaryType: "Monthly", incentivePerHour: 0, doj: "",
    ...(r.data || {}),
    ...(payMap[r.id] || {}),
    id: r.id, authId: r.auth_id, mobile: r.mobile || PENDING,
    name: r.name, role: r.role, status: r.status,
  })).sort((a, b) => (a.empCode || "").localeCompare(b.empCode || ""));
  return {
    users,
    tasks: tk.map((r) => r.data),
    cases: cs.map((r) => r.data),
    attendance: at.map((r) => r.data),
    leaves: lv.map((r) => r.data),
    masters: Object.fromEntries(ms.map((r) => [r.key, r.items])),
    locations: lc.map((r) => r.data),
    settings: (st[0] && st[0].data) || { morningDue: "10:30", ownerEmail: "md@revanza.in" },
    audit: au.map((r) => ({ ts: new Date(r.ts).getTime(), by: r.by_name, action: r.action, detail: r.detail })),
  };
}

/* One row per record; key columns are mirrored so the database
   can enforce who may touch which row. */
const rowBuilders = {
  users: (u) => ["profiles", {
    id: u.id,
    auth_id: u.authId || null,
    mobile: u.mobile && u.mobile !== PENDING ? u.mobile : null,
    name: u.name, role: u.role, status: u.status,
    data: stripKeys(u, [...PROFILE_CORE, ...PAY_KEYS, "pin"]),
  }],
  tasks: (t) => ["tasks", { id: t.id, assigned_to: t.assignedTo || null, assigned_by: t.assignedBy || null, status: t.status, data: t }],
  cases: (c) => ["cases", { id: c.id, associate: c.associate || null, data: c }],
  attendance: (a) => ["attendance", { id: a.id, profile_id: a.userId, date: a.date, data: a }],
  leaves: (l) => ["leaves", { id: l.id, profile_id: l.userId, status: l.status, data: l }],
  locations: (l) => ["locations", { id: l.id, data: l }],
};

/* Compares the workspace before and after a change and pushes only
   what changed. Last write wins; a background refresh pulls in
   everyone else's changes. */
export async function syncDB(prev, next, meRole) {
  const jobs = [];
  for (const col of Object.keys(rowBuilders)) {
    const before = Object.fromEntries((prev[col] || []).map((x) => [x.id, JSON.stringify(x)]));
    for (const item of next[col] || []) {
      if (before[item.id] !== JSON.stringify(item)) {
        const [table, row] = rowBuilders[col](item);
        jobs.push(supabase.from(table).upsert(row));
        if (col === "users" && meRole === OWNER) {
          jobs.push(supabase.from("payroll").upsert({
            profile_id: item.id,
            data: { salary: item.salary || "", salaryType: item.salaryType || "Monthly", incentivePerHour: item.incentivePerHour || 0 },
          }));
        }
      }
    }
  }
  for (const key of Object.keys(next.masters || {})) {
    if (JSON.stringify(next.masters[key]) !== JSON.stringify((prev.masters || {})[key])) {
      jobs.push(supabase.from("masters").upsert({ key, items: next.masters[key] }));
    }
  }
  if (JSON.stringify(next.settings) !== JSON.stringify(prev.settings)) {
    jobs.push(supabase.from("app_settings").upsert({ id: 1, data: next.settings }));
  }
  const newAudit = (next.audit || []).length - (prev.audit || []).length;
  for (let i = 0; i < newAudit; i++) {
    const a = next.audit[i];
    jobs.push(supabase.from("audit").insert({ by_name: a.by, action: a.action, detail: a.detail }));
  }
  const results = await Promise.allSettled(jobs);
  results.forEach((r) => {
    if (r.status === "fulfilled" && r.value && r.value.error) console.error("sync:", r.value.error.message);
    if (r.status === "rejected") console.error("sync:", r.reason);
  });
}
