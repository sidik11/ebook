const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const { google } = require("googleapis");

if (!admin.apps.length) {
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey || !process.env.FIREBASE_DATABASE_URL || !process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error("Firebase server configuration is incomplete");
  }
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
}

const db = admin.database();
const bucket = admin.storage().bucket();
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
const RATE_LIMITS = { login: 10, register: 8, forgot: 5 };
const rateBuckets = new Map();
function rateLimit(keyName, limit) {
  const t = now();
  const old = rateBuckets.get(keyName);
  if (!old || t - old.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(keyName, { startedAt: t, count: 1 });
    return true;
  }
  old.count += 1;
  return old.count <= limit;
}
function requestIp(req) {
  return String(req.ip || req.get("x-forwarded-for") || "unknown").split(",")[0].trim().slice(0, 80);
}
function enforceRateLimit(req, bucket, limit) {
  if (!rateLimit(bucket + ":" + requestIp(req), limit)) fail(429, "Too many requests. Please try again later.");
}
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const now = () => Date.now();

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
function key(value) {
  return String(value).replace(/[.#$\\[\\]/]/g, "_").slice(0, 768);
}

async function get(path) {
  return db.ref(path).once("value").then(s => s.exists() ? s.val() : null);
}
async function set(path, value) { return db.ref(path).set(value); }
async function update(path, value) { return db.ref(path).update(value); }
async function remove(path) { return db.ref(path).remove(); }

async function createSession(userId) {
  const raw = randomToken();
  const csrf = randomToken();
  const sessionId = hash(raw);
  await set("sessions/" + sessionId, {
    userId,
    csrfHash: hash(csrf),
    createdAt: now(),
    expiresAt: now() + SESSION_MS,
    revoked: false
  });
  return { raw, csrf };
}
function setSession(res, session) {
  res.cookie("ms_session", session.raw, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_MS
  });
  res.cookie("ms_csrf", session.csrf, {
    httpOnly: false, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_MS
  });
}
async function current(req) {
  const raw = req.cookies.ms_session;
  if (!raw) return null;
  const id = hash(raw);
  const session = await get("sessions/" + id);
  if (!session || session.revoked || Number(session.expiresAt) <= now()) return null;
  const user = await get("users/" + session.userId);
  if (!user || user.status !== "ACTIVE") return null;
  return { id, session, user, userId: session.userId };
}
async function guard(req, res) {
  const auth = await current(req);
  if (!auth) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return auth;
}
function csrf(req, auth) {
  const supplied = req.get("x-csrf-token");
  return Boolean(supplied && hash(supplied) === auth.session.csrfHash);
}
function requireCsrf(req, res, auth) {
  if (!csrf(req, auth)) {
    res.status(403).json({ error: "Invalid CSRF token" });
    return false;
  }
  return true;
}
async function adminGuard(req, res) {
  const auth = await guard(req, res);
  if (!auth) return null;
  // Role is always read from the current user record, never trusted from the session.
  if (auth.user.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return auth;
}
async function audit(action, auth, meta = {}) {
  const id = db.ref("auditLogs").push().key;
  await set("auditLogs/" + id, {
    action,
    actorId: auth?.userId || "system",
    actorEmail: auth?.user?.email || null,
    createdAt: now(),
    meta
  });
}
async function publicBook(id, data) {
  const book = { id, ...data };
  delete book.storagePath;
  delete book.coverPath;
  if (data.coverPath) {
    try {
      const [url] = await bucket.file(data.coverPath).getSignedUrl({
        action: "read",
        expires: now() + SIGNED_URL_MS,
        responseDisposition: "inline"
      });
      book.coverUrl = url;
    } catch {
      book.coverUrl = null;
    }
  }
  return book;
}
async function listBooks(activeOnly = true, limit = 100) {
  let query = db.ref("books");
  if (activeOnly) query = query.orderByChild("status").equalTo("ACTIVE");
  const snap = await query.once("value");
  const result = [];
  snap.forEach(child => result.push({ id: child.key, data: child.val() }));
  result.sort((a, b) => Number(b.data.createdAt || 0) - Number(a.data.createdAt || 0));
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
function gmailRawMessage({ from, to, subject, html, text }) {
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
    requestBody: { raw: gmailRawMessage({ from: sender, to, subject, html, text }) }
  });
}
function resetOtpHash(userId, otp) {
  return hash(userId + ":" + otp + ":" + String(process.env.AUTH_SESSION_SECRET || "reset-otp"));
}
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.set("Cache-Control", req.path.startsWith("/api/") ? "no-store" : "public, max-age=60");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.get("origin");
    const expected = process.env.PUBLIC_ORIGIN;
    if (expected && origin && origin !== expected) return res.status(403).json({ error: "Origin not allowed" });
  }
  next();
});

