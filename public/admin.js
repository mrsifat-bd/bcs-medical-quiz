let ADMIN = null;
async function boot() {
  ADMIN = await me();
  if (!ADMIN || ADMIN.role !== "admin") { gate(); return; }
  showApp();
}
function gate(){ document.getElementById("gate").style.display="block"; document.getElementById("appwrap").style.display="none"; document.getElementById("logout").style.display="none"; }
function showApp(){
  document.getElementById("gate").style.display="none"; document.getElementById("appwrap").style.display="block";
  document.getElementById("who").textContent=ADMIN.username+" (admin)";
  loadStats(); loadLeads(); loadUsers(); loadFlags();
}
document.getElementById("lgo").addEventListener("click",adminLogin);
document.getElementById("lp").addEventListener("keydown",e=>{if(e.key==="Enter")adminLogin();});
async function adminLogin(){
  const m=document.getElementById("lmsg");m.innerHTML="";
  try{const u=await api("/api/login",{method:"POST",body:JSON.stringify({username:lu.value.trim(),password:lp.value,device_id:deviceId()})});
    if(u.role!=="admin"){m.innerHTML=`<div class="msg err">Not an admin account.</div>`;return;} ADMIN=u; showApp();
  }catch(e){m.innerHTML=`<div class="msg err">${esc(e.message)}</div>`;}
}
document.getElementById("logout").addEventListener("click",async()=>{await api("/api/logout",{method:"POST"});location.reload();});
document.querySelectorAll(".tabs button").forEach(b=>b.addEventListener("click",()=>{
  document.querySelectorAll(".tabs button").forEach(x=>x.classList.remove("active"));b.classList.add("active");
  document.querySelectorAll(".tabc").forEach(t=>t.style.display="none");
  document.getElementById("tab-"+b.dataset.tab).style.display="block";
}));
function enc(s){return encodeURIComponent(s);}

/* ---- shared server-side pagination state + helpers ---- */
const PG={leads:{page:1,pageSize:20,search:""},users:{page:1,pageSize:20,search:""},flags:{page:1,pageSize:20}};
function pager(key,total,loader){
  const st=PG[key];const pages=Math.ceil(total/st.pageSize)||1;
  if(st.page>pages){st.page=pages;}
  const from=total?((st.page-1)*st.pageSize+1):0;
  const to=Math.min(total,st.page*st.pageSize);
  return `<div class="pgbar" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;flex-wrap:wrap">
    <span style="color:var(--muted);font-size:13px">${total?`${from}–${to} of ${total}`:"No records"}</span>
    <span style="display:flex;gap:6px;align-items:center">
      <button class="btn gray sm" ${st.page<=1?'disabled':''} onclick="${loader}(${st.page-1})">‹ Prev</button>
      <span class="pinfo" style="font-size:13px">Page ${st.page} / ${pages}</span>
      <button class="btn gray sm" ${st.page>=pages?'disabled':''} onclick="${loader}(${st.page+1})">Next ›</button>
    </span></div>`;
}
const debounceMap={};
function debouncedSearch(key,val,loader){st_set(key,val);clearTimeout(debounceMap[key]);debounceMap[key]=setTimeout(()=>{PG[key].page=1;loader(1);},300);}
function st_set(key,val){PG[key].search=val;}

async function loadStats(){
  const s=await api("/api/admin/stats");
  document.getElementById("stats").innerHTML=
    `<div class="stat"><b>${s.questions}</b><span>Questions</span></div>
     <div class="stat"><b>${s.leads}</b><span>Sign-ups</span></div>
     <div class="stat"><b>${s.users}</b><span>Members</span></div>
     <div class="stat"><b>${s.openFlags}</b><span>Open reports</span></div>`;
}

