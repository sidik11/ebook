const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const { google } = require("googleapis");
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Load local .env if present
function loadEnv() {
  const envPaths = [
    path.resolve(__dirname, ".env"),
    path.resolve(__dirname, "../.env"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "api/.env")
  ];
  for (const envFile of envPaths) {
    if (fs.existsSync(envFile)) {
      try {
        if (typeof process.loadEnvFile === "function") {
          process.loadEnvFile(envFile);
          break;
        }
      } catch {
        try {
          const content = fs.readFileSync(envFile, "utf8");
          for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eq = trimmed.indexOf("=");
            if (eq > 0) {
              const k = trimmed.slice(0, eq).trim();
              let v = trimmed.slice(eq + 1).trim();
              if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                v = v.slice(1, -1);
              }
              if (!process.env[k]) process.env[k] = v;
            }
          }
          break;
        } catch {}
      }
    }
  }
}
loadEnv();

// Password-reset OTPs and session tokens depend on this secret. Fail during
// module initialization so a misconfigured deployment cannot run insecurely.
const AUTH_SESSION_SECRET = String(process.env.AUTH_SESSION_SECRET || "");
if (Buffer.byteLength(AUTH_SESSION_SECRET, "utf8") < 32) {
  throw new Error("AUTH_SESSION_SECRET is required and must be at least 32 bytes. Generate a strong random secret and configure it in the API environment.");
}

// Firebase initialization with graceful degradation
let firebaseInitialized = false;
let dbInstance = null;
let bucketInstance = null;
let r2Client = null;

function getR2() {
  const bucket = String(process.env.BUCKET || "").trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY || "").trim();
  const secretAccessKey = String(process.env.R2_SECRET_KEY || "").trim();
  const endpoint = String(process.env.R2_ENDPOINT || "").trim();
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;
  if (!r2Client) r2Client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
  return { client: r2Client, bucket };
}
function requireR2() {
  const r2 = getR2();
  if (!r2) fail(503, "R2 storage is not configured. Set BUCKET, R2_ACCESS_KEY, R2_SECRET_KEY, and R2_ENDPOINT.");
  return r2;
}
async function r2SignedGet(keyName) {
  const r2 = requireR2();
  return getSignedUrl(r2.client, new GetObjectCommand({ Bucket: r2.bucket, Key: keyName }), { expiresIn: Math.floor(SIGNED_URL_MS / 1000) });
}
function isR2Path(value) { return /^private\/(ebooks|covers)\/[a-f0-9-]+\.(pdf|jpg|png|webp)$/.test(String(value || "")); }
function isR2Book(book) { return book?.storageProvider === "r2"; }

function getFirebase() {
  if (firebaseInitialized && dbInstance) {
    return { db: dbInstance, bucket: bucketInstance };
  }

  if (admin.apps.length > 0) {
    dbInstance = admin.database();
    try { bucketInstance = admin.storage().bucket(); } catch {}
    firebaseInitialized = true;
    return { db: dbInstance, bucket: bucketInstance };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

  if (!projectId || !clientEmail || !privateKey || !databaseURL) {
    return null;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey
      }),
      databaseURL,
      ...(storageBucket ? { storageBucket } : {})
    });
    dbInstance = admin.database();
    bucketInstance = admin.storage().bucket();
    firebaseInitialized = true;
    return { db: dbInstance, bucket: bucketInstance };
  } catch (err) {
    console.error("Firebase initialization failed:", err.message);
    return null;
  }
}

function requireDb() {
  const fb = getFirebase();
  if (!fb || !fb.db) {
    fail(503, "Firebase database is not configured. Please set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and FIREBASE_DATABASE_URL.");
  }
  return fb.db;
}

function requireBucket() {
  const fb = getFirebase();
  if (!fb || !fb.bucket) {
    fail(503, "Firebase Storage is not configured. Please set FIREBASE_STORAGE_BUCKET.");
  }
  return fb.bucket;
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb", verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(cookieParser());

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNED_URL_MS = 5 * 60 * 1000;
const MAX_BOOK_PRICE = 100000;
const MAX_BOOK_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const PASSWORD_RESET_OTP_MS = 10 * 60 * 1000;
const PASSWORD_RESET_OTP_ATTEMPTS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITS = { login: 10, register: 8, forgot: 5, "forgot-user": 3, "reset-verify": 10, "admin-setup": 3 };
const ADMIN_SETUP_LOCK_MS = 5 * 60 * 1000;
const ADMIN_SETUP_KEY = String(process.env.ADMIN_SETUP_KEY || "");

function now() {
  return Date.now();
}

async function rateLimit(keyName, limit) {
  const db = requireDb();
  const ref = db.ref("rateLimits/" + hash(keyName));
  const result = await ref.transaction(current => {
    const t = now();
    if (!current || t - Number(current.startedAt || 0) >= RATE_WINDOW_MS) {
      return { startedAt: t, count: 1 };
    }
    return {
      startedAt: Number(current.startedAt),
      count: Number(current.count || 0) + 1
    };
  });
  const count = Number(result.snapshot.val()?.count || 0);
  return count <= limit;
}

function requestIp(req) {
  return String(req.ip || req.get("x-forwarded-for") || "unknown").split(",")[0].trim().slice(0, 80);
}

async function enforceRateLimit(req, bucket, limit) {
  const allowed = await rateLimit(bucket + ":" + requestIp(req), limit);
  if (!allowed) fail(429, "Too many requests. Please try again later.");
}

function requireAdminSetupKey(req) {
  if (ADMIN_SETUP_KEY.length < 16) {
    fail(503, "Admin setup is disabled until ADMIN_SETUP_KEY is configured.");
  }
  const supplied = String(req.get("x-admin-setup-key") || "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_SETUP_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    fail(403, "Invalid admin setup key.");
  }
}

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return salt.toString("base64url") + "." + key.toString("base64url");
}

