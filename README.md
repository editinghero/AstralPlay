# AstralPlay
AstralPlay is a local web streaming platform for organizing and watching web series from your own files.
It detects episodes from `S__E__` file names, arranges them by season, and saves watch progress, history, and thumbnails in the browser and folder DB.

**URL**: https://astralplay.pages.dev/

## Features
- import videos through a single `Import Media` entry point
- detect episodes using `S__E__` pattern
- ask thumbnail mode each import:
  - one uploaded image for all thumbnails
  - no thumbnails
  - generate thumbnails
- cache generated thumbnails and playback progress
- open episode in fullscreen YouTube-style custom player layout
- support sidebar views: `Library`, `Continue`, `History`
- `Continue` auto-opens last played episode from DB
- merge history entries for the same episode and keep the latest play timestamp
- clear history from the History view

## Notes
- Browser playback support depends on codec/container. `mp4` is safest.
- Many `.mkv` files may not play in browser even though they are detected.
- Progress/history/thumbnail cache are saved in localStorage.
- When running the local Node server, `Open Folder` uses the server APIs and writes `.astralplay.db.json` inside the selected media folder.
- On `http://localhost:3333`, `Open Folder` also writes cached thumbnails into `.astralplay_thumbs` in that same media folder.
- `Open Files` stays browser-only and does not write folder DB/thumb files.
- If the app falls back to browser folder access, it can also write `.astralplay.db.json` directly through the File System Access API.
- Thumbnail extraction is client-side; cached thumbnails are reused before generating missing ones.
- Cloudflare Pages is static hosting, so it cannot write `.astralplay.db.json` back into your deployed site.
- If you want the folder JSON database, run AstralPlay locally on your own machine.

## Run Locally
```bash
node server.js
```

Open:
`http://localhost:3333`

For LAN access on your phone:
- double-click `astralplay.cmd`
- open the `AstralPlay LAN URL` shown in the terminal on your phone browser

You can also launch it from terminal:
```bash
npm start
```

## Import
Use the `Import Media` button:
- choose `Open Folder` on desktop browsers that support directory pick
- choose `Open Files` on mobile and as fallback

The scanner searches recursively and detects episode tokens like:
- `S01E01`
- `S1E2`
- `S_01_E_03`
- `S-02-E-10`
