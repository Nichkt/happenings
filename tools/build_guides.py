#!/usr/bin/env python3
"""Builds the guide pages (this weekend, free this weekend, Eastside, Bellevue,
holiday events) from data/events.json, and rewrites sitemap.xml.

Plain HTML that search engines can read without running JavaScript. Run from
the repository root: python3 tools/build_guides.py
The GitHub workflow in .github/workflows/guides.yml runs it after every
"Events for" commit, so the pages follow the list every morning.
"""
import datetime as dt
import html
import json
import os
import re
from zoneinfo import ZoneInfo

SITE = "https://seattlehappenings.org"
NEWSLETTER = "happening"  # Buttondown username (account happeninginseattle@gmail.com)
TZ = ZoneInfo("America/Los_Angeles")
NEAR = {"SEATTLE", "EASTSIDE", "NORTH", "SOUTH"}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = json.load(open(os.path.join(ROOT, "data", "events.json"), encoding="utf-8"))
EVENTS = DATA["events"]
REGIONS = {r["id"]: r["label"] for r in DATA["regions"]}
CATS = {c["id"]: c["short"] for c in DATA["categories"]}

TODAY = dt.datetime.now(TZ).date()


def d(s):
    return dt.date.fromisoformat(s)


def weekend():
    wd = TODAY.weekday()  # Mon 0 .. Sun 6
    if wd == 6:
        sat = TODAY - dt.timedelta(days=1)
    else:
        sat = TODAY + dt.timedelta(days=(5 - wd) % 7)
    start = max(TODAY, sat - dt.timedelta(days=1))
    return start, sat + dt.timedelta(days=1)


def fmt(day):
    return day.strftime("%a, %b ") + str(day.day)


def overlaps(e, a, b):
    return d(e["start"]) <= b and d(e["end"]) >= a


def clean_summary(e):
    s = (e.get("summary") or "").strip()
    if not s or "Add to calendar" in s or "Category:" in s or s.startswith("@") or len(s) < 25:
        return ""
    if len(s) > 220:
        s = s[:217].rsplit(" ", 1)[0] + "..."
    return s


def in_place(e, name):
    return name.lower() in ((e.get("placeLines") or "") + " " + (e.get("place") or "")).lower()


WS, WE = weekend()
WLABEL = f"{fmt(WS)} to {fmt(WE)}" if WS != WE else fmt(WS)
MONTH = TODAY.strftime("%B %Y")

PAGES = [
    dict(slug="this-weekend", nav="This weekend",
         title=f"Things to do around Seattle this weekend ({WLABEL})",
         h1="Things to do around Seattle this weekend",
         intro=f"Markets, festivals, street fairs and art walks in Seattle, the Eastside, and north and south of the city, {WLABEL}. Pulled from city and community calendars every morning.",
         pick=lambda e: e.get("region") in NEAR and overlaps(e, WS, WE), weekend=True),
    dict(slug="free-this-weekend", nav="Free this weekend",
         title=f"Free things to do in Seattle this weekend ({WLABEL})",
         h1="Free things to do around Seattle this weekend",
         intro=f"Every event here is listed as free by its organizer, {WLABEL}. Check the event page before you go, since details change.",
         pick=lambda e: e.get("region") in NEAR and e.get("free") and overlaps(e, WS, WE), weekend=True),
    dict(slug="eastside-this-weekend", nav="Eastside this weekend",
         title=f"Things to do on the Eastside this weekend: Bellevue, Redmond, Kirkland ({WLABEL})",
         h1="Things to do on the Eastside this weekend",
         intro=f"Bellevue, Redmond, Kirkland, Issaquah, Sammamish, Mercer Island and the rest of the Eastside, {WLABEL}.",
         pick=lambda e: e.get("region") == "EASTSIDE" and overlaps(e, WS, WE), weekend=True),
    dict(slug="seattle-this-weekend", nav="Seattle this weekend",
         title=f"Things to do in Seattle this weekend ({WLABEL})",
         h1="Things to do in Seattle this weekend",
         intro=f"Events inside the city of Seattle, {WLABEL}, from neighborhood street fairs to Seattle Center festivals.",
         pick=lambda e: e.get("region") == "SEATTLE" and overlaps(e, WS, WE), weekend=True),
    dict(slug="eastside", nav="Eastside events",
         title=f"Eastside events: Bellevue, Redmond, Kirkland and more ({MONTH})",
         h1="Upcoming events on the Eastside",
         intro="Community events across the Eastside for the next 30 days, from city calendars in Bellevue, Redmond, Kirkland, Mercer Island, Snoqualmie and nearby.",
         pick=lambda e: e.get("region") == "EASTSIDE" and overlaps(e, TODAY, TODAY + dt.timedelta(days=30))),
    dict(slug="bellevue", nav="Bellevue events",
         title=f"Things to do in Bellevue, WA ({MONTH})",
         h1="Things to do in Bellevue",
         intro="Upcoming events in Bellevue for the next 60 days, including Bellevue Botanical Garden, Old Bellevue, Downtown Park and Bellevue Square.",
         pick=lambda e: in_place(e, "Bellevue") and overlaps(e, TODAY, TODAY + dt.timedelta(days=60))),
    dict(slug="holiday-events", nav="Holiday events",
         title=f"Holiday events around Seattle and the Eastside ({TODAY.year})",
         h1="Holiday and seasonal events around Seattle",
         intro="Tree lightings, holiday markets, Santa visits, light shows and seasonal festivals around Seattle and the Eastside, for the next three months.",
         pick=lambda e: e.get("category") == "SEASONAL" and e.get("region") in NEAR and overlaps(e, TODAY, TODAY + dt.timedelta(days=90))),
]

