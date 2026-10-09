import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useAuth } from "./main";
import { BookOpen, FileText, ChevronRight, CheckCircle2, UploadCloud } from "lucide-react";

export function SAdminLogin() {
  const { user, setUser } = useAuth();
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  useEffect(() => { if (user?.role === "sadmin") navigate("/sadmin", { replace: true }); }, [user, navigate]);
  async function submit(e) {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: userId, password, portal: "sadmin" }) });
      if (data.user?.role !== "sadmin") throw new Error("Sub-admin credentials required.");
      setUser(data.user);
      navigate("/sadmin");
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <main className="auth"><form onSubmit={submit}>
    <span className="auth-kicker">STAFF ACCESS</span><h1>Book Uploader Login</h1>
    <p>Sign in with the fixed user ID and password provided by the main administrator. Only the main administrator can change your credentials. Registration is disabled.</p>
    <input autoComplete="username" placeholder="Sub-admin user ID" value={userId} onChange={e=>setUserId(e.target.value)} required />
    <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required />
    {error && <p className="error">{error}</p>}
    <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    <p><Link to="/books">Return to store</Link></p>
  </form></main>;
}

export default function SAdmin() {
  const { user, setUser } = useAuth();
  const [books, setBooks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("PAID");
  const [price, setPrice] = useState("49");
  const [cover, setCover] = useState(null);
  const [pdf, setPdf] = useState(null);
  const [uploadProgress, setUploadProgress] = useState({ cover: 0, pdf: 0, stage: "" });
  const navigate = useNavigate();
  async function load() { const d=await api("/api/sadmin/books"); setBooks(Array.isArray(d.books)?d.books:[]); }
  useEffect(()=>{ if(user?.role!=="sadmin") { navigate("/sadmin",{replace:true}); return; } load().catch(e=>setError(e.message)); },[user]);
  async function upload(file, kind, progressKey) {
    const p=await api("/api/sadmin/upload-url",{method:"POST",body:JSON.stringify({name:file.name,type:file.type,size:file.size})});
    await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open("PUT",p.url);
      xhr.setRequestHeader("Content-Type",file.type);
      xhr.upload.onprogress=event=>{
        if(event.lengthComputable) setUploadProgress(current=>({...current,[progressKey]:Math.min(100,Math.round(event.loaded/event.total*100)),stage:kind}));
      };
      xhr.onload=()=>{ if(xhr.status>=200&&xhr.status<300){setUploadProgress(current=>({...current,[progressKey]:100,stage:kind}));resolve();}else reject(new Error(kind+" upload failed (HTTP "+xhr.status+").")); };
      xhr.onerror=()=>reject(new Error(kind+" upload failed due to a network error."));
      xhr.onabort=()=>reject(new Error(kind+" upload was cancelled."));
      xhr.send(file);
    });
    const verify=await api("/api/sadmin/upload-status?path="+encodeURIComponent(p.path));
    if(!verify.uploaded || Number(verify.size)!==file.size || String(verify.contentType).toLowerCase()!==file.type.toLowerCase()) throw new Error(kind+" upload could not be verified.");
    return p.path;
  }
  async function submit(e) {
    e.preventDefault(); setError(""); setNotice("");
    if(!cover || !pdf) return setError("Choose both a cover image and a PDF.");
    if(pdf.type!=="application/pdf" || !["image/jpeg","image/png","image/webp"].includes(cover.type)) return setError("Use a PDF file and JPG, PNG, or WEBP cover.");
    setBusy(true); setUploadProgress({cover:0,pdf:0,stage:"Preparing upload"});
    try {
      const coverPath=await upload(cover,"Cover","cover");
      const storagePath=await upload(pdf,"PDF","pdf");
      setUploadProgress(current=>({...current,stage:"Submitting book details"}));
      await api("/api/sadmin/books",{method:"POST",body:JSON.stringify({title,author,category,description,type,price:type==="FREE"?0:Number(price),coverPath,storagePath,storageProvider:"r2"})});
      setNotice("Book submitted for main-admin review. It is not public yet.");
      setTitle("");setAuthor("");setCategory("");setDescription("");setType("PAID");setPrice("49");setCover(null);setPdf(null);
      e.target.reset(); await load();
    } catch(err) { setError(err.message || "Could not submit book."); } finally { setBusy(false); setUploadProgress(current=>({...current,stage:""})); }
  }
  async function logout() { try { await api("/api/auth/logout?portal=sadmin",{method:"POST"}); } catch {} setUser(null); navigate("/sadmin",{replace:true}); }
  return <main className="container sadmin-workspace">
    <header className="sadmin-topbar">
      <div><span className="auth-kicker">SUB-ADMIN WORKSPACE</span><h1>Book Uploads</h1><p>Signed in as {user?.name || user?.id}. Submit books for the main administrator to review.</p></div>
      <button className="sadmin-logout" onClick={logout}>Log out</button>
    </header>
    <section className="sadmin-upload-card">
      <div className="sadmin-section-heading"><div><span className="auth-kicker">STAFF ACCESS</span><h2>Upload a new book</h2><p>Complete the book information and add a cover image and PDF. Books stay private until approved.</p></div></div>
      <form onSubmit={submit} className="sadmin-upload-form">
        <div className="sadmin-form-divider"/>
        <div className="sadmin-subheading">Book information</div>
        <div className="sadmin-fields-grid">
          <label className="sadmin-field"><span>Book title *</span><input placeholder="e.g. Database Management System" value={title} onChange={e=>setTitle(e.target.value)} maxLength={200} required/></label>
          <label className="sadmin-field"><span>Author</span><input placeholder="Author name" value={author} onChange={e=>setAuthor(e.target.value)} maxLength={120}/></label>
          <label className="sadmin-field"><span>Category</span><input placeholder="Technology, Engineering..." value={category} onChange={e=>setCategory(e.target.value)} maxLength={80}/></label>
          <label className="sadmin-field"><span>Access type</span><select value={type} onChange={e=>setType(e.target.value)}><option value="PAID">Paid ebook</option><option value="FREE">Free ebook</option></select></label>
          {type==="PAID" && <label className="sadmin-field sadmin-full"><span>Price (INR) · required</span><input type="number" min="1" max="100000" step="1" placeholder="49" value={price} onChange={e=>setPrice(e.target.value)} required/></label>}
          <label className="sadmin-field sadmin-full"><span>Description</span><textarea placeholder="Explain what the reader will learn or get from this ebook." value={description} onChange={e=>setDescription(e.target.value)} maxLength={5000} rows={5}/></label>
        </div>
        <div className="sadmin-form-divider"/>
        <div className="sadmin-subheading">Protected files</div>
        <div className="sadmin-file-grid">
          <label className={"sadmin-file-card "+(cover?"has-file":"")}>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setCover(e.target.files?.[0]||null)} required/>
            <span className="sadmin-file-icon"><BookOpen size={26}/></span>
            <span className="sadmin-file-copy"><strong>Cover image</strong><small>{cover?cover.name:"JPG, PNG or WEBP · max 10 MB"}</small>{cover&&<small>{(cover.size/1024/1024).toFixed(2)} MB selected</small>}</span>
            {cover?<CheckCircle2 className="sadmin-file-arrow" size={20}/>:<ChevronRight className="sadmin-file-arrow" size={20}/>}
          </label>
          <label className={"sadmin-file-card "+(pdf?"has-file":"")}>
            <input type="file" accept="application/pdf,.pdf" onChange={e=>setPdf(e.target.files?.[0]||null)} required/>
            <span className="sadmin-file-icon"><FileText size={26}/></span>
            <span className="sadmin-file-copy"><strong>PDF document</strong><small>{pdf?pdf.name:"PDF only · max 100 MB"}</small>{pdf&&<small>{(pdf.size/1024/1024).toFixed(2)} MB selected</small>}</span>
            {pdf?<CheckCircle2 className="sadmin-file-arrow" size={20}/>:<ChevronRight className="sadmin-file-arrow" size={20}/>}
          </label>
        </div>
        {busy && <div className="sadmin-progress-panel" aria-live="polite">
          <div className="sadmin-progress-heading"><strong><UploadCloud size={17}/> Upload progress</strong><span>{uploadProgress.stage||"Working…"}</span></div>
          {[{key:"cover",label:"Cover image",file:cover},{key:"pdf",label:"PDF document",file:pdf}].map(item=><div className="sadmin-progress-item" key={item.key}>
            <div className="sadmin-progress-label"><span>{item.label}{uploadProgress.stage===item.label&&uploadProgress[item.key]<100?" · uploading":""}</span><b>{uploadProgress[item.key]}%</b></div>
            <div className="sadmin-progress-track"><div style={{width:uploadProgress[item.key]+"%"}}/></div>
            {item.file&&<small>{item.file.name}</small>}
          </div>)}
        </div>}
        {error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
        <button className="primary sadmin-submit" disabled={busy}>{busy?"Uploading and submitting…":"Submit book for review"}</button>
      </form>
    </section>
    <section className="sadmin-catalogue"><div className="sadmin-catalogue-heading"><div><span className="auth-kicker">YOUR WORK</span><h2>Catalogue and review status</h2></div><button type="button" onClick={()=>load().catch(e=>setError(e.message))}>Refresh</button></div>
      {error && !books.length && <p className="error">{error}</p>}
      {!books.length ? <p className="sadmin-empty">No books found yet.</p> : <div className="sadmin-book-grid">
        {books.map(b=><article className="sadmin-book-card" key={b.id}>
          {b.coverUrl ? <img src={b.coverUrl} alt={b.title+" cover"}/> : <div className="sadmin-book-placeholder"><BookOpen size={30}/></div>}
          <div className="sadmin-book-info"><h3>{b.title}</h3><p>{b.author||"Unknown author"}</p><span className="sadmin-status">{String(b.status||"").replaceAll("_"," ")}</span><strong>{b.type==="FREE"?"Free":"₹"+Number(b.price||0)}</strong></div>
        </article>)}
      </div>}
    </section>
  </main>;
}
