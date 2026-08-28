# KalaSetu — Complete Firebase Setup & Deployment Handover Guide

This guide contains **everything your teammate needs** to set up, configure, wire, and deploy the KalaSetu Firebase backend and frontend from scratch.

---

## 📋 Overview of What is Being Deployed

| Component | Technology | Purpose |
|---|---|---|
| **Frontend PWA** | Vite + React + TypeScript + PWA | Artisan Mobile App |
| **Backend API** | Firebase Cloud Functions (v2) + Express.js | All API endpoints under `/api/**` |
| **Authentication** | Firebase Phone Auth (SMS OTP) | Artisan login with phone number |
| **Database** | Cloud Firestore (`asia-south1`) | Storing Users, Products, Categories |
| **Image Storage** | Cloud Storage (`asia-south1`) | Raw & Enhanced Product Photos |
| **AI Services** | Gemini 3.5 Transcribe & Gemini 3.5 Flash | Voice STT, Multilingual Translation, Anti-hallucination Descriptions, SIH26090 Smart Pricing |

---

## 🚀 Step-by-Step Setup Instructions

---

### Step 1: Create a New Firebase Project
1. Open the [Firebase Console](https://console.firebase.google.com/).
2. Click **Add project** (or **Create a project**).
3. Name it: `kalasetu-app` (or any unique name).
4. Disable Google Analytics (not required) → Click **Create Project**.
5. Note down your **Project ID** (e.g. `kalasetu-app-12345`).

---

### Step 2: Upgrade to Blaze Plan (Pay-As-You-Go)
> ⚠️ **CRITICAL**: Cloud Functions require the **Blaze plan**. It is free within generous monthly tiers (2M function calls, 5GB storage, 50k reads/day). You will not be charged unless you exceed these huge limits.

1. In the bottom-left sidebar of the Firebase Console, click **Upgrade** (next to Spark Plan).
2. Select **Blaze Plan** and attach a Google Billing account (credit/debit card).
3. Set a budget alert (e.g., ₹200 or $5) so you are notified of any unexpected usage.

---

### Step 3: Enable Phone Authentication
1. Go to **Build** → **Authentication** in the left sidebar.
2. Click **Get Started**.
3. Under the **Sign-in method** tab, click **Phone**.
4. Toggle **Enable** → Click **Save**.

#### 🧪 Add Test Numbers (For Testing Without Real SMS)
1. On the same Phone Auth page, expand **Phone numbers for testing**.
2. Add:
   - Phone Number: `+91 9999999999`
   - Test Code: `123456`
3. Click **Add** / **Save**.
*(You can use this number in the app and in Postman without consuming SMS quota).*

---

### Step 4: Create Cloud Firestore Database
1. Go to **Build** → **Firestore Database**.
2. Click **Create Database**.
3. Choose **Start in production mode** (our repository rules will configure access).
4. Choose Location: **`asia-south1` (Mumbai)** *(best latency for India)*.
5. Click **Enable**.

---

### Step 5: Enable Cloud Storage
1. Go to **Build** → **Storage**.
2. Click **Get Started**.
3. Choose **Start in production mode**.
4. Location: Select **`asia-south1` (Mumbai)**.
5. Click **Done**.
6. Note your **Storage Bucket Name** (e.g., `kalasetu-app-12345.firebasestorage.app` or `kalasetu-app-12345.appspot.com`).

---

### Step 6: Register the Web App & Get Frontend Keys
1. In the Firebase Console, click the **Settings Gear (⚙️)** → **Project settings**.
2. Under the **General** tab, scroll to **Your apps**.
3. Click the **Web `</>`** icon.
4. App nickname: `KalaSetu PWA`.
5. Check the box: **"Also set up Firebase Hosting"**.
6. Click **Register app**.
7. Copy the config values displayed:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "kalasetu-app-12345.firebaseapp.com",
  projectId: "kalasetu-app-12345",
  storageBucket: "kalasetu-app-12345.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef"
};
```

---

### Step 7: Get Gemini API Key for AI Features
1. Go to [Google AI Studio](https://aistudio.google.com/apikey).
2. Sign in with Google → Click **Create API Key**.
3. Select your Firebase Google Cloud Project or create a new key.
4. Copy the API Key (`AIzaSy...`).

---

## 💻 Local Codebase Setup & Configuration

Clone/pull the repository to your local machine and execute the following:

### 1. Configure the Frontend `.env` File
In the **root directory** of the project (`KalaSetu/`), create a `.env` file:

```env
# Root .env file

