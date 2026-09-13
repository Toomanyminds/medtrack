/* ============================================================
   MedTrack — personal medical record tracker
   All data lives in the user's own Google Drive. This file only
   ever talks to: Google Identity Services, the Drive REST API,
   and the Gemini REST API, using keys the user supplies once.
   ============================================================ */

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "MedTrack";
const INDEX_NAME = "medtrack_index.json";
const GEMINI_MODEL = "gemini-flash-latest";

const LS = {
  clientId: "mt_client_id",
  geminiKey: "mt_gemini_key",
  folderId: "mt_folder_id",
  indexFileId: "mt_index_file_id",
  records: "mt_records_cache",
  account: "mt_account_email",
};

const state = {
  clientId: localStorage.getItem(LS.clientId) || "",
  geminiKey: localStorage.getItem(LS.geminiKey) || "",
  accessToken: null,
  tokenExpiresAt: 0,
  tokenClient: null,
  folderId: localStorage.getItem(LS.folderId) || null,
  indexFileId: localStorage.getItem(LS.indexFileId) || null,
  records: safeParse(localStorage.getItem(LS.records)) || [],
  currentView: "home",
};

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function esc(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), ms);
}

/* ============================== BOOT ============================== */

window.addEventListener("DOMContentLoaded", () => {
  wireStaticHandlers();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  if (!state.clientId || !state.geminiKey) {
    showGate("setup");
  } else {
    showGate("signin");
    initTokenClient();
    attemptSilentSignIn();
  }
});

function showGate(which) {
  $("#gate-setup").style.display = which === "setup" ? "flex" : "none";
  $("#gate-signin").style.display = which === "signin" ? "flex" : "none";
  $("#main-app").style.display = which === "app" ? "flex" : "none";
}

/* ============================== SETUP ============================== */

function wireStaticHandlers() {
  $("#btn-save-setup").addEventListener("click", () => {
    const cid = $("#in-client-id").value.trim();
    const key = $("#in-gemini-key").value.trim();
    if (!cid || !key) { toast("Both fields are needed to continue"); return; }
    state.clientId = cid;
    state.geminiKey = key;
    localStorage.setItem(LS.clientId, cid);
    localStorage.setItem(LS.geminiKey, key);
    showGate("signin");
    initTokenClient();
  });

  $("#btn-edit-setup").addEventListener("click", () => {
    $("#in-client-id").value = state.clientId;
    $("#in-gemini-key").value = state.geminiKey;
    showGate("setup");
  });

  $("#btn-google-signin").addEventListener("click", () => {
    if (!state.tokenClient) { initTokenClient(); }
    state.tokenClient.requestAccessToken({ prompt: "consent" });
  });

  // bottom nav
  $all("nav.tabbar button").forEach((b) => {
    b.addEventListener("click", () => switchView(b.dataset.view));
  });

  // upload
  $("#drop-zone").addEventListener("click", () => $("#file-input").click());
  $("#btn-pick-file").addEventListener("click", () => $("#file-input").click());
  $("#btn-pick-camera").addEventListener("click", () => $("#camera-input").click());
  $("#file-input").addEventListener("change", (e) => handleFiles(e.target.files));
  $("#camera-input").addEventListener("change", (e) => handleFiles(e.target.files));

  // records filter
  $("#records-filter").addEventListener("change", renderRecords);
  $("#trend-analyte").addEventListener("change", renderTrend);

  // settings
  $("#btn-signout").addEventListener("click", signOut);
  $("#btn-edit-keys").addEventListener("click", () => {
    $("#in-client-id").value = state.clientId;
    $("#in-gemini-key").value = state.geminiKey;
    showGate("setup");
  });
  $("#btn-resync").addEventListener("click", () => loadIndex(true));
  $("#btn-open-drive").addEventListener("click", () => {
    if (state.folderId) window.open(`https://drive.google.com/drive/folders/${state.folderId}`, "_blank");
  });

  // sheet
  $("#sheet-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "sheet-backdrop") closeSheet();
  });
}

