import React, { useEffect, useRef, useState, createContext, useContext } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const COVER_INPUT_MAX_BYTES = 5 * 1024 * 1024;
const COVER_OUTPUT_MAX_BYTES = 350 * 1024;

export async function compressCoverImage(file) {
  if (!file || !/^image\/(jpeg|png|webp)$/i.test(file.type)) {
    throw new Error("Choose a JPG, PNG, or WEBP cover image.");
  }
  if (file.size > COVER_INPUT_MAX_BYTES) {
    throw new Error("Cover image must be 5 MB or smaller before compression.");
  }

  const MAX_DIMENSION = 1000;
  const TIMEOUT_MS = 20000;
  let sourceUrl = "";
  let bitmap;

  const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Cover compression timed out. Try a smaller image or another browser.")), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });

  const makeBlob = (canvas, quality) => new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Your browser could not encode this cover as WebP.")), "image/webp", quality);
    } catch {
      reject(new Error("Your browser could not encode this cover as WebP."));
    }
  });

  const encodeOnMainThread = async (image) => {
    const scale = Math.min(1, MAX_DIMENSION / image.width, MAX_DIMENSION / image.height);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Your browser cannot prepare this cover image.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    // Encode at most three times; avoid repeatedly encoding large source dimensions.
    let blob = await makeBlob(canvas, 0.78);
    if (blob.size > COVER_OUTPUT_MAX_BYTES) blob = await makeBlob(canvas, 0.62);
    if (blob.size > COVER_OUTPUT_MAX_BYTES) blob = await makeBlob(canvas, 0.46);
    return { blob, width, height };
  };

  try {
    const work = async () => {
      // Prefer an isolated worker + OffscreenCanvas so decoding and WebP encoding
      // do not freeze the upload form on mobile devices.
      if (typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function") {
        let worker;
        let workerUrl;
        try {
          const workerSource = `
            self.onmessage = async ({ data }) => {
              let bitmap;
              try {
                bitmap = await createImageBitmap(data.file);
                const scale = Math.min(1, 1000 / bitmap.width, 1000 / bitmap.height);
                const width = Math.max(1, Math.round(bitmap.width * scale));
                const height = Math.max(1, Math.round(bitmap.height * scale));
                const canvas = new OffscreenCanvas(width, height);
                const context = canvas.getContext("2d", { alpha: false });
                if (!context) throw new Error("Canvas unavailable");
                context.fillStyle = "#ffffff";
                context.fillRect(0, 0, width, height);
                context.drawImage(bitmap, 0, 0, width, height);
                let blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.78 });
                if (blob.size > data.maxBytes) blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.62 });
                if (blob.size > data.maxBytes) blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.46 });
                self.postMessage({ ok: true, blob, width, height });
              } catch (error) {
                self.postMessage({ ok: false, error: error?.message || "Cover compression failed." });
              } finally {
                if (bitmap) bitmap.close?.();
              }
            };
          `;
          workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
          worker = new Worker(workerUrl);
          const result = await new Promise((resolve, reject) => {
            worker.onmessage = event => event.data?.ok
              ? resolve(event.data)
              : reject(new Error(event.data?.error || "Cover compression failed."));
            worker.onerror = () => reject(new Error("Background cover compression failed."));
            worker.postMessage({ file, maxBytes: COVER_OUTPUT_MAX_BYTES });
          });
          return result;
        } catch (workerError) {
          // Fall back for browsers whose worker canvas/WebP encoder is unsupported.
          if (workerError?.message?.includes("timed out")) throw workerError;
        } finally {
          if (worker) worker.terminate();
          if (workerUrl) URL.revokeObjectURL(workerUrl);
        }
      }

      if (typeof createImageBitmap === "function") {
        bitmap = await createImageBitmap(file);
      } else {
        sourceUrl = URL.createObjectURL(file);
        const image = new Image();
        image.src = sourceUrl;
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error("Could not read this cover image."));
        });
        bitmap = image;
      }
      return await encodeOnMainThread(bitmap);
    };

    const result = await withTimeout(work(), TIMEOUT_MS);
    if (!result.blob || result.blob.size > COVER_OUTPUT_MAX_BYTES) {
      throw new Error("Cover could not be compressed below 350 KB. Choose a smaller image.");
    }

    const baseName = String(file.name || "cover").replace(/\.[^.]+$/, "") || "cover";
    const optimized = new File([result.blob], baseName + ".webp", { type: "image/webp", lastModified: Date.now() });
    return {
      file: optimized,
      originalSize: file.size,
      compressedSize: optimized.size,
      wasCompressed: file.type !== "image/webp" || file.size !== optimized.size || result.width !== bitmap?.width || result.height !== bitmap?.height,
      width: result.width,
      height: result.height
    };
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }
}

import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate, useParams, useLocation } from "react-router-dom";
import "./styles.css";
import AdminPanel from "./AdminPanel";
import SAdmin, { SAdminLogin } from "./SAdmin";

// Global CSRF token cache
let cachedCsrfToken = "";

function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(";").shift();
  return "";
}

function activePortal() {
  const params = new URLSearchParams(window.location.search);
  return window.location.pathname.startsWith("/admin") || params.get("portal") === "admin" ? "admin" : window.location.pathname.startsWith("/sadmin") || params.get("portal") === "sadmin" ? "sadmin" : "user";
}