# Base URL for API calls
# For local development with emulator:
VITE_API_BASE_URL=http://127.0.0.1:5001/<YOUR_PROJECT_ID>/us-central1/api
# For production (after deployment):
# VITE_API_BASE_URL=/api

# Firebase Web App Config (From Step 6)
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=kalasetu-app-12345.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=kalasetu-app-12345
VITE_FIREBASE_STORAGE_BUCKET=kalasetu-app-12345.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=1234567890
VITE_FIREBASE_APP_ID=1:1234567890:web:abcdef
```

### 2. Configure the Backend `.env` File
In the **`functions/` directory**, create a `.env` file:

```env
# functions/.env file

# Google Gemini API Key (From Step 7)
GEMINI_API_KEY=AIzaSy...

# Optional model defaults
GEMINI_TRANSCRIBE_MODEL=gemini-3.5-transcribe
GEMINI_FLASH_MODEL=gemini-3.5-flash

# BHASHINI Translation (Phase 2 - Leave blank for automatic Gemini fallback)
BHASHINI_ULCA_USER_ID=
BHASHINI_ULCA_API_KEY=
BHASHINI_PIPELINE_ID=
```

---

## 🔗 Link Local Project to Firebase

Open a terminal in the root project folder (`KalaSetu/`):

```bash
# 1. Login to Firebase CLI
npx firebase-tools login

# 2. Link your Firebase project
npx firebase-tools use --add
```
- Select your newly created project from the list.
- Alias name: Type `default` and press Enter.

---

## 🛠️ Build & Run Locally (Emulators)

To test everything on your local machine with full offline database & functions:

```bash
# 1. Install frontend dependencies (root)
npm install

# 2. Install & build backend dependencies
cd functions
npm install
npm run build
cd ..

# 3. Start Firebase Emulators (Functions, Firestore, Storage)
npx firebase-tools emulators:start --only functions,firestore,storage
```

In a second terminal window, run the frontend dev server:
```bash
npm run dev
```

Visit `http://localhost:5173` in your browser. You can now test the phone login with `+91 9999999999` and OTP `123456`.

---

## 🚀 Full Production Deployment

When ready to deploy live to the cloud:

```bash
# 1. Deploy Firestore Security Rules and Composite Indexes
npx firebase-tools deploy --only firestore

# 2. Deploy Cloud Storage Security Rules
npx firebase-tools deploy --only storage

# 3. Set Backend Secret for Cloud Functions
npx firebase-tools functions:secrets:set GEMINI_API_KEY

# 4. Build and Deploy Cloud Functions Backend
cd functions
npm run build
cd ..
npx firebase-tools deploy --only functions

# 5. Build and Deploy Frontend PWA
# In root .env, ensure VITE_API_BASE_URL=/api is set
npm run build
npx firebase-tools deploy --only hosting
```

Or deploy everything in one command:
```bash
npm run build && npx firebase-tools deploy
```

---

## 🔍 Verification & Testing Checklist

Once deployed, verify each component:

- [ ] **Health Endpoint**: Open `https://<YOUR_PROJECT_ID>.web.app/api/health` in your browser. Should return `{"status":"ok","version":"1.0.0"}`.
- [ ] **Frontend**: Open `https://<YOUR_PROJECT_ID>.web.app/`.
- [ ] **Login Flow**: Sign in with phone number `+91 9999999999` / OTP `123456`.
- [ ] **Product Publishing**: Capture/upload a product photo, record a voice description, generate a price suggestion, and hit Publish.
- [ ] **Firestore Verification**: Open Firebase Console → Firestore Database → Check that `users` and `products` collections contain the published product.
- [ ] **Storage Verification**: Open Firebase Console → Storage → Check that uploaded photos appear in `/products/<userId>/...`.

---

## 🆘 Troubleshooting Common Issues

| Error | Cause | Fix |
|---|---|---|
| `Cloud Functions deployment failed: billing account not found` | Project is still on the free Spark plan | Upgrade project to **Blaze plan** in Firebase Console. |
| `Missing Authorization header` (401) | User is not signed in with Firebase Auth | Sign in first with phone OTP. The client automatically passes the JWT token. |
| `reCAPTCHA container not found` | Missing anchor element in DOM | Verify `<div id="recaptcha-container" />` exists in `PhoneEntryScreen.tsx`. |
| `Index not found error in Firestore query` | Firestore composite index missing | Run `npx firebase-tools deploy --only firestore:indexes`. |
| `CORS Error in browser` | Frontend calling functions without `/api` rewrite | Ensure `VITE_API_BASE_URL=/api` in production `.env` so all calls route through Firebase Hosting. |
