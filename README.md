# Seattle Happenings website

The website of [Seattle Happenings on Google Play](https://play.google.com/store/apps/details?id=com.nicholaston.happenings): the list of upcoming events is the home page, and the page about the app is at `about/`.

The site is deliberately static: plain HTML, CSS, and a small amount of JavaScript, with no analytics, trackers, external fonts, or build step.

## Local preview

From this directory:

```powershell
python -m http.server 4173
```

Then open `http://127.0.0.1:4173/`.

## Events page

The home page, <https://seattlehappenings.org/>, is the list of upcoming events: `index.html`, `app.js`, `app.css`, `theme.css`, `data/` and `ics/`. Don't edit those here: the app's private repository rebuilds them every morning with the app's own search and replaces them, in a commit titled "Events for" and the date. The page itself lives in that repository's `web/` folder. Everything else here (`about/`, `assets/`, `events/`, `404.html` and the rest) it leaves alone.

The list was at `events/` until November 6, 2026. `events/index.html` now only sends old links on to the home page, keeping the event in them (`#e=...`).

## About the app

`about/` is the page about the app (`about/index.html`, with its `styles.css` and `script.js`), at <https://seattlehappenings.org/about/>. It was the home page until the events list took its place.

## Deployment

GitHub Pages publishes the `main` branch from the repository root, at the custom domain in `CNAME` (keep that file: without it Pages drops the domain):

<https://seattlehappenings.org/>

The domain is registered at Cloudflare, and its DNS there points it at GitHub Pages: four `A` and four `AAAA` records for `seattlehappenings.org`, and a `CNAME` from `www` to `nichkt.github.io`, all "DNS only" so that GitHub's own HTTPS certificate covers it. `www` and the old address, <https://nichkt.github.io/happenings/>, redirect to it. Links within the site are relative, except in `404.html`, which is shown at any depth and so starts them at the root.

The app's canonical privacy policy remains at:

<https://nichkt.github.io/seattle-happenings-privacy/>
