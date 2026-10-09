import React, { useEffect, useRef, useState, createContext, useContext } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate, useParams, useLocation } from "react-router-dom";
import "./styles.css";
import AdminPanel from "./AdminPanel";

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
  return window.location.pathname.startsWith("/admin") || params.get("portal") === "admin" ? "admin" : "user";
}

export async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const method = (options.method || "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrfCookie = activePortal() === "admin" ? "ms_admin_csrf" : "ms_csrf";
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

// Auth Context for centralized user state
const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

function Layout({ children }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdminArea = location.pathname.startsWith("/admin");

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
      {!isAdminArea && (
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
      {!isAdminArea && (
        <footer>
          <p>© {new Date().getFullYear()} MS Tech EBook. All rights reserved.</p>
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
              <img src={b.coverUrl} alt={b.title} loading="lazy" />
            ) : (
              <b>MS<br />TECH<br />EBOOK</b>
            )}
          </div>
          <h3>{b.title}</h3>
          <p>{b.author || "MS Tech EBook"}</p>
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
        <h1>Read with <em>MS Tech EBook.</em></h1>
        <p>Buy once. Keep your digital books forever in your personal cloud library.</p>
        <Link className="primary" to="/books" style={{ marginTop: "16px" }}>Browse Catalog</Link>
      </div>
      <section>
        <h2>Featured Titles</h2>
        {loading && <p style={{ color: "#8b949e" }}>Loading catalog...</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && <Grid books={books.slice(0, 6)} />}
      </section>
    </main>
  );
}

function Books() {
  const [books, setBooks] = useState([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/books")
      .then(data => setBooks(Array.isArray(data.books) ? data.books : []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = books.filter(b =>
    `${b.title} ${b.author || ""} ${b.category || ""}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <main className="container">
      <h1>All Ebooks</h1>
      {error && <p className="error">{error}</p>}
      <input
        type="search"
        placeholder="Search by title, author, or category..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
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
        if (data.user.mustChangePassword) navigate("/change-password");
        else navigate("/books");
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
      const portalQuery = user?.role === "admin" ? "?portal=admin" : "?portal=user";
      await api("/api/auth/change-password" + portalQuery, {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword })
      });
      setUser({ ...user, mustChangePassword: false });
      setDone(true);
      setTimeout(() => navigate(user?.role === "admin" ? "/admin" : "/books"), 1000);
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
  const navigate = useNavigate();

  useEffect(() => {
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

  async function handleBuy() {
    if (!user) return navigate("/login");
    setBuying(true);

    try {
      const orderData = await api("/api/orders/create", {
        method: "POST",
        body: JSON.stringify({ bookId: id })
      });

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
            await api("/api/orders/verify", {
              method: "POST",
              body: JSON.stringify({
                bookId: id,
                ...response
              })
            });
            navigate("/library");
          } catch (verifyErr) {
            alert(`Payment verification error: ${verifyErr.message}`);
          }
        },
        theme: { color: "#7c5cff" }
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", resp => {
        alert(`Payment failed: ${resp.error?.description || "Unknown error"}`);
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
          <img src={book.coverUrl} alt={book.title} />
        ) : (
          <b>MS<br />TECH<br />EBOOK</b>
        )}
      </div>
      <div>
        <small style={{ letterSpacing: "1.5px", fontWeight: 700, color: "#9b8cff" }}>
          {book.category || "EBOOK"}
        </small>
        <h1>{book.title}</h1>
        <p style={{ color: "#8b949e", marginBottom: "16px" }}>By {book.author || "MS Tech EBook"}</p>
        <p style={{ whiteSpace: "pre-line" }}>{book.description}</p>
        <h2 style={{ margin: "24px 0" }}>{isFree ? "Free" : `₹${Number(book.price || 0)}`}</h2>
        {canRead ? (
          <Link className="primary" to={`/read/${id}`}>Read Now</Link>
        ) : (
          <button className="primary" onClick={handleBuy} disabled={buying}>
            {buying ? "Initiating..." : `Buy for ₹${Number(book.price || 0)}`}
          </button>
        )}
      </div>
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

function Reader() {
  const { id } = useParams();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pageNumber, setPageNumber] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const canvasRef = useRef(null);

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
    if (!pdfDoc || !canvasRef.current) return;
    let active = true;
    const render = async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (!active) return;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d", { alpha: false });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: context, viewport }).promise;
      } catch (e) {
        if (active) setError(e.message || "Unable to render this page.");
      }
    };
    render();
    return () => { active = false; };
  }, [pdfDoc, pageNumber, scale]);

  useEffect(() => {
    const preventAction = e => e.preventDefault();
    const preventKeys = e => {
      const key = String(e.key || "").toLowerCase();
      if (
        ((e.ctrlKey || e.metaKey) && ["c", "x", "s", "p", "u", "a"].includes(key)) ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && ["i", "j", "c"].includes(key)) ||
        key === "f12"
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const blockEvents = ["contextmenu", "copy", "cut", "selectstart", "dragstart"];
    blockEvents.forEach(ev => document.addEventListener(ev, preventAction, true));
    document.addEventListener("keydown", preventKeys, true);
    document.documentElement.classList.add("protected-reader-active");
    return () => {
      blockEvents.forEach(ev => document.removeEventListener(ev, preventAction, true));
      document.removeEventListener("keydown", preventKeys, true);
      document.documentElement.classList.remove("protected-reader-active");
      try { pdfDoc?.destroy(); } catch {}
    };
  }, [pdfDoc]);

  if (error) return <main className="center error"><p>{error}</p></main>;

  return (
    <main className="reader protected-reader" onContextMenu={e => e.preventDefault()}>
      <div className="readerbar">
        <span>Protected Reader · Copy Disabled</span>
        <div className="reader-controls">
          <button type="button" onClick={() => setScale(v => Math.max(.75, Number((v - .1).toFixed(1))))}>−</button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScale(v => Math.min(2.2, Number((v + .1).toFixed(1))))}>+</button>
          <button type="button" disabled={pageNumber <= 1} onClick={() => setPageNumber(v => Math.max(1, v - 1))}>‹</button>
          <span>{numPages ? `${pageNumber} / ${numPages}` : "—"}</span>
          <button type="button" disabled={!numPages || pageNumber >= numPages} onClick={() => setPageNumber(v => Math.min(numPages, v + 1))}>›</button>
          <Link to="/library">Back to Library</Link>
        </div>
      </div>

      {loading || pdfLoading ? (
        <div className="center"><div className="reader-loading"><span className="reader-spinner" />Preparing protected pages…</div></div>
      ) : pdfDoc ? (
        <div className="canvas-reader" onContextMenu={e => e.preventDefault()}>
          <div className="canvas-page" onContextMenu={e => e.preventDefault()}>
            <canvas ref={canvasRef} aria-label={`Protected ebook page ${pageNumber}`} />
          </div>
        </div>
      ) : (
        <div className="center error"><p>Could not load the ebook file.</p></div>
      )}
    </main>
  );
}

function App() {
  const location = useLocation();
  const portal = location.pathname.startsWith("/admin") || new URLSearchParams(location.search).get("portal") === "admin" ? "admin" : "user";
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

  if (loading) {
    return (
      <main className="center">
        <p style={{ color: "#8b949e" }}>Loading MS Tech EBook...</p>
      </main>
    );
  }

  return (
    <AuthContext.Provider value={{ user, setUser }}>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/books" element={<Books />} />
          <Route path="/books/:id" element={<Detail />} />
          <Route path="/login" element={<AuthForm />} />
          <Route path="/register" element={<AuthForm register />} />
          <Route path="/change-password" element={user ? <ChangePassword /> : <Navigate to="/login" replace />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/setadmin" element={<SetAdmin />} />
          <Route path="/library" element={user ? <Library /> : <Navigate to="/login" replace />} />
          <Route path="/read/:id" element={user ? <Reader /> : <Navigate to="/login" replace />} />
          <Route path="/admin/*" element={user?.role === "admin" ? <AdminPanel /> : <AdminLogin />} />
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