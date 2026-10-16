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

  // Saved choices

  function load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(`${store}:${key}`));
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(`${store}:${key}`, JSON.stringify(value));
    } catch {
      // Private browsing or storage turned off: the choice lasts until the page closes.
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
    const c = el('article', 'card');
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
    const found = groups(today);
    const frag = document.createDocumentFragment();
    for (const g of found) {
      const section = el('section');
      section.append(el('h2', 'section-title', SECTIONS[g.section]));
      const cards = el('div', 'cards');
      for (const row of g.rows) cards.append(card(row, today));
      section.append(cards);
      frag.append(section);
    }
    if (!found.length) frag.append(emptyState());
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
    const url = pageUrl(e);
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

    body.append(el('p', 'listed', `Listed by ${e.sources && e.sources.length ? e.sources.join(', ') : 'a calendar'}${e.keptSince ? '. Its calendar couldn\'t be read lately, so check the website.' : ''}`));
    const email = document.body.dataset.email;
    if (email) {
      const subject = `${feed.app} listing: ${e.title} (${e.dates})`;
      const mail = link(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`About ${pageUrl(e)}\n\nWhat's wrong:\n`)}`, 'report', 'Report a problem with this listing', 'flag', false);
      body.append(mail);
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

  function openAdd(e) {
    const file = `ics/${encodeURIComponent(e.id)}.ics`;
    // An iPhone offers to add an event only from a real file on the web, opened in place.
    const apple = option('apple', 'Apple Calendar', 'iPhone, iPad and Mac', file, { newTab: false });
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
    events = Array.isArray(data.events) ? data.events : [];
    byId.clear();
    bySeries.clear();
    for (const e of events) {
      e.s = epochDay(e.start);
      e.e = epochDay(e.end);
      e.sources = Array.isArray(e.sources) ? e.sources : [];
      const short = categoryOf(e.category).short || '';
      e.text = normalize([e.title, e.placeLines || e.place, e.summary, short].filter(Boolean).join(' '));
      byId.set(e.id, e);
      if (!bySeries.has(e.series)) bySeries.set(e.series, []);
      bySeries.get(e.series).push(e);
    }
    for (const dates of bySeries.values()) {
      dates.sort((a, b) => a.s - b.s || minute(a) - minute(b));
      const seen = Math.min(...dates.map((d) => Date.parse(d.firstSeen) || 0));
      for (const d of dates) d.seriesSeen = seen;
    }
    store = `happenings:${String(data.app || 'happenings').toLowerCase().replace(/[^a-z0-9]+/g, '-')}:v1`;
    today = todayIn(data.zone);
    loadedAt = Date.now();
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

  async function fetchFeed() {
    const r = await fetch('data/events.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
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
    loadFilters();
    loadStars();
    footer();
    render();
    openFromHash();
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
    });
  }

  wire();
  start();
})();
