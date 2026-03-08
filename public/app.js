const statusEl = document.getElementById("status");
const libraryInfoEl = document.getElementById("libraryInfo");
const rowsEl = document.getElementById("rows");
const toggleAllRowsBtn = document.getElementById("toggleAllRowsBtn");
const menuBtn = document.getElementById("menuBtn");
const sidebarEl = document.querySelector(".sidebar");

const navButtons = {
  library: document.getElementById("navLibrary"),
  continue: document.getElementById("navContinue"),
  history: document.getElementById("navHistory"),
};

const importBtn = document.getElementById("importBtn");
const folderInput = document.getElementById("folderInput");
const filesInput = document.getElementById("filesInput");
const singleThumbInput = document.getElementById("singleThumbInput");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

const importChoiceModal = document.getElementById("importChoiceModal");
const pickFolderChoiceBtn = document.getElementById("pickFolderChoiceBtn");
const pickFilesChoiceBtn = document.getElementById("pickFilesChoiceBtn");
const closeImportChoiceBtn = document.getElementById("closeImportChoiceBtn");

const thumbChoiceModal = document.getElementById("thumbChoiceModal");
const modeSingleBtn = document.getElementById("modeSingle");
const modeNoneBtn = document.getElementById("modeNone");
const modeGenerateBtn = document.getElementById("modeGenerate");

const playerModal = document.getElementById("playerModal");
const playerBackdrop = document.getElementById("playerBackdrop");
const closePlayerBtn = document.getElementById("closePlayerBtn");
const videoWrap = document.getElementById("videoWrap");
const videoEl = document.getElementById("video");
const controlsEl = document.getElementById("controls");
const nowPlayingEl = document.getElementById("nowPlaying");
const seekEl = document.getElementById("seek");
const playPauseBtn = document.getElementById("playPauseBtn");
const nextBtn = document.getElementById("nextBtn");
const autoNextBtn = document.getElementById("autoNextBtn");
const timeTextEl = document.getElementById("timeText");
const volumeEl = document.getElementById("volume");
const speedBtn = document.getElementById("speedBtn");
const speedMenu = document.getElementById("speedMenu");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const queueListEl = document.getElementById("queueList");
const queueToggleBtn = document.getElementById("queueToggleBtn");

const episodePattern = /s[\s._-]*(\d{1,3})[\s._-]*e[\s._-]*(\d{1,4})/i;
const supported = new Set(["mp4", "mkv", "webm", "mov", "avi", "m4v"]);
const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
const DB_KEY = "astralplay.localdb.v3";
const AUTONEXT_KEY = "astralplay.autonext.v3";
const ROOT_DB_FILE = ".astralplay.db.json";
const LEGACY_ROOT_DB_FILE = ".seriesarrange.db.json";

let localDb = loadDb();
let allEpisodes = [];
let activeView = "library";
let activeList = [];
let currentEpisode = null;
let currentEpisodeIndex = -1;
let currentSeasonQueue = [];
let autoNext = localStorage.getItem(AUTONEXT_KEY) !== "false";
let seekActive = false;
let saveTimer = null;
let controlsHideTimer = null;
let rootHandle = null;
let serverRoot = "";
let serverApiReady = false;
let serverApiChecked = false;
let allRowsCollapsed = false;
let queueOpen = false;
const rowPageState = new Map();

function normalizeDb(data) {
  const source = data && typeof data === "object" ? data : {};
  return {
    progress: source.progress && typeof source.progress === "object" && !Array.isArray(source.progress) ? source.progress : {},
    history: Array.isArray(source.history) ? source.history : [],
    thumbCache:
      source.thumbCache && typeof source.thumbCache === "object" && !Array.isArray(source.thumbCache)
        ? source.thumbCache
        : {},
    lastPlayedKey: typeof source.lastPlayedKey === "string" ? source.lastPlayedKey : "",
    libraryCache:
      source.libraryCache && typeof source.libraryCache === "object" && !Array.isArray(source.libraryCache)
        ? {
            fileCount: Number(source.libraryCache.fileCount || 0),
            cachedThumbCount: Number(source.libraryCache.cachedThumbCount || 0),
            files:
              source.libraryCache.files &&
              typeof source.libraryCache.files === "object" &&
              !Array.isArray(source.libraryCache.files)
                ? source.libraryCache.files
                : {},
            updatedAt: typeof source.libraryCache.updatedAt === "string" ? source.libraryCache.updatedAt : "",
          }
        : { fileCount: 0, cachedThumbCount: 0, files: {}, updatedAt: "" },
  };
}

function loadDb() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    return normalizeDb(raw ? JSON.parse(raw) : null);
  } catch {}
  return normalizeDb({});
}

function persistLocalDb() {
  localStorage.setItem(DB_KEY, JSON.stringify(localDb));
}

