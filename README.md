# Revanza Office Task Manager

Attendance (photo + GPS), task assignment and follow-up, legal case tracking, leave, calendar, reports and audit log — for Revanza.

**Prototype notice:** all data is stored unencrypted in each user's own browser (localStorage). There is no server, so:
- Data is NOT shared between devices or people. Each phone/laptop has its own copy.
- The PIN login and role restrictions are interface behaviour, not real security.
- OTP, WhatsApp, email and Google Calendar sync are not connected.

Use it to test and agree the workflow. Do not load real salary or sensitive case data.

## Run on your computer

Needs Node.js 18 or newer (https://nodejs.org).

```bash
npm install
npm run dev
```

Open the address it prints (usually http://localhost:5173).

**Demo sign-in:** mobile `9841344444`, PIN `1234` (Sushil, Owner). Use "Preview another role" on the login screen for staff views.

## Put it on GitHub

1. Create a new repository on github.com (e.g. `revanza-office-task-manager`), without a README.
2. In this folder, run:

```bash
git init
git add .
git commit -m "Revanza Office Task Manager prototype"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/revanza-office-task-manager.git
git push -u origin main
```

## Deploy on Vercel

1. Go to https://vercel.com and sign in with your GitHub account.
2. Click **Add New → Project**, and import the `revanza-office-task-manager` repository.
3. Vercel detects Vite automatically — leave the settings as they are and click **Deploy**.
4. You'll get a URL like `https://revanza-office-task-manager.vercel.app`. Open it on your phone; the browser will offer "Add to Home Screen" so it installs like an app.

Every time you push changes to GitHub, Vercel redeploys automatically.


## GOING LIVE (shared data + real sign-in) — about 15 minutes

The app has two modes. Without the two environment variables below it runs as a single-device demo. With them, it becomes the live office system: one shared database, real authentication, and permissions enforced by the database (payroll Owner-only, legal cases Owner + Legal Associates only, staff can only write their own attendance/leave, completed tasks locked at the server).

### Step 1 — Create the database (free)
1. Go to https://supabase.com → sign in with GitHub → **New project**.
2. Name it `revanza-rotm`, choose the region closest to Chennai (Mumbai / `ap-south-1`), set any strong database password (you won't need it day-to-day), and create.

### Step 2 — Load the schema
1. In the Supabase project, open **SQL Editor → New query**.
2. Open the file `supabase/schema.sql` from this project, copy ALL of it, paste, and click **Run**.
3. You should see "Success". This creates every table, all the permission rules, and the 15 Revanza staff.

### Step 3 — Auth settings
1. Go to **Authentication → Sign In / Providers → Email**.
2. Turn **OFF** "Confirm email" (sign-ins are by mobile number + PIN; there are no real inboxes). Save.

### Step 4 — Connect the app
1. In Supabase: **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
2. On Vercel: your project → **Settings → Environment Variables** → add:
   - `VITE_SUPABASE_URL` = the Project URL
   - `VITE_SUPABASE_ANON_KEY` = the anon key
3. Redeploy (Deployments → ⋯ → Redeploy). For local use, copy `.env.example` to `.env` and fill the same two values.

### Step 5 — First sign-ins
- Open the site → **"First time — create my PIN"** → mobile `9841344444` → choose your PIN. That's you (Owner).
- Staff do the same with their own numbers — but only numbers you have added can register. Most staff numbers are still "Pending Information": open **Employee Directory → Manage** and fill in each person's real mobile number first.

### Day-to-day notes for live mode
- **Forgot/reset a staff PIN:** Supabase dashboard → Authentication → Users → select the user → update password. The stored password is their PIN followed by `@Rvz#26` (e.g. PIN 5081 → `5081@Rvz#26`).
- **Deactivate someone:** Employee Directory → Manage → Deactivate (they can no longer use the app even if signed in elsewhere after refresh).
- **Backups:** Supabase → Database → Backups (daily on free tier).
- Changes made by one person appear for others within ~45 seconds or on switching back to the app.

### Still not included (needs paid services + server functions)
WhatsApp/SMS sending (Twilio/WhatsApp Business API), automatic emails to md@revanza.in, OTP login, and Google Calendar sync. The app shows the 11:30 reminder queue and daily summary so nothing is missed manually; wiring the actual sending is the next phase (Supabase Edge Functions + Twilio + an email provider).

## Camera and GPS

Attendance requires a photograph and reads GPS. Browsers only allow camera/location on **https** (Vercel provides this) or on `localhost` — so both work; a plain `http://` server on your office network will not.

## Replace the logo

Put your logo file in `public/` (e.g. `public/logo.png`) and it will be available at `/logo.png`. Then update the `Mark` component in `src/App.jsx` (or ask Claude to wire it in) and swap `public/icon.svg` for the app icon.