/* leads */
async function loadLeads(page){
  if(page)PG.leads.page=page;
  const st=PG.leads;
  const {leads,total}=await api(`/api/admin/leads?page=${st.page}&pageSize=${st.pageSize}&search=${enc(st.search)}`);
  const rows=leads.map(l=>`<tr>
    <td><b>${esc(l.name||"")}</b></td><td>${esc(l.medical||"")}</td><td>${esc(l.session||"")}</td>
    <td>${esc(l.email||"")}</td><td>${esc(l.whatsapp||"")}</td>
    <td>${l.bought_book?`<span class="pill ${l.bought_book==="Yes"?"green":"gray"}">${esc(l.bought_book)}</span>`:""}</td>
    <td style="white-space:nowrap;color:var(--muted)">${(l.signup_at||"").slice(0,10)}</td>
    <td>${l.converted_user_id?`<span class="pill green">member: ${esc(l.username||"")}</span>`:`<button class="btn sm" onclick="convertLead('${l.gid}','${enc(l.name||"")}')">Create login</button>`}</td>
  </tr>`).join("");
  const focus=document.activeElement&&document.activeElement.id==="leadSearch";
  const search=`<div style="margin-bottom:10px"><input id="leadSearch" placeholder="Search name, email, WhatsApp…" value="${esc(st.search)}" oninput="debouncedSearch('leads',this.value,loadLeads)" style="max-width:320px"/></div>`;
  document.getElementById("leadWrap").innerHTML=`${search}<table><tr><th>Name</th><th>Medical college</th><th>Session</th><th>Gmail</th><th>WhatsApp</th><th>Book?</th><th>Date</th><th>Action</th></tr>${rows||`<tr><td colspan="8" style="color:var(--muted)">No sign-ups${st.search?" match your search":" yet"}.</td></tr>`}</table>${pager("leads",total,"loadLeads")}`;
  if(focus){const el=document.getElementById("leadSearch");el.focus();el.setSelectionRange(el.value.length,el.value.length);}
}
async function convertLead(gid,name){
  const uname=prompt("Choose a username for "+decodeURIComponent(name)+":"); if(!uname)return;
  const pass=prompt("Choose a password for this member:"); if(!pass)return;
  try{const r=await api(`/api/admin/leads/${gid}/convert`,{method:"POST",body:JSON.stringify({username:uname.trim(),password:pass})});
    alert("Member created.\n\nUsername: "+r.username+"\nPassword: "+pass+"\n\nSend these to the student via WhatsApp. It works on one device only.");
    loadLeads();loadUsers();loadStats();
  }catch(e){alert(e.message);}
}

/* members */
async function loadUsers(page){
  if(page)PG.users.page=page;
  const st=PG.users;
  const {users,total}=await api(`/api/admin/users?page=${st.page}&pageSize=${st.pageSize}&search=${enc(st.search)}`);
  const rows=users.map(u=>`<tr>
    <td><b>${esc(u.username)}</b></td><td>${esc(u.name||"")}</td>
    <td>${u.active?'<span class="pill green">active</span>':'<span class="pill gray">disabled</span>'}</td>
    <td>${u.bound?'<span class="pill amber">device bound</span>':'<span class="pill gray">not bound</span>'}</td>
    <td style="white-space:nowrap">${esc(u.last_ip||"—")}</td>
    <td>${esc(u.last_device||"—")}</td>
    <td style="white-space:nowrap;color:var(--muted)">${u.last_login_at?String(u.last_login_at).slice(0,16).replace("T"," "):"—"}</td>
    <td style="white-space:nowrap">${fmtDur(u.total_seconds||0)}</td>
    <td style="white-space:nowrap">${u.multi_device?'<span class="pill green">multi-device</span>':'<span class="pill gray">1 device</span>'}${u.active_sessions?` <span class="pill" style="background:var(--tealbg,#e6f6f3);color:var(--teal-d)">${u.active_sessions} online</span>`:""}</td>
    <td style="white-space:nowrap">
      <button class="btn gray sm" onclick="toggleMulti(${u.id},${u.multi_device?0:1})">${u.multi_device?"Make single-device":"Allow multi-device"}</button>
      <button class="btn gray sm" onclick="resetDevice(${u.id})">Reset device</button>
      <button class="btn gray sm" onclick="toggleActive(${u.id},${u.active?0:1})">${u.active?"Disable":"Enable"}</button>
      <button class="btn gray sm" onclick="resetPw(${u.id})">Password</button>
      <button class="btn danger sm" onclick="delUser(${u.id},'${enc(u.username)}')">Delete</button></td></tr>`).join("");
  const focus=document.activeElement&&document.activeElement.id==="userSearch";
  const search=`<div style="margin-bottom:10px"><input id="userSearch" placeholder="Search username or name…" value="${esc(st.search)}" oninput="debouncedSearch('users',this.value,loadUsers)" style="max-width:320px"/></div>`;
  document.getElementById("userWrap").innerHTML=`${search}<table><tr><th>Username</th><th>Name</th><th>Status</th><th>Device lock</th><th>Last IP</th><th>Device</th><th>Last login</th><th>Time spent</th><th>Devices</th><th>Actions</th></tr>${rows||`<tr><td colspan="10" style="color:var(--muted)">No members${st.search?" match your search":" yet"}.</td></tr>`}</table>${pager("users",total,"loadUsers")}`;
  if(focus){const el=document.getElementById("userSearch");el.focus();el.setSelectionRange(el.value.length,el.value.length);}
}
function fmtDur(s){s=Math.max(0,Math.round(s));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);if(h)return h+"h "+m+"m";if(m)return m+"m";return s+"s";
}
document.getElementById("addUser").addEventListener("click",async()=>{
  const m=document.getElementById("umsg");m.innerHTML="";
  try{await api("/api/admin/users",{method:"POST",body:JSON.stringify({username:nu.value.trim(),name:nn.value.trim(),password:np.value})});
    nu.value=nn.value=np.value="";m.innerHTML=`<div class="msg ok">Member added.</div>`;loadUsers();loadStats();
  }catch(e){m.innerHTML=`<div class="msg err">${esc(e.message)}</div>`;}
});
async function resetDevice(id){await api(`/api/admin/users/${id}/reset-device`,{method:"POST"});loadUsers();}
async function toggleMulti(id,on){await api(`/api/admin/users/${id}/multi-device`,{method:"POST",body:JSON.stringify({on})});loadUsers();}
async function toggleActive(id,a){await api(`/api/admin/users/${id}/active`,{method:"POST",body:JSON.stringify({active:a})});loadUsers();}
async function resetPw(id){const p=prompt("New password:");if(!p)return;await api(`/api/admin/users/${id}/password`,{method:"POST",body:JSON.stringify({password:p})});alert("Password updated.");}
async function delUser(id,u){if(!confirm("Delete member "+decodeURIComponent(u)+"?"))return;await api(`/api/admin/users/${id}`,{method:"DELETE"});loadUsers();loadStats();}

