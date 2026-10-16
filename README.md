# Seattle Happenings website

Public landing page for [Seattle Happenings on Google Play](https://play.google.com/store/apps/details?id=com.nicholaston.happenings).

The site is deliberately static: plain HTML, CSS, and a small amount of JavaScript, with no analytics, trackers, external fonts, or build step.

## Local preview

From this directory:

```powershell
python -m http.server 4173
```

Then open `http://127.0.0.1:4173/`.

## Events page

`events/` is the list of upcoming events, at <https://nichkt.github.io/happenings/events/>. Don't edit it here: the app's private repository rebuilds it every morning with the app's own search and replaces the whole folder, in a commit titled "Events for" and the date. The page itself lives in that repository's `web/` folder.

## Deployment

GitHub Pages publishes the `main` branch from the repository root:

<https://nichkt.github.io/happenings/>

The app's canonical privacy policy remains at:

<https://nichkt.github.io/seattle-happenings-privacy/>