export async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const method = (options.method || "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrfCookie = activePortal() === "admin" ? "ms_admin_csrf" : activePortal() === "sadmin" ? "ms_sadmin_csrf" : "ms_csrf";
    const csrf = cachedCsrfToken || getCookie(csrfCookie);
    if (csrf && !headers["X-CSRF-Token"]) {
      headers["X-CSRF-Token"] = csrf;
    }
  }

  const res = await fetch(path, {
    ...options,
    credentials: "include",
    cache: method === "GET" ? "no-store" : options.cache,
    headers
  });

  const data = await res.json().catch(() => ({}));

  if (data.csrfToken) {
    cachedCsrfToken = data.csrfToken;
  }

  if (!res.ok) {
    const errorMsg = data.error || (res.statusText ? `${res.status} ${res.statusText}` : "Request failed");
    const err = new Error(errorMsg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

export async function checkAuth(portal = activePortal()) {
  const res = await api("/api/auth/me?portal=" + encodeURIComponent(portal));
  if (res.csrfToken) cachedCsrfToken = res.csrfToken;
  return res;
}


// SEO metadata manager. This updates browser metadata on client-side navigation;
// server-rendered/prerendered HTML is still needed for the strongest SEO results.
function setSeoMetadata({ title, description, path, noindex = false, image = "", type = "website" }) {
  const origin = window.location.origin;
  const canonicalUrl = origin + (path || window.location.pathname);
  document.title = title;
  const upsertMeta = (selector, attrs, value) => {
    let node = document.head.querySelector(selector);
    if (!node) {
      node = document.createElement("meta");
      Object.entries(attrs).forEach(([key, val]) => node.setAttribute(key, val));
      document.head.appendChild(node);
    }
    node.setAttribute("content", value);
  };
  upsertMeta('meta[name="description"]', { name: "description" }, description);
  upsertMeta('meta[name="robots"]', { name: "robots" }, noindex ? "noindex, nofollow" : "index, follow, max-image-preview:large");
  upsertMeta('meta[property="og:type"]', { property: "og:type" }, type);
  upsertMeta('meta[property="og:title"]', { property: "og:title" }, title);
  upsertMeta('meta[property="og:description"]', { property: "og:description" }, description);
  upsertMeta('meta[property="og:url"]', { property: "og:url" }, canonicalUrl);
  upsertMeta('meta[name="twitter:card"]', { name: "twitter:card" }, image ? "summary_large_image" : "summary");
  upsertMeta('meta[name="twitter:title"]', { name: "twitter:title" }, title);
  upsertMeta('meta[name="twitter:description"]', { name: "twitter:description" }, description);
  if (image) {
    upsertMeta('meta[property="og:image"]', { property: "og:image" }, image);
    upsertMeta('meta[name="twitter:image"]', { name: "twitter:image" }, image);
  } else {
    document.head.querySelector('meta[property="og:image"]')?.remove();
    document.head.querySelector('meta[name="twitter:image"]')?.remove();
  }
  let canonical = document.head.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.href = canonicalUrl;
}
function SeoManager() {
  const location = useLocation();
  useEffect(() => {
    const path = location.pathname;
    const oldSchema = document.getElementById("ms-tech-ebook-website-schema");
    if (oldSchema) oldSchema.remove();
    // Individual book pages set their own metadata once the public book record loads.
    if (/^\/books\/[^/]+$/.test(path)) return;
    const pages = {
      "/": ["MS Tech EBook | Buy and Read Ebooks Online", "Discover, buy, and read ebooks online with MS Tech EBook. Explore digital books across categories and access your library anytime."],
      "/books": ["Browse Ebooks Online | MS Tech EBook", "Explore ebooks by title, author, and category on MS Tech EBook. Discover digital books, compare details, and find your next read."],
      "/refund-policy": ["Refund Policy | MS Tech EBook", "Read the MS Tech EBook refund policy for digital purchases, payment issues, and support eligibility."],
      "/support": ["Customer Support | MS Tech EBook", "Contact MS Tech EBook support for payment problems, duplicate charges, and ebook access issues."]
    };
    const isPrivate = /^\/(admin|sadmin|read|library|login|register|change-password|forgot-password|reset-password|setadmin)(\/|$)/.test(path);
    const [title, description] = pages[path] || ["MS Tech EBook | Digital Bookstore", "Explore digital books and ebooks on MS Tech EBook."];
    setSeoMetadata({
      title, description, path,
      noindex: isPrivate || path.startsWith("/books/") || (!pages[path] && path !== "/")
    });
    if (path === "/") {
      const schema = document.createElement("script");
      schema.id = "ms-tech-ebook-website-schema";
      schema.type = "application/ld+json";
      schema.textContent = JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "WebSite",
            "@id": window.location.origin + "/#website",
            name: "MS Tech EBook",
            url: window.location.origin + "/",
            description: pages["/"][1],
            publisher: { "@id": window.location.origin + "/#organization" }
          },
          {
            "@type": "Organization",
            "@id": window.location.origin + "/#organization",
            name: "MS Tech EBook",
            url: window.location.origin + "/",
            email: "msinnovatex@gmail.com",
            parentOrganization: {
              "@type": "Organization",
              name: "MS InnovateX"
            }
          }
        ]
      });
      document.head.appendChild(schema);
    }
  }, [location.pathname, location.search]);
  return null;
}

// Auth Context for centralized user state
const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

function Layout({ children }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdminArea = location.pathname.startsWith("/admin") || location.pathname.startsWith("/sadmin") || ["admin", "sadmin"].includes(new URLSearchParams(location.search).get("portal"));
  const isReaderPage = location.pathname.startsWith("/read/");

  async function handleLogout() {
    try {
      await api("/api/auth/logout?portal=user", { method: "POST" });
    } catch {}
    cachedCsrfToken = "";
    setUser(null);
    navigate("/login");
  }

  return (
    <>
      {!isAdminArea && !isReaderPage && (
        <header>
          <Link className="brand" to="/">MS Tech EBook</Link>
          <nav>
            <Link to="/books">Store</Link>
            {user ? (
              <>
                <Link to="/library">My Library</Link>
                <button onClick={handleLogout} style={{ opacity: 0.85 }}>Logout ({user.name.split(" ")[0]})</button>
              </>
            ) : (
              <>
                <Link to="/login">Login</Link>
                <Link to="/register">Register</Link>
              </>
            )}
          </nav>
        </header>
      )}
      {children}
      {!isAdminArea && !isReaderPage && (
        <footer className="site-footer">
          <p>© {new Date().getFullYear()} MS Tech EBook. All rights reserved.</p>
          <nav aria-label="Customer support">
            <Link to="/refund-policy">Refund Policy</Link>
            <Link to="/support">Raise a Complaint</Link>
            <a href="mailto:msinnovatex@gmail.com">msinnovatex@gmail.com</a>
            <a href="mailto:Info@msinnovatex.com">Info@msinnovatex.com</a>
          </nav>
        </footer>
      )}
    </>
  );
}

function Grid({ books = [] }) {
  if (!Array.isArray(books) || books.length === 0) {
    return <div className="empty" style={{ padding: "40px 0", textAlign: "center", color: "#8b949e" }}>No ebooks available at the moment.</div>;
  }

  return (
    <div className="grid">
      {books.map(b => (
        <Link className="card" to={`/books/${b.id}`} key={b.id}>
          <div className="cover">
            {b.coverUrl ? (
              <img src={b.coverUrl} alt={b.title} loading="lazy" decoding="async" width="700" height="1000" />
            ) : (
              <b>MS<br />TECH<br />EBOOK</b>
            )}
          </div>
          <h3>{b.title}</h3>
          <p>{b.author || "MS Tech EBook"}</p>
          {b.publishedDate && <small className="book-published-date">Published {new Date(b.publishedDate + "T00:00:00").toLocaleDateString()}</small>}
          <strong>{b.type === "FREE" || Number(b.price || 0) === 0 ? "FREE" : "₹" + Number(b.price || 0)}</strong>
        </Link>
      ))}
    </div>
  );
}

