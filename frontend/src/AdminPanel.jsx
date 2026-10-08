import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileText,
  IndianRupee,
  LayoutDashboard,
  Library as LibraryIcon,
  LogOut,
  Menu,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShoppingBag,
  Trash2,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { api, useAuth } from "./main";

const NAV = [
  { key: "dashboard", label: "Overview", icon: LayoutDashboard },
  { key: "upload", label: "Upload Book", icon: UploadCloud },
  { key: "library", label: "Library", icon: LibraryIcon },
  { key: "orders", label: "Orders", icon: ShoppingBag },
  { key: "users", label: "Users", icon: Users },
  { key: "settings", label: "Settings", icon: Settings },
];

const emptyUploadState = {
  cover: { status: "idle", progress: 0, message: "Waiting" },
  pdf: { status: "idle", progress: 0, message: "Waiting" }
};

function AdminPanel() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const segment = location.pathname.split("/").filter(Boolean)[1] || "dashboard";
  const view = NAV.some(item => item.key === segment) ? segment : "dashboard";

  const [books, setBooks] = useState([]);
  const [orders, setOrders] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [notice, setNotice] = useState({ type: "", text: "" });

  const [form, setForm] = useState({
    title: "",
    author: "",
    category: "",
    description: "",
    price: "",
  });
  const [type, setType] = useState("PAID");
  const [cover, setCover] = useState(null);
  const [file, setFile] = useState(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadState, setUploadState] = useState(emptyUploadState);

  const [editing, setEditing] = useState(null);
  const [editBusy, setEditBusy] = useState(false);

  const [initialized, setInitialized] = useState(false);

  const showNotice = (type, text) => {
    setNotice({ type, text });
    window.setTimeout(() => setNotice(current => current.text === text ? { type: "", text: "" } : current), 5000);
  };

  const setView = next => {
    navigate(next === "dashboard" ? "/admin" : "/admin/" + next);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const loadBooks = async () => {
    const data = await api("/api/admin/books");
    setBooks(Array.isArray(data.books) ? data.books : []);
  };

  const loadOrders = async () => {
    try {
      const data = await api("/api/admin/orders");
      setOrders(Array.isArray(data.orders) ? data.orders : []);
    } catch {
      setOrders([]);
    }
  };

  const loadUsers = async () => {
    try {
      const data = await api("/api/admin/users");
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch {
      setUsers([]);
    }
  };

  const loadAll = async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      await Promise.all([loadBooks(), loadOrders(), loadUsers()]);
      setInitialized(true);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        cachedLogout();
        return;
      }
      showNotice("error", err.message || "Could not load the administrator workspace.");
    } finally {
      if (quiet) setRefreshing(false);
      else setLoading(false);
    }
  };

  const cachedLogout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    setUser(null);
    navigate("/admin", { replace: true });
  };

  useEffect(() => {
    if (!user || user.role !== "admin") {
      navigate("/admin", { replace: true });
      return;
    }
    if (user.mustChangePassword) {
      navigate("/change-password", { replace: true });
      return;
    }
    if (!initialized) loadAll();
  }, [user]);

  const updateUploadState = (kind, patch) => {
    setUploadState(previous => ({
      ...previous,
      [kind]: { ...previous[kind], ...patch }
    }));
  };

  const waitForUploadedFile = async (storagePath, expectedSize, expectedType) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const result = await api("/api/admin/upload-status?path=" + encodeURIComponent(storagePath));
        if (
          result.uploaded &&
          Number(result.size) === Number(expectedSize) &&
          String(result.contentType || "").toLowerCase() === String(expectedType || "").toLowerCase()
        ) return result;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error("Cloudflare R2 did not confirm the upload. Check the bucket CORS policy and retry.");
  };

  const uploadDirect = async (selectedFile, kind, label) => {
    updateUploadState(kind, { status: "preparing", progress: 0, message: "Preparing " + label + "..." });
    const policy = await api("/api/admin/upload-url", {
      method: "POST",
      body: JSON.stringify({
        name: selectedFile.name,
        type: selectedFile.type,
        size: selectedFile.size,
      }),
    });

    updateUploadState(kind, { status: "uploading", progress: 0, message: "Uploading " + label + " to R2..." });

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;

      const verify = async () => {
        if (settled) return;
        try {
          await waitForUploadedFile(policy.path, selectedFile.size, selectedFile.type);
          settled = true;
          updateUploadState(kind, {
            status: "done",
            progress: 100,
            message: label + " uploaded and verified.",
          });
          resolve(policy.path);
        } catch (err) {
          settled = true;
          updateUploadState(kind, { status: "error", progress: 0, message: err.message });
          reject(err);
        }
      };

      xhr.open("PUT", policy.url, true);
      xhr.setRequestHeader("Content-Type", selectedFile.type);
      xhr.timeout = 30 * 60 * 1000;

      xhr.upload.onprogress = event => {
        if (event.lengthComputable) {
          const progress = Math.min(99, Math.round((event.loaded / event.total) * 100));
          updateUploadState(kind, {
            status: "uploading",
            progress,
            message: label + ": " + progress + "%",
          });
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          updateUploadState(kind, { status: "verifying", progress: 100, message: "Transfer complete. Verifying R2 object..." });
          verify();
        } else {
          settled = true;
          const message = xhr.status === 403
            ? "R2 rejected the upload. Check your bucket CORS configuration."
            : "R2 upload failed with HTTP " + xhr.status + ".";
          updateUploadState(kind, { status: "error", progress: 0, message });
          reject(new Error(message));
        }
      };

      xhr.onerror = () => {
        if (!settled) verify().catch(() => {});
      };

      xhr.ontimeout = () => {
        if (settled) return;
        settled = true;
        const message = label + " upload timed out. Please retry.";
        updateUploadState(kind, { status: "error", progress: 0, message });
        reject(new Error(message));
      };

      xhr.onabort = () => {
        if (settled) return;
        settled = true;
        const message = label + " upload was cancelled.";
        updateUploadState(kind, { status: "error", progress: 0, message });
        reject(new Error(message));
      };

      xhr.send(selectedFile);
    });
  };

  const resetUpload = () => {
    setForm({ title: "", author: "", category: "", description: "", price: "" });
    setType("PAID");
    setCover(null);
    setFile(null);
    setUploadBusy(false);
    setUploadState(emptyUploadState);
  };

  const handleUpload = async event => {
    event.preventDefault();
    if (uploadBusy) return;

    setUploadBusy(true);
    setNotice({ type: "", text: "" });
    setUploadState(emptyUploadState);

    const uploadedPaths = [];

    try {
      if (!cover || !file) throw new Error("Select both a cover image and the PDF before publishing.");
      if (file.type !== "application/pdf") throw new Error("The ebook file must be a PDF.");
      if (!["image/jpeg", "image/png", "image/webp"].includes(cover.type)) throw new Error("Cover must be JPG, PNG, or WEBP.");

      const coverPath = await uploadDirect(cover, "cover", "Cover image");
      uploadedPaths.push(coverPath);

      const storagePath = await uploadDirect(file, "pdf", "PDF document");
      uploadedPaths.push(storagePath);

      updateUploadState("pdf", { status: "publishing", progress: 100, message: "Files verified. Publishing catalog entry..." });

      const result = await api("/api/admin/books", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          type,
          price: type === "FREE" ? 0 : Number(form.price),
          coverPath,
          storagePath,
          storageProvider: "r2",
        }),
      });

      resetUpload();
      await loadBooks();
      setView("library");
      showNotice("success", "Ebook published successfully. It is now active in the storefront.");
      if (result?.id) {
        setQuery("");
      }
    } catch (err) {
      for (const storagePath of uploadedPaths) {
        try {
          await api("/api/admin/upload-file", {
            method: "DELETE",
            body: JSON.stringify({ path: storagePath }),
          });
        } catch {}
      }
      showNotice("error", err.message || "Upload failed.");
    } finally {
      setUploadBusy(false);
    }
  };

  const beginEdit = book => {
    setEditing({
      id: book.id,
      title: book.title || "",
      author: book.author || "",
      category: book.category || "",
      description: book.description || "",
      price: book.price || "",
      type: book.type || "PAID",
      status: book.status || "ACTIVE",
    });
  };

  const saveEdit = async event => {
    event.preventDefault();
    if (!editing) return;
    setEditBusy(true);
    try {
      await api("/api/admin/books/" + editing.id, {
        method: "PATCH",
        body: JSON.stringify({
          ...editing,
          price: editing.type === "FREE" ? 0 : Number(editing.price),
        }),
      });
      await loadBooks();
      setEditing(null);
      showNotice("success", "Book details updated.");
    } catch (err) {
      showNotice("error", err.message || "Could not update this book.");
    } finally {
      setEditBusy(false);
    }
  };

  const toggleStatus = async book => {
    try {
      const nextStatus = book.status === "ACTIVE" ? "DRAFT" : "ACTIVE";
      await api("/api/admin/books/" + book.id, {
        method: "PATCH",
        body: {
          ...book,
          status: nextStatus,
          type: book.type || "PAID",
          price: book.type === "FREE" ? 0 : Number(book.price || 0),
        },
      });
      await loadBooks();
      showNotice("success", nextStatus === "ACTIVE" ? "Book published to the storefront." : "Book moved to draft.");
    } catch (err) {
      showNotice("error", err.message || "Could not change publishing status.");
    }
  };

  const deleteBook = async book => {
    if (!window.confirm('Delete "' + book.title + '" and remove its stored files?')) return;
    try {
      await api("/api/admin/books/" + book.id, { method: "DELETE" });
      await loadBooks();
      showNotice("success", "Book deleted.");
    } catch (err) {
      showNotice("error", err.message || "Could not delete the book.");
    }
  };

  const filteredBooks = useMemo(() => {
    const q = query.toLowerCase().trim();
    return books.filter(book => {
      const matchesQuery = !q || [
        book.title,
        book.author,
        book.category,
      ].filter(Boolean).join(" ").toLowerCase().includes(q);
      const matchesStatus = statusFilter === "ALL" || String(book.status || "").toUpperCase() === statusFilter;
      const bookType = book.type === "FREE" || Number(book.price || 0) === 0 ? "FREE" : "PAID";
      const matchesType = typeFilter === "ALL" || bookType === typeFilter;
      return matchesQuery && matchesStatus && matchesType;
    });
  }, [books, query, statusFilter, typeFilter]);

  const stats = {
    total: books.length,
    active: books.filter(b => String(b.status || "").toUpperCase() === "ACTIVE").length,
    draft: books.filter(b => String(b.status || "").toUpperCase() === "DRAFT").length,
    paid: books.filter(b => b.type === "PAID" && Number(b.price || 0) > 0).length,
    free: books.filter(b => b.type === "FREE" || Number(b.price || 0) === 0).length,
  };

  const formatDate = value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : "—";
  };

  const formatMoney = value => "₹" + Number(value || 0).toLocaleString("en-IN");

  if (loading) {
    return (
      <main className="admin-workspace-loading">
        <div className="admin-loader-card">
          <span className="admin-loader-dot" />
          <strong>Opening administrator workspace…</strong>
          <span>Loading catalog, orders and users</span>
        </div>
      </main>
    );
  }

  return (
    <main className="admin-workspace">
      <div className="admin-mobile-overlay" data-open={sidebarOpen} onClick={() => setSidebarOpen(false)} />
      <aside className={"admin-sidebar" + (sidebarOpen ? " open" : "")}>
        <div className="admin-sidebar-brand">
          <div className="admin-brand-mark">MS</div>
          <div>
            <strong>MS Tech EBook</strong>
            <span>Control Center</span>
          </div>
          <button className="admin-icon-button admin-mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        <div className="admin-sidebar-section">
          <span className="admin-sidebar-label">Workspace</span>
          <nav className="admin-nav">
            {NAV.map(item => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  className={"admin-nav-item" + (view === item.key ? " active" : "")}
                  onClick={() => setView(item.key)}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                  {item.key === "library" && <b>{books.length}</b>}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="admin-sidebar-bottom">
          <Link to="/books" className="admin-sidebar-link" onClick={() => setSidebarOpen(false)}>
            <ExternalLink size={17} /> Storefront
          </Link>
          <button className="admin-sidebar-link" onClick={cachedLogout}>
            <LogOut size={17} /> Sign out
          </button>
          <div className="admin-account-chip">
            <div className="admin-avatar">{String(user?.name || "A").trim().charAt(0).toUpperCase()}</div>
            <div>
              <strong>{user?.name || "Administrator"}</strong>
              <span>{user?.email || "—"}</span>
            </div>
          </div>
        </div>
      </aside>

      <section className="admin-main">
        <header className="admin-headerbar">
          <div className="admin-header-left">
            <button className="admin-icon-button admin-menu-trigger" onClick={() => setSidebarOpen(true)} aria-label="Open admin menu">
              <Menu size={20} />
            </button>
            <div>
              <span className="admin-header-kicker">ADMINISTRATOR</span>
              <h1>{NAV.find(item => item.key === view)?.label || "Overview"}</h1>
            </div>
          </div>
          <div className="admin-header-actions">
            <button className="admin-secondary" onClick={() => loadAll(true)} disabled={refreshing}>
              <RefreshCw size={15} className={refreshing ? "admin-spin" : ""} />
              Refresh
            </button>
            <button className="admin-primary compact" onClick={() => setView("upload")}>
              <Plus size={16} /> New Book
            </button>
          </div>
        </header>

        {notice.text && (
          <div className={"admin-alert " + (notice.type === "error" ? "is-error" : "is-success")}>
            {notice.type === "error" ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            <span>{notice.text}</span>
            <button onClick={() => setNotice({ type: "", text: "" })} aria-label="Dismiss"><X size={15} /></button>
          </div>
        )}

        {view === "dashboard" && (
          <>
            <section className="admin-command">
              <div>
                <span className="admin-header-kicker">CATALOG COMMAND CENTER</span>
                <h2>Run your ebook business from one place.</h2>
                <p>Publish books, control availability, review sales activity and keep your digital library organized.</p>
                <div className="admin-command-actions">
                  <button className="admin-primary" onClick={() => setView("upload")}><UploadCloud size={17} /> Upload a Book</button>
                  <button className="admin-secondary" onClick={() => setView("library")}><LibraryIcon size={17} /> Open Library</button>
                </div>
              </div>
              <div className="admin-command-orb">
                <BookOpen size={58} strokeWidth={1.5} />
              </div>
            </section>

            <section className="admin-stat-grid">
              <StatCard label="Total books" value={stats.total} icon={<BookOpen size={19} />} meta={stats.active + " active"} />
              <StatCard label="Paid books" value={stats.paid} icon={<IndianRupee size={19} />} meta={stats.free + " free"} />
              <StatCard label="Orders" value={orders.length} icon={<ShoppingBag size={19} />} meta="Recorded orders" />
              <StatCard label="Customers" value={users.length} icon={<Users size={19} />} meta="Registered accounts" />
            </section>

            <section className="admin-dashboard-grid">
              <div className="admin-card">
                <SectionHeading
                  eyebrow="RECENT CATALOG"
                  title="Latest books"
                  action={<button className="admin-text-action" onClick={() => setView("library")}>View all <ChevronRight size={15} /></button>}
                />
                <BookMiniList books={books.slice(0, 5)} formatMoney={formatMoney} />
              </div>
              <div className="admin-card">
                <SectionHeading eyebrow="QUICK STATUS" title="Store health" />
                <div className="admin-health-grid">
                  <HealthItem label="Published" value={stats.active} tone="good" />
                  <HealthItem label="Drafts" value={stats.draft} tone="neutral" />
                  <HealthItem label="Paid catalog" value={stats.paid} tone="accent" />
                  <HealthItem label="Free catalog" value={stats.free} tone="neutral" />
                </div>
                <div className="admin-tip">
                  <PackageCheck size={18} />
                  <div>
                    <strong>Publishing rule</strong>
                    <span>A book appears in the customer Store only while its status is Active.</span>
                  </div>
                </div>
              </div>
            </section>
          </>
        )}

        {view === "upload" && (
          <section className="admin-page-grid upload-page">
            <div className="admin-card admin-form-card">
              <SectionHeading eyebrow="PUBLISHING" title="Add a new ebook" subtitle="Upload the protected PDF and cover, then publish it directly to the active catalog." />
              <form className="admin-pro-form" onSubmit={handleUpload}>
                <div className="admin-form-section-title">Book information</div>
                <div className="admin-two-col">
                  <Field label="Book title" required>
                    <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Database Management System" required />
                  </Field>
                  <Field label="Author">
                    <input value={form.author} onChange={e => setForm({ ...form, author: e.target.value })} placeholder="Author name" />
                  </Field>
                </div>
                <div className="admin-two-col">
                  <Field label="Category">
                    <input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} placeholder="Technology, Engineering…" />
                  </Field>
                  <Field label="Access type">
                    <select value={type} onChange={e => setType(e.target.value)}>
                      <option value="PAID">Paid ebook</option>
                      <option value="FREE">Free ebook</option>
                    </select>
                  </Field>
                </div>
                <Field label={"Price (INR)" + (type === "PAID" ? " · required" : "")}>
                  <input type="number" min="1" step="1" disabled={type === "FREE"} required={type === "PAID"} value={type === "FREE" ? "" : form.price} onChange={e => setForm({ ...form, price: e.target.value })} placeholder="499" />
                </Field>
                <Field label="Description">
                  <textarea rows={6} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Explain what the reader will learn or get from this ebook." />
                </Field>

                <div className="admin-form-section-title">Protected files</div>
                <div className="admin-file-grid">
                  <FileDrop label="Cover image" accept=".jpg,.jpeg,.png,.webp,image/*" file={cover} setFile={setCover} icon={<BookOpen size={22} />} hint="JPG, PNG or WEBP · max 10 MB" />
                  <FileDrop label="PDF document" accept=".pdf,application/pdf" file={file} setFile={setFile} icon={<FileText size={22} />} hint="PDF only · max 100 MB" />
                </div>

                <div className="admin-upload-panel">
                  <div className="admin-upload-panel-head">
                    <div>
                      <span className="admin-small-label">UPLOAD PIPELINE</span>
                      <strong>Files are verified before the book is published.</strong>
                    </div>
                    {uploadBusy && <span className="admin-live"><span /> Uploading</span>}
                  </div>
                  <UploadProgress item={uploadState.cover} label="Cover image" />
                  <UploadProgress item={uploadState.pdf} label="PDF document" />
                </div>

                <div className="admin-form-actions">
                  <button type="button" className="admin-secondary" onClick={() => setView("library")} disabled={uploadBusy}>Back to Library</button>
                  <button className="admin-primary" disabled={uploadBusy}>
                    <UploadCloud size={17} />
                    {uploadBusy ? "Publishing…" : "Upload & Publish"}
                  </button>
                </div>
              </form>
            </div>

            <aside className="admin-card admin-side-card">
              <span className="admin-header-kicker">PUBLISHING CHECKLIST</span>
              <h3>Before you hit publish</h3>
              <Checklist text="Use a clear title and category so readers can find the book." />
              <Checklist text="Paid books need a price greater than ₹0." />
              <Checklist text="The PDF and cover are stored in private R2 paths." />
              <Checklist text="Publishing makes the book immediately visible in the Store." />
              <div className="admin-side-note">
                <Clock3 size={17} />
                <span>Uploads can take time on slow connections. Keep this page open until verification finishes.</span>
              </div>
            </aside>
          </section>
        )}

        {view === "library" && (
          <section className="admin-page-grid">
            <div className="admin-card admin-library-card">
              <SectionHeading
                eyebrow="CATALOG LIBRARY"
                title={"All ebooks · " + books.length}
                subtitle="This is the single source of truth for what is published, drafted, priced and stored."
                action={<button className="admin-primary compact" onClick={() => setView("upload")}><Plus size={16} /> Upload Book</button>}
              />
              <div className="admin-library-toolbar">
                <div className="admin-search-wrap">
                  <Search size={17} />
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search title, author or category…" />
                </div>
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                  <option value="ALL">All statuses</option>
                  <option value="ACTIVE">Active</option>
                  <option value="DRAFT">Draft</option>
                </select>
                <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                  <option value="ALL">All access types</option>
                  <option value="PAID">Paid</option>
                  <option value="FREE">Free</option>
                </select>
              </div>

              <div className="admin-library-summary">
                <span>{filteredBooks.length} result{filteredBooks.length === 1 ? "" : "s"}</span>
                <span>{stats.active} active · {stats.draft} drafts</span>
              </div>

              {filteredBooks.length ? (
                <div className="admin-book-list">
                  {filteredBooks.map(book => (
                    <div className="admin-book-row" key={book.id}>
                      <div className="admin-book-thumb">
                        {book.coverUrl ? <img src={book.coverUrl} alt="" /> : <FileText size={22} />}
                      </div>
                      <div className="admin-book-info">
                        <strong>{book.title}</strong>
                        <span>{book.author || "MS Tech EBook"} · {book.category || "General"}</span>
                        <small>Added {formatDate(book.createdAt)}</small>
                      </div>
                      <div className="admin-book-badges">
                        <b className={book.type === "PAID" && Number(book.price || 0) > 0 ? "paid" : "free"}>
                          {book.type === "PAID" && Number(book.price || 0) > 0 ? formatMoney(book.price) : "FREE"}
                        </b>
                        <span className={String(book.status || "").toUpperCase() === "ACTIVE" ? "active" : "draft"}>
                          {String(book.status || "").toUpperCase() === "ACTIVE" ? "Active" : "Draft"}
                        </span>
                      </div>
                      <div className="admin-book-actions">
                        <Link to={"/books/" + book.id} className="admin-icon-action" title="Open customer view"><ExternalLink size={16} /></Link>
                        <button className="admin-icon-action" onClick={() => beginEdit(book)} title="Edit"><Pencil size={16} /></button>
                        <button className="admin-icon-action" onClick={() => toggleStatus(book)} title={book.status === "ACTIVE" ? "Unpublish" : "Publish"}>
                          {book.status === "ACTIVE" ? <PackageCheck size={16} /> : <CheckCircle2 size={16} />}
                        </button>
                        <button className="admin-icon-action danger" onClick={() => deleteBook(book)} title="Delete"><Trash2 size={16} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState icon={<LibraryIcon size={30} />} title="Nothing matches your filters" text={books.length ? "Clear the filters or search another title." : "Start by uploading your first ebook."} action={!books.length ? <button className="admin-primary" onClick={() => setView("upload")}><UploadCloud size={17} /> Upload first book</button> : null} />
              )}
            </div>
          </section>
        )}

        {view === "orders" && (
          <section className="admin-page-grid">
            <div className="admin-card">
              <SectionHeading eyebrow="SALES" title={"Orders · " + orders.length} subtitle="Payment records currently stored by the application." />
              {orders.length ? (
                <div className="admin-data-table-wrap">
                  <table className="admin-data-table">
                    <thead>
                      <tr><th>Order</th><th>Customer</th><th>Book</th><th>Amount</th><th>Status</th><th>Created</th></tr>
                    </thead>
                    <tbody>
                      {orders.map(order => (
                        <tr key={order.id}>
                          <td><strong>{order.razorpayOrderId || order.id}</strong></td>
                          <td><span>{order.userEmail || "—"}</span></td>
                          <td><span>{order.bookTitle || order.bookId || "—"}</span></td>
                          <td><strong>{formatMoney(order.amount)}</strong></td>
                          <td><b className={"admin-table-pill " + (order.status === "PAID" ? "good" : "neutral")}>{order.status || "—"}</b></td>
                          <td><span>{formatDate(order.createdAt)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState icon={<ShoppingBag size={30} />} title="No orders yet" text="Customer purchases will appear here when the payment flow creates an order." />
              )}
            </div>
          </section>
        )}

        {view === "users" && (
          <section className="admin-page-grid">
            <div className="admin-card">
              <SectionHeading eyebrow="CUSTOMERS" title={"Users · " + users.length} subtitle="Basic account visibility for operational support. Passwords and secret credentials are never shown." />
              {users.length ? (
                <div className="admin-data-table-wrap">
                  <table className="admin-data-table">
                    <thead>
                      <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th></tr>
                    </thead>
                    <tbody>
                      {users.map(person => (
                        <tr key={person.id}>
                          <td><strong>{person.name || "—"}</strong></td>
                          <td><span>{person.email || "—"}</span></td>
                          <td><span>{person.role || "user"}</span></td>
                          <td><b className={"admin-table-pill " + (person.status === "ACTIVE" ? "good" : "neutral")}>{person.status || "—"}</b></td>
                          <td><span>{formatDate(person.createdAt)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState icon={<Users size={30} />} title="No users found" text="Customer accounts will appear here after registration." />
              )}
            </div>
          </section>
        )}

        {view === "settings" && (
          <section className="admin-page-grid settings-page">
            <div className="admin-card">
              <SectionHeading eyebrow="OPERATIONS" title="Administrator settings" subtitle="Operational information for the current deployment. Secrets remain server-side." />
              <div className="admin-settings-list">
                <SettingRow icon={<PackageCheck size={18} />} label="Protected file storage" value="Cloudflare R2" />
                <SettingRow icon={<BookOpen size={18} />} label="Reader" value="Canvas-based protected viewer" />
                <SettingRow icon={<IndianRupee size={18} />} label="Currency" value="INR" />
                <SettingRow icon={<BarChart3 size={18} />} label="Catalog status" value={stats.active + " active / " + stats.draft + " draft"} />
              </div>
            </div>
            <div className="admin-card">
              <SectionHeading eyebrow="NAVIGATION" title="Never get trapped in Library" subtitle="The admin workspace uses real routes, so every section can return directly to every other section." />
              <div className="admin-settings-actions">
                <button className="admin-secondary" onClick={() => setView("dashboard")}><ArrowLeft size={16} /> Dashboard</button>
                <button className="admin-primary" onClick={() => setView("upload")}><UploadCloud size={16} /> Upload Book</button>
                <button className="admin-secondary" onClick={() => setView("library")}><LibraryIcon size={16} /> Library</button>
              </div>
            </div>
          </section>
        )}
      </section>

      {editing && (
        <div className="admin-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="admin-modal">
            <div className="admin-modal-head">
              <div>
                <span className="admin-header-kicker">EDIT CATALOG ENTRY</span>
                <h2>{editing.title}</h2>
              </div>
              <button className="admin-icon-button" onClick={() => setEditing(null)}><X size={18} /></button>
            </div>
            <form className="admin-pro-form" onSubmit={saveEdit}>
              <div className="admin-two-col">
                <Field label="Book title" required>
                  <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} required />
                </Field>
                <Field label="Author">
                  <input value={editing.author} onChange={e => setEditing({ ...editing, author: e.target.value })} />
                </Field>
              </div>
              <div className="admin-two-col">
                <Field label="Category">
                  <input value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })} />
                </Field>
                <Field label="Access type">
                  <select value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value })}>
                    <option value="PAID">Paid</option>
                    <option value="FREE">Free</option>
                  </select>
                </Field>
              </div>
              <Field label="Price (INR)">
                <input type="number" min="1" step="1" disabled={editing.type === "FREE"} required={editing.type === "PAID"} value={editing.type === "FREE" ? "" : editing.price} onChange={e => setEditing({ ...editing, price: e.target.value })} />
              </Field>
              <Field label="Description">
                <textarea rows={6} value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} />
              </Field>
              <Field label="Publishing status">
                <select value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value })}>
                  <option value="ACTIVE">Active</option>
                  <option value="DRAFT">Draft</option>
                </select>
              </Field>
              <div className="admin-form-actions">
                <button type="button" className="admin-secondary" onClick={() => setEditing(null)}>Cancel</button>
                <button className="admin-primary" disabled={editBusy}>{editBusy ? "Saving…" : "Save changes"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

function Field({ label, required, children }) {
  return (
    <label className="admin-field">
      <span>{label}{required ? " *" : ""}</span>
      {children}
    </label>
  );
}

function FileDrop({ label, accept, file, setFile, icon, hint }) {
  return (
    <label className={"admin-file-drop" + (file ? " has-file" : "")}>
      <div className="admin-file-icon">{icon}</div>
      <div>
        <strong>{label}{file ? " selected" : ""}</strong>
        <span>{file ? file.name : hint}</span>
      </div>
      <input type="file" accept={accept} required={!file} onChange={e => setFile(e.target.files?.[0] || null)} />
      <ChevronRight size={17} />
    </label>
  );
}

function UploadProgress({ item, label }) {
  return (
    <div className="admin-progress-row">
      <div className="admin-progress-head">
        <span>{label}</span>
        <b>{item.status === "done" ? "Verified" : item.progress ? item.progress + "%" : item.message}</b>
      </div>
      <div className="admin-progress-track"><div style={{ width: item.progress + "%" }} /></div>
      <small>{item.message}</small>
    </div>
  );
}

function Checklist({ text }) {
  return <div className="admin-check"><CheckCircle2 size={17} /><span>{text}</span></div>;
}

function SectionHeading({ eyebrow, title, subtitle, action }) {
  return (
    <div className="admin-section-heading">
      <div>
        {eyebrow && <span className="admin-header-kicker">{eyebrow}</span>}
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function StatCard({ label, value, icon, meta }) {
  return (
    <div className="admin-stat-card">
      <div className="admin-stat-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{meta}</small>
    </div>
  );
}

function HealthItem({ label, value, tone }) {
  return (
    <div className={"admin-health-item " + tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BookMiniList({ books, formatMoney }) {
  if (!books.length) {
    return <EmptyState icon={<BookOpen size={30} />} title="No books yet" text="Your first published title will appear here." />;
  }

  return (
    <div className="admin-mini-list">
      {books.map(book => (
        <div className="admin-mini-row" key={book.id}>
          <div className="admin-mini-thumb">{book.coverUrl ? <img src={book.coverUrl} alt="" /> : <FileText size={18} />}</div>
          <div>
            <strong>{book.title}</strong>
            <span>{book.author || "MS Tech EBook"}</span>
          </div>
          <div className="admin-mini-right">
            <b>{book.type === "PAID" && Number(book.price || 0) > 0 ? formatMoney(book.price) : "FREE"}</b>
            <span>{book.status === "ACTIVE" ? "Active" : "Draft"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingRow({ icon, label, value }) {
  return (
    <div className="admin-setting-row">
      <div className="admin-setting-icon">{icon}</div>
      <div><span>{label}</span><strong>{value}</strong></div>
    </div>
  );
}

function EmptyState({ icon, title, text, action }) {
  return (
    <div className="admin-empty">
      <div className="admin-empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

export default AdminPanel;