function persistDb() {
  persistLocalDb();
  writeFolderDbIfPossible();
  if (serverRoot) {
    writeServerDb(localDb);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

async function ensureServerApi() {
  if (serverApiChecked) return serverApiReady;
  serverApiChecked = true;
  try {
    const data = await fetchJson("/api/health");
    serverApiReady = Boolean(data.ok);
  } catch {
    serverApiReady = false;
  }
  return serverApiReady;
}

function isLoopbackHost() {
  const host = String(window.location.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function withCacheBust(url, token = Date.now()) {
  if (!url) return "";
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(token))}`;
}

async function readServerDb(root) {
  const data = await fetchJson(`/api/db?root=${encodeURIComponent(root)}`);
  return normalizeDb(data);
}

async function writeServerDb(patch) {
  if (!serverRoot) return;
  try {
    await fetchJson("/api/db", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: serverRoot, ...patch }),
    });
  } catch (error) {
    console.error("Failed to sync DB to server.", error);
  }
}

function makeServerFileSignature(ep) {
  return `${ep.relPath}::${Number(ep.size || 0)}::${Number(ep.modifiedAt || 0)}`;
}

function buildServerLibraryCache(episodes) {
  const files = {};
  let cachedThumbCount = 0;
  for (const ep of episodes) {
    files[ep.relPath] = makeServerFileSignature(ep);
    if (ep.hasThumb) cachedThumbCount += 1;
  }
  return {
    fileCount: episodes.length,
    cachedThumbCount,
    files,
    updatedAt: new Date().toISOString(),
  };
}

async function writeServerProgress(ep, progress, useBeacon = false) {
  if (!serverRoot || !ep || !progress) return;
  const payload = {
    root: serverRoot,
    key: ep.key,
    currentTime: Number(progress.currentTime || 0),
    duration: Number(progress.duration || 0),
    speed: Number(progress.speed || 1),
    volume: Number(progress.volume || 1),
    lastPlayedKey: localDb.lastPlayedKey || ep.key,
  };

  if (useBeacon && navigator.sendBeacon) {
    try {
      const ok = navigator.sendBeacon("/api/progress", new Blob([JSON.stringify(payload)], { type: "application/json" }));
      if (ok) return;
    } catch {}
  }

  try {
    await fetchJson("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error("Failed to sync progress to server.", error);
  }
}

async function uploadServerThumb(ep, dataUrl) {
  const data = await fetchJson("/api/thumb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root: serverRoot,
      file: ep.relPath,
      dataUrl,
    }),
  });

  ep.hasThumb = true;
  ep.serverThumbPath = data.thumbPath || ep.serverThumbPath;
  ep.thumbUrl = withCacheBust(ep.serverThumbPath, `${Date.now()}-${Math.random()}`);
}

async function readFolderDbIfPossible() {
  if (!rootHandle) return;
  for (const name of [ROOT_DB_FILE, LEGACY_ROOT_DB_FILE]) {
    try {
      const fileHandle = await rootHandle.getFileHandle(name);
      const text = await (await fileHandle.getFile()).text();
      localDb = normalizeDb(JSON.parse(text));
      persistDb();
      return;
    } catch {}
  }
}

async function writeFolderDbIfPossible() {
  if (!rootHandle) return;
  try {
    const fileHandle = await rootHandle.getFileHandle(ROOT_DB_FILE, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(
      JSON.stringify(
        {
          progress: localDb.progress,
          history: localDb.history,
          thumbCache: localDb.thumbCache,
          lastPlayedKey: localDb.lastPlayedKey || "",
          libraryCache: localDb.libraryCache,
          updatedAt: Date.now(),
        },
        null,
        2
      )
    );
    await writable.close();
    try {
      await rootHandle.removeEntry(LEGACY_ROOT_DB_FILE);
    } catch {}
  } catch {}
}

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.className = error ? "status error" : "status";
}

function ext(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function seasonLabel(n) {
  return `S${String(n).padStart(2, "0")}`;
}

function episodeLabel(n) {
  return `E${String(n).padStart(2, "0")}`;
}

function episodeKeyFromMeta(meta) {
  return `${meta.relPath || meta.name}::${meta.size}::${meta.lastModified}`;
}

function parseEpisode(meta) {
  if (!supported.has(ext(meta.name))) return null;
  const match = meta.name.match(episodePattern);
  if (!match) return null;
  const season = Number(match[1]);
  const episode = Number(match[2]);
  const series = meta.name.replace(/\.[^.]+$/, "").slice(0, match.index).replace(/[._-]+/g, " ").trim() || "Unknown Series";
  return {
    key: episodeKeyFromMeta(meta),
    file: meta.file,
    relPath: meta.relPath || meta.name,
    filename: meta.name,
    series,
    season,
    episode,
    thumbUrl: "",
    objectUrl: "",
    streamUrl: "",
  };
}

function flattenServerLibrary(library) {
  const items = [];
  for (const series of library.series || []) {
    for (const season of series.seasons || []) {
      for (const episode of season.episodes || []) {
        items.push({
          key: episode.key,
          file: null,
          relPath: episode.relativePath,
          filename: episode.filename,
          series: series.name,
          season: Number(season.season),
          episode: Number(episode.episode),
          size: Number(episode.size || 0),
          modifiedAt: Number(episode.modifiedAt || 0),
          thumbUrl: episode.hasThumb ? episode.thumbPath || "" : "",
          serverThumbPath: episode.thumbPath || "",
          hasThumb: Boolean(episode.hasThumb),
          objectUrl: "",
          streamUrl: episode.streamPath || "",
        });
      }
    }
  }
  return items;
}

function formatTime(v) {
  const s = Math.max(0, Math.floor(v || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function progressOf(ep) {
  return localDb.progress[ep.key] || null;
}

function progressPct(ep) {
  const p = progressOf(ep);
  if (!p || !p.duration) return 0;
  return Math.max(0, Math.min(100, (p.currentTime / p.duration) * 100));
}

function placeholderThumb(ep) {
  const t = encodeURIComponent(`${ep.series} ${seasonLabel(ep.season)}${episodeLabel(ep.episode)}`);
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'><rect width='100%' height='100%' fill='%2327273a'/><text x='30' y='190' fill='%23cdd6f4' font-size='28' font-family='Segoe UI'>${t}</text></svg>`;
}

function askThumbMode() {
  thumbChoiceModal.classList.remove("hidden");
  return new Promise((resolve) => {
    const done = (mode) => {
      thumbChoiceModal.classList.add("hidden");
      modeSingleBtn.onclick = null;
      modeNoneBtn.onclick = null;
      modeGenerateBtn.onclick = null;
      resolve(mode);
    };
    modeSingleBtn.onclick = () => done("single");
    modeNoneBtn.onclick = () => done("none");
    modeGenerateBtn.onclick = () => done("generate");
  });
}

function askSingleImage() {
  return new Promise((resolve) => {
    singleThumbInput.value = "";
    singleThumbInput.onchange = () => {
      const file = singleThumbInput.files?.[0];
      if (!file) return resolve("");
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width || 640;
        canvas.height = img.naturalHeight || img.height || 360;
        const ctx = canvas.getContext("2d");
        URL.revokeObjectURL(url);
        if (!ctx) return resolve("");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve("");
      };
      img.src = url;
    };
    singleThumbInput.click();
  });
}

async function buildThumb(source) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    let objectUrl = "";
    if (typeof source === "string") {
      v.src = source;
      v.crossOrigin = "anonymous";
    } else {
      objectUrl = URL.createObjectURL(source);
      v.src = objectUrl;
    }
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    const cleanup = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      v.remove();
    };
    const fail = () => {
      cleanup();
      resolve("");
    };
    v.onerror = fail;
    v.onloadedmetadata = () => {
      const target = v.duration > 3 ? Math.min(8, v.duration * 0.25) : 0;
      v.onseeked = () => {
        const c = document.createElement("canvas");
        c.width = 480;
        c.height = 270;
        const ctx = c.getContext("2d");
        if (!ctx) return fail();
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const out = c.toDataURL("image/jpeg", 0.7);
        cleanup();
        resolve(out);
      };
      try {
        v.currentTime = target;
      } catch {
        fail();
      }
    };
  });
}