function passwordOK(password, encoded) {
  try {
    const [salt, stored] = String(encoded).split(".");
    const actual = crypto.scryptSync(password, Buffer.from(salt, "base64url"), 64);
    const expected = Buffer.from(stored, "base64url");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function validEmail(value) {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPassword(value) {
  return typeof value === "string" && value.length >= 10 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

function safeText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function isValidDateOnly(value) {
  const dateOnly = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return false;
  const parsed = new Date(dateOnly + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateOnly;
}

function key(value) {
  return String(value).replace(/[.#$\\[\\]]/g, "_").slice(0, 768);
}

async function get(dbPath) {
  const db = requireDb();
  return db.ref(dbPath).once("value").then(s => s.exists() ? s.val() : null);
}

async function set(dbPath, value) {
  const db = requireDb();
  return db.ref(dbPath).set(value);
}

async function update(dbPath, value) {
  const db = requireDb();
  return db.ref(dbPath).update(value);
}

async function remove(dbPath) {
  const db = requireDb();
  return db.ref(dbPath).remove();
}

async function createSession(userId) {
  const raw = randomToken();
  const csrf = randomToken();
  const sessionId = hash(raw);
  await set("sessions/" + sessionId, {
    userId,
    csrf,
    csrfHash: hash(csrf),
    createdAt: now(),
    expiresAt: now() + SESSION_MS,
    revoked: false
  });
  return { raw, csrf };
}

const isProduction = process.env.NODE_ENV === "production" && !process.env.DEV_MODE;

function portalCookieNames(portal = "user") {
  if (portal === "admin") return { session: "ms_admin_session", csrf: "ms_admin_csrf" };
  if (portal === "sadmin") return { session: "ms_sadmin_session", csrf: "ms_sadmin_csrf" };
  return { session: "ms_session", csrf: "ms_csrf" };
}

function requestPortal(req) {
  const p = String(req.query?.portal || req.body?.portal || "").toLowerCase();
  return p === "admin" ? "admin" : p === "sadmin" ? "sadmin" : "user";
}

function setSession(res, session, portal = "user") {
  const names = portalCookieNames(portal);
  res.cookie(names.session, session.raw, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MS
  });
  res.cookie(names.csrf, session.csrf, {
    httpOnly: false,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MS
  });
}

async function current(req, portal = "user") {
  const names = portalCookieNames(portal);
  const raw = req.cookies[names.session];
  if (!raw) return null;
  const id = hash(raw);
  const session = await get("sessions/" + id);
  if (!session || session.revoked || Number(session.expiresAt) <= now()) return null;
  const user = await get("users/" + session.userId);
  if (!user || user.status !== "ACTIVE") return null;
  // Keep administrator and customer identities confined to their own portal.
  if (portal === "admin" && user.role !== "admin") return null;
  if (portal === "sadmin" && user.role !== "sadmin") return null;
  if (portal === "user" && ["admin", "sadmin"].includes(user.role)) return null;
  return { id, session, user, userId: session.userId, portal };
}

async function guard(req, res, portal = "user") {
  const auth = await current(req, portal);
  if (!auth) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return auth;
}

function csrf(req, auth) {
  const supplied = req.get("x-csrf-token");
  if (!supplied) return false;
  return hash(supplied) === auth.session.csrfHash;
}

function requireCsrf(req, res, auth) {
  if (!csrf(req, auth)) {
    res.status(403).json({ error: "Invalid CSRF token" });
    return false;
  }
  return true;
}

async function adminGuard(req, res) {
  const auth = await guard(req, res, "admin");
  if (!auth) return null;
  if (auth.user.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return auth;
}
async function sadminGuard(req, res) {
  const auth = await guard(req, res, "sadmin");
  if (!auth) return null;
  if (auth.user.role !== "sadmin") {
    res.status(403).json({ error: "Sub-admin access required" });
    return null;
  }
  return auth;
}

async function audit(action, auth, meta = {}) {
  try {
    const db = requireDb();
    const id = db.ref("auditLogs").push().key;
    await set("auditLogs/" + id, {
      action,
      actorId: auth?.userId || "system",
      actorEmail: auth?.user?.email || null,
      createdAt: now(),
      meta
    });
  } catch (err) {
    console.warn("Audit log write skipped:", err.message);
  }
}

async function publicBook(bookId, data) {
  const rawPrice = Number(data?.price || 0);
  const normalizedType = String(data?.type || "").toUpperCase() === "FREE" || rawPrice <= 0 ? "FREE" : "PAID";
  const book = {
    id: bookId,
    title: safeText(data?.title, MAX_BOOK_TITLE),
    author: safeText(data?.author, 120),
    category: safeText(data?.category, 80),
    publishedDate: safeText(data?.publishedDate, 10),
    description: safeText(data?.description, MAX_DESCRIPTION),
    type: normalizedType,
    price: normalizedType === "FREE" ? 0 : rawPrice,
    status: "ACTIVE"
  };
  delete book.storagePath;
  delete book.coverPath;
  delete book.storageProvider;
  if (data.coverPath) {
    try {
      if (isR2Book(data)) book.coverUrl = await r2SignedGet(data.coverPath);
      else {
        const bucket = requireBucket();
        const [url] = await bucket.file(data.coverPath).getSignedUrl({ action: "read", expires: now() + SIGNED_URL_MS, responseDisposition: "inline" });
        book.coverUrl = url;
      }
    } catch { book.coverUrl = null; }
  }
  return book;
}

async function listBooks(activeOnly = true, limit = 100) {
  const db = requireDb();
  // Normalize status in application code so older records with accidental
  // casing differences do not disappear from the storefront.
  const snap = await db.ref("books").once("value");
  const result = [];
  snap.forEach(child => {
    const data = child.val() || {};
    if (!activeOnly || String(data.status || "").toUpperCase() === "ACTIVE") {
      result.push({ id: child.key, data });
    }
  });
  result.sort((a, b) => Number(b.data?.createdAt || 0) - Number(a.data?.createdAt || 0));
  return result.slice(0, limit);
}

async function owned(userId, bookId) {
  return get("purchases/" + hash(userId + ":" + bookId));
}

function amountPaise(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_BOOK_PRICE) return null;
  return Math.round(n * 100);
}

function gmailClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  const sender = process.env.GMAIL_SENDER_EMAIL;
  if (!clientId || !clientSecret || !refreshToken || !validEmail(sender)) {
    fail(500, "Gmail API is not configured");
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return { gmail: google.gmail({ version: "v1", auth: oauth2 }), sender };
}

function gmailRawMessage({ from, to, subject, html }) {
  const lines = [
    "From: " + from,
    "To: " + to,
    "Subject: " + subject,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

async function sendGmail({ to, subject, html, text }) {
  const { gmail, sender } = gmailClient();
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: gmailRawMessage({ from: sender, to, subject, html }) }
  });
}

function resetOtpHash(userId, otp) {
  return hash(userId + ":" + otp + ":" + AUTH_SESSION_SECRET);
}

function getRazorpay() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    fail(503, "Razorpay payment gateway is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
  }
  return new Razorpay({ key_id, key_secret });
}

// Global Security, fail-closed CORS & preflight middleware.
const configuredPublicOrigin = (() => {
  const raw = String(process.env.PUBLIC_ORIGIN || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== raw.replace(/\/+$/, "")) {
      throw new Error("PUBLIC_ORIGIN must be an origin only (scheme + host + optional port), without a path.");
    }
    return parsed.origin;
  } catch (error) {
    throw new Error("Invalid PUBLIC_ORIGIN configuration: " + error.message);
  }
})();
if (isProduction && !configuredPublicOrigin) {
  throw new Error("PUBLIC_ORIGIN is required in production. Set it to the exact deployed frontend origin.");
}

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (isProduction) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.set("Cache-Control", req.path.includes("/api/") ? "no-store" : "public, max-age=60");

  const origin = req.get("origin");
  const isLocal = !isProduction && Boolean(origin) && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const originAllowed = !origin || isLocal || (configuredPublicOrigin && origin === configuredPublicOrigin);

  if (!originAllowed) {
    return req.method === "OPTIONS"
      ? res.status(403).end()
      : res.status(403).json({ error: "Origin not allowed" });
  }

  if (origin && (isLocal || configuredPublicOrigin && origin === configuredPublicOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, Authorization, X-Admin-Setup-Key");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Router for all API routes (mounted at /api and / to support all deployment styles)
const router = express.Router();

router.get("/health", (req, res) => {
  const ready = Boolean(getFirebase());
  res.json({
    ok: true,
    service: "MS Tech EBook",
    firebaseConfigured: ready,
    time: new Date().toISOString()
  });
});

router.post("/auth/register", async (req, res) => {
  try {
    await enforceRateLimit(req, "register", RATE_LIMITS.register);
    const { name, email: rawEmail, password } = req.body || {};
    const email = String(rawEmail || "").trim().toLowerCase();
    if (!safeText(name, 100) || !validEmail(email) || !validPassword(password)) {
      return res.status(400).json({ error: "Invalid account details. Password must be 10+ characters with uppercase, lowercase, and numbers." });
    }
    const userId = hash(email);
    const userPath = "users/" + userId;
    if (await get(userPath)) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    await set(userPath, {
      name: safeText(name, 100),
      email,
      passwordHash: passwordHash(password),
      role: "user",
      status: "ACTIVE",
      createdAt: now(),
      updatedAt: now()
    });
    // Registration creates the account only. Authentication happens explicitly through /auth/login.
    res.status(201).json({
      ok: true,
      registered: true,
      user: { name: safeText(name, 100), email, role: "user", mustChangePassword: false }
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Registration failed" });
  }
});

function validAdminId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{3,64}$/.test(value);
}

async function findUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!validEmail(normalized)) return null;
  const hashedId = hash(normalized);
  const direct = await get("users/" + hashedId);
  if (direct) return { userId: hashedId, user: direct };
  const indexedId = await get("adminEmailIndex/" + hashedId);
  if (indexedId) {
    const indexed = await get("users/" + indexedId);
    if (indexed) return { userId: indexedId, user: indexed };
  }
  return null;
}

async function adminSetupComplete() {
  try {
    return Boolean(await get("system/adminSetup"));
  } catch {
    return false;
  }
}

router.get("/setup/admin", async (req, res) => {
  try {
    if (await adminSetupComplete()) {
      return res.status(410).json({ error: "Admin setup is already completed." });
    }
    const legacy = await get("users/admin");
    const legacyAdmin = legacy?.role === "admin" ? legacy : null;
    res.json({ ok: true, setupRequired: true, existingLegacyAdmin: Boolean(legacyAdmin) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Admin setup status unavailable" });
  }
});

router.post("/setup/admin", async (req, res) => {
  let setupLockToken = null;
  let setupCompleted = false;
  try {
    requireAdminSetupKey(req);
    await enforceRateLimit(req, "admin-setup", RATE_LIMITS["admin-setup"]);
    if (await adminSetupComplete()) {
      return res.status(410).json({ error: "Admin setup is already completed." });
    }

    const db = requireDb();
    setupLockToken = randomToken();
    const lockRef = db.ref("system/adminSetupLock");
    const lockTx = await lockRef.transaction(current => {
      const fresh = current && Number(current.startedAt || 0) > now() - ADMIN_SETUP_LOCK_MS;
      if (fresh) return;
      return { token: setupLockToken, startedAt: now() };
    });
    if (!lockTx.committed) {
      return res.status(409).json({ error: "Admin setup is currently being initialized. Try again shortly." });
    }
    if (await adminSetupComplete()) {
      return res.status(410).json({ error: "Admin setup is already completed." });
    }

    const adminId = safeText(req.body?.adminId, 64);
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password;

    if (!validAdminId(adminId)) return res.status(400).json({ error: "Admin ID must be 3-64 characters using letters, numbers, _ or -." });
    if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid admin email address." });
    if (!validPassword(password)) return res.status(400).json({ error: "Password must be 10-128 characters and include uppercase, lowercase, and a number." });

    const targetPath = "users/" + adminId;
    const existingTarget = await get(targetPath);
    if (existingTarget && existingTarget.role !== "admin") return res.status(409).json({ error: "That admin ID is already used by another account." });

    const emailOwner = await get("users/" + hash(email));
    if (emailOwner && emailOwner.role !== "admin") return res.status(409).json({ error: "That email is already registered to another account." });

    const usersSnap = await db.ref("users").once("value");
    const existingAdmins = [];
    usersSnap.forEach(child => {
      const value = child.val();
      if (value?.role === "admin") existingAdmins.push({ id: child.key, user: value });
    });

    const user = {
      name: "Administrator",
      email,
      passwordHash: passwordHash(password),
      role: "admin",
      status: "ACTIVE",
      mustChangePassword: false,
      createdAt: existingTarget?.createdAt || now(),
      updatedAt: now()
    };

    const updates = {};
    for (const item of existingAdmins) {
      if (item.id !== adminId) {
        updates["users/" + item.id] = null;
        if (validEmail(item.user?.email)) updates["adminEmailIndex/" + hash(item.user.email)] = null;
      }
    }
    updates[targetPath] = user;
    updates["adminEmailIndex/" + hash(email)] = adminId;
    updates["system/adminSetup"] = { completedAt: now(), userId: adminId, email };

    const sessions = await db.ref("sessions").once("value");
    sessions.forEach(child => {
      const session = child.val();
      if (session?.userId && existingAdmins.some(item => item.id === session.userId) && session.userId !== adminId) {
        updates["sessions/" + child.key + "/revoked"] = true;
        updates["sessions/" + child.key + "/revokedAt"] = now();
      }
    });

    await db.ref().update(updates);
    setupCompleted = true;
    await audit("ADMIN_SETUP_COMPLETED", { userId: adminId, user }, { adminId, email });
    res.status(201).json({ ok: true, message: "Admin account created. The setup page is now permanently locked.", user: { name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    console.error("Admin setup error", e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Admin setup failed" });
  } finally {
    if (setupLockToken && !setupCompleted) {
      try {
        const db = requireDb();
        const snap = await db.ref("system/adminSetupLock").once("value");
        if (snap.val()?.token === setupLockToken) await db.ref("system/adminSetupLock").remove();
      } catch {}
    }
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    await enforceRateLimit(req, "login", RATE_LIMITS.login);
    const { email: rawEmail, password, otp } = req.body || {};
    const portal = ["admin", "sadmin"].includes(String(req.body?.portal || "")) ? String(req.body.portal) : "user";
    const login = String(rawEmail || "").trim().toLowerCase();
    let userId;
    let user;

    if (login === "admin") {
      const legacy = await get("users/admin");
      if (!legacy || legacy.role !== "admin") return res.status(401).json({ error: "Invalid email or password" });
      userId = "admin";
      user = legacy;
    } else if (validEmail(login)) {
      const found = await findUserByEmail(login);
      userId = found?.userId;
      user = found?.user;
    } else if (validAdminId(login)) {
      const candidate = await get("users/" + login);
      if (candidate && ["admin", "sadmin"].includes(candidate.role)) {
        userId = login;
        user = candidate;
      }
    } else {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    if (!user || user.status !== "ACTIVE" || typeof password !== "string" || !passwordOK(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if (portal === "admin" && user.role !== "admin") return res.status(403).json({ error: "Administrator credentials required." });
    if (portal === "sadmin" && user.role !== "sadmin") return res.status(403).json({ error: "Sub-admin credentials required." });
    if (portal === "user" && ["admin", "sadmin"].includes(user.role)) return res.status(403).json({ error: "Use the correct staff portal to sign in." });

    const firstLogin = ["admin", "sadmin"].includes(user.role) && user.mustChangePassword === true;
    if (user.role === "admin" && !firstLogin && process.env.ADMIN_TOTP_SECRET) {
      if (!verifyTotp(String(process.env.ADMIN_TOTP_SECRET), String(otp || ""))) {
        return res.status(401).json({ error: "Admin verification code required", code: "ADMIN_OTP_REQUIRED" });
      }
    }

    await update("users/" + userId, { lastLoginAt: now(), updatedAt: now() });
    const session = await createSession(userId);
    setSession(res, session, user.role === "admin" ? "admin" : user.role === "sadmin" ? "sadmin" : "user");
    res.json({
      ok: true,
      user: { name: user.name, email: user.email, role: user.role, mustChangePassword: Boolean(user.mustChangePassword) },
      csrfToken: session.csrf
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Login failed" });
  }
});

router.post("/auth/change-password", async (req, res) => {
  try {
    const auth = await guard(req, res, requestPortal(req));
    if (!auth || !requireCsrf(req, res, auth)) return;
    if (auth.user.role === "sadmin") return res.status(403).json({ error: "Sub-admin credentials can only be changed by the main administrator." });
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;

    if (typeof currentPassword !== "string" || !passwordOK(currentPassword, auth.user.passwordHash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    if (!validPassword(newPassword)) {
      return res.status(400).json({ error: "New password must be 10-128 characters and include uppercase, lowercase, and a number" });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must be different from the current password" });
    }

    const userPath = "users/" + auth.userId;
    await update(userPath, {
      passwordHash: passwordHash(newPassword),
      mustChangePassword: false,
      updatedAt: now()
    });

    const db = requireDb();
    const sessions = await db.ref("sessions").orderByChild("userId").equalTo(auth.userId).once("value");
    const sessionUpdates = {};
    sessions.forEach(child => {
      if (child.key !== auth.id) {
        sessionUpdates["sessions/" + child.key + "/revoked"] = true;
        sessionUpdates["sessions/" + child.key + "/revokedAt"] = now();
      }
    });
    if (Object.keys(sessionUpdates).length) await db.ref().update(sessionUpdates);

    await audit("PASSWORD_CHANGED", auth);
    res.json({ ok: true, message: "Password changed successfully." });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Password change failed" });
  }
});

router.post("/auth/forgot-password", async (req, res) => {
  try { await enforceRateLimit(req, "forgot", RATE_LIMITS.forgot); } catch (e) { return res.status(e.status || 429).json({ error: e.message || "Too many requests" }); }
  const generic = { ok: true, message: "If an account exists for this email, a verification code has been sent." };
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!validEmail(email)) return res.status(200).json(generic);
    // Apply an account-keyed quota as well as the IP quota. Keep the response
    // generic to avoid revealing whether an email address is registered.
    if (!(await rateLimit("forgot-user:" + hash(email), RATE_LIMITS["forgot-user"]))) {
      return res.status(200).json(generic);
    }
    const found = await findUserByEmail(email);
    const userId = found?.userId;
    const user = found?.user;
    if (!user || user.status !== "ACTIVE") return res.status(200).json(generic);

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const resetId = crypto.randomBytes(24).toString("base64url");
    await set("passwordResets/" + resetId, {
      userId,
      otpHash: resetOtpHash(userId, otp),
      createdAt: now(),
      expiresAt: now() + PASSWORD_RESET_OTP_MS,
      attempts: 0,
      consumed: false
    });

    try {
      await sendGmail({
        to: user.email,
        subject: "MS Tech EBook password reset code",
        text: "Your MS Tech EBook password reset code is " + otp + ". It expires in 10 minutes.",
        html: "<div style='font-family:Arial,sans-serif;max-width:560px;margin:auto'><h2>MS Tech EBook</h2><p>Your password reset verification code is:</p><div style='font-size:32px;font-weight:700;letter-spacing:8px;padding:18px 0'>" + otp + "</div><p>This code expires in 10 minutes and can be used once.</p><p>If you did not request this, you can safely ignore this email.</p></div>"
      });
    } catch (mailError) {
      await remove("passwordResets/" + resetId);
      console.error("Password reset email failed", mailError);
      return res.status(500).json({ error: "Password reset email could not be sent" });
    }
    res.cookie("ms_reset", resetId, { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/api/auth", maxAge: PASSWORD_RESET_OTP_MS });
    res.json(generic);
  } catch (e) {
    console.error("Forgot password error", e);
    res.status(500).json({ error: "Password reset request failed" });
  }
});

router.post("/auth/reset-password", async (req, res) => {
  try {
    // Distributed RTDB-backed limits protect both the endpoint and an
    // individual reset token, including across serverless instances.
    await enforceRateLimit(req, "reset-verify", RATE_LIMITS["reset-verify"]);

    const resetId = safeText(req.cookies.ms_reset, 100);
    const otp = safeText(req.body?.otp, 6);
    const password = req.body?.password;
    if (!resetId || !/^\d{6}$/.test(otp) || !validPassword(password)) {
      return res.status(400).json({ error: "Invalid reset details" });
    }
    if (!(await rateLimit("reset-token:" + resetId, PASSWORD_RESET_OTP_ATTEMPTS))) {
      return res.status(429).json({ error: "Too many verification attempts. Request a new code." });
    }

    const resetPath = "passwordResets/" + key(resetId);
    const resetRef = requireDb().ref(resetPath);
    const claimToken = crypto.randomBytes(24).toString("base64url");
    const timestamp = now();

    // One RTDB transaction serializes all competing verification attempts.
    // Incorrect codes increment attempts atomically; a correct code atomically
    // consumes the token, so parallel requests cannot both reset the password.
    const transaction = await resetRef.transaction(current => {
      if (!current || current.consumed || Number(current.expiresAt) <= timestamp) return;
      const attempts = Number(current.attempts || 0);
      if (attempts >= PASSWORD_RESET_OTP_ATTEMPTS) return;
      if (resetOtpHash(current.userId, otp) === current.otpHash) {
        return { ...current, consumed: true, consumedAt: timestamp, consumeToken: claimToken };
      }
      return { ...current, attempts: attempts + 1, lastAttemptAt: timestamp };
    });

    const reset = transaction.snapshot.val();
    if (!transaction.committed || !reset) {
      return res.status(400).json({ error: "Invalid or expired verification code" });
    }
    if (reset.consumeToken !== claimToken) {
      if (Number(reset.attempts || 0) >= PASSWORD_RESET_OTP_ATTEMPTS) {
        return res.status(429).json({ error: "Too many verification attempts. Request a new code." });
      }
      return res.status(400).json({ error: "Invalid verification code" });
    }

    const userPath = "users/" + reset.userId;
    const user = await get(userPath);
    if (!user || user.status !== "ACTIVE") {
      // The OTP remains consumed once claimed; it can never be replayed.
      return res.status(400).json({ error: "Account is unavailable" });
    }

    const db = requireDb();
    await db.ref().update({
      [userPath + "/passwordHash"]: passwordHash(password),
      [userPath + "/updatedAt"]: now(),
      [resetPath + "/consumeToken"]: null
    });
    res.clearCookie("ms_reset", { path: "/api/auth" });

    const sessions = await db.ref("sessions").orderByChild("userId").equalTo(reset.userId).once("value");
    const sessionUpdates = {};
    sessions.forEach(child => {
      sessionUpdates["sessions/" + child.key + "/revoked"] = true;
      sessionUpdates["sessions/" + child.key + "/revokedAt"] = now();
    });
    if (Object.keys(sessionUpdates).length) await db.ref().update(sessionUpdates);

    res.json({ ok: true, message: "Password reset successfully. Please log in with your new password." });
  } catch (e) {
    if (e.status === 429) return res.status(429).json({ error: e.message || "Too many requests. Please try again later." });
    console.error("Reset password error", e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Password reset failed" });
  }
});

router.post("/auth/logout", async (req, res) => {
  const portal = requestPortal(req);
  const names = portalCookieNames(portal);
  const auth = await current(req, portal);
  if (auth) await update("sessions/" + auth.id, { revoked: true, revokedAt: now() });
  res.clearCookie(names.session, { path: "/" });
  res.clearCookie(names.csrf, { path: "/" });
  res.json({ ok: true, portal });
});

router.get("/auth/me", async (req, res) => {
  try {
    const portal = requestPortal(req);
    const names = portalCookieNames(portal);
    const auth = await current(req, portal);
    if (!auth) return res.status(401).json({ error: "Not logged in" });
    res.json({
      user: {
        id: auth.userId,
        name: auth.user.name,
        email: auth.user.email,
        role: auth.user.role,
        mustChangePassword: Boolean(auth.user.mustChangePassword)
      },
      csrfToken: req.cookies[names.csrf] || auth.session.csrf || "",
      portal
    });
  } catch (e) {
    res.status(500).json({ error: "Authentication check failed" });
  }
});

router.get("/books", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, max-age=0");
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const books = await listBooks(true, limit);
    const publicBooks = await Promise.all(books.map(b => publicBook(b.id, b.data)));
    res.json({ books: publicBooks });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not load ebooks" });
  }
});

router.get("/books/:id", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, max-age=0");
    const id = key(req.params.id);
    const data = await get("books/" + id);
    if (!data || String(data.status || "").toUpperCase() !== "ACTIVE") return res.status(404).json({ error: "Book not found" });
    res.json({ book: await publicBook(id, data) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not load ebook" });
  }
});

// Browser uploads use a signed multipart POST policy instead of a cross-origin PUT.
// This avoids a CORS preflight and does not require granting the service account
// permission to modify the bucket's CORS configuration.
router.post("/admin/storage-cors", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const r2 = getR2();
    res.json({ ok: Boolean(r2), uploadMode: "r2-signed-put", corsRequired: true, message: r2 ? "Cloudflare R2 is configured. Browser uploads require an R2 bucket CORS rule for this site origin." : "R2 storage is not configured." });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Storage upload configuration unavailable" }); }
});

const STORAGE_UPLOADS = {
  "application/pdf": { folder: "ebooks", max: 100 * 1024 * 1024, ext: "pdf" },
  "image/jpeg": { folder: "covers", max: 5 * 1024 * 1024, ext: "jpg" },
  "image/png": { folder: "covers", max: 5 * 1024 * 1024, ext: "png" },
  "image/webp": { folder: "covers", max: 350 * 1024, ext: "webp" }
};

function storageUploadSpec(type) {
  return STORAGE_UPLOADS[type] || null;
}

function isManagedStoragePath(storagePath) {
  return /^private\/(ebooks|covers)\/[a-f0-9-]+\.(pdf|jpg|png|webp)$/.test(String(storagePath || ""));
}

router.post("/admin/upload-url", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const { name, type, size } = req.body || {};
    const spec = storageUploadSpec(type);
    if (type !== "application/pdf" && type !== "image/webp") return res.status(400).json({ error: "Cover images must be compressed to WebP before upload." });
    if (!name) return res.status(400).json({ error: "File name is required" });
    if (!spec) return res.status(400).json({ error: "Unsupported file type. Use PDF, JPG, PNG, or WEBP." });
    if (!Number.isFinite(Number(size)) || Number(size) <= 0) return res.status(400).json({ error: "Invalid file size" });
    if (Number(size) > spec.max) return res.status(400).json({ error: `File is too large. Maximum allowed for this file type is ${Math.round(spec.max / (1024 * 1024))} MB.` });
    const storagePath = "private/" + spec.folder + "/" + crypto.randomUUID() + "." + spec.ext;
    const r2 = requireR2();
    const uploadUrl = await getSignedUrl(r2.client, new PutObjectCommand({ Bucket: r2.bucket, Key: storagePath, ContentType: type }), { expiresIn: 15 * 60 });
    res.json({ mode: "signed-put", url: uploadUrl, path: storagePath, storageProvider: "r2", contentType: type, maxBytes: spec.max, expiresAt: now() + 15 * 60 * 1000 });
  } catch (e) {
    console.error("R2 upload URL error:", e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Could not create secure R2 upload URL", code: e.code || "R2_UPLOAD_URL_ERROR" });
  }
});

router.get("/admin/upload-status", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth) return;
    const storagePath = String(req.query?.path || "");
    if (!isR2Path(storagePath)) return res.status(400).json({ error: "Invalid R2 upload path" });
    const r2 = requireR2();
    try {
      const metadata = await r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: storagePath }));
      return res.json({ uploaded: true, path: storagePath, storageProvider: "r2", size: Number(metadata.ContentLength || 0), contentType: metadata.ContentType || null, etag: metadata.ETag || null });
    } catch (err) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") return res.json({ uploaded: false, path: storagePath, storageProvider: "r2" });
      throw err;
    }
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Could not verify R2 upload" }); }
});

router.delete("/admin/upload-file", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const storagePath = String(req.body?.path || "");
    if (!isR2Path(storagePath)) return res.status(400).json({ error: "Invalid R2 upload path" });
    const r2 = requireR2();
    await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: storagePath }));
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Could not remove incomplete R2 upload" }); }
});

function normalizeBookInput(body) {
  const type = body.type === "FREE" ? "FREE" : body.type === "PAID" ? "PAID" : null;
  const price = type === "FREE" ? 0 : Number(body.price);
  const storageProvider = body.storageProvider === "r2" ? "r2" : null;
  if (!type || !safeText(body.title, MAX_BOOK_TITLE) || !body.storagePath || !body.coverPath || storageProvider !== "r2") fail(400, "Invalid book details");
  if (!isR2Path(body.storagePath) || !isR2Path(body.coverPath)) fail(400, "Book files must be stored in R2.");
  if (type === "PAID" && (!Number.isFinite(price) || price <= 0 || price > MAX_BOOK_PRICE)) fail(400, "Invalid book price");
  return {
    title: safeText(body.title, MAX_BOOK_TITLE),
    author: safeText(body.author, 120),
    category: safeText(body.category, 80),
    description: safeText(body.description, MAX_DESCRIPTION),
    type,
    price: type === "FREE" ? 0 : Number(price),
    storageProvider,
    storagePath: String(body.storagePath),
    coverPath: String(body.coverPath)
  };
}

router.get("/admin/subadmins", async (req, res) => {
  try {
    const auth = await adminGuard(req, res); if (!auth) return;
    const snap = await requireDb().ref("users").once("value");
    const users = [];
    snap.forEach(child => { const u=child.val()||{}; if (u.role === "sadmin") users.push({ id: child.key, name: u.name || "", status: u.status || "ACTIVE", createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null }); });
    res.set("Cache-Control", "no-store, max-age=0"); res.json({ users });
  } catch(e) { res.status(e.status || 500).json({error:e.message || "Could not load sub-admins"}); }
});

router.post("/admin/subadmins", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const subAdminId = safeText(req.body?.userId, 64).toLowerCase();
    const password = req.body?.password;
    const name = safeText(req.body?.name || "Book Uploader", 120);
    if (!validAdminId(subAdminId)) return res.status(400).json({ error: "User ID must be 3-64 characters using letters, numbers, _ or -." });
    if (!validPassword(password)) return res.status(400).json({ error: "Password must be 10-128 characters and include uppercase, lowercase, and a number." });
    const existing = await get("users/" + subAdminId);
    if (existing) return res.status(409).json({ error: "That user ID is already in use." });
    const user = { name, email: null, passwordHash: passwordHash(password), role: "sadmin", status: "ACTIVE", mustChangePassword: false, createdAt: now(), createdBy: auth.userId, updatedAt: now() };
    await set("users/" + subAdminId, user);
    await audit("SUBADMIN_CREATED", auth, { subAdminId });
    res.status(201).json({ ok: true, user: { id: subAdminId, name, role: "sadmin", status: "ACTIVE", mustChangePassword: false } });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Could not create sub-admin" }); }
});


router.patch("/admin/subadmins/:id", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const subAdminId = key(req.params.id);
    const user = await get("users/" + subAdminId);
    if (!user || user.role !== "sadmin") return res.status(404).json({ error: "Sub-admin account not found." });
    const name = safeText(req.body?.name, 120);
    if (!name) return res.status(400).json({ error: "Display name is required." });
    const changes = { name, updatedAt: now(), updatedBy: auth.userId };
    if (typeof req.body?.password === "string" && req.body.password.length) {
      if (!validPassword(req.body.password)) return res.status(400).json({ error: "Password must be 10-128 characters and include uppercase, lowercase, and a number." });
      changes.passwordHash = passwordHash(req.body.password);
      changes.mustChangePassword = false;
    }
    await update("users/" + subAdminId, changes);
    if (changes.passwordHash) {
      const sessions = await requireDb().ref("sessions").orderByChild("userId").equalTo(subAdminId).once("value");
      const sessionUpdates = {};
      sessions.forEach(child => { sessionUpdates["sessions/" + child.key + "/revoked"] = true; sessionUpdates["sessions/" + child.key + "/revokedAt"] = now(); });
      if (Object.keys(sessionUpdates).length) await requireDb().ref().update(sessionUpdates);
    }
    await audit(changes.passwordHash ? "SUBADMIN_UPDATED_AND_PASSWORD_RESET" : "SUBADMIN_UPDATED", auth, { subAdminId });
    res.json({ ok: true, user: { id: subAdminId, name, status: changes.status || user.status || "ACTIVE" } });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Could not update sub-admin." }); }
});

router.patch("/admin/subadmins/:id/status", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const subAdminId = key(req.params.id);
    const user = await get("users/" + subAdminId);
    if (!user || user.role !== "sadmin") return res.status(404).json({ error: "Sub-admin account not found." });
    const status = String(req.body?.status || "").toUpperCase();
    if (!["ACTIVE", "BLOCKED"].includes(status)) return res.status(400).json({ error: "Status must be ACTIVE or BLOCKED." });
    await update("users/" + subAdminId, { status, updatedAt: now(), updatedBy: auth.userId });
    if (status === "BLOCKED") {
      const sessions = await requireDb().ref("sessions").orderByChild("userId").equalTo(subAdminId).once("value");
      const sessionUpdates = {};
      sessions.forEach(child => { sessionUpdates["sessions/" + child.key + "/revoked"] = true; sessionUpdates["sessions/" + child.key + "/revokedAt"] = now(); });
      if (Object.keys(sessionUpdates).length) await requireDb().ref().update(sessionUpdates);
    }
    await audit(status === "BLOCKED" ? "SUBADMIN_BLOCKED" : "SUBADMIN_UNBLOCKED", auth, { subAdminId });
    res.json({ ok: true, id: subAdminId, status });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Could not update sub-admin status." }); }
});

router.delete("/admin/subadmins/:id", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const subAdminId = key(req.params.id);
    const user = await get("users/" + subAdminId);
    if (!user || user.role !== "sadmin") return res.status(404).json({ error: "Sub-admin account not found." });
    const sessions = await requireDb().ref("sessions").orderByChild("userId").equalTo(subAdminId).once("value");
    const sessionUpdates = {};
    sessions.forEach(child => { sessionUpdates["sessions/" + child.key + "/revoked"] = true; sessionUpdates["sessions/" + child.key + "/revokedAt"] = now(); });
    const updates = { ["users/" + subAdminId]: null };
    for (const [path, value] of Object.entries(sessionUpdates)) updates[path] = value;
    await requireDb().ref().update(updates);
    await audit("SUBADMIN_DELETED", auth, { subAdminId });
    res.json({ ok: true, id: subAdminId });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Could not delete sub-admin." }); }
});

