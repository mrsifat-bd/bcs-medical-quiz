// Shared helpers
function deviceId() {
  let d = localStorage.getItem("bcs_device_id");
  if (!d) { d = "dev-" + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now()); localStorage.setItem("bcs_device_id", d); }
  return d;
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, credentials: "same-origin", ...opts });
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || ("Error " + res.status));
  return data;
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
// render **bold** markup safely
function md(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
async function me() { try { return (await api("/api/me")).user; } catch (e) { return null; } }