/* flags */
async function loadFlags(page){
  if(page)PG.flags.page=page;
  const st=PG.flags;
  const {flags,total}=await api(`/api/admin/flags?page=${st.page}&pageSize=${st.pageSize}`);
  const rows=flags.map(f=>`<tr style="${f.resolved?'opacity:.5':''}">
    <td style="max-width:440px"><div style="font-size:12px;color:var(--muted)">Q${f.question_id} · ${esc(f.subject)} › ${esc(f.heading)}</div>
      <div>${md(f.stem)}</div>${f.reason?`<div style="font-size:13px;color:var(--red);margin-top:4px">"${esc(f.reason)}"</div>`:""}</td>
    <td style="white-space:nowrap;color:var(--muted)">${(f.created_at||"").slice(0,10)}</td>
    <td>${f.resolved?'<span class="pill gray">resolved</span>':`<button class="btn gray sm" onclick="resolveFlag(${f.id})">Resolve</button> <button class="btn danger sm" onclick="delQ(${f.question_id})">Hide Q</button>`}</td></tr>`).join("");
  document.getElementById("flagWrap").innerHTML=`<table><tr><th>Question / report</th><th>Date</th><th>Action</th></tr>${rows||`<tr><td colspan="3" style="color:var(--muted)">No reports.</td></tr>`}</table>${pager("flags",total,"loadFlags")}`;
}
async function resolveFlag(id){await api(`/api/admin/flags/${id}/resolve`,{method:"POST"});loadFlags();loadStats();}
async function delQ(id){if(!confirm("Hide question Q"+id+"?"))return;await api(`/api/admin/questions/${id}/delete`,{method:"POST"});loadFlags();loadStats();}

/* upload */
document.getElementById("uploadBtn").addEventListener("click",async()=>{
  const m=document.getElementById("upmsg");m.innerHTML="";
  const f=document.getElementById("file").files[0];
  if(!f){m.innerHTML=`<div class="msg err">Choose a file first.</div>`;return;}
  const fd=new FormData();fd.append("file",f);m.innerHTML="Uploading…";
  try{const res=await fetch("/api/admin/upload",{method:"POST",body:fd,credentials:"same-origin"});const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Upload failed");
    let h=`<div class="msg ok">${esc(data.message)}</div>`;
    if(data.errors&&data.errors.length)h+=`<div class="msg err">Skipped:<br>${data.errors.map(esc).join("<br>")}</div>`;
    m.innerHTML=h;loadStats();
  }catch(e){m.innerHTML=`<div class="msg err">${esc(e.message)}</div>`;}
});
/* settings */
document.getElementById("chpw").addEventListener("click",async()=>{
  const m=document.getElementById("pwmsg");m.innerHTML="";
  try{await api("/api/admin/change-password",{method:"POST",body:JSON.stringify({password:ap.value})});ap.value="";m.innerHTML=`<div class="msg ok">Password updated.</div>`;}
  catch(e){m.innerHTML=`<div class="msg err">${esc(e.message)}</div>`;}
});
boot();
