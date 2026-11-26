/**
 * CoverLanka — Google Drive backup service
 * Saves the app's daily backups in the "CoverLanka Backups" folder and keeps 30 days,
 * and passes the app's new-order notifications on to the team's phones.
 * Only someone signed in to the CoverLanka team account can use it: every request
 * carries the app's sign-in token, which is checked against the CoverLanka database.
 */
const PROJECT_ID = "coverlanka-manager";
const FOLDER_NAME = "CoverLanka Backups";
const KEEP_DAYS = 30;   // backups older than this go to the Drive trash…
const KEEP_MIN = 10;    // …but the newest 10 are always kept

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!isTeam(req.token)) return out({ ok: false, error: "Not allowed — sign in to the CoverLanka app first" });
    const folder = getFolder();

    if (req.action === "save") {
      const name = String(req.name || "");
      if (!/^coverlanka-backup-[A-Za-z0-9\-]+\.json$/.test(name)) return out({ ok: false, error: "Bad file name" });
      const lock = LockService.getScriptLock(); lock.waitLock(20000);
      try {
        const it = folder.getFilesByName(name); let f;
        if (it.hasNext()) { f = it.next(); f.setContent(req.data); }
        else f = folder.createFile(name, req.data, "application/json");
        prune(folder);
        return out({ ok: true, name: name, size: f.getSize() });
      } finally { lock.releaseLock(); }
    }

    if (req.action === "list") {
      const files = [], it = folder.getFiles();
      while (it.hasNext()) { const f = it.next(); if (!/\.json$/.test(f.getName())) continue;
        files.push({ id: f.getId(), name: f.getName(), size: f.getSize(), time: f.getLastUpdated().toISOString() }); }
      files.sort((a, b) => b.time.localeCompare(a.time));
      return out({ ok: true, files: files, folderUrl: folder.getUrl() });
    }

    if (req.action === "get") {
      const f = DriveApp.getFileById(String(req.id));
      if (!inFolder(f, folder)) return out({ ok: false, error: "That file is not a CoverLanka backup" });
      return out({ ok: true, name: f.getName(), data: f.getBlob().getDataAsString() });
    }
    if (req.action === "push") {
      const allowed = /^https:\/\/(fcm\.googleapis\.com|[a-z0-9.-]*\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]*\.notify\.windows\.com)\//;
      const msgs = (req.messages || []).slice(0, 50).filter(m => allowed.test(String(m.endpoint)));
      const reqs = msgs.map(m => ({ url: m.endpoint, method: "post", contentType: "application/octet-stream",
        headers: m.headers || {}, payload: Utilities.base64Decode(m.body), muteHttpExceptions: true }));
      const res = reqs.length ? UrlFetchApp.fetchAll(reqs) : [];
      const byId = {}; msgs.forEach((m, i) => byId[m.id] = res[i].getResponseCode());
      return out({ ok: true, results: (req.messages || []).map(m => byId[m.id] || 400) });
    }
    if (req.action === "domex") return out(domex(req));
    return out({ ok: false, error: "Unknown action" });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() { return out({ ok: true, service: "CoverLanka backup" }); }

/* The token is accepted only if the CoverLanka database (whose rules allow
   only the team account) lets it read. */
function isTeam(token) {
  if (!token) return false;
  const url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/meta/counters";
  const r = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
  const code = r.getResponseCode();
  return code === 200 || code === 404;
}

function getFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("folderId");
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const found = DriveApp.getFoldersByName(FOLDER_NAME);
  const folder = found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER_NAME);
  props.setProperty("folderId", folder.getId());
  return folder;
}

function inFolder(file, folder) {
  const ps = file.getParents();
  while (ps.hasNext()) if (ps.next().getId() === folder.getId()) return true;
  return false;
}

function prune(folder) {
  const files = [], it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); if (/\.json$/.test(f.getName())) files.push(f); }
  files.sort((a, b) => b.getLastUpdated() - a.getLastUpdated());
  const cut = Date.now() - KEEP_DAYS * 864e5;
  files.slice(KEEP_MIN).forEach(f => { if (f.getLastUpdated().getTime() < cut) f.setTrashed(true); });
}

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ===================== Domex courier API =====================
   The Domex API key, username and password are kept ONLY in this script's
   Script properties (Project Settings → Script properties):
     DOMEX_API_KEY   DOMEX_USER   DOMEX_PASS
   They are never sent to the app or written to any file.            */
const DOMEX_BASE = "https://www.connectmesecurego.com/api/";

function domexCreds() {
  const p = PropertiesService.getScriptProperties();
  const c = { key: p.getProperty("DOMEX_API_KEY"), user: p.getProperty("DOMEX_USER"), pass: p.getProperty("DOMEX_PASS") };
  if (!c.key || !c.user || !c.pass) throw new Error("Domex is not set up yet — add DOMEX_API_KEY, DOMEX_USER and DOMEX_PASS in the script's Script properties");
  return c;
}