function switchView(name) {
  state.currentView = name;
  $all(".view").forEach((v) => v.classList.remove("active"));
  $(`#view-${name}`).classList.add("active");
  $all("nav.tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const titles = { home: "Home", records: "Records", upload: "Add", trends: "Trends", settings: "Settings" };
  $("#topbar-title").textContent = titles[name];
  if (name === "home") renderHome();
  if (name === "records") renderRecords();
  if (name === "trends") renderTrend();
}

/* ============================== AUTH ============================== */

function initTokenClient() {
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    setTimeout(initTokenClient, 300);
    return;
  }
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.clientId,
    scope: DRIVE_SCOPE,
    callback: async (resp) => {
      if (resp.error) {
        $("#signin-error").style.display = "block";
        $("#signin-error").textContent = "Sign-in didn't go through — tap Sign in with Google to try again.";
        return;
      }
      state.accessToken = resp.access_token;
      state.tokenExpiresAt = Date.now() + (resp.expires_in || 3300) * 1000;
      await onSignedIn();
    },
  });
}

function attemptSilentSignIn() {
  // Best-effort quiet re-auth so the person doesn't have to tap through
  // the consent screen every time they open the app. If Google can't
  // renew it silently (e.g. the browser session expired), the manual
  // "Sign in with Google" button on the gate screen still works.
  setTimeout(() => {
    if (!state.accessToken && state.tokenClient) {
      try { state.tokenClient.requestAccessToken({ prompt: "" }); } catch {}
    }
  }, 400);
}

function ensureFreshToken() {
  return new Promise((resolve, reject) => {
    if (state.accessToken && Date.now() < state.tokenExpiresAt - 60000) {
      resolve(state.accessToken);
      return;
    }
    if (!state.tokenClient) { reject(new Error("Not signed in")); return; }
    const prevCallback = state.tokenClient.callback;
    state.tokenClient.callback = (resp) => {
      state.tokenClient.callback = prevCallback;
      if (resp.error) { reject(new Error(resp.error)); return; }
      state.accessToken = resp.access_token;
      state.tokenExpiresAt = Date.now() + (resp.expires_in || 3300) * 1000;
      resolve(state.accessToken);
    };
    state.tokenClient.requestAccessToken({ prompt: "" });
  });
}

async function onSignedIn() {
  showGate("app");
  $("#main-app").style.display = "flex";
  try {
    const info = await fetchJson("https://www.googleapis.com/oauth2/v3/userinfo", {});
    $("#settings-account").textContent = info.email || "Google account";
    localStorage.setItem(LS.account, info.email || "");
  } catch { $("#settings-account").textContent = localStorage.getItem(LS.account) || "Google account"; }
  setStatus("Loading your records…");
  await ensureFolder();
  await loadIndex(false);
  setStatus("Synced");
  switchView("home");
}

function signOut() {
  if (state.accessToken) {
    try { google.accounts.oauth2.revoke(state.accessToken, () => {}); } catch {}
  }
  state.accessToken = null;
  state.tokenExpiresAt = 0;
  showGate("signin");
}

function setStatus(text) {
  $("#topbar-sub").textContent = text;
}

/* ============================== FETCH HELPERS ============================== */