app.get("/api/health", (req, res) => res.json({ ok: true, service: "MS Tech EBook", time: new Date().toISOString() }));

app.post("/api/auth/register", async (req, res) => {
  try {
    enforceRateLimit(req, "register", RATE_LIMITS.register);
    const { name, email: rawEmail, password } = req.body || {};
    const email = String(rawEmail || "").trim().toLowerCase();
    if (!safeText(name, 100) || !validEmail(email) || !validPassword(password)) return res.status(400).json({ error: "Invalid account details" });
    const userId = hash(email);
    const path = "users/" + userId;
    if (await get(path)) return res.status(409).json({ error: "Account already exists" });
    await set(path, {
      name: safeText(name, 100), email, passwordHash: passwordHash(password),
      role: "user", status: "ACTIVE", createdAt: now(), updatedAt: now()
    });
    const session = await createSession(userId);
    setSession(res, session);
    res.status(201).json({ ok: true, user: { name: safeText(name, 100), email, role: "user", mustChangePassword: false }, csrfToken: session.csrf });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Registration failed" });
  }
});

async function getOrCreateBootstrapAdmin() {
  const legacyPath = "users/admin";
  const legacy = await get(legacyPath);
  if (legacy) return { user: legacy, userId: "admin" };

  const email = String(process.env.ADMIN_INITIAL_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_INITIAL_PASSWORD || "");
  if (!validEmail(email) || !validPassword(password)) {
    fail(500, "Admin bootstrap is not configured. Set ADMIN_INITIAL_EMAIL and ADMIN_INITIAL_PASSWORD.");
  }
  const userId = hash(email);
  const path = "users/" + userId;
  let user = await get(path);
  if (!user) {
    user = { name: "Administrator", email, passwordHash: passwordHash(password), role: "admin", status: "ACTIVE", mustChangePassword: true, createdAt: now(), updatedAt: now() };
    await set(path, user);
  }
  return { user, userId };
}

