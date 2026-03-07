const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const { spawn, execFile } = require("child_process");

const PORT = Number(process.env.PORT || 3333);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const ICON_DIR = path.join(__dirname, "icon");
const ROOT_DB_FILE = ".astralplay.db.json";
const LEGACY_ROOT_DB_FILE = ".seriesarrange.db.json";
const THUMB_DIR_NAME = ".astralplay_thumbs";
const LEGACY_THUMB_DIR_NAME = ".seriesarrange_thumbs";
const MEDIA_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"]);
const thumbJobs = new Map();

const episodePattern = /s[\s._-]*(\d{1,3})[\s._-]*e[\s._-]*(\d{1,4})/i;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".avi") return "video/x-msvideo";
  return "application/octet-stream";
}

async function fileExists(targetPath) {
  return fsp.access(targetPath, fs.constants.F_OK).then(() => true).catch(() => false);
}

function safeResolveMediaPath(rawPath) {
  if (!rawPath) return null;
  const normalized = path.normalize(rawPath);
  return path.resolve(normalized);
}

function extractEpisodeInfo(filename) {
  const match = filename.match(episodePattern);
  if (!match) return null;

  const season = Number(match[1]);
  const episode = Number(match[2]);
  const title = filename.replace(path.extname(filename), "");
  const series = title.slice(0, match.index).replace(/[._-]+/g, " ").trim() || "Unknown Series";

  return { series, season, episode };
}

function findLanIp() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry && entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

async function walkFiles(rootDir) {
  const queue = [rootDir];
  const files = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  return files;
}

async function scanLibrary(rootDir) {
  const absRoot = safeResolveMediaPath(rootDir);
  if (!absRoot) {
    throw new Error("Missing root directory.");
  }
  const stat = await fsp.stat(absRoot).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error("Root directory not found.");
  }

  const files = await walkFiles(absRoot);
  const bySeries = new Map();

  for (const fullPath of files) {
    const ext = path.extname(fullPath).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(ext)) continue;

    const filename = path.basename(fullPath);
    const episodeInfo = extractEpisodeInfo(filename);
    if (!episodeInfo) continue;

    if (!bySeries.has(episodeInfo.series)) {
      bySeries.set(episodeInfo.series, new Map());
    }

    const seasons = bySeries.get(episodeInfo.series);
    if (!seasons.has(episodeInfo.season)) {
      seasons.set(episodeInfo.season, []);
    }

    const relativePath = canonicalRelativeFile(path.relative(absRoot, fullPath));
    const stat = await fsp.stat(fullPath).catch(() => null);
    const hasThumb = await fileExists(thumbFilePath(absRoot, relativePath));
    seasons.get(episodeInfo.season).push({
      episode: episodeInfo.episode,
      filename,
      relativePath,
      size: stat?.size || 0,
      modifiedAt: stat?.mtimeMs || 0,
      streamPath: `/api/stream?root=${encodeURIComponent(absRoot)}&file=${encodeURIComponent(relativePath)}`,
      thumbPath: `/api/thumb?root=${encodeURIComponent(absRoot)}&file=${encodeURIComponent(relativePath)}`,
      hasThumb,
      key: `${absRoot}::${relativePath}`,
    });
  }

  const seriesList = Array.from(bySeries.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([seriesName, seasonsMap]) => {
      const seasons = Array.from(seasonsMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([seasonNumber, episodes]) => ({
          season: seasonNumber,
          episodes: episodes.sort((a, b) => a.episode - b.episode),
        }));

      const episodeCount = seasons.reduce((sum, s) => sum + s.episodes.length, 0);
      return { name: seriesName, seasons, episodeCount };
    });

  return {
    root: absRoot,
    seriesCount: seriesList.length,
    series: seriesList,
  };
}

async function validateRootDir(rootDir) {
  const absRoot = safeResolveMediaPath(rootDir);
  if (!absRoot) {
    throw new Error("Missing root directory.");
  }
  const stat = await fsp.stat(absRoot).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error("Root directory not found.");
  }
  return absRoot;
}