function Home() {
  const [books, setBooks] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/books")
      .then(data => setBooks(Array.isArray(data.books) ? data.books : []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="hero">
      <div>
        <small style={{ letterSpacing: "2px", fontWeight: 700, color: "#9b8cff" }}>PREMIUM DIGITAL READING</small>
        <h1>Discover, Buy, and Read Ebooks Online</h1>
        <p>Explore digital books on MS Tech EBook, find titles by author or category, and keep your purchased ebooks in your personal online library.</p>
        <Link className="primary" to="/books" style={{ marginTop: "16px" }}>Browse Catalog</Link>
      </div>
      <section>
        <h2>Featured Titles</h2>
        {loading && <p style={{ color: "#8b949e" }}>Loading catalog...</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && <Grid books={books.slice(0, 6)} />}
        <p style={{ marginTop: "18px" }}>Looking for your next read? <Link to="/books">Browse the full ebook catalog</Link> to explore available titles, authors, categories, and prices. For help with purchases or access, visit <Link to="/support">customer support</Link>.</p>
      </section>
      <section aria-labelledby="ebook-store-guide" style={{ maxWidth: "900px", margin: "32px auto 0", padding: "0 16px" }}>
        <h2 id="ebook-store-guide">Your Online Ebook Store</h2>
        <p>MS Tech EBook is a digital bookstore where readers can discover ebook titles, review book details, and purchase available digital editions online. Each book page provides information to help you decide what to read before buying.</p>
        <p>After signing in, you can access eligible purchases from your personal library. If you have a question about payment, a duplicate charge, or ebook access, use our <Link to="/support">support page</Link>. Please read the <Link to="/refund-policy">refund policy</Link> before making a digital purchase.</p>
      </section>
    </main>
  );
}

function Books() {
  const [books, setBooks] = useState([]);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("ALL");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/books")
      .then(data => setBooks(Array.isArray(data.books) ? data.books : []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const categories = [...new Set(books.map(book => String(book.category || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const filtered = books.filter(b => {
    const matchesCategory = selectedCategory === "ALL" || String(b.category || "").trim() === selectedCategory;
    const matchesSearch = `${b.title} ${b.author || ""} ${b.category || ""}`.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <main className="container">
      <h1>Browse Ebooks Online</h1>
      <p>Explore the MS Tech EBook catalog by book title, author, or category. Open an ebook listing to review its description, publication details, and price before purchase.</p>
      {error && <p className="error">{error}</p>}
      <div className="store-search-tools">
        <label className="store-search-box">
          <span className="store-search-icon" aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="Search books, authors, or categories"
            aria-label="Search books, authors, or categories"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </label>
        <label className="store-category-box">
          <span className="store-filter-icon" aria-hidden="true">☷</span>
          <select aria-label="Filter ebooks by category" value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}>
            <option value="ALL">All categories</option>
            {categories.map(category => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
      </div>
      {!loading && !error && <p style={{ color: "#8b949e", marginTop: 0 }}>{filtered.length} {filtered.length === 1 ? "book" : "books"} found</p>}
      {loading ? (
        <p style={{ color: "#8b949e" }}>Loading ebooks...</p>
      ) : (
        <Grid books={filtered} />
      )}
    </main>
  );
}

function AuthForm({ register = false }) {
  const { setUser } = useAuth();
  const [email, setEmail] = useState("");
  const [registeredMessage, setRegisteredMessage] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return !register && params.get("registered") === "1";
  });
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload = register ? { name, email, password } : { email, password };
      const data = await api(register ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      if (register) {
        cachedCsrfToken = "";
        setUser(null);
        setRegisteredMessage(true);
        navigate("/login?registered=1", { replace: true });
      } else {
        if (data.csrfToken) cachedCsrfToken = data.csrfToken;
        setUser(data.user);
        if (data.user.mustChangePassword) {
          navigate("/change-password");
        } else {
          const requestedNext = new URLSearchParams(window.location.search).get("next") || "";
          navigate(requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/books");
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form onSubmit={handleSubmit}>
        <span className="auth-kicker">{register ? "JOIN THE READING CLUB" : "WELCOME BACK"}</span>
        <h1>{register ? "Create your account." : "Sign in & start reading."}</h1>
        {!register && registeredMessage && <p className="success auth-success">Account created successfully. Now enter your email and password to log in.</p>}
        {register && (
          <input placeholder="Your Full Name" value={name} onChange={e => setName(e.target.value)} required />
        )}
        <input
          type="email"
          placeholder="Email Address"
          autoComplete={register ? "email" : "username"}
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder={register ? "Password (10+ chars: upper, lower, number)" : "Password"}
          minLength={register ? 10 : undefined}
          autoComplete={register ? "new-password" : "current-password"}
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
        />
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Please wait..." : register ? "Create Account" : "Login"}
        </button>
        <p style={{ textAlign: "center", marginTop: "12px", fontSize: "14px" }}>
          <Link to={register ? "/login" : "/register"}>
            {register ? "Already have an account? Login here" : "Don't have an account? Register"}
          </Link>
        </p>
        {!register && (
          <p style={{ textAlign: "center", fontSize: "14px", marginTop: "4px" }}>
            <Link to="/forgot-password" style={{ color: "#9b8cff" }}>Forgot password?</Link>
          </p>
        )}
      </form>
    </main>
  );
}

function AdminLogin() {
  const { user, setUser } = useAuth();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [otpRequired, setOtpRequired] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (user?.role === "admin") navigate("/admin", { replace: true });
  }, [user, navigate]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: login, password, portal: "admin", ...(otp ? { otp } : {}) })
      });
      if (data.user?.role !== "admin") throw new Error("Administrator credentials required.");
      if (data.csrfToken) cachedCsrfToken = data.csrfToken;
      setUser(data.user);
      navigate(data.user.mustChangePassword ? "/change-password?portal=admin" : "/admin");
    } catch (err) {
      if (err.data?.code === "ADMIN_OTP_REQUIRED" || err.message.includes("Admin verification code")) setOtpRequired(true);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form onSubmit={handleSubmit}>
        <h1>Administrator Portal</h1>
        <p style={{ color: "#a0aec0", fontSize: "14px", lineHeight: 1.6 }}>
          Secure administrator access. Customer accounts cannot use this portal.
        </p>
        <input type="text" placeholder="Admin ID or email" autoComplete="username" value={login} onChange={e => setLogin(e.target.value)} required />
        <input type="password" placeholder="Administrator password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        {otpRequired && (
          <input inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit Admin 2FA Code" maxLength={6} value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} required />
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Signing in..." : "Administrator Login"}</button>
        <p style={{ textAlign: "center", fontSize: "13px", marginTop: "4px" }}>
          <Link to="/books">Return to Store</Link>
        </p>
      </form>
    </main>
  );
}

function ChangePassword() {
  const { user, setUser } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) return setError("Passwords do not match");
    setBusy(true);
    try {
      const portalQuery = user?.role === "admin" ? "?portal=admin" : user?.role === "sadmin" ? "?portal=sadmin" : "?portal=user";
      await api("/api/auth/change-password" + portalQuery, {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword })
      });
      setUser({ ...user, mustChangePassword: false });
      setDone(true);
      setTimeout(() => navigate(user?.role === "admin" ? "/admin" : user?.role === "sadmin" ? "/sadmin" : "/books"), 1000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form onSubmit={handleSubmit}>
        <h1>{user?.mustChangePassword ? "Set Up New Password" : "Change Password"}</h1>
        {user?.mustChangePassword && <p className="success">First-time login detected. Please create a new secure password.</p>}
        <input type="password" placeholder="Current Password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
        <input type="password" placeholder="New Password (10+ chars, upper, lower, number)" autoComplete="new-password" minLength={10} value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
        <input type="password" placeholder="Confirm New Password" autoComplete="new-password" minLength={10} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
        {error && <p className="error">{error}</p>}
        {done ? <p className="success">Password updated! Redirecting...</p> : <button className="primary" disabled={busy}>{busy ? "Updating..." : "Update Password"}</button>}
      </form>
    </main>
  );
}

function SetAdmin() {
  const [adminId, setAdminId] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api("/api/setup/admin")
      .then(() => setLocked(false))
      .catch(e => {
        if (e.message?.includes("already completed")) setLocked(true);
        else setError(e.message);
      });
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (password !== confirm) return setError("Passwords do not match");
    setBusy(true);
    try {
      await api("/api/setup/admin", {
        method: "POST",
        headers: { "X-Admin-Setup-Key": setupKey },
        body: JSON.stringify({ adminId, email, password })
      });
      setDone(true);
      setTimeout(() => navigate("/admin/admin"), 1500);
    } catch (err) {
      if (err.message?.includes("already completed")) setLocked(true);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (locked) {
    return (
      <main className="auth"><form>
        <h1>Setup Completed</h1>
        <p className="success">The administrator account has already been initialized. Setup is permanently disabled.</p>
        <button type="button" className="primary" onClick={() => navigate("/admin/admin")}>Go to Administrator Portal</button>
      </form></main>
    );
  }

  if (done) {
    return (
      <main className="auth"><form>
        <h1>Admin Account Created</h1>
        <p className="success">Administrator account successfully created. Setup is now locked.</p>
        <p>Redirecting to administrator portal...</p>
      </form></main>
    );
  }

  return (
    <main className="auth">
      <form onSubmit={submit}>
        <h1>Initialize Admin</h1>
        <p style={{ color: "#a0aec0", fontSize: "14px" }}>
          This one-time setup requires the private ADMIN_SETUP_KEY configured on the server.
        </p>
        <input type="password" placeholder="Admin Setup Key" value={setupKey} onChange={e => setSetupKey(e.target.value)} minLength={16} required />
        <input placeholder="Admin User ID (e.g. admin)" value={adminId} onChange={e => setAdminId(e.target.value)} pattern="[A-Za-z0-9_-]{3,64}" minLength={3} maxLength={64} required />
        <input type="email" placeholder="Admin Email Address" value={email} onChange={e => setEmail(e.target.value)} required />
        <input type="password" placeholder="Admin Password (10+ chars, upper, lower, number)" minLength={10} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required />
        <input type="password" placeholder="Confirm Admin Password" minLength={10} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Configuring..." : "Create Admin Account"}</button>
      </form>
    </main>
  );
}

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email })
      });
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form onSubmit={send}>
        <h1>Reset Password</h1>
        {sent ? (
          <>
            <p className="success">If an account exists for this email, a 6-digit code has been dispatched.</p>
            <Link className="primary" to={`/reset-password?email=${encodeURIComponent(email)}`}>
              Enter Verification Code
            </Link>
          </>
        ) : (
          <>
            <p style={{ color: "#a0aec0", fontSize: "14px" }}>
              Enter your registered email to receive a password reset verification code.
            </p>
            <input
              type="email"
              placeholder="Registered Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy}>
              {busy ? "Sending..." : "Send Verification Code"}
            </button>
          </>
        )}
        <p style={{ textAlign: "center", marginTop: "12px", fontSize: "14px" }}>
          <Link to="/login">Back to Login</Link>
        </p>
      </form>
    </main>
  );
}

