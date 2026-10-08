import React, { useEffect, useState, createContext, useContext } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate, useParams } from "react-router-dom";
import "./styles.css";

// Global CSRF token cache
let cachedCsrfToken = "";

function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(";").shift();
  return "";
}

export async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const method = (options.method || "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrf = cachedCsrfToken || getCookie("ms_csrf");
    if (csrf && !headers["X-CSRF-Token"]) {
      headers["X-CSRF-Token"] = csrf;
    }
  }

  const res = await fetch(path, {
    ...options,
    credentials: "include",
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

export async function checkAuth() {
  const res = await api("/api/auth/me");
  if (res.csrfToken) cachedCsrfToken = res.csrfToken;
  return res;
}

// Auth Context for centralized user state
const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

function Layout({ children }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {}
    cachedCsrfToken = "";
    setUser(null);
    navigate("/login");
  }

  return (
    <>
      <header>
        <Link className="brand" to="/">MS Tech EBook</Link>
        <nav>
          <Link to="/books">Store</Link>
          {user ? (
            <>
              <Link to="/library">My Library</Link>
              {user.role === "admin" && (
                <Link to="/admin" style={{ color: "#a78bfa", fontWeight: 700 }}>Admin Panel</Link>
              )}
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
      {children}
      <footer>
        <p>© {new Date().getFullYear()} MS Tech EBook. All rights reserved.</p>
      </footer>
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
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [otpRequired, setOtpRequired] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);

    try {
      const payload = register
        ? { name, email, password }
        : { email, password, ...(otp ? { otp } : {}) };

      const endpoint = register ? "/api/auth/register" : "/api/auth/login";
      const data = await api(endpoint, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (data.csrfToken) cachedCsrfToken = data.csrfToken;
      setUser(data.user);

      if (data.user.mustChangePassword) {
        navigate("/change-password");
      } else if (data.user.role === "admin") {
        navigate("/admin");
      } else {
        navigate("/books");
      }
    } catch (err) {
      if (!register && (err.message.includes("Admin verification code") || err.data?.code === "ADMIN_OTP_REQUIRED")) {
        setOtpRequired(true);
      }
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form onSubmit={handleSubmit}>
        <h1>{register ? "Create Account" : "Welcome Back"}</h1>
        {register && (
          <input
            placeholder="Your Full Name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
          />
        )}
        <input
          type={register ? "email" : "text"}
          placeholder={register ? "Email Address" : "Email or Admin ID"}
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder={register ? "Password (10+ chars: upper, lower, number)" : "Password"}
          minLength={register ? 10 : undefined}
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
        />
        {otpRequired && (
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit Admin 2FA Code"
            maxLength="6"
            value={otp}
            onChange={e => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            required
          />
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in..." : register ? "Create Account" : "Login"}
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
    if (newPassword !== confirmPassword) {
      return setError("Passwords do not match");
    }
    setBusy(true);

    try {
      await api("/api/auth/change-password", {
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
        {user?.mustChangePassword && (
          <p className="success">First-time login detected. Please create a new secure password.</p>
        )}
        <input
          type="password"
          placeholder="Current Password"
          value={currentPassword}
          onChange={e => setCurrentPassword(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="New Password (10+ chars, upper, lower, number)"
          minLength={10}
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Confirm New Password"
          minLength={10}
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          required
        />
        {error && <p className="error">{error}</p>}
        {done ? (
          <p className="success">Password updated! Redirecting...</p>
        ) : (
          <button className="primary" disabled={busy}>
            {busy ? "Updating..." : "Update Password"}
          </button>
        )}
      </form>
    </main>
  );
}

function SetAdmin() {
  const [adminId, setAdminId] = useState("");
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
        if (e.message && e.message.includes("already completed")) setLocked(true);
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
        body: JSON.stringify({ adminId, email, password })
      });
      setDone(true);
      setTimeout(() => navigate("/login"), 1500);
    } catch (err) {
      if (err.message && err.message.includes("already completed")) setLocked(true);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (locked) {
    return (
      <main className="auth">
        <form>
          <h1>Setup Completed</h1>
          <p className="success">The administrator account has already been initialized. This endpoint is permanently disabled.</p>
          <button type="button" className="primary" onClick={() => navigate("/login")}>Go to Login</button>
        </form>
      </main>
    );
  }

  if (done) {
    return (
      <main className="auth">
        <form>
          <h1>Admin Account Created</h1>
          <p className="success">Administrator account successfully created! Setup is now locked.</p>
          <p>Redirecting to login...</p>
        </form>
      </main>
    );
  }

  return (
    <main className="auth">
      <form onSubmit={submit}>
        <h1>Initialize Admin</h1>
        <p style={{ color: "#a0aec0", fontSize: "14px" }}>
          Configure the primary administrator account. Once set, this setup endpoint is permanently locked.
        </p>
        <input
          placeholder="Admin User ID (e.g. admin)"
          value={adminId}
          onChange={e => setAdminId(e.target.value)}
          pattern="[A-Za-z0-9_-]{3,64}"
          minLength={3}
          maxLength={64}
          required
        />
        <input
          type="email"
          placeholder="Admin Email Address"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Admin Password (10+ chars, upper, lower, number)"
          minLength={10}
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Confirm Admin Password"
          minLength={10}
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          required
        />
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Configuring..." : "Create Admin Account"}
        </button>
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

function Admin() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [books, setBooks] = useState([]);
  const [type, setType] = useState("PAID");
  const [form, setForm] = useState({ title: "", author: "", category: "", description: "", price: "" });
  const [cover, setCover] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(null);

  const loadBooks = () => {
    api("/api/admin/books")
      .then(data => setBooks(Array.isArray(data.books) ? data.books : []))
      .catch(e => setErr(e.message));
  };

  useEffect(() => {
    if (!user || user.role !== "admin") {
      navigate("/login");
      return;
    }
    if (user.mustChangePassword) {
      navigate("/change-password");
      return;
    }
    loadBooks();
  }, [user, navigate]);

  const resetForm = () => {
    setEditing(null);
    setType("PAID");
    setForm({ title: "", author: "", category: "", description: "", price: "" });
    setCover(null);
    setFile(null);
    setErr("");
  };

  async function handleUpload(e) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    setErr("");

    try {
      if (!cover || !file) throw new Error("Select both a cover image and PDF ebook");
      if (file.type !== "application/pdf") throw new Error("Ebook file must be a PDF");
      if (!["image/jpeg", "image/png", "image/webp"].includes(cover.type)) {
        throw new Error("Cover must be JPG, PNG, or WEBP format");
      }

      await api("/api/admin/storage-cors", { method: "POST" }).catch(() => {});

      const uploadDirect = async f => {
        const u = await api("/api/admin/upload-url", {
          method: "POST",
          body: JSON.stringify({ name: f.name, type: f.type, size: f.size })
        });
        const putRes = await fetch(u.url, {
          method: "PUT",
          headers: { "Content-Type": f.type },
          body: f
        });
        if (!putRes.ok) throw new Error(`Upload failed for ${f.name}`);
        return u.path;
      };

      const coverPath = await uploadDirect(cover);
      const storagePath = await uploadDirect(file);

      await api("/api/admin/books", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          type,
          price: type === "FREE" ? 0 : Number(form.price),
          coverPath,
          storagePath
        })
      });

      setMsg("Ebook successfully published!");
      resetForm();
      e.target.reset();
      loadBooks();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");

    try {
      await api(`/api/admin/books/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...form,
          type,
          price: type === "FREE" ? 0 : Number(form.price),
          status: editing.status
        })
      });
      setMsg("Book updated successfully.");
      resetForm();
      loadBooks();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Permanently delete this ebook and its stored files?")) return;
    try {
      await api(`/api/admin/books/${id}`, { method: "DELETE" });
      setMsg("Book deleted.");
      loadBooks();
    } catch (x) {
      setErr(x.message);
    }
  }

  async function handleToggleStatus(b) {
    try {
      const nextStatus = b.status === "ACTIVE" ? "DRAFT" : "ACTIVE";
      await api(`/api/admin/books/${b.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...b, status: nextStatus })
      });
      setMsg(nextStatus === "ACTIVE" ? "Book published." : "Book unpublished.");
      loadBooks();
    } catch (x) {
      setErr(x.message);
    }
  }

  function startEdit(b) {
    setEditing(b);
    setType(b.type || "PAID");
    setForm({
      title: b.title || "",
      author: b.author || "",
      category: b.category || "",
      description: b.description || "",
      price: b.price || ""
    });
    setMsg("");
    setErr("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="admin-shell">
      <div className="admin-top">
        <div>
          <span className="eyebrow">MS TECH EBOOK · ADMIN</span>
          <h1>Dashboard</h1>
          <p>Manage your digital catalog, pricing, and book distribution.</p>
        </div>
        <div className="admin-top-actions">
          <Link className="admin-secondary" to="/books">View Store</Link>
        </div>
      </div>

      <div className="admin-stats">
        <div><span>Total Ebooks</span><strong>{books.length}</strong></div>
        <div><span>Active</span><strong>{books.filter(b => b.status === "ACTIVE").length}</strong></div>
        <div><span>Free</span><strong>{books.filter(b => b.type === "FREE").length}</strong></div>
        <div><span>Paid</span><strong>{books.filter(b => b.type === "PAID").length}</strong></div>
      </div>

      <div className="admin-grid">
        <section className="admin-panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">{editing ? "EDITING MODE" : "CATALOG MANAGEMENT"}</span>
              <h2>{editing ? `Editing: ${editing.title}` : "Publish New Ebook"}</h2>
            </div>
            {editing && <button className="admin-secondary" onClick={resetForm}>Cancel</button>}
          </div>

          <form className="admin-form" onSubmit={editing ? handleSaveEdit : handleUpload}>
            <div className="field">
              <label>Book Title *</label>
              <input
                required
                value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Master Modern Full-Stack"
              />
            </div>

            <div className="field-row">
              <div className="field">
                <label>Author</label>
                <input
                  value={form.author}
                  onChange={e => setForm({ ...form, author: e.target.value })}
                  placeholder="Author Name"
                />
              </div>
              <div className="field">
                <label>Category</label>
                <input
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  placeholder="Technology, Engineering..."
                />
              </div>
            </div>

            <div className="field">
              <label>Description</label>
              <textarea
                rows={5}
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="Detailed summary of the book..."
              />
            </div>

            <div className="field-row">
              <div className="field">
                <label>Access Type *</label>
                <select value={type} onChange={e => setType(e.target.value)}>
                  <option value="PAID">Paid Ebook</option>
                  <option value="FREE">Free Ebook</option>
                </select>
              </div>
              <div className="field">
                <label>Price (₹) {type === "PAID" && "*"}</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  disabled={type === "FREE"}
                  required={type === "PAID"}
                  value={type === "FREE" ? "" : form.price}
                  onChange={e => setForm({ ...form, price: e.target.value })}
                  placeholder="499"
                />
              </div>
            </div>

            {!editing && (
              <div className="upload-grid">
                <label className="upload-box">
                  <span>Cover Image *</span>
                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,image/*"
                    required
                    onChange={e => setCover(e.target.files?.[0] || null)}
                  />
                  <small>{cover ? cover.name : "JPG, PNG, WEBP (Max 10MB)"}</small>
                </label>
                <label className="upload-box">
                  <span>PDF Document *</span>
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    required
                    onChange={e => setFile(e.target.files?.[0] || null)}
                  />
                  <small>{file ? file.name : "PDF only (Max 100MB)"}</small>
                </label>
              </div>
            )}

            {err && <p className="error">{err}</p>}
            {msg && <p className="success">{msg}</p>}

            <button className="admin-primary" disabled={busy}>
              {busy ? "Processing..." : editing ? "Save Changes" : "Upload & Publish Ebook"}
            </button>
          </form>
        </section>

        <aside className="admin-panel admin-help">
          <span className="eyebrow">GUIDELINES</span>
          <h2>Secure Distribution</h2>
          <ol>
            <li>Files are kept in private Firebase Storage.</li>
            <li>Readers receive timed signed URLs only after authorization.</li>
            <li>Set prices in whole Rupees (INR).</li>
            <li>Use high-resolution 3:4 aspect ratio covers for best appearance.</li>
          </ol>
        </aside>
      </div>

      <section className="admin-panel catalog">
        <div className="panel-title">
          <div>
            <span className="eyebrow">CATALOG</span>
            <h2>Manage Ebooks ({books.length})</h2>
          </div>
        </div>

        {books.length > 0 ? (
          <div className="catalog-list">
            {books.map(b => (
              <div className="catalog-row" key={b.id}>
                <div className="catalog-cover">
                  {b.coverUrl ? <img src={b.coverUrl} alt="" /> : <span>PDF</span>}
                </div>
                <div className="catalog-main">
                  <strong>{b.title}</strong>
                  <span>{b.author || "MS Tech EBook"} · {b.category || "General"}</span>
                </div>
                <div className="catalog-meta">
                  <b className={b.type === "FREE" ? "free" : "paid"}>
                    {b.type === "FREE" ? "FREE" : `₹${Number(b.price || 0)}`}
                  </b>
                  <span className={b.status === "ACTIVE" ? "published" : "draft"}>
                    {b.status === "ACTIVE" ? "Active" : "Draft"}
                  </span>
                </div>
                <div className="catalog-actions">
                  <button onClick={() => startEdit(b)}>Edit</button>
                  <button onClick={() => handleToggleStatus(b)}>
                    {b.status === "ACTIVE" ? "Unpublish" : "Publish"}
                  </button>
                  <Link to={`/read/${b.id}`} style={{ padding: "8px 10px", borderRadius: "8px", background: "#151b29", border: "1px solid #30384b", fontSize: "12px" }}>
                    Preview
                  </Link>
                  <button className="danger" onClick={() => handleDelete(b.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="catalog-empty">
            <h3>No ebooks uploaded yet</h3>
            <p>Upload your first ebook using the form above.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function Reader() {
  const { id } = useParams();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api(`/api/books/${id}/secure-url`)
      .then(res => setUrl(res.url))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    const preventAction = e => e.preventDefault();
    const preventKeys = e => {
      if ((e.ctrlKey || e.metaKey) && ["c", "x", "s", "p", "u"].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
    };
    ["contextmenu", "copy", "cut", "selectstart"].forEach(ev => document.addEventListener(ev, preventAction));
    document.addEventListener("keydown", preventKeys);
    return () => {
      ["contextmenu", "copy", "cut", "selectstart"].forEach(ev => document.removeEventListener(ev, preventAction));
      document.removeEventListener("keydown", preventKeys);
    };
  }, []);

  if (error) return <main className="center error"><p>{error}</p></main>;

  return (
    <main className="reader">
      <div className="readerbar">
        <span>Protected Reader</span>
        <Link to="/library" style={{ background: "#202637", padding: "6px 14px", borderRadius: "6px" }}>
          Back to Library
        </Link>
      </div>
      {loading ? (
        <div className="center"><p>Preparing your reading session...</p></div>
      ) : url ? (
        <iframe title="Protected Ebook Reader" src={`${url}#toolbar=0&navpanes=0`} />
      ) : (
        <div className="center error"><p>Could not load the ebook file.</p></div>
      )}
    </main>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkAuth()
      .then(data => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

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
          <Route path="/admin" element={user?.role === "admin" ? <Admin /> : <Navigate to="/login" replace />} />
          <Route path="/admin/admin" element={<Navigate to="/admin" replace />} />
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