async function authFetch(url, opts = {}) {
  const token = await ensureFreshToken();
  const headers = Object.assign({}, opts.headers || {}, { Authorization: `Bearer ${token}` });
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function fetchJson(url, opts) {
  const res = await authFetch(url, opts);
  return res.json();
}

/* ============================== DRIVE ============================== */

async function ensureFolder() {
  if (state.folderId) return state.folderId;
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`);
  const found = await fetchJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {});
  if (found.files && found.files.length) {
    state.folderId = found.files[0].id;
  } else {
    const created = await fetchJson("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    state.folderId = created.id;
  }
  localStorage.setItem(LS.folderId, state.folderId);
  return state.folderId;
}

async function loadIndex(forceRemote) {
  if (!forceRemote && state.records.length) { renderAll(); return; }
  try {
    if (!state.indexFileId) {
      const q = encodeURIComponent(`name='${INDEX_NAME}' and '${state.folderId}' in parents and trashed=false`);
      const found = await fetchJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {});
      if (found.files && found.files.length) state.indexFileId = found.files[0].id;
    }
    if (state.indexFileId) {
      const res = await authFetch(`https://www.googleapis.com/drive/v3/files/${state.indexFileId}?alt=media`, {});
      const data = await res.json();
      state.records = data.records || [];
      localStorage.setItem(LS.indexFileId, state.indexFileId);
      localStorage.setItem(LS.records, JSON.stringify(state.records));
    }
  } catch (e) {
    console.error("loadIndex failed", e);
    toast("Couldn't sync from Drive — showing your last saved list");
  }
  renderAll();
}

