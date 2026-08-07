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

## Camera and GPS

Attendance requires a photograph and reads GPS. Browsers only allow camera/location on **https** (Vercel provides this) or on `localhost` — so both work; a plain `http://` server on your office network will not.

## Replace the logo

Put your logo file in `public/` (e.g. `public/logo.png`) and it will be available at `/logo.png`. Then update the `Mark` component in `src/App.jsx` (or ask Claude to wire it in) and swap `public/icon.svg` for the app icon.
