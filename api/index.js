const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");

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
  return typeof value === "string" && value.length <= 254 && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);
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

async function redis(command, args = []) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.UPSTASH_REDIS_REST_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([command, ...args])
  });
  if (!response.ok) throw new Error("Rate-limit service unavailable");
  return (await response.json()).result;
}
async function rateLimit(id, count, seconds) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  const value = await redis("INCR", [id]);
  if (Number(value) === 1) await redis("EXPIRE", [id, seconds]);
  if (Number(value) > count) fail(429, "Too many requests. Please try again later.");
}
async function atomic(path, updater) {
  return db.ref(path).transaction(updater);
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
    const { name, email: rawEmail, password } = req.body || {};
    const email = String(rawEmail || "").trim().toLowerCase();
    await rateLimit("reg:" + hash(email), 5, 3600);
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
    res.status(201).json({ ok: true, user: { name: safeText(name, 100), email, role: "user" }, csrfToken: session.csrf });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email: rawEmail, password, otp } = req.body || {};
    const email = String(rawEmail || "").trim().toLowerCase();
    await rateLimit("login:" + hash(email), 10, 900);
    if (!validEmail(email) || typeof password !== "string") return res.status(400).json({ error: "Invalid credentials" });
    const userId = hash(email);
    const user = await get("users/" + userId);
    if (!user || user.status !== "ACTIVE" || !passwordOK(password, user.passwordHash)) return res.status(401).json({ error: "Invalid email or password" });
    if (user.role === "admin" && process.env.ADMIN_TOTP_SECRET) {
      if (!verifyTotp(String(process.env.ADMIN_TOTP_SECRET), String(otp || ""))) {
        return res.status(401).json({ error: "Admin verification code required", code: "ADMIN_OTP_REQUIRED" });
      }
    }
    const session = await createSession(userId);
    setSession(res, session);
    res.json({ ok: true, user: { name: user.name, email: user.email, role: user.role }, csrfToken: session.csrf });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Login failed" });
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
  res.json({ user: { name: auth.user.name, email: auth.user.email, role: auth.user.role }, csrfToken: req.cookies.ms_csrf || "" });
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
    await rateLimit("order:" + auth.userId, 5, 60);
    const bookId = key(req.body?.bookId);
    const book = await get("books/" + bookId);
    if (!book || book.status !== "ACTIVE") return res.status(404).json({ error: "Book not found" });
    const pricePaise = amountPaise(book.price);
    if (book.type === "FREE" || !pricePaise) return res.status(400).json({ error: "This ebook is free. No payment is required" });
    const purchase = await owned(auth.userId, bookId);
    if (purchase?.status === "PAID") return res.status(409).json({ error: "Already purchased" });
    const lock = "order-lock:" + auth.userId + ":" + bookId;
    if (await redis("SET", [lock, "1", "NX", "EX", 30]) === null) return res.status(409).json({ error: "Order already in progress" });
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
    } finally {
      await redis("DEL", [lock]).catch(() => {});
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
    await rateLimit("reader:" + auth.userId, 30, 60);
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
  for (const char of String(input).replace(/=+$/,"").toUpperCase().replace(/\\s/g,"")) {
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
  if (!/^\\d{6}$/.test(code)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let delta = -1; delta <= 1; delta++) if (totp(secret, step + delta) === code) return true;
  return false;
}

app.use((err, req, res, next) => {
  console.error("Unhandled API error", err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