router.get("/sadmin/books", async (req, res) => {
  try {
    const auth = await sadminGuard(req, res);
    if (!auth) return;
    const books = await listBooks(false, 200);
    res.set("Cache-Control", "no-store, max-age=0");
    res.json({ books: await Promise.all(books.map(async b => ({ id: b.id, title: b.data.title, author: b.data.author, category: b.data.category, type: b.data.type, price: b.data.price, status: b.data.status, createdAt: b.data.createdAt, coverUrl: b.data.coverPath ? await publicBook(b.id, b.data).then(p => p.coverUrl) : null }))) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message || "Could not load catalogue" }); }
});

router.post("/sadmin/upload-url", async (req, res) => {
  try {
    const auth = await sadminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const { name, type, size } = req.body || {};
    const spec = storageUploadSpec(type);
    if (type !== "application/pdf" && type !== "image/webp") return res.status(400).json({ error: "Cover images must be compressed to WebP before upload." });
    if (!name || !spec || !Number.isFinite(Number(size)) || Number(size) <= 0 || Number(size) > spec.max) return res.status(400).json({ error: "Invalid file or unsupported upload type." });
    const r2 = requireR2();
    const extension = spec.ext;
    const storagePath = "private/" + (type === "application/pdf" ? "ebooks/" : "covers/") + crypto.randomUUID() + "." + extension;
    const command = new PutObjectCommand({ Bucket: r2.bucket, Key: storagePath, ContentType: type });
    const url = await getSignedUrl(r2.client, command, { expiresIn: 300 });
    res.json({ url, path: storagePath });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Could not prepare upload" }); }
});

router.get("/sadmin/upload-status", async (req, res) => {
  try {
    const auth = await sadminGuard(req, res);
    if (!auth) return;
    const storagePath = safeText(req.query.path, 500);
    if (!isR2Path(storagePath)) return res.status(400).json({ error: "Invalid storage path" });
    const r2 = requireR2();
    const meta = await r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: storagePath }));
    res.json({ uploaded: true, size: Number(meta.ContentLength || 0), contentType: meta.ContentType || "" });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Upload not verified" }); }
});

