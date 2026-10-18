# papertrail

A self-hosted, fraidycat-style news aggregator. One Docker container, no accounts, no database.

## Run
    docker compose up -d --build     # then open http://localhost:8080

Edit `data/sources.txt` for server-side defaults, or paste/upload your own list in the **Sources** dialog
(`url | tag1, tag2`, one per line, `#` comments).

## How it works
- **Server** fetches sites for you (so browser CORS never applies), auto-discovers RSS/Atom/JSON feeds,
  and falls back to scraping headlines, links and thumbnails from the page. Story detail (summary, thumbnail)
  for scraped items is fetched when you expand them.
- **Browser** stores everything personal (sources, article cache, saved, read later, report) in localStorage,
  so the host is stateless and users' data stays private. Export/Import backup moves it between devices.
- **Search / filter / sort**: keyword search and tag chips apply within the "Show last…" window; sort by newest or
  trending (stories whose key words appear across several different sources, decayed by age).
- **Source filter**: the Source dropdown narrows the feed to one configured site.
- **Source status**: every source reports what happened (HTTP status, failure stage, a suggestion, and the steps taken); failed ones can be retried.
- **Thumbnails**: after each refresh the app fetches only the `<head>` of stories that lack an image (via `/api/enrich`) so thumbnails appear without expanding.
- **Categories**: create your own categories, file any story under one or more, and browse them in the Categories tab.
- **News report**: "Add to report" collects stories; the server builds a .docx where each title is a hyperlink, grouped under a heading per category.

## Security (no site allowlist needed)
- SSRF guard: only http(s) on ports 80/443; every DNS result and every redirect hop is checked and private,
  loopback, link-local, CGNAT, multicast and cloud-metadata ranges are refused. The socket connects to the
  validated IP, defeating DNS rebinding.
- Limits: 3 MB pages, 2 MB images, 8 s idle / 15 s total timeout, 4 redirects, 40 sources per request,
  per-IP rate limiting, 1 MB request bodies.
- Remote content never touches your origin: summaries are reduced to plain text and rendered with textContent;
  thumbnails go through an image proxy (raster types only, no SVG, sandboxed) so readers' IPs aren't leaked to
  publishers. Strict CSP (`default-src 'none'`, scripts/styles/images from self only), nosniff, no-referrer.
- Container: non-root, read-only filesystem, all capabilities dropped, no-new-privileges, memory/PID limits.
- For extra defence in depth, run it on a network that can't reach your LAN, and serve it behind HTTPS.

## Limits to know about
- Sites that block bots, need JavaScript to render, or sit behind paywalls/logins may return nothing or only headlines.
- localStorage keeps about 4,000 recent articles (30 days max); saved/read-later/report items are kept regardless.