async function saveIndex() {
  localStorage.setItem(LS.records, JSON.stringify(state.records));
  const payload = JSON.stringify({ records: state.records }, null, 0);
  const boundary = "medtrack" + Date.now();
  const metadata = state.indexFileId
    ? { name: INDEX_NAME }
    : { name: INDEX_NAME, parents: [state.folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
  const url = state.indexFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${state.indexFileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
  const res = await authFetch(url, {
    method: state.indexFileId ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json();
  if (!state.indexFileId) {
    state.indexFileId = data.id;
    localStorage.setItem(LS.indexFileId, state.indexFileId);
  }
}

async function uploadFileToDrive(file, base64) {
  const boundary = "medtrack" + Date.now();
  const metadata = { name: file.name, parents: [state.folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${file.type || "application/octet-stream"}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64}\r\n--${boundary}--`;
  const res = await authFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

async function deleteFromDrive(fileId) {
  try { await authFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: "DELETE" }); } catch {}
}

/* ============================== FILE READING ============================== */

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ============================== GEMINI ============================== */

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    isMedical: { type: "boolean" },
    rejectReason: { type: "string" },
    docType: { type: "string", enum: ["Blood Test", "Imaging", "Prescription", "Consultation Note", "Symptom Photo", "Other Medical", "Not Medical"] },
    issue: { type: "string" },
    dateOfDocument: { type: "string" },
    doctorOrClinic: { type: "string" },
    summary: { type: "string" },
    bloodPanel: {
      type: "array",
      items: {
        type: "object",
        properties: {
          analyte: { type: "string" },
          value: { type: "number" },
          unit: { type: "string" },
          refLow: { type: "number" },
          refHigh: { type: "number" },
          flag: { type: "string", enum: ["low", "normal", "high", "unknown"] },
        },
      },
    },
  },
  required: ["isMedical", "docType", "summary"],
};

const GEMINI_PROMPT = `You are a private medical records assistant reviewing one uploaded file for a personal health archive.

First decide: is this a personal medical document? That includes lab/blood reports, prescriptions, consultation or discharge notes, imaging reports, medical bills tied to care, or a photo of a bodily symptom (e.g. a wound, rash, bruise, swelling, bite). If it is clearly unrelated to the uploader's own health (e.g. a receipt, a screenshot of an app, a landscape photo, a meme, a work document), set isMedical to false and give a short rejectReason.

If it is medical, set isMedical true and:
- docType: the best matching category.
- issue: the underlying condition or reason this record exists, in 1-4 words a patient would use (e.g. "Thyroid", "Skin - infection", "Annual checkup", "Knee injury"). Keep the same wording across documents about the same ongoing issue where possible.
- dateOfDocument: the date on the document itself if visible, as YYYY-MM-DD. If not visible, leave empty.
- doctorOrClinic: name if visible, else empty.
- summary: 1-2 plain-language sentences a patient would want to remember about this specific document.
- bloodPanel: if and only if this is a lab/blood test with numeric analyte values, list every analyte you can read with its value, unit, and reference range if printed, plus a flag of low/high/normal relative to that range (unknown if no range given). Leave this empty array for anything else.

Respond only with the JSON object matching the schema. Do not include any text outside the JSON.`;

async function classifyWithGemini(file, base64) {
  const isText = file.type.startsWith("text/") || /\.(csv|txt)$/i.test(file.name);
  const parts = isText
    ? [{ text: GEMINI_PROMPT }, { text: atob(base64) }]
    : [{ text: GEMINI_PROMPT }, { inlineData: { mimeType: file.type || "application/octet-stream", data: base64 } }];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(state.geminiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "{}";
  return JSON.parse(text);
}

/* ============================== UPLOAD PIPELINE ============================== */

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  switchView("upload");
  $("#queue-title").style.display = "block";
  $("#queue-list").style.display = "block";

  for (const file of files) {
    if (file.size > 18 * 1024 * 1024) {
      addQueueRow(file.name, "fail", "Too large (18MB limit)");
      continue;
    }
    const row = addQueueRow(file.name, "pending", "Reading…");
    try {
      const base64 = await readFileAsBase64(file);
      setQueueRow(row, "pending", "Asking Gemini to read it…");
      const result = await classifyWithGemini(file, base64);

      if (!result.isMedical) {
        setQueueRow(row, "fail", result.rejectReason || "Doesn't look like a medical document", true, { file, base64, result });
        continue;
      }
      setQueueRow(row, "pending", "Saving to Drive…");
      const driveFile = await uploadFileToDrive(file, base64);
      const record = buildRecord(file, driveFile, result);
      state.records.unshift(record);
      await saveIndex();
      setQueueRow(row, "ok", `Filed under "${record.issue}"`);
    } catch (e) {
      console.error(e);
      setQueueRow(row, "fail", "Something went wrong — try again");
    }
  }
  renderAll();
}

function buildRecord(file, driveFile, result) {
  return {
    id: driveFile.id + "_" + Date.now(),
    fileId: driveFile.id,
    fileName: file.name,
    mimeType: file.type,
    webViewLink: driveFile.webViewLink || null,
    uploadedAt: new Date().toISOString(),
    docType: result.docType || "Other Medical",
    issue: result.issue || "Uncategorized",
    dateOfDocument: result.dateOfDocument || "",
    doctor: result.doctorOrClinic || "",
    summary: result.summary || "",
    bloodPanel: Array.isArray(result.bloodPanel) ? result.bloodPanel : [],
  };
}

function addQueueRow(name, status, msg) {
  const list = $("#queue-list");
  const el = document.createElement("div");
  el.className = "queue-item";
  el.innerHTML = `<div class="dot ${status}"></div><div class="body"><div class="fn">${esc(name)}</div><div class="st">${esc(msg)}</div></div>`;
  list.prepend(el);
  return el;
}

function setQueueRow(row, status, msg, showOverride, ctx) {
  row.querySelector(".dot").className = `dot ${status}`;
  const st = row.querySelector(".st");
  st.textContent = msg;
  if (showOverride) {
    const btn = document.createElement("button");
    btn.className = "override";
    btn.textContent = "Add anyway";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      setQueueRow(row, "pending", "Saving to Drive…");
      try {
        const driveFile = await uploadFileToDrive(ctx.file, ctx.base64);
        const record = buildRecord(ctx.file, driveFile, Object.assign({ docType: "Other Medical", issue: "Uncategorized", summary: "Manually added — Gemini flagged this as non-medical." }, ctx.result, { isMedical: true }));
        state.records.unshift(record);
        await saveIndex();
        setQueueRow(row, "ok", `Filed under "${record.issue}"`);
        renderAll();
      } catch (e) {
        setQueueRow(row, "fail", "Couldn't save — try again");
      }
    });
    row.querySelector(".body").appendChild(btn);
  }
}

/* ============================== RENDERING ============================== */

function renderAll() {
  renderHome();
  renderRecords();
  renderTrend();
}

function docIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8z"/><path d="M14 3v5h5"/></svg>`;
}

function issueList() {
  const set = new Map();
  state.records.forEach((r) => set.set(r.issue, (set.get(r.issue) || 0) + 1));
  return Array.from(set.entries()).sort((a, b) => b[1] - a[1]);
}

function renderHome() {
  $("#stat-total").textContent = state.records.length;
  $("#stat-issues").textContent = issueList().length;
  const analytes = new Set();
  state.records.forEach((r) => (r.bloodPanel || []).forEach((b) => analytes.add(normalizeAnalyte(b.analyte))));
  $("#stat-blood").textContent = analytes.size;

  const chips = $("#home-chips");
  const issues = issueList();
  chips.innerHTML = issues.length
    ? issues.map(([name, n]) => `<button class="chip" data-issue="${esc(name)}">${esc(name)} · ${n}</button>`).join("")
    : `<span style="font-size:13px;color:var(--ink-soft)">No issues tracked yet — add your first record.</span>`;
  chips.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => {
      switchView("records");
      $("#records-filter").value = c.dataset.issue;
      renderRecords();
    })
  );

  const recent = $("#home-recent");
  const top = state.records.slice(0, 6);
  recent.innerHTML = top.length
    ? top.map(recordRowHtml).join("")
    : emptyHtml("No records yet. Tap Add to upload your first report, prescription, or photo.");
  wireRecordRows(recent);
}

function emptyHtml(msg) {
  return `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8z"/><path d="M14 3v5h5"/></svg><p>${esc(msg)}</p></div>`;
}

function recordRowHtml(r) {
  const date = r.dateOfDocument || r.uploadedAt.slice(0, 10);
  return `<div class="record" data-id="${r.id}">
    <div class="icon">${docIcon()}</div>
    <div class="body">
      <div class="title">${esc(r.docType)} — ${esc(r.issue)}</div>
      <div class="meta">${esc(date)}${r.doctor ? " · " + esc(r.doctor) : ""}</div>
      <div class="summary">${esc(r.summary)}</div>
    </div>
  </div>`;
}

function wireRecordRows(container) {
  container.querySelectorAll(".record").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.id))
  );
}

function renderRecords() {
  const sel = $("#records-filter");
  const current = sel.value || "__all";
  const issues = issueList();
  sel.innerHTML = `<option value="__all">All issues</option>` + issues.map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
  sel.value = issues.some(([n]) => n === current) ? current : "__all";

  const filtered = sel.value === "__all" ? state.records : state.records.filter((r) => r.issue === sel.value);
  const list = $("#records-list");
  list.innerHTML = filtered.length ? filtered.map(recordRowHtml).join("") : emptyHtml("Nothing here yet.");
  wireRecordRows(list);
}

function normalizeAnalyte(name) {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function collectAnalytes() {
  const map = new Map();
  state.records.forEach((r) => {
    (r.bloodPanel || []).forEach((b) => {
      const key = normalizeAnalyte(b.analyte);
      if (!key) return;
      if (!map.has(key)) map.set(key, { label: b.analyte, points: [] });
      map.get(key).points.push({
        date: r.dateOfDocument || r.uploadedAt.slice(0, 10),
        value: b.value,
        unit: b.unit,
        refLow: b.refLow,
        refHigh: b.refHigh,
        flag: b.flag,
      });
    });
  });
  map.forEach((v) => v.points.sort((a, b) => (a.date > b.date ? 1 : -1)));
  return map;
}

let trendChart = null;
function renderTrend() {
  const map = collectAnalytes();
  const sel = $("#trend-analyte");
  const keys = Array.from(map.keys());
  const current = sel.value;
  sel.innerHTML = keys.map((k) => `<option value="${esc(k)}">${esc(map.get(k).label)}</option>`).join("");

  if (!keys.length) {
    $("#trend-empty").style.display = "block";
    $("#trend-chart-wrap").style.display = "none";
    $("#trend-legend").style.display = "none";
    sel.style.display = "none";
    return;
  }
  sel.style.display = "block";
  sel.value = keys.includes(current) ? current : keys[0];
  $("#trend-empty").style.display = "none";
  $("#trend-chart-wrap").style.display = "block";
  $("#trend-legend").style.display = "flex";

  const entry = map.get(sel.value);
  const labels = entry.points.map((p) => p.date);
  const values = entry.points.map((p) => p.value);
  const refLow = entry.points.find((p) => p.refLow != null)?.refLow;
  const refHigh = entry.points.find((p) => p.refHigh != null)?.refHigh;
  const pointColors = entry.points.map((p) => (p.flag === "high" ? "#C1543C" : p.flag === "low" ? "#D9A441" : "#3E6259"));

  const ctx = $("#trend-canvas").getContext("2d");
  if (trendChart) trendChart.destroy();

  const datasets = [
    {
      label: entry.label,
      data: values,
      borderColor: "#3E6259",
      backgroundColor: "#3E6259",
      pointBackgroundColor: pointColors,
      pointBorderColor: pointColors,
      pointRadius: 5,
      tension: 0.25,
      fill: false,
    },
  ];
  if (refLow != null && refHigh != null) {
    datasets.push({
      label: "range high",
      data: labels.map(() => refHigh),
      borderColor: "transparent",
      backgroundColor: "rgba(62,98,89,0.10)",
      pointRadius: 0,
      fill: "+1",
    });
    datasets.push({
      label: "range low",
      data: labels.map(() => refLow),
      borderColor: "transparent",
      backgroundColor: "rgba(62,98,89,0.10)",
      pointRadius: 0,
      fill: false,
    });
  }

  trendChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { grid: { color: "#E4DFD3" }, ticks: { font: { size: 10 } } },
      },
    },
  });
}