function dbPathForRoot(absRoot) {
  return path.join(absRoot, ROOT_DB_FILE);
}

function normalizeDb(data) {
  const source = data && typeof data === "object" ? data : {};
  return {
    progress:
      source.progress && typeof source.progress === "object" && !Array.isArray(source.progress) ? source.progress : {},
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

async function migrateRootStorage(absRoot) {
  const dbPath = path.join(absRoot, ROOT_DB_FILE);
  const legacyDbPath = path.join(absRoot, LEGACY_ROOT_DB_FILE);
  const thumbDir = path.join(absRoot, THUMB_DIR_NAME);
  const legacyThumbDir = path.join(absRoot, LEGACY_THUMB_DIR_NAME);

  const dbExists = await fsp.access(dbPath, fs.constants.F_OK).then(() => true).catch(() => false);
  const legacyDbExists = await fsp.access(legacyDbPath, fs.constants.F_OK).then(() => true).catch(() => false);
  if (!dbExists && legacyDbExists) {
    try {
      await fsp.rename(legacyDbPath, dbPath);
    } catch {
      const raw = await fsp.readFile(legacyDbPath, "utf8").catch(() => "");
      if (raw) {
        await fsp.writeFile(dbPath, raw, "utf8");
      }
    }
  }

  const thumbExists = await fsp.access(thumbDir, fs.constants.F_OK).then(() => true).catch(() => false);
  const legacyThumbExists = await fsp.access(legacyThumbDir, fs.constants.F_OK).then(() => true).catch(() => false);
  if (!thumbExists && legacyThumbExists) {
    try {
      await fsp.rename(legacyThumbDir, thumbDir);
    } catch {}
  }
}

async function readRootDb(absRoot) {
  await migrateRootStorage(absRoot);
  const dbPath = dbPathForRoot(absRoot);
  const exists = await fsp.access(dbPath, fs.constants.F_OK).then(() => true).catch(() => false);
  if (!exists) {
    const empty = normalizeDb({});
    await fsp.writeFile(dbPath, JSON.stringify(empty, null, 2), "utf8");
    return empty;
  }

  const raw = await fsp.readFile(dbPath, "utf8");
  try {
    return normalizeDb(JSON.parse(raw));
  } catch {}
  return normalizeDb({});
}

async function writeRootDb(absRoot, data) {
  await migrateRootStorage(absRoot);
  const dbPath = dbPathForRoot(absRoot);
  const normalized = normalizeDb(data);
  normalized.updatedAt = new Date().toISOString();
  await fsp.writeFile(dbPath, JSON.stringify(normalized, null, 2), "utf8");
}

function thumbDirForRoot(absRoot) {
  return path.join(absRoot, THUMB_DIR_NAME);
}

function canonicalRelativeFile(relativeFile) {
  return path.normalize(String(relativeFile || "")).replaceAll("\\", "/");
}

function thumbFilePath(absRoot, relativeFile) {
  const encoded = Buffer.from(canonicalRelativeFile(relativeFile)).toString("base64url");
  return path.join(thumbDirForRoot(absRoot), `${encoded}.jpg`);
}

async function writeThumbnail(absRoot, relativeFile, dataBuffer) {
  const safeRelative = canonicalRelativeFile(relativeFile);
  const fullPath = path.resolve(path.join(absRoot, safeRelative));
  if (!fullPath.startsWith(absRoot)) {
    throw new Error("Invalid file path.");
  }

  const outputFile = thumbFilePath(absRoot, safeRelative);
  await fsp.mkdir(path.dirname(outputFile), { recursive: true });
  await fsp.writeFile(outputFile, dataBuffer);
}

async function generateThumbnail(absRoot, relativeFile, outputFile) {
  const fullPath = path.resolve(path.join(absRoot, canonicalRelativeFile(relativeFile)));
  if (!fullPath.startsWith(absRoot)) {
    throw new Error("Invalid file path.");
  }

  await fsp.mkdir(path.dirname(outputFile), { recursive: true });
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      ["-y", "-ss", "00:00:10", "-i", fullPath, "-frames:v", "1", "-vf", "scale=640:-1", outputFile],
      { windowsHide: true, stdio: "ignore" }
    );

    ffmpeg.on("error", () => reject(new Error("ffmpeg not available.")));
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("ffmpeg thumbnail generation failed."));
    });
  });
}