E = html.escape


def iso(day, minute):
    if minute is None:
        return day
    return f"{day}T{minute // 60:02d}:{minute % 60:02d}:00"


def schema(evs, page):
    items = []
    for i, e in enumerate(evs[:40]):
        ev = {
            "@type": "Event",
            "name": e["title"],
            "startDate": iso(e["start"], e.get("startMinute")),
            "endDate": iso(e["end"], e.get("endMinute")),
            "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
            "eventStatus": "https://schema.org/EventScheduled",
            "url": e["url"],
        }
        if e.get("place"):
            lines = (e.get("placeLines") or e["place"]).split("\n")
            ev["location"] = {"@type": "Place", "name": lines[0],
                              "address": lines[1] if len(lines) > 1 else lines[0]}
        if e.get("image"):
            ev["image"] = e["image"]
        if clean_summary(e):
            ev["description"] = clean_summary(e)
        if e.get("free"):
            ev["isAccessibleForFree"] = True
            ev["offers"] = {"@type": "Offer", "price": 0, "priceCurrency": "USD", "url": e["url"]}
        items.append({"@type": "ListItem", "position": i + 1, "item": ev})
    data = {"@context": "https://schema.org", "@type": "ItemList",
            "name": page["h1"], "url": f"{SITE}/{page['slug']}/", "itemListElement": items}
    return json.dumps(data, ensure_ascii=False).replace("</", "<\\/")


def card(e):
    bits = [E(e.get("dates") or e["start"])]
    if e.get("time"):
        bits.append(E(e["time"]))
    meta = " &middot; ".join(bits)
    place = f'<p class="place">{E(e["place"])}</p>' if e.get("place") else ""
    tags = []
    if e.get("free"):
        tags.append('<span class="tag free">Free</span>')
    elif e.get("cost"):
        tags.append(f'<span class="tag">{E(e["cost"])}</span>')
    if e.get("category") in CATS:
        tags.append(f'<span class="tag">{E(CATS[e["category"]])}</span>')
    if e.get("kids"):
        tags.append('<span class="tag">Kids</span>')
    summ = clean_summary(e)
    summ = f"<p>{E(summ)}</p>" if summ else ""
    return f"""<li class="ev">
  <p class="when">{meta}</p>
  <h3><a href="{E(e['url'])}" rel="noopener">{E(e['title'])}</a></h3>
  {place}
  {summ}
  <p class="tags">{''.join(tags)}</p>
  <p class="acts"><a href="../ics/{E(e['id'])}.ics">Add to calendar</a> <a href="../#e={E(e['id'])}">Open in Seattle Happenings</a></p>
</li>"""


def nav(current):
    links = []
    for p in PAGES:
        if p["slug"] == current:
            links.append(f'<a aria-current="page" href="../{p["slug"]}/">{E(p["nav"])}</a>')
        else:
            links.append(f'<a href="../{p["slug"]}/">{E(p["nav"])}</a>')
    return "\n      ".join(links)


SIGNUP = f"""<form class="signup" action="https://buttondown.com/api/emails/embed-subscribe/{NEWSLETTER}" method="post" target="_blank">
    <label for="email"><strong>Get the weekend list by email.</strong> One email on Thursdays with the best events for the weekend. Free, unsubscribe anytime.</label>
    <div class="row"><input type="email" name="email" id="email" placeholder="you@example.com" required autocomplete="email"><button type="submit">Sign up</button></div>
  </form>"""