router.post("/sadmin/books", async (req, res) => {
  try {
    const auth = await sadminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const book = { ...normalizeBookInput(req.body || {}), category: "" };
    const r2 = requireR2();
    const [pdfMeta, coverMeta] = await Promise.all([
      r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: book.storagePath })),
      r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: book.coverPath }))
    ]);
    if (Number(pdfMeta.ContentLength || 0) <= 0 || Number(pdfMeta.ContentLength || 0) > STORAGE_UPLOADS["application/pdf"].max || String(pdfMeta.ContentType || "").toLowerCase() !== "application/pdf") fail(400, "PDF upload could not be verified.");
    if (Number(coverMeta.ContentLength || 0) <= 0 || Number(coverMeta.ContentLength || 0) > STORAGE_UPLOADS["image/webp"].max || String(coverMeta.ContentType || "").toLowerCase() !== "image/webp") fail(400, "Cover must be a compressed WebP image under 350 KB.");
    const db = requireDb();
    const id = db.ref("books").push().key;
    await set("books/" + id, { ...book, status: "PENDING_REVIEW", createdAt: now(), updatedAt: now(), createdBy: auth.userId, submittedByRole: "sadmin" });
    await audit("BOOK_SUBMITTED_FOR_REVIEW", auth, { bookId: id });
    res.status(201).json({ ok: true, id, status: "PENDING_REVIEW" });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Book could not be submitted" }); }
});

router.patch("/admin/books/:id/review", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const id = key(req.params.id);
    const decision = safeText(req.body?.decision, 20).toUpperCase();
    const note = safeText(req.body?.note, 1000);
    const category = safeText(req.body?.category, 80);
    const publishedDate = String(req.body?.publishedDate ?? "").trim();
    if (!["APPROVE", "REJECT"].includes(decision)) return res.status(400).json({ error: "Choose approve or reject." });
    if (decision === "APPROVE" && !category) return res.status(400).json({ error: "Choose a category before publishing this book." });
    if (decision === "APPROVE" && !isValidDateOnly(publishedDate)) return res.status(400).json({ error: "Choose a valid published date before publishing this book." });
    if (decision === "REJECT" && note.length < 5) return res.status(400).json({ error: "Add a rejection reason of at least 5 characters." });
    const db = requireDb();
    const reviewTime = now();
    const reviewTx = await db.ref("books/" + id).transaction(current => {
      if (!current || current.status !== "PENDING_REVIEW") return;
      return { ...current, ...(decision === "APPROVE" ? { category, publishedDate } : {}), status: decision === "APPROVE" ? "ACTIVE" : "REJECTED", reviewedAt: reviewTime, reviewedBy: auth.userId, reviewNote: note || null, updatedAt: reviewTime };
    });
    if (!reviewTx.committed) return res.status(409).json({ error: "This book is no longer pending review. Refresh the catalogue and check its current status." });
    await audit(decision === "APPROVE" ? "BOOK_APPROVED" : "BOOK_REJECTED", auth, { bookId: id });
    res.json({ ok: true, status: decision === "APPROVE" ? "ACTIVE" : "REJECTED" });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Review action failed" }); }
});

