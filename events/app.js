/*
 * The events page. It reads data/events.json, which the Website workflow
 * writes every day from the same search the app runs without a Gemini key,
 * and shows it the way the app's home screen does: the same tabs, sections,
 * series and filters (see HomeList.kt, Format.kt and ShowFilter).
 *
 * Everything in the list comes from other people's calendars, so it's only
 * ever put on the page as text (textContent), and links only if they're
 * http or https. Stars and filters are kept in this browser's localStorage,
 * under keys with the app's name: both cities' sites share one origin.
 *
 * Refresh loads the newest list. "Search with Gemini" reads what the app
 * reads only with a Gemini key, from this browser and with the visitor's own
 * free key: the feed's gemini block says what (see "Search with Gemini" below).
 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const DAY_MS = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const SECTIONS = ['Going on now', 'This week', 'Next week', 'Later'];
  /** A series first listed within this many days gets the "new" dot. */
  const NEW_DAYS = 7;
  /** Past this, the page says the list may be out of date. */
  const STALE_HOURS = 48;
  /** What's handed to a calendar link's notes; the rest is on the event's website. */
  const MAX_NOTES = 1500;

  let feed = null;
  let events = [];
  const byId = new Map();
  const bySeries = new Map();
  let today = 0;
  let loadedAt = 0;
  let store = 'happenings';
  let stars = {};
  let filters = null;
  let words = [];
  let current = null;
  const view = { mode: 'upcoming', weekend: false };
  /** What Gemini found, as saved in this browser: clean copies, without what index() works out. */
  let found = { v: 1, at: null, model: null, events: [], read: [] };
  /** While a Gemini search runs: { ctl, i, n, name }. */
  let searching = null;
  /** Why the last Gemini search stopped short, for the status box. */
  let problem = null;
  let refreshing = false;

  // Dates are days since 1970-01-01, in the area: the feed's dates are the area's.

  function epochDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
  }

  const utc = (day) => new Date(day * DAY_MS);
  const month = (day) => MONTHS[utc(day).getUTCMonth()];
  const weekday = (day) => WEEKDAYS[utc(day).getUTCDay()];
  const dom = (day) => utc(day).getUTCDate();
  const year = (day) => utc(day).getUTCFullYear();
  const monthDay = (day) => `${month(day)} ${dom(day)}`;
  const isoDay = (day) => utc(day).toISOString().slice(0, 10);

  function todayIn(zone) {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date())) {
      parts[p.type] = p.value;
    }
    return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY_MS);
  }

  /** Format.dateRange: "Sat, Sep 26", "Sep 26–27", "Sep 30–Oct 2". */
  function dateRange(s, e) {
    if (e === s) return `${weekday(s)}, ${month(s)} ${dom(s)}`;
    if (month(s) === month(e) && year(s) === year(e)) return `${month(s)} ${dom(s)}–${dom(e)}`;
    return `${month(s)} ${dom(s)}–${month(e)} ${dom(e)}`;
  }

  /** Format.relativeDate: "Today", "Tomorrow – 27", "Through Oct 31". */
  function relativeDate(s, e, t) {
    if (s < t && e >= t) return e === t ? 'Ends today' : `Through ${month(e)} ${dom(e)}`;
    const suffix = e !== s ? ` – ${month(e) === month(s) ? dom(e) : `${month(e)} ${dom(e)}`}` : '';
    if (s === t) return `Today${suffix}`;
    if (s === t + 1) return `Tomorrow${suffix}`;
    return dateRange(s, e);
  }

  /** Format.badge: ("SAT", "26") for a day, ("SEP", "26") for a run. */
  function badge(s, e, t) {
    const shown = s < t ? t : s;
    return [(e === s ? weekday(shown) : month(shown)).toUpperCase(), String(dom(shown))];
  }

  /** HomeList.weekendOf: the coming Friday to Sunday, or from today once it's begun. */
  function weekendOf(t) {
    const sunday = t + ((7 - utc(t).getUTCDay()) % 7);
    return [Math.max(sunday - 2, t), sunday];
  }

  const shownStart = (e, t) => Math.max(e.s, t);

  /** HomeList.sectionOf. */
  function sectionOf(e, t) {
    if (e.s < t && e.e - e.s + 1 > 4) return 0;
    if (shownStart(e, t) <= t + 6) return 1;
    if (shownStart(e, t) <= t + 13) return 2;
    return 3;
  }

  /** Filters.normalize: lowercase words without accents, padded with spaces. */
  function normalize(text) {
    if (!text || !text.trim()) return ' ';
    const t = text.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/['’]s\b/g, 's')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    return ` ${t} `;
  }

  function webUrl(u) {
    if (!u) return null;
    try {
      const url = new URL(u);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const minute = (e) => (e.startMinute == null ? -1 : e.startMinute);

  // Saved choices. What storage can't keep (turned off, or full) is kept here
  // until the page closes, and read before storage, so nothing is lost by
  // reading back what was just saved.

  const unsaved = new Map();

  function load(key, fallback) {
    const k = `${store}:${key}`;
    try {
      const v = JSON.parse(unsaved.has(k) ? unsaved.get(k) : localStorage.getItem(k));
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    const k = `${store}:${key}`;
    const json = JSON.stringify(value);
    try {
      localStorage.setItem(k, json);
      unsaved.delete(k);
    } catch {
      unsaved.set(k, json);
    }
  }

  const isStarred = (id) => Object.prototype.hasOwnProperty.call(stars, id);

  /**
   * A date's id can change when its listing does: a star finds its date again
   * by series and days, and among twins (one title twice on a day) by place
   * and time. When that can't tell, the star stays where it was rather than
   * move to the wrong one.
   */
  function loadStars() {
    const saved = load('stars', {});
    const has = (id) => Object.prototype.hasOwnProperty.call(saved, id);
    stars = {};
    const todayIso = isoDay(today);
    for (const [id, s] of Object.entries(saved)) {
      if (!s || typeof s !== 'object') continue;
      const again = byId.get(id) || findAgain(s, (e) => !has(e.id) && !isStarred(e.id));
      if (again) stars[again.id] = starOf(again);
      else if (typeof s.x === 'string' && s.x >= todayIso) stars[id] = s; // its calendar may be back tomorrow
    }
    save('stars', stars);
  }

  const starOf = (e) => ({ s: e.series, d: e.start, x: e.end, p: e.place, m: e.startMinute });

  function findAgain(s, free) {
    const near = (e) => e.start === s.d || (typeof s.x === 'string' && e.start <= s.x && s.d <= e.end);
    const score = (e) => (s.p != null && e.place === s.p ? 1 : 0) + (s.m != null && e.startMinute === s.m ? 1 : 0) + (e.start === s.d ? 0.5 : 0);
    const ranked = events.filter((e) => e.series === s.s && free(e) && near(e)).map((e) => [score(e), e]).sort((a, b) => b[0] - a[0]);
    if (!ranked.length || ranked[0][0] === 0 || (ranked.length > 1 && ranked[0][0] === ranked[1][0])) return undefined;
    return ranked[0][1];
  }

  function toggleStar(e) {
    if (isStarred(e.id)) delete stars[e.id];
    else stars[e.id] = starOf(e);
    save('stars', stars);
    for (const b of document.querySelectorAll('[data-star]')) {
      if (b.dataset.star === e.id) paintStar(b, e);
    }
    updateCounts();
    if (view.mode === 'starred') render();
    toast(isStarred(e.id) ? 'Starred. Stars are kept in this browser.' : 'Star removed');
  }

  function defaultFilters() {
    return {
      regions: Object.fromEntries(feed.regions.map((r) => [r.id, r.on])),
      categories: Object.fromEntries(feed.categories.map((c) => [c.id, c.on])),
      hidePaid: false,
      hideKids: false,
      hidePolitics: false,
    };
  }

  function loadFilters() {
    const d = defaultFilters();
    const s = load('filters', {});
    filters = {
      regions: { ...d.regions, ...(s.regions || {}) },
      categories: { ...d.categories, ...(s.categories || {}) },
      hidePaid: s.hidePaid === true,
      hideKids: s.hideKids === true,
      hidePolitics: s.hidePolitics === true,
    };
  }

  function changedFilters() {
    const d = defaultFilters();
    let n = 0;
    for (const r of feed.regions) if (filters.regions[r.id] !== d.regions[r.id]) n++;
    for (const c of feed.categories) if (filters.categories[c.id] !== d.categories[c.id]) n++;
    return n + [filters.hidePaid, filters.hideKids, filters.hidePolitics].filter(Boolean).length;
  }

  // The list

  /** ShowFilter.accepts: starred dates and the watched festivals always show. */
  function accepts(e) {
    if (isStarred(e.id) || e.watch) return true;
    if (e.region && filters.regions[e.region] === false) return false;
    if (filters.categories[e.category] === false) return false;
    if (filters.hidePaid && e.free === false) return false;
    if (filters.hideKids && e.kids) return false;
    if (filters.hidePolitics && e.political) return false;
    return true;
  }

  /** HomeList.Narrow: each word has to start a word somewhere, so "mark" finds "Night Market". */
  function narrows(e, t) {
    if (view.weekend) {
      const [from, to] = weekendOf(t);
      if (e.s > to || e.e < from) return false;
    }
    return words.every((w) => e.text.includes(` ${w}`));
  }

  function series(list, t) {
    const groups = new Map();
    for (const e of list) {
      if (!groups.has(e.series)) groups.set(e.series, []);
      groups.get(e.series).push(e);
    }
    return [...groups.values()].map((dates) => {
      dates.sort((a, b) => shownStart(a, t) - shownStart(b, t) || minute(a) - minute(b));
      return { main: dates[0], more: dates.slice(1) };
    });
  }

  /** HomeList.build. */
  function groups(t) {
    const visible = events.filter((e) => e.e >= t && accepts(e) && narrows(e, t));
    let rows;
    if (view.mode === 'starred') rows = visible.filter((e) => isStarred(e.id)).map((e) => ({ main: e, more: [] }));
    else if (view.mode === 'free') rows = series(visible.filter((e) => e.free === true), t);
    else rows = series(visible, t);
    const out = SECTIONS.map(() => []);
    for (const r of rows) out[sectionOf(r.main, t)].push(r);
    for (const g of out) {
      g.sort((a, b) => shownStart(a.main, t) - shownStart(b.main, t) || minute(a.main) - minute(b.main) ||
        compare(a.main.title.toLowerCase(), b.main.title.toLowerCase()));
    }
    return out.map((rows, section) => ({ section, rows })).filter((g) => g.rows.length);
  }

  function isNew(e) {
    const first = e.seriesSeen;
    return first > Date.parse(feed.since) && Date.now() - first < NEW_DAYS * DAY_MS;
  }

  /** HomeList.moreDatesLabel: "Also Oct 3, Oct 10 +2". */
  function moreDatesLabel(more) {
    if (!more.length) return null;
    const shown = more.slice(0, 3).map((d) => monthDay(d.s)).join(', ');
    return `Also ${shown}${more.length > 3 ? ` +${more.length - 3}` : ''}`;
  }

  // Building blocks

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function icon(name) {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('class', 'icon');
    s.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', `#i-${name}`);
    s.append(use);
    return s;
  }

  function button(className, label, iconName, onClick) {
    const b = el('button', className);
    b.type = 'button';
    if (iconName) b.append(icon(iconName));
    if (label) b.append(document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  }

  function link(href, className, label, iconName, newTab = true) {
    const a = el('a', className);
    a.href = href;
    if (newTab) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    if (iconName) a.append(icon(iconName));
    if (label) a.append(document.createTextNode(label));
    return a;
  }

  function paintStar(b, e) {
    const on = isStarred(e.id);
    b.setAttribute('aria-pressed', String(on));
    if (b.classList.contains('icon-button')) {
      b.replaceChildren(icon(on ? 'star' : 'star-outline'));
    } else {
      b.replaceChildren(icon(on ? 'star' : 'star-outline'), document.createTextNode(on ? 'Starred' : 'Star'));
    }
  }

  function starButton(e, className) {
    const b = button(className, null, null, () => toggleStar(e));
    b.dataset.star = e.id;
    b.setAttribute('aria-label', `Star ${e.title}`);
    paintStar(b, e);
    return b;
  }

  const categoryOf = (id) => feed.categories.find((c) => c.id === id) || { label: id, short: id };
  const when = (e) => [e.dates, e.time].filter(Boolean).join(' · ');

  function card(row, t) {
    const e = row.main;
    const c = el('article', e.gemini ? 'card gemini' : 'card');
    const top = el('div', 'card-top');
    const [day, num] = badge(e.s, e.e, t);
    const b = el('div', `badge${e.s <= t + 1 ? ' soon' : ''}`);
    b.setAttribute('aria-hidden', 'true');
    b.append(el('b', null, day), el('span', null, num));

    const main = el('div', 'card-main');
    const title = button('title', null, null, () => openDetails(e));
    if (isNew(e)) {
      const dot = el('span', 'new-dot');
      dot.title = 'New this week';
      title.append(dot, el('span', 'visually-hidden', 'New: '));
    }
    title.append(document.createTextNode(e.title));
    main.append(title, el('p', 'line', [relativeDate(e.s, e.e, t), e.time, e.place].filter(Boolean).join(' · ')));
    const tags = el('div', 'tags');
    tags.append(el('span', 'tag', categoryOf(e.category).short || categoryOf(e.category).label));
    if (e.free === true) tags.append(el('span', 'tag free', 'Free'));
    if (e.gemini) tags.append(geminiTag());
    main.append(tags);
    const more = moreDatesLabel(row.more);
    if (more) main.append(el('p', 'more-dates', more));

    top.append(b, main, starButton(e, 'icon-button star'));
    // The card opens the details anywhere but its buttons. The click's path is
    // fixed when it happens: the star repaints its icon, which leaves the target
    // out of the page by the time the click gets here.
    top.addEventListener('click', (ev) => {
      if (!ev.composedPath().some((n) => n instanceof Element && n.matches('button, a'))) openDetails(e);
    });

    const actions = el('div', 'card-actions');
    const site = webUrl(e.url);
    if (site) {
      const w = link(site, 'button', 'Website', 'web');
      w.setAttribute('aria-label', `Website for ${e.title}`);
      actions.append(w);
    }
    const add = button(site ? 'button tonal' : 'button', 'Add to calendar', 'calendar-add', () => openAdd(e));
    add.setAttribute('aria-label', `Add ${e.title} to your calendar`);
    actions.append(add);
    c.append(top, actions);
    return c;
  }

  function render() {
    const list = $('list');
    list.setAttribute('aria-busy', 'false');
    const shown = groups(today);
    const frag = document.createDocumentFragment();
    for (const g of shown) {
      const section = el('section');
      section.append(el('h2', 'section-title', SECTIONS[g.section]));
      const cards = el('div', 'cards');
      for (const row of g.rows) cards.append(card(row, today));
      section.append(cards);
      frag.append(section);
    }
    if (!shown.length) frag.append(emptyState());
    list.replaceChildren(frag);
    updateCounts();
  }

  function emptyState() {
    const box = el('div', 'empty');
    const narrowed = words.length > 0 || view.weekend;
    if (view.mode === 'starred' && !narrowed) {
      box.append(el('p', null, 'Nothing starred yet. Star an event to keep it here. Stars are kept in this browser.'));
      return box;
    }
    const what = view.mode === 'free' ? 'Nothing free' : view.mode === 'starred' ? 'Nothing starred' : 'Nothing';
    box.append(el('p', null, `${what} matches${narrowed ? ' that search' : ' your filters'}.`));
    if (narrowed) {
      box.append(button('button', 'Clear the search', null, () => {
        $('q').value = '';
        words = [];
        setWeekend(false);
        render();
      }));
    } else if (changedFilters() > 0) {
      box.append(button('button', 'Reset the filters', null, () => {
        filters = defaultFilters();
        save('filters', filters);
        render();
      }));
    }
    return box;
  }

  function updateCounts() {
    const starred = events.filter((e) => e.e >= today && isStarred(e.id)).length;
    $('star-count').textContent = starred ? String(starred) : '';
    const changed = changedFilters();
    $('filter-count').textContent = changed ? String(changed) : '';
    $('open-filters').setAttribute('aria-label', changed ? `Filters, ${changed} changed` : 'Filters');
  }

  // Details

  function infoLine(iconName, text) {
    const li = el('li');
    li.append(icon(iconName), el('span', null, text));
    return li;
  }

  function description(body, e) {
    const lead = e.summary || e.description;
    if (!lead) return;
    const p = el('p', 'about', lead);
    body.append(p);
    if (e.summary && e.description) {
      const more = button('link-button', 'Show more', null, () => {
        const open = more.textContent === 'Show more';
        p.textContent = open ? e.description : e.summary;
        more.textContent = open ? 'Show less' : 'Show more';
      });
      body.append(more);
    } else if (!e.summary && lead.length > 400) {
      p.classList.add('clamped');
      const more = button('link-button', 'Show more', null, () => {
        const open = p.classList.toggle('clamped') === false;
        more.textContent = open ? 'Show less' : 'Show more';
      });
      body.append(more);
    }
  }

  function pageUrl(e) {
    return `${location.origin}${location.pathname}#e=${encodeURIComponent(e.id)}`;
  }

  async function share(e) {
    // What Gemini found is only in this browser, so a link to it here would go nowhere for anyone else.
    const url = e.gemini ? webUrl(e.url) || `${location.origin}${location.pathname}` : pageUrl(e);
    const text = `${e.title} · ${when(e)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: e.title, text, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('Link copied');
    } catch {
      toast(url, 6000);
    }
  }

  function openDetails(e, push = true) {
    current = e;
    const t = today;
    const body = $('details-body');
    body.replaceChildren();

    const photo = webUrl(e.image);
    if (photo && photo.startsWith('https:')) {
      const fig = el('figure', 'photo');
      const img = el('img');
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => fig.remove());
      img.src = photo;
      fig.append(img);
      if (e.imageCredit) fig.append(el('figcaption', null, `Photo: ${e.imageCredit}`));
      body.append(fig);
    }

    const head = el('div', 'sheet-head');
    const h = el('h2', null, e.title);
    h.id = 'd-title';
    const close = button('icon-button', null, 'close', () => $('details').close());
    close.setAttribute('aria-label', 'Close');
    head.append(h, close);
    body.append(head);

    const prefix = e.s === t ? 'Today' : e.s === t + 1 ? 'Tomorrow' : e.s < t ? 'On now' : null;
    const info = el('ul', 'info');
    info.append(infoLine('time', [prefix, e.dates, e.time].filter(Boolean).join(' · ')));
    if (e.placeLines) info.append(infoLine('place', e.placeLines));
    if (e.cost) info.append(infoLine('tag', e.cost));
    info.append(infoLine('kind', categoryOf(e.category).label));
    body.append(info);
    if (e.gemini) body.append(geminiNote(e));

    // The one thing most people open a listing for, so it's big and where the eye lands.
    const site = webUrl(e.url);
    if (site) {
      const visit = el('div', 'visit');
      visit.append(link(site, 'button big', 'Visit website', 'web'));
      body.append(visit);
    }

    description(body, e);

    const actions = el('div', 'actions');
    actions.append(starButton(e, 'button tonal'));
    actions.append(button('button tonal', 'Add to calendar', 'calendar-add', () => openAdd(e)));
    if (e.map) {
      actions.append(link(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.map)}`, 'button tonal', 'Directions', 'directions'));
    }
    actions.append(button('button tonal', 'Share', 'share', () => share(e)));
    body.append(actions);

    const dates = (bySeries.get(e.series) || []).filter((d) => d.e >= t);
    if (dates.length > 1) {
      const box = el('div', 'dates');
      box.append(el('h3', null, 'All dates'));
      const chips = el('div', 'date-chips');
      for (const d of dates.slice(0, 24)) {
        const chip = button('', dateRange(d.s, d.e), isStarred(d.id) ? 'star' : null, () => {
          openDetails(d, false);
          history.replaceState(history.state, '', `#e=${encodeURIComponent(d.id)}`);
        });
        if (d.id === e.id) chip.setAttribute('aria-current', 'true');
        chips.append(chip);
      }
      box.append(chips);
      if (dates.length > 24) box.append(el('p', 'fine', `+${dates.length - 24} more dates`));
      body.append(box);
    }

    const email = document.body.dataset.email;
    // What Gemini found says where in its note, and no one else can open it to see what's wrong.
    if (!e.gemini) {
      body.append(el('p', 'listed', `Listed by ${e.sources && e.sources.length ? e.sources.join(', ') : 'a calendar'}${e.keptSince ? '. Its calendar couldn\'t be read lately, so check the website.' : ''}`));
      if (email) {
        const subject = `${feed.app} listing: ${e.title} (${e.dates})`;
        const mail = link(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`About ${pageUrl(e)}\n\nWhat's wrong:\n`)}`, 'report', 'Report a problem with this listing', 'flag', false);
        body.append(mail);
      }
    }

    const dialog = $('details');
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    body.scrollTop = 0;
    if (push && location.hash !== `#e=${e.id}`) history.pushState({ e: e.id }, '', `#e=${encodeURIComponent(e.id)}`);
  }

  // Add to calendar

  const compact = (iso) => iso.replace(/[-:]/g, '');

  function query(params) {
    return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  function notes(e) {
    const n = e.calendar.notes || '';
    return n.length > MAX_NOTES ? `${n.slice(0, MAX_NOTES).replace(/\s+\S*$/, '')}…\n\n${webUrl(e.url) || ''}`.trim() : n;
  }

  function googleUrl(e) {
    const c = e.calendar;
    const params = { action: 'TEMPLATE', text: e.title, dates: `${compact(c.start)}/${compact(c.end)}` };
    if (!c.allDay) params.ctz = feed.zone;
    if (c.notes) params.details = notes(e);
    if (e.map) params.location = e.map;
    return `https://calendar.google.com/calendar/render?${query(params)}`;
  }

  /** Outlook on the web; all-day ends are the day after, as in the .ics file. */
  function outlookUrl(e, host) {
    const c = e.calendar;
    const params = { path: '/calendar/action/compose', rru: 'addevent', subject: e.title, startdt: c.start, enddt: c.end };
    if (c.allDay) params.allday = 'true';
    if (c.notes) params.body = notes(e);
    if (e.map) params.location = e.map;
    return `https://${host}/calendar/0/deeplink/compose?${query(params)}`;
  }

  function fileName(e) {
    const s = e.title.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return `${s || 'event'}.ics`;
  }

  function option(kind, title, note, href, { newTab = true, download = null } = {}) {
    const a = link(href, `add-option ${kind}`, null, kind === 'file' ? 'download' : 'calendar', newTab);
    if (download) a.setAttribute('download', download);
    const text = el('span');
    text.append(el('strong', null, title), el('small', null, note));
    a.append(text);
    if (newTab) a.append(icon('open'));
    a.addEventListener('click', () => setTimeout(() => $('add').close(), 300));
    return a;
  }

  const onApple = () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);

  /** The event file of what Gemini found, made here: there's none on the site for it. One at a time. */
  let made = null;

  function openAdd(e) {
    if (made) URL.revokeObjectURL(made);
    made = e.gemini ? URL.createObjectURL(new Blob([ics(e)], { type: 'text/calendar;charset=utf-8' })) : null;
    const file = made || `ics/${encodeURIComponent(e.id)}.ics`;
    // An iPhone offers to add an event only from a real file on the web, opened in place.
    const apple = made
      ? option('apple', 'Apple Calendar', 'Downloads the event: open it to add it', file, { newTab: false, download: fileName(e) })
      : option('apple', 'Apple Calendar', 'iPhone, iPad and Mac', file, { newTab: false });
    const google = option('google', 'Google Calendar', 'Opens Google Calendar to save it', googleUrl(e));
    const outlook = option('outlook', 'Outlook.com', 'Outlook, Hotmail and Live accounts', outlookUrl(e, 'outlook.live.com'));
    const office = option('office', 'Microsoft 365', 'Outlook for work or school', outlookUrl(e, 'outlook.office.com'));
    const other = option('file', 'Download the event file', 'An .ics file for any other calendar', file, { newTab: false, download: fileName(e) });
    $('add-what').textContent = `${e.title} · ${when(e)}`;
    $('add-list').replaceChildren(...(onApple() ? [apple, google, outlook, office, other] : [google, apple, outlook, office, other]));
    $('add').showModal();
  }

  // Filters

  function check(label, checked, onChange) {
    const l = el('label', 'check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    l.append(input, el('span', null, label));
    return l;
  }

  function paintFilters() {
    $('f-regions').replaceChildren(...feed.regions.map((r) => check(r.label, filters.regions[r.id] !== false, (on) => {
      filters.regions[r.id] = on;
      filtersChanged();
    })));
    $('f-categories').replaceChildren(...feed.categories.map((c) => check(c.label, filters.categories[c.id] !== false, (on) => {
      filters.categories[c.id] = on;
      filtersChanged();
    })));
    $('f-paid').checked = filters.hidePaid;
    $('f-kids').checked = filters.hideKids;
    $('f-politics').checked = filters.hidePolitics;
  }

  function filtersChanged() {
    save('filters', filters);
    render();
  }

  // Search with Gemini
  //
  // What the app reads only with a Gemini key, read from this browser with the
  // visitor's own: the festivals' own pages and the other pages, by Gemini's
  // URL context tool, and the news sites' articles, from WordPress's API. The
  // feed's gemini block says which, and has the app's words for what's wanted.
  // What's found is kept in this browser, tinted and marked Gemini. The rules
  // are the app's, ported: Replies.extracted, Titles.tidy, Free.price,
  // Regions, TitleMatch, SameHappening, Format and CalendarTimes.

  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
  /** Both cities' pages are on one origin, so one key does for both. */
  const KEY_STORE = 'happenings:gemini-key';
  /** GeminiClient.DEFAULT_MODEL: asked when Google's list of models can't be had. */
  const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
  /** Inside the free tier's 15 requests a minute for Flash-Lite. */
  const SPACING_MS = 6500;
  const MAX_ATTEMPTS = 8;
  const MAX_BUSY_MODELS = 3;
  const MAX_BUSY_MS = 60000;
  /** DocReader's limits. */
  const MAX_ARTICLES = 15;
  const MAX_ARTICLE_AGE_DAYS = 180;
  const MAX_DOC_CHARS = 30000;
  const MAX_BATCH_CHARS = 100000;
  const MAX_BATCH_DOCS = 8;
  /** How far ahead a festival's own page is read for its dates; the rest, as far as the list goes, and this at least. */
  const WATCH_DAYS = 365;
  const PAGE_DAYS = 84;
  /** Longer than this, it's a season or an exhibition, not a happening. */
  const MAX_SPAN_DAYS = 120;
  /** A find is kept this long after the search that found it, or until it's over; a starred one until it's over. */
  const KEEP_FOUND_DAYS = 7;
  const FULL_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const HOUR_MS = 3600000;

  const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  class GeminiError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }

  const TROUBLE = {
    quota: 'Today\'s free Gemini requests are used up. Try again tomorrow.',
    busy: 'Gemini is busy right now. Try again in a few minutes.',
    net: 'Couldn\'t reach Gemini. Check your connection and try again.',
    place: 'Gemini isn\'t available where you are, or to this key.',
  };

  const stopped = () => new GeminiError('stopped', 'Stopped.');

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(stopped());
        return;
      }
      if (!(ms > 0)) {
        resolve();
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(stopped());
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // The key: in this browser if the visitor says so, otherwise only until the page closes.

  let keyInMemory = null;
  /** The models the key was found to have: { key, list }. */
  let models = null;

  function savedKey() {
    try {
      const k = localStorage.getItem(KEY_STORE) || sessionStorage.getItem(KEY_STORE);
      if (k) return k;
    } catch {
      // Storage turned off: the one in memory.
    }
    return keyInMemory;
  }

  function keyRemembered() {
    try {
      return !!localStorage.getItem(KEY_STORE);
    } catch {
      return false;
    }
  }

  function keepKey(key, remember) {
    keyInMemory = key;
    try {
      localStorage.removeItem(KEY_STORE);
      sessionStorage.removeItem(KEY_STORE);
      (remember ? localStorage : sessionStorage).setItem(KEY_STORE, key);
    } catch {
      // Kept in memory only.
    }
  }

  function forgetKey() {
    keyInMemory = null;
    models = null;
    try {
      localStorage.removeItem(KEY_STORE);
      sessionStorage.removeItem(KEY_STORE);
    } catch {
      // Nothing was kept.
    }
  }

  // Asking Gemini (GeminiClient)

  /** fetch, with what goes wrong on the way as a GeminiError. No cookies go along. */
  async function call(url, init, signal) {
    let r;
    let body = '';
    try {
      r = await fetch(url, { ...init, signal, credentials: 'omit', cache: 'no-store' });
      body = await r.text();
    } catch {
      if (signal && signal.aborted) throw stopped();
      throw new GeminiError('net', TROUBLE.net);
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** Google's error: what it says, why, how long to wait, and whether the day's quota is used up. */
  function errorOf(body) {
    let err = null;
    try {
      const o = JSON.parse(body);
      err = o && o.error && typeof o.error === 'object' ? o.error : null;
    } catch {
      // Not JSON.
    }
    const out = { message: '', reason: null, daily: false, retry: null };
    if (!err) {
      out.message = String(body || '').slice(0, 200);
      return out;
    }
    if (typeof err.message === 'string') out.message = err.message;
    for (const d of Array.isArray(err.details) ? err.details : []) {
      if (!d || typeof d !== 'object') continue;
      if (typeof d.reason === 'string') out.reason = d.reason;
      if (typeof d.retryDelay === 'string') {
        const s = parseFloat(d.retryDelay.replace(/s$/, ''));
        if (Number.isFinite(s)) out.retry = s * 1000;
      }
      for (const v of Array.isArray(d.violations) ? d.violations : []) {
        if (v && typeof v.quotaId === 'string' && /perday/i.test(v.quotaId)) out.daily = true;
      }
    }
    return out;
  }

  const keyRejected = (code, err) =>
    (code === 400 && err.reason === 'API_KEY_INVALID') || /API key not valid/i.test(err.message) || code === 401 || code === 403;

  /** The Flash models the key can use, best first. Asking for them checks the key, too. */
  async function listModels(key, signal) {
    const r = await call(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } }, signal);
    if (!r.ok) {
      const err = errorOf(r.body);
      if (keyRejected(r.status, err)) throw new GeminiError('key', 'Google didn\'t accept the key.');
      if (/location is not supported/i.test(err.message)) throw new GeminiError('place', TROUBLE.place);
      if (r.status === 429) throw new GeminiError(err.daily ? 'quota' : 'busy', err.daily ? TROUBLE.quota : TROUBLE.busy);
      if (r.status >= 500) throw new GeminiError('busy', TROUBLE.busy);
      throw new GeminiError('reply', `Gemini said: ${(err.message || `HTTP ${r.status}`).slice(0, 200)}`);
    }
    let names = [];
    try {
      const list = JSON.parse(r.body).models;
      names = (Array.isArray(list) ? list : [])
        .filter((m) => m && typeof m.name === 'string' && Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''));
    } catch {
      // The default, then.
    }
    const ranked = rankFlash(names);
    return ranked.length ? ranked : [FALLBACK_MODEL];
  }

  /** GeminiClient.rankFlash: stable Flash-Lite, newest first; then Flash; then previews. */
  function rankFlash(names) {
    const pattern = /^gemini-(\d+)(?:\.(\d+))?-flash(-lite)?(-.+)?$/;
    return [...new Set(names)]
      .map((n) => {
        const m = pattern.exec(n);
        return m && { n, major: Number(m[1]) || 0, minor: Number(m[2]) || 0, lite: !!m[3], suffix: m[4] || '' };
      })
      .filter((m) => m && !['image', 'tts', 'audio', 'live', 'thinking'].some((w) => m.suffix.includes(w)))
      .sort((a, b) => (a.suffix ? 1 : 0) - (b.suffix ? 1 : 0) || (a.lite ? 0 : 1) - (b.lite ? 0 : 1) || b.major - a.major || b.minor - a.minor)
      .map((m) => m.n);
  }

  const client = (key, list, signal) => ({ key, list, signal, model: list[0], gone: new Set(), plain: new Set(), last: 0 });

  const nextModel = (c, skip) => c.list.find((m) => m !== c.model && !c.gone.has(m) && !skip.has(m));

  /**
   * GeminiClient.request: waits out a busy model once, then tries others, and
   * moves on from a model that's been retired. A request turned away for its
   * schema, or for asking for JSON while reading a page (not every model does
   * both), is asked again in plain words, as is every later one like it to
   * that model.
   */
  async function ask(c, system, user, url) {
    const busy = new Set();
    const began = Date.now();
    let waited = false;
    for (let attempt = 1; ; attempt++) {
      const plain = c.plain.has(`${c.model}|${url}`);
      const r = await send(c, system, user, url, plain);
      if (r.ok) return parseReply(r.body, url);
      const err = errorOf(r.body);
      const code = r.status;
      if (keyRejected(code, err)) throw new GeminiError('key', 'Google didn\'t accept the key.');
      if (code === 400 && /location is not supported/i.test(err.message)) throw new GeminiError('place', TROUBLE.place);
      if (code === 400 && !plain && (url || /schema|mime|json|tool|function/i.test(err.message))) {
        c.plain.add(`${c.model}|${url}`);
      } else if (code === 404) {
        c.gone.add(c.model);
        const next = nextModel(c, busy);
        if (!next) throw new GeminiError('place', 'No Gemini Flash model is available to this key.');
        c.model = next;
      } else if (code === 429) {
        if (err.daily) throw new GeminiError('quota', TROUBLE.quota);
        if (attempt >= 3) throw new GeminiError('busy', TROUBLE.busy);
        await sleep(Math.min(Math.max(err.retry || 30000, 5000), 65000), c.signal);
      } else if (code >= 500) {
        if (Date.now() - began > MAX_BUSY_MS) throw new GeminiError('busy', TROUBLE.busy);
        if (!waited) {
          waited = true;
          await sleep(5000, c.signal);
        } else {
          busy.add(c.model);
          const next = busy.size < MAX_BUSY_MODELS && nextModel(c, busy);
          if (!next) throw new GeminiError('busy', TROUBLE.busy);
          c.model = next;
        }
      } else {
        throw new GeminiError('reply', `Gemini said: ${(err.message || `HTTP ${code}`).slice(0, 200)}`);
      }
      if (attempt >= MAX_ATTEMPTS) throw new GeminiError('reply', 'Gemini kept turning the request away.');
    }
  }

  const PLAIN_JSON = 'Reply with JSON only, no other words: {"events": [...]}, each item with doc, title, start, end, ' +
    'startTime, endTime, venue, city, cost, free, forKids, political, category and summary.';

  async function send(c, system, user, url, plain) {
    const wait = c.last + SPACING_MS - Date.now();
    if (c.last && wait > 0) await sleep(wait, c.signal);
    c.last = Date.now();
    const config = {};
    if (!plain || !url) config.responseMimeType = 'application/json';
    if (!plain) config.responseSchema = eventsSchema();
    const body = {
      systemInstruction: { parts: [{ text: plain ? `${system}\n${PLAIN_JSON}` : system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: config,
    };
    if (url) body.tools = [{ url_context: {} }];
    return call(`${GEMINI}/models/${c.model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, c.signal);
  }

  /**
   * GeminiClient.parseReply. A page Gemini was asked to read has to have been
   * opened, so nothing comes from what Gemini only remembers of it.
   */
  function parseReply(body, url) {
    let root = null;
    try {
      root = JSON.parse(body);
    } catch {
      throw new GeminiError('reply', 'Gemini\'s reply was not JSON.');
    }
    const cand = root && Array.isArray(root.candidates) ? root.candidates[0] : null;
    if (!cand || typeof cand !== 'object') {
      const blocked = root && root.promptFeedback && root.promptFeedback.blockReason;
      throw new GeminiError('reply', blocked ? 'Gemini declined to read this page.' : 'Gemini gave no answer.');
    }
    if (url && !opened(cand)) throw new GeminiError('page', 'Gemini couldn\'t open the page.');
    const parts = cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    const text = parts.filter((p) => p && p.thought !== true && typeof p.text === 'string').map((p) => p.text).join('');
    if (!text.trim()) throw new GeminiError('reply', 'Gemini gave an empty answer.');
    const json = lenientJson(text);
    if (json == null) throw new GeminiError('reply', 'Gemini\'s answer was not valid JSON.');
    return json;
  }

  function opened(cand) {
    const meta = cand.urlContextMetadata || cand.url_context_metadata;
    const list = meta && (meta.urlMetadata || meta.url_metadata);
    return Array.isArray(list) && list.some((m) => m && /SUCCESS/.test(String(m.urlRetrievalStatus || m.url_retrieval_status || '')));
  }

  /** The JSON Gemini wrote, in a code fence or not, and cut back to its last whole item if it was cut off. */
  function lenientJson(raw) {
    let text = raw.trim();
    if (text.startsWith('```')) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
      const fence = text.lastIndexOf('```');
      if (fence >= 0) text = text.slice(0, fence);
      text = text.trim();
    }
    const start = text.search(/[{[]/);
    if (start < 0) return null;
    text = text.slice(start);
    try {
      return JSON.parse(text);
    } catch {
      // Cut off, or with words after it.
    }
    const fixed = repairTruncated(text);
    if (fixed == null) return null;
    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }

  function repairTruncated(text) {
    const stack = [];
    let inString = false;
    let escaped = false;
    let safeCut = -1;
    let safeStack = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        if (!stack.length) return null;
        stack.pop();
        if (!stack.length) return text.slice(0, i + 1); // whole, with words after it
        if (stack[stack.length - 1] === '[') {
          safeCut = i + 1;
          safeStack = stack.slice();
        }
      }
    }
    if (safeCut < 0) return null;
    return text.slice(0, safeCut) + safeStack.reverse().map((c) => (c === '[' ? ']' : '}')).join('');
  }

  // What's asked (Prompts)

  const todayLine = (t) => `Today is ${FULL_WEEKDAYS[utc(t).getUTCDay()]}, ${isoDay(t)}.`;

  /** The app tells these by words (Kids, Politics); here Gemini says, so the page's filters work on its finds too. */
  const FLAG_RULES = [
    '- forKids: true if it is put on for children (a storytime, a toddler morning, a trick-or-treat, a kids\' carnival); ' +
      'false for a festival that families go to.',
    '- political: true for a protest, rally or march; a campaign or election event; a party\'s or a cause group\'s gathering; ' +
      'a town hall, council meeting or public hearing. Parades and celebrations of a people or of a cause\'s history ' +
      '(Pride, Juneteenth, MLK Day) are false unless they are a march or a rally.',
  ];

  function extractSystem(t, until) {
    const g = feed.gemini;
    return [
      `You read web pages from ${g.area} and list the happenings they announce.`,
      todayLine(t),
      g.wanted,
      `Only list happenings that take place between ${isoDay(t)} and ${isoDay(until)}.`,
      'Rules:',
      '- Use only dates stated in the text. Skip anything without a date.',
      '- If a date has no year, use the year that puts it closest to today.',
      '- Resolve relative dates such as "this Saturday" against the page\'s published date.',
      '- If a happening repeats on several dates, give each date as its own item (at most 8).',
      '- title: the happening\'s own name, without dates, prices, or the word Free.',
      '- start and end: YYYY-MM-DD; end equals start for a one-day happening.',
      '- startTime and endTime: 24-hour HH:MM if stated, otherwise null.',
      `- venue and city as stated; city is the town (${g.towns}...).`,
      '- cost: short text such as "Free" or "$10" if stated.',
      `- ${g.summaryRule}`,
      ...FLAG_RULES,
      '- doc: the number of the document the happening appears in.',
      'Return an empty list if the pages announce nothing that fits.',
    ].join('\n');
  }

  function watchSystem(t, name, until) {
    return [
      `You read a web page to find the dates of one specific happening: "${name}".`,
      todayLine(t),
      `List every upcoming date of "${name}" (or of the same happening under a slightly different name)`,
      `between ${isoDay(t)} and ${isoDay(until)}. Ignore every other event on the page.`,
      '- Use only dates stated in the text. If a date has no year, use the year that puts it closest to today.',
      '- start and end: YYYY-MM-DD; end equals start for a one-day happening. At most 8 items.',
      '- startTime and endTime: 24-hour HH:MM if stated, otherwise null.',
      '- title: the happening\'s name. venue and city as stated. cost if stated.',
      `- category: one of ${feed.categories.map((c) => c.id).join(', ')}.`,
      `- ${feed.gemini.summaryRule}`,
      ...FLAG_RULES,
      '- doc: the document number.',
      'Return an empty list if no date is given.',
    ].join('\n');
  }

  function eventsSchema() {
    const p = (type, nullable) => (nullable ? { type, nullable: true } : { type });
    return {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              doc: p('integer'),
              title: p('string'),
              start: p('string'),
              end: p('string', true),
              startTime: p('string', true),
              endTime: p('string', true),
              venue: p('string', true),
              city: p('string', true),
              cost: p('string', true),
              free: p('boolean', true),
              forKids: p('boolean', true),
              political: p('boolean', true),
              category: { type: 'string', enum: feed.categories.map((c) => c.id) },
              summary: p('string'),
            },
            required: ['doc', 'title', 'start', 'category', 'summary'],
          },
        },
      },
      required: ['events'],
    };
  }

  function docsUser(docs) {
    return docs.map((d, i) =>
      `[Document ${i + 1}]\nTitle: ${d.title}\nURL: ${d.url}\n${d.published ? `Published: ${d.published}\n` : ''}Text:\n${d.text}\n\n`).join('');
  }

  /** A page Gemini opens itself: from Google, as a site may not let a browser on another site read it. */
  const urlUser = (name, url) =>
    `[Document 1]\nTitle: ${name}\nURL: ${url}\nText: not included. Read the page at this URL with the URL context tool.\n\n`;

  // What Gemini says (Replies)

  function str(v) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
    const s = String(v).trim();
    return s && s.toLowerCase() !== 'null' ? s : null;
  }

  const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

  function dayOfIso(s) {
    const d = s ? s.slice(0, 10) : '';
    if (!ISO_DAY.test(d)) return null;
    const day = epochDay(d);
    return isoDay(day) === d ? day : null;
  }

  function minutesOf(s) {
    const m = s ? /^(\d{1,2}):(\d{2})/.exec(s) : null;
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h <= 23 && min <= 59 ? h * 60 + min : null;
  }

  /** Replies.extracted: { events: [...] }, a bare list, or the first list in the reply. */
  function extracted(reply, docs) {
    let list = [];
    if (Array.isArray(reply)) list = reply;
    else if (reply && typeof reply === 'object') list = Array.isArray(reply.events) ? reply.events : Object.values(reply).find(Array.isArray) || [];
    const ids = new Set(feed.categories.map((c) => c.id));
    const out = [];
    for (const o of list) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      let doc = 1;
      if (Number.isInteger(o.doc)) doc = o.doc;
      else if (typeof o.doc === 'string' && /^\s*[+-]?\d+\s*$/.test(o.doc)) doc = parseInt(o.doc, 10);
      if (doc < 1 || doc > docs) continue;
      const raw = str(o.title);
      const title = raw && cleanTitle(raw);
      if (!title) continue;
      const s = dayOfIso(str(o.start));
      if (s == null) continue;
      const e = dayOfIso(str(o.end));
      const startMinute = minutesOf(str(o.startTime));
      const endMinute = startMinute == null ? null : minutesOf(str(o.endTime));
      const category = (str(o.category) || '').toUpperCase().replace(/[ -]/g, '_');
      out.push({
        doc,
        title,
        s,
        e: e != null && e >= s ? e : s,
        startMinute,
        endMinute: endMinute === startMinute ? null : endMinute,
        venue: str(o.venue),
        city: str(o.city),
        cost: str(o.cost),
        free: bool(o.free),
        forKids: bool(o.forKids),
        political: bool(o.political),
        category: ids.has(category) ? category : null,
        summary: str(o.summary),
      });
    }
    return out;
  }

  /** A start tag, with its attributes quoted or not; and one attribute. */
  const HTML_TAG = /<([a-z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/gi;
  const HTML_ATTR = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

  /**
   * Another site's HTML as an inert document, so nothing in it loads or runs.
   * Its styles go first: this page's policy reports each one the parser
   * meets as a violation, though none is ever applied.
   */
  function parseHtml(html) {
    const bare = String(html)
      .replace(/<style(?=[\s/>])[\s\S]*?(?:<\/style\s*>|$)/gi, ' ')
      .replace(HTML_TAG, (tag, name, attrs, slash) =>
        `<${name}${attrs.replace(HTML_ATTR, (a, n) => (n.toLowerCase() === 'style' ? '' : a))}${slash}>`);
    return new DOMParser().parseFromString(bare, 'text/html');
  }

  /** Text, without the markup a site's HTML has. */
  const plainText = (html) => parseHtml(html).documentElement.textContent || '';

  /** Replies.cleanTitle: models sometimes leave "FREE:", the year or a date in a title. */
  function cleanTitle(raw) {
    let t = (raw.includes('&') || raw.includes('<') ? plainText(raw) : raw).replace(/\s+/g, ' ').trim();
    t = t.replace(/^(free|new)\s*[:!–—-]\s*/i, '');
    t = t.replace(/\s*[([]?\b(19|20)\d\d\b[)\]]?\s*$/, '');
    t = t.replace(/^(19|20)\d\d\s+/, '');
    t = t.replace(/^[ \-–—:|,]+|[ \-–—:|,]+$/g, '');
    return t.length >= 3 ? tidy(t) : null;
  }

  // Titles.tidy: a title that shouts, in title case.

  const ACRONYMS = new Set([
    'AAPI', 'ADA', 'AI', 'ASL', 'ASU', 'AZ', 'BIMA', 'BIPOC', 'CD', 'CID', 'DIY', 'ID', 'KEXP', 'KUOW', 'LEGO', 'LGBTQIA',
    'MIM', 'MOHAI', 'MOPOP', 'NAAM', 'NASA', 'NYC', 'NYE', 'PHX', 'PNB', 'PTA', 'PTSA', 'QTBIPOC', 'REI', 'SAAM', 'SAM',
    'SCM', 'SLU', 'SODO', 'STEAM', 'STEM', 'UFO', 'USA', 'UW', 'VR', 'WA', 'WWI', 'WWII', 'YMCA', 'YWCA',
  ]);
  const SHORTENINGS = new Set(['DR', 'FT', 'JR', 'MR', 'MRS', 'MT', 'SR', 'ST']);
  const SMALL = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'de', 'del', 'el', 'en', 'for', 'from', 'in', 'into', 'la', 'las', 'los',
    'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via', 'with', 'y',
  ]);
  const BREAKS = new Set(['-', '–', '—', '|', '/', ':']);
  const JOINERS = '-‑/';
  const ROMAN = /^[IVX]{2,4}$/;
  const DOTTED = /^(?:\p{L}\.)+\p{L}?$/u;
  const ORDINAL = /^(\d+)(ST|ND|RD|TH)$/;
  const LETTER = /\p{L}/u;
  const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;

  const letters = (s) => [...s].filter((ch) => LETTER.test(ch)).length;
  const hasVowel = (s) => /[AEIOUY]/.test(s.normalize('NFD').toUpperCase());
  const capitalized = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  function tidy(title) {
    const words = title.split(' ');
    const allLoud = letters(title) >= 4 && !/\p{Ll}/u.test(title);
    if (!allLoud && words.filter(shouts).length < 2) return title;
    let opens = true;
    return words.map((w, i) => {
      const cased = /\p{Lu}/u.test(w) && !/\p{Ll}/u.test(w) ? loudWord(w, opens, i > 0 ? words[i - 1] : null) : w;
      opens = BREAKS.has(w) || w.endsWith(':') || w.endsWith('|');
      return cased;
    }).join(' ');
  }

  function shouts(w) {
    const core = w.replace(/^[^\p{L}\p{Nd}]+|[^\p{L}\p{Nd}]+$/gu, '');
    return letters(core) >= 3 && !/[\p{Ll}\p{Nd}]/u.test(core) && !ACRONYMS.has(core) && !ROMAN.test(core) &&
      !DOTTED.test(core) && hasVowel(core);
  }

  function loudWord(w, opens, previous) {
    const chars = [...w];
    const start = chars.findIndex((ch) => LETTER_OR_DIGIT.test(ch));
    if (start < 0) return w;
    let end = chars.length;
    while (end > start && !LETTER_OR_DIGIT.test(chars[end - 1])) end--;
    const lead = chars.slice(0, start).join('');
    const first = opens || [...lead].some((ch) => '(["“‘\''.includes(ch));
    const pieces = [];
    let piece = '';
    for (const ch of chars.slice(start, end)) {
      if (JOINERS.includes(ch)) {
        pieces.push(piece, ch);
        piece = '';
      } else {
        piece += ch;
      }
    }
    pieces.push(piece);
    // A hyphenated word starts with a capital wherever it is: "In-Person", but "Trick-or-Treat".
    const cased = pieces.map((p, i) => (p.length === 1 && JOINERS.includes(p) ? p : wordPart(p, i === 0 && (first || pieces.length > 1), previous)));
    return lead + cased.join('') + chars.slice(end).join('');
  }

  function wordPart(p, first, previous) {
    if (!LETTER.test(p)) return p;
    const ordinal = ORDINAL.exec(p);
    if (ordinal) return ordinal[1] + ordinal[2].toLowerCase();
    if (/\p{Nd}/u.test(p) || p.includes('&') || DOTTED.test(p)) return p;
    const lower = p.toLowerCase();
    if (!first && SMALL.has(lower)) return lower;
    if ([...p].length === 1) return p;
    if (SHORTENINGS.has(p)) return capitalized(lower);
    if (ACRONYMS.has(p) || ROMAN.test(p) || !hasVowel(p)) return p;
    if ((p === 'AM' || p === 'PM') && previous && /\p{Nd}$/u.test(previous)) return p;
    if (p.length > 3 && p.startsWith('MC')) return `Mc${capitalized(lower.slice(2))}`;
    const apostrophe = p.search(/['’]/);
    if (apostrophe > 0) {
      const before = p.slice(0, apostrophe);
      const after = lower.slice(apostrophe + 1);
      // O'Brien and D'Angelo, but Seattle's and Don't.
      const name = (before === 'O' || before === 'D') && after.length >= 2;
      return capitalized(before.toLowerCase()) + p[apostrophe] + (name ? capitalized(after) : after);
    }
    return capitalized(lower);
  }

  // Free.price: whether a cost says it's free.

  const SOME = '(?:members?|kids?|children|childs?|students?|seniors?|veterans?|military|youth|teens?|toddlers?|babies|baby|infants?|' +
    '(?:kids?|children|ages?|those|anyone|guests) (?:under|younger than|aged?) \\d+|under \\d+|' +
    'ages? \\d+(?: \\d+)?(?: (?:and|or) (?:under|younger))?|\\d+ (?:years? )?(?:and|or) (?:under|younger|below))';
  const FOR_SOME_ONLY = '(?! (?:and|or) (?:families|family|adults|parents|grownups|caregivers)| of all ages)';
  const SOME_FREE = new RegExp(
    ` ${SOME}(?: (?:are|get in|gets in|enter|go|get|eat|always|admitted))* free(?= )` +
      `| free (?:admission |entry |entrance )?(?:for|to) ${SOME}${FOR_SOME_ONLY}(?= )` +
      '| (?:one|1|a) free (?:child|kid|youth|adult|companion)(?: ticket| admission| entry)?(?= )',
    'g',
  );
  const NEEDS_ADMISSION = new RegExp(
    ' (?:included|includes|include|free|access) (?:with|in) (?:(?:paid|general|museum|zoo|garden|gardens|gallery|park|gate|' +
      'regular|daily|your|a|valid|the|standard|day|aquarium) )*(?:admission|ticket|tickets|entry|membership|pass)(?= )' +
      '| (?:with|requires|require|requiring|plus) (?:(?:paid|museum|zoo|garden|gardens|park|gate|regular|daily|valid|general) )+admission(?= )' +
      '| (?:regular|general|museum|zoo|garden|standard|normal|daily) admission (?:applies|apply|rates apply|prices apply|required|fees apply)(?= )',
  );
  const FREE_OF_SOMETHING = new RegExp(
    ' (?:gluten|dairy|nut|peanut|sugar|alcohol|smoke|smoking|tobacco|vape|drug|scent|fragrance|car|cash|' +
      'waste|plastic|tax|fear|stress|hands|hassle|worry|care|cruelty|latex|allergy|allergen|meat|fat|caffeine|' +
      'duty|debt|crime|litter|trash|carbon|fossil|soy|egg|wheat|grain|chemical|pesticide|barrier|' +
      'born|break|breaking|set|feel|land of the|home of the|wild and) free(?= )',
    'g',
  );
  const FREE_WORD = / (?:free|complimentary|gratis|no (?:cost|charge|fee|fees|cover|admission))(?= )/;
  const MONEY_WORDS = / \d+(?: \d{2})? (?:usd|dollars?|bucks|each|pp|per (?:person|adult|child|kid|car|vehicle|family|ticket|player|team|couple|household))(?= )/;

  const plainCost = (text) => normalize(text.replace(/(\d+)\s*\+/g, '$1 and up')).replace(FREE_OF_SOMETHING, ' ').replace(/ {2,}/g, ' ');

  function freeFrom(cost) {
    if (!cost || !cost.trim()) return null;
    const raw = cost.replace(/\$\s?0+(?:\.0+)?(?![.\d])/g, ' free ');
    let c = plainCost(raw);
    if (!c.trim()) return null;
    if (NEEDS_ADMISSION.test(c)) return false;
    c = c.replace(SOME_FREE, ' ');
    const free = FREE_WORD.test(c);
    const money = raw.includes('$') || MONEY_WORDS.test(c);
    // "Free – $25": free to get in, with something extra to buy.
    if (free && (!money || c.trimStart().startsWith('free'))) return true;
    if (money || /\d/.test(c)) return false;
    if (/ (?:donation|donations)(?= )/.test(c)) return true;
    return null;
  }

  // Regions: where a find is, by the area's towns and neighborhoods.

  let places = { byName: new Map(), hoods: new Set(), outside: [], text: [], address: [], country: /$^/g, state: '' };
  const STOP_WORDS = ['the', 'a', 'an', 'annual', 'free', 'at', 'of', 'in', 'on', 'and', 'for', 'to', 'with',
    'presents', 'present', 'returns', 'return', 'edition', 'event'];
  let stopWords = new Set(STOP_WORDS);

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function learnPlaces(g) {
    const byName = new Map(Object.entries(g.places && typeof g.places === 'object' ? g.places : {}));
    const cityOnly = new Set(Array.isArray(g.cityOnly) ? g.cityOnly : []);
    const outside = Array.isArray(g.outside) ? g.outside.filter((n) => typeof n === 'string' && n) : [];
    // A name on its own, as a word or words: "(?<![a-z0-9])" is left out for Safari before 16.4.
    const pattern = (name) => {
      const source = `(^|[^a-z0-9])${escapeRe(name)}(?![a-z0-9])`;
      return { name, re: new RegExp(source), all: new RegExp(source, 'g'), region: byName.get(name) || null };
    };
    // Longest first, so "west seattle junction" wins over "seattle".
    const longest = (a, b) => b.length - a.length;
    const states = (Array.isArray(g.stateNames) ? g.stateNames : []).map(escapeRe);
    places = {
      byName,
      hoods: new Set(Array.isArray(g.neighborhoods) ? g.neighborhoods : []),
      outside,
      text: [...byName.keys()].filter((n) => !cityOnly.has(n)).sort(longest).map(pattern),
      address: [...new Set([...byName.keys(), ...outside])].sort(longest).map(pattern),
      country: new RegExp(`\\b(${[...states, 'usa', 'us', 'city of'].join('|')})\\b`, 'g'),
      state: typeof g.state === 'string' ? g.state : '',
    };
    stopWords = new Set([...STOP_WORDS, places.state.toLowerCase()].filter(Boolean));
  }

  /** Regions.normalize: lower case, no accents, punctuation to spaces. */
  function placeText(text) {
    return text.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase()
      .replace(/c-id/g, 'cid')
      .replace(/[^a-z0-9,.\- ]/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** A city without its zip code, state or country: "Seattle, WA 98104" is "seattle". */
  function cityText(city) {
    return placeText(city)
      .replace(/\b\d{5}(-\d{4})?\b/g, ' ')
      .replace(/[,.]/g, ' ')
      .replace(places.country, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** A town or neighborhood by name, or a place outside the area. */
  function knownPlace(name) {
    const n = cityText(name);
    return n !== '' && (places.byName.has(n) || places.outside.includes(n));
  }

  /** Regions.find: the first name found, an outside one included. */
  function findPlace(city, address, venue, title) {
    if (city) {
      const n = cityText(city);
      if (places.byName.has(n)) return n;
      if (n && places.outside.includes(n)) return n;
    }
    if (address) {
      const p = inAddress(placeText(address));
      if (p) return p.name;
    }
    for (const field of [venue, title]) {
      if (!field || !field.trim()) continue;
      const n = placeText(field);
      const p = places.text.find((x) => x.re.test(n));
      if (p) return p.name;
    }
    return null;
  }

  /** The name that ends last in an address, the town coming after the street: "Scottsdale Rd, Tempe". */
  function inAddress(n) {
    let best = null;
    let bestEnd = -1;
    for (const p of places.address) {
      p.all.lastIndex = 0;
      let end = -1;
      let m;
      while ((m = p.all.exec(n))) end = m.index + m[0].length - 1;
      if (end > bestEnd) {
        best = p;
        bestEnd = end;
      }
    }
    return best;
  }

  function detectRegion(city, venue, title) {
    const n = findPlace(city, null, venue, title);
    return n ? places.byName.get(n) || null : null;
  }

  function placeName(city, address, venue) {
    const n = findPlace(city, address, venue, null);
    return n && places.byName.has(n) ? n : null;
  }

  /** Regions.isOutside, by the city: Portland, Tucson, another state. */
  function isOutside(city) {
    if (!city) return false;
    const n = cityText(city);
    if (places.byName.has(n)) return false;
    return places.outside.some((o) => n === o || n.startsWith(`${o} `));
  }

  // TitleMatch: titles as sets of the words that say what they are.

  function titleWords(text) {
    const t = text.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/c-id/g, 'cid')
      .replace(/c\.i\.d\./g, 'cid')
      .replace(/['’]s\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\bchinatown international district\b/g, 'cid')
      .replace(/\bchinatown id\b/g, 'cid')
      .replace(/\binternational district\b/g, 'cid');
    return t.split(' ')
      .filter((w) => w && !stopWords.has(w) && !/^\d+(st|nd|rd|th)$/.test(w) && !/^(19|20)\d\d$/.test(w) && !/^\d+$/.test(w))
      .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  }

  const tokens = (text) => new Set(text ? titleWords(text) : []);
  /** TitleMatch.key, which the feed's series are the hash of. */
  const seriesKey = (title) => [...tokens(title)].sort().join(' ');

  function sharedCount(a, b) {
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n;
  }

  const unionSize = (a, b) => a.size + b.size - sharedCount(a, b);
  const containsAll = (a, b) => [...b].every((x) => a.has(x));
  const without = (a, b) => new Set([...a].filter((x) => !b.has(x)));

  function sameTokens(a, b) {
    if (!a.size || !b.size) return false;
    const n = sharedCount(a, b);
    const smaller = Math.min(a.size, b.size);
    if (smaller >= 2 && n / smaller >= 0.8) return true;
    return n / unionSize(a, b) >= 0.6;
  }

  function sameAtVenue(a, aVenue, b, bVenue) {
    if (sameTokens(a, b)) return true;
    const venues = new Set([...aVenue, ...bVenue]);
    if (!venues.size) return false;
    const aRest = without(a, venues);
    const bRest = without(b, venues);
    if (!aRest.size || !bRest.size) return false;
    return (aRest.size !== a.size || bRest.size !== b.size) && sharedCount(aRest, bRest) / unionSize(aRest, bRest) >= 0.6;
  }

  const datesOverlap = (aStart, aEnd, bStart, bEnd, slack = 1) => aStart <= bEnd + slack && bStart <= aEnd + slack;
  const regionsCompatible = (a, b) => !a || !b || a === b;

  /** TitleMatch.matchesWatch: whether a date read off a festival's page is the festival's. */
  function matchesWatch(name, title, region, venue) {
    const w = tokens(name);
    const t = tokens(title);
    if (!w.size || !t.size) return false;
    if (!regionsCompatible(detectRegion(null, null, name), region)) return false;
    const n = sharedCount(w, t);
    if (n / w.size >= 0.8) return true;
    if (n >= 2 && n / unionSize(w, t) >= 0.6) return true;
    const rest = without(w, tokens(venue));
    return rest.size >= 1 && rest.size < w.size && containsAll(t, rest);
  }

  // SameHappening: whether a find is what the list has already, or another find.

  const clueCache = new WeakMap();
  const startDay = (x) => (x.s != null ? x.s : epochDay(x.start));
  const endDay = (x) => (x.e != null ? x.e : epochDay(x.end));

  /**
   * A listed date's venue, town and street address, from its place lines: the
   * feed has them only as Format wrote them. The last part of the place is
   * its town when it's a town's name, after any state or zip.
   */
  function whereOf(e) {
    const lines = e.placeLines ? e.placeLines.split('\n') : [];
    let address = null;
    if (lines.length > 1) address = lines.slice(1).join(', ');
    else if (lines.length === 1 && lines[0] !== e.place) address = lines[0];
    let venue = null;
    let city = null;
    if (e.place) {
      const parts = e.place.split(',').map((p) => p.trim()).filter(Boolean);
      while (parts.length > 1 && !cityText(parts[parts.length - 1])) parts.pop();
      const last = parts[parts.length - 1];
      if (last && knownPlace(last)) {
        city = last;
        venue = parts.length > 1 ? parts.slice(0, -1).join(', ') : null;
      } else {
        venue = e.place;
      }
    }
    return { venue, city, address };
  }

  function cluesOf(x) {
    let c = clueCache.get(x);
    if (c) return c;
    const where = x.gemini ? { venue: x.venue || null, city: x.city || null, address: null } : whereOf(x);
    const venueInOrder = where.venue ? titleWords(where.venue) : [];
    c = {
      s: startDay(x),
      e: endDay(x),
      m: x.startMinute == null ? null : x.startMinute,
      region: x.region || null,
      words: tokens(x.title),
      venueInOrder,
      venueWords: new Set(venueInOrder),
      link: linkOf(x.url),
      venue: where.venue,
      city: where.city,
      address: where.address,
      town: undefined,
      core: null,
      addressInOrder: null,
    };
    clueCache.set(x, c);
    return c;
  }

  /** The town, or null when it can't be told or is only a neighborhood. */
  function townOf(c) {
    if (c.town === undefined) {
      const where = [c.address, c.city].filter(Boolean).join(', ') || null;
      const n = placeName(c.city, where, c.venue);
      c.town = n && !places.hoods.has(n) ? n : null;
    }
    return c.town;
  }

  /** The title's words that aren't its venue's or its town's: "oxtober" of "Oxtober at Oxbow Farm". */
  function coreOf(c) {
    if (!c.core) {
      const town = townOf(c);
      const core = without(without(c.words, c.venueWords), tokens(town));
      c.core = core.size ? core : c.words;
    }
    return c.core;
  }

  /** SameHappening.link: a page, without what doesn't tell two apart; a site's home page isn't one. */
  function linkOf(url) {
    if (!url) return null;
    const u = url.trim().toLowerCase().split('#')[0].replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
    return u.includes('/') || u.includes('?') ? u : null;
  }

  function namesVenueOf(a, b) {
    const venue = b.venueInOrder;
    if (venue.length < 2) return false;
    if (!a.addressInOrder) a.addressInOrder = a.address ? titleWords(a.address) : [];
    const words = a.addressInOrder;
    for (let i = 0; i + venue.length <= words.length; i++) {
      if (venue.every((w, j) => words[i + j] === w)) return true;
    }
    return false;
  }

  function sameVenue(a, b) {
    if (!a.size || !b.size) return false;
    if (a.size === b.size && containsAll(a, b)) return true;
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
    return smaller.size >= 2 && containsAll(larger, smaller);
  }

  /** Finds have no street address, so SameHappening's street numbers don't come into it. */
  const samePlace = (a, b) => sameVenue(a.venueWords, b.venueWords) || namesVenueOf(a, b) || namesVenueOf(b, a);

  /** One town by two names: "Bainbridge" and "Bainbridge Island". */
  const sameTown = (a, b) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);

  const startsDiffer = (a, b) => a.m != null && b.m != null && a.m !== b.m;

  function closeTitles(a, b) {
    if (!a.size || !b.size) return false;
    if (a.size === b.size && containsAll(a, b)) return true;
    const smaller = Math.min(a.size, b.size);
    return smaller >= 2 && sharedCount(a, b) * 5 >= smaller * 4;
  }

  function apart(a, b) {
    if (!regionsCompatible(a.region, b.region)) return true;
    const aTown = townOf(a);
    const bTown = townOf(b);
    if (!aTown || !bTown) return false;
    return !sameTown(aTown, bTown) && !samePlace(a, b) && !(a.link != null && a.link === b.link && closeTitles(a.words, b.words));
  }

  function alike(a, b) {
    if (!datesOverlap(a.s, a.e, b.s, b.e)) return false;
    const atVenue = samePlace(a, b);
    if (a.venueWords.size && b.venueWords.size && !atVenue) {
      if (!startsDiffer(a, b) && closeTitles(a.words, b.words) && datesOverlap(a.s, a.e, b.s, b.e, 0)) return true;
    } else if (sameAtVenue(a.words, a.venueWords, b.words, b.venueWords)) {
      return true;
    }
    if (atVenue && !startsDiffer(a, b) && ((a.s === a.e) === (b.s === b.e) || a.s === b.s)) {
      const ac = coreOf(a);
      const bc = coreOf(b);
      if (containsAll(ac, bc) || containsAll(bc, ac)) return true;
    }
    const sameStart = a.s === b.s && a.m != null && a.m === b.m;
    if (sameStart && (atVenue || (a.link != null && a.link === b.link))) {
      const ac = coreOf(a);
      const bc = coreOf(b);
      const n = sharedCount(ac, bc);
      return n > 0 && n * 2 >= Math.min(ac.size, bc.size);
    }
    return false;
  }

  function sameHappening(x, y) {
    if (!datesOverlap(startDay(x), endDay(x), startDay(y), endDay(y))) return false;
    const a = cluesOf(x);
    const b = cluesOf(y);
    return alike(a, b) && !apart(a, b);
  }

  // How a find reads, and what a calendar gets (Format, Links.mapQuery, CalendarTimes)

  function clock(minute, withMeridiem = true) {
    const m = ((minute % 1440) + 1440) % 1440;
    const h24 = Math.floor(m / 60);
    const min = m % 60;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const base = min === 0 ? `${h12}` : `${h12}:${String(min).padStart(2, '0')}`;
    return withMeridiem ? `${base} ${h24 < 12 ? 'AM' : 'PM'}` : base;
  }

  /** "1–9 PM", "10 AM–6 PM", "7:30 PM". */
  function timeRange(start, end) {
    if (start == null) return null;
    if (end == null || end === start) return clock(start);
    const sameHalf = (start < 720) === (end < 720);
    return `${clock(start, !sameHalf)}–${clock(end)}`;
  }

  function placeOf(venue, city) {
    const v = venue && venue.trim() ? venue.trim() : null;
    const c = city && city.trim() ? city.trim() : null;
    if (!v) return c;
    return !c || v.toLowerCase().includes(c.toLowerCase()) ? v : `${v}, ${c}`;
  }

  function costLabel(cost, free) {
    if (free === true) return 'Free';
    return cost && cost.trim() && cost.length <= 40 ? cost.trim() : null;
  }

  function mapQuery(venue, city) {
    const parts = [venue, city].map((p) => (p || '').trim()).filter(Boolean);
    if (!parts.length) return null;
    const kept = [];
    for (const p of parts) if (!kept.some((k) => k.toLowerCase().includes(p.toLowerCase()))) kept.push(p);
    const q = kept.join(', ');
    return !city && places.state && !q.includes(places.state) ? `${q}, ${places.state}` : q;
  }

  const zoneFormats = new Map();

  /** How far the zone's clock is ahead of UTC at an instant. */
  function zoneOffset(ms, zone) {
    if (!zoneFormats.has(zone)) {
      zoneFormats.set(zone, new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      }));
    }
    const p = {};
    for (const part of zoneFormats.get(zone).formatToParts(new Date(ms))) p[part.type] = part.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  }

  /** The instant a day and minute are on the zone's clocks. */
  function wallClock(day, minute, zone) {
    const local = day * DAY_MS + Math.min(Math.max(minute, 0), 1439) * 60000;
    const first = local - zoneOffset(local, zone);
    return local - zoneOffset(first, zone);
  }

  const instant = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  /** CalendarTimes: a day with a start time goes in with its hours; anything longer, all day, with the hours in the notes. */
  function calendarOf(g, s, e) {
    const hours = e > s && g.startMinute != null ? `Hours: ${timeRange(g.startMinute, g.endMinute)}` : null;
    const notes = [hours, g.summary, g.url].filter(Boolean).join('\n\n') || null;
    if (g.startMinute == null || e > s) return { allDay: true, start: isoDay(s), end: isoDay(e + 1), notes };
    const begin = wallClock(s, g.startMinute, feed.zone);
    let end = begin + HOUR_MS;
    if (g.endMinute != null && g.endMinute > g.startMinute) end = wallClock(s, g.endMinute, feed.zone);
    else if (g.endMinute != null && g.endMinute < g.startMinute) end = wallClock(s + 1, g.endMinute, feed.zone);
    return { allDay: false, start: instant(begin), end: instant(end), notes };
  }

  /** WebFeed.text: an iCalendar TEXT value. */
  function icsText(s) {
    let out = '';
    for (const ch of s.replace(/\r\n/g, '\n')) {
      if (ch === '\\') out += '\\\\';
      else if (ch === ';') out += '\\;';
      else if (ch === ',') out += '\\,';
      else if (ch === '\n' || ch === '\r') out += '\\n';
      else if (ch === '\t') out += ch;
      else if (ch >= ' ' && ch !== '\u007f') out += ch;
    }
    return out;
  }

  /** WebFeed.fold: lines of at most 75 bytes, never broken inside a character. */
  function fold(line) {
    if (new TextEncoder().encode(line).length <= 75) return line;
    let out = '';
    let used = 0;
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      const bytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (used + bytes > 75) {
        out += '\r\n ';
        used = 1;
      }
      out += ch;
      used += bytes;
    }
    return out;
  }

  const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  /** WebFeed.ics, for a find: the site has no file of it, so it's made here. */
  function ics(e) {
    const c = e.calendar;
    const stamp = (iso) => iso.replace(/[-:]/g, '');
    const foundAt = Date.parse(e.found);
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:-//${feed.app}//Search with Gemini//EN`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${e.id}-${slug(feed.app)}@${location.hostname || 'localhost'}`,
      `DTSTAMP:${stamp(instant(Number.isFinite(foundAt) ? foundAt : Date.now()))}`,
    ];
    if (c.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${c.start.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${c.end.replace(/-/g, '')}`, 'TRANSP:TRANSPARENT');
    } else {
      lines.push(`DTSTART:${stamp(c.start)}`, `DTEND:${stamp(c.end)}`);
    }
    lines.push(`SUMMARY:${icsText(e.title)}`);
    if (e.map) lines.push(`LOCATION:${icsText(e.map)}`);
    if (c.notes) lines.push(`DESCRIPTION:${icsText(c.notes)}`);
    const url = webUrl(e.url);
    if (url) lines.push(`URL:${url}`);
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.map((l) => `${fold(l)}\r\n`).join('');
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    if (window.crypto && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Without a secure context there's no SHA-256: a find's series then won't match the list's.
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (const b of bytes) {
      h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  // Finds: kept in this browser.

  /** What's kept of a find; the rest is worked out again when it's loaded ([dress]). */
  const FIND_FIELDS = ['id', 'series', 'title', 'start', 'end', 'startMinute', 'endMinute', 'venue', 'city', 'region', 'category',
    'costText', 'free', 'watch', 'kids', 'political', 'summary', 'url', 'via', 'sources', 'from', 'found'];

  const fallbackCategory = () => (feed.categories.some((c) => c.id === 'COMMUNITY') ? 'COMMUNITY' : feed.categories[0].id);

  /** A find with what the page shows of it, as the feed's dates have. */
  function dress(g) {
    const s = epochDay(g.start);
    const e = epochDay(g.end);
    g.gemini = true;
    g.dates = dateRange(s, e);
    g.time = timeRange(g.startMinute, g.endMinute);
    g.place = placeOf(g.venue, g.city);
    g.placeLines = g.place;
    g.cost = costLabel(g.costText, g.free);
    g.map = mapQuery(g.venue, g.city);
    g.calendar = calendarOf(g, s, e);
    clueCache.delete(g);
    return g;
  }

  /** DocReader.candidateOf: a date Gemini read, as a find; null if it's outside the area or the time looked at. */
  async function findOf(x, step, run) {
    if (isOutside(x.city)) return null;
    if (x.e < today || x.s > step.until || x.e - x.s + 1 > MAX_SPAN_DAYS) return null;
    const region = detectRegion(x.city, x.venue, x.title);
    // A festival's own page's dates are the festival's: its name, if Gemini's differs.
    const title = step.watch && !matchesWatch(step.name, x.title, region, x.venue) ? step.name : x.title;
    const key = seriesKey(title);
    const minute = x.startMinute == null ? -1 : x.startMinute;
    const hash = await sha256([key, isoDay(x.s), region || '', (x.venue || '').toLowerCase(), minute].join('|'));
    return dress({
      id: `g-${hash.slice(0, 10)}`,
      series: (await sha256(key)).slice(0, 10),
      title,
      start: isoDay(x.s),
      end: isoDay(x.e),
      startMinute: x.startMinute,
      endMinute: x.endMinute,
      venue: x.venue,
      city: x.city,
      region,
      category: x.category || fallbackCategory(),
      costText: x.cost,
      free: x.free != null ? x.free : freeFrom(x.cost),
      watch: step.watch,
      kids: x.forKids === true,
      political: x.political === true,
      summary: x.summary,
      url: webUrl(x.url),
      via: step.via,
      sources: [step.via],
      from: step.name,
      found: run.at,
    });
  }

  /**
   * One happening found twice in a search is one find, with what each had.
   * Not one page's dates, though: a market every Saturday is a date each.
   */
  function addFind(run, g) {
    const twin = run.finds.find((f) => !(f.from === g.from && f.start !== g.start) && sameHappening(f, g));
    if (!twin) {
      const base = g.id;
      for (let n = 2; run.finds.some((f) => f.id === g.id); n++) g.id = `${base}-${n}`;
      run.finds.push(g);
      return;
    }
    if (twin.startMinute == null && g.startMinute != null) {
      twin.startMinute = g.startMinute;
      twin.endMinute = g.endMinute;
    } else if (twin.endMinute == null && g.endMinute != null && twin.startMinute === g.startMinute) {
      twin.endMinute = g.endMinute;
    }
    for (const k of ['venue', 'city', 'costText', 'free', 'summary', 'region']) {
      if (twin[k] == null && g[k] != null) twin[k] = g[k];
    }
    twin.sources = [...new Set([...twin.sources, ...g.sources])];
    twin.watch = twin.watch || g.watch;
    twin.kids = twin.kids || g.kids;
    twin.political = twin.political || g.political;
    dress(twin);
  }

  function validFind(g) {
    return !!g && typeof g === 'object' && typeof g.id === 'string' && /^g-[0-9a-f]{10}(-\d+)?$/.test(g.id) &&
      typeof g.title === 'string' && g.title.trim() !== '' && typeof g.series === 'string' &&
      typeof g.start === 'string' && dayOfIso(g.start) != null && typeof g.end === 'string' && dayOfIso(g.end) != null && g.start <= g.end;
  }

  /** What was found and kept in this browser: what's not over, from the last week's searches, or starred. */
  function loadFound() {
    const out = { v: 1, at: null, model: null, events: [], read: [] };
    const raw = load('gemini', null);
    if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.events)) return out;
    const saved = load('stars', {});
    const since = Date.now() - KEEP_FOUND_DAYS * DAY_MS;
    const ids = new Set(feed.categories.map((c) => c.id));
    const minute = (m) => (Number.isInteger(m) && m >= 0 && m < 1440 ? m : null);
    const text = (s) => (typeof s === 'string' && s.trim() ? s : null);
    for (const g of raw.events) {
      if (!validFind(g) || epochDay(g.end) < today) continue;
      if (!(Date.parse(g.found) >= since) && !owns(saved, g.id)) continue;
      const startMinute = minute(g.startMinute);
      out.events.push(dress({
        id: g.id,
        series: g.series,
        title: g.title,
        start: g.start,
        end: g.end,
        startMinute,
        endMinute: startMinute == null ? null : minute(g.endMinute),
        venue: text(g.venue),
        city: text(g.city),
        region: places.byName.size && [...places.byName.values()].includes(g.region) ? g.region : null,
        category: ids.has(g.category) ? g.category : fallbackCategory(),
        costText: text(g.costText),
        free: typeof g.free === 'boolean' ? g.free : null,
        watch: g.watch === true,
        kids: g.kids === true,
        political: g.political === true,
        summary: text(g.summary),
        url: webUrl(g.url),
        via: text(g.via),
        sources: Array.isArray(g.sources) ? g.sources.filter((s) => typeof s === 'string') : [],
        from: text(g.from),
        found: text(g.found),
      }));
    }
    const at = Date.parse(raw.at);
    if (out.events.length || at >= since) {
      out.at = Number.isFinite(at) ? raw.at : null;
      out.model = typeof raw.model === 'string' ? raw.model : null;
      out.read = (Array.isArray(raw.read) ? raw.read : [])
        .filter((r) => r && typeof r.name === 'string')
        .map((r) => ({ name: r.name, ok: r.ok === true }));
    }
    return out;
  }

  function saveFound() {
    save('gemini', {
      v: 1,
      at: found.at,
      model: found.model,
      events: found.events.map((g) => Object.fromEntries(FIND_FIELDS.map((k) => [k, g[k] === undefined ? null : g[k]]))),
      read: found.read,
    });
  }

  /**
   * What a search has found so far goes on the list. What an earlier search
   * found stays only if its page couldn't be read this time, or it's starred;
   * one found again passes its star on to the new find.
   */
  function commit(run) {
    const read = new Set(run.read.filter((r) => r.ok).map((r) => r.name));
    const saved = load('stars', {});
    let moved = false;
    const kept = [];
    for (const old of run.old) {
      const again = run.finds.find((g) => sameHappening(old, g));
      if (again) {
        if (again.id !== old.id && owns(saved, old.id)) {
          if (!owns(saved, again.id)) saved[again.id] = starOf(again);
          delete saved[old.id];
          moved = true;
        }
        continue;
      }
      if (!read.has(old.from) || owns(saved, old.id)) kept.push(old);
    }
    if (moved) save('stars', saved);
    found = { v: 1, at: run.any ? run.at : run.before, model: run.model, events: [...run.finds, ...kept], read: run.read.slice() };
    saveFound();
    index();
    loadStars();
    render();
    paintStatus();
  }

  function clearFound() {
    const kept = found.events.filter((g) => isStarred(g.id));
    found = { v: 1, at: null, model: found.model, events: kept, read: [] };
    problem = null;
    saveFound();
    index();
    loadStars();
    render();
    paintStatus();
    toast(kept.length ? 'Cleared. Starred ones stay until they\'re over.' : 'Cleared what Gemini found');
  }

  // Reading: festivals' pages and the other pages by Gemini's URL context tool, news by WordPress's API.

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  /** What a search reads, in the app's order: the festivals' own pages, then the rest. */
  function plan() {
    const g = feed.gemini;
    const until = Math.max(dayOfIso(feed.until) || 0, today + PAGE_DAYS);
    const steps = [];
    for (const w of Array.isArray(g.watches) ? g.watches : []) {
      const url = webUrl(w && w.url);
      if (url && w.name) steps.push({ kind: 'watch', name: w.name, url, via: hostOf(url), watch: true, until: today + WATCH_DAYS });
    }
    for (const s of Array.isArray(g.sources) ? g.sources : []) {
      const url = webUrl(s && s.url);
      if (url && s.name) steps.push({ kind: s.feed ? 'news' : 'page', name: s.name, url, via: s.name, watch: false, until });
    }
    return steps;
  }

  /** HtmlText.fromHtml, near enough: the words, a line to each block. */
  function htmlText(html) {
    if (!html) return '';
    const doc = parseHtml(html);
    for (const n of doc.querySelectorAll('script, style, noscript, template, iframe, svg, form, button')) n.remove();
    for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
    for (const b of doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote, figcaption, dt, dd, pre, table, ul, ol, section, article')) {
      b.append('\n');
    }
    const text = (doc.body ? doc.body.textContent : '').replace(/[^\S\n]+/g, ' ').replace(/ ?\n[\s]*/g, '\n').trim();
    return text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text;
  }

  async function getJson(url, signal) {
    const r = await fetch(url, { signal, credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /**
   * A news site's latest articles in its category, as the app reads its feed:
   * from WordPress's API, which lets other sites read it, where its feed
   * doesn't. Null if the site's API can't be read.
   */
  async function articles(step, signal) {
    const m = /^(https:\/\/[^/]+)\/category\/([^/?#]+)\/feed\/?$/.exec(step.url);
    if (!m) return null;
    try {
      const cats = await getJson(`${m[1]}/wp-json/wp/v2/categories?slug=${m[2]}&_fields=id`, signal);
      const id = Array.isArray(cats) && cats[0] ? cats[0].id : null;
      if (!Number.isInteger(id)) return null;
      const posts = await getJson(`${m[1]}/wp-json/wp/v2/posts?categories=${id}&per_page=${MAX_ARTICLES}&_fields=link,date,title,content`, signal);
      if (!Array.isArray(posts)) return null;
      const docs = [];
      for (const p of posts) {
        if (!p || typeof p !== 'object') continue;
        const published = typeof p.date === 'string' && ISO_DAY.test(p.date.slice(0, 10)) ? p.date.slice(0, 10) : null;
        if (published && epochDay(published) < today - MAX_ARTICLE_AGE_DAYS) continue;
        const text = htmlText(p.content && typeof p.content.rendered === 'string' ? p.content.rendered : '');
        if (text.length < 200) continue;
        const title = p.title && typeof p.title.rendered === 'string' ? plainText(p.title.rendered).trim() : '';
        docs.push({ title: title || step.name, url: webUrl(p.link) || step.url, published, text });
      }
      return docs;
    } catch {
      if (signal.aborted) throw stopped();
      return null;
    }
  }

  function batches(docs) {
    const out = [];
    let batch = [];
    let size = 0;
    for (const d of docs) {
      if (batch.length && (size + d.text.length > MAX_BATCH_CHARS || batch.length >= MAX_BATCH_DOCS)) {
        out.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(d);
      size += d.text.length;
    }
    if (batch.length) out.push(batch);
    return out;
  }

  /** A bad key, the day's quota, a busy Gemini, no connection or Stop end the search; anything else, only this page. */
  const endsSearch = (err) => err instanceof GeminiError && err.kind !== 'reply' && err.kind !== 'page';

  /** One page or news site: what Gemini read off it, and whether all of it was read. */
  async function readStep(c, step) {
    const items = [];
    if (step.kind === 'news') {
      const docs = await articles(step, c.signal);
      if (docs) {
        let failed = null;
        for (const batch of batches(docs)) {
          try {
            const reply = await ask(c, extractSystem(today, step.until), docsUser(batch), false);
            for (const x of extracted(reply, batch.length)) items.push({ ...x, url: batch[x.doc - 1].url });
          } catch (err) {
            if (endsSearch(err)) throw err;
            failed = err;
          }
        }
        if (failed && !items.length) throw failed;
        return { items, whole: !failed };
      }
    }
    // A news site whose API can't be read: its category's page, as Gemini reads the rest.
    const url = step.kind === 'news' ? step.url.replace(/feed\/?$/, '') : step.url;
    const system = step.kind === 'watch' ? watchSystem(today, step.name, step.until) : extractSystem(today, step.until);
    const reply = await ask(c, system, urlUser(step.name, url), true);
    for (const x of extracted(reply, 1)) items.push({ ...x, url });
    return { items, whole: true };
  }

  async function search() {
    if (searching || !feed || !feed.gemini) return;
    const key = savedKey();
    if (!key) {
      openKey();
      return;
    }
    const ctl = new AbortController();
    searching = { ctl, i: 0, n: 0, name: null };
    problem = null;
    paintStatus();
    const run = { at: new Date().toISOString(), before: found.at, old: found.events.slice(), finds: [], read: [], any: false, model: found.model };
    let stop = null;
    try {
      const list = models && models.key === key ? models.list : await listModels(key, ctl.signal);
      models = { key, list };
      const c = client(key, list, ctl.signal);
      const steps = plan();
      searching.n = steps.length;
      for (const [i, step] of steps.entries()) {
        searching.i = i + 1;
        searching.name = step.name;
        paintStatus();
        let whole = false;
        try {
          const got = await readStep(c, step);
          for (const x of got.items) {
            const g = await findOf(x, step, run);
            if (g) addFind(run, g);
          }
          whole = got.whole;
          run.any = true;
        } catch (err) {
          if (ctl.signal.aborted) throw stopped();
          if (endsSearch(err)) throw err;
        }
        run.read.push({ name: step.name, ok: whole });
        run.model = c.model;
        commit(run);
      }
    } catch (err) {
      if (!(err instanceof GeminiError)) console.error(err);
      stop = ctl.signal.aborted ? stopped() : err instanceof GeminiError ? err : new GeminiError('reply', 'Something went wrong. Try again.');
    }
    searching = null;
    finish(run, stop);
  }

  function finish(run, stop) {
    if (stop && stop.kind === 'key') {
      forgetKey();
      paintStatus();
      openKey('Google didn\'t accept the key. Check that it\'s all there, or create a new one in Google AI Studio.');
      return;
    }
    if (stop && stop.kind === 'stopped') {
      paintStatus();
      toast('Stopped. What Gemini found so far is on the list.', 4000);
      return;
    }
    if (stop) problem = TROUBLE[stop.kind] || stop.message;
    else if (!run.any) problem = 'Gemini couldn\'t read any of the pages. Try again later.';
    paintStatus();
    if (problem) {
      toast(problem, 5000);
      return;
    }
    const n = new Set(run.finds.filter((g) => byId.has(g.id)).map((g) => g.series)).size;
    toast(n ? `Gemini found ${n} more event${n === 1 ? '' : 's'}` : 'Gemini didn\'t find anything that isn\'t on the list already', 4000);
  }

  // What the page shows of it

  function geminiTag() {
    const t = el('span', 'tag gemini');
    t.title = 'Found by Gemini';
    t.append(icon('sparkle'), document.createTextNode('Gemini'));
    return t;
  }

  function geminiNote(e) {
    const p = el('p', 'gemini-note');
    const at = Date.parse(e.found);
    const day = Number.isFinite(at) ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(at)) : null;
    const where = [e.via ? `at ${e.via}` : null, day ? `on ${day}` : null].filter(Boolean).join(' ');
    p.append(icon('sparkle'), el('span', null, `Gemini found this${where ? ` ${where}` : ''}. Gemini can make mistakes, so check the website before you go.`));
    return p;
  }

  /** How many happenings only Gemini found, on the list now. */
  const geminiCount = () => new Set(events.filter((e) => e.gemini && e.e >= today).map((e) => e.series)).size;

  let statusParts = null;

  function paintStatus() {
    const box = $('gemini-status');
    const go = $('gemini-search');
    const label = go.querySelector('span');
    if (searching) {
      go.disabled = true;
      go.classList.add('busy');
      label.textContent = go.dataset.busy;
      if (!statusParts) {
        const row = el('div', 'gs-row');
        const spinner = el('span', 'spinner');
        spinner.setAttribute('aria-hidden', 'true');
        const text = el('p', 'gs-text');
        row.append(spinner, text);
        const bar = el('progress', 'gs-bar');
        bar.setAttribute('aria-hidden', 'true');
        const actions = el('div', 'gs-actions');
        actions.append(button('button quiet small', 'Stop', null, () => {
          if (searching) searching.ctl.abort();
        }));
        box.replaceChildren(row, bar, actions);
        statusParts = { text, bar };
      }
      const s = searching;
      statusParts.text.textContent = s.n ? `Gemini is reading ${s.name} (${s.i} of ${s.n})…` : 'Checking your key…';
      if (s.n) {
        statusParts.bar.max = s.n;
        statusParts.bar.value = s.i - 1;
      } else {
        statusParts.bar.removeAttribute('value');
      }
      box.hidden = false;
      return;
    }
    statusParts = null;
    go.disabled = false;
    go.classList.remove('busy');
    label.textContent = go.dataset.idle;
    const unread = found.read.filter((r) => !r.ok).map((r) => r.name);
    if (!found.at && !problem && !unread.length) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const parts = [];
    if (found.at) {
      const n = geminiCount();
      const at = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(found.at));
      const head = el('p', 'gs-head');
      head.append(icon('sparkle'), el('span', null, `${n ? `Gemini found ${n} more event${n === 1 ? '' : 's'}` : 'Gemini found nothing that isn\'t on the list already'} · ${at}`));
      parts.push(head);
    }
    if (problem) parts.push(el('p', 'gs-problem', problem));
    if (unread.length) {
      const named = unread.length > 6 ? `${unread.slice(0, 5).join(', ')} and ${unread.length - 5} more` : unread.join(', ');
      parts.push(el('p', 'gs-fine', `Couldn't read: ${named}.`));
    }
    const actions = el('div', 'gs-actions');
    if (found.events.length) actions.append(button('button quiet small', 'Clear', null, clearFound));
    if (savedKey()) actions.append(button('button quiet small', 'Change key', null, () => openKey()));
    if (actions.childElementCount) parts.push(actions);
    box.replaceChildren(...parts);
    box.hidden = false;
  }

  // The key's dialog

  let checking = false;

  function keyError(text) {
    const p = $('key-error');
    p.textContent = text || '';
    p.hidden = !text;
  }

  function openKey(error) {
    const input = $('key-input');
    input.value = '';
    keyError(error);
    const has = !!savedKey();
    $('key-forget').hidden = !has;
    $('key-remember').checked = has ? keyRemembered() : true;
    const d = $('gemini-key');
    if (!d.open) d.showModal();
    input.focus();
  }

  async function submitKey(ev) {
    ev.preventDefault();
    if (checking) return;
    const key = $('key-input').value.replace(/\s+/g, '');
    if (!key) {
      keyError('Paste your Gemini key first.');
      return;
    }
    if (!/^[\w-]{20,}$/.test(key)) {
      keyError('That doesn\'t look like a Gemini key. Copy the whole key from Google AI Studio and paste it here.');
      return;
    }
    checking = true;
    const submit = $('key-save');
    const label = submit.querySelector('span');
    submit.disabled = true;
    label.textContent = submit.dataset.busy;
    keyError(null);
    try {
      const list = await listModels(key);
      models = { key, list };
      keepKey(key, $('key-remember').checked);
      $('gemini-key').close();
      search();
    } catch (err) {
      if (!(err instanceof GeminiError)) console.error(err);
      keyError(err instanceof GeminiError && err.kind === 'key'
        ? 'Google didn\'t accept that key. Check that you copied all of it, or create a new one in Google AI Studio.'
        : (err instanceof GeminiError && (TROUBLE[err.kind] || err.message)) || 'Something went wrong. Try again.');
    } finally {
      checking = false;
      submit.disabled = false;
      label.textContent = submit.dataset.idle;
    }
  }

  // Page

  let toastTimer = 0;
  function toast(text, ms = 2500) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, ms);
  }

  function setWeekend(on) {
    view.weekend = on;
    $('weekend').setAttribute('aria-pressed', String(on));
  }

  function setMode(mode) {
    view.mode = mode;
    for (const tab of document.querySelectorAll('[role="tab"]')) tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
    render();
    const intro = document.querySelector('.intro');
    const y = intro.offsetTop + intro.offsetHeight;
    if (window.scrollY > y) window.scrollTo(0, y);
  }

  function footer() {
    const zone = feed.zone;
    const at = new Date(feed.generatedAt);
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const named = feed.sources.length;
    $('updated').textContent = `Updated ${fmt.format(at)} ${feed.area} time, from ${named} calendar${named === 1 ? '' : 's'}. Checked again every day.`;
    $('sources').textContent = feed.sources.map((s) => s.name).join(', ');
    const hours = (Date.now() - at.getTime()) / 3600000;
    const notice = $('notice');
    if (hours > STALE_HOURS) {
      const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }).format(at);
      notice.textContent = `This list was last updated on ${day}, so some details may have changed. Check an event's website before you go.`;
      notice.hidden = false;
    } else {
      notice.hidden = true;
    }
  }

  function prepare(data) {
    feed = data;
    store = `happenings:${String(data.app || 'happenings').toLowerCase().replace(/[^a-z0-9]+/g, '-')}:v1`;
    today = todayIn(data.zone);
    loadedAt = Date.now();
    learnPlaces(data.gemini || {});
    if (!searching) found = loadFound();
    index();
    $('gemini-search').hidden = !data.gemini;
  }

  function derive(e) {
    e.s = epochDay(e.start);
    e.e = epochDay(e.end);
    e.sources = Array.isArray(e.sources) ? e.sources : [];
    const short = categoryOf(e.category).short || '';
    e.text = normalize([e.title, e.placeLines || e.place, e.summary, short].filter(Boolean).join(' '));
    byId.set(e.id, e);
    if (!bySeries.has(e.series)) bySeries.set(e.series, []);
    bySeries.get(e.series).push(e);
  }

  /** The list: the feed's dates, and what Gemini found that the feed doesn't have. */
  function index() {
    events = (Array.isArray(feed.events) ? feed.events : []).slice();
    byId.clear();
    bySeries.clear();
    for (const e of events) derive(e);
    mergeFound();
    for (const dates of bySeries.values()) {
      dates.sort((a, b) => a.s - b.s || minute(a) - minute(b));
      // What only Gemini found is never "new": it's marked Gemini instead.
      const listed = dates.filter((d) => !d.gemini);
      const seen = listed.length ? Math.min(...listed.map((d) => Date.parse(d.firstSeen) || 0)) : 0;
      for (const d of dates) d.seriesSeen = seen;
    }
  }

  /**
   * Adds what Gemini found, but not what the feed lists already: a calendar's
   * listing has more to it. A starred find that the feed lists now passes its
   * star to the listing.
   */
  function mergeFound() {
    if (!found.events.length) return;
    const listed = events.slice();
    const saved = load('stars', {});
    let moved = false;
    for (const g of found.events) {
      if (epochDay(g.end) < today) continue;
      const twin = listed.find((e) => sameHappening(g, e));
      if (twin) {
        if (owns(saved, g.id)) {
          if (!owns(saved, twin.id)) saved[twin.id] = starOf(twin);
          delete saved[g.id];
          moved = true;
        }
        continue;
      }
      const d = { ...g, sources: Array.isArray(g.sources) ? g.sources.slice() : [] };
      events.push(d);
      derive(d);
    }
    if (moved) save('stars', saved);
  }

  function hashId() {
    const m = /^#e=([\w-]+)$/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function openFromHash() {
    const id = hashId();
    const details = $('details');
    if (!id) {
      if (details.open) details.close();
      return;
    }
    const e = byId.get(id);
    if (e && e.e >= today) {
      openDetails(e, false);
      return;
    }
    // A link to a date that's passed or gone: said once, and the address goes back to the list's,
    // so closing details later and Back don't come back to it.
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (details.open) details.close();
    toast('That event has passed or isn\'t listed anymore.', 4000);
  }

  async function fetchFeed(fresh = false) {
    // A refresh asks past every cache, GitHub's included, for the list the workflow wrote last.
    const r = await fetch(fresh ? `data/events.json?r=${Date.now()}` : 'data/events.json', { cache: fresh ? 'no-store' : 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function show() {
    loadFilters();
    loadStars();
    footer();
    render();
    paintStatus();
  }

  async function start() {
    const list = $('list');
    try {
      prepare(await fetchFeed());
    } catch {
      list.setAttribute('aria-busy', 'false');
      const box = el('div', 'empty');
      box.append(el('p', null, 'The events couldn\'t be loaded. Check your connection and try again.'));
      box.append(button('button', 'Try again', null, () => location.reload()));
      list.replaceChildren(box);
      return;
    }
    show();
    openFromHash();
  }

  /** Spins until the newest list is in, and long enough to be seen to. */
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const b = $('refresh');
    const label = b.querySelector('span');
    b.disabled = true;
    b.classList.add('spinning');
    label.textContent = b.dataset.busy;
    $('list').setAttribute('aria-busy', 'true');
    const began = Date.now();
    const before = feed ? new Set(feed.events.map((e) => e.id)) : null;
    const was = feed ? feed.generatedAt : null;
    try {
      const data = await fetchFeed(true);
      await sleep(700 - (Date.now() - began));
      prepare(data);
      show();
      if (!before) {
        openFromHash();
      } else if (data.generatedAt === was) {
        const at = new Intl.DateTimeFormat('en-US', { timeZone: data.zone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(data.generatedAt));
        toast(`The list is up to date. It was updated ${at}.`, 3500);
      } else {
        const added = new Set(feed.events.filter((e) => !before.has(e.id) && epochDay(e.end) >= today).map((e) => e.series)).size;
        toast(added ? `Updated: ${added} new event${added === 1 ? '' : 's'}` : 'Updated: nothing new since the last list', 3500);
      }
    } catch {
      $('list').setAttribute('aria-busy', 'false');
      toast('Couldn\'t refresh the list. Check your connection and try again.', 4000);
    } finally {
      refreshing = false;
      b.disabled = false;
      b.classList.remove('spinning');
      label.textContent = b.dataset.idle;
    }
  }

  function wire() {
    for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener('click', () => setMode(tab.dataset.mode));

    let typing = 0;
    $('q').addEventListener('input', () => {
      clearTimeout(typing);
      typing = setTimeout(() => {
        words = normalize($('q').value).trim().split(' ').filter(Boolean);
        if (feed) render();
      }, 120);
    });
    $('weekend').addEventListener('click', () => {
      setWeekend(!view.weekend);
      if (feed) render();
    });
    $('open-filters').addEventListener('click', () => {
      if (!feed) return;
      paintFilters();
      $('filters').showModal();
    });
    $('f-paid').addEventListener('change', (ev) => {
      filters.hidePaid = ev.target.checked;
      filtersChanged();
    });
    $('f-kids').addEventListener('change', (ev) => {
      filters.hideKids = ev.target.checked;
      filtersChanged();
    });
    $('f-politics').addEventListener('change', (ev) => {
      filters.hidePolitics = ev.target.checked;
      filtersChanged();
    });
    $('f-reset').addEventListener('click', () => {
      filters = defaultFilters();
      paintFilters();
      filtersChanged();
    });

    $('refresh').addEventListener('click', () => refresh());
    $('gemini-search').addEventListener('click', () => {
      if (!feed || !feed.gemini || searching) return;
      if (savedKey()) search();
      else openKey();
    });
    $('key-form').addEventListener('submit', submitKey);
    $('key-forget').addEventListener('click', () => {
      forgetKey();
      $('gemini-key').close();
      paintStatus();
      toast('The key is forgotten. What Gemini found stays on the list.', 3500);
    });

    for (const d of document.querySelectorAll('dialog')) {
      // A click on the dim backdrop, outside the sheet, closes it; one on its scrollbar doesn't.
      d.addEventListener('click', (ev) => {
        if (ev.target !== d) return;
        const r = d.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) d.close();
      });
      for (const b of d.querySelectorAll('[data-close]')) b.addEventListener('click', () => d.close());
    }
    $('details').addEventListener('close', () => {
      current = null;
      if (!hashId()) return;
      if (history.state && history.state.e) history.back();
      else history.replaceState(null, '', `${location.pathname}${location.search}`);
    });
    window.addEventListener('popstate', () => {
      if (feed) openFromHash();
    });

    const controls = $('controls');
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        controls.classList.toggle('stuck', controls.getBoundingClientRect().top <= 0 && window.scrollY > 0);
        ticking = false;
      });
    }, { passive: true });

    // A page left open overnight moves on to the new day, and to the new list.
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !feed) return;
      if (Date.now() - loadedAt > 30 * 60000) {
        try {
          prepare(await fetchFeed());
          loadStars();
          footer();
        } catch {
          return;
        }
      } else if (todayIn(feed.zone) === today) {
        return;
      }
      today = todayIn(feed.zone);
      if (current && !$('details').open) current = null;
      render();
      paintStatus();
    });
  }

  wire();
  start();
})();