function ResetPassword() {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setEmail(q.get("email") || "");
  }, []);

  async function reset(e) {
    e.preventDefault();
    setError("");
    if (password !== confirm) return setError("Passwords do not match");
    setBusy(true);

    try {
      await api("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ otp, password })
      });
      setDone(true);
      setTimeout(() => navigate("/login"), 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form onSubmit={reset}>
        <h1>Verify & Reset</h1>
        <input
          type="email"
          placeholder="Email Address"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="6-digit Verification Code"
          maxLength={6}
          value={otp}
          onChange={e => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          required
        />
        <input
          type="password"
          placeholder="New Password (10+ chars)"
          minLength={10}
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Confirm New Password"
          minLength={10}
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          required
        />
        {error && <p className="error">{error}</p>}
        {done ? (
          <p className="success">Password reset successful! Redirecting to login...</p>
        ) : (
          <button className="primary" disabled={busy}>
            {busy ? "Resetting..." : "Set New Password"}
          </button>
        )}
      </form>
    </main>
  );
}

function Detail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [book, setBook] = useState(null);
  const [owned, setOwned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [buying, setBuying] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [showCouponEntry, setShowCouponEntry] = useState(false);
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponMessage, setCouponMessage] = useState({ type: "", text: "" });
  const navigate = useNavigate();

  useEffect(() => {
    setCouponCode("");
    setShowCouponEntry(false);
    setAppliedCoupon(null);
    setCouponMessage({ type: "", text: "" });
    setLoading(true);
    api(`/api/books/${id}`)
      .then(res => setBook(res.book))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));

    if (user) {
      api("/api/library")
        .then(res => {
          if (Array.isArray(res.books)) {
            setOwned(res.books.some(b => b.id === id));
          }
        })
        .catch(() => {});
    }
  }, [id, user]);


  useEffect(() => {
    if (loading || (book && !error)) return;
    setSeoMetadata({
      title: "Ebook Not Found | MS Tech EBook",
      description: "This ebook is unavailable or could not be found in the MS Tech EBook catalog.",
      path: `/books/${encodeURIComponent(id)}`,
      noindex: true
    });
  }, [loading, book, error, id]);

  useEffect(() => {
    if (!book) return;
    const title = `${String(book.title || "Ebook").slice(0, 42)} | MS Tech EBook`;
    const summary = String(book.description || `Discover ${book.title} by ${book.author || "MS Tech EBook"} on MS Tech EBook.`).replace(/\s+/g, " ").trim().slice(0, 155);
    setSeoMetadata({
      title,
      description: summary || `Discover ${book.title} on MS Tech EBook.`,
      path: `/books/${encodeURIComponent(id)}`,
      noindex: false,
      type: "book",
    });
    const oldSchema = document.getElementById("ms-tech-ebook-book-schema");
    const oldBreadcrumb = document.getElementById("ms-tech-ebook-breadcrumb-schema");
    if (oldSchema) oldSchema.remove();
    if (oldBreadcrumb) oldBreadcrumb.remove();
    const bookUrl = window.location.origin + `/books/${encodeURIComponent(id)}`;
    const schema = document.createElement("script");
    schema.id = "ms-tech-ebook-book-schema";
    schema.type = "application/ld+json";
    schema.textContent = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Book",
      "@id": bookUrl + "#book",
      url: bookUrl,
      bookFormat: "https://schema.org/EBook",
      name: String(book.title || ""),
      author: { "@type": "Person", name: String(book.author || "MS Tech EBook") },
      publisher: { "@type": "Organization", name: "MS Tech EBook", url: window.location.origin + "/" },
      description: summary,
      inLanguage: String(book.language || "en"),
      ...(book.category ? { genre: String(book.category) } : {}),
      ...(book.publishedDate ? { datePublished: book.publishedDate } : {}),
      offers: {
        "@type": "Offer",
        priceCurrency: "INR",
        price: String(book.type === "FREE" ? 0 : Number(book.price || 0)),
        availability: "https://schema.org/InStock",
        url: bookUrl
      }
    }).replace(/</g, "\\u003c");
    const breadcrumb = document.createElement("script");
    breadcrumb.id = "ms-tech-ebook-breadcrumb-schema";
    breadcrumb.type = "application/ld+json";
    breadcrumb.textContent = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: window.location.origin + "/" },
        { "@type": "ListItem", position: 2, name: "Ebooks", item: window.location.origin + "/books" },
        { "@type": "ListItem", position: 3, name: String(book.title || "Ebook"), item: bookUrl }
      ]
    }).replace(/</g, "\\u003c");
    document.head.appendChild(schema);
    document.head.appendChild(breadcrumb);
    return () => { schema.remove(); breadcrumb.remove(); };
  }, [book, id]);

  async function applyCoupon() {
    if (!user) return navigate("/login");
    const code = couponCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{12}$/.test(code)) { setCouponMessage({ type: "error", text: "Enter a 12-character letter-and-number coupon code." }); return; }
    setCouponBusy(true); setCouponMessage({ type: "", text: "" });
    try {
      const result = await api("/api/coupons/validate", { method: "POST", body: JSON.stringify({ code, bookId: id }) });
      if (Number(result.finalPrice) === 0) {
        // Redeem a valid 100% coupon immediately; do not require a second
        // click on the purchase button or create a zero-value Razorpay order.
        await api("/api/coupons/redeem-free", {
          method: "POST",
          body: JSON.stringify({ code: result.code, bookId: id })
        });
        setCouponCode(result.code);
        setAppliedCoupon(result);
        setShowCouponEntry(false);
        setCouponMessage({ type: "success", text: "100% coupon redeemed. Ebook added to My Library." });
        navigate("/library");
        return;
      }
      setCouponCode(result.code);
      setAppliedCoupon(result);
      setShowCouponEntry(false);
      setCouponMessage({ type: "success", text: `${result.discountPercent}% discount applied successfully.` });
    } catch (err) {
      setAppliedCoupon(null);
      setCouponMessage({ type: "error", text: err.message || "Coupon could not be applied." });
    } finally { setCouponBusy(false); }
  }

  async function handleBuy() {
    if (!user) return navigate("/login");
    if (buying) return;
    setBuying(true);

    try {
      const orderData = await api("/api/orders/create", {
        method: "POST",
        body: JSON.stringify({ bookId: id, ...(appliedCoupon ? { couponCode: appliedCoupon.code } : {}) })
      });

      if (orderData.free) {
        navigate("/library");
        return;
      }

      if (!window.Razorpay) {
        throw new Error("Razorpay SDK is not loaded. Please verify your internet connection or ad blocker.");
      }

      const options = {
        key: orderData.key,
        amount: orderData.amount,
        currency: orderData.currency,
        name: orderData.name,
        description: orderData.description,
        order_id: orderData.order_id,
        prefill: { email: user.email, name: user.name },
        handler: async response => {
          try {
            const verified = await api("/api/orders/verify", {
              method: "POST",
              body: JSON.stringify({
                bookId: id,
                ...response
              })
            });
            if (verified.duplicateCaptured) {
              navigate(`/support?category=DUPLICATE_CHARGE&bookId=${encodeURIComponent(id)}&orderId=${encodeURIComponent(response.razorpay_order_id)}&paymentId=${encodeURIComponent(response.razorpay_payment_id)}`);
              return;
            }
            navigate("/library");
          } catch (verifyErr) {
            navigate(`/support?category=BOOK_NOT_UNLOCKED&bookId=${encodeURIComponent(id)}&orderId=${encodeURIComponent(response.razorpay_order_id || orderData.order_id)}&paymentId=${encodeURIComponent(response.razorpay_payment_id || "")}`);
          }
        },
        theme: { color: "#7c5cff" }
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", resp => {
        const metadata = resp.error?.metadata || {};
        navigate(`/support?category=PAYMENT_ISSUE&bookId=${encodeURIComponent(id)}&orderId=${encodeURIComponent(metadata.order_id || orderData.order_id)}&paymentId=${encodeURIComponent(metadata.payment_id || "")}`);
      });
      rzp.open();
    } catch (err) {
      alert(err.message);
    } finally {
      setBuying(false);
    }
  }

  if (loading) return <main className="center"><p>Loading ebook details...</p></main>;
  if (error) return <main className="center error"><p>{error}</p></main>;
  if (!book) return <main className="center"><p>Book not found.</p></main>;

  const isFree = book.type === "FREE" || Number(book.price || 0) === 0;
  const canRead = owned || isFree || (user && user.role === "admin");

  return (
    <main className="detail">
      <div className="cover big">
        {book.coverUrl ? (
          <img src={book.coverUrl} alt={book.title} loading="eager" decoding="async" width="700" height="1000" />
        ) : (
          <b>MS<br />TECH<br />EBOOK</b>
        )}
      </div>
      <div>
        <small style={{ letterSpacing: "1.5px", fontWeight: 700, color: "#9b8cff" }}>
          {book.category || "EBOOK"}
        </small>
        <h1>{book.title}</h1>
        <p style={{ color: "#8b949e", marginBottom: "8px" }}>By {book.author || "MS Tech EBook"}</p>
        {book.publishedDate && <p style={{ color: "#8b949e", fontSize: "14px", marginBottom: "16px" }}>Published {new Date(book.publishedDate + "T00:00:00").toLocaleDateString()}</p>}
        <p style={{ whiteSpace: "pre-line" }}>{book.description}</p>
        <div className="book-purchase-pricing">
          {appliedCoupon ? <><span className="book-original-price">₹{Number(book.price || 0).toFixed(2).replace(/\.00$/, "")}</span><h2>₹{Number(appliedCoupon.finalPrice).toFixed(2).replace(/\\.00$/, "")}</h2><span className="book-discount-badge">{appliedCoupon.discountPercent}% OFF</span></> : <h2>{isFree ? "Free" : `₹${Number(book.price || 0)}`}</h2>}
        </div>
        {canRead ? (
          <Link className="primary" to={`/read/${id}`}>Read Now</Link>
        ) : (
          <>
            <button className="primary" onClick={handleBuy} disabled={buying}>
              {buying ? (appliedCoupon && Number(appliedCoupon.finalPrice) === 0 ? "Adding to My Library..." : "Initiating...") : (appliedCoupon && Number(appliedCoupon.finalPrice) === 0 ? "Get free access · Add to Library" : `Buy for ₹${appliedCoupon ? Number(appliedCoupon.finalPrice).toFixed(2).replace(/\\.00$/, "") : Number(book.price || 0)}`)}
            </button>
            {!isFree && !appliedCoupon && <button type="button" className="coupon-toggle-link" onClick={() => { setShowCouponEntry(value => !value); setCouponMessage({type:"",text:""}); }}>
              {showCouponEntry ? "Cancel coupon" : "Apply a coupon"}
            </button>}
            {!isFree && (showCouponEntry || appliedCoupon) && <section className="book-coupon-panel" aria-label="Apply coupon">
              <div className="book-coupon-heading"><strong>Have a coupon?</strong><span>Save on this ebook</span></div>
              {appliedCoupon ? <div className="book-coupon-applied"><span><b>{appliedCoupon.code}</b> applied · {appliedCoupon.discountPercent}% off</span><button type="button" onClick={() => { setAppliedCoupon(null); setCouponMessage({type:"",text:""}); }}>Remove</button></div> : <div className="book-coupon-controls"><input aria-label="12-character coupon code" autoComplete="off" maxLength={12} value={couponCode} type="text" inputMode="text" autoCapitalize="characters" spellCheck={false} onChange={e => { setCouponCode(e.currentTarget.value.slice(0,12).toUpperCase()); setCouponMessage({type:"",text:""}); }} placeholder="Enter 12-character code" /><button type="button" className="book-coupon-apply" disabled={couponBusy || couponCode.length !== 12} onClick={applyCoupon}>{couponBusy ? "Checking…" : "Apply coupon"}</button></div>}
              {couponMessage.text && <p className={couponMessage.type === "error" ? "book-coupon-error" : "book-coupon-success"} role="status">{couponMessage.text}</p>}
            </section>}
            <p className="purchase-help">
              Digital purchases are non-refundable after the book is successfully unlocked. If your payment is captured but the book stays locked, <Link to={`/support?category=BOOK_NOT_UNLOCKED&bookId=${encodeURIComponent(id)}`}>raise a payment complaint</Link>.
              <br /><Link to="/refund-policy">Read our Refund Policy</Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function RefundPolicy() {
  return (
    <main className="container policy-page">
      <span className="auth-kicker">CUSTOMER POLICY</span>
      <h1>Refund & Cancellation Policy</h1>
      <p className="policy-updated">MS Tech EBook · Digital products</p>
      <section className="policy-card">
        <h2>1. Digital purchases</h2>
        <p>Because ebooks are digital products, an order is generally non-refundable once the purchased book has been successfully unlocked and made available in your account, except where a refund is required by applicable law.</p>
      </section>
      <section className="policy-card">
        <h2>2. Payment completed, book still locked</h2>
        <p>If Razorpay confirms that your payment was captured but the book does not appear in <strong>My Library</strong> or remains locked, do not pay again immediately. Refresh My Library and sign in to the same account used for checkout. If access is still missing after 15 minutes, submit a complaint and include your Razorpay order ID and payment ID where available.</p>
        <p>We will review the transaction and either restore access or assess the case for a refund. A refund is not automatic; the payment status must be verified first.</p>
        <Link className="primary" to="/support?category=BOOK_NOT_UNLOCKED">Report a locked book</Link>
      </section>
      <section className="policy-card">
        <h2>3. Duplicate charges or failed orders</h2>
        <p>If you were charged more than once for the same book, or your payment was captured but checkout failed, submit a complaint. We will verify the payment records and review any extra captured charge for refund. Keep your transaction details until the case is resolved.</p>
        <Link to="/support?category=DUPLICATE_CHARGE">Report a duplicate charge</Link>
      </section>
      <section className="policy-card">
        <h2>4. How to contact us</h2>
        <p>Use the complaint form for a traceable case, or contact our support team by email.</p>
        <p><strong>Email:</strong> <a href="mailto:msinnovatex@gmail.com">msinnovatex@gmail.com</a></p>
        <p><strong>Additional contact:</strong> <a href="mailto:Info@msinnovatex.com">Info@msinnovatex.com</a></p>
        <Link to="/support">Raise a Complaint</Link>
      </section>
      <p className="policy-footnote">Nothing in this policy limits any consumer rights that cannot legally be excluded under applicable law.</p>
    </main>
  );
}

function SupportComplaint() {
  const params = new URLSearchParams(window.location.search);
  const { user } = useAuth();
  const [category, setCategory] = useState(params.get("category") || "BOOK_NOT_UNLOCKED");
  const [bookId, setBookId] = useState(params.get("bookId") || "");
  const [orderId, setOrderId] = useState(params.get("orderId") || "");
  const [paymentId, setPaymentId] = useState(params.get("paymentId") || "");
  const [message, setMessage] = useState("");
  const [complaintId, setComplaintId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  if (!user) {
    return <Navigate to={"/login?next=" + encodeURIComponent(window.location.pathname + window.location.search)} replace />;
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!user) {
      navigate("/login?next=" + encodeURIComponent(window.location.pathname + window.location.search));
      return;
    }
    setBusy(true);
    try {
      const result = await api("/api/support/complaints", {
        method: "POST",
        body: JSON.stringify({ category, bookId, orderId, paymentId, message })
      });
      setComplaintId(result.complaintId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (complaintId) {
    return (
      <main className="auth">
        <section className="support-success">
          <span className="auth-kicker">COMPLAINT RECEIVED</span>
          <h1>We have received your request.</h1>
          <p>Your complaint ID is:</p>
          <strong className="complaint-id">{complaintId}</strong>
          <p>Keep this ID for follow-up. Our team will verify the transaction and review access restoration or refund eligibility.</p>
          <p><a href="mailto:msinnovatex@gmail.com">msinnovatex@gmail.com</a> · <a href="mailto:Info@msinnovatex.com">Info@msinnovatex.com</a></p>
          <Link className="primary" to="/library">Check My Library</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="auth support-page">
      <form onSubmit={submit}>
        <span className="auth-kicker">CUSTOMER SUPPORT</span>
        <h1>Raise a Complaint</h1>
        <p className="support-intro">Use this form if you were charged but cannot open your ebook, were charged twice, or need help with a payment.</p>
        {!user && <p className="error">Please sign in with the account used for the purchase before submitting a complaint.</p>}
        <label className="support-label">Complaint type
          <select value={category} onChange={e => setCategory(e.target.value)} required>
            <option value="BOOK_NOT_UNLOCKED">Payment done, book not unlocked</option>
            <option value="DUPLICATE_CHARGE">Duplicate payment / extra charge</option>
            <option value="PAYMENT_ISSUE">Payment or checkout issue</option>
            <option value="OTHER">Other issue</option>
          </select>
        </label>
        <label className="support-label">Book ID (if known)
          <input value={bookId} onChange={e => setBookId(e.target.value)} placeholder="Book ID" maxLength={120} />
        </label>
        <label className="support-label">Razorpay Order ID (if available)
          <input value={orderId} onChange={e => setOrderId(e.target.value)} placeholder="order_..." maxLength={100} />
        </label>
        <label className="support-label">Razorpay Payment ID (if available)
          <input value={paymentId} onChange={e => setPaymentId(e.target.value)} placeholder="pay_..." maxLength={100} />
        </label>
        <label className="support-label">What happened?
          <textarea value={message} onChange={e => setMessage(e.target.value)} minLength={10} maxLength={2000} rows={5} placeholder="Describe the issue and the approximate payment time. Do not include card details, passwords, or OTPs." required />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Submitting..." : "Submit Complaint"}</button>
        <p className="support-contact">You can also email <a href="mailto:msinnovatex@gmail.com">msinnovatex@gmail.com</a> or <a href="mailto:Info@msinnovatex.com">Info@msinnovatex.com</a>.</p>
        <p className="support-contact"><Link to="/refund-policy">Read the Refund Policy</Link></p>
      </form>
    </main>
  );
}

function Library() {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/library")
      .then(res => setBooks(Array.isArray(res.books) ? res.books : []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="container">
      <h1>My Library</h1>
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p style={{ color: "#8b949e" }}>Loading your library...</p>
      ) : books.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <p style={{ color: "#8b949e", fontSize: "18px" }}>You have not added any ebooks to your library yet.</p>
          <Link className="primary" to="/books" style={{ marginTop: "16px" }}>Browse Ebooks</Link>
        </div>
      ) : (
        <Grid books={books} />
      )}
    </main>
  );
}

function ProtectedPdfPage({ pdfDoc, pageNumber, scale, totalPages, scrollRootRef, registerPage, onActivePage, onRenderError }) {
  const sectionRef = useRef(null);
  const canvasRef = useRef(null);
  const pdfPageRef = useRef(null);
  const activeCallbackRef = useRef(onActivePage);
  const errorCallbackRef = useRef(onRenderError);
  const [visible, setVisible] = useState(false);
  const [geometry, setGeometry] = useState(null);

  useEffect(() => { activeCallbackRef.current = onActivePage; }, [onActivePage]);
  useEffect(() => { errorCallbackRef.current = onRenderError; }, [onRenderError]);

  useEffect(() => {
    let active = true;
    pdfDoc.getPage(pageNumber).then(page => {
      if (!active) return;
      pdfPageRef.current = page;
      const viewport = page.getViewport({ scale });
      setGeometry({ width: viewport.width, height: viewport.height });
    }).catch(error => {
      if (active) errorCallbackRef.current?.(error?.message || "Unable to prepare PDF page.");
    });
    return () => {
      active = false;
      pdfPageRef.current = null;
    };
  }, [pdfDoc, pageNumber, scale]);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        setVisible(true);
        const root = entry.rootBounds;
        if (root) {
          const focusLine = root.top + root.height * 0.42;
          const box = entry.boundingClientRect;
          const nearFocus = box.top <= focusLine && box.bottom >= focusLine;
          if (entry.intersectionRatio >= 0.12 || nearFocus) {
            activeCallbackRef.current?.(pageNumber);
          }
        }
      }
    }, {
      root: scrollRootRef.current,
      rootMargin: "850px 0px",
      threshold: [0, 0.12, 0.3, 0.6]
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pageNumber, scrollRootRef]);

  useEffect(() => {
    const page = pdfPageRef.current;
    const canvas = canvasRef.current;
    if (!visible || !page || !canvas || !geometry) return undefined;

    let active = true;
    const viewport = page.getViewport({ scale });
    const context = canvas.getContext("2d", { alpha: false });
    // Render at device pixel density while keeping CSS dimensions at the
    // intended zoom level. This prevents blurry text on high-DPI phones.
    const outputScale = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    const transform = outputScale > 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
    const renderTask = page.render({ canvasContext: context, viewport, transform });
    renderTask.promise.catch(error => {
      if (active && error?.name !== "RenderingCancelledException") {
        errorCallbackRef.current?.(error?.message || "Unable to render PDF page.");
      }
    });
    return () => {
      active = false;
      try { renderTask.cancel(); } catch {}
    };
  }, [visible, geometry, scale, pageNumber]);

  return (
    <section
      ref={element => {
        sectionRef.current = element;
        registerPage(pageNumber, element);
      }}
      className="canvas-page"
      style={geometry ? { width: geometry.width + "px", height: geometry.height + "px", maxWidth: "none", flex: "0 0 auto" } : { width: "min(100%, 720px)", minHeight: "65vh" }}
      aria-label={"Page " + pageNumber + " of " + totalPages}
      onContextMenu={event => event.preventDefault()}
    >
      <canvas ref={canvasRef} aria-label={"Protected ebook page " + pageNumber} />
      <span className="canvas-page-number">{pageNumber}</span>
    </section>
  );
}

function Reader() {
  const { id } = useParams();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pageNumber, setPageNumber] = useState(1);
  const [numPages, setNumPages] = useState(0);
  // "scale" is the zoom multiplier on top of fit-to-width.
  const [scale, setScale] = useState(1.0);
  const [fitScale, setFitScale] = useState(1);
  const canvasReaderRef = useRef(null);
  const pageRefs = useRef({});

  useEffect(() => {
    let active = true;
    api(`/api/books/${id}/secure-url`)
      .then(res => { if (active) setUrl(res.url); })
      .catch(e => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!url) return;
    let active = true;
    let loadingTask = null;
    setPdfLoading(true);
    setError("");
    setPdfDoc(null);
    setNumPages(0);
    setPageNumber(1);

    (async () => {
      try {
        const response = await fetch(url, { credentials: "omit", cache: "no-store" });
        if (!response.ok) throw new Error(`Unable to load protected ebook (HTTP ${response.status}).`);
        const buffer = await response.arrayBuffer();
        if (!active) return;
        loadingTask = getDocument({ data: buffer });
        const document = await loadingTask.promise;
        if (!active) {
          await document.destroy();
          return;
        }
        pageRefs.current = {};
        setPdfDoc(document);
        setNumPages(document.numPages);
      } catch (e) {
        if (active) setError(e.message || "Could not open the protected ebook.");
      } finally {
        if (active) setPdfLoading(false);
      }
    })();

    return () => {
      active = false;
      try { loadingTask?.destroy(); } catch {}
    };
  }, [url]);

  useEffect(() => {
    const reader = canvasReaderRef.current;
    if (!pdfDoc || !reader) return undefined;
    let active = true;
    let observer = null;
    let fallbackUpdate = null;

    pdfDoc.getPage(1).then(firstPage => {
      if (!active || !canvasReaderRef.current) return;
      const pageWidth = firstPage.getViewport({ scale: 1 }).width;
      const updateFit = () => {
        if (!active || !canvasReaderRef.current) return;
        // Keep the full page visible by default; zoom can then enlarge it past
        // the phone width and the reader will provide horizontal panning.
        const availableWidth = Math.max(240, canvasReaderRef.current.clientWidth - 28);
        setFitScale(Math.max(0.35, Math.min(1, availableWidth / pageWidth)));
      };
      updateFit();
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(updateFit);
        observer.observe(reader);
      } else {
        fallbackUpdate = updateFit;
        window.addEventListener("resize", fallbackUpdate);
      }
    }).catch(e => {
      if (active) setError(e.message || "Could not calculate page size.");
    });

    return () => {
      active = false;
      if (observer) observer.disconnect();
      if (fallbackUpdate) window.removeEventListener("resize", fallbackUpdate);
    };
  }, [pdfDoc]);

  useEffect(() => {
    const preventAction = event => event.preventDefault();
    const preventKeys = event => {
      const key = String(event.key || "").toLowerCase();
      if (
        ((event.ctrlKey || event.metaKey) && ["c", "x", "s", "p", "u", "a"].includes(key)) ||
        ((event.ctrlKey || event.metaKey) && event.shiftKey && ["i", "j", "c"].includes(key)) ||
        key === "f12"
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const blockEvents = ["contextmenu", "copy", "cut", "selectstart", "dragstart"];
    blockEvents.forEach(name => document.addEventListener(name, preventAction, true));
    document.addEventListener("keydown", preventKeys, true);
    document.documentElement.classList.add("protected-reader-active");
    return () => {
      blockEvents.forEach(name => document.removeEventListener(name, preventAction, true));
      document.removeEventListener("keydown", preventKeys, true);
      document.documentElement.classList.remove("protected-reader-active");
      try { pdfDoc?.destroy(); } catch {}
    };
  }, [pdfDoc]);

  const registerPage = (number, element) => {
    if (element) pageRefs.current[number] = element;
    else delete pageRefs.current[number];
  };
  const onActivePage = number => setPageNumber(previous => previous === number ? previous : number);
  const reportRenderError = message => setError(message);
  const goToPage = number => {
    const next = Math.max(1, Math.min(numPages || 1, number));
    setPageNumber(next);
    pageRefs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (error) return <main className="center error"><p>{error}</p></main>;

  return (
    <main className="reader protected-reader" onContextMenu={event => event.preventDefault()}>
      <div className="readerbar">
        <span>Protected Reader · Copy Disabled</span>
        <div className="reader-controls">
          <button type="button" aria-label="Zoom out" onClick={() => setScale(value => Math.max(.75, Number((value - .1).toFixed(1))))}>−</button>
          <span aria-live="polite">{Math.round(scale * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setScale(value => Math.min(3, Number((value + .1).toFixed(1))))}>+</button>
          <button type="button" className="reader-fit-button" onClick={() => setScale(1)}>Fit width</button>
          <button type="button" aria-label="Previous page" disabled={pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}>‹</button>
          <span>{numPages ? `${pageNumber} / ${numPages}` : "—"}</span>
          <button type="button" aria-label="Next page" disabled={!numPages || pageNumber >= numPages} onClick={() => goToPage(pageNumber + 1)}>›</button>
          <Link to="/library">Back to Library</Link>
        </div>
      </div>

      {loading || pdfLoading ? (
        <div className="center"><div className="reader-loading"><span className="reader-spinner" />Preparing protected pages…</div></div>
      ) : pdfDoc ? (
        <div className="canvas-reader" ref={canvasReaderRef} onContextMenu={event => event.preventDefault()}>
          {Array.from({ length: numPages }, (_, index) => (
            <ProtectedPdfPage
              key={id + "-" + (index + 1)}
              pdfDoc={pdfDoc}
              pageNumber={index + 1}
              totalPages={numPages}
              scale={fitScale * scale}
              scrollRootRef={canvasReaderRef}
              registerPage={registerPage}
              onActivePage={onActivePage}
              onRenderError={reportRenderError}
            />
          ))}
        </div>
      ) : (
        <div className="center error"><p>Could not load the ebook file.</p></div>
      )}
    </main>
  );
}

function App() {
  const location = useLocation();
  const portal = location.pathname.startsWith("/admin") || new URLSearchParams(location.search).get("portal") === "admin" ? "admin" : location.pathname.startsWith("/sadmin") || new URLSearchParams(location.search).get("portal") === "sadmin" ? "sadmin" : "user";
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    cachedCsrfToken = "";
    checkAuth(portal)
      .then(data => { if (active) setUser(data.user); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [portal]);

  // Do not briefly render an administrator identity on a customer route
  // while the customer portal session is being checked (and vice versa).
  const portalUser = user && (
    (portal === "admin" && user.role === "admin") ||
    (portal === "sadmin" && user.role === "sadmin") ||
    (portal === "user" && !["admin", "sadmin"].includes(user.role))
  ) ? user : null;

  if (loading) {
    return (
      <main className="center">
        <p style={{ color: "#8b949e" }}>Loading MS Tech EBook...</p>
      </main>
    );
  }

  return (
    <AuthContext.Provider value={{ user: portalUser, setUser }}>
      <SeoManager />
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/books" element={<Books />} />
          <Route path="/books/:id" element={<Detail />} />
          <Route path="/refund-policy" element={<RefundPolicy />} />
          <Route path="/support" element={<SupportComplaint />} />
          <Route path="/login" element={<AuthForm />} />
          <Route path="/register" element={<AuthForm register />} />
          <Route path="/change-password" element={portalUser ? <ChangePassword /> : <Navigate to="/login" replace />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/setadmin" element={<SetAdmin />} />
          <Route path="/library" element={portalUser ? <Library /> : <Navigate to="/login" replace />} />
          <Route path="/read/:id" element={portalUser ? <Reader /> : <Navigate to="/login" replace />} />
          <Route path="/admin/*" element={portalUser?.role === "admin" ? <AdminPanel /> : <AdminLogin />} />
          <Route path="/sadmin/*" element={portalUser?.role === "sadmin" ? <SAdmin /> : <SAdminLogin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AuthContext.Provider>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
}