router.post("/admin/books", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const book = normalizeBookInput(req.body || {});
    if (!book.category) fail(400, "Choose or enter a category before publishing.");
    const publishedDate = String(req.body?.publishedDate ?? "").trim();
    if (!isValidDateOnly(publishedDate)) fail(400, "Choose a valid published date before publishing.");
    const r2 = requireR2();
    const [pdfMeta, coverMeta] = await Promise.all([
      r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: book.storagePath })),
      r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: book.coverPath }))
    ]);
    const pdfSize = Number(pdfMeta.ContentLength || 0);
    const coverSize = Number(coverMeta.ContentLength || 0);
    if (pdfSize <= 0 || pdfSize > STORAGE_UPLOADS["application/pdf"].max || String(pdfMeta.ContentType || "").toLowerCase() !== "application/pdf") fail(400, "PDF upload could not be verified in R2.");
    if (coverSize <= 0 || coverSize > STORAGE_UPLOADS["image/webp"].max || String(coverMeta.ContentType || "").toLowerCase() !== "image/webp") fail(400, "Cover must be a compressed WebP image under 350 KB.");
    const db = requireDb();
    const id = db.ref("books").push().key;
    await set("books/" + id, { ...book, publishedDate, status: "ACTIVE", createdAt: now(), updatedAt: now(), createdBy: auth.user.email });
    await audit("BOOK_CREATED", auth, { bookId: id });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Book could not be created" });
  }
});

router.get("/admin/books", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth) return;
    res.set("Cache-Control", "no-store, max-age=0");
    const books = await listBooks(false, 200);
    res.json({ books: books.map(b => ({ id: b.id, ...b.data })) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not load admin books" });
  }
});


router.get("/admin/analytics", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth) return;
    res.set("Cache-Control", "no-store, max-age=0");

    const db = requireDb();
    const [usersSnap, booksSnap, ordersSnap, purchasesSnap] = await Promise.all([
      db.ref("users").once("value"),
      db.ref("books").once("value"),
      db.ref("orders").once("value"),
      db.ref("purchases").once("value"),
    ]);

    const users = [];
    usersSnap.forEach(child => users.push({ id: child.key, ...(child.val() || {}) }));
    const books = [];
    booksSnap.forEach(child => books.push({ id: child.key, ...(child.val() || {}) }));
    const orders = [];
    ordersSnap.forEach(child => orders.push({ id: child.key, ...(child.val() || {}) }));
    const purchases = [];
    purchasesSnap.forEach(child => purchases.push({ id: child.key, ...(child.val() || {}) }));

    const customerUsers = users.filter(u => u.role !== "admin");
    const paidOrders = orders.filter(o => String(o.status || "").toUpperCase() === "PAID");
    const openOrders = orders.filter(o => String(o.status || "").toUpperCase() !== "PAID");
    const paidPurchases = purchases.filter(p => String(p.status || "").toUpperCase() === "PAID");
    const revenue = paidOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0);
    const purchaseRevenue = paidPurchases.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const totalBuyAmount = revenue || purchaseRevenue;
    const uniqueBuyers = new Set(paidOrders.map(o => o.userId).filter(Boolean));
    if (!uniqueBuyers.size) paidPurchases.forEach(p => { if (p.userId) uniqueBuyers.add(p.userId); });

    const nowTs = now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dayStart = startOfDay.getTime();
    const last7Start = nowTs - 7 * 24 * 60 * 60 * 1000;
    const last30Start = nowTs - 30 * 24 * 60 * 60 * 1000;
    const sumSince = since => paidOrders.filter(o => Number(o.createdAt || 0) >= since).reduce((sum, o) => sum + Number(o.amount || 0), 0);

    const topBookMap = new Map();
    paidOrders.forEach(order => {
      const bookId = String(order.bookId || "");
      if (!bookId) return;
      const current = topBookMap.get(bookId) || { bookId, sales: 0, revenue: 0 };
      current.sales += 1;
      current.revenue += Number(order.amount || 0);
      topBookMap.set(bookId, current);
    });
    const bookMap = new Map(books.map(book => [book.id, book]));
    const topBooks = [...topBookMap.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 7)
      .map(item => ({
        bookId: item.bookId,
        title: safeText(bookMap.get(item.bookId)?.title, MAX_BOOK_TITLE) || "Deleted book",
        sales: item.sales,
        revenue: item.revenue
      }));

    const dailyRevenue = [];
    for (let i = 6; i >= 0; i -= 1) {
      const day = new Date(dayStart - i * 24 * 60 * 60 * 1000);
      const next = day.getTime() + 24 * 60 * 60 * 1000;
      const amount = paidOrders
        .filter(o => Number(o.createdAt || 0) >= day.getTime() && Number(o.createdAt || 0) < next)
        .reduce((sum, o) => sum + Number(o.amount || 0), 0);
      dailyRevenue.push({
        date: day.toISOString().slice(5, 10),
        amount
      });
    }

    const activeBooks = books.filter(b => String(b.status || "").toUpperCase() === "ACTIVE").length;
    const paidBooks = books.filter(b => String(b.type || "").toUpperCase() === "PAID" && Number(b.price || 0) > 0).length;
    const freeBooks = books.filter(b => String(b.type || "").toUpperCase() === "FREE" || Number(b.price || 0) === 0).length;
    const blockedUsers = customerUsers.filter(u => String(u.status || "").toUpperCase() !== "ACTIVE").length;
    const totalUsers = customerUsers.length;
    const averageOrder = paidOrders.length ? totalBuyAmount / paidOrders.length : 0;

    const recentOrders = [...paidOrders]
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, 8)
      .map(order => {
        const customer = users.find(u => u.id === order.userId);
        const book = bookMap.get(order.bookId);
        return {
          id: order.id,
          userEmail: validEmail(customer?.email) ? customer.email : "—",
          userName: safeText(customer?.name, 120) || "Customer",
          bookTitle: safeText(book?.title, MAX_BOOK_TITLE) || "Deleted book",
          amount: Number(order.amount || 0),
          paymentId: safeText(order.paymentId, 100) || "—",
          orderId: safeText(order.razorpayOrderId || order.id, 100),
          createdAt: Number(order.createdAt || 0)
        };
      });

    res.json({
      ok: true,
      overview: {
        totalUsers,
        activeUsers: customerUsers.filter(u => String(u.status || "").toUpperCase() === "ACTIVE").length,
        blockedUsers,
        adminUsers: users.filter(u => u.role === "admin").length,
        totalBooks: books.length,
        activeBooks,
        paidBooks,
        freeBooks,
        totalOrders: orders.length,
        paidOrders: paidOrders.length,
        openOrders: openOrders.length,
        totalPurchases: paidPurchases.length,
        uniqueBuyers: uniqueBuyers.size,
        totalBuyAmount: totalBuyAmount,
        averageOrderValue: averageOrder,
        todayRevenue: sumSince(dayStart),
        last7DaysRevenue: sumSince(last7Start),
        last30DaysRevenue: sumSince(last30Start),
        paymentSuccessRate: orders.length ? (paidOrders.length / orders.length) * 100 : 0
      },
      dailyRevenue,
      topBooks,
      recentOrders
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not load administrator analytics" });
  }
});

router.get("/admin/users", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth) return;
    res.set("Cache-Control", "no-store, max-age=0");
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    const db = requireDb();
    const [snap, purchasesSnap] = await Promise.all([
      db.ref("users").once("value"),
      db.ref("purchases").once("value")
    ]);
    const purchaseStats = new Map();
    purchasesSnap.forEach(child => {
      const data = child.val() || {};
      if (String(data.status || "").toUpperCase() !== "PAID" || !data.userId) return;
      const current = purchaseStats.get(data.userId) || { purchases: 0, spent: 0 };
      current.purchases += 1;
      current.spent += Number(data.amount || 0);
      purchaseStats.set(data.userId, current);
    });

    const users = [];
    snap.forEach(child => {
      const data = child.val() || {};
      const stats = purchaseStats.get(child.key) || { purchases: 0, spent: 0 };
      users.push({
        id: child.key,
        name: safeText(data.name, 120),
        email: validEmail(data.email) ? data.email : "",
        role: data.role === "admin" ? "admin" : "user",
        status: String(data.status || "ACTIVE").toUpperCase() === "BLOCKED" ? "BLOCKED" : "ACTIVE",
        createdAt: Number(data.createdAt || 0),
        updatedAt: Number(data.updatedAt || 0),
        lastLoginAt: Number(data.lastLoginAt || 0),
        purchases: stats.purchases,
        spent: stats.spent
      });
    });
    users.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ users: users.slice(0, limit) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not load users" });
  }
});

router.patch("/admin/users/:id/status", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const userId = key(req.params.id);
    if (!userId || userId === auth.userId) return res.status(400).json({ error: "You cannot block your own administrator account." });

    const user = await get("users/" + userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.role === "admin") return res.status(403).json({ error: "Administrator accounts cannot be blocked from this panel." });

    const nextStatus = String(req.body?.status || "").toUpperCase() === "BLOCKED" ? "BLOCKED" : "ACTIVE";
    await update("users/" + userId, {
      status: nextStatus,
      updatedAt: now(),
      updatedBy: auth.user.email
    });

    if (nextStatus === "BLOCKED") {
      const sessions = await requireDb().ref("sessions").orderByChild("userId").equalTo(userId).once("value");
      const sessionUpdates = {};
      sessions.forEach(child => {
        sessionUpdates["sessions/" + child.key + "/revoked"] = true;
        sessionUpdates["sessions/" + child.key + "/revokedAt"] = now();
      });
      if (Object.keys(sessionUpdates).length) await requireDb().ref().update(sessionUpdates);
    }

    await audit(nextStatus === "BLOCKED" ? "USER_BLOCKED" : "USER_UNBLOCKED", auth, { userId });
    res.json({ ok: true, status: nextStatus });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Could not update user status" });
  }
});

router.get("/admin/complaints", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth) return;
    res.set("Cache-Control", "no-store, max-age=0");
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const snap = await requireDb().ref("supportComplaints").once("value");
    const complaints = [];
    snap.forEach(child => {
      const item = child.val() || {};
      complaints.push({
        id: child.key,
        userId: safeText(item.userId, 150),
        userName: safeText(item.userName, 120),
        userEmail: validEmail(item.userEmail) ? item.userEmail : "",
        category: safeText(item.category, 40),
        message: safeText(item.message, 2000),
        bookId: safeText(item.bookId, 150),
        orderId: safeText(item.orderId, 100),
        paymentId: safeText(item.paymentId, 100),
        status: safeText(item.status || "OPEN", 30).toUpperCase(),
        emailNotificationStatus: safeText(item.emailNotificationStatus || "UNKNOWN", 20).toUpperCase(),
        resolutionNote: safeText(item.resolutionNote, 1000),
        createdAt: Number(item.createdAt || 0),
        updatedAt: Number(item.updatedAt || item.createdAt || 0),
        resolvedAt: Number(item.resolvedAt || 0),
        resolvedBy: safeText(item.resolvedBy, 200)
      });
    });
    complaints.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ complaints: complaints.slice(0, limit) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not load complaints" });
  }
});

