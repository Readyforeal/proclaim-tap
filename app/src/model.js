// The companion's state machine: monitors Proclaim, publishes live state, syncs the cloud library.
// No Electron imports, so the checks drive this exact code under plain Node.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProclaimClient, ServerClient, cloudLink, itemById, liveUpdate, newProfile, parseLibrary, parsePresentation, profileLink,
  publishUpdate, resolve, samePresentation, sectionAt, setProfileLink, tapKey, validURL } from './core.js';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const within = (time, seconds) => time != null && Date.now() - time < seconds * 1000;
const DEMO_ITEMS = [['connect', 'Connect'], ['parents', 'Parent’s Night Out'], ['football', 'Flag Football'], ['countdown', 'Countdown'],
  ['welcome', 'Welcome'], ['pioneers', 'Pioneers Conference'], ['giving', 'Giving'], ['sermon', 'Sunday message']];
const DEMO = parsePresentation({ id: 'demo-presentation', localRevision: 1, title: 'Sunday at Revival · Demo',
  warmupStartIndex: 3, serviceStartIndex: 4, postServiceStartIndex: 8,
  serviceItems: DEMO_ITEMS.map(([id, title]) => ({ id: `demo-${id}`, title, kind: 'Content', slides: [{ index: 0 }] })) });

/** Old installations keep local mode until cloud sync is explicitly enabled. */
export const parseSettings = raw => ({ url: String(raw.url), enabled: raw.enabled === true,
  cloudEnabled: raw.cloudEnabled ?? false, monitorLocal: raw.monitorLocal ?? true });

export class AppModel {
  connection = 'Paused'; // Paused | Connecting | Disconnected | Off air | On air | Demo
  detail = 'Open Proclaim on this Mac to get started.';
  presentation = null; currentStatus = null; lastChecked = null; selectedItemID = null;
  profile = newProfile(); forceFallback = false; storageError = null; syncRequested = false;
  serverSettings = { url: 'https://tap.revivalomaha.org', enabled: false, cloudEnabled: true, monitorLocal: true };
  serverMessage = 'Server publishing is off.'; serverError = null;
  cloudLibrary = null; cloudError = null; cloudEditError = null; cloudMessage = 'Connect to the server to sync links.';
  cloudSaving = false; cloudChecked = null;
  lastPublished = null; serverFallbackURL = null; serverConfirmedURL = null;
  isMonitoring = false;
  #publisherID = randomUUID(); #publishSequence = 0; #publishToken = ''; #lastSentKey = null;
  #generation = {}; #publishGeneration = {}; #publishing = false; #cloudSyncing = false; #sessionId = null;

  constructor({ dir, allowPublishing = true, serverClient = new ServerClient(), proclaim = new ProclaimClient(),
    loadToken = () => '', saveToken = () => {} }) {
    Object.assign(this, { dir, allowPublishing, serverClient, proclaim, loadToken, saveToken });
    const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (fs.existsSync(path.join(dir, 'links.json'))) {
      try { const saved = read('links.json'); this.profile = { fallbackURL: saved.fallbackURL ?? '', links: saved.links ?? {} }; }
      catch (error) { this.storageError = `Could not load saved links: ${error.message}`; }
    }
    if (!allowPublishing) return;
    try {
      this.serverSettings = parseSettings(read('server.json'));
      if (this.serverSettings.enabled || this.serverSettings.cloudEnabled) {
        try { this.#publishToken = loadToken(); } catch (error) { this.serverError = error.message; }
      }
    } catch { /* no saved settings yet */ }
    if (!this.serverSettings.cloudEnabled) return;
    try {
      const cached = read('cloud-cache.json');
      if (cached.serverURL !== this.serverSettings.url) return;
      this.cloudLibrary = parseLibrary(cached.library);
      if (!this.serverSettings.monitorLocal) {
        this.presentation = this.cloudLibrary.presentations[0] ?? null;
        this.selectedItemID = this.presentation?.serviceItems[0]?.id ?? null;
      }
    } catch { /* no usable cache */ }
  }

  #write(name, value, pretty) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, pretty ? 2 : 0));
    fs.renameSync(`${file}.tmp`, file); // atomic replace
  }