app.post("/api/auth/login", async (req, res) => {
  try {
    enforceRateLimit(req, "login", RATE_LIMITS.login);
    const { email: rawEmail, password, otp } = req.body || {};
    const login = String(rawEmail || "").trim().toLowerCase();
    const isLegacyAdmin = login === "admin";
    let userId;
    let user;

    if (isLegacyAdmin) {
      const bootstrap = await getOrCreateBootstrapAdmin();
      userId = bootstrap.userId;
      user = bootstrap.user;
    } else {
      if (!validEmail(login) || typeof password !== "string") return res.status(400).json({ error: "Invalid credentials" });
      userId = hash(login);
      user = await get("users/" + userId);
    }

    if (!user || user.status !== "ACTIVE" || typeof password !== "string" || !passwordOK(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // The factory admin account is allowed one password-only login so it can be secured
    // immediately. Every later admin login requires TOTP when configured.
    const firstLogin = user.role === "admin" && user.mustChangePassword === true;
    if (user.role === "admin" && !firstLogin && process.env.ADMIN_TOTP_SECRET) {
      if (!verifyTotp(String(process.env.ADMIN_TOTP_SECRET), String(otp || ""))) {
        return res.status(401).json({ error: "Admin verification code required", code: "ADMIN_OTP_REQUIRED" });
      }
    }

    const session = await createSession(userId);
    setSession(res, session);
    rateBuckets.delete("login:" + requestIp(req));
    res.json({
      ok: true,
      user: { name: user.name, email: user.email, role: user.role, mustChangePassword: Boolean(user.mustChangePassword) },
      csrfToken: session.csrf
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Login failed" });
  }
});

app.post("/api/auth/change-password", async (req, res) => {
  try {
    const auth = await guard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
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

app.post("/api/auth/forgot-password", async (req, res) => {
  try { enforceRateLimit(req, "forgot", RATE_LIMITS.forgot); } catch (e) { return res.status(e.status || 429).json({ error: e.message || "Too many requests" }); }
  const generic = { ok: true, message: "If an account exists for this email, a verification code has been sent." };
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!validEmail(email)) return res.status(200).json(generic);
    const userId = hash(email);
    const user = await get("users/" + userId);
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
    res.cookie("ms_reset", resetId, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/auth", maxAge: PASSWORD_RESET_OTP_MS });
    res.json(generic);
  } catch (e) {
    console.error("Forgot password error", e);
    res.status(500).json({ error: "Password reset request failed" });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const resetId = safeText(req.cookies.ms_reset, 100);
    const otp = safeText(req.body?.otp, 6);
    const password = req.body?.password;
    if (!resetId || !/^\d{6}$/.test(otp) || !validPassword(password)) return res.status(400).json({ error: "Invalid reset details" });

    const resetPath = "passwordResets/" + key(resetId);
    const reset = await get(resetPath);
    if (!reset || reset.consumed || Number(reset.expiresAt) <= now()) return res.status(400).json({ error: "Invalid or expired verification code" });
    const attempts = Number(reset.attempts || 0);
    if (attempts >= PASSWORD_RESET_OTP_ATTEMPTS) return res.status(429).json({ error: "Too many verification attempts. Request a new code." });

    if (resetOtpHash(reset.userId, otp) !== reset.otpHash) {
      await update(resetPath, { attempts: attempts + 1, lastAttemptAt: now() });
      return res.status(400).json({ error: "Invalid verification code" });
    }

    const userPath = "users/" + reset.userId;
    const user = await get(userPath);
    if (!user || user.status !== "ACTIVE") return res.status(400).json({ error: "Account is unavailable" });

    await db.ref().update({
      [userPath + "/passwordHash"]: passwordHash(password),
      [userPath + "/updatedAt"]: now(),
      [resetPath + "/consumed"]: true,
      [resetPath + "/consumedAt"]: now()
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
    console.error("Reset password error", e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Password reset failed" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const auth = await current(req);
  if (auth) await update("sessions/" + auth.id, { revoked: true, revokedAt: now() });
  res.clearCookie("ms_session", { path: "/" });
  res.clearCookie("ms_csrf", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/auth/me", async (req, res) => {
  const auth = await current(req);
  if (!auth) return res.status(401).json({ error: "Not logged in" });
  res.json({ user: { name: auth.user.name, email: auth.user.email, role: auth.user.role, mustChangePassword: Boolean(auth.user.mustChangePassword) }, csrfToken: req.cookies.ms_csrf || "" });
});

app.get("/api/books", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const books = await listBooks(true, limit);
    const publicBooks = await Promise.all(books.map(b => publicBook(b.id, b.data)));
    res.json({ books: publicBooks });
  } catch {
    res.status(500).json({ error: "Could not load ebooks" });
  }
});
app.get("/api/books/:id", async (req, res) => {
  try {
    const data = await get("books/" + key(req.params.id));
    if (!data || data.status !== "ACTIVE") return res.status(404).json({ error: "Book not found" });
    res.json({ book: await publicBook(key(req.params.id), data) });
  } catch {
    res.status(500).json({ error: "Could not load ebook" });
  }
});

app.post("/api/admin/upload-url", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const { name, type, size } = req.body || {};
    const allowed = {
      "application/pdf": { folder: "ebooks", max: 50 * 1024 * 1024, ext: "pdf" },
      "image/jpeg": { folder: "covers", max: 5 * 1024 * 1024, ext: "jpg" },
      "image/png": { folder: "covers", max: 5 * 1024 * 1024, ext: "png" },
      "image/webp": { folder: "covers", max: 5 * 1024 * 1024, ext: "webp" }
    };
    const spec = allowed[type];
    if (!spec || !name || !Number.isFinite(Number(size)) || Number(size) <= 0 || Number(size) > spec.max) return res.status(400).json({ error: "Invalid file or file size" });
    const path = "private/" + spec.folder + "/" + crypto.randomUUID() + "." + spec.ext;
    const [url] = await bucket.file(path).getSignedUrl({
      version: "v4", action: "write", expires: now() + 15 * 60 * 1000,
      contentType: type, extensionHeaders: { "content-type": type }
    });
    res.json({ url, path, maxBytes: spec.max });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Upload URL could not be created" });
  }
});

function normalizeBookInput(body) {
  const type = body.type === "FREE" ? "FREE" : body.type === "PAID" ? "PAID" : null;
  const price = type === "FREE" ? 0 : Number(body.price);
  if (!type || !safeText(body.title, MAX_BOOK_TITLE) || !body.storagePath || !body.coverPath) fail(400, "Invalid book details");
  if (type === "PAID" && (!Number.isFinite(price) || price <= 0 || price > MAX_BOOK_PRICE)) fail(400, "Invalid book price");
  return {
    title: safeText(body.title, MAX_BOOK_TITLE),
    author: safeText(body.author, 120),
    category: safeText(body.category, 80),
    description: safeText(body.description, MAX_DESCRIPTION),
    type, price, storagePath: String(body.storagePath), coverPath: String(body.coverPath)
  };
}
app.post("/api/admin/books", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const book = normalizeBookInput(req.body || {});
    const id = db.ref("books").push().key;
    await set("books/" + id, { ...book, status: "ACTIVE", createdAt: now(), updatedAt: now(), createdBy: auth.user.email });
    await audit("BOOK_CREATED", auth, { bookId: id });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Book could not be created" });
  }
});
app.get("/api/admin/books", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth) return;
    const books = await listBooks(false, 100);
    res.json({ books: books.map(b => ({ id: b.id, ...b.data })) });
  } catch (e) {
    res.status(e.status || 500).json({ error: "Could not load admin books" });
  }
});
app.patch("/api/admin/books/:id", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const path = "books/" + key(req.params.id);
    const existing = await get(path);
    if (!existing) return res.status(404).json({ error: "Book not found" });
    const title = safeText(req.body.title, MAX_BOOK_TITLE);
    const type = req.body.type === "FREE" ? "FREE" : req.body.type === "PAID" ? "PAID" : null;
    const status = req.body.status === "DRAFT" ? "DRAFT" : req.body.status === "ACTIVE" ? "ACTIVE" : null;
    const price = type === "FREE" ? 0 : Number(req.body.price);
    if (!title || !type || !status || (type === "PAID" && (!Number.isFinite(price) || price <= 0 || price > MAX_BOOK_PRICE))) return res.status(400).json({ error: "Invalid book details" });
    await update(path, {
      title, author: safeText(req.body.author, 120), category: safeText(req.body.category, 80),
      description: safeText(req.body.description, MAX_DESCRIPTION), type, price, status,
      updatedAt: now(), updatedBy: auth.user.email
    });
    await audit("BOOK_UPDATED", auth, { bookId: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Book could not be updated" });
  }
});
app.delete("/api/admin/books/:id", async (req, res) => {
  try {
    const auth = await adminGuard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const path = "books/" + key(req.params.id);
    const book = await get(path);
    if (!book) return res.status(404).json({ error: "Book not found" });
    for (const storagePath of [book.storagePath, book.coverPath]) {
      if (storagePath) {
        try { await bucket.file(storagePath).delete(); } catch (e) { if (e.code !== 404) throw e; }
      }
    }
    await remove(path);
    await audit("BOOK_DELETED", auth, { bookId: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Book could not be deleted" });
  }
});

app.post("/api/orders/create", async (req, res) => {
  try {
    const auth = await guard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const bookId = key(req.body?.bookId);
    const book = await get("books/" + bookId);
    if (!book || book.status !== "ACTIVE") return res.status(404).json({ error: "Book not found" });
    const pricePaise = amountPaise(book.price);
    if (book.type === "FREE" || !pricePaise) return res.status(400).json({ error: "This ebook is free. No payment is required" });
    const purchase = await owned(auth.userId, bookId);
    if (purchase?.status === "PAID") return res.status(409).json({ error: "Already purchased" });
    try {
      const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
      const order = await razorpay.orders.create({
        amount: pricePaise, currency: "INR",
        receipt: ("ebook_" + now() + "_" + crypto.randomBytes(3).toString("hex")).slice(0, 40),
        notes: { userId: auth.userId, bookId }
      });
      await set("orders/" + order.id, {
        userId: auth.userId, bookId, amountPaise: order.amount, amount: Number(book.price),
        status: "CREATED", createdAt: now(), razorpayOrderId: order.id
      });
      res.json({ key: process.env.RAZORPAY_KEY_ID, order_id: order.id, amount: order.amount, currency: order.currency, name: "MS Tech EBook", description: book.title });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.status ? e.message : "Could not create Razorpay order" });
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Could not create order" });
  }
});

async function finalizePayment(paymentId, orderId) {
  const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  const payment = await razorpay.payments.fetch(paymentId);
  const order = await get("orders/" + orderId);
  if (!order) fail(404, "Order not found");
  if (payment.order_id !== orderId || payment.status !== "captured" || Number(payment.amount) !== Number(order.amountPaise)) fail(400, "Payment verification failed");
  const purchaseId = hash(order.userId + ":" + order.bookId);
  const existing = await get("purchases/" + purchaseId);
  if (existing?.status === "PAID") return { alreadyProcessed: true };
  const paymentEvent = await get("paymentEvents/" + paymentId);
  if (paymentEvent?.status === "PROCESSED") return { alreadyProcessed: true };
  await db.ref().update({
    ["purchases/" + purchaseId]: {
      userId: order.userId, bookId: order.bookId, orderId, paymentId,
      amount: order.amount, amountPaise: order.amountPaise, status: "PAID", purchasedAt: now()
    },
    ["orders/" + orderId + "/status"]: "PAID",
    ["orders/" + orderId + "/paymentId"]: paymentId,
    ["orders/" + orderId + "/updatedAt"]: now(),
    ["paymentEvents/" + paymentId]: { status: "PROCESSED", orderId, userId: order.userId, processedAt: now() }
  });
  return { alreadyProcessed: false };
}

app.post("/api/orders/verify", async (req, res) => {
  try {
    const auth = await guard(req, res);
    if (!auth || !requireCsrf(req, res, auth)) return;
    const { bookId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!bookId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: "Incomplete payment data" });
    const order = await get("orders/" + razorpay_order_id);
    if (!order || order.userId !== auth.userId || order.bookId !== key(bookId)) return res.status(403).json({ error: "Invalid order" });
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
    if (expected.length !== String(razorpay_signature).length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(razorpay_signature)))) return res.status(403).json({ error: "Payment verification failed" });
    await finalizePayment(razorpay_payment_id, razorpay_order_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Payment verification failed" });
  }
});

app.post("/api/webhooks/razorpay", async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.get("x-razorpay-signature");
    if (!secret || !signature) return res.status(401).json({ error: "Webhook not configured" });
    const raw = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body));
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return res.status(401).json({ error: "Invalid webhook signature" });
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