router.post("/admin/complaints/:id/refund", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const complaintId = key(req.params.id);
    const complaint = await get("supportComplaints/" + complaintId);
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });
    if (complaint.refund && Object.keys(complaint.refund).length) return res.status(409).json({ error: "A refund attempt already exists for this complaint. Reconcile its status in Razorpay before retrying; automatic retries are disabled to prevent duplicate refunds." });
    const paymentId = safeText(complaint.paymentId || req.body?.paymentId, 100);
    if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) return res.status(400).json({ error: "A valid Razorpay payment ID is required. Verify the complaint details first." });
    const razorpay = getRazorpay();
    const payment = await razorpay.payments.fetch(paymentId);
    if (!payment || payment.status !== "captured" || payment.captured !== true) return res.status(409).json({ error: "Payment is not captured. No refund was issued." });
    if (complaint.orderId && String(payment.order_id || "") !== String(complaint.orderId)) return res.status(409).json({ error: "The verified payment does not match the order ID recorded on this complaint." });
    const linkedOrder = payment.order_id ? await get("orders/" + key(payment.order_id)) : null;
    if (linkedOrder?.userId && complaint.userId && String(linkedOrder.userId) !== String(complaint.userId)) return res.status(409).json({ error: "The payment owner does not match the customer who submitted this complaint." });
    const requestedAmount = req.body?.amountPaise == null ? Number(payment.amount) - Number(payment.amount_refunded || 0) : Number(req.body.amountPaise);
    if (!Number.isInteger(requestedAmount) || requestedAmount <= 0 || requestedAmount > Number(payment.amount) - Number(payment.amount_refunded || 0)) return res.status(400).json({ error: "Refund amount is invalid or exceeds the remaining captured amount." });
    const db = requireDb();
    const lockRef = db.ref("supportComplaints/" + complaintId + "/refund");
    const lock = await lockRef.transaction(current => {
      if (current && ["PROCESSING", "SUBMITTED", "PROCESSED"].includes(String(current.status || ""))) return;
      if (current && Object.keys(current).length) return;
      return { status: "PROCESSING", paymentId, amountPaise: requestedAmount, requestedBy: auth.userId, requestedAt: now(), idempotencyKey: hash("complaint-refund:" + complaintId + ":" + paymentId + ":" + requestedAmount) };
    });
    if (!lock.committed) return res.status(409).json({ error: "A refund request is already being processed or has been issued." });
    try {
      const refund = await razorpay.payments.refund(paymentId, { amount: requestedAmount, speed: "normal", notes: { complaintId, reviewedBy: auth.userId, refundKey: hash("complaint-refund:" + complaintId + ":" + paymentId + ":" + requestedAmount).slice(0, 40) }, receipt: ("complaint_" + complaintId).slice(0, 40) });
      await update("supportComplaints/" + complaintId, { status: "REFUND_ISSUED", resolutionNote: safeText(req.body?.resolutionNote || "Refund approved by administrator after payment verification.", 1000), updatedAt: now(), updatedBy: auth.user.email, resolvedAt: now(), resolvedBy: auth.user.email, refund: { id: refund.id, paymentId, amountPaise: refund.amount, status: refund.status || "SUBMITTED", requestedAt: now(), requestedBy: auth.userId } });
      await audit("REFUND_INITIATED_BY_ADMIN", auth, { complaintId, paymentId, refundId: refund.id, amountPaise: refund.amount });
      return res.json({ ok: true, refund: { id: refund.id, status: refund.status, amountPaise: refund.amount, paymentId } });
    } catch (refundError) {
      // Provider outcome may be ambiguous (for example, timeout after acceptance).
      // Preserve a blocking UNKNOWN state; never permit an automatic second refund.
      try { await update("supportComplaints/" + complaintId + "/refund", { status: "UNKNOWN", paymentId, amountPaise: requestedAmount, lastCheckedAt: now(), error: safeText(refundError.message, 300), requestedBy: auth.userId }); } catch (persistError) { console.error("CRITICAL: refund state could not be persisted; reconcile Razorpay before retrying", complaintId, persistError.message); }
      throw refundError;
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Refund could not be processed. Verify Razorpay credentials and transaction status." });
  }
});

router.patch("/admin/complaints/:id", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const complaintId = key(req.params.id);
    const complaint = await get("supportComplaints/" + complaintId);
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });
    const allowedStatuses = new Set(["OPEN", "UNDER_REVIEW", "RESOLVED", "REJECTED"]);
    const status = safeText(req.body?.status, 30).toUpperCase();
    const resolutionNote = safeText(req.body?.resolutionNote, 1000);
    if (!allowedStatuses.has(status)) return res.status(400).json({ error: "Invalid complaint status" });
    if (["RESOLVED", "REJECTED"].includes(status) && resolutionNote.length < 5) {
      return res.status(400).json({ error: "Add a resolution note of at least 5 characters before closing this complaint." });
    }
    const timestamp = now();
    await update("supportComplaints/" + complaintId, {
      status,
      resolutionNote: resolutionNote || null,
      updatedAt: timestamp,
      updatedBy: auth.user.email,
      ...(["RESOLVED", "REJECTED"].includes(status) ? { resolvedAt: timestamp, resolvedBy: auth.user.email } : { resolvedAt: null, resolvedBy: null })
    });
    await audit("SUPPORT_COMPLAINT_UPDATED", auth, { complaintId, status });
    res.json({ ok: true, status });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Could not update complaint" });
  }
});

router.get("/admin/orders", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth) return;
    res.set("Cache-Control", "no-store, max-age=0");
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const snap = await requireDb().ref("orders").once("value");
    const rawOrders = [];
    snap.forEach(child => rawOrders.push({ id: child.key, ...(child.val() || {}) }));
    rawOrders.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    const orders = [];
    for (const order of rawOrders.slice(0, limit)) {
      const [customer, book] = await Promise.all([
        order.userId ? get("users/" + key(order.userId)) : null,
        order.bookId ? get("books/" + key(order.bookId)) : null,
      ]);
      orders.push({
        id: order.id,
        userId: order.userId || null,
        userEmail: validEmail(customer?.email) ? customer.email : "",
        bookId: order.bookId || null,
        bookTitle: safeText(book?.title, MAX_BOOK_TITLE),
        amount: Number(order.amount || 0),
        amountPaise: Number(order.amountPaise || 0),
        status: safeText(order.status, 30),
        razorpayOrderId: safeText(order.razorpayOrderId || order.id, 100),
        paymentId: safeText(order.paymentId, 100),
        createdAt: Number(order.createdAt || 0),
        updatedAt: Number(order.updatedAt || 0),
      });
    }
    res.json({ orders });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not load orders" });
  }
});

router.patch("/admin/books/:id", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const bookPath = "books/" + key(req.params.id);
    const existing = await get(bookPath);
    if (!existing) return res.status(404).json({ error: "Book not found" });
    const title = safeText(req.body.title, MAX_BOOK_TITLE);
    const type = req.body.type === "FREE" ? "FREE" : req.body.type === "PAID" ? "PAID" : null;
    const status = req.body.status === "DRAFT" ? "DRAFT" : req.body.status === "ACTIVE" ? "ACTIVE" : null;
    const price = type === "FREE" ? 0 : Number(req.body.price);
    const changes = {
      title, author: safeText(req.body.author, 120), category: safeText(req.body.category, 80),
      description: safeText(req.body.description, MAX_DESCRIPTION), type, price, status,
      updatedAt: now(), updatedBy: auth.user.email
    };
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "publishedDate")) {
      const publishedDate = String(req.body.publishedDate ?? "").trim();
      if (!isValidDateOnly(publishedDate)) return res.status(400).json({ error: "Choose a valid published date." });
      changes.publishedDate = publishedDate;
    }
    if (!title || !type || !status || (type === "PAID" && (!Number.isFinite(price) || price <= 0 || price > MAX_BOOK_PRICE))) return res.status(400).json({ error: "Invalid book details" });
    await update(bookPath, changes);
    await audit("BOOK_UPDATED", auth, { bookId: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Book could not be updated" });
  }
});

router.delete("/admin/books/:id", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const bookPath = "books/" + key(req.params.id);
    const book = await get(bookPath);
    if (!book) return res.status(404).json({ error: "Book not found" });
    if (isR2Book(book)) {
      const r2 = requireR2();
      for (const storagePath of [book.storagePath, book.coverPath]) {
        if (storagePath) { try { await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: storagePath })); } catch (e) { console.warn("R2 delete file error:", e.message); } }
      }
    } else {
      const bucket = requireBucket();
      for (const storagePath of [book.storagePath, book.coverPath]) {
        if (storagePath) { try { await bucket.file(storagePath).delete(); } catch (e) { if (e.code !== 404) console.warn("Delete file error:", e.message); } }
      }
    }
    await remove(bookPath);
    await audit("BOOK_DELETED", auth, { bookId: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Book could not be deleted" });
  }
});