function activeButtonState() {
  Object.entries(navButtons).forEach(([key, btn]) => btn.classList.toggle("active", key === activeView));
  clearHistoryBtn.classList.toggle("hidden-action", activeView !== "history");
}

function visibleListForView() {
  if (activeView === "continue") {
    return allEpisodes.filter((ep) => {
      const p = progressOf(ep);
      if (!p || !p.duration) return false;
      const percent = (p.currentTime / p.duration) * 100;
      return percent > 2 && percent < 98;
    });
  }
  if (activeView === "history") {
    return [...localDb.history]
      .reverse()
      .map((h) => allEpisodes.find((ep) => ep.key === h.key))
      .filter(Boolean);
  }
  return [...allEpisodes];
}

function groupBySeason(list) {
  const map = new Map();
  for (const ep of list) {
    const key = `${ep.series} • ${seasonLabel(ep.season)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ep);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function cardsPerPage() {
  const width = rowsEl.clientWidth || window.innerWidth || 1200;
  if (width < 640) return 1;
  if (width < 980) return 2;
  if (width < 1350) return 3;
  return 4;
}

function seasonProgress(items) {
  let seen = 0;
  const itemsWithProgress = [];

  for (const ep of items) {
    const p = progressOf(ep);
    if (p && p.duration) {
      itemsWithProgress.push(p);
      seen += p.currentTime;
    }
  }

  if (itemsWithProgress.length === 0) {
    return "0%";
  }

  const avgDuration = itemsWithProgress.reduce((sum, p) => sum + p.duration, 0) / itemsWithProgress.length;
  const total = avgDuration * items.length;

  if (!total) {
    return "0%";
  }

  return `${Math.round((seen / total) * 100)}%`;
}

function makeCard(ep) {
  const card = document.createElement("button");
  card.className = "card";
  card.type = "button";
  card.dataset.episodeKey = ep.key;
  card.addEventListener("click", () => openEpisode(ep));

  const thumb = document.createElement("div");
  thumb.className = "card-thumb";
  const img = document.createElement("img");
  img.src = ep.thumbUrl || placeholderThumb(ep);
  img.alt = ep.filename;
  thumb.appendChild(img);
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = `${seasonLabel(ep.season)}${episodeLabel(ep.episode)}`;
  thumb.appendChild(tag);

  const bar = document.createElement("div");
  bar.className = "progress";
  const fill = document.createElement("div");
  fill.dataset.progressFill = ep.key;
  fill.style.width = `${progressPct(ep)}%`;
  bar.appendChild(fill);

  const meta = document.createElement("div");
  meta.className = "meta";
  const title = document.createElement("strong");
  title.textContent = ep.filename;
  const sub = document.createElement("small");
  sub.dataset.progressText = ep.key;
  const p = progressOf(ep);
  sub.textContent = p?.duration ? `${Math.round(progressPct(ep))}% watched` : `${ep.series} • ${seasonLabel(ep.season)}`;
  meta.append(title, sub);

  card.append(thumb, bar, meta);
  return card;
}

function renderRows() {
  activeButtonState();
  activeList = visibleListForView();
  rowsEl.innerHTML = "";
  if (!activeList.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No episodes for this view.";
    rowsEl.appendChild(empty);
    return;
  }

  const groups = groupBySeason(activeList);
  const perPage = cardsPerPage();
  groups.forEach(([title, items]) => {
    items.sort((a, b) => a.episode - b.episode);
    const block = document.createElement("section");
    block.className = "row-block";

    const header = document.createElement("div");
    header.className = "row-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "row-title-wrap";
    const h = document.createElement("h2");
    h.textContent = `${title} • ${items.length} eps • ${seasonProgress(items)} watched`;
    h.dataset.seasonHeader = title;

    const right = document.createElement("div");
    right.className = "row-controls";
    const toggle = document.createElement("button");
    toggle.className = "row-toggle";
    toggle.textContent = allRowsCollapsed ? "Show" : "Hide";
    const left = document.createElement("button");
    left.className = "row-arrow";
    left.textContent = "<";
    const arrowRight = document.createElement("button");
    arrowRight.className = "row-arrow";
    arrowRight.textContent = ">";
    right.append(toggle, left, arrowRight);
    titleWrap.append(h, right);
    header.append(titleWrap);

    const viewport = document.createElement("div");
    viewport.className = "row-viewport";

    const inner = document.createElement("div");
    inner.className = "row-inner";
    viewport.append(inner);

    const state = {
      start: Math.min(rowPageState.get(title) || 0, Math.max(0, items.length - perPage)),
    };

    const renderPage = () => {
      const maxStart = Math.max(0, items.length - perPage);
      state.start = Math.max(0, Math.min(state.start, maxStart));
      rowPageState.set(title, state.start);

      const pageItems = items.slice(state.start, state.start + perPage);
      inner.innerHTML = "";
      inner.style.setProperty("--per-page", String(Math.max(1, pageItems.length)));
      pageItems.forEach((ep) => inner.appendChild(makeCard(ep)));

      left.disabled = state.start <= 0;
      arrowRight.disabled = state.start >= maxStart;
    };

    left.addEventListener("click", () => {
      state.start -= perPage;
      renderPage();
    });
    arrowRight.addEventListener("click", () => {
      state.start += perPage;
      renderPage();
    });
    renderPage();

    toggle.addEventListener("click", () => {
      const hidden = viewport.classList.toggle("collapsed");
      toggle.textContent = hidden ? "Show" : "Hide";
    });

    if (allRowsCollapsed) {
      viewport.classList.add("collapsed");
    }

    block.append(header, viewport);
    rowsEl.appendChild(block);
  });
}

function refreshProgressUi() {
  document.querySelectorAll("[data-progress-fill]").forEach((el) => {
    const key = el.dataset.progressFill;
    const ep = allEpisodes.find((x) => x.key === key);
    el.style.width = ep ? `${progressPct(ep)}%` : "0%";
  });
  document.querySelectorAll("[data-progress-text]").forEach((el) => {
    const key = el.dataset.progressText;
    const ep = allEpisodes.find((x) => x.key === key);
    const p = ep ? progressOf(ep) : null;
    el.textContent = p?.duration ? `${Math.round(progressPct(ep))}% watched` : "";
  });
  document.querySelectorAll("[data-season-header]").forEach((el) => {
    const title = el.dataset.seasonHeader;
    const items = activeList.filter((ep) => `${ep.series} • ${seasonLabel(ep.season)}` === title);
    el.textContent = `${title} • ${items.length} eps • ${seasonProgress(items)} watched`;
  });
}

async function importFileMetas(metas) {
  if (!metas.length) return setStatus("No files selected.", true);
  await closePlayer();
  const mode = await askThumbMode();
  let singleThumb = "";
  if (mode === "single") {
    singleThumb = await askSingleImage();
  }

  setStatus("Parsing episodes...");
  allEpisodes = metas.map(parseEpisode).filter(Boolean);
  if (!allEpisodes.length) {
    rowsEl.innerHTML = "";
    return setStatus("No S__E__ files found.", true);
  }
  libraryInfoEl.textContent = `${allEpisodes.length} episodes`;
  allEpisodes.forEach((ep) => {
    ep.thumbUrl = localDb.thumbCache[ep.key] || placeholderThumb(ep);
  });
  renderRows();

  if (mode === "single" && singleThumb) {
    allEpisodes.forEach((ep) => {
      ep.thumbUrl = singleThumb;
      localDb.thumbCache[ep.key] = singleThumb;
    });
    persistDb();
    renderRows();
    return setStatus("Using one image for all thumbnails.");
  }
  if (mode === "none") {
    return setStatus("Thumbnails disabled.");
  }

  const missingThumbs = allEpisodes.filter((ep) => !localDb.thumbCache[ep.key]);
  if (!missingThumbs.length) {
    setStatus("Loaded cached thumbnails.");
    return;
  }

  setStatus(`Loaded cache. Generating ${missingThumbs.length} missing thumbnails...`);
  const batch = 8;
  let index = 0;
  while (index < missingThumbs.length) {
    const slice = missingThumbs.slice(index, index + batch);
    await Promise.all(
      slice.map(async (ep) => {
        const t = await buildThumb(ep.file);
        localDb.thumbCache[ep.key] = t || placeholderThumb(ep);
        ep.thumbUrl = localDb.thumbCache[ep.key];
      })
    );
    index += slice.length;
    allEpisodes.forEach((ep) => {
      ep.thumbUrl = localDb.thumbCache[ep.key] || ep.thumbUrl || placeholderThumb(ep);
    });
    renderRows();
    setStatus(`Generated ${index}/${missingThumbs.length} missing thumbnails...`);
  }
  persistDb();
  setStatus("Library ready.");
}

async function processServerThumbnails(mode, singleThumb = "", targetsOverride = null) {
  if (mode === "none") {
    allEpisodes.forEach((ep) => {
      ep.thumbUrl = ep.hasThumb ? ep.serverThumbPath : placeholderThumb(ep);
    });
    renderRows();
    setStatus("Using cached thumbnails only.");
    return;
  }

  const targets = Array.isArray(targetsOverride)
    ? targetsOverride
    : mode === "single"
      ? allEpisodes
      : allEpisodes.filter((ep) => !ep.hasThumb && ep.streamUrl);

  if (!targets.length) {
    allEpisodes.forEach((ep) => {
      ep.thumbUrl = ep.hasThumb ? ep.serverThumbPath : ep.thumbUrl;
    });
    renderRows();
    setStatus("Library ready from disk cache.");
    return;
  }

  const batchSize = 4;
  let completed = 0;
  let saved = 0;
  const total = targets.length;

  while (completed < total) {
    const slice = targets.slice(completed, completed + batchSize);
    const results = await Promise.all(
      slice.map(async (ep) => {
        try {
          const dataUrl = mode === "single" ? singleThumb : await buildThumb(ep.streamUrl);
          if (!dataUrl) return false;
          await uploadServerThumb(ep, dataUrl);
          return true;
        } catch (error) {
          console.error(`Failed to save thumbnail for ${ep.filename}.`, error);
          return false;
        }
      })
    );

    saved += results.filter(Boolean).length;
    completed += slice.length;
    renderRows();
    setStatus(`Saved ${saved}/${total} thumbnails to .astralplay_thumbs...`);
  }

  setStatus(
    saved ? `Saved ${saved} thumbnails to .astralplay_thumbs.` : "No thumbnails could be generated for this folder.",
    saved === 0
  );

  if (serverRoot) {
    try {
      localDb.libraryCache = buildServerLibraryCache(allEpisodes);
      persistLocalDb();
      await writeServerDb({ libraryCache: localDb.libraryCache });
    } catch (error) {
      console.error("Failed to sync library cache to server.", error);
    }
  }
}

async function importServerLibrary(root) {
  await closePlayer();
  setStatus("Scanning folder on local server...");
  const [library, db] = await Promise.all([
    fetchJson(`/api/library?root=${encodeURIComponent(root)}`),
    readServerDb(root),
  ]);

  serverRoot = root;
  rootHandle = null;
  
  // Merge server progress into local progress
  for (const key in db.progress) {
    if (!localDb.progress[key] || db.progress[key].updatedAt > localDb.progress[key].updatedAt) {
      localDb.progress[key] = db.progress[key];
    }
  }

  // Merge server history into local history
  const historyMap = new Map();
  for (const item of localDb.history) {
    historyMap.set(item.key, item);
  }
  for (const item of db.history) {
    if (!historyMap.has(item.key) || item.at > historyMap.get(item.key).at) {
      historyMap.set(item.key, item);
    }
  }
  localDb.history = Array.from(historyMap.values()).sort((a, b) => a.at - b.at);

  // Update the rest of the localDb with server data
  localDb.thumbCache = db.thumbCache;
  localDb.lastPlayedKey = db.lastPlayedKey;
  localDb.libraryCache = db.libraryCache;

  persistLocalDb();

  allEpisodes = flattenServerLibrary(library);
  if (!allEpisodes.length) {
    rowsEl.innerHTML = "";
    libraryInfoEl.textContent = "0 episodes";
    return setStatus("No S__E__ files found in selected folder.", true);
  }

  allEpisodes.forEach((ep) => {
    ep.thumbUrl = ep.hasThumb ? ep.serverThumbPath : placeholderThumb(ep);
  });
  libraryInfoEl.textContent = `${allEpisodes.length} episodes`;
  renderRows();

  const previousFiles = localDb.libraryCache?.files || {};
  const currentCache = buildServerLibraryCache(allEpisodes);
  const addedEpisodes = allEpisodes.filter((ep) => {
    const previousSignature = previousFiles[ep.relPath];
    return previousSignature !== makeServerFileSignature(ep);
  });
  const missingThumbs = allEpisodes.filter((ep) => !ep.hasThumb && ep.streamUrl);
  const targets = addedEpisodes.filter((ep) => !ep.hasThumb && ep.streamUrl);
  const unchangedLibrary =
    currentCache.fileCount === Number(localDb.libraryCache?.fileCount || 0) &&
    addedEpisodes.length === 0 &&
    missingThumbs.length === 0;

  if (unchangedLibrary) {
    localDb.libraryCache = currentCache;
    persistLocalDb();
    return setStatus(
      `Loaded folder DB cache. ${currentCache.fileCount} files, ${currentCache.cachedThumbCount} thumbnails, history restored.`
    );
  }

  if (!missingThumbs.length) {
    localDb.libraryCache = currentCache;
    persistLocalDb();
    await writeServerDb({ libraryCache: currentCache });
    return setStatus(
      `Loaded folder cache. ${currentCache.fileCount} files scanned, no new thumbnails needed, history restored.`
    );
  }

  const mode = await askThumbMode();
  let singleThumb = "";
  if (mode === "single") {
    singleThumb = await askSingleImage();
    if (!singleThumb) {
      return setStatus("No image selected for thumbnails.", true);
    }
  }

  if (mode === "generate" && targets.length === 0) {
    localDb.libraryCache = currentCache;
    persistLocalDb();
    await writeServerDb({ libraryCache: currentCache });
    return setStatus(
      `No new files to cache. Loaded existing thumbnails from .astralplay_thumbs for ${currentCache.cachedThumbCount}/${currentCache.fileCount} files.`
    );
  }

  if (mode === "generate" && targets.length > 0) {
    await processServerThumbnails(mode, singleThumb, targets);
    localDb.libraryCache = buildServerLibraryCache(allEpisodes);
    persistLocalDb();
    await writeServerDb({ libraryCache: localDb.libraryCache });
    return;
  }

  await processServerThumbnails(mode, singleThumb);
}

function openImportChoice() {
  importChoiceModal.classList.remove("hidden");
}

function closeImportChoice() {
  importChoiceModal.classList.add("hidden");
}

async function collectFromDirectoryHandle(handle, prefix = "") {
  const out = [];
  for await (const [name, entry] of handle.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === "directory") {
      out.push(...(await collectFromDirectoryHandle(entry, rel)));
    } else if (entry.kind === "file") {
      const file = await entry.getFile();
      out.push({ name: file.name, relPath: rel, size: file.size, lastModified: file.lastModified, file });
    }
  }
  return out;
}

async function pickFolder() {
  if (isLoopbackHost()) {
    const serverAvailable = await ensureServerApi();
    if (!serverAvailable) {
      setStatus("Localhost mode requires the Node server APIs. Run this app with node server.js.", true);
      return;
    }

    try {
      setStatus("Opening folder on local server...");
      const selection = await fetchJson("/api/pick-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await importServerLibrary(selection.root);
      return;
    } catch (error) {
      setStatus(error.message || "Failed to open folder on local server.", true);
      return;
    }
  }

  if (window.showDirectoryPicker) {
    try {
      setStatus("Opening folder...");
      serverRoot = "";
      rootHandle = await window.showDirectoryPicker();
      await readFolderDbIfPossible();
      const files = await collectFromDirectoryHandle(rootHandle);
      return importFileMetas(files);
    } catch {
      setStatus("Folder picker canceled, fallback to upload.", true);
    }
  }
  folderInput.click();
}

async function handleFolderInput(files) {
  serverRoot = "";
  rootHandle = null;
  await importFileMetas(
    Array.from(files || []).map((file) => ({
      name: file.name,
      relPath: file.webkitRelativePath || file.name,
      size: file.size,
      lastModified: file.lastModified,
      file,
    }))
  );
}

async function handleFilesInput(files) {
  serverRoot = "";
  rootHandle = null;
  await importFileMetas(
    Array.from(files || []).map((file) => ({
      name: file.name,
      relPath: file.name,
      size: file.size,
      lastModified: file.lastModified,
      file,
    }))
  );
  if (isLoopbackHost()) {
    setStatus("Open Files uses browser cache only. Use Open Folder on localhost for db.json and .astralplay_thumbs.");
  }
}

function addHistory(ep) {
  localDb.history = localDb.history.filter((entry) => entry.key !== ep.key);
  localDb.history.push({ key: ep.key, at: Date.now() });
  if (localDb.history.length > 2000) localDb.history = localDb.history.slice(-2000);
  persistDb();
  if (serverRoot) {
    void writeServerDb({
      history: localDb.history,
      lastPlayedKey: localDb.lastPlayedKey || ep.key,
    });
  }
}

function saveCurrentProgress(options = {}) {
  if (!currentEpisode) return;
  localDb.lastPlayedKey = currentEpisode.key;
  const progress = {
    currentTime: Number(videoEl.currentTime || 0),
    duration: Number(videoEl.duration || 0),
    volume: Number(videoEl.volume || 1),
    speed: Number(videoEl.playbackRate || 1),
    updatedAt: Date.now(),
  };
  localDb.progress[currentEpisode.key] = progress;
  persistDb();
  if (serverRoot && options.useBeacon) {
    void writeServerProgress(currentEpisode, progress, options.useBeacon === true);
  }
}

function queueSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCurrentProgress();
    persistDb();
    refreshProgressUi();
  }, 1400);
}

function clearControlsHideTimer() {
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
}

function isPlayerFullscreen() {
  return document.fullscreenElement === videoWrap;
}

function syncFullscreenState() {
  const fullscreen = isPlayerFullscreen();
  playerModal.classList.toggle("fullscreen-mode", fullscreen);
  if (!fullscreen) {
    clearControlsHideTimer();
    controlsEl.classList.add("visible");
  }
}

function setQueueOpen(open) {
  queueOpen = Boolean(open) && window.innerWidth <= 1100;
  playerModal.classList.toggle("queue-open", queueOpen);
  queueToggleBtn.textContent = queueOpen ? "Hide Next" : "Up Next";
}

function showControls() {
  clearControlsHideTimer();
  controlsEl.classList.add("visible");
  if (isPlayerFullscreen() && !videoEl.paused) {
    controlsHideTimer = setTimeout(() => {
      controlsEl.classList.remove("visible");
      controlsHideTimer = null;
    }, 6000);
  }
}

function updateTimeUi() {
  const cur = videoEl.currentTime || 0;
  const dur = videoEl.duration || 0;
  timeTextEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  if (!seekActive) seekEl.value = dur > 0 ? String((cur / dur) * 100) : "0";
}

function seasonQueueFor(ep) {
  return allEpisodes
    .filter((x) => x.series === ep.series && x.season === ep.season)
    .sort((a, b) => a.episode - b.episode);
}

function updateQueue() {
  queueListEl.innerHTML = "";
  currentSeasonQueue.forEach((ep) => {
    const item = document.createElement("button");
    item.className = ep.key === currentEpisode?.key ? "queue-item active" : "queue-item";
    item.innerHTML = `<img src="${ep.thumbUrl || placeholderThumb(ep)}" alt="${ep.filename}" /><div><strong>${ep.filename}</strong><small>${ep.series} • ${seasonLabel(ep.season)}</small></div>`;
    item.addEventListener("click", () => openEpisode(ep));
    queueListEl.appendChild(item);
  });
}

async function closePlayer() {
  if (isPlayerFullscreen()) {
    try {
      await document.exitFullscreen?.();
    } catch {}
  }
  clearControlsHideTimer();
  setQueueOpen(false);
  speedMenu.classList.add("hidden");
  playerModal.classList.add("hidden");
  playerModal.classList.remove("fullscreen-mode");
  document.body.classList.remove("player-open");
  videoEl.pause();
  if (currentEpisode?.objectUrl) {
    URL.revokeObjectURL(currentEpisode.objectUrl);
    currentEpisode.objectUrl = "";
  }
  videoEl.removeAttribute("src");
  videoEl.load();
  currentEpisode = null;
}

async function openEpisode(ep) {
  const previousEpisode = currentEpisode;
  if (previousEpisode?.objectUrl && previousEpisode !== ep) {
    URL.revokeObjectURL(previousEpisode.objectUrl);
    previousEpisode.objectUrl = "";
  }
  currentEpisode = ep;
  currentEpisodeIndex = activeList.findIndex((x) => x.key === ep.key);
  currentSeasonQueue = seasonQueueFor(ep);
  nowPlayingEl.textContent = `${ep.series} • ${seasonLabel(ep.season)} ${episodeLabel(ep.episode)} • ${ep.filename}`;

  if (ep.file) {
    if (ep.objectUrl) URL.revokeObjectURL(ep.objectUrl);
    ep.objectUrl = URL.createObjectURL(ep.file);
    videoEl.src = ep.objectUrl;
  } else {
    ep.objectUrl = "";
    videoEl.src = ep.streamUrl;
  }

  const p = progressOf(ep);
  videoEl.volume = p?.volume ?? 1;
  volumeEl.value = String(videoEl.volume);
  videoEl.playbackRate = p?.speed ?? p?.playbackRate ?? 1;
  speedBtn.textContent = `${videoEl.playbackRate}x`;

  setQueueOpen(false);
  playerModal.classList.remove("hidden");
  playerModal.classList.remove("fullscreen-mode");
  document.body.classList.add("player-open");
  localDb.lastPlayedKey = ep.key;
  addHistory(ep);
  updateQueue();

  videoEl.addEventListener(
    "loadedmetadata",
    async () => {
      if (p?.currentTime && p.currentTime < (videoEl.duration || 0) - 8) {
        videoEl.currentTime = p.currentTime;
      }
      updateTimeUi();
      await videoEl.play().catch(() => {});
      playPauseBtn.textContent = videoEl.paused ? "Play" : "Pause";
      showControls();
    },
    { once: true }
  );
}

async function playNext() {
  if (!currentEpisode) return;
  const i = currentSeasonQueue.findIndex((x) => x.key === currentEpisode.key);
  const next = currentSeasonQueue[i + 1];
  if (next) await openEpisode(next);
}

function initSpeedMenu() {
  speedMenu.innerHTML = "";
  speeds.forEach((s) => {
    const item = document.createElement("button");
    item.className = "speed-item";
    item.textContent = `${s}x`;
    item.addEventListener("click", () => {
      videoEl.playbackRate = s;
      speedBtn.textContent = `${s}x`;
      speedMenu.classList.add("hidden");
      queueSave();
    });
    speedMenu.appendChild(item);
  });
}

Object.entries(navButtons).forEach(([key, btn]) => {
  btn.addEventListener("click", () => {
    activeView = key;
    renderRows();
    if (key === "continue") {
      const last = allEpisodes.find((ep) => ep.key === localDb.lastPlayedKey);
      if (last) {
        openEpisode(last);
      } else {
        setStatus("No last played episode found in DB.", true);
      }
    }
    if (window.innerWidth <= 1100) sidebarEl.classList.remove("open");
  });
});

toggleAllRowsBtn.addEventListener("click", () => {
  allRowsCollapsed = !allRowsCollapsed;
  toggleAllRowsBtn.textContent = allRowsCollapsed ? "Show All Seasons" : "Hide All Seasons";
  renderRows();
});

menuBtn.addEventListener("click", () => {
  sidebarEl.classList.toggle("open");
});

importBtn.addEventListener("click", openImportChoice);
pickFolderChoiceBtn.addEventListener("click", () => {
  closeImportChoice();
  pickFolder();
});
pickFilesChoiceBtn.addEventListener("click", () => {
  closeImportChoice();
  filesInput.click();
});
closeImportChoiceBtn.addEventListener("click", closeImportChoice);
folderInput.addEventListener("change", () => handleFolderInput(folderInput.files));
filesInput.addEventListener("change", () => handleFilesInput(filesInput.files));
clearHistoryBtn.addEventListener("click", () => {
  if (!window.confirm("Clear playback history?")) return;
  localDb.history = [];
  persistDb();
  if (serverRoot) {
    void writeServerDb({ history: [] });
  }
  renderRows();
  setStatus("History cleared.");
});

playerBackdrop.addEventListener("click", () => {
  if (queueOpen) {
    setQueueOpen(false);
    return;
  }
  closePlayer();
});
closePlayerBtn.addEventListener("click", closePlayer);
queueToggleBtn.addEventListener("click", () => setQueueOpen(!queueOpen));

playPauseBtn.addEventListener("click", async () => {
  if (videoEl.paused) await videoEl.play().catch(() => {});
  else videoEl.pause();
  playPauseBtn.textContent = videoEl.paused ? "Play" : "Pause";
  showControls();
});
nextBtn.addEventListener("click", playNext);
autoNextBtn.addEventListener("click", () => {
  autoNext = !autoNext;
  localStorage.setItem(AUTONEXT_KEY, String(autoNext));
  autoNextBtn.textContent = `Auto Next: ${autoNext ? "On" : "Off"}`;
  showControls();
});

seekEl.addEventListener("input", () => {
  seekActive = true;
  const dur = videoEl.duration || 0;
  const t = (Number(seekEl.value) / 100) * dur;
  timeTextEl.textContent = `${formatTime(t)} / ${formatTime(dur)}`;
});
seekEl.addEventListener("change", () => {
  const dur = videoEl.duration || 0;
  videoEl.currentTime = (Number(seekEl.value) / 100) * dur;
  seekActive = false;
  queueSave();
  showControls();
});

volumeEl.addEventListener("input", () => {
  videoEl.volume = Number(volumeEl.value);
  queueSave();
  showControls();
});

speedBtn.addEventListener("click", () => {
  speedMenu.classList.toggle("hidden");
  showControls();
});

fullscreenBtn.addEventListener("click", async () => {
  if (!document.fullscreenElement) await videoWrap.requestFullscreen?.();
  else await document.exitFullscreen?.();
  syncFullscreenState();
  showControls();
});

document.addEventListener("fullscreenchange", () => {
  syncFullscreenState();
  if (isPlayerFullscreen()) showControls();
});

document.addEventListener("click", (e) => {
  if (!speedMenu.contains(e.target) && e.target !== speedBtn) speedMenu.classList.add("hidden");
});

videoWrap.addEventListener("mousemove", showControls);
videoWrap.addEventListener("click", (e) => {
  if (e.target === videoEl) {
    if (videoEl.paused) videoEl.play().catch(() => {});
    else videoEl.pause();
  }
  showControls();
});

videoEl.addEventListener("timeupdate", () => {
  updateTimeUi();
  queueSave();
});
videoEl.addEventListener("pause", () => {
  playPauseBtn.textContent = "Play";
  controlsEl.classList.add("visible");
  clearControlsHideTimer();
  queueSave();
});
videoEl.addEventListener("play", () => {
  playPauseBtn.textContent = "Pause";
  showControls();
});
videoEl.addEventListener("ended", async () => {
  saveCurrentProgress();
  persistDb();
  refreshProgressUi();
  if (autoNext) await playNext();
});

window.addEventListener("beforeunload", () => {
  saveCurrentProgress({ useBeacon: true });
  persistDb();
});

document.addEventListener("keydown", (e) => {
  if (playerModal.classList.contains("hidden")) return;
  const key = e.key.toLowerCase();
  if (key === " " || key === "k") {
    e.preventDefault();
    if (videoEl.paused) videoEl.play().catch(() => {});
    else videoEl.pause();
    return;
  }
  if (key === "arrowleft") {
    e.preventDefault();
    videoEl.currentTime = Math.max(0, (videoEl.currentTime || 0) - 5);
    return;
  }
  if (key === "arrowright") {
    e.preventDefault();
    videoEl.currentTime = Math.min(videoEl.duration || Infinity, (videoEl.currentTime || 0) + 5);
    return;
  }
  if (key === "j") {
    e.preventDefault();
    videoEl.currentTime = Math.max(0, (videoEl.currentTime || 0) - 10);
    return;
  }
  if (key === "l") {
    e.preventDefault();
    videoEl.currentTime = Math.min(videoEl.duration || Infinity, (videoEl.currentTime || 0) + 10);
    return;
  }
  if (key === "f") {
    e.preventDefault();
    if (!document.fullscreenElement) videoWrap.requestFullscreen?.();
    else document.exitFullscreen?.();
    return;
  }
  if (key === "m") {
    e.preventDefault();
    videoEl.muted = !videoEl.muted;
    return;
  }
  if (key === "escape") {
    e.preventDefault();
    closePlayer();
  }
});

initSpeedMenu();
autoNextBtn.textContent = `Auto Next: ${autoNext ? "On" : "Off"}`;
toggleAllRowsBtn.textContent = "Hide All Seasons";
window.addEventListener("resize", () => {
  setQueueOpen(false);
  renderRows();
});
renderRows();
