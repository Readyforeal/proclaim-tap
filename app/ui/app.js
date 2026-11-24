// Renderer: draws the state the main process sends and forwards user actions back. Holds no app logic.
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
// Replace a region only when its markup actually changed, so hover, scroll and selection survive the 4×/s updates.
const painted = new WeakMap();
const paint = (el, markup) => { if (painted.get(el) !== markup) { painted.set(el, markup); el.innerHTML = markup; } };
const okLink = raw => {
  const value = raw.trim();
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !/\s/.test(value); } catch { return false; }
};
// "Giving [tap:giving]" → "Giving" plus a marker chip. Titles with a broken marker are shown untouched.
const titleMarkup = item => (item.marker
  ? `${esc(item.title.replace(/\s*\[tap:[^\]]*\]\s*/i, ' ').trim() || item.title)} <span class="chip">tap:${esc(item.marker)}</span>`
  : esc(item.title));
const notes = lines => lines.filter(([text]) => text).map(([text, error]) => `<p class="${error ? 'error selectable' : ''}">${esc(text)}</p>`).join('');

let state = null, editorKey = null, baseline = '';
const call = async (name, ...args) => render(await window.tap.call(name, ...args));

function render(next) {
  state = next;
  const s = state, booth = !s.isRemoteEditor;

  // Toolbar
  const tone = s.connection === 'On air' ? 'live' : ['Demo', 'Connecting'].includes(s.connection) ? 'warn' : '';
  $('status').textContent = s.connection;
  $('status').dataset.tone = tone;
  $('role-label').hidden = booth;
  $('monitor').hidden = !booth;
  paint($('monitor'), s.isMonitoring ? `${icon('pause')}Pause` : `${icon('play')}Connect to Proclaim`);
  $('monitor').classList.toggle('btn-primary', !s.isMonitoring);

  // Sidebar
  $('sync').disabled = !s.isMonitoring || s.connection === 'Off air' || s.syncRequested;
  $('sync').hidden = !booth;
  $('sync-label').textContent = s.syncRequested ? 'Syncing…' : 'Sync';
  const picker = $('picker');
  picker.hidden = s.presentations.length < 2;
  paint(picker, s.presentations.map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join(''));
  if (s.presentation) picker.value = s.presentation.id;
  $('presentation-title').hidden = !picker.hidden;
  $('presentation-title').textContent = s.presentation?.title ?? (booth ? 'Waiting for Proclaim' : 'Waiting for the presentation Mac');
  $('presentation-meta').textContent = s.presentation
    ? `${s.items.length} item${s.items.length === 1 ? '' : 's'} · ${s.linkedCount} linked${s.cached ? ' · Cached list' : ''}` : '';
  $('search').parentElement.hidden = !s.presentation;
  renderList();

  // On screen now → tap destination
  const live = $('live'), onAir = s.connection === 'On air';
  live.toggleAttribute('data-live', onAir);
  paint(live, `
    <div class="split">
      <span class="eyebrow">${s.isDemo ? 'Simulated screen' : 'On screen now'}</span>
      <span class="row-actions">${s.live.slide ? `<span class="caption">Slide ${s.live.slide}</span>` : ''}
        ${onAir ? '<span class="badge" data-tone="live">On air</span>' : ''}</span>
    </div>
    <h2 class="display">${esc(s.live.title)}</h2>
    <p class="caption">${esc([s.live.context, s.detail].filter(Boolean).join(' · '))}</p>`);
  const d = s.destination, target = $('destination');
  target.toggleAttribute('data-fallback', d.isFallback);
  paint(target, `
    ${icon(d.isFallback ? 'home' : 'link')}
    <div class="body">
      <div class="split"><span class="eyebrow">A tap opens</span><span class="badge" data-tone="${d.healthy ? 'ok' : ''}">${esc(d.badge)}</span></div>
      <h3 class="title">${esc(d.isFallback ? 'Church Center' : d.reason)}</h3>
      <p class="mono url selectable">${esc(d.url ?? 'Add your Church Center URL in Settings')}</p>
      ${d.isFallback ? `<p class="caption">${esc(d.reason)}</p>` : ''}
    </div>
    ${d.url ? `<button class="btn btn-icon" data-action="open" data-url="${esc(d.url)}" aria-label="Open this link in your browser" title="Open this link in your browser">${icon('open')}</button>` : ''}`);
  $('force-row').hidden = !booth;
  $('force').checked = s.forceFallback;
  paint($('server-notes'), notes([[s.serverMessage], [s.serverError, true], [d.confirmedURL && `Last confirmed: ${d.confirmedURL}`]]));

  renderEditor();
  $('storage-error').hidden = !s.storageError;
  $('storage-error').textContent = s.storageError ?? '';

  // Status bar and the parts of Settings that reflect live state
  $('source').textContent = booth ? 'Proclaim on this Mac · 127.0.0.1:52195' : `Remote editor · ${s.settings.url}`;
  $('last-response').textContent = s.lastChecked
    ? `Last response ${new Date(s.lastChecked).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : '';
  $('set-import').disabled = !s.usesCloud || s.cloud.saving || !s.cloud.fresh || !booth;
  paint($('set-cloud-notes'), s.usesCloud ? notes([[s.cloud.message], [s.cloud.error, true]]) : '');
}

function renderList() {
  const s = state, list = $('list'), query = $('search').value.trim().toLowerCase();
  if (!s.presentation) {
    return paint(list, `<div class="empty">${icon('screen')}<strong>Bring your service into view</strong>
      <p>${s.isRemoteEditor
        ? 'Connect to the server in Settings. Presentations appear after the presentation Mac uploads them, and stay editable while that Mac is off.'
        : 'Open Proclaim on this Mac, enable Settings → Remote, and go On Air. Your presentation syncs automatically.'}</p>
      ${s.isRemoteEditor ? '' : '<button class="btn" data-action="demo">Explore a sample presentation</button>'}</div>`);
  }
  const visible = s.items.filter(item => !query || item.title.toLowerCase().includes(query));
  let section = null;
  const rows = visible.map(item => {
    const head = item.section === section ? '' : `<div class="list-section eyebrow">${esc(section = item.section)}</div>`;
    const isLive = item.id === s.currentItemID;
    return `${head}<button class="row" role="option" data-action="select" data-id="${esc(item.id)}" aria-selected="${item.id === s.selectedItemID}"${isLive ? ' data-live' : ''}>
      <span class="row-main"><span class="row-title">${titleMarkup(item)}</span>
        ${item.warning ? `<span class="row-warn">${esc(item.warning)}</span>` : ''}</span>
      ${isLive ? '<span class="row-live">LIVE</span>' : ''}${item.linked ? icon('link') : ''}</button>`;
  }).join('');
  const hadFocus = list.contains(document.activeElement);
  paint(list, rows || '<p class="empty-search">No announcements match that search.</p>');
  if (hadFocus && !list.contains(document.activeElement)) list.querySelector('[aria-selected="true"]')?.focus();
}

function renderEditor() {
  const s = state, item = s.items.find(i => i.id === s.selectedItemID), input = $('link-input');
  $('editor').hidden = !item;
  if (!item) { editorKey = null; return; }
  const key = `${s.presentation.id}/${item.id}`;
  // Adopt the saved value when switching items, or when it changes underneath text the user has not edited.
  if (key !== editorKey || input.value === baseline || input.value === item.link) input.value = baseline = item.link;
  editorKey = key;
  paint($('edit-title'), titleMarkup(item));
  $('edit-meta').textContent = `${item.section} · ${item.slides} slide${item.slides === 1 ? '' : 's'}`;
  $('demo-show').hidden = !s.isDemo;
  input.disabled = s.usesCloud && (!item.marker || s.cloud.saving || !s.cloud.fresh);
  $('edit-hint').textContent = !s.usesCloud
    ? 'Leave empty to use Church Center. This local link applies to every slide in this item; each copy has its own mapping.'
    : item.marker
      ? 'This link applies to every item using this marker, including future weekly duplicates. Clearing it removes the shared link everywhere.'
      : 'Add exactly one marker such as [tap:giving] to this item’s title in Proclaim. Unmarked items use Church Center.';
  paint($('cloud-notes'), s.usesCloud ? notes([[s.cloud.message], [s.cloud.error, true]]) : '');
  validateEditor();
}

function validateEditor() {
  const input = $('link-input'), item = state.items.find(i => i.id === state.selectedItemID), valid = okLink(input.value);
  input.setAttribute('aria-invalid', !valid);
  $('link-error').hidden = valid;
  $('link-save').disabled = !valid || input.disabled;
  $('link-reload').hidden = !item || input.value === item.link;
}

function openSettings() {
  const { settings, fallbackURL } = state;
  document.querySelector(`[name="role"][value="${settings.monitorLocal ? 'booth' : 'editor'}"]`).checked = true;
  $('set-url').value = settings.url;
  $('set-token').value = '';
  $('set-cloud').checked = settings.cloudEnabled;
  $('set-publish').checked = settings.enabled;
  $('set-fallback').value = fallbackURL;
  $('set-error').hidden = $('set-fallback-error').hidden = true;
  syncRole();
  $('settings').showModal();
}
// A remote editor always syncs and never publishes.
function syncRole() {
  const editor = document.querySelector('[name="role"]:checked').value === 'editor';
  if (editor) { $('set-cloud').checked = true; $('set-publish').checked = false; }
  $('set-cloud').disabled = $('set-publish').disabled = editor;
}
async function saveServer() {
  await call('configureServer', { url: $('set-url').value, token: $('set-token').value, enabled: $('set-publish').checked,
    cloudEnabled: $('set-cloud').checked, monitorLocal: document.querySelector('[name="role"]:checked').value === 'booth' });
  $('set-error').hidden = !state.serverError;
  $('set-error').textContent = state.serverError ?? '';
  if (!state.serverError) $('set-token').value = '';
}

const actions = {
  monitor: () => call(state.isMonitoring ? 'stop' : 'start'),
  sync: () => call('sync'),
  demo: () => call('showDemo'),
  select: el => call('select', el.dataset.id),
  open: el => call('open', el.dataset.url),
  'demo-show': () => call('showDemoItem', state.selectedItemID),
  'reload-link': () => { editorKey = null; renderEditor(); },
  settings: openSettings,
  'close-settings': () => $('settings').close(),
  'save-server': saveServer,
  'save-fallback': () => {
    const valid = okLink($('set-fallback').value);
    $('set-fallback-error').hidden = valid;
    if (valid) call('setFallback', $('set-fallback').value);
  },
  import: () => call('importLinks'),
  export: () => call('exportProfile'),
};
document.addEventListener('click', event => {
  const el = event.target.closest('[data-action]');
  if (el && !el.disabled) actions[el.dataset.action](el);
});
$('link-form').addEventListener('submit', event => {
  event.preventDefault();
  if (okLink($('link-input').value)) call('setLink', $('link-input').value, state.selectedItemID, baseline);
});
$('link-input').addEventListener('input', validateEditor);
$('search').addEventListener('input', renderList);
$('force').addEventListener('change', event => call('setForceFallback', event.target.checked));
$('picker').addEventListener('change', event => call('choosePresentation', event.target.value));
document.querySelectorAll('[name="role"]').forEach(radio => radio.addEventListener('change', syncRole));
$('list').addEventListener('keydown', event => {
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const rows = [...$('list').querySelectorAll('.row')];
  const row = rows[rows.indexOf(document.activeElement) + step];
  if (row) { row.focus(); actions.select(row); }
});

window.tap.onState(render);
call('view');