function normalizeCouponCode(value) { return String(value || "").trim().toUpperCase(); }
function couponDiscount(coupon, priceRupees) {
  const percent = Number(coupon?.discountPercent || 0);
  if (!Number.isInteger(percent) || percent < 1 || percent > 90) return 0;
  return Math.min(Math.round(priceRupees * percent) / 100, priceRupees);
}
async function getActiveCoupon(code) {
  if (!/^[A-Z0-9]{12}$/.test(code)) return null;
  const coupon = await get("coupons/" + code);
  if (!coupon || coupon.status !== "ACTIVE" || (coupon.expiresAt && Number(coupon.expiresAt) <= now())) return null;
  return coupon;
}
router.post("/coupons/validate", async (req, res) => {
  try {
    const auth = await guard(req, res); if (!auth || !requireCsrf(req, res, auth)) return;
    const code = normalizeCouponCode(req.body?.code), bookId = key(req.body?.bookId);
    const book = await get("books/" + bookId);
    if (!book || book.status !== "ACTIVE" || book.type === "FREE" || !amountPaise(book.price)) return res.status(400).json({ error: "Coupons can only be used on paid books." });
    const coupon = await getActiveCoupon(code);
    if (!coupon) return res.status(400).json({ error: "Invalid or expired coupon code." });
    if (await get("couponUses/" + code + "/" + hash(auth.userId))) return res.status(409).json({ error: "You have already used this coupon." });
    const reservations = await requireDb().ref("coupons/" + code + "/reservations").once("value");
    let active = 0; reservations.forEach(child => { if (Number(child.val()?.expiresAt || 0) > now()) active++; });
    if (Number(coupon.usedCount || 0) + active >= Number(coupon.maxUses || 0)) return res.status(409).json({ error: "This coupon has reached its usage limit." });
    const originalPrice = Number(book.price || 0), discount = couponDiscount(coupon, originalPrice);
    res.set("Cache-Control", "no-store"); res.json({ ok: true, code, discountPercent: coupon.discountPercent, originalPrice, discount, finalPrice: Math.max(0, Math.round((originalPrice - discount) * 100) / 100) });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Could not validate coupon." }); }
});
router.get("/admin/coupons", async (req, res) => {
  try {
    const auth = await adminGuard(req, res); if (!auth) return;
    const [cs, us, usersSnap, booksSnap] = await Promise.all([requireDb().ref("coupons").once("value"), requireDb().ref("couponUses").once("value"), requireDb().ref("users").once("value"), requireDb().ref("books").once("value")]);
    const users = {}, books = {}, useMap = {};
    usersSnap.forEach(n => users[n.key] = n.val() || {}); booksSnap.forEach(n => books[n.key] = n.val() || {});
    us.forEach(codeNode => { useMap[codeNode.key] = []; codeNode.forEach(n => { const u=n.val()||{}; useMap[codeNode.key].push({ id:n.key,userId:u.userId||"",email:users[u.userId]?.email||"",bookId:u.bookId||"",bookTitle:books[u.bookId]?.title||u.bookId||"",orderId:u.orderId||"",discount:Number(u.discount||0),paidAmount:Number(u.paidAmount||0),usedAt:u.usedAt||null }); }); });
    const coupons=[]; cs.forEach(n=>{const c=n.val()||{};if(!c.code)return;coupons.push({code:n.key,discountPercent:Number(c.discountPercent||0),maxUses:Number(c.maxUses||0),usedCount:Number(c.usedCount||0),status:c.status||"ACTIVE",createdAt:c.createdAt||null,uses:(useMap[n.key]||[]).sort((a,b)=>Number(b.usedAt||0)-Number(a.usedAt||0))});});
    coupons.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)); res.set("Cache-Control","no-store, max-age=0"); res.json({coupons});
  } catch(e) { res.status(e.status||500).json({error:e.status?e.message:"Could not load coupons."}); }
});
router.post("/admin/coupons", async (req, res) => {
  try {
    const auth = await adminGuard(req, res); if (!auth || !requireCsrf(req, res, auth)) return;
    const code=normalizeCouponCode(req.body?.code), discountPercent=Number(req.body?.discountPercent), maxUses=Number(req.body?.maxUses);
    if(!/^[A-Z0-9]{12}$/.test(code)) return res.status(400).json({error:"Coupon code must contain exactly 12 letters or numbers."});
    if(!Number.isInteger(discountPercent)||discountPercent<1||discountPercent>90) return res.status(400).json({error:"Discount must be a whole percentage from 1 to 90."});
    if(!Number.isInteger(maxUses)||maxUses<1||maxUses>1000000) return res.status(400).json({error:"Usage limit must be a whole number from 1 to 1,000,000."});
    const tx=await requireDb().ref("coupons/"+code).transaction(current=>current?undefined:{code,discountPercent,maxUses,usedCount:0,status:"ACTIVE",createdAt:now(),createdBy:auth.userId,reservations:{}});
    if(!tx.committed) return res.status(409).json({error:"That coupon code already exists."});
    await audit("COUPON_CREATED",auth,{code,discountPercent,maxUses});
    res.status(201).json({ok:true,coupon:{code,discountPercent,maxUses,usedCount:0,status:"ACTIVE",createdAt:now(),uses:[]}});
  } catch(e) { res.status(e.status||500).json({error:e.status?e.message:"Could not create coupon."}); }
});
router.delete("/admin/coupons/:code", async (req, res) => {
  try {
    const auth=await adminGuard(req,res); if(!auth||!requireCsrf(req,res,auth)) return;
    const code=normalizeCouponCode(req.params.code), coupon=await get("coupons/"+code);
    if(!/^[A-Z0-9]{12}$/.test(code)) return res.status(400).json({error:"Invalid coupon code."});
    if(!coupon||!coupon.code) return res.status(404).json({error:"Coupon not found."});
    await update("coupons/"+code,{status:"DELETED",deletedAt:now(),deletedBy:auth.userId,reservations:null});
    await audit("COUPON_DELETED",auth,{code}); res.json({ok:true,code});
  } catch(e) { res.status(e.status||500).json({error:e.status?e.message:"Could not delete coupon."}); }
});

router.post("/orders/create", async (req, res) => {
  let lockPath = "";
  let lockToken = "";
  try {
    const auth = await guard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const bookId = key(req.body?.bookId);
    const book = await get("books/" + bookId);
    if (!book || book.status !== "ACTIVE") return res.status(404).json({ error: "Book not found" });
    const basePricePaise = amountPaise(book.price);
    if (book.type === "FREE" || !basePricePaise) return res.status(400).json({ error: "This ebook is free. No payment is required" });
    const couponCode = normalizeCouponCode(req.body?.couponCode);
    let coupon = null, discountRupees = 0, pricePaise = basePricePaise;
    if (couponCode) {
      coupon = await getActiveCoupon(couponCode);
      if (!coupon) return res.status(400).json({ error: "Invalid or expired coupon code." });
      if (await get("couponUses/" + couponCode + "/" + hash(auth.userId))) return res.status(409).json({ error: "You have already used this coupon." });
      discountRupees = couponDiscount(coupon, Number(book.price || 0));
      pricePaise = Math.max(100, basePricePaise - Math.round(discountRupees * 100));
      if (discountRupees <= 0) return res.status(400).json({ error: "This coupon is not valid for this purchase." });
      const reservationKey = hash(auth.userId + ":" + bookId);
      const couponTx = await requireDb().ref("coupons/" + couponCode).transaction(current => {
        if (!current || current.status !== "ACTIVE" || (current.expiresAt && Number(current.expiresAt) <= now())) return;
        const reservations = current.reservations || {};
        Object.keys(reservations).forEach(k => { if (Number(reservations[k]?.expiresAt || 0) <= now()) delete reservations[k]; });
        if (reservations[reservationKey] && Number(reservations[reservationKey].expiresAt) > now()) return current;
        if (Number(current.usedCount || 0) + Object.keys(reservations).length >= Number(current.maxUses || 0)) return;
        reservations[reservationKey] = { userId: auth.userId, bookId, expiresAt: now() + 30 * 60 * 1000 };
        return { ...current, reservations };
      });
      if (!couponTx.committed) return res.status(409).json({ error: "This coupon has reached its usage limit." });
    }
    const purchaseId = hash(auth.userId + ":" + bookId);
    const purchase = await owned(auth.userId, bookId);
    if (purchase?.status === "PAID") return res.status(409).json({ error: "Already purchased" });

    // Recover an unpaid order if the customer closed checkout or the lock expired.
    // Reusing the same provider order avoids creating a second payable order.
    lockPath = "checkoutLocks/" + purchaseId;
    const existingLock = await get(lockPath);
    if (existingLock?.orderId && Number(existingLock.expiresAt || 0) <= now()) {
      const existingOrder = await get("orders/" + key(existingLock.orderId));
      if (existingOrder?.status === "CREATED" && existingOrder.userId === auth.userId && existingOrder.bookId === bookId) {
        const razorpay = getRazorpay();
        const providerOrder = await razorpay.orders.fetch(existingLock.orderId);
        if (providerOrder && providerOrder.status !== "paid" && Number(providerOrder.amount) === Number(existingOrder.amountPaise)) {
          await update(lockPath, { status: "CREATED", updatedAt: now(), expiresAt: now() + 30 * 60 * 1000 });
          return res.json({ key: process.env.RAZORPAY_KEY_ID, order_id: providerOrder.id, amount: providerOrder.amount, currency: providerOrder.currency, name: "MS Tech EBook", description: book.title, recovered: true });
        }
      }
    }

    // Atomic lock protects against concurrent checkout requests.
    lockToken = randomToken();
    const lockTx = await requireDb().ref(lockPath).transaction(current => {
      if (current && Number(current.expiresAt || 0) > now()) return;
      // A stale lock linked to an unresolved order must be recovered, not replaced.
      if (current?.orderId && current.status !== "PAID") return;
      return { token: lockToken, userId: auth.userId, bookId, status: "CREATING", createdAt: now(), expiresAt: now() + 30 * 60 * 1000 };
    });
    if (!lockTx.committed) {
      return res.status(409).json({ error: "An earlier checkout is unresolved. Retry to resume it, or contact support if payment may already have been taken." });
    }

    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount: pricePaise, currency: "INR",
      receipt: ("ebook_" + now() + "_" + crypto.randomBytes(3).toString("hex")).slice(0, 40),
      notes: { userId: auth.userId, bookId }
    });
    await set("orders/" + order.id, {
      userId: auth.userId, bookId, amountPaise: order.amount, amount: Number((order.amount / 100).toFixed(2)),
      originalAmount: Number(book.price), discount: discountRupees, couponCode: coupon ? couponCode : "",
      status: "CREATED", createdAt: now(), razorpayOrderId: order.id
    });
    await update(lockPath, { status: "CREATED", orderId: order.id, updatedAt: now(), expiresAt: now() + 30 * 60 * 1000 });
    res.json({ key: process.env.RAZORPAY_KEY_ID, order_id: order.id, amount: order.amount, currency: order.currency, name: "MS Tech EBook", description: book.title, couponCode: coupon ? couponCode : "", discount: discountRupees });
  } catch (e) {
    if (lockPath && lockToken) {
      try {
        await requireDb().ref(lockPath).transaction(current => current?.token === lockToken ? null : undefined);
      } catch {}
    }
    res.status(e.status || 500).json({ error: e.status ? e.message : "Could not create order" });
  }
});

async function finalizePayment(paymentId, orderId) {
  const razorpay = getRazorpay();
  const payment = await razorpay.payments.fetch(paymentId);
  const order = await get("orders/" + orderId);
  if (!order) fail(404, "Order not found");
  if (payment.order_id !== orderId || payment.status !== "captured" || Number(payment.amount) !== Number(order.amountPaise)) {
    fail(400, "Payment verification failed");
  }

  const db = requireDb();
  const purchaseId = hash(order.userId + ":" + order.bookId);
  const purchasePath = "purchases/" + purchaseId;
  const eventPath = "paymentEvents/" + paymentId;
  const priorEvent = await get(eventPath);
  if (priorEvent?.status === "PROCESSED") return { alreadyProcessed: true };
  if (priorEvent?.status === "DUPLICATE_CAPTURED") return { alreadyProcessed: true, duplicateCaptured: true };

  // The purchase record is the single atomic entitlement gate. Only one
  // captured payment can claim it; parallel webhook/browser callbacks cannot
  // overwrite the first payment's entitlement.
  const purchaseTx = await db.ref(purchasePath).transaction(current => {
    if (current?.status === "PAID") return;
    return {
      userId: order.userId, bookId: order.bookId, orderId, paymentId,
      amount: order.amount, amountPaise: order.amountPaise, status: "PAID", purchasedAt: now()
    };
  });
  const currentPurchase = purchaseTx.snapshot.val();
  const duplicateCaptured = !purchaseTx.committed && currentPurchase?.status === "PAID" && currentPurchase.paymentId !== paymentId;

  // If a second distinct captured payment reached the gateway, preserve the
  // original entitlement and mark the extra charge for explicit refund review.
  const status = duplicateCaptured ? "DUPLICATE_CAPTURED" : "PAID";
  const event = {
    status: duplicateCaptured ? "DUPLICATE_CAPTURED" : "PROCESSED",
    orderId, userId: order.userId, bookId: order.bookId, processedAt: now(),
    refundStatus: duplicateCaptured ? "REVIEW_REQUIRED" : "NOT_REQUIRED",
    ...(duplicateCaptured ? { duplicateOfPaymentId: currentPurchase.paymentId } : {})
  };
  const updates = {
    ["orders/" + orderId + "/status"]: status,
    ["orders/" + orderId + "/paymentId"]: paymentId,
    ["orders/" + orderId + "/updatedAt"]: now(),
    [eventPath]: event,
    ["checkoutLocks/" + purchaseId + "/status"]: "PAID",
    ["checkoutLocks/" + purchaseId + "/updatedAt"]: now()
  };
  if (!duplicateCaptured && order.couponCode) {
    const code = normalizeCouponCode(order.couponCode);
    const usePath = "couponUses/" + code + "/" + hash(order.userId);
    const useTx = await db.ref(usePath).transaction(current => current || { userId: order.userId, bookId: order.bookId, orderId, discount: Number(order.discount || 0), originalAmount: Number(order.originalAmount || order.amount), paidAmount: Number(order.amount || 0), usedAt: now() });
    if (useTx.committed) {
      await db.ref("coupons/" + code).transaction(current => {
        if (!current) return;
        const reservations = current.reservations || {};
        delete reservations[hash(order.userId + ":" + order.bookId)];
        return { ...current, usedCount: Number(current.usedCount || 0) + 1, reservations };
      });
    }
  } else if (order.couponCode) {
    await db.ref("coupons/" + normalizeCouponCode(order.couponCode) + "/reservations/" + hash(order.userId + ":" + order.bookId)).remove();
  }
  if (duplicateCaptured) {
    updates["orders/" + orderId + "/refundStatus"] = "REVIEW_REQUIRED";
    updates["orders/" + orderId + "/duplicateOfPaymentId"] = currentPurchase.paymentId;
  }
  await db.ref().update(updates);
  return { alreadyProcessed: !purchaseTx.committed && !duplicateCaptured, duplicateCaptured };
}