  get isDemo() { return this.connection === 'Demo'; }
  // Main-process use only; never included in view() or sent to the renderer.
  updateConnection() { return { url: this.serverSettings.url, token: this.#publishToken }; }
  get usesCloud() { return this.allowPublishing && this.serverSettings.cloudEnabled && !this.isDemo; }
  get isRemoteEditor() { return !this.serverSettings.monitorLocal; }
  get isLocalEditor() { return this.serverSettings.monitorLocal && !this.serverSettings.enabled; }
  get cloudFresh() { return within(this.cloudChecked, 10) && this.cloudError == null; }
  get publishingHealthy() { return this.serverSettings.enabled && this.serverError == null && within(this.lastPublished, 10); }
  get currentItem() {
    const source = this.isRemoteEditor
      ? this.cloudLibrary?.presentations.find(p => p.id === this.currentStatus?.presentationId) : this.presentation;
    return itemById(source, this.currentStatus?.status.itemId);
  }
  get selectedItem() { return itemById(this.presentation, this.selectedItemID); }
  get destinationDisplayURL() {
    const destination = this.destination;
    return this.serverSettings.enabled && destination.isFallback && this.serverFallbackURL ? this.serverFallbackURL : destination.url;
  }
  get destination() {
    const { presentation, currentStatus: status, forceFallback } = this;
    if (!this.usesCloud) {
      return resolve({ profile: this.profile, presentation, status, live: this.connection === 'On air' || this.isDemo, forceFallback });
    }
    if (this.isRemoteEditor) {
      const live = this.cloudFresh ? this.cloudLibrary?.live : null;
      if (!live) return { url: null, isFallback: true, reason: 'Waiting for server confirmation' };
      const isFallback = live.mode === 'fallback';
      return { url: live.destination, isFallback, reason: isFallback ? 'Server is using Church Center' : 'Server’s live destination' };
    }
    const shared = { fallbackURL: this.serverFallbackURL ?? this.profile.fallbackURL, links: {} };
    for (const item of presentation?.serviceItems ?? []) setProfileLink(shared, cloudLink(this.cloudLibrary, item), presentation.id, item.id);
    return resolve({ profile: shared, presentation, status, live: this.connection === 'On air', forceFallback });
  }

  link(itemId) {
    if (!this.presentation) return '';
    const item = itemById(this.presentation, itemId);
    if (this.usesCloud && item) return cloudLink(this.cloudLibrary, item);
    return profileLink(this.profile, this.presentation.id, itemId);
  }

  setLink(link, itemId, expectedURL = null) {
    if (!this.presentation) return;
    if (!this.usesCloud) {
      setProfileLink(this.profile, link, this.presentation.id, itemId);
      return this.#saveProfile();
    }
    const item = itemById(this.presentation, itemId), key = item && tapKey(item.title);
    if (!key) { this.cloudEditError = 'Add one marker such as [tap:giving] to this item’s Proclaim title first.'; return; }
    if (expectedURL != null && expectedURL !== cloudLink(this.cloudLibrary, item)) {
      this.cloudEditError = 'This link changed while you were editing. Reload the saved link and review your change.'; return;
    }
    const rule = { key, title: item.title, url: link.trim() };
    this.#editCloud(rule.url ? 'saveLink' : 'deleteLink', { rule });
  }

  setFallback(link) { this.profile.fallbackURL = link.trim(); this.#saveProfile(); }

  /** Local mappings as pretty JSON with stable key order, for links.json and export. */
  profileJSON() {
    const links = Object.fromEntries(Object.entries(this.profile.links).sort(([a], [b]) => (a < b ? -1 : 1)));
    return { fallbackURL: this.profile.fallbackURL, links };
  }
  #saveProfile() {
    try { this.#write('links.json', this.profileJSON(), true); this.storageError = null; }
    catch (error) { this.storageError = `Could not save links: ${error.message}`; }
  }

  configureServer({ url, token = '', enabled, cloudEnabled = false, monitorLocal = true }) {
    if (!this.allowPublishing) return;
    const trimmed = url.trim(), parsed = validURL(trimmed) && new URL(trimmed);
    if (!parsed || parsed.pathname !== '/' || parsed.search || parsed.hash || /[?#]/.test(trimmed)) {
      this.serverError = 'Enter the HTTPS server address without a path, query, or fragment.'; return;
    }
    if (!monitorLocal && !cloudEnabled) { this.serverError = 'Remote editing requires cloud sync.'; return; }
    try {
      const replacement = token.trim();
      const chosen = replacement || this.#publishToken || this.loadToken();
      if ((enabled || cloudEnabled) && chosen.length < 32) {
        this.serverError = 'Enter the server’s device token (at least 32 characters).'; return;
      }
      if (replacement) this.saveToken(replacement);
      const settings = { url: trimmed, enabled: enabled && monitorLocal, cloudEnabled, monitorLocal };
      this.#write('server.json', settings);
      // Clear the previous server best-effort; its TTL remains the final safety net.
      if (this.serverSettings.enabled && this.serverSettings.monitorLocal && this.#publishToken) {
        this.serverClient.publish(this.serverSettings.url, this.#publishToken,
          publishUpdate(this.#publisherID, ++this.#publishSequence, null)).catch(() => {});
      }
      Object.assign(this, { cloudLibrary: null, presentation: null, selectedItemID: null, cloudChecked: null, cloudError: null,
        cloudEditError: null, cloudSaving: false, serverSettings: settings, lastPublished: null, serverFallbackURL: null,
        serverConfirmedURL: null, serverError: null,
        serverMessage: enabled ? 'Connecting to the redirect server…' : 'Publishing off. Any previous live link expires within the server timeout.' });
      this.#publishGeneration = {}; this.#publishing = false; this.#cloudSyncing = false;
      this.#publishToken = chosen; this.#lastSentKey = null;
      this.start();
    } catch (error) { this.serverError = error.message; }
  }

  // Each loop captures a generation token; replacing the token retires the loop, and every await re-checks it
  // so a request that was already in flight can never restore stale state.
  async #loop(alive, step, ms) {
    while (alive()) { await step(); await sleep(ms); }
  }

  #startPublishing() {
    if (!this.allowPublishing || !this.serverSettings.enabled || !this.serverSettings.monitorLocal || this.#publishing) return;
    this.#publishing = true;
    const run = this.#publishGeneration;
    this.#loop(() => this.#publishGeneration === run, () => this.#publishIfNeeded(run), 1000);
  }

  async #publishIfNeeded(run) {
    const base = validURL(this.serverSettings.url);
    if (!base || !this.#publishToken) { this.serverError = 'Add the server URL and device token in Settings.'; return; }
    // Never publish simulated or stale slides, even if a Proclaim request stalls.
    const fresh = this.connection === 'On air' && within(this.lastChecked, 6);
    const destination = this.destination, usesCloud = this.usesCloud, forceFallback = this.forceFallback;
    const active = fresh && !destination.isFallback ? destination.url : null;
    const status = fresh ? this.currentStatus : null;
    const key = usesCloud
      ? [status?.presentationId ?? 'off', status?.presentationLocalRevision ?? 0, status?.status.itemId ?? '',
        status?.status.slideIndex ?? 0, status?.status.quickScreenKind ?? '', forceFallback].join('/')
      : active ?? 'fallback';
    if (this.#lastSentKey === key && within(this.lastPublished, 5)) return;
    const sequence = ++this.#publishSequence;
    try {
      const ack = await this.serverClient.publish(base, this.#publishToken, usesCloud
        ? liveUpdate(this.#publisherID, sequence, status, forceFallback) : publishUpdate(this.#publisherID, sequence, active));
      if (run !== this.#publishGeneration) return;
      this.#lastSentKey = key; this.lastPublished = Date.now(); this.serverError = null;
      this.serverFallbackURL = ack.fallbackURL; this.serverConfirmedURL = ack.destination;
      this.serverMessage = `Server confirmed ${ack.mode === 'announcement' ? 'announcement link' : 'Church Center'} · timeout ${ack.ttlSeconds}s`;
    } catch (error) {
      if (run !== this.#publishGeneration) return;
      this.#lastSentKey = null; this.serverError = error.message;
      this.serverMessage = 'Update not confirmed. Server falls back when its heartbeat expires.';
    }
  }

  start() {
    this.stop();
    this.#startCloudSync();
    this.#startPublishing();
    if (!this.serverSettings.monitorLocal) { this.detail = 'Remote editor · the presentation Mac reports the live screen.'; return; }
    this.connection = 'Connecting';
    this.detail = 'Looking for Proclaim on this Mac…';
    this.isMonitoring = true;
    const run = this.#generation;
    this.#loop(() => this.#generation === run, () => this.#poll(run), 1000);
  }

  stop() {
    this.isMonitoring = false;
    this.#generation = {}; this.#sessionId = null;
    this.currentStatus = null; this.lastChecked = null; this.syncRequested = false;
    this.connection = 'Paused';
    this.detail = 'Monitoring paused. The destination uses Church Center.';
    // Demo items never appear as a cached real presentation.
    if (this.presentation?.id === DEMO.id) { this.presentation = null; this.selectedItemID = null; }
  }

  /** Stops every background loop, including cloud sync and publishing. */
  shutdown() { this.stop(); this.#publishGeneration = {}; this.#publishing = false; this.#cloudSyncing = false; }

  sync() { this.syncRequested = true; }

  async #poll(run) {
    const stale = () => this.#generation !== run;
    try {
      const session = await this.proclaim.onAirSession();
      if (stale()) return;
      if (!session) {
        Object.assign(this, { connection: 'Off air', detail: 'Proclaim is connected and off air.', currentStatus: null,
          lastChecked: Date.now(), syncRequested: false });
        this.#sessionId = null;
        return;
      }
      const sessionChanged = session !== this.#sessionId;
      if (sessionChanged) {
        this.currentStatus = null; this.connection = 'Connecting'; this.detail = 'Syncing the on-air presentation…';
      }
      if (sessionChanged || !this.presentation || this.syncRequested) {
        const fresh = await this.proclaim.presentation(session);
        if (stale()) return;
        this.#apply(fresh);
        this.#sessionId = session; this.syncRequested = false;
      }
      let snapshot = this.presentation;
      const status = await this.proclaim.status(session, snapshot.localRevision);
      if (stale()) return;
      const matches = () => status.presentationId === snapshot.id && status.presentationLocalRevision === snapshot.localRevision;
      if (!matches() || (!itemById(snapshot, status.status.itemId) && status.status.quickScreenKind === 'None')) {
        this.currentStatus = null;
        snapshot = await this.proclaim.presentation(session);
        if (stale()) return;
        this.#apply(snapshot);
      }
      if (!matches()) throw new Error('Presentation changed; waiting for matching slide data.');
      Object.assign(this, { currentStatus: status, connection: 'On air', detail: 'Following Proclaim · checks about once a second',
        lastChecked: Date.now() });
    } catch (error) {
      if (stale()) return;
      this.currentStatus = null; this.#sessionId = null;
      this.connection = 'Disconnected';
      this.detail = `${error.message} Retrying automatically.`;
    }
  }

  #apply(fresh) {
    const changed = fresh.id !== this.presentation?.id;
    this.presentation = fresh;
    if (changed || !itemById(fresh, this.selectedItemID)) {
      this.selectedItemID = fresh.serviceItems.find(item => item.slides.length)?.id ?? null;
    }
  }

  select(itemId) { if (itemById(this.presentation, itemId)) this.selectedItemID = itemId; }

  showDemo() {
    this.stop();
    this.#apply(DEMO);
    this.connection = 'Demo';
    this.detail = 'Sample presentation. No connection to Proclaim or your server.';
    this.showDemoItem('demo-connect');
  }

  showDemoItem(itemId) {
    if (!this.isDemo) return;
    this.currentStatus = { presentationId: DEMO.id, presentationLocalRevision: 1,
      status: { revision: 1, itemId, slideIndex: 0, quickScreenKind: 'None' } };
    this.lastChecked = Date.now();
  }

  #startCloudSync() {
    if (!this.allowPublishing || !this.serverSettings.cloudEnabled || !this.#publishToken || this.#cloudSyncing) return;
    this.#cloudSyncing = true;
    const run = this.#publishGeneration;
    this.#loop(() => this.#publishGeneration === run, () => this.#refreshCloud(run), 3000);
  }

  #acceptCloud(library) {
    if (library.revision < (this.cloudLibrary?.revision ?? -1)) return;
    if (library.revision !== this.cloudLibrary?.revision) {
      try { this.#write('cloud-cache.json', { serverURL: this.serverSettings.url, library }); }
      catch (error) { this.storageError = `Links are on the server, but the offline cache could not be saved: ${error.message}`; }
    }
    this.cloudLibrary = library;
    this.cloudChecked = Date.now();
    this.serverFallbackURL = library.live.fallbackURL;
    if (!this.isRemoteEditor) return;
    const live = library.live;
    this.currentStatus = live.connected ? live.presentationStatus : null;
    this.serverConfirmedURL = live.destination;
    this.serverMessage = live.connected ? 'Presentation Mac connected · server destination confirmed' : 'No fresh booth heartbeat · Church Center fallback';
    this.connection = this.currentStatus ? 'On air' : 'Off air';
    this.detail = 'Remote editor · changes are saved to the server.';
    const chosen = library.presentations.find(p => p.id === this.presentation?.id)
      ?? library.presentations.find(p => p.id === live.presentationStatus?.presentationId) ?? library.presentations[0];
    if (chosen) this.#apply(chosen);
  }

  async #refreshCloud(run) {
    const base = validURL(this.serverSettings.url), stale = () => run !== this.#publishGeneration;
    if (!base) return;
    try {
      const library = await this.serverClient.library(base, this.#publishToken);
      if (stale()) return;
      if (library.revision < (this.cloudLibrary?.revision ?? -1)) {
        throw new Error('The server library is older than this Mac’s cached copy. Save the server settings again to reconnect after a database restore.');
      }
      this.#acceptCloud(library);
      this.cloudError = null;
      if (!this.cloudSaving && this.cloudEditError == null) this.cloudMessage = 'Links synced with server';
      // Only the booth uploads real snapshots. Browsing on a laptop never uploads its selection.
      const presentation = this.presentation;
      if (!this.serverSettings.enabled || this.isRemoteEditor || this.isDemo || !presentation || this.cloudSaving
        || samePresentation(library.presentations.find(p => p.id === presentation.id), presentation)) return;
      this.cloudSaving = true;
      try {
        const updated = await this.serverClient.updateLibrary(base, this.#publishToken,
          { baseRevision: library.revision, operation: 'savePresentation', presentation });
        if (!stale()) this.#acceptCloud(updated);
      } finally { if (!stale()) this.cloudSaving = false; }
    } catch (error) {
      if (stale()) return;
      this.cloudError = error.message;
      this.cloudMessage = 'Cloud sync unavailable · saved links are still on the server';
      if (this.isRemoteEditor) {
        Object.assign(this, { connection: 'Disconnected', currentStatus: null, detail: 'Server connection lost. Displayed presentation is cached.' });
      }
    }
  }

  chooseCloudPresentation(id) {
    const chosen = this.isRemoteEditor && this.cloudLibrary?.presentations.find(p => p.id === id);
    if (chosen) this.#apply(chosen);
  }

  async #editCloud(operation, change) {
    if (this.cloudSaving) { this.cloudEditError = 'A sync is in progress. Try saving again in a moment.'; return; }
    const library = this.cloudLibrary, base = validURL(this.serverSettings.url);
    if (!library || !this.cloudFresh || !base) {
      this.cloudEditError = 'Connect to the server before saving. Your unsaved text stays in this editor.'; return;
    }
    this.cloudSaving = true;
    this.cloudMessage = 'Saving to server…';
    const run = this.#publishGeneration, stale = () => run !== this.#publishGeneration;
    try {
      const updated = await this.serverClient.updateLibrary(base, this.#publishToken, { baseRevision: library.revision, operation, ...change });
      if (stale()) return;
      this.#acceptCloud(updated);
      this.cloudEditError = null;
      this.cloudMessage = 'Saved to server · available on every connected Mac';
    } catch (error) {
      if (stale()) return;
      // Never retry an edit automatically against a newer revision.
      this.cloudEditError = error.message;
      this.cloudMessage = 'Not saved · review your change and try again';
    } finally { if (!stale()) this.cloudSaving = false; }
  }

  importCurrentLocalLinks() {
    const presentation = this.presentation;
    if (!presentation || this.isDemo) return;
    const rules = presentation.serviceItems.flatMap(item => {
      const url = profileLink(this.profile, presentation.id, item.id), key = tapKey(item.title);
      return key && validURL(url) ? [{ key, title: item.title, url }] : [];
    });
    if (!rules.length) {
      this.cloudEditError = 'No local links with markers found in this presentation. Add markers to the existing Proclaim items, sync, then import again.'; return;
    }
    this.#editCloud('importLinks', { rules });
  }

  /** Everything the window needs to draw, as plain JSON. */
  view() {
    const { presentation, currentStatus: status, serverSettings: settings, isRemoteEditor, usesCloud, isDemo } = this;
    const destination = this.destination, current = this.currentItem, selected = this.selectedItem;
    const quick = status && status.status.quickScreenKind !== 'None' ? status.status.quickScreenKind : null;
    const items = (presentation?.serviceItems ?? []).map((item, index) => {
      const link = this.link(item.id), marker = tapKey(item.title);
      return { id: item.id, title: item.title, section: sectionAt(presentation, index), slides: item.slides.length, link, marker,
        linked: validURL(link) != null,
        warning: usesCloud && item.title.toLowerCase().includes('[tap:') && !link ? (marker ? 'Tap link needed' : 'Check tap marker') : null };
    });
    const idle = { 'Off air': 'Ready for the next service', Paused: 'Monitoring paused', 'On air': 'Unknown presentation item' };
    return {
      connection: this.connection, detail: this.detail, isDemo, isRemoteEditor, isLocalEditor: this.isLocalEditor, usesCloud, isMonitoring: this.isMonitoring,
      syncRequested: this.syncRequested, forceFallback: this.forceFallback, lastChecked: this.lastChecked,
      presentation: presentation && { id: presentation.id, title: presentation.title },
      presentations: isRemoteEditor ? (this.cloudLibrary?.presentations ?? []).map(p => ({ id: p.id, title: p.title })) : [],
      items: items.filter(item => item.slides > 0), linkedCount: items.filter(item => item.linked).length,
      cached: this.connection !== 'On air' && !isDemo && presentation != null,
      selectedItemID: selected?.id ?? null, currentItemID: current?.id ?? null,
      live: {
        title: quick ? `Quick screen: ${quick}` : current?.title ?? idle[this.connection] ?? 'Waiting for a live slide',
        slide: status ? status.status.slideIndex + 1 : null,
        context: !current ? '' : isRemoteEditor
          ? this.cloudLibrary?.presentations.find(p => p.id === status?.presentationId)?.title ?? ''
          : items.find(item => item.id === current.id)?.section ?? '',
      },
      destination: { isFallback: destination.isFallback, reason: destination.reason, url: this.destinationDisplayURL,
        badge: isRemoteEditor ? (this.cloudFresh ? 'Server status' : 'Not confirmed')
          : this.publishingHealthy ? 'Publishing' : settings.enabled ? 'Not confirmed' : 'Local only',
        healthy: isRemoteEditor ? this.cloudFresh : this.publishingHealthy,
        confirmedURL: settings.enabled || isRemoteEditor ? this.serverConfirmedURL : null },
      serverMessage: this.serverMessage, serverError: this.serverError, storageError: this.storageError,
      cloud: { message: this.cloudMessage, error: this.cloudEditError ?? this.cloudError, saving: this.cloudSaving, fresh: this.cloudFresh },
      settings, fallbackURL: this.profile.fallbackURL,
    };
  }
}