function placeholderSvgBase64(title) {
  const safeTitle = String(title || "Episode").replace(/[<>&"]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stop-color="#313244"/><stop offset="100%" stop-color="#1e1e2e"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="540" cy="70" r="110" fill="#cba6f7" fill-opacity="0.25"/><circle cx="80" cy="320" r="130" fill="#89b4fa" fill-opacity="0.2"/><text x="28" y="190" fill="#f5e0dc" font-size="32" font-family="Segoe UI, Arial, sans-serif">${safeTitle}</text></svg>`;
  return Buffer.from(svg, "utf8").toString("base64");
}

async function handleThumbnail(req, res, root, relativeFile) {
  let absRoot;
  try {
    absRoot = await validateRootDir(root);
  } catch {
    absRoot = null;
  }
  if (!absRoot || !relativeFile) {
    sendText(res, 400, "Missing root or file.");
    return;
  }

  const safeRelative = canonicalRelativeFile(relativeFile);
  const outputFile = thumbFilePath(absRoot, safeRelative);
  const title = path.basename(safeRelative).replace(path.extname(safeRelative), "");
  const exists = await fsp.access(outputFile, fs.constants.F_OK).then(() => true).catch(() => false);

  if (!exists) {
    const jobKey = `${absRoot}::${safeRelative}`;
    if (!thumbJobs.has(jobKey)) {
      const job = generateThumbnail(absRoot, safeRelative, outputFile).finally(() => thumbJobs.delete(jobKey));
      thumbJobs.set(jobKey, job);
    }
    try {
      await thumbJobs.get(jobKey);
    } catch {
      const svgData = placeholderSvgBase64(title);
      const body = Buffer.from(svgData, "base64");
      res.writeHead(200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=600",
        "Content-Length": body.length,
      });
      res.end(body);
      return;
    }
  }

  try {
    const file = await fsp.readFile(outputFile);
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      "Content-Length": file.length,
    });
    res.end(file);
  } catch {
    const svgData = placeholderSvgBase64(title);
    const body = Buffer.from(svgData, "base64");
    res.writeHead(200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=600",
      "Content-Length": body.length,
    });
    res.end(body);
  }
}

async function handleThumbnailUpload(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 10 * 1024 * 1024) req.destroy();
  });

  req.on("end", async () => {
    try {
      const payload = JSON.parse(body || "{}");
      if (!payload || typeof payload !== "object" || !payload.root || !payload.file || !payload.dataUrl) {
        sendJson(res, 400, { error: "Invalid payload." });
        return;
      }

      const match = /^data:image\/jpeg;base64,(.+)$/i.exec(String(payload.dataUrl));
      if (!match) {
        sendJson(res, 400, { error: "Only JPEG thumbnail uploads are supported." });
        return;
      }

      const absRoot = await validateRootDir(payload.root);
      const buffer = Buffer.from(match[1], "base64");
      await writeThumbnail(absRoot, payload.file, buffer);
      sendJson(res, 200, { ok: true, thumbPath: `/api/thumb?root=${encodeURIComponent(absRoot)}&file=${encodeURIComponent(payload.file)}` });
    } catch (error) {
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return;
      }
      sendJson(res, 400, { error: error.message || "Failed to save thumbnail." });
    }
  });
}