router.post("/orders/verify", async (req, res) => {
  try {
    const auth = await guard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const { bookId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!bookId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: "Incomplete payment data" });
    const order = await get("orders/" + razorpay_order_id);
    if (!order || order.userId !== auth.userId || order.bookId !== key(bookId)) return res.status(403).json({ error: "Invalid order" });
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) return res.status(500).json({ error: "Payment verification unavailable" });
    const expected = crypto.createHmac("sha256", secret).update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
    if (expected.length !== String(razorpay_signature).length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(razorpay_signature)))) {
      return res.status(403).json({ error: "Payment verification failed" });
    }
    const finalization = await finalizePayment(razorpay_payment_id, razorpay_order_id);
    res.json({
      ok: true,
      duplicateCaptured: Boolean(finalization.duplicateCaptured),
      message: finalization.duplicateCaptured
        ? "This payment was captured but another payment already unlocked the book. The extra charge has been flagged for refund review."
        : "Payment verified successfully."
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Payment verification failed" });
  }
});

router.post("/webhooks/razorpay", async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.get("x-razorpay-signature");
    if (!secret || !signature) return res.status(401).json({ error: "Webhook not configured" });
    const raw = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body));
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }
    const event = req.body || {};
    const payment = event.payload?.payment?.entity;
    if (event.event === "payment.captured" && payment?.id && payment?.order_id) {
      await finalizePayment(payment.id, payment.order_id);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Webhook processing failed" });
  }
});

router.post("/support/complaints", async (req, res) => {
  try {
    await enforceRateLimit(req, "complaint", 5);
    const auth = await guard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const allowedCategories = new Set(["BOOK_NOT_UNLOCKED", "DUPLICATE_CHARGE", "PAYMENT_ISSUE", "OTHER"]);
    const category = safeText(req.body?.category, 40).toUpperCase();
    const message = safeText(req.body?.message, 2000);
    let bookId = req.body?.bookId ? key(req.body.bookId) : "";
    let orderId = safeText(req.body?.orderId, 100);
    let paymentId = safeText(req.body?.paymentId, 100);

    if (!allowedCategories.has(category) || message.length < 10) {
      return res.status(400).json({ error: "Choose a complaint type and provide at least 10 characters of detail." });
    }
    if (orderId) {
      const order = await get("orders/" + key(orderId));
      if (!order || order.userId !== auth.userId) return res.status(403).json({ error: "Order not found for this account." });
      bookId = bookId || order.bookId;
      paymentId = paymentId || order.paymentId || "";
    }
    if (paymentId) {
      const event = await get("paymentEvents/" + key(paymentId));
      if (event && event.userId !== auth.userId) return res.status(403).json({ error: "Payment does not belong to this account." });
      if (event) {
        orderId = orderId || event.orderId || "";
        bookId = bookId || event.bookId || "";
      }
    }
    if (bookId) {
      const book = await get("books/" + bookId);
      if (!book) return res.status(404).json({ error: "Book not found." });
      if (!orderId) {
        const ordersSnap = await requireDb().ref("orders").orderByChild("userId").equalTo(auth.userId).once("value");
        let latest = null;
        ordersSnap.forEach(child => {
          const item = child.val() || {};
          if (item.bookId === bookId && (!latest || Number(item.createdAt || 0) > Number(latest.createdAt || 0))) {
            latest = { ...item, id: child.key };
          }
        });
        if (latest) {
          orderId = latest.id;
          paymentId = paymentId || latest.paymentId || "";
        }
      }
    }

    const db = requireDb();
    const ref = db.ref("supportComplaints").push();
    const complaintId = ref.key;
    await ref.set({
      id: complaintId,
      userId: auth.userId,
      userEmail: auth.user.email,
      userName: auth.user.name,
      category,
      message,
      bookId: bookId || null,
      orderId: orderId || null,
      paymentId: paymentId || null,
      status: "OPEN",
      emailNotificationStatus: "PENDING",
      createdAt: now(),
      updatedAt: now()
    });

    // Email is best-effort: never lose a saved complaint because SMTP/OAuth
    // is unavailable. The complaint remains recorded for administrator review.
    let emailNotificationStatus = "FAILED";
    const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
    try {
      await sendGmail({
        to: "msinnovatex@gmail.com, Info@msinnovatex.com",
        subject: "MS Tech EBook support complaint " + complaintId,
        text: "A customer support complaint was submitted. ID: " + complaintId + "; Category: " + category + "; Customer: " + auth.user.email + "; Book: " + (bookId || "not provided") + "; Order: " + (orderId || "not provided") + "; Payment: " + (paymentId || "not provided") + "; Message: " + message,
        html: "<div style='font-family:Arial,sans-serif;max-width:640px;margin:auto'><h2>MS Tech EBook complaint</h2><p><strong>Complaint ID:</strong> " + escapeHtml(complaintId) + "</p><p><strong>Category:</strong> " + escapeHtml(category) + "</p><p><strong>Customer:</strong> " + escapeHtml(auth.user.name) + " (" + escapeHtml(auth.user.email) + ")</p><p><strong>Book ID:</strong> " + escapeHtml(bookId || "Not provided") + "</p><p><strong>Order ID:</strong> " + escapeHtml(orderId || "Not provided") + "</p><p><strong>Payment ID:</strong> " + escapeHtml(paymentId || "Not provided") + "</p><p><strong>Details:</strong></p><p>" + escapeHtml(message).replace(/\n/g, "<br>") + "</p><p>Status: OPEN</p></div>"
      });
      emailNotificationStatus = "SENT";
    } catch (mailError) {
      console.warn("Complaint email notification failed:", mailError.message);
    }
    try {
      await update("supportComplaints/" + complaintId, { emailNotificationStatus, updatedAt: now() });
    } catch (statusError) {
      console.warn("Complaint notification status update failed:", statusError.message);
    }
    await audit("SUPPORT_COMPLAINT_CREATED", auth, { complaintId, category, bookId: bookId || null, orderId: orderId || null, emailNotificationStatus });
    res.status(201).json({ ok: true, complaintId, status: "OPEN", message: "Complaint submitted. Please keep your complaint ID for follow-up.", emailNotificationStatus });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Could not submit complaint. Please email support." });
  }
});

router.get("/library", async (req, res) => {
  try {
    const auth = await guard(req, res);
    if (!auth) return;
    const db = requireDb();
    const purchaseSnap = await db.ref("purchases").orderByChild("userId").equalTo(auth.userId).once("value");
    const ids = new Set();
    purchaseSnap.forEach(child => {
      const p = child.val();
      if (p.status === "PAID") ids.add(p.bookId);
    });
    const activeBooks = await listBooks(true, 1000);
    activeBooks.forEach(b => {
      if (b.data.type === "FREE" || Number(b.data.price || 0) === 0) ids.add(b.id);
    });
    const books = [];
    for (const id of ids) {
      const b = await get("books/" + id);
      if (b && b.status === "ACTIVE") books.push(await publicBook(id, b));
    }
    res.json({ books });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Could not load your library" });
  }
});

router.get("/books/:id/secure-url", async (req, res) => {
  try {
    const auth = await guard(req, res);
    if (!auth) return;
    const id = key(req.params.id);
    const book = await get("books/" + id);
    if (!book || book.status !== "ACTIVE" || !book.storagePath) {
      return res.status(404).json({ error: "Ebook unavailable" });
    }
    const free = book.type === "FREE" || Number(book.price || 0) === 0;
    const isAdmin = auth.user.role === "admin";
    if (!free && !isAdmin) {
      const purchase = await owned(auth.userId, id);
      if (!purchase || purchase.status !== "PAID") {
        return res.status(403).json({ error: "Purchase required" });
      }
    }
    let url;
    if (isR2Book(book)) url = await r2SignedGet(book.storagePath);
    else {
      const bucket = requireBucket();
      [url] = await bucket.file(book.storagePath).getSignedUrl({ action: "read", expires: now() + SIGNED_URL_MS, responseDisposition: "inline" });
    }
    res.json({ url, expiresIn: SIGNED_URL_MS / 1000 });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Could not open ebook" });
  }
});

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = [];
  for (const char of String(input).replace(/=+$/, "").toUpperCase().replace(/\s/g, "")) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) throw new Error("Invalid TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

function totp(secret, counter) {
  const keyBuf = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", keyBuf).update(msg).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 1000000).padStart(6, "0");
}

function verifyTotp(secret, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let delta = -1; delta <= 1; delta++) {
    if (totp(secret, step + delta) === code) return true;
  }
  return false;
}


function xmlEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Dynamic sitemap: includes all currently published books, not just a fixed list.
// Vercel rewrites /sitemap.xml to this function using the seoPath query parameter.
app.use(async (req, res, next) => {
  const seoPath = String(req.query?.seoPath || "");
  if (req.method !== "GET" || !["/sitemap.xml", "/robots.txt"].includes(seoPath)) return next();
  try {
    const origin = String(process.env.PUBLIC_ORIGIN || "https://ebook-one-jade.vercel.app").replace(/\/+$/, "");
    if (seoPath === "/robots.txt") {
      res.status(200);
      res.type("text/plain; charset=utf-8");
      res.set("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
      return res.send("User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: " + origin + "/sitemap.xml\n");
    }
    const entries = [
      { path: "/", priority: "1.0", changefreq: "weekly" },
      { path: "/books", priority: "0.9", changefreq: "daily" },
      { path: "/support", priority: "0.5", changefreq: "monthly" },
      { path: "/refund-policy", priority: "0.3", changefreq: "yearly" }
    ];
    const publishedBooks = await listBooks(true, 10000);
    for (const item of publishedBooks) {
      const id = String(item.id || "");
      if (!id) continue;
      const updated = Number(item.data?.updatedAt || item.data?.createdAt || 0);
      entries.push({
        path: "/books/" + encodeURIComponent(id),
        priority: "0.7",
        changefreq: "monthly",
        lastmod: updated > 0 ? new Date(updated).toISOString().slice(0, 10) : ""
      });
    }
    const urls = entries.map(entry => {
      const lastmod = entry.lastmod ? `\n    <lastmod>${entry.lastmod}</lastmod>` : "";
      return `  <url>\n    <loc>${xmlEscape(origin + entry.path)}</loc>${lastmod}\n    <changefreq>${entry.changefreq}</changefreq>\n    <priority>${entry.priority}</priority>\n  </url>`;
    }).join("\n");
    res.status(200);
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  } catch (error) {
    console.error("Sitemap generation failed:", error.message);
    return res.status(503).type("text/plain").send("Sitemap temporarily unavailable");
  }
});

// Keep the API surface under /api only. The frontend SPA owns all other routes.
app.use("/api", router);

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error("Unhandled API error", err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

// Run directly if invoked with node
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`MS Tech EBook API listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
