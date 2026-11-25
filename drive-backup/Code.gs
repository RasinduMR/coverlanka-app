/**
 * CoverLanka — Google Drive backup service
 * Saves the app's daily backups in the "CoverLanka Backups" folder and keeps 30 days.
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

/* Run this once from the editor to give the script permission to use Drive. */
function setup() { const f = getFolder(); Logger.log("Backups go to: " + f.getUrl()); }
