import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useAuth } from "./main";

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
  const navigate = useNavigate();
  async function load() { const d=await api("/api/sadmin/books"); setBooks(Array.isArray(d.books)?d.books:[]); }
  useEffect(()=>{ if(user?.role!=="sadmin") { navigate("/sadmin",{replace:true}); return; } load().catch(e=>setError(e.message)); },[user]);
  async function upload(file, kind) {
    const p=await api("/api/sadmin/upload-url",{method:"POST",body:JSON.stringify({name:file.name,type:file.type,size:file.size})});
    const response=await fetch(p.url,{method:"PUT",headers:{"Content-Type":file.type},body:file});
    if(!response.ok) throw new Error(kind+" upload failed (HTTP "+response.status+").");
    const verify=await api("/api/sadmin/upload-status?path="+encodeURIComponent(p.path));
    if(!verify.uploaded || Number(verify.size)!==file.size || String(verify.contentType).toLowerCase()!==file.type.toLowerCase()) throw new Error(kind+" upload could not be verified.");
    return p.path;
  }
  async function submit(e) {
    e.preventDefault(); setError(""); setNotice("");
    if(!cover || !pdf) return setError("Choose both a cover image and a PDF.");
    if(pdf.type!=="application/pdf" || !["image/jpeg","image/png","image/webp"].includes(cover.type)) return setError("Use a PDF file and JPG, PNG, or WEBP cover.");
    setBusy(true);
    try {
      const coverPath=await upload(cover,"Cover");
      const storagePath=await upload(pdf,"PDF");
      await api("/api/sadmin/books",{method:"POST",body:JSON.stringify({title,author,category,description,type,price:type==="FREE"?0:Number(price),coverPath,storagePath,storageProvider:"r2"})});
      setNotice("Book submitted for main-admin review. It is not public yet.");
      setTitle("");setAuthor("");setCategory("");setDescription("");setType("PAID");setPrice("49");setCover(null);setPdf(null);
      e.target.reset(); await load();
    } catch(err) { setError(err.message || "Could not submit book."); } finally { setBusy(false); }
  }
  async function logout() { try { await api("/api/auth/logout?portal=sadmin",{method:"POST"}); } catch {} setUser(null); navigate("/sadmin",{replace:true}); }
  return <main className="container" style={{maxWidth:1100}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:16,flexWrap:"wrap"}}>
      <div><span className="auth-kicker">SUB-ADMIN WORKSPACE</span><h1>Book Uploads</h1><p>Signed in as {user?.name || user?.id}. You can view the catalogue and submit books for review.</p></div>
      <button onClick={logout}>Log out</button>
    </div>
    <section className="policy-card" style={{margin:"24px 0"}}>
      <h2>Submit a book</h2><p>Uploaded books remain private until the main administrator approves them.</p>
      <form onSubmit={submit} style={{display:"grid",gap:12}}>
        <input placeholder="Book title" value={title} onChange={e=>setTitle(e.target.value)} maxLength={200} required/>
        <input placeholder="Author" value={author} onChange={e=>setAuthor(e.target.value)} maxLength={120}/>
        <input placeholder="Category" value={category} onChange={e=>setCategory(e.target.value)} maxLength={80}/>
        <textarea placeholder="Description" value={description} onChange={e=>setDescription(e.target.value)} maxLength={5000} rows={4}/>
        <label>Book type <select value={type} onChange={e=>setType(e.target.value)}><option value="PAID">Paid</option><option value="FREE">Free</option></select></label>
        {type==="PAID" && <input type="number" min="1" max="100000" step="1" placeholder="Price in INR" value={price} onChange={e=>setPrice(e.target.value)} required/>}
        <label>Cover image (JPG, PNG, WEBP)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setCover(e.target.files?.[0]||null)} required/></label>
        <label>Book PDF<input type="file" accept="application/pdf,.pdf" onChange={e=>setPdf(e.target.files?.[0]||null)} required/></label>
        {error && <p className="error">{error}</p>}{notice && <p className="success">{notice}</p>}
        <button className="primary" disabled={busy}>{busy?"Uploading and submitting…":"Submit for review"}</button>
      </form>
    </section>
    <section><h2>Catalogue and review status</h2>
      {error && !books.length && <p className="error">{error}</p>}
      {!books.length ? <p>No books found yet.</p> : <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))",gap:16}}>
        {books.map(b=><article className="policy-card" key={b.id}>
          {b.coverUrl && <img src={b.coverUrl} alt="" style={{width:"100%",maxHeight:180,objectFit:"contain"}}/>}
          <h3>{b.title}</h3><p>{b.author||"Unknown author"}</p><p>Status: <strong>{String(b.status||"").replaceAll("_"," ")}</strong></p>
          <p>{b.type==="FREE"?"Free":"₹"+Number(b.price||0)}</p>
        </article>)}
      </div>}
    </section>
  </main>;
}