/* ============================== DETAIL SHEET ============================== */

function openDetail(id) {
  const r = state.records.find((x) => x.id === id);
  if (!r) return;
  const panelRows = (r.bloodPanel || [])
    .map((b) => {
      const flagClass = b.flag === "high" ? "flag-high" : b.flag === "low" ? "flag-low" : "";
      return `<tr><td>${esc(b.analyte)}</td><td class="${flagClass}">${b.value ?? ""} ${esc(b.unit || "")}</td><td>${b.refLow ?? "–"}–${b.refHigh ?? "–"}</td></tr>`;
    })
    .join("");

  $("#sheet-content").innerHTML = `
    <div class="handle"></div>
    <h2>${esc(r.docType)}</h2>
    <div style="color:var(--ink-soft); font-size:13px;">${esc(r.issue)}</div>
    <dl>
      <dt>Date</dt><dd>${esc(r.dateOfDocument || r.uploadedAt.slice(0, 10))}</dd>
      <dt>Doctor / clinic</dt><dd>${esc(r.doctor || "—")}</dd>
      <dt>File</dt><dd>${esc(r.fileName)}</dd>
    </dl>
    <p style="font-size:14px; line-height:1.5;">${esc(r.summary)}</p>
    ${panelRows ? `<table class="panel-table"><thead><tr><th>Analyte</th><th>Value</th><th>Range</th></tr></thead><tbody>${panelRows}</tbody></table>` : ""}
    <div style="display:flex; gap:10px; margin-top:20px;">
      ${r.webViewLink ? `<button class="btn btn-primary" style="flex:1" onclick="window.open('${r.webViewLink}','_blank')">Open file</button>` : ""}
      <button class="btn btn-ghost" style="flex:1" id="btn-delete-record">Delete</button>
    </div>
  `;
  $("#btn-delete-record").addEventListener("click", async () => {
    if (!confirm("Delete this record from MedTrack and Drive?")) return;
    await deleteFromDrive(r.fileId);
    state.records = state.records.filter((x) => x.id !== id);
    await saveIndex();
    closeSheet();
    renderAll();
    toast("Record deleted");
  });
  $("#sheet-backdrop").classList.add("active");
}

function closeSheet() {
  $("#sheet-backdrop").classList.remove("active");
}
