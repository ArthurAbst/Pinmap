// Test-only stand-in for Supabase, used when config.fake is set and the page runs on localhost.
// Talks to scripts/fake_server.py, which keeps rows and files in memory.
export function createFakeRemote() {
  const key = "pinmap:fake-user";
  let authFn = () => {};
  const j = (r) => { if (!r.ok) throw new Error("fake server " + r.status); return r.json(); };
  const read = () => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  return {
    async getUser() { return read(); },
    onAuth(fn) { authFn = fn; },
    async signIn(email, password) {
      if (!password || password.length < 6) throw new Error("Invalid login credentials");
      const u = { id: "u-" + email.toLowerCase().replace(/[^a-z0-9]/g, ""), email };
      localStorage.setItem(key, JSON.stringify(u)); authFn(u); return u;
    },
    async signUp(email, password, name) {
      const u = await this.signIn(email, password);
      if (name) await this.updateMeta({ name });
      return { user: u, session: { user: u } };
    },
    async signOut() { localStorage.removeItem(key); authFn(null); },
    async getMeta() { return j(await fetch(`/fake/meta?user=${read().id}`)); },
    async updateMeta(p) { await j(await fetch(`/fake/meta?user=${read().id}`, { method: "POST", body: JSON.stringify(p) })); },
    async pull(table, since) { return j(await fetch(`/fake/pull?table=${table}&since=${encodeURIComponent(since || "")}&user=${read().id}`)); },
    async upsert(table, rows) { await j(await fetch(`/fake/upsert?table=${table}`, { method: "POST", body: JSON.stringify(rows) })); },
    async upload(path, blob) { await j(await fetch(`/fake/file?path=${encodeURIComponent(path)}`, { method: "PUT", body: blob })); },
    async download(path) { const r = await fetch(`/fake/file?path=${encodeURIComponent(path)}`); if (!r.ok) throw new Error("404"); return r.blob(); },
    async remove(paths) { await j(await fetch(`/fake/remove`, { method: "POST", body: JSON.stringify(paths) })); },
  };
}