def page_html(page, evs):
    canonical = f"{SITE}/{page['slug']}/"
    if page.get("weekend"):
        multi = [e for e in evs if (d(e["end"]) - d(e["start"])).days > 3]
        single = [e for e in evs if e not in multi]
        body = ""
        if single:
            body += f'<h2>Happening {E(WLABEL)}</h2>\n<ul class="list">\n' + "\n".join(card(e) for e in single) + "\n</ul>\n"
        if multi:
            body += '<h2>Running all weekend</h2>\n<ul class="list">\n' + "\n".join(card(e) for e in multi) + "\n</ul>\n"
    else:
        body = '<ul class="list">\n' + "\n".join(card(e) for e in evs) + "\n</ul>\n"
    if not evs:
        body = '<p class="empty">Nothing is listed here yet. The <a href="../">full list</a> has everything coming up, and it updates every morning.</p>'
    desc = page["intro"][:300]
    upd = TODAY.strftime("%B ") + str(TODAY.day) + TODAY.strftime(", %Y")
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#123946">
  <meta name="color-scheme" content="light dark">
  <title>{E(page['title'])} | Seattle Happenings</title>
  <meta name="description" content="{E(desc)}">
  <link rel="canonical" href="{canonical}">
  <link rel="icon" type="image/png" sizes="32x32" href="../assets/icon-32.png">
  <link rel="stylesheet" href="../guides/guide.css">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Seattle Happenings">
  <meta property="og:title" content="{E(page['title'])}">
  <meta property="og:description" content="{E(desc)}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="{SITE}/assets/feature-graphic.png">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">{schema(evs, page)}</script>
</head>
<body>
  <header class="top">
    <a class="brand" href="../"><img src="../assets/icon-32.png" width="28" height="28" alt=""> Seattle Happenings</a>
    <nav class="guides" aria-label="Guides">
      {nav(page['slug'])}
    </nav>
  </header>
  <main class="wrap">
    <h1>{E(page['h1'])}</h1>
    <p class="intro">{E(page['intro'])}</p>
    <p class="count">{len(evs)} event{'s' if len(evs) != 1 else ''} &middot; updated {E(upd)} &middot; <a href="../">See the full list with filters</a></p>
    {SIGNUP}
    {body}
    {SIGNUP.replace('id="email"', 'id="email2"').replace('for="email"', 'for="email2"')}
  </main>
  <footer class="foot">
    <p>Seattle Happenings collects community events from city and neighborhood calendars every morning. No accounts, ads or tracking.</p>
    <p><a href="../">All events</a> <a href="../about/">About</a> <a href="https://play.google.com/store/apps/details?id=com.nicholaston.happenings" rel="noopener">Android app</a> <a href="mailto:nichkt@gmail.com">Contact</a></p>
    <p class="fine">Independent and not affiliated with the City of Seattle or the events and organizers listed.</p>
  </footer>
</body>
</html>
"""


def hub_html():
    items = "\n".join(
        f'<li><a href="../{p["slug"]}/">{E(p["h1"])}</a></li>' for p in PAGES)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#123946">
  <meta name="color-scheme" content="light dark">
  <title>Event guides for Seattle and the Eastside | Seattle Happenings</title>
  <meta name="description" content="Weekend guides and city guides for community events around Seattle, Bellevue and the Eastside, updated every morning.">
  <link rel="canonical" href="{SITE}/guides/">
  <link rel="icon" type="image/png" sizes="32x32" href="../assets/icon-32.png">
  <link rel="stylesheet" href="guide.css">
</head>
<body>
  <header class="top"><a class="brand" href="../"><img src="../assets/icon-32.png" width="28" height="28" alt=""> Seattle Happenings</a></header>
  <main class="wrap">
    <h1>Event guides</h1>
    <p class="intro">Short lists built from the full events list every morning.</p>
    <ul class="hub">
{items}
    </ul>
    {SIGNUP}
  </main>
  <footer class="foot"><p><a href="../">All events</a> <a href="../about/">About</a></p></footer>
</body>
</html>
"""


def sort_key(e):
    return (e["start"], e.get("startMinute") or 0, e["title"])


def write(path, text):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    old = open(full, encoding="utf-8").read() if os.path.exists(full) else None
    if old != text:
        with open(full, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)


def main():
    for p in PAGES:
        evs = sorted((e for e in EVENTS if p["pick"](e) and d(e["end"]) >= TODAY), key=sort_key)
        write(f"{p['slug']}/index.html", page_html(p, evs))
        print(f"{p['slug']}: {len(evs)} events")
    write("guides/index.html", hub_html())
    urls = [("", "daily", "1.0"), ("about/", "monthly", "0.6"), ("guides/", "weekly", "0.7")]
    urls += [(p["slug"] + "/", "daily", "0.9") for p in PAGES]
    body = "\n".join(
        f"  <url>\n    <loc>{SITE}/{u}</loc>\n    <lastmod>{TODAY.isoformat()}</lastmod>\n    <changefreq>{c}</changefreq>\n    <priority>{pr}</priority>\n  </url>"
        for u, c, pr in urls)
    write("sitemap.xml", f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{body}\n</urlset>\n')


if __name__ == "__main__":
    main()
