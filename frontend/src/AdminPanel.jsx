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
  Ban,
  UserCheck,
  Receipt,
  TrendingUp,
  MessageSquare,
} from "lucide-react";
import { api, useAuth, compressCoverImage } from "./main";

const NAV = [
  { key: "dashboard", label: "Overview", icon: LayoutDashboard },
  { key: "upload", label: "Upload Book", icon: UploadCloud },
  { key: "library", label: "Library", icon: LibraryIcon },
  { key: "orders", label: "Orders", icon: ShoppingBag },
  { key: "complaints", label: "Complaints", icon: MessageSquare },
  { key: "users", label: "Users", icon: Users },
  { key: "staff", label: "Sub-admins & Review", icon: UserCheck },
  { key: "settings", label: "Settings", icon: Settings },
];

const emptyUploadState = {
  cover: { status: "idle", progress: 0, message: "Waiting" },
  pdf: { status: "idle", progress: 0, message: "Waiting" }
};

const emptyAnalytics = {
  overview: {
    totalUsers: 0, activeUsers: 0, blockedUsers: 0, adminUsers: 0,
    totalBooks: 0, activeBooks: 0, paidBooks: 0, freeBooks: 0,
    totalOrders: 0, paidOrders: 0, openOrders: 0, totalPurchases: 0,
    uniqueBuyers: 0, totalBuyAmount: 0, averageOrderValue: 0,
    todayRevenue: 0, last7DaysRevenue: 0, last30DaysRevenue: 0,
    paymentSuccessRate: 0
  },
  dailyRevenue: [],
  topBooks: [],
  recentOrders: []
};