app.get("/api/library", async (req, res) => {
  try {
    const auth = await guard(req, res);
    if (!auth) return;
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
  } catch {
    res.status(500).json({ error: "Could not load your library" });
  }
});

app.get("/api/books/:id/secure-url", async (req, res) => {
  try {
    const auth = await guard(req, res);
    if (!auth) return;
    const id = key(req.params.id);
    const book = await get("books/" + id);
    if (!book || book.status !== "ACTIVE" || !book.storagePath) return res.status(404).json({ error: "Ebook unavailable" });
    const free = book.type === "FREE" || Number(book.price || 0) === 0;
    if (!free) {
      const purchase = await owned(auth.userId, id);
      if (!purchase || purchase.status !== "PAID") return res.status(403).json({ error: "Purchase required" });
    }
    const [url] = await bucket.file(book.storagePath).getSignedUrl({
      action: "read", expires: now() + SIGNED_URL_MS, responseDisposition: "inline"
    });
    res.json({ url, expiresIn: SIGNED_URL_MS / 1000 });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Could not open ebook" });
  }
});

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = [];
  for (const char of String(input).replace(/=+$/,"").toUpperCase().replace(/\s/g,"")) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) throw new Error("Invalid TOTP secret");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 255); }
  }
  return Buffer.from(out);
}
function totp(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 1000000).padStart(6, "0");
}
function verifyTotp(secret, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let delta = -1; delta <= 1; delta++) if (totp(secret, step + delta) === code) return true;
  return false;
}

app.use((err, req, res, next) => {
  console.error("Unhandled API error", err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