function domexToken(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) { const t = cache.get("domexToken"); if (t) return t; }
  const c = domexCreds();
  const r = UrlFetchApp.fetch(DOMEX_BASE + "Token/access-token-v-4-1", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { "x-api-key": c.key, accept: "*/*" },
    payload: JSON.stringify({ userName: c.user, password: c.pass })
  });
  let j = {}; try { j = JSON.parse(r.getContentText()); } catch (e) {}
  if (r.getResponseCode() !== 200 || !j.token) throw new Error("Domex sign-in failed (" + r.getResponseCode() + ") — check the Domex username, password and API key");
  let ttl = 3600;                                   // keep the token until shortly before it expires
  try { const exp = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(j.token.split(".")[1])).getDataAsString()).exp;
        if (exp) ttl = Math.floor(exp - Date.now() / 1000 - 120); } catch (e) {}
  ttl = Math.max(60, Math.min(21600, ttl));
  cache.put("domexToken", j.token, ttl);
  return j.token;
}

function domexReq(method, path, query, body, token) {
  const c = domexCreds();
  const qs = query ? "?" + Object.keys(query).map(k => k + "=" + encodeURIComponent(query[k])).join("&") : "";
  const o = { method: method, muteHttpExceptions: true, headers: { "x-api-key": c.key, accept: "*/*", Authorization: "Bearer " + token } };
  if (body) { o.contentType = "application/json"; o.payload = JSON.stringify(body); }
  return { url: DOMEX_BASE + path + qs, opts: o };
}

function domexParse(r) {
  let data = null; const txt = r.getContentText();
  try { data = JSON.parse(txt); } catch (e) { data = txt ? String(txt).slice(0, 300) : null; }
  return { status: r.getResponseCode(), data: data };
}

/* one call, signing in again once if the saved token was refused */
function domexCall(method, path, query, body) {
  let t = domexToken(false);
  let q = domexReq(method, path, query, body, t);
  let r = UrlFetchApp.fetch(q.url, q.opts);
  if (r.getResponseCode() === 401) { t = domexToken(true); q = domexReq(method, path, query, body, t); r = UrlFetchApp.fetch(q.url, q.opts); }
  return domexParse(r);
}

const DOMEX_FIELDS = ["trackingNo","refNo","paymentMethod","exchange","isPaid","beforeDelivered","itemType","senderName","senderAddress",
  "senderContactNo","receiverName","receiverAddress","receiverCity","receiverContactNo1","receiverContactNo2","packageDesc","weight",
  "remark","createdUser","keyValue","totalCharges","noOfPcs"];

function domex(req) {
  const tn = String(req.trackingNo || "").trim();
  const needTn = () => { if (!/^[A-Za-z0-9\-]{3,25}$/.test(tn)) throw new Error("Bad tracking number"); };
  const clean = p => { const o = {}; DOMEX_FIELDS.forEach(k => { if (p && p[k] !== undefined && p[k] !== null) o[k] = p[k]; }); return o; };

  if (req.op === "test") { domexToken(true); const res = { ok: true, signedIn: true };
    if (tn) { needTn(); res.waybill = domexCall("get", "CustomerInwards/getCustomerWayBillDetails", { trackingNo: tn }); }
    return res; }
  if (req.op === "waybill") { needTn(); return { ok: true, result: domexCall("get", "CustomerInwards/getCustomerWayBillDetails", { trackingNo: tn }) }; }
  if (req.op === "status") { needTn(); return { ok: true, result: domexCall("get", "CustomerInwards/getCustomerStatusDetails", { trackingNo: tn }) }; }
  if (req.op === "statusMany") {
    const list = (req.trackingNos || []).map(String).filter(x => /^[A-Za-z0-9\-]{3,25}$/.test(x)).slice(0, 40);
    if (!list.length) return { ok: true, results: {} };
    let t = domexToken(false);
    let rs = UrlFetchApp.fetchAll(list.map(x => { const q = domexReq("get", "CustomerInwards/getCustomerStatusDetails", { trackingNo: x }, null, t); q.opts.url = q.url; return q.opts; }));
    if (rs.some(r => r.getResponseCode() === 401)) { t = domexToken(true);
      rs = UrlFetchApp.fetchAll(list.map(x => { const q = domexReq("get", "CustomerInwards/getCustomerStatusDetails", { trackingNo: x }, null, t); q.opts.url = q.url; return q.opts; })); }
    const results = {}; list.forEach((x, i) => results[x] = domexParse(rs[i]));
    return { ok: true, results: results };
  }
  if (req.op === "create" || req.op === "update") {
    const p = clean(req.parcel); if (String(p.trackingNo || "") !== tn) throw new Error("Tracking number mismatch"); needTn();
    return { ok: true, result: domexCall(req.op === "create" ? "post" : "put",
      req.op === "create" ? "CustomerInwards/setCustomerDataEntry" : "CustomerInwards/updateCustomerDataEntry", null, p) };
  }
  if (req.op === "delete") { needTn(); return { ok: true, result: domexCall("delete", "CustomerInwards/DeleteCustomerDataEntry", { trackingNo: tn }) }; }
  throw new Error("Unknown Domex action");
}

/* Run this from the editor after adding the Script properties, to check the Domex sign-in. */
function testDomex() { domexToken(true); Logger.log("Domex sign-in works ✔"); }

/* Run this once from the editor to give the script permission to use Drive. */
function setup() { const f = getFolder(); Logger.log("Backups go to: " + f.getUrl()); }