function openFolder(absPath) {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("explorer.exe", [absPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (platform === "darwin") {
    spawn("open", [absPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [absPath], { detached: true, stdio: "ignore" }).unref();
}

function pickFolderDialog() {
  if (process.platform === "win32") {
    return new Promise((resolve, reject) => {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$dialog.Description = 'Select series root folder'",
        "$dialog.ShowNewFolderButton = $false",
        "if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Write($dialog.SelectedPath) }",
      ].join("; ");

      execFile(
        "powershell.exe",
        ["-NoProfile", "-STA", "-Command", script],
        { timeout: 120000, windowsHide: false, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(new Error("Folder dialog failed."));
            return;
          }
          const selected = String(stdout || "").trim();
          if (!selected) {
            reject(new Error("Folder selection cancelled."));
            return;
          }
          resolve(selected);
        }
      );
    });
  }

  return Promise.reject(new Error("Folder picker dialog is currently implemented for Windows."));
}

async function serveStatic(req, res, pathname) {
  const targetPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(targetPath).replace(/^(\.\.[/\\])+/, "");

  let baseDir = PUBLIC_DIR;
  let relativePath = safePath;
  if (pathname === "/favicon.ico") {
    baseDir = ICON_DIR;
    relativePath = "favicon.ico";
  } else if (pathname.startsWith("/icon/")) {
    baseDir = ICON_DIR;
    relativePath = safePath.replace(/^[/\\]?icon[/\\]?/, "");
  }

  const filePath = path.join(baseDir, relativePath);
  if (!filePath.startsWith(baseDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const content = await fsp.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "Content-Length": content.length,
    });
    res.end(content);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function handleStream(req, res, root, relativeFile) {
  let absRoot;
  try {
    absRoot = await validateRootDir(root);
  } catch {
    absRoot = null;
  }
  if (!absRoot || !relativeFile) {
    sendText(res, 400, "Missing root or file.");
    return;
  }

  const safeRelative = path.normalize(relativeFile);
  const fullPath = path.resolve(path.join(absRoot, safeRelative));
  if (!fullPath.startsWith(absRoot)) {
    sendText(res, 403, "Invalid file path.");
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(fullPath);
  } catch {
    sendText(res, 404, "File not found.");
    return;
  }

  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = mimeType(fullPath);
  const baseHeaders = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
  };

  if (!range) {
    res.writeHead(200, { ...baseHeaders, "Content-Length": fileSize });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    sendText(res, 416, "Invalid range.");
    return;
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : fileSize - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
    sendText(res, 416, "Range not satisfiable.");
    return;
  }

  const chunkSize = end - start + 1;
  res.writeHead(206, {
    ...baseHeaders,
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Content-Length": chunkSize,
  });
  fs.createReadStream(fullPath, { start, end }).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = requestUrl;

  if (pathname === "/api/library" && req.method === "GET") {
    const root = searchParams.get("root");
    try {
      const absRoot = await validateRootDir(root);
      const library = await scanLibrary(absRoot);
      library.dbFile = dbPathForRoot(absRoot);
      sendJson(res, 200, library);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Failed to scan library." });
    }
    return;
  }

  if (pathname === "/api/progress" && req.method === "GET") {
    const root = searchParams.get("root");
    try {
      const absRoot = await validateRootDir(root);
      const db = await readRootDb(absRoot);
      sendJson(res, 200, db.progress);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Failed to read progress." });
    }
    return;
  }

  if (pathname === "/api/progress" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        if (!payload || typeof payload !== "object" || !payload.key || !payload.root) {
          sendJson(res, 400, { error: "Invalid payload." });
          return;
        }

        const absRoot = await validateRootDir(payload.root);
        const db = await readRootDb(absRoot);
        db.progress[payload.key] = {
          currentTime: Number(payload.currentTime || 0),
          duration: Number(payload.duration || 0),
          speed: Number(payload.speed ?? payload.playbackRate ?? 1),
          volume: Number(payload.volume || 1),
          updatedAt: new Date().toISOString(),
        };
        if (typeof payload.lastPlayedKey === "string") {
          db.lastPlayedKey = payload.lastPlayedKey;
        }
        await writeRootDb(absRoot, db);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        if (error instanceof SyntaxError) {
          sendJson(res, 400, { error: "Invalid JSON body." });
          return;
        }
        sendJson(res, 400, { error: error.message || "Failed to save progress." });
      }
    });
    return;
  }

  if (pathname === "/api/db" && req.method === "GET") {
    const root = searchParams.get("root");
    try {
      const absRoot = await validateRootDir(root);
      const db = await readRootDb(absRoot);
      sendJson(res, 200, db);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Failed to read DB." });
    }
    return;
  }

  if (pathname === "/api/db" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) req.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        if (!payload || typeof payload !== "object" || !payload.root) {
          sendJson(res, 400, { error: "Invalid payload." });
          return;
        }

        const absRoot = await validateRootDir(payload.root);
        const db = await readRootDb(absRoot);

        if ("progress" in payload) {
          db.progress =
            payload.progress && typeof payload.progress === "object" && !Array.isArray(payload.progress)
              ? payload.progress
              : {};
        }
        if ("history" in payload) {
          db.history = Array.isArray(payload.history) ? payload.history : [];
        }
        if ("thumbCache" in payload) {
          db.thumbCache =
            payload.thumbCache && typeof payload.thumbCache === "object" && !Array.isArray(payload.thumbCache)
              ? payload.thumbCache
              : {};
        }
        if ("lastPlayedKey" in payload) {
          db.lastPlayedKey = typeof payload.lastPlayedKey === "string" ? payload.lastPlayedKey : "";
        }
        if ("libraryCache" in payload) {
          db.libraryCache =
            payload.libraryCache && typeof payload.libraryCache === "object" && !Array.isArray(payload.libraryCache)
              ? {
                  fileCount: Number(payload.libraryCache.fileCount || 0),
                  cachedThumbCount: Number(payload.libraryCache.cachedThumbCount || 0),
                  files:
                    payload.libraryCache.files &&
                    typeof payload.libraryCache.files === "object" &&
                    !Array.isArray(payload.libraryCache.files)
                      ? payload.libraryCache.files
                      : {},
                  updatedAt:
                    typeof payload.libraryCache.updatedAt === "string"
                      ? payload.libraryCache.updatedAt
                      : new Date().toISOString(),
                }
              : { fileCount: 0, cachedThumbCount: 0, files: {}, updatedAt: new Date().toISOString() };
        }

        await writeRootDb(absRoot, db);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        if (error instanceof SyntaxError) {
          sendJson(res, 400, { error: "Invalid JSON body." });
          return;
        }
        sendJson(res, 400, { error: error.message || "Failed to save DB." });
      }
    });
    return;
  }

  if (pathname === "/api/stream" && req.method === "GET") {
    await handleStream(req, res, searchParams.get("root"), searchParams.get("file"));
    return;
  }

  if (pathname === "/api/thumb" && req.method === "GET") {
    await handleThumbnail(req, res, searchParams.get("root"), searchParams.get("file"));
    return;
  }

  if (pathname === "/api/thumb" && req.method === "POST") {
    await handleThumbnailUpload(req, res);
    return;
  }

  if (pathname === "/api/open-folder" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const absRoot = await validateRootDir(payload.root);
        openFolder(absRoot);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Failed to open folder." });
      }
    });
    return;
  }

  if (pathname === "/api/pick-folder" && req.method === "POST") {
    try {
      const selected = await pickFolderDialog();
      const absRoot = await validateRootDir(selected);
      sendJson(res, 200, { root: absRoot });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Failed to pick folder." });
    }
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }

  await serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  const lanIp = findLanIp();
  console.log(`AstralPlay running on http://localhost:${PORT}`);
  if (lanIp) {
    console.log(`AstralPlay LAN URL: http://${lanIp}:${PORT}`);
  }
});