function AdminPanel() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const segment = location.pathname.split("/").filter(Boolean)[1] || "dashboard";
  const view = NAV.some(item => item.key === segment) ? segment : "dashboard";

  const [books, setBooks] = useState([]);
  const [orders, setOrders] = useState([]);
  const [complaints, setComplaints] = useState([]);
  const [complaintFilter, setComplaintFilter] = useState("ALL");
  const [complaintQuery, setComplaintQuery] = useState("");
  const [complaintBusyId, setComplaintBusyId] = useState("");
  const [complaintNotes, setComplaintNotes] = useState({});
  const [users, setUsers] = useState([]);
  const [analytics, setAnalytics] = useState(emptyAnalytics);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [userQuery, setUserQuery] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState("ALL");
  const [notice, setNotice] = useState({ type: "", text: "" });
  const [subAdmins, setSubAdmins] = useState([]);
  const [newSubAdminId, setNewSubAdminId] = useState("");
  const [newSubAdminPassword, setNewSubAdminPassword] = useState("");
  const [newSubAdminName, setNewSubAdminName] = useState("Book Uploader");
  const [staffBusy, setStaffBusy] = useState(false);
  const [reviewNotes, setReviewNotes] = useState({});

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
    const target = next === "dashboard" ? "/admin" : "/admin/" + next;
    if (location.pathname !== target) navigate(target);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const goToUpload = () => setView("upload");

  const loadSubAdmins = async () => { const data = await api("/api/admin/subadmins"); setSubAdmins(Array.isArray(data.users) ? data.users : []); };

  const createSubAdmin = async event => {
    event.preventDefault(); setStaffBusy(true);
    try {
      const data = await api("/api/admin/subadmins", { method: "POST", body: JSON.stringify({ userId: newSubAdminId, password: newSubAdminPassword, name: newSubAdminName }) });
      setSubAdmins(current => [...current, { id: data.user.id, name: data.user.name, status: "ACTIVE" }]);
      setNewSubAdminId(""); setNewSubAdminPassword("");
      setNotice({type:"success",text:"Sub-admin account created. Share the credentials privately; only the main admin can change the password."});
    } catch(err) { setNotice({type:"error",text:err.message}); } finally { setStaffBusy(false); }
  };
  const editSubAdmin = async item => {
    const name = window.prompt("Edit display name for " + item.id, item.name || "");
    if (name === null) return;
    const password = window.prompt("Enter a new password to reset it, or leave blank to keep the current password. Minimum 10 characters with uppercase, lowercase and a number.");
    if (password === null) return;
    setStaffBusy(true);
    try {
      const body = { name: name.trim() };
      if (password.trim()) body.password = password;
      await api("/api/admin/subadmins/" + encodeURIComponent(item.id), { method: "PATCH", body: JSON.stringify(body) });
      await loadSubAdmins();
      setNotice({type:"success",text:"Sub-admin account updated. User ID remains unchanged."});
    } catch(err) { setNotice({type:"error",text:err.message}); } finally { setStaffBusy(false); }
  };
  const setSubAdminStatus = async (item, status) => {
    setStaffBusy(true);
    try {
      await api("/api/admin/subadmins/" + encodeURIComponent(item.id) + "/status", { method: "PATCH", body: JSON.stringify({ status }) });
      await loadSubAdmins();
      setNotice({type:"success",text:"Sub-admin " + (status === "BLOCKED" ? "blocked." : "unblocked.")});
    } catch(err) { setNotice({type:"error",text:err.message}); } finally { setStaffBusy(false); }
  };
  const deleteSubAdmin = async item => {
    if (!window.confirm("Delete sub-admin " + item.id + "? This cannot be undone.")) return;
    setStaffBusy(true);
    try {
      await api("/api/admin/subadmins/" + encodeURIComponent(item.id), { method: "DELETE" });
      setSubAdmins(current => current.filter(user => user.id !== item.id));
      setNotice({type:"success",text:"Sub-admin account deleted."});
    } catch(err) { setNotice({type:"error",text:err.message}); } finally { setStaffBusy(false); }
  };
  const reviewBook = async (book, decision) => {
    const note = String(reviewNotes[book.id] || "").trim();
    if (decision === "REJECT" && note.length < 5) { setNotice({type:"error",text:"Add a rejection reason of at least 5 characters."}); return; }
    setStaffBusy(true);
    try { await api("/api/admin/books/" + encodeURIComponent(book.id) + "/review", {method:"PATCH",body:JSON.stringify({decision,note})}); await loadBooks(); setNotice({type:"success",text:decision === "APPROVE" ? "Book approved and published to customers." : "Book rejected and kept unpublished."}); }
    catch(err) { setNotice({type:"error",text:err.message}); } finally { setStaffBusy(false); }
  };

  const loadBooks = async () => {
    const data = await api("/api/admin/books");
    setBooks(Array.isArray(data.books) ? data.books : []);
  };

  const loadOrders = async () => {
    try {
      const data = await api("/api/admin/orders?limit=1000");
      setOrders(Array.isArray(data.orders) ? data.orders : []);
    } catch {
      setOrders([]);
    }
  };

  const loadComplaints = async () => {
    try {
      const data = await api("/api/admin/complaints?limit=1000");
      setComplaints(Array.isArray(data.complaints) ? data.complaints : []);
    } catch (err) {
      if (err.status === 401 || err.status === 403) throw err;
      setComplaints([]);
      showNotice("error", err.message || "Complaints could not be loaded.");
    }
  };

  const loadUsers = async () => {
    try {
      const data = await api("/api/admin/users?limit=1000");
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch {
      setUsers([]);
    }
  };

  const loadAnalytics = async () => {
    try {
      const data = await api("/api/admin/analytics");
      setAnalytics({
        ...emptyAnalytics,
        ...data,
        overview: { ...emptyAnalytics.overview, ...(data?.overview || {}) },
        dailyRevenue: Array.isArray(data?.dailyRevenue) ? data.dailyRevenue : [],
        topBooks: Array.isArray(data?.topBooks) ? data.topBooks : [],
        recentOrders: Array.isArray(data?.recentOrders) ? data.recentOrders : []
      });
    } catch (err) {
      if (err.status === 401 || err.status === 403) throw err;
      setAnalytics(emptyAnalytics);
      showNotice("error", err.message || "Analytics could not be loaded.");
    }
  };

  const loadAll = async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      await Promise.all([loadBooks(), loadOrders(), loadComplaints(), loadUsers(), loadAnalytics(), loadSubAdmins()]);
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
    try { await api("/api/auth/logout?portal=admin", { method: "POST" }); } catch {}
    setUser(null);
    navigate("/admin", { replace: true });
  };

  useEffect(() => {
    if (!user || user.role !== "admin") {
      navigate("/admin", { replace: true });
      return;
    }
    if (user.mustChangePassword) {
      navigate("/change-password?portal=admin", { replace: true });
      return;
    }
    if (!initialized) loadAll();
  }, [user]);

  const updateComplaintStatus = async (complaint, status) => {
    const resolutionNote = String(complaintNotes[complaint.id] || complaint.resolutionNote || "").trim();
    if (["RESOLVED", "REFUND_ISSUED", "REJECTED"].includes(status) && resolutionNote.length < 5) {
      showNotice("error", "Add a resolution note of at least 5 characters before closing this complaint.");
      return;
    }
    setComplaintBusyId(complaint.id);
    try {
      await api("/api/admin/complaints/" + encodeURIComponent(complaint.id), {
        method: "PATCH",
        body: JSON.stringify({ status, resolutionNote })
      });
      setComplaints(current => current.map(item => item.id === complaint.id
        ? { ...item, status, resolutionNote, updatedAt: Date.now() }
        : item));
      showNotice("success", "Complaint updated to " + status.replaceAll("_", " ").toLowerCase() + ".");
    } catch (err) {
      showNotice("error", err.message || "Could not update complaint.");
    } finally {
      setComplaintBusyId("");
    }
  };

  const issueVerifiedRefund = async complaint => {
    const resolutionNote = String(complaintNotes[complaint.id] || complaint.resolutionNote || "").trim();
    if (resolutionNote.length < 5) { showNotice("error", "Add a review note explaining why this refund is approved."); return; }
    if (!complaint.paymentId && !window.confirm("No payment ID is saved on the complaint. Continue only if you have verified the correct Razorpay payment ID.")) return;
    const paymentId = complaint.paymentId || window.prompt("Enter the verified Razorpay payment ID (pay_…):");
    if (!paymentId) return;
    if (!window.confirm("This will submit a real refund request to Razorpay after payment verification. Continue?")) return;
    setComplaintBusyId(complaint.id);
    try {
      const result = await api("/api/admin/complaints/" + encodeURIComponent(complaint.id) + "/refund", { method: "POST", body: JSON.stringify({ paymentId, resolutionNote }) });
      setComplaints(current => current.map(item => item.id === complaint.id ? { ...item, status: "REFUND_ISSUED", refund: result.refund, resolutionNote, updatedAt: Date.now() } : item));
      showNotice("success", "Razorpay refund " + (result.refund?.id || "") + " submitted. Status: " + (result.refund?.status || "submitted") + ".");
    } catch(err) { showNotice("error", err.message || "Refund request failed."); }
    finally { setComplaintBusyId(""); }
  };

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
    let published = false;

    try {
      if (!cover || !file) throw new Error("Select both a cover image and the PDF before publishing.");
      if (file.type !== "application/pdf") throw new Error("The ebook file must be a PDF.");
      if (!["image/jpeg", "image/png", "image/webp"].includes(cover.type)) throw new Error("Cover must be JPG, PNG, or WEBP.");
      if (cover.size > 5 * 1024 * 1024) throw new Error("Cover image must be 5 MB or smaller before compression.");
      updateUploadState("cover", { status: "compressing", progress: 0, message: "Compressing cover to WebP..." });
      const coverResult = await compressCoverImage(cover);
      const coverFile = coverResult.file;
      updateUploadState("cover", { status: "preparing", progress: 0, message: coverResult.wasCompressed ? `Compressed ${(coverResult.originalSize / 1024).toFixed(0)} KB → ${(coverResult.compressedSize / 1024).toFixed(0)} KB (WebP).` : "Cover already optimized." });
      const coverPath = await uploadDirect(coverFile, "cover", "Cover image");
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

      published = true;
      resetUpload();
      await loadBooks();
      setView("library");
      showNotice("success", "Ebook published successfully. It is now active in the storefront.");
      if (result?.id) {
        setQuery("");
      }
    } catch (err) {
      if (published) {
        showNotice("error", "The ebook was published, but the admin library refresh failed. Refresh the admin workspace; the stored files were kept.");
      } else {
        for (const storagePath of uploadedPaths) {
          try {
            await api("/api/admin/upload-file", {
              method: "DELETE",
              body: JSON.stringify({ path: storagePath }),
            });
          } catch {}
        }
        showNotice("error", err.message || "Upload failed.");
      }
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
        body: JSON.stringify({
          ...book,
          status: nextStatus,
          type: book.type || "PAID",
          price: book.type === "FREE" ? 0 : Number(book.price || 0),
        }),
      });
      await loadBooks();
      showNotice("success", nextStatus === "ACTIVE" ? "Book published to the storefront." : "Book moved to draft.");
    } catch (err) {
      showNotice("error", err.message || "Could not change publishing status.");
    }
  };

  const toggleUserStatus = async person => {
    if (person.role === "admin") {
      showNotice("error", "Administrator accounts cannot be blocked from this panel.");
      return;
    }
    const nextStatus = String(person.status || "").toUpperCase() === "BLOCKED" ? "ACTIVE" : "BLOCKED";
    const action = nextStatus === "BLOCKED" ? "block" : "unblock";
    if (nextStatus === "BLOCKED" && !window.confirm('Block "' + (person.name || person.email) + '"? They will be signed out and cannot log in until unblocked.')) return;
    try {
      await api("/api/admin/users/" + person.id + "/status", {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus })
      });
      await Promise.all([loadUsers(), loadAnalytics()]);
      showNotice("success", (person.name || "User") + " was " + (action === "block" ? "blocked." : "unblocked."));
    } catch (err) {
      showNotice("error", err.message || "Could not update user status.");
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

  const filteredUsers = useMemo(() => {
    const q = userQuery.toLowerCase().trim();
    return users.filter(person => {
      const matchesQuery = !q || [person.name, person.email].filter(Boolean).join(" ").toLowerCase().includes(q);
      const normalizedStatus = String(person.status || "ACTIVE").toUpperCase();
      const matchesStatus = userStatusFilter === "ALL" || normalizedStatus === userStatusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [users, userQuery, userStatusFilter]);

  const analyticsOverview = analytics.overview || emptyAnalytics.overview;
  const dailyMax = Math.max(1, ...analytics.dailyRevenue.map(item => Number(item.amount || 0)));


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
                  {item.key === "upload" && <span className="admin-nav-arrow">→</span>}
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
            <section className="admin-command admin-dashboard-hero">
              <div>
                <span className="admin-header-kicker">BUSINESS INTELLIGENCE</span>
                <h2>Your ebook business, measured in real numbers.</h2>
                <p>Track customers, paid sales, revenue, catalogue performance and account activity from the administrator dashboard.</p>
                <div className="admin-command-actions">
                  <button className="admin-primary" onClick={() => setView("upload")}><UploadCloud size={17} /> Upload a Book</button>
                  <button className="admin-secondary" onClick={() => setView("users")}><Users size={17} /> View Users</button>
                  <button className="admin-secondary" onClick={() => setView("orders")}><Receipt size={17} /> Payment Ledger</button>
                </div>
              </div>
              <div className="admin-command-orb admin-revenue-orb">
                <TrendingUp size={58} strokeWidth={1.5} />
                <span>{formatMoney(analyticsOverview.totalBuyAmount)}</span>
                <small>Total buy amount</small>
              </div>
            </section>

            <section className="admin-stat-grid admin-kpi-grid">
              <StatCard label="Total users" value={analyticsOverview.totalUsers} icon={<Users size={19} />} meta={analyticsOverview.activeUsers + " active · " + analyticsOverview.blockedUsers + " blocked"} />
              <StatCard label="Total buy amount" value={formatMoney(analyticsOverview.totalBuyAmount)} icon={<IndianRupee size={19} />} meta={analyticsOverview.paidOrders + " successful payments"} />
              <StatCard label="Total orders" value={analyticsOverview.totalOrders} icon={<ShoppingBag size={19} />} meta={analyticsOverview.openOrders + " unpaid / open"} />
              <StatCard label="Unique buyers" value={analyticsOverview.uniqueBuyers} icon={<UserCheck size={19} />} meta={analyticsOverview.totalPurchases + " paid purchases"} />
              <StatCard label="Today" value={formatMoney(analyticsOverview.todayRevenue)} icon={<TrendingUp size={19} />} meta="Revenue today" />
              <StatCard label="Last 7 days" value={formatMoney(analyticsOverview.last7DaysRevenue)} icon={<BarChart3 size={19} />} meta="Rolling revenue" />
              <StatCard label="Last 30 days" value={formatMoney(analyticsOverview.last30DaysRevenue)} icon={<BarChart3 size={19} />} meta="Rolling revenue" />
              <StatCard label="Average order" value={formatMoney(analyticsOverview.averageOrderValue)} icon={<IndianRupee size={19} />} meta={analyticsOverview.paymentSuccessRate.toFixed(1) + "% payment success"} />
            </section>

            <section className="admin-dashboard-grid admin-analysis-grid">
              <div className="admin-card">
                <SectionHeading eyebrow="REVENUE TREND" title="Last 7 days" subtitle="Captured Razorpay orders grouped by day." />
                <div className="admin-revenue-chart">
                  {analytics.dailyRevenue.map(item => (
                    <div className="admin-revenue-day" key={item.date}>
                      <div className="admin-revenue-bar-track"><div style={{ height: Math.max(4, Math.round((Number(item.amount || 0) / dailyMax) * 100)) + "%" }} /></div>
                      <strong>{formatMoney(item.amount)}</strong>
                      <span>{item.date}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="admin-card">
                <SectionHeading eyebrow="STORE HEALTH" title="Catalog & accounts" />
                <div className="admin-health-grid">
                  <HealthItem label="Active books" value={analyticsOverview.activeBooks} tone="good" />
                  <HealthItem label="Draft books" value={Math.max(0, analyticsOverview.totalBooks - analyticsOverview.activeBooks)} tone="neutral" />
                  <HealthItem label="Paid catalog" value={analyticsOverview.paidBooks} tone="accent" />
                  <HealthItem label="Free catalog" value={analyticsOverview.freeBooks} tone="neutral" />
                  <HealthItem label="Active users" value={analyticsOverview.activeUsers} tone="good" />
                  <HealthItem label="Blocked users" value={analyticsOverview.blockedUsers} tone="neutral" />
                </div>
              </div>
            </section>

            <section className="admin-dashboard-grid admin-analysis-grid">
              <div className="admin-card">
                <SectionHeading
                  eyebrow="TOP PERFORMERS"
                  title="Best-selling books"
                  action={<button className="admin-text-action" onClick={() => setView("orders")}>Payment ledger <ChevronRight size={15} /></button>}
                />
                {analytics.topBooks.length ? (
                  <div className="admin-ranking-list">
                    {analytics.topBooks.map((item, index) => (
                      <div className="admin-ranking-row" key={item.bookId}>
                        <b>{index + 1}</b>
                        <div><strong>{item.title}</strong><span>{item.sales} sale{item.sales === 1 ? "" : "s"}</span></div>
                        <strong>{formatMoney(item.revenue)}</strong>
                      </div>
                    ))}
                  </div>
                ) : <EmptyState icon={<BookOpen size={30} />} title="No paid sales yet" text="Successful purchases will automatically appear here." />}
              </div>

              <div className="admin-card">
                <SectionHeading
                  eyebrow="RECENT PAYMENTS"
                  title="Latest successful purchases"
                  action={<button className="admin-text-action" onClick={() => setView("orders")}>View all <ChevronRight size={15} /></button>}
                />
                {analytics.recentOrders.length ? (
                  <div className="admin-recent-payment-list">
                    {analytics.recentOrders.slice(0, 5).map(order => (
                      <div className="admin-recent-payment" key={order.id}>
                        <div className="admin-payment-avatar">{String(order.userName || "C").charAt(0).toUpperCase()}</div>
                        <div><strong>{order.userName}</strong><span>{order.bookTitle} · {formatDate(order.createdAt)}</span></div>
                        <b>{formatMoney(order.amount)}</b>
                      </div>
                    ))}
                  </div>
                ) : <EmptyState icon={<Receipt size={30} />} title="No successful payments" text="Completed payments will be shown here." />}
              </div>
            </section>

            <section className="admin-card admin-admin-actions-card">
              <SectionHeading eyebrow="USER CONTROL" title="Account moderation" subtitle="Block a customer immediately or restore access. Blocking revokes their active sessions." />
              <div className="admin-control-summary">
                <div><span>Registered customers</span><strong>{analyticsOverview.totalUsers}</strong></div>
                <div><span>Active</span><strong>{analyticsOverview.activeUsers}</strong></div>
                <div><span>Blocked</span><strong>{analyticsOverview.blockedUsers}</strong></div>
                <button className="admin-primary" onClick={() => setView("users")}><Users size={16} /> Manage Users</button>
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
                  <button type="button" className="admin-secondary" onClick={() => setView("library")} disabled={uploadBusy}><ArrowLeft size={15} /> Back to Library</button>
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
                subtitle="Manage every title, price and publishing state from one place."
                action={
                  <div className="admin-library-actions">
                    <button className="admin-secondary compact" onClick={() => setView("dashboard")}><ArrowLeft size={15} /> Dashboard</button>
                    <button className="admin-primary compact" onClick={goToUpload}><Plus size={16} /> Upload Book</button>
                  </div>
                }
              />
              <div className="admin-library-quickbar">
                <div>
                  <strong>Ready to publish?</strong>
                  <span>Upload a new PDF and cover without leaving the admin workspace.</span>
                </div>
                <button className="admin-secondary compact" onClick={goToUpload}><UploadCloud size={15} /> Open upload workspace</button>
              </div>
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
              <SectionHeading eyebrow="PAYMENT LEDGER" title={"All payment details · " + orders.length} subtitle={"Successful revenue: " + formatMoney(analyticsOverview.totalBuyAmount) + " · Average paid order: " + formatMoney(analyticsOverview.averageOrderValue)} />
              {orders.length ? (
                <div className="admin-data-table-wrap">
                  <table className="admin-data-table admin-payment-table">
                    <thead>
                      <tr><th>Order ID</th><th>Payment ID</th><th>Customer</th><th>Book</th><th>Amount</th><th>Status</th><th>Date</th></tr>
                    </thead>
                    <tbody>
                      {orders.map(order => (
                        <tr key={order.id}>
                          <td><strong>{order.razorpayOrderId || order.id}</strong></td>
                          <td><span>{order.paymentId || "—"}</span></td>
                          <td><span>{order.userEmail || "—"}</span></td>
                          <td><span>{order.bookTitle || order.bookId || "—"}</span></td>
                          <td><strong>{formatMoney(order.amount)}</strong></td>
                          <td><b className={"admin-table-pill " + (String(order.status || "").toUpperCase() === "PAID" ? "good" : "neutral")}>{order.status || "—"}</b></td>
                          <td><span>{formatDate(order.createdAt)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState icon={<ShoppingBag size={30} />} title="No orders yet" text="Customer payment orders will appear here when checkout is started." />
              )}
            </div>
          </section>
        )}

        {view === "complaints" && (
          <section className="admin-page-grid">
            <div className="admin-card">
              <SectionHeading
                eyebrow="CUSTOMER SUPPORT"
                title={"Customer complaints · " + complaints.length}
                subtitle="Review each complaint. Refunds are only submitted to Razorpay after you explicitly approve them here and the API verifies the captured payment."
              />
              <div className="admin-user-toolbar">
                <div className="admin-search-wrap">
                  <Search size={17} />
                  <input value={complaintQuery} onChange={e => setComplaintQuery(e.target.value)} placeholder="Search complaint, email, book, order or payment ID…" />
                </div>
                <select value={complaintFilter} onChange={e => setComplaintFilter(e.target.value)}>
                  <option value="ALL">All statuses</option>
                  <option value="OPEN">Open</option>
                  <option value="UNDER_REVIEW">Under review</option>
                  <option value="RESOLVED">Resolved</option>
                  <option value="REFUND_ISSUED">Refund issued</option>
                  <option value="REJECTED">Rejected</option>
                </select>
              </div>
              {(() => {
                const q = complaintQuery.trim().toLowerCase();
                const filtered = complaints.filter(item =>
                  (complaintFilter === "ALL" || item.status === complaintFilter) &&
                  (!q || [item.id, item.userName, item.userEmail, item.category, item.message, item.bookId, item.orderId, item.paymentId].some(value => String(value || "").toLowerCase().includes(q)))
                );
                if (!filtered.length) {
                  return <EmptyState icon={<MessageSquare size={30} />} title="No complaints found" text={complaints.length ? "Try another search or status filter." : "New customer complaints will appear here when submitted."} />;
                }
                return (
                  <div className="admin-complaint-list">
                    {filtered.map(item => (
                      <article className="admin-complaint-card" key={item.id}>
                        <div className="admin-complaint-head">
                          <div>
                            <span className="admin-header-kicker">{String(item.category || "OTHER").replaceAll("_", " ")}</span>
                            <h3>{item.userName || "Customer"} <span>· {item.userEmail || "No email"}</span></h3>
                            <p>Complaint ID: <strong>{item.id}</strong> · {formatDate(item.createdAt)}</p>
                          </div>
                          <b className={"admin-table-pill " + (["RESOLVED", "REFUND_ISSUED"].includes(item.status) ? "good" : item.status === "REJECTED" ? "blocked" : "neutral")}>{String(item.status || "OPEN").replaceAll("_", " ")}</b>
                        </div>
                        <p className="admin-complaint-message">{item.message || "No message supplied."}</p>
                        <div className="admin-complaint-meta">
                          <span><strong>Book:</strong> {item.bookId || "—"}</span>
                          <span><strong>Order:</strong> {item.orderId || "—"}</span>
                          <span><strong>Payment:</strong> {item.paymentId || "—"}</span>
                          <span><strong>Email alert:</strong> {item.emailNotificationStatus || "UNKNOWN"}</span>
                        </div>
                        <label className="admin-field admin-complaint-note">
                          <span>Resolution / review note {["RESOLVED", "REFUND_ISSUED", "REJECTED"].includes(item.status) ? "" : "(required before closing)"}</span>
                          <textarea rows={2} maxLength={1000} value={complaintNotes[item.id] ?? item.resolutionNote ?? ""} onChange={e => setComplaintNotes(current => ({ ...current, [item.id]: e.target.value }))} placeholder="Record what was checked, access restored, or refund reference…" />
                        </label>
                        <div className="admin-complaint-actions">
                          <button className="admin-secondary" disabled={complaintBusyId === item.id || item.status === "UNDER_REVIEW"} onClick={() => updateComplaintStatus(item, "UNDER_REVIEW")}>{complaintBusyId === item.id ? "Saving…" : "Mark under review"}</button>
                          <button className="admin-secondary" disabled={complaintBusyId === item.id || item.status === "RESOLVED"} onClick={() => updateComplaintStatus(item, "RESOLVED")}>Mark resolved</button>
                          <button className="admin-primary" disabled={complaintBusyId === item.id || item.status === "REFUND_ISSUED" || Boolean(item.refund?.id)} onClick={() => issueVerifiedRefund(item)}>{complaintBusyId === item.id ? "Verifying…" : "Verify & issue refund"}</button>
                          <button className="admin-user-action block" disabled={complaintBusyId === item.id || item.status === "REJECTED"} onClick={() => updateComplaintStatus(item, "REJECTED")}>Reject</button>
                          {item.userEmail && <a className="admin-complaint-email" href={"mailto:" + encodeURIComponent(item.userEmail) + "?subject=" + encodeURIComponent("MS Tech EBook complaint " + item.id)}>Email customer</a>}
                        </div>
                        {item.resolvedBy && <p className="admin-complaint-resolution">Last handled by {item.resolvedBy}{item.resolvedAt ? " · " + formatDate(item.resolvedAt) : ""}</p>}
                      </article>
                    ))}
                  </div>
                );
              })()}
            </div>
          </section>
        )}

        {view === "users" && (
          <section className="admin-page-grid">
            <div className="admin-card">
              <SectionHeading eyebrow="CUSTOMER CONTROL" title={"All users · " + users.length} subtitle="Search every customer, inspect purchase totals, and block or restore access." />
              <div className="admin-user-toolbar">
                <div className="admin-search-wrap">
                  <Search size={17} />
                  <input value={userQuery} onChange={e => setUserQuery(e.target.value)} placeholder="Search name or email…" />
                </div>
                <select value={userStatusFilter} onChange={e => setUserStatusFilter(e.target.value)}>
                  <option value="ALL">All users</option>
                  <option value="ACTIVE">Active</option>
                  <option value="BLOCKED">Blocked</option>
                </select>
              </div>
              {filteredUsers.length ? (
                <div className="admin-data-table-wrap">
                  <table className="admin-data-table admin-users-table">
                    <thead>
                      <tr><th>User</th><th>Email</th><th>Status</th><th>Purchases</th><th>Total spent</th><th>Last login</th><th>Created</th><th>Control</th></tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map(person => {
                        const blocked = String(person.status || "").toUpperCase() === "BLOCKED";
                        return (
                          <tr key={person.id}>
                            <td><strong>{person.name || "—"}</strong></td>
                            <td><span>{person.email || "—"}</span></td>
                            <td><b className={"admin-table-pill " + (blocked ? "blocked" : "good")}>{blocked ? "BLOCKED" : "ACTIVE"}</b></td>
                            <td><span>{Number(person.purchases || 0)}</span></td>
                            <td><strong>{formatMoney(person.spent)}</strong></td>
                            <td><span>{person.lastLoginAt ? formatDate(person.lastLoginAt) : "Never"}</span></td>
                            <td><span>{formatDate(person.createdAt)}</span></td>
                            <td>
                              {person.role === "admin" ? (
                                <span className="admin-protected-user"><UserCheck size={14} /> Admin</span>
                              ) : (
                                <button className={"admin-user-action " + (blocked ? "restore" : "block")} onClick={() => toggleUserStatus(person)}>
                                  {blocked ? <UserCheck size={14} /> : <Ban size={14} />}
                                  {blocked ? "Unblock" : "Block"}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState icon={<Users size={30} />} title="No users match" text="Change the search or status filter." />
              )}
            </div>
          </section>
        )}

        {view === "staff" && (
          <section className="admin-page-grid">
            <div className="admin-card">
              <SectionHeading eyebrow="STAFF ACCESS" title="Generate sub-admin credentials" subtitle="Sub-admins cannot register themselves and can only upload books for review." />
              <form onSubmit={createSubAdmin} style={{display:"grid",gap:12,maxWidth:560}}>
                <label>Display name<input value={newSubAdminName} onChange={e=>setNewSubAdminName(e.target.value)} maxLength={120} required /></label>
                <label>User ID<input value={newSubAdminId} onChange={e=>setNewSubAdminId(e.target.value)} pattern="[A-Za-z0-9_-]{3,64}" placeholder="book_uploader01" required /></label>
                <label>Password<input type="password" autoComplete="new-password" value={newSubAdminPassword} onChange={e=>setNewSubAdminPassword(e.target.value)} minLength={10} placeholder="10+ chars, upper/lower/number" required /></label>
                <button className="admin-primary" disabled={staffBusy}>Generate sub-admin login</button>
              </form>
              <h3 style={{marginTop:24}}>Existing sub-admin accounts</h3>
              {subAdmins.length ? <div className="admin-table-wrap"><table><thead><tr><th>User ID (fixed)</th><th>Name</th><th>Status</th><th>Controls</th></tr></thead><tbody>{subAdmins.map(item=><tr key={item.id}><td>{item.id}</td><td>{item.name}</td><td>{item.status}</td><td style={{display:"flex",gap:6,flexWrap:"wrap"}}><button type="button" className="admin-secondary" disabled={staffBusy} onClick={()=>editSubAdmin(item)}>Edit / Reset password</button><button type="button" className={ "admin-user-action " + (item.status==="BLOCKED"?"restore":"block")} disabled={staffBusy} onClick={()=>setSubAdminStatus(item,item.status==="BLOCKED"?"ACTIVE":"BLOCKED")}>{item.status==="BLOCKED"?"Unblock":"Block"}</button><button type="button" className="admin-user-action block" disabled={staffBusy} onClick={()=>deleteSubAdmin(item)}>Delete</button></td></tr>)}</tbody></table></div> : <p>No sub-admin accounts created yet.</p>}
              {notice.text && <p className={notice.type==="error"?"error":"success"}>{notice.text}</p>}}
            </div>
            <div className="admin-card">
              <SectionHeading eyebrow="PUBLISHING GATE" title="Books awaiting review" subtitle="Only the main administrator can publish sub-admin submissions." />
              {books.filter(book=>book.status==="PENDING_REVIEW").length ? books.filter(book=>book.status==="PENDING_REVIEW").map(book=><article key={book.id} style={{borderBottom:"1px solid var(--border,#ddd)",padding:"16px 0"}}>
                <h3>{book.title}</h3><p>{book.author || "Unknown author"} · {book.category || "Uncategorized"} · {book.type==="FREE"?"Free":formatMoney(book.price)}</p>
                <textarea placeholder="Review note (required for rejection)" value={reviewNotes[book.id]||""} onChange={e=>setReviewNotes(v=>({...v,[book.id]:e.target.value}))} rows={2} />
                <div style={{display:"flex",gap:8,marginTop:8}}><button className="admin-primary" disabled={staffBusy} onClick={()=>reviewBook(book,"APPROVE")}>Approve & publish</button><button className="admin-secondary" disabled={staffBusy} onClick={()=>reviewBook(book,"REJECT")}>Reject</button></div>
              </article>) : <p>No books are awaiting review.</p>}
              {notice.text && <p className={notice.type==="error"?"error":"success"}>{notice.text}</p>}
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
