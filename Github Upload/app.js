// ══════════════════════════════════════════════════════════════════════════════
// Configuration
// ══════════════════════════════════════════════════════════════════════════════
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Sub-contractor expense accounts — only two exist in MEC's Xero chart:
//   301   = sub-contractors, NO GST   (Type A individual, Type C company)
//   301-A = sub-contractors, GST registered (Type B individual+GST, Type D company+GST)
let ACCOUNT_CODES = {
  A: '301',    // No GST
  B: '301-A',  // GST registered
  C: '301',    // No GST
  D: '301-A',  // GST registered
};

// Xero AU tax type names exactly as Xero expects on bill import. "Tax on Purchases" is NOT a
// valid Xero AU rate (it imported blank); the GST-on-purchases rate is "GST on Expenses".
let TAX_TYPES = {
  A: 'GST Free Expenses',
  B: 'GST on Expenses',
  C: 'GST Free Expenses',
  D: 'GST on Expenses',
};

// ── Two-bill super workflow (accountant-agreed, May 2026) ──────────────────────
// Bill 1 = contractor (paid net). Bill 2 = super, billed to the clearing house and
// paid as a separate ABA batch. Super is expensed above the line on account 478-C.
// For GST-registered contractors (Type B/D) a matching BAS-excluded withholding line
// on Bill 1 offsets 478-C so the GST credit stays on the full fee. The old liability
// account 826-C is retired from this flow (the liability sits in AP/800 automatically).
// CLEARINGHOUSE_NAME is the Xero supplier + the name shown in the contractor's super note.
// Update it once a clearing-house provider is chosen (see TODO.md, item 11).
let CLEARINGHOUSE_NAME = 'Australian Super Clearing House';
let SUPER_ACCOUNT = '478-C';
// Zoho Forms "Super & Payment Details" form — appending ?crm_entity_id=<TeamRecordId> pre-fills it
// for that contractor. Used by the completeness gate's "Copy form link / Email" actions.
// Override via config.json "superFormUrl".
let SUPER_FORM_URL = 'https://forms.zohopublic.com/melbourneentertainmentco/form/MECSuperPaymentDetails/formperma/9tfujE0ZwFo01T4gZWmdiplXXc0j7cpqvHhDDrX1nRQ';

// ── Duo / group super detection (config-driven; see config.json) ───────────────
// Performers who flip between solo and duo/group under one ABN. Lower-cased names.
let VARIABLE_LINEUP_PERFORMERS = [];
// Exact "What Did They End Up Booking?" values that imply multiple performers / could go either way.
let MULTI_OFFERINGS = [];
let AMBIGUOUS_OFFERINGS = [];
// Keyword engine so renamed/new offering values are caught without editing config.json.
const MULTI_KEYWORDS = ['duo','trio','quartet','quintet','sextet','band','pair','group','ensemble','mariachi','choir','collective'];
const SOLO_KEYWORDS  = ['soloist'];

// ── Known retail/AP suppliers (Dan Murphy's etc.) — see config.json knownSuppliers ───────────
// Gmail reader flags these so liquor/supplier tax invoices aren't treated as contractor invoices.
let KNOWN_SUPPLIERS = [];

const TYPE_LABELS = {
  A: 'No GST · Super ✓',
  B: 'GST · Super ✓',
  C: 'No GST · No super',
  D: 'GST · No super',
};

// Column name candidates for Zoho CSV auto-detection
const COL_CANDIDATES = {
  firstName:    ['first name','firstname','given name','first'],
  lastName:     ['last name','lastname','surname','family name','last'],
  fullName:     ['full name','fullname','name','contact name','performer name','contractor name','display name'],
  entityType:   ['entity type','account type','business structure','contractor type','structure','entity'],
  gstReg:       ['gst registered','gst registration','registered for gst','gst','has gst','gst status'],
  superEligible:['super eligible','superannuation eligible','sg eligible','super eligibility',
                 'super','superannuation','eligible for super','sgaa eligible'],
  fundName:     ['super fund','fund name','superannuation fund','fund','default fund'],
  fundUSI:      ['usi','fund usi','super fund usi','unique superannuation identifier'],
  fundABN:      ['fund abn','super fund abn','abn (fund)'],
  memberNumber: ['member number','member id','account number','super account','member account',
                 'super member number','membership number'],
  tfn:          ['tfn','tax file number','taxpayer identification'],
};

// ══════════════════════════════════════════════════════════════════════════════
// Embedded Data — auto-refreshed by Claude when caches are rebuilt
// Contractors: 163 records, generated 2026-05-14 21:54:17
// Bookings:    872 records, generated 2026-05-14 20:55:39
// ══════════════════════════════════════════════════════════════════════════════
let EMBEDDED_CONTRACTORS_META = {generated:'', recordCount:0};
let EMBEDDED_CONTRACTORS = [];

let EMBEDDED_BOOKINGS_META = {generated:'', recordCount:0};
let EMBEDDED_BOOKINGS = [];

// ── State ──
let contractors = [];
let rawHeaders = [];
let colMap = {};
let invoices = [];
let processed = [];
let manualRowId = 0;
let abrCache = {};      // keyed by cleaned 11-digit ABN
let abrRowData = {};      // keyed by row id, stores ABR lookup result
let invoiceGSTData = {};        // keyed by row id, stores hasGST from PDF extraction
let invoiceSuperData = {};      // keyed by row id, stores superWithhold override
let invoiceSuperShareData = {}; // keyed by row id, duo/group: this performer's own super-assessable share ($). When set, super is calculated on this amount instead of the full service fee. Payment is unchanged.
let invoiceSuperModeData  = {}; // keyed by row id, the user-picked super decision per invoice: 'solo' | 'group'.
let invoicePaidData = {};      // keyed by row id, stores alreadyPaid from PDF extraction
let invoiceBookingData = {};   // keyed by row id, stores [{bookingId,bookingName,eventDate,cost}] — selected booking matches
let invoiceExpenseData = {};   // keyed by row id, stores {parking:0, accommodation:0, travel:0, other:0}
let invoicePerfGuess = {};     // keyed by row id, true if the perf date was a best-guess (not an explicit event-date label) — surfaced in Review, not Stage 1
let invoiceTypeData = {};      // keyed by row id, stores 'event' | 'ap' | 'unknown'
let invoiceFileData = {};      // keyed by row id, stores object URL for PDF preview
let invoiceRawText = {};       // keyed by row id, stores raw PDF text for debugging
let bookings = [];      // loaded from MEC Bookings Cache.json

// ══════════════════════════════════════════════════════════════════════════════
// Navigation
// ══════════════════════════════════════════════════════════════════════════════
function gotoStep(n) {
  // Views: refresh (Step 1), 2 (Enter Invoice Data), 3 (Review & Export), talent
  const views = ['refresh', 2, 3, 'talent'];
  const order = { refresh: 1, 2: 2, 3: 3 };   // for the "done" tick on earlier steps
  views.forEach(i => {
    const el = document.getElementById(`view-${i}`);
    if (el) el.classList.toggle('hidden', i !== n);
    const tab = document.getElementById(`step-tab-${i}`);
    if (!tab) return;
    tab.classList.remove('active','done');
    if (i === n) tab.classList.add('active');
    else if (order[i] != null && order[n] != null && order[i] < order[n]) tab.classList.add('done');
  });
  // Close data panel when navigating to a step
  document.getElementById('data-panel').classList.add('hidden');
  // Render talent list when switching to that view
  if (n === 'talent') renderTalentList();
  // Make sure the SAFF contribution-period inputs are pre-filled when the export step opens
  if (n === 3) initSaffPeriodDefaults();
  // Track where we are so the Talent List tab can toggle back to the previous main step
  if (n !== 'talent') lastMainStep = n;
  currentView = n;
}
let currentView = 'refresh';
let lastMainStep = 'refresh';

// Talent List tab toggles: open it, or if already open go back to the last main step.
function toggleTalent() {
  gotoStep(currentView === 'talent' ? lastMainStep : 'talent');
}

function showHowItWorks() {
  const m = document.getElementById('how-modal');
  if (m) m.style.display = 'flex';
}
function closeHowItWorks() {
  const m = document.getElementById('how-modal');
  if (m) m.style.display = 'none';
}

// In-page banner (replaces blocking alert() for routine workflow messages).
// type: 'info' | 'success' | 'warn' | 'error'. Click to dismiss; auto-dismisses.
function showBanner(msg, type = 'info') {
  const palette = {
    info:    ['#1D4ED8', '#EFF6FF', '#BFDBFE'],
    success: ['#166534', '#F0FDF4', '#BBF7D0'],
    warn:    ['#92400E', '#FFFBEB', '#FDE68A'],
    error:   ['#991B1B', '#FEF2F2', '#FECACA'],
  };
  const [fg, bg, bd] = palette[type] || palette.info;
  let host = document.getElementById('app-banner-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'app-banner-host';
    host.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:10050;display:flex;flex-direction:column;gap:8px;align-items:center';
    document.body.appendChild(host);
  }
  const b = document.createElement('div');
  b.style.cssText = `background:${bg};color:${fg};border:1px solid ${bd};border-radius:8px;padding:10px 16px;font-size:13px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.14);display:flex;align-items:center;gap:14px;cursor:pointer;max-width:560px`;
  b.innerHTML = `<span style="flex:1;white-space:pre-line">${msg}</span><span style="opacity:.55;font-weight:700">✕</span>`;
  b.onclick = () => b.remove();
  host.appendChild(b);
  setTimeout(() => { b.style.transition = 'opacity .4s'; b.style.opacity = '0'; setTimeout(() => b.remove(), 400); },
    (type === 'error' || type === 'warn') ? 8000 : 4500);
}

function renderTalentList() {
  const query = (document.getElementById('talent-search')?.value || '').toLowerCase().trim();
  const fType  = document.getElementById('talent-filter-type')?.value  || '';
  const fGst   = document.getElementById('talent-filter-gst')?.value   || '';
  const fAbn   = document.getElementById('talent-filter-abn')?.value   || '';
  const fSuper = document.getElementById('talent-filter-super')?.value || '';

  const data = contractors.filter(c => {
    if (query && !(c.name.toLowerCase().includes(query) || (c.abn && c.abn.includes(query)) || (c.fundName && c.fundName.toLowerCase().includes(query)))) return false;
    if (fType && c.type !== fType) return false;
    if (fGst === 'yes' && !c.gst) return false;
    if (fGst === 'no'  &&  c.gst) return false;
    if (fAbn === 'has'     && !c.abn) return false;
    if (fAbn === 'missing' &&  c.abn) return false;
    if (fSuper) {
      // Super-eligibility is by TYPE (A/B withhold super; C/D don't) — matches how the tool
      // actually withholds, and is reliable even when the cached superEligible flag is stale.
      const elig = ['A','B'].includes(c.type);
      const complete   = elig && missingSuperFields(c).length === 0;
      const incomplete = elig && missingSuperFields(c).length > 0;
      if (fSuper === 'complete'   && !complete)   return false;   // excludes C/D (n/a) too
      if (fSuper === 'incomplete' && !incomplete) return false;
    }
    return true;
  }).sort((a,b) => a.name.localeCompare(b.name));

  document.getElementById('talent-count').textContent =
    `${data.length} of ${contractors.length} contractors`;

  const tbody = document.getElementById('talent-tbody');
  if (!tbody) return;
  tbody.innerHTML = data.map((c, i) => {
    const typeColor = {A:'badge-a',B:'badge-b',C:'badge-c',D:'badge-d'}[c.type] || 'badge-a';
    const gstCell = c.gst ? `<span style="color:#27AE60;font-weight:600">✓ Yes</span>` : `<span style="color:#aaa">—</span>`;
    const superCell = c.superEligible ? `<span style="color:#27AE60;font-weight:600">✓ Yes</span>` : `<span style="color:#aaa">—</span>`;
    const fundWarning = c.superEligible && !c.fundName
      ? `<span style="color:#c0392b;font-size:11px">⚠ not set</span>` : escHtml(c.fundName || '—');
    // Super-details health — applies to type A/B (who have super withheld); C/D = n/a
    let superStatus;
    if (!['A','B'].includes(c.type)) {
      superStatus = `<span style="color:#aaa;font-size:11px">n/a</span>`;
    } else {
      const miss = missingSuperFields(c);
      const detail = `<strong>${escHtml(c.name)}</strong>`
        + `DOB: ${c.dob||'—'} · Gender: ${c.gender||'—'}<br>`
        + `Fund USI: ${c.fundUSI||'—'} · Member: ${c.memberNumber||'—'}<br>`
        + `Address: ${escHtml(c.address||'—')}, ${escHtml(c.suburb||'—')} ${escHtml(c.state||'')} ${escHtml(c.postcode||'')}<br>`
        + (miss.length ? `<span style="color:#FCA5A5">Missing: ${escHtml(miss.join(', '))}</span>` : `<span style="color:#86EFAC">All super details complete ✓</span>`);
      superStatus = miss.length
        ? `<span class="s2-tip" style="color:#C53030;font-weight:600;font-size:11px;cursor:help">⚠ ${miss.length} missing<span class="s2-tip-box">${detail}</span></span>`
        : `<span class="s2-tip" style="color:#27AE60;font-weight:600;font-size:11px;cursor:help">✓ Complete<span class="s2-tip-box">${detail}</span></span>`;
    }
    return `<tr>
      <td style="text-align:right;color:#aaa;font-size:11px">${i+1}</td>
      <td><strong>${escHtml(c.name)}</strong></td>
      <td><span class="badge ${typeColor}" style="font-size:10px">${c.type} — ${TYPE_LABELS[c.type]||c.type}</span></td>
      <td style="font-size:11px;color:#555">${escHtml(c.structure||'—')}</td>
      <td style="font-family:monospace;font-size:11px">${escHtml(c.abn||'—')}</td>
      <td style="text-align:center">${gstCell}</td>
      <td style="text-align:center">${superCell}</td>
      <td style="text-align:center">${superStatus}</td>
      <td style="font-size:11px">${fundWarning}</td>
      <td style="font-size:11px;color:#666">${escHtml(c.fundUSI||'—')}</td>
      <td style="font-size:11px;color:#666">${escHtml(c.memberNumber||'—')}</td>
    </tr>`;
  }).join('');
}

function toggleDataPanel() {
  const panel = document.getElementById('data-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    panel.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

function sortInvoiceRows(criterion) {
  if (!criterion) return;
  const getSortKey = (tr) => {
    const id = tr.id.replace('row-','');
    switch (criterion) {
      case 'name':  return (document.getElementById('name-'+id)?.value || 'zzz').toLowerCase();
      case 'total-desc': return -(parseFloat(document.getElementById('total-'+id)?.value) || 0);
      case 'total-asc':  return  (parseFloat(document.getElementById('total-'+id)?.value) || 0);
      case 'date':  return document.getElementById('date-'+id)?.value || '';
      default: return 0;
    }
  };
  ['pdf-tbody','ap-review-tbody','manual-tbody'].forEach(tbodyId => {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const rows = [...tbody.querySelectorAll('tr[id]')];
    rows.sort((a, b) => {
      const ka = getSortKey(a), kb = getSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    rows.forEach(tr => tbody.appendChild(tr));
  });
}

function toggleSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    panel.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

function initEmbeddedData() {
  // Auto-load contractors from embedded cache
  contractors = EMBEDDED_CONTRACTORS.map(r => ({
    name:         r.name || '',
    firstName:    r.firstName || '',
    lastName:     r.lastName  || '',
    abn:          r.abn  || '',
    type:         r.type || null,
    superEligible: !!(r.super || r.superEligible),
    superPercentage: r.superPercentage ?? null,   // Zoho Super_Percentage; null → tool uses 12% default
    gst:          !!(r.gst),
    structure:    r.structure || '',
    fundName:     r.fundName  || '',
    fundUSI:      r.fundUSI   || '',
    fundABN:      r.fundABN   || '',
    memberNumber: r.memberNumber || '',
    xeroName:     r.xeroName || '',   // exact Xero contact name → used as the bill "From"
    variableLineup: r.variableLineup === true,  // duo/group watch-list flag from Zoho Team checkbox (if enabled)
    // SAFF member fields — present only after a live "Refresh from Zoho" (NOT baked into the
    // committed contractors.json, as TFN/DOB are sensitive PII). Empty on the static cache load.
    tfn:          r.tfn   || '',
    dob:          r.dob   || '',
    gender:       r.gender || '',
    email:        r.email || '',
    phone:        r.phone || '',
    address:      r.address  || '',
    suburb:       r.suburb   || '',
    state:        r.state    || '',
    postcode:     r.postcode || '',
    zohoId:       r.id || '',
  })).filter(c => c.name && c.name !== 'TBC' && !c.name.startsWith('TEST '));

  // Auto-load bookings
  bookings = EMBEDDED_BOOKINGS;

  // Update header status
  const d = (EMBEDDED_CONTRACTORS_META.generated || '').slice(0,16) || '—';
  document.getElementById('hdr-status').textContent =
    `${contractors.length} contractors · ${bookings.length} bookings — ${d}`;
  const refreshStatus = document.getElementById('refresh-screen-status');
  if (refreshStatus) refreshStatus.textContent =
    `Loaded: ${contractors.length} contractors · ${bookings.length} bookings — as of ${d}`;

  // Restore the saved Zoho proxy URL into the Settings field (no default — must be pasted once)
  const zp = document.getElementById('zoho-proxy-url');
  if (zp) zp.value = localStorage.getItem('zohoProxyUrl') || '';

  // Restore Xero push proxy URL + access key (Step 3 button uses these)
  const xpu = document.getElementById('xero-proxy-url');
  if (xpu) xpu.value = localStorage.getItem('xeroProxyUrl') || '';
  const xak = document.getElementById('xero-access-key');
  if (xak) xak.value = localStorage.getItem('xeroAccessKey') || '';
}

// ── Live "Refresh from Zoho" — calls the proxy (Apps Script) which holds the Zoho login,
//    runs the scoped query, and returns { generated, contractors:[...], bookings:[...] }.
//    Loads the result in memory for this session (no file upload, no commit needed). ──
async function refreshFromZoho() {
  const url = (localStorage.getItem('zohoProxyUrl') || '').trim();
  if (!url) {
    alert('No Zoho refresh URL is set yet.\n\nOpen ⚙ Settings and paste your Zoho proxy URL, then try again.');
    if (typeof toggleSettingsPanel === 'function') toggleSettingsPanel();
    return;
  }
  const btn = document.getElementById('zoho-refresh-btn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Pulling…'; }
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error('Proxy returned HTTP ' + res.status);
    const data = await res.json();
    if (data && data.error) throw new Error(data.error);
    const contr = Array.isArray(data.contractors) ? data.contractors : null;
    const book  = Array.isArray(data.bookings)    ? data.bookings    : null;
    if (!contr || !book) throw new Error('Unexpected response — expected { contractors:[…], bookings:[…] }');
    const stamp = data.generated || new Date().toISOString().slice(0,16).replace('T',' ');
    EMBEDDED_CONTRACTORS = contr;
    EMBEDDED_CONTRACTORS_META = { generated: stamp, recordCount: contr.length };
    EMBEDDED_BOOKINGS = book;
    EMBEDDED_BOOKINGS_META = { generated: stamp, recordCount: book.length };
    initEmbeddedData();
    const withXero = contractors.filter(c => c.xeroName && String(c.xeroName).trim()).length;
    showBanner(`✓ Refreshed live from Zoho — ${contractors.length} contractors (${withXero} with a Xero entity name) · ${bookings.length} bookings (Confirmed · −6/+2 months · still-unpaid only), as of ${stamp}`, 'success');
  } catch (e) {
    console.error('Zoho refresh failed', e);
    alert('Zoho refresh failed:\n' + e.message + '\n\nCheck the URL in ⚙ Settings, and that the proxy is deployed and authorised.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('review-modal').style.display !== 'none') closeReviewModal();
    if (document.getElementById('raw-text-overlay').style.display !== 'none') closeRawText();
    if (document.getElementById('gst-modal-overlay').classList.contains('open')) closeGSTModal();
  }
});

/* initial data load + UI init handled by bootstrap() at the end of this file */

// ══════════════════════════════════════════════════════════════════════════════
// Step 1: Contractors Cache JSON
// ══════════════════════════════════════════════════════════════════════════════
function handleContractorsJsonFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      const raw = data.contractors || data;
      contractors = raw.map(r => ({
        name:          r.name || '',
        abn:           r.abn  || '',
        type:          r.type || null,
        superEligible: !!(r.super || r.superEligible),
        gst:           !!(r.gst),
        structure:     r.structure || '',
        fundName:      r.fundName  || '',
        fundUSI:       r.fundUSI   || '',
        memberNumber:  r.memberNumber || '',
        superPercentage: r.superPercentage ?? null,
        xeroName:      r.xeroName || '',
        variableLineup: r.variableLineup === true,
        zohoId:        r.id || '',
      })).filter(c => c.name && c.name !== 'TBC' && !c.name.startsWith('TEST ') && !c.name.startsWith('Nathan Op'));

      document.getElementById('zoho-count').textContent =
        `⚡ ${contractors.length} contractors loaded from cache`;
      buildZohoPreview();
      document.getElementById('zoho-mapping').classList.add('hidden');
      document.getElementById('zoho-loaded').classList.remove('hidden');
      // Hide the drop zones so the panel is tidy
      document.getElementById('contractors-json-drop').classList.add('hidden');
      document.getElementById('zoho-drop').parentElement.querySelectorAll('.drop-zone, div[style*="or use"]').forEach(el => el.style.display = 'none');
    } catch(err) {
      alert('Could not parse contractors JSON: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 1: Zoho CSV
// ══════════════════════════════════════════════════════════════════════════════
function handleZohoFile(input) {
  const file = input.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete: result => {
      rawHeaders = result.meta.fields || [];
      buildColMapUI(rawHeaders);
      document.getElementById('zoho-mapping').classList.remove('hidden');
    }
  });
}

function buildColMapUI(headers) {
  const lc = headers.map(h => h.toLowerCase().trim());
  const grid = document.getElementById('col-map-grid');
  grid.innerHTML = '';

  const fields = [
    ['fullName',    'Performer full name'],
    ['firstName',   'First name (if separate)'],
    ['lastName',    'Last name (if separate)'],
    ['entityType',  'Entity type (Sole Trader / Pty Ltd)'],
    ['gstReg',      'GST registered (Yes/No)'],
    ['superEligible','Super eligible (Yes/No)'],
    ['fundName',    'Super fund name'],
    ['fundUSI',     'Fund USI'],
    ['fundABN',     'Fund ABN'],
    ['memberNumber','Member number'],
    ['tfn',         'TFN (optional)'],
  ];

  fields.forEach(([key, label]) => {
    const best = autoDetectCol(key, lc, headers);
    const row = document.createElement('div');
    row.className = 'map-row';
    row.innerHTML = `
      <label>${label}</label>
      <select id="map-${key}" style="flex:1">
        <option value="">(not in this export)</option>
        ${headers.map(h => `<option value="${h}" ${h===best?'selected':''}>${h}</option>`).join('')}
      </select>`;
    grid.appendChild(row);
  });
}

function autoDetectCol(key, lcHeaders, headers) {
  const candidates = COL_CANDIDATES[key] || [];
  for (const c of candidates) {
    const idx = lcHeaders.findIndex(h => h.includes(c));
    if (idx >= 0) return headers[idx];
  }
  return '';
}

function confirmMapping() {
  const fields = ['fullName','firstName','lastName','entityType','gstReg',
                  'superEligible','fundName','fundUSI','fundABN','memberNumber','tfn'];
  colMap = {};
  fields.forEach(f => {
    colMap[f] = document.getElementById(`map-${f}`)?.value || '';
  });

  // Re-parse file
  const file = document.getElementById('zoho-file').files[0];
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete: result => {
      contractors = result.data.map(row => parseContractor(row));
      contractors = contractors.filter(c => c.name);
      document.getElementById('zoho-count').textContent =
        `✓ ${contractors.length} contractors loaded`;
      buildZohoPreview();
      document.getElementById('zoho-mapping').classList.add('hidden');
      document.getElementById('zoho-loaded').classList.remove('hidden');
      document.getElementById('hdr-status').textContent =
        `${contractors.length} contractors loaded`;
    }
  });
}

function parseContractor(row) {
  const get = key => (row[colMap[key]] || '').trim();

  let name = get('fullName');
  if (!name && (get('firstName') || get('lastName')))
    name = (get('firstName') + ' ' + get('lastName')).trim();

  const entityRaw = get('entityType').toLowerCase();
  // "Not a sole trader" — companies, trusts AND partnerships. Super is only withheld from
  // sole traders, so partnerships must be excluded here (policy: May 2026).
  const isPtyLtd = entityRaw.includes('pty') || entityRaw.includes('company') ||
                   entityRaw.includes('trust') || entityRaw.includes('ltd') ||
                   entityRaw.includes('corp') || entityRaw.includes('partner');

  const gstRaw = get('gstReg').toLowerCase();
  const isGST = gstRaw.includes('yes') || gstRaw === '1' || gstRaw === 'true' || gstRaw === 'y';

  const superRaw = get('superEligible').toLowerCase();
  const isSuperEligible = !isPtyLtd && (
    superRaw.includes('yes') || superRaw === '1' || superRaw === 'true' || superRaw === 'y' ||
    superRaw === '' // default: if sole trader and no explicit "No", assume eligible
  );

  let type;
  if (!isPtyLtd && !isGST) type = 'A';
  else if (!isPtyLtd && isGST) type = 'B';
  else if (isPtyLtd && !isGST) type = 'C';
  else type = 'D';

  return {
    name, entityType: get('entityType'), gstReg: isGST,
    superEligible: isSuperEligible, type,
    fundName: get('fundName'), fundUSI: get('fundUSI'),
    fundABN: get('fundABN'), memberNumber: get('memberNumber'),
    tfn: get('tfn'),
  };
}

function buildZohoPreview() {
  const tbl = document.getElementById('zoho-preview');
  tbl.innerHTML = `
    <thead><tr>
      <th>Name</th><th>Entity Type</th><th>GST</th>
      <th>Super Eligible</th><th>Type</th><th>Fund</th>
    </tr></thead>
    <tbody>
      ${contractors.slice(0,10).map(c => `
        <tr>
          <td>${c.name}</td>
          <td>${c.entityType||'—'}</td>
          <td>${c.gstReg?'Yes':'No'}</td>
          <td>${c.superEligible?'Yes':'No'}</td>
          <td><span class="badge badge-${c.type.toLowerCase()}">${c.type} — ${TYPE_LABELS[c.type]}</span></td>
          <td style="font-size:11px">${c.fundName||'—'}</td>
        </tr>`).join('')}
      ${contractors.length > 10 ? `<tr><td colspan="6" style="color:#888;font-size:12px;padding:8px">
        … and ${contractors.length - 10} more</td></tr>` : ''}
    </tbody>`;
}

function resetZoho() {
  contractors = [];
  document.getElementById('zoho-file').value = '';
  document.getElementById('zoho-loaded').classList.add('hidden');
  document.getElementById('zoho-mapping').classList.add('hidden');
}

// ══════════════════════════════════════════════════════════════════════════════
// Bookings Cache (Zoho)
// ══════════════════════════════════════════════════════════════════════════════
function showBookingsPanel() {
  document.getElementById('view-1-bookings').classList.remove('hidden');
  document.getElementById('view-1-bookings').scrollIntoView({behavior:'smooth'});
}

function handleBookingsFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      bookings = data.bookings || [];
      const generated = data.generated ? new Date(data.generated).toLocaleDateString('en-AU') : 'unknown date';
      document.getElementById('bookings-status').innerHTML =
        `<strong>${bookings.length} bookings loaded</strong> (generated ${generated}) — cross-checking enabled.`;
      document.getElementById('bookings-loaded').classList.remove('hidden');
    } catch(err) {
      alert('Could not read bookings file. Make sure you loaded MEC Bookings Cache.json');
    }
  };
  reader.readAsText(file);
}

function resetBookings() {
  bookings = [];
  document.getElementById('bookings-file').value = '';
  document.getElementById('bookings-loaded').classList.add('hidden');
}

// Stopwords for booking name matching (prevent single generic word false-positives)
const BOOKING_MATCH_STOPWORDS = new Set([
  'band','duo','trio','group','ensemble','orchestra','choir','singers',
  'music','the','and','of','with','for',
  'melbourne','entertainment','company','productions','pty','ltd',
  'trust','australia','services','events','management','media','solo'
]);

function _bookingNameMatches(entName, needle) {
  // Guard empty/too-short strings. Without this, a blank entertainer name makes
  // needle.includes('') === true, so an unassigned/nameless booking slot matches EVERY sender —
  // which made the Gmail reader show the same "— 130 unpaid" badge for every contractor.
  entName = (entName || '').trim();
  needle  = (needle  || '').trim();
  if (entName.length < 3 || needle.length < 3) return false;
  if (entName.includes(needle) || needle.includes(entName)) return true;
  // Word-level: require ≥2 meaningful words to match (prevents "band" false-positive)
  const words = entName.split(/\W+/).filter(w => w.length > 2 && !BOOKING_MATCH_STOPWORDS.has(w));
  if (!words.length) return false;
  const matchCount = words.filter(w => needle.includes(w)).length;
  // Single long word (≥6 chars) is OK on its own; otherwise need 2+
  return matchCount >= 2 || (matchCount === 1 && words.find(w => needle.includes(w) && w.length >= 6) !== undefined);
}

function findAllBookingMatches(invoiceName, invoiceTotal, perfDate, invoiceDate) {
  if (!bookings.length) return [];
  const needle = (invoiceName || '').toLowerCase().trim();
  if (!needle || needle.length < 3) return [];
  const refDate = perfDate || invoiceDate || null;
  const results = [];

  for (const booking of bookings) {
    for (const ent of (booking.entertainers || [])) {
      const entName = (ent.name || '').toLowerCase();
      if (!_bookingNameMatches(entName, needle)) continue;

      // Date distance (days) — use perf date preferentially
      let daysDiff = 9999;
      if (refDate && booking.eventDate) {
        daysDiff = Math.abs((new Date(refDate) - new Date(booking.eventDate)) / 86400000);
      }
      if (daysDiff > 400) continue; // ignore very old records

      const costMatch = invoiceTotal > 0
        ? Math.abs(ent.cost - invoiceTotal) / Math.max(ent.cost, 1) < 0.10
        : null;

      results.push({
        booking, entertainer: ent,
        alreadyPaid: ent.paid,
        costMatch, costDiff: invoiceTotal > 0 ? (invoiceTotal - ent.cost) : null,
        daysDiff,
        score: daysDiff * 1 + (costMatch === true ? -200 : 0) + (ent.paid ? 30 : 0)
      });
    }
  }
  return results.sort((a, b) => a.score - b.score).slice(0, 5);
}

function findBookingMatch(invoiceName, invoiceTotal, invoiceDate) {
  const all = findAllBookingMatches(invoiceName, invoiceTotal, null, invoiceDate);
  return all.length ? all[0] : null;
}

// Booking match that prefers explicitly-linked bookings (from Review modal selection) over fuzzy search.
// linkedBookings = invoiceBookingData['id_'+rowId] = [{bookingId, bookingName, eventDate, cost}]
function getBookingMatchForRow(name, total, date, linkedBookings) {
  if (linkedBookings && linkedBookings.length > 0 && bookings.length > 0) {
    for (const lb of linkedBookings) {
      const fullBooking = bookings.find(b => b.id === lb.bookingId);
      if (!fullBooking) continue;
      const ents = fullBooking.entertainers || [];
      // Identify the correct entertainer SLOT in this booking. Prefer the performer whose NAME
      // matches so we read THEIR paid flag — not a same-cost co-performer's. (Matching by cost
      // first caused false 'already paid' flags in multi-performer bookings with equal slot costs.)
      const first = (name || '').toLowerCase().split(' ').filter(Boolean)[0] || '';
      const nameHit = e => first.length >= 3 && (e.name || '').toLowerCase().includes(first);
      const costHit = e => lb.cost > 0 && Math.abs((e.cost || 0) - lb.cost) < 0.01;
      let ent = ents.find(e => nameHit(e) && costHit(e))   // best: name + cost
             || ents.find(nameHit)                          // then the correctly-named performer
             || (lb.cost > 0 ? ents.find(costHit) : null)   // then cost only
             || (ents.length === 1 ? ents[0] : null);       // then the sole entertainer
      if (ent) {
        return {
          booking: fullBooking,
          entertainer: ent,
          alreadyPaid: !!ent.paid,
          costMatch: Math.abs((ent.cost || 0) - total) < 0.01,
          costDiff: Math.abs((ent.cost || 0) - total)
        };
      }
    }
  }
  // No linked bookings (or none resolved) — fall back to fuzzy match
  return findBookingMatch(name, total, date);
}
// Get ALL bookings for a specific contractor by their Zoho ID (exact match — no fuzzy logic)
// Returns records sorted closest to refDate first
function getContractorBookings(zohoId, refDate) {
  if (!bookings.length || !zohoId) return [];
  const ref = refDate ? new Date(refDate + 'T12:00:00') : new Date();
  const results = [];
  for (const booking of bookings) {
    for (const ent of (booking.entertainers || [])) {
      if (ent.id === zohoId) {
        const evtDate = booking.eventDate ? new Date(booking.eventDate + 'T12:00:00') : null;
        const daysDiff = evtDate ? Math.abs((ref - evtDate) / 86400000) : 9999;
        results.push({ booking, entertainer: ent, daysDiff });
        break; // contractor only appears once per booking
      }
    }
  }
  return results.sort((a, b) => a.daysDiff - b.daysDiff);
}

// ══════════════════════════════════════════════════════════════════════════════
// Duo / group super detection
// ══════════════════════════════════════════════════════════════════════════════
// Some performers invoice under one ABN but sometimes work as a duo/group (e.g. Harry Longworth).
// MEC pays the full invoice (the performer pays their partner) but must NOT pay the partner's super
// into the performer's fund. These helpers flag such invoices so the operator is prompted in Review;
// the actual super-assessable share is operator/performer-entered (the tool never guesses a number).

// Is this contractor on the "variable lineup" watch-list (flips between solo and duo/group)?
function isVariableLineup(contractor) {
  if (!contractor) return false;
  if (contractor.variableLineup === true) return true;            // Zoho Team checkbox (once enabled)
  const n = (contractor.name || '').toLowerCase().trim();
  return !!n && VARIABLE_LINEUP_PERFORMERS.indexOf(n) !== -1;     // config.json name list
}

// Classify a single offering string → 'multi' | 'ambiguous' | 'solo'.
function classifyOffering(offer) {
  const s = (offer || '').toLowerCase().trim();
  if (!s) return null;
  if (MULTI_OFFERINGS.indexOf(s) !== -1) return 'multi';
  if (AMBIGUOUS_OFFERINGS.indexOf(s) !== -1) return 'ambiguous';
  if (SOLO_KEYWORDS.some(k => s.indexOf(k) !== -1)) return 'solo';           // "Complete Soloist"
  if (MULTI_KEYWORDS.some(k => new RegExp('\\b' + k).test(s))) return 'multi'; // duo/trio/band/pair/group…
  return 'solo';
}

// Strongest offering signal across a booking's offerings: 'multi' | 'ambiguous' | null.
function bookingOfferingSignal(booking) {
  const offers = booking && booking.offerings;
  if (!Array.isArray(offers) || !offers.length) return null;
  let sig = null;
  for (const o of offers) {
    const c = classifyOffering(o);
    if (c === 'multi') return 'multi';
    if (c === 'ambiguous') sig = 'ambiguous';
  }
  return sig;
}

// Does the invoice's raw text mention a duo/group?
function invoiceTextMultiHint(id) {
  const t = (invoiceRawText['id_' + id] || '').toLowerCase();
  if (!t) return false;
  if (/\b(duo|trio|quartet|quintet|sextet|ensemble|mariachi)\b/.test(t)) return true;
  if (/\b\d+\s*(?:x\s*)?(?:performers|musicians|players|artists|piece)\b/.test(t)) return true;
  if (/\bx\s*\d+\s*(?:performers|musicians|players|artists)\b/.test(t)) return true;
  return false;
}

// Combined per-row flag. Returns { level:'multi'|'ambiguous'|null, reasons:[...] }.
// Pass explicit name/total/date so it works both at row-creation time (before inputs exist) and
// from the Review modal (reading current DOM values).
function multiPerfFlag(id, match, name, total, date) {
  const reasons = [];
  let level = null;
  const escalate = lvl => { if (lvl === 'multi') level = 'multi'; else if (lvl === 'ambiguous' && level !== 'multi') level = 'ambiguous'; };

  if (isVariableLineup(match)) { escalate('multi'); reasons.push(`${match.name} is on the variable-lineup watch-list (sometimes performs as a duo/group)`); }

  const bm = getBookingMatchForRow(name || (match && match.name) || '', total || 0, date || '', invoiceBookingData['id_' + id] || null);
  const sig = bm ? bookingOfferingSignal(bm.booking) : null;
  if (sig) {
    const offerTxt = (bm.booking.offerings || []).join(', ');
    if (sig === 'multi') { escalate('multi'); reasons.push(`the booking was logged as a group${offerTxt ? ' (' + offerTxt + ')' : ''}`); }
    else { escalate('ambiguous'); reasons.push(`the booking offering could be solo or group${offerTxt ? ' (' + offerTxt + ')' : ''}`); }
  }

  if (invoiceTextMultiHint(id)) { escalate('multi'); reasons.push('the invoice text mentions a duo/group'); }

  return { level, reasons };
}

// ══════════════════════════════════════════════════════════════════════════════
// ABR Lookup (Australian Business Register) — JSONP, no CORS proxy needed
// ══════════════════════════════════════════════════════════════════════════════
function abrJsonpLookup(clean, guid) {
  return new Promise((resolve, reject) => {
    const cbName = '_abrCb_' + clean + '_' + Date.now();
    const timeout = setTimeout(() => {
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      reject(new Error('ABR timeout'));
    }, 12000);
    window[cbName] = function(data) {
      clearTimeout(timeout);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      resolve(data);
    };
    const script = document.createElement('script');
    script.onerror = () => {
      clearTimeout(timeout);
      delete window[cbName];
      reject(new Error('ABR script error'));
    };
    script.src = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${clean}&guid=${guid}&callback=${cbName}`;
    document.head.appendChild(script);
  });
}

async function lookupABN(abn) {
  const clean = abn.replace(/\s/g, '');
  if (clean.length !== 11 || !/^\d{11}$/.test(clean)) return null;
  if (abrCache[clean]) return abrCache[clean];

  const guid = document.getElementById('abr-guid')?.value.trim() || MEC_ABR_GUID_DEFAULT;
  if (!guid) return null;

  try {
    const data = await abrJsonpLookup(clean, guid);

    if (data.Message && /not a valid ABN|no record/i.test(data.Message)) return null;

    const entityTypeCode = data.EntityTypeCode || '';
    const entityTypeDesc = data.EntityTypeName || '';
    // "Not a sole trader" for super purposes — companies, partnerships (PTR) and trusts.
    // Super is withheld only from sole traders/individuals (IND), so PTR is included here.
    const compCodes = ['PRV','PUB','LTD','LTDP','NLP','CCIV','PTR',
                       'DTT','DIT','FXT','HYT','FUT','CUT','PUT','SMF','ARF','APF'];
    const isCompany = compCodes.includes(entityTypeCode);

    const isActive = (data.AbnStatus || '').toLowerCase() === 'active';
    // GST: Gst field is the GST-registered-from date; empty string means not registered
    const isGST = !!(data.Gst && data.Gst.trim() !== '' && data.Gst.trim() !== '');

    // JSON API returns EntityName for companies; for individuals it may be blank
    // Business names array is a fallback
    let entityName = (data.EntityName || '').trim();
    if (!entityName && data.BusinessName && data.BusinessName.length)
      entityName = data.BusinessName[0];

    const result = { clean, isCompany, isGST, isActive, entityName, entityTypeCode, entityTypeDesc };
    abrCache[clean] = result;
    return result;
  } catch(e) {
    console.warn('ABR lookup error:', e);
    return null;
  }
}

async function doABNLookup(id) {
  const abnInput = document.getElementById('abn-' + id);
  const statusEl = document.getElementById('match-' + id);
  if (!abnInput || !statusEl) return;

  const raw = abnInput.value.trim();
  const clean = raw.replace(/\s/g, '');

  if (!clean) { statusEl.innerHTML = '<span class="badge badge-warn">No ABN</span>'; return; }
  if (clean.length !== 11 || !/^\d{11}$/.test(clean)) {
    statusEl.innerHTML = '<span class="badge badge-warn">Invalid ABN</span>'; return;
  }
  const guid = document.getElementById('abr-guid')?.value.trim();
  if (!guid) {
    statusEl.innerHTML = '<span class="badge badge-warn">Need GUID ↑</span>'; return;
  }

  statusEl.innerHTML = '<span style="color:#888;font-size:12px"><span class="spinner"></span> Looking up…</span>';

  const r = await lookupABN(clean);
  if (!r) { statusEl.innerHTML = '<span class="badge badge-warn">Lookup failed</span>'; return; }
  if (!r.isActive) { statusEl.innerHTML = '<span class="badge badge-warn">ABN cancelled</span>'; return; }

  // Store ABR result for this row (used in processInvoices as fallback)
  abrRowData['id_' + id] = r;

  const typeGuess = r.isCompany ? (r.isGST ? 'D' : 'C') : (r.isGST ? 'B' : 'A');
  const icon = r.isCompany ? '🏢' : '👤';
  const gstLabel = r.isGST ? '<span style="color:var(--green)">GST ✓</span>' : '<span style="color:#888">No GST</span>';
  statusEl.innerHTML = `<span style="font-size:11px;line-height:1.4">${icon} ${r.entityName||'Found'}<br>${gstLabel} → <strong>Type ${typeGuess}</strong></span>`;
}

// Restore saved GUID on load (falls back to embedded default)
const MEC_ABR_GUID_DEFAULT = '2284311b-d375-4d27-b5a2-d5c93a7a9a48';
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('abrGuid') || MEC_ABR_GUID_DEFAULT;
  const el = document.getElementById('abr-guid');
  if (el && saved) { el.value = saved; }
});

// Drag & drop
['zoho-drop', 'contractors-json-drop', 'pdf-drop', 'bookings-drop-zone'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', e => {
    e.preventDefault(); el.classList.remove('drag-over');
    if (id === 'contractors-json-drop') {
      const file = e.dataTransfer.files[0];
      if (file) {
        const dt = new DataTransfer(); dt.items.add(file);
        document.getElementById('contractors-json-file').files = dt.files;
        handleContractorsJsonFile(document.getElementById('contractors-json-file'));
      }
    } else if (id === 'zoho-drop') {
      const file = e.dataTransfer.files[0];
      if (file) {
        const dt = new DataTransfer(); dt.items.add(file);
        document.getElementById('zoho-file').files = dt.files;
        handleZohoFile(document.getElementById('zoho-file'));
      }
    } else if (id === 'pdf-drop') {
      const files = e.dataTransfer.files;
      if (files && files.length) {
        const dt = new DataTransfer();
        Array.from(files).forEach(f => { if (f.type === 'application/pdf') dt.items.add(f); });
        if (dt.files.length) {
          document.getElementById('pdf-files').files = dt.files;
          handlePDFs(document.getElementById('pdf-files'));
        }
      }
    } else if (id === 'bookings-drop-zone') {
      const file = e.dataTransfer.files[0];
      if (file) {
        const dt = new DataTransfer(); dt.items.add(file);
        document.getElementById('bookings-file').files = dt.files;
        handleBookingsFile(document.getElementById('bookings-file'));
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 2: Invoice Input
// ══════════════════════════════════════════════════════════════════════════════
function switchTab(tab) {
  document.getElementById('tab-pdf').classList.toggle('active', tab==='pdf');
  document.getElementById('tab-manual').classList.toggle('active', tab==='manual');
  document.getElementById('tab-gmail').classList.toggle('active', tab==='gmail');
  document.getElementById('pane-pdf').classList.toggle('hidden', tab!=='pdf');
  document.getElementById('pane-manual').classList.toggle('hidden', tab!=='manual');
  document.getElementById('pane-gmail').classList.toggle('hidden', tab!=='gmail');
  // Hide the PDF-tab sort control when Gmail is active (Gmail has its own sort)
  const bottomSort = document.getElementById('sort-select-bottom');
  if (bottomSort) bottomSort.closest('div[style*="margin-left:auto"]').style.visibility = (tab === 'gmail') ? 'hidden' : '';
  // Initialise GIS token client on first visit to Gmail tab
  if (tab === 'gmail' && !gmailTokenClient && typeof google !== 'undefined' && google.accounts) {
    gmailInit();
  }
}

// ── PDF processing ──
async function handlePDFs(input) {
  const files = Array.from(input.files);
  const list = document.getElementById('pdf-list');
  const tbody = document.getElementById('pdf-tbody');
  // Do NOT clear — append to existing batch so multiple uploads accumulate

  // Add a batch separator if there are already rows
  const existingCount = tbody.querySelectorAll('tr').length;
  if (existingCount > 0) {
    const sep = document.createElement('tr');
    sep.innerHTML = `<td colspan="8" style="background:#EDF2F7;color:#718096;font-size:11px;font-weight:600;padding:4px 10px;letter-spacing:0.5px">— New batch: ${files.length} invoice${files.length>1?'s':''} added below —</td>`;
    tbody.appendChild(sep);
  }

  for (const file of files) {
    const item = document.createElement('div');
    item.className = 'pdf-item';
    item.innerHTML = `<span class="name">📄 ${file.name}</span>
      <span class="pdf-status pdf-warn"><span class="spinner"></span> Reading…</span>`;
    list.appendChild(item);

    try {
      const data = await extractPDFData(file);
      item.querySelector('.pdf-status').className = 'pdf-status pdf-ok';
      item.querySelector('.pdf-status').textContent = '✓ Extracted';

      const id = 'pdf-' + Date.now() + Math.random();
      const match = matchContractor(data.name, data.abn);

      // ── Duplicate detection ────────────────────────────────────────
      // Flag if a row already exists with the same ABN + invoice number (or ABN + total + date)
      const dupWarning = checkDuplicate(data.abn, data.invoiceNumber, data.total, data.date);
      if (dupWarning) {
        item.querySelector('.pdf-status').className = 'pdf-status pdf-warn';
        item.querySelector('.pdf-status').textContent = '⚠ Possible duplicate — check below';
      }

      appendInvoiceRow(tbody, id, data, match, file.name, dupWarning);
      invoiceGSTData['id_' + id] = !!data.hasGST;
      invoicePaidData['id_' + id] = !!data.alreadyPaid;
      invoicePerfGuess['id_' + id] = !!data.perfDateGuess;
      invoiceTypeData['id_' + id] = data.invoiceTypeHint || 'unknown';
      // Pre-populate expense fields from PDF text detection (only if non-zero amounts found)
      if (data.detectedExpenses) {
        const de = data.detectedExpenses;
        if (de.parking > 0 || de.accommodation > 0 || de.travel > 0) {
          invoiceExpenseData['id_' + id] = { parking: de.parking, accommodation: de.accommodation, travel: de.travel };
        }
      }
      // Store object URL for PDF preview (revoke old if re-used)
      invoiceFileData['id_' + id] = URL.createObjectURL(file);
      // Store raw text for debug inspection (helps diagnose amount/name extraction failures)
      invoiceRawText['id_' + id] = data._rawText || '';
      // Auto-lookup ABN if extracted and GUID is set
      if (data.abn && document.getElementById('abr-guid')?.value.trim()) {
        doABNLookup(id);
      }
    } catch(e) {
      item.querySelector('.pdf-status').className = 'pdf-status pdf-warn';
      item.querySelector('.pdf-status').textContent = '⚠ Could not read — enter manually';
      const id = 'pdf-err-' + Date.now();
      appendInvoiceRow(tbody, id, {name:'', invoiceNumber:'', date:'', total:0}, null, file.name);
      // Still store PDF URL — Review modal will show the PDF so user can read & enter data manually
      invoiceFileData['id_' + id] = URL.createObjectURL(file);
    }
  }

  const totalRows = document.getElementById('pdf-tbody').querySelectorAll('tr[id]').length;
  document.getElementById('pdf-info').textContent =
    `${totalRows} PDF${totalRows>1?'s':''} processed (${files.length} just added). Review the extracted data below — edit any fields that look wrong before proceeding.`;
  document.getElementById('pdf-results').classList.remove('hidden');
  // Keep the drop zone generous after upload — it stays an easy target for adding more
  // invoices (e.g. a second batch you missed). Only a modest reduction, not a thin strip.
  const pdfDrop = document.getElementById('pdf-drop');
  if (pdfDrop) {
    pdfDrop.style.padding = '28px 20px';
    pdfDrop.style.minHeight = '110px';
    const icon = pdfDrop.querySelector('.icon');
    const labels = pdfDrop.querySelectorAll('.label');
    if (icon) { icon.style.display = ''; icon.style.fontSize = '32px'; icon.style.marginBottom = '6px'; }
    labels.forEach((l, i) => {
      if (i === 0) { l.style.display = ''; l.style.fontSize = '14px'; l.firstElementChild && (l.innerHTML = '<strong>Add more PDFs</strong> — click or drag &amp; drop'); }
      else { l.style.display = ''; l.style.fontSize = '11px'; l.style.marginTop = '3px'; }
    });
  }
  // Keep the uploaded-file list reasonably visible too
  const pdfListEl = document.getElementById('pdf-list');
  if (pdfListEl) pdfListEl.style.maxHeight = '120px';
  // Auto-sort A→Z by contractor name after each upload so duplicates cluster together
  sortInvoiceRows('name');
  updateProcessCount();
}

async function extractPDFData(file) {
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument(ab).promise;
  let text = '';
  for (let i = 1; i <= Math.min(pdf.numPages, 3); i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  const result = parseInvoiceText(text, file.name);
  result._rawText = text;  // preserve raw text for debug inspection
  return result;
}

function parseInvoiceText(text, filename) {
  const MEC_RE = /melbourne\s+entertainment|melbentco|mlebourne|92\s+rupert|pay\.melbentco|ent\s+co\s+pty|222\s+hoddle/i;

  // ── ABN ──────────────────────────────────────────────────────────────────
  // Helper: reject 11-digit numbers that look like Australian phone numbers
  // +61 4XX XXX XXX (mobile) → 614XXXXXXXX; +61 3XX XXXX XXXX (Vic landline) → 613XXXXXXXX
  const isPhoneABN = (n) => /^61[2-9]\d{8}$/.test(n);

  // ABN checksum (ATO algorithm) — used to safely accept BARE, unlabelled 11-digit ABNs
  // without grabbing random account/phone numbers.
  const isValidABN = (n) => {
    if (!/^\d{11}$/.test(n)) return false;
    const w = [10,1,3,5,7,9,11,13,15,17,19];
    let sum = 0;
    for (let i = 0; i < 11; i++) sum += (parseInt(n[i],10) - (i === 0 ? 1 : 0)) * w[i];
    return sum % 89 === 0;
  };

  // The contractor is the SENDER. Skip any ABN that belongs to MEC (the recipient) — it
  // typically appears right after the bill-to party, e.g. "To: Melbourne Entertainment
  // Company ABN: 45 627 873 644". We treat an ABN as MEC's if MEC appears in the ~60 chars
  // before it. (Different contractors write different/incorrect MEC ABNs, so a context check
  // is more reliable than a hard-coded number.)
  const isRecipientABN = (idx) => MEC_RE.test(text.slice(Math.max(0, idx - 60), idx));

  let abn = '';
  // Strategy 1: explicitly labelled "ABN: NNN" or "ABN - NNN" (most reliable)
  // Allow dash separator: "ABN - 92 386 967 408"
  for (const m of text.matchAll(/\bABN\b[:\-\s]+(\d[\d\s]{9,14}\d)/gi)) {
    const candidate = m[1].replace(/\s/g,'');
    if (candidate.length !== 11 || isPhoneABN(candidate)) continue;
    if (isRecipientABN(m.index)) continue;   // MEC's ABN, not the contractor's
    abn = candidate;
    break;
  }
  // Strategy 2: space-formatted ABN "XX XXX XXX XXX" — but not near phone/mobile keywords
  if (!abn) {
    for (const m of text.matchAll(/\b(\d{2}\s\d{3}\s\d{3}\s\d{3})\b/g)) {
      const candidate = m[1].replace(/\s/g,'');
      // Reject if preceded by phone/mobile context within 50 chars
      const before = text.slice(Math.max(0, m.index - 50), m.index);
      if (/phone|mobile|mob|tel|fax|\+61/i.test(before)) continue;
      if (isPhoneABN(candidate)) continue;
      if (isRecipientABN(m.index)) continue;   // MEC's ABN, not the contractor's
      abn = candidate;
      break;
    }
  }
  // Strategy 3: scan up to 200 chars after any "ABN" keyword for a standalone 11-digit number
  // Handles columnar layouts like "ABN  MEC  Emily Lawson  96471761158"
  if (!abn) {
    for (const m of text.matchAll(/\bABN\b/gi)) {
      if (isRecipientABN(m.index)) continue;   // MEC's ABN, not the contractor's
      const window = text.slice(m.index, m.index + 200);
      // Try compact 11-digit run
      const compact = window.replace(/\s/g,'').match(/ABN[-:]?(\d{11})/i);
      if (compact && !isPhoneABN(compact[1])) { abn = compact[1]; break; }
      // Try standalone 11-digit number (not part of a larger run)
      const standalone = window.match(/\b(\d{11})\b/);
      if (standalone && !isPhoneABN(standalone[1])) { abn = standalone[1]; break; }
    }
  }
  // Strategy 4: bare, unlabelled 11-digit ABN (no "ABN" keyword, no spacing). Accept only if it
  // passes the ABN checksum, isn't phone-shaped, and isn't MEC's (recipient). Handles invoices
  // that print the payee's ABN as a plain number under their name — e.g. Heidi Milne:
  // "Heidi Milne 32365862556".
  if (!abn) {
    for (const m of text.matchAll(/\b(\d{11})\b/g)) {
      const cand = m[1];
      if (isPhoneABN(cand) || !isValidABN(cand)) continue;
      if (isRecipientABN(m.index)) continue;   // MEC's ABN, not the contractor's
      abn = cand;
      break;
    }
  }

  // ── Name ─────────────────────────────────────────────────────────────────
  let name = '';

  // Strategy 0a: "NAME: Firstname Lastname" but NOT "Account Name:" or "Business Name:" etc.
  // Handles invoices that have a standalone "NAME: ..." field (some contractor invoice templates)
  const nameLabelM = text.match(/(?<![A-Za-z])NAME\s*:\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){1,3})/);
  if (nameLabelM && !MEC_RE.test(nameLabelM[1])) name = nameLabelM[1].trim();

  // Strategy 0c: explicit "For: [optional noise] Firstname Lastname"
  // Handles "For: DJ Service Daniel Dartnell" → "Daniel Dartnell"
  if (!name) {
    const forM = text.match(
      /\bFor\s*:\s*(?:(?:DJ|MC|Band|Music|Audio|Service|Live|Sound|Photography)\s+){0,3}([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/
    );
    if (forM && !MEC_RE.test(forM[1])) name = forM[1].trim();
  }

  // Declared at function scope so Strategy A3 (below) can reference them even when the
  // block that populates them doesn't run. (Previously block-scoped here, which threw
  // "billIdx is not defined" in A3 whenever all earlier name strategies failed — aborting
  // the entire parse and leaving the row blank with no extracted text.)
  let billIdx = -1;
  let sender = '';
  // STRAT_A_REJECT is used by both Strategy A (in this block) and Strategy A3 (later, outside
  // this block), so it must live at function scope too.
  const STRAT_A_REJECT = /^(Tax|Invoice|Receipt|Payment|Statement|Amount|Enclosed|Remittance|Description|Quantity|Service|Booking)/i;
  if (!name) {
    // Find sender section = text before "Bill To:", "BILL TO", "Attention:", "To:" etc.
    billIdx = text.search(/\b(?:Bill\s+[Tt]o|Bill\s*:|Attention\s*:|Issued\s+[Tt]o|Pay(?:able)?\s+[Tt]o\s*:(?!\s*\d))\b/i);
    sender = billIdx > 0 ? text.slice(0, billIdx).trim() : text.slice(0, 400);
    // Strip "To: ..." recipient prefix if it leads the sender block
    sender = sender.replace(/^\s*To\s*:.*/, '').trim();

    // Strategy A: proper-case name right at start of sender section (handles "Cormack-Brown")
    const nameA = sender.match(/^([A-Z][a-z]+(?:[-][A-Z][a-z]+)?(?:\s+[A-Z][a-z]+(?:[-][A-Z][a-z]+)?){1,3})/);
    if (nameA && !MEC_RE.test(nameA[1]) && !STRAT_A_REJECT.test(nameA[1])) name = nameA[1];

    if (!name) {
      // Strategy B: all-caps company name at start of sender section
      const CAPS_STOP = new Set(['TAX','INVOICE','BILL','RECEIPT','DATE','GST','ABN','TOTAL',
        'SUBTOTAL','PAYMENT','FOR','TO','FROM','UNIT','STREET','ROAD','AVENUE','DRIVE',
        'COURT','CLOSE','PLACE','LANE','DIRECT','BANK','BSB','ACCOUNT','NUMBER',
        'AMOUNT','ENCLOSED','REMITTANCE','ADVICE','DESCRIPTION','QUANTITY','SERVICE',
        'BOOKING','EVENT','ENTERTAINMENT','PHOTOGRAPHY','MUSIC','VIDEO']);
      const capsWords = [];
      for (const w of sender.trim().split(/\s+/)) {
        const clean = w.replace(/[^A-Z]/g,'');
        if (clean.length >= 2 && clean === w.toUpperCase().replace(/\./g,'')) {
          if (!CAPS_STOP.has(clean)) capsWords.push(w);
          else break;
        } else {
          if (capsWords.length) break;
        }
      }
      if (capsWords.length >= 2) name = capsWords.join(' ');
    }
  }

  // Strategy C: PTY LTD registered company name anywhere in text
  // Handles "JAZZ TO ROCK ENTERTAINMENT PTY. LTD." appearing in payment section
  if (!name) {
    const ptyM = text.match(/\b([A-Z]{2,}(?:\s+[A-Z]{2,}){1,6}\s+PTY\.?\s*LTD\.?)/);
    if (ptyM && !MEC_RE.test(ptyM[1])) name = ptyM[1].trim().replace(/\.?\s*$/, '');
  }

  // Strategy D: near-ABN fallback — sender's name often appears right before their ABN
  // Tries LAST ABN occurrence first (payment/sender block), then FIRST ABN occurrence
  if (!name && abn) {
    const GEO_STOP = /\b(Victoria|Queensland|South\s+Australia|New\s+South\s+Wales|Western\s+Australia|Northern\s+Territory|Tasmania|Vic|Qld|NSW|WA|SA|NT|ACT|TAS|Street|Road|Avenue|Drive|Court|Grove|Lane|Place|Crescent|Boulevard|Close|Way|Australia|Melbourne|Sydney|Brisbane|Perth|Adelaide|Hobart|Darwin|Hill|Park|Bay|Valley|North|South|East|West|Central|Gate|Floor|Level|Suite)\b/i;
    const GENERIC_STOP_D = /^(Tax|Invoice|Receipt|Payment|Statement|From|Sender|Payee|Memo|Note|Dear|Hello|Hi|To|Attention|Re|Grand|Total|Subtotal|Due|Date|Please|Direct|Bank|Transfer|Cash|Amount|Enclosed|Description|Quantity|Unit|Price|Service|Booking|Event|Music|Photography|Video|Entertainment|Remittance|Advice|Cheque|Number|Reference|Ref|Credit|Financial|National|Union)$/i;
    const BANK_CTX = /\b(BSB|bsb|bank|account|deposit|transfer|credit\s+union|eft|payment)\b/i;
    const tryExtractNearABN = (pos) => {
      if (pos <= 30) return '';
      const priorText = text.slice(Math.max(0, pos - 300), pos);
      const candidates = [...priorText.matchAll(/([A-Z][a-zA-Z]{1,20}(?:\s+[A-Z][a-zA-Z]{1,20}){1,3})\b/g)];
      for (let i = candidates.length - 1; i >= 0; i--) {
        const c = candidates[i][1].trim();
        const words = c.split(/\s+/);
        if (words.length < 2) continue;
        if (MEC_RE.test(c)) continue;
        if (GEO_STOP.test(c)) continue;
        if (words.some(w => GENERIC_STOP_D.test(w))) continue;
        if (!words.every(w => /^[A-Z]/.test(w))) continue;
        // Reject if candidate appears within a banking/payment details block
        const ctx = priorText.slice(Math.max(0, candidates[i].index - 100), candidates[i].index);
        if (BANK_CTX.test(ctx)) continue;
        return c;
      }
      return '';
    };
    // Find ALL ABN keyword positions and try last first (payment section = more likely to be contractor)
    const allAbnMatches = [...text.matchAll(/\bABN\b/gi)];
    for (let ai = allAbnMatches.length - 1; ai >= 0; ai--) {
      const candidate = tryExtractNearABN(allAbnMatches[ai].index);
      if (candidate) { name = candidate; break; }
    }
    // Also try at the position of the ABN digit run itself — catches columnar layouts
    // where the ABN number appears far from the "ABN" keyword (e.g. "ABN  [name1]  [name2]  96471761158")
    if (!name) {
      const abnDigitIdx = text.indexOf(abn);
      if (abnDigitIdx > 30) {
        const candidate = tryExtractNearABN(abnDigitIdx);
        if (candidate) name = candidate;
      }
    }
  }

  // Strategy E: "Payable to:" / "Pay to:" — some invoices label the recipient with this
  if (!name) {
    const payToM = text.match(/(?:Pay(?:able)?\s+to|Remit\s+to)\s*:\s*([A-Z][a-zA-Z '&]{2,50}?)(?:\s+ABN|\s+\d{2}|\s+Ph|\s*$)/i);
    if (payToM && !MEC_RE.test(payToM[1])) name = payToM[1].trim();
  }

  // Strategy F: FROM-label — "FROM [Name]" or "FROM\n[Name]" layout (e.g. Hikari Photography)
  if (!name) {
    const fromM = text.match(/\bFROM\b[\s\r\n:]+([A-Za-z][a-zA-Z0-9 '&.-]{2,60}?)(?:\s{2,}|\s+ABN|\s+Phone|\s+Mobile|\s+Email|\s*$)/i);
    if (fromM) {
      const candidate = fromM[1].trim();
      if (!MEC_RE.test(candidate)
          && !/^(Tax\s+Invoice|Invoice|Receipt|Phone|Mob|Email|ABN|Address|Tel|Fax|www\.|http)/i.test(candidate)) {
        name = candidate;
      }
    }
  }

  // Strategy A3: scan sender section for first non-metadata title-case name
  // Handles modern invoice formats (Xero, Stripe, etc.) where the sender name appears after
  // invoice headers: "Page 1 of 1  Invoice  Invoice number  XXXX  Date…  [SENDER NAME]  address"
  // Only applied when billIdx properly bounded the sender section (avoids false positives on full text)
  if (!name && billIdx > 0) {
    const META_SKIP_A3 = /^(?:Page\s+\d|Invoice|Tax\s+Invoice|Invoice\s+Number|Invoice\s+No|Date\s+of\s+Issue|Date\s+Due|Due\s+Date|Date\s+Issued|Issued\s+Date|Reference|GST|ABN|BSB|Account|Payment|Bill|Description|Qty|Quantity|Total|Subtotal|Tax|Amount|Ref|Receipt)/i;
    const senderTokens = sender.split(/\s{2,}|\n/);
    for (const token of senderTokens) {
      const t = token.trim();
      if (!t || t.length < 4) continue;
      const firstWord = t.split(/\s+/)[0];
      if (META_SKIP_A3.test(firstWord)) continue;
      if (STRAT_A_REJECT.test(firstWord)) continue;
      // Title-case multi-word name (e.g. "The Harp Lab")
      const m = t.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
      if (m && !MEC_RE.test(m[1])) { name = m[1].trim(); break; }
    }
  }

  // Strategy H: all-caps sender name near end of document
  // Some informal invoices (especially handwritten-style) put the sender name in all-caps at the bottom
  // e.g. "FINN   BRUNNING" at the very end of the invoice
  if (!name) {
    const CAPS_STOP_H = new Set(['TAX','INVOICE','BILL','RECEIPT','DATE','GST','ABN','TOTAL',
      'SUBTOTAL','PAYMENT','FOR','TO','FROM','UNIT','STREET','ROAD','AVENUE','DRIVE',
      'COURT','CLOSE','PLACE','LANE','DIRECT','BANK','BSB','ACCOUNT','NUMBER',
      'AMOUNT','ENCLOSED','REMITTANCE','ADVICE','DESCRIPTION','QUANTITY','SERVICE',
      'BOOKING','EVENT','ENTERTAINMENT','PHOTOGRAPHY','MUSIC','VIDEO','INVOICE']);
    const tailText = text.slice(-300);
    for (const m of [...tailText.matchAll(/\b([A-Z]{2,}(?:\s+[A-Z]{2,}){1,3})\b/g)].reverse()) {
      const raw = m[1].trim();
      const words = raw.split(/\s+/).filter(w => w.length >= 2 && !CAPS_STOP_H.has(w));
      if (words.length < 2) continue;
      const candidate = words.map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
      if (!MEC_RE.test(candidate)) { name = candidate; break; }
    }
  }

  // Strategy G: filename fallback (often has performer name e.g. "20260503_One Plus One Invoice.pdf")
  if (!name) {
    // Remove date prefix (YYYYMMDD_ or YYYY-MM-DD_), extension, underscores/dashes → spaces
    let fn = filename.replace(/\.(pdf)$/i,'').replace(/^\d{6,8}[_\-\s]+/, '').replace(/[_\-]/g,' ').trim();
    // Strip trailing invoice-related keywords
    fn = fn.replace(/\s+(Invoice|Tax Invoice|Bill|Receipt|Payment|Statement|INV[-\s]?\d*)$/i, '').trim();
    const fnM = fn.match(/([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}))+)/);
    if (fnM && !MEC_RE.test(fnM[1])) name = fnM[1].trim();
    // If still no match, try simpler: any 2+ word title-cased sequence
    if (!name) {
      const fnM2 = fn.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)/);
      if (fnM2 && !MEC_RE.test(fnM2[1])) name = fnM2[1].trim();
    }
  }

  // Strategy H2 (last resort): bank "Account Name:" — for invoices with no sender-name header
  // and no usable filename, the payee name in the bank block is often the only place the
  // contractor is named (e.g. "Payable To: Account Name: Ricardo Ferrao" → "Ricardo Ferrao").
  // Runs AFTER the filename fallback so it never overrides a cleaner name; truncates at the
  // bank-name words that follow it in payment blocks (e.g. "...National Australia Bank").
  if (!name) {
    const acctNameM = text.match(/Account\s*Name\s*[:\-]?\s*([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){1,2})/i);
    if (acctNameM) {
      const candidate = acctNameM[1].trim().replace(
        /\s+\b(National|Australia|Commonwealth|Westpac|ANZ|NAB|Bendigo|Bankwest|Suncorp|Macquarie|ING|Bank|BSB|Account|Acc|Number|No|ABN|Pay|For|Date|Reference)\b.*$/i, ''
      ).trim();
      const words = candidate.split(/\s+/);
      if (candidate && !MEC_RE.test(candidate) && words.length >= 2 && words.length <= 4) name = candidate;
    }
  }

  // Final: strip trailing noise words from any extracted name
  // e.g. "Jake Fehily Invoice" → "Jake Fehily", "Olivia Bradbury AD" → "Olivia Bradbury"
  if (name) {
    name = name.replace(/\s+\b(Invoice|Tax|Receipt|Payment|Statement|Bill|Advice|Services?|Group|Pty|Ltd|Inc|Co|Corp|And|Or|The|An?|Of|For|By|At|Amount|Enclosed|Description|Ref|Reference|Number|Booking|Event|Photography|Music|Video|Entertainment|AD|ID|No|Num)\b\.?$/i, '').trim();
    // Reject if the whole thing is a generic heading
    if (/^(Tax\s+Invoice|TAX\s+INVOICE|Invoice\s*(?:#|No\.?|Number)?|Receipt|Payment\s+Advice|Statement|Amount\s+Enclosed|Remittance\s+Advice)$/i.test(name)) {
      name = '';
    }
  }

  // ── Invoice number ───────────────────────────────────────────────────────
  let invoiceNumber = '';
  // Primary: "Invoice No: 123" or "Invoice Number: INV-001" (requires explicit qualifier)
  // Allow spaced digits (PDF artifact): "Invoice no: 0 10" → "010"
  const invM = text.match(/invoice\s+(?:no\.?|number|#|num|id)\s*:?\s*([A-Z]{0,4}[-]?\d[\d\s\w\-]{0,14})/i);
  if (invM && invM[1]) {
    const raw = invM[1].trim();
    const tokens = raw.split(/\s+/);
    let stripped;
    // If first token has mixed letters+digits (template code like "O5V1TVAO") and last token is
    // purely numeric, take only the trailing number (e.g. "O5V1TVAO 0018" → "0018")
    if (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length-1])
        && /[A-Za-z]/.test(tokens[0]) && /\d/.test(tokens[0]) && tokens[0].length >= 4) {
      stripped = tokens[tokens.length - 1];
    } else {
      // Take the leading token, then merge only PURE-DIGIT continuations (handles PDF-split
      // numbers like "0 10" → "010"). Stop at the first token containing a letter — that's the
      // next field bleeding in (e.g. "011 Issue date" → "011", "INV-9140620 Invoice" → "INV-9140620").
      const parts = [tokens[0]];
      for (let k = 1; k < tokens.length; k++) {
        if (/^\d+$/.test(tokens[k])) parts.push(tokens[k]); else break;
      }
      stripped = parts.join('');
    }
    if (!/^(date|due|to|from|for|of|the|is|a|an|and)\b/i.test(stripped)) invoiceNumber = stripped;
  }
  // Fallback: "Tax Invoice 1234" or "Tax Invoice INV-3240"
  if (!invoiceNumber) {
    const taxInvM = text.match(/[Tt]ax\s+[Ii]nvoice\s+([A-Z]{0,4}[-]?\d[\w\-]{0,14})/);
    if (taxInvM && !/^\d{4}[-\/]\d{2}/.test(taxInvM[1])) invoiceNumber = taxInvM[1].trim(); // skip dates
  }
  // Fallback: bare "INVOICE 246" or "INVOICE 0036" — no qualifier word
  // Catches invoices like Kim Calapardo's that print just "INVOICE [number]"
  if (!invoiceNumber) {
    const bareInvM = text.match(/\bINVOICE\s+([A-Z]{0,4}[-]?\d[\w\-]{0,14})\b/i);
    if (bareInvM) {
      const v = bareInvM[1].trim();
      // Skip if it looks like a date (17/05/2026 → "17" alone won't reach here, but be safe)
      if (!/^\d{4}[-\/]\d{2}/.test(v) && !/^\d{1,2}[\/\-\.]\d{2}/.test(v)) {
        invoiceNumber = v;
      }
    }
  }
  // Fallback: "Invoice ID: HIK24-0522" style
  if (!invoiceNumber) {
    const invIdM = text.match(/Invoice\s+ID\s*:\s*([^\s\r\n]{3,20})/i);
    if (invIdM) invoiceNumber = invIdM[1].trim();
  }
  // Fallback: "INV-3240" or "INV3240" standalone token
  if (!invoiceNumber) {
    const invStandaloneM = text.match(/\b(INV[-]?\d{3,})\b/i);
    if (invStandaloneM) invoiceNumber = invStandaloneM[1].toUpperCase();
  }
  // Fallback: "Reference No. 082" / "Reference Number: 082" / "Reference No\n082"
  // Allow space, period, colon or newline as separator (e.g. "Reference No. 082")
  // Skip booking-reference-style codes like "KC-246" (2-3 caps + hyphen + 2-4 digits) —
  // these are MEC's internal payment references written onto contractor invoices, not invoice numbers.
  if (!invoiceNumber) {
    const refM = text.match(/Reference\s+(?:No\.?|Number|#)\s*[\s:.\r\n]+([A-Za-z0-9][\w\-]{0,20})/i);
    if (refM) {
      const refVal = refM[1].trim();
      if (!/^[A-Z]{2,3}-\d{2,4}$/i.test(refVal)) invoiceNumber = refVal;
    }
  }
  // Fallback: "Inv: 2026011" — short "Inv:" prefix without qualifier word
  if (!invoiceNumber) {
    const invColonM = text.match(/\bInv\s*:\s*([A-Za-z0-9][\w\-]{0,20})/i);
    if (invColonM) invoiceNumber = invColonM[1].trim();
  }
  // Fallback: "TAX INVOICE#2224" or "INVOICE#NNN" — hash directly attached to INVOICE keyword
  if (!invoiceNumber) {
    const taxInvHash = text.match(/\bINVOICE#\s*([A-Z0-9][\w\-]{0,15})\b/i);
    if (taxInvHash) invoiceNumber = taxInvHash[1].trim();
  }
  // Fallback: "# 38" or "#INV-001" near top OR bottom of invoice (min 2 chars after #)
  if (!invoiceNumber) {
    const hashM = text.slice(0,600).match(/#\s*([A-Z0-9][\w\-]{1,15})\b/i)
               || text.slice(-400).match(/#\s*([A-Z0-9][\w\-]{1,15})\b/i);
    if (hashM) invoiceNumber = hashM[1].trim();
  }
  // Final fallback: "Invoice 0204" or "Invoice 020 4" at end of document
  // Handles invoices that put their number on the last line with no qualifier word
  if (!invoiceNumber) {
    const endInvM = text.slice(-400).match(/\bInvoice\b\s+(\d[\d\s]{0,8})\s*$/im);
    if (endInvM) invoiceNumber = endInvM[1].trim().replace(/\s+/g, '');
  }

  // ── Date normalisation: collapse spaces around AND inside date sequences (PDF artifact) ──
  // pdf.js often splits dates like "17 / 0 5 /202 6" or "16 / 0 5 /202 6". First de-space whole
  // date-shaped runs (two separators), then tidy any remaining spaces around separators.
  // Requires two /-. separators, so ABNs/account numbers (no double separator) are untouched.
  text = text.replace(/\b\d(?:\s?\d)?\s*[\/\-.]\s*\d(?:\s?\d)?\s*[\/\-.]\s*\d(?:\s?\d){1,3}\b/g, m => m.replace(/\s+/g, ''));
  text = text.replace(/(\d)\s*\/\s*(\d)/g, '$1/$2');

  // ── Date (prefer "Invoice Date:" label; handle 2-digit years) ────────────
  let date = '';
  function parseDate(d, mo, y) {
    if (!d || !mo || !y) return '';
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  const invDateM = text.match(/(?:invoice\s*date|date\s*issued|issue\s*date)[:\s]+(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/i);
  if (invDateM) date = parseDate(invDateM[1], invDateM[2], invDateM[3]);
  if (!date) {
    // "Date: DD/MM/YY" — plain date label (e.g. Liv Bradbury Photography)
    const dateOnlyM = text.match(/\bDate\s*:\s*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/i);
    if (dateOnlyM) date = parseDate(dateOnlyM[1], dateOnlyM[2], dateOnlyM[3]);
  }
  if (!date) {
    // First numeric date that is NOT a Due date (so "Due 11/05/2026" doesn't masquerade as the
    // issue date — e.g. Freya Boltman, where the real issue date is the worded "3 May 2026").
    for (const m of text.matchAll(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g)) {
      if (/\bdue\b[^\d]{0,12}$/i.test(text.slice(Math.max(0, m.index - 14), m.index))) continue;
      if (+m[1] > 31 || +m[2] > 12) continue;
      date = parseDate(m[1], m[2], m[3]); break;
    }
  }
  if (!date) {
    const d2 = text.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})\b/i);
    if (d2) {
      const mn = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
      date = `${d2[3]}-${mn[d2[2].toLowerCase().slice(0,3)]}-${d2[1].padStart(2,'0')}`;
    }
  }

  // ── Total (never match "Subtotal") ───────────────────────────────────────
  let total = 0;
  const totals = [];
  // Pattern 1: "TOTAL ... $X.XX" or "TOTAL AUD X.XX" (decimal amounts)
  for (const m of text.matchAll(/(?<![Ss]ub)[Tt][Oo][Tt][Aa][Ll][^A-Za-z\d]{0,30}?(?:\$|AUD\s*\$?)\s*(\d[\d,]*\.\d{2})/g)) {
    totals.push(parseFloat(m[1].replace(/,/g,'')));
  }
  for (const m of text.matchAll(/(?<![Ss]ub)[Tt]otal\s*\$\s*(\d[\d,]*\.\d{2})/g)) {
    totals.push(parseFloat(m[1].replace(/,/g,'')));
  }
  // Pattern 1b: comma-formatted total no decimal (e.g. "Total $3,300" or "TOTAL AUD 3,300")
  for (const m of text.matchAll(/(?<![Ss]ub)[Tt][Oo][Tt][Aa][Ll][^A-Za-z\d]{0,30}?(?:\$|AUD\s*\$?)?\s*(\d{1,3}(?:,\d{3})+)\b(?![.\d])/g)) {
    const val = parseFloat(m[1].replace(/,/g,''));
    if (val >= 100) totals.push(val);
  }
  // Pattern 1c: "TOTAL ... $ NN NN .NN" — PDF text extraction splits numbers with spaces
  // e.g. "Total $ 3 00 .00" → $300.00
  for (const m of text.matchAll(/(?<![Ss]ub)[Tt][Oo][Tt][Aa][Ll][^A-Za-z\d]{0,40}?\$\s*(\d+)\s+(\d{2,3})\s*\.\s*(\d{2})\b/g)) {
    const val = parseFloat(`${m[1]}${m[2]}.${m[3]}`);
    if (val >= 1) totals.push(val);
  }
  // Pattern 1d: "TOTAL ... $ NN NN" — spaced whole dollar, no decimal e.g. "Total $ 33 00" → $3300.
  // Guard: only concatenate when the FIRST group is 1–2 digits (a true split prefix). A 3+ digit
  // first group like "$450" is already a complete amount — gluing a trailing "17" wrongly made 45017.
  for (const m of text.matchAll(/(?<![Ss]ub)[Tt][Oo][Tt][Aa][Ll][^A-Za-z\d]{0,40}?\$\s*(\d+)\s+(\d{2,3})\b(?!\s*[.,\d])/g)) {
    if (m[1].length > 2) continue;
    const val = parseFloat(`${m[1]}${m[2]}`);
    if (val >= 10) totals.push(val);
  }
  // Pattern 2: "TOTAL- $190", "TOTAL $190", "TOTAL: $1000" (whole dollars, handwritten/simple
  // invoices). Allow colon/dash/space between TOTAL and the amount.
  for (const m of text.matchAll(/(?<![Ss]ub)TOTAL[-:\s]*\$\s*(\d{2,})\b(?![.\d])/gi)) {
    const val = parseFloat(m[1]);
    if (val >= 10) totals.push(val);
  }
  // Pattern 2b: letter-spaced "(GRAND) TOTAL" labels (PDF artifact, e.g. Queen of Hearts prints
  // "T O T A L :  $ 1000"). De-space first, then match a $-amount after the TOTAL/GRAND TOTAL label.
  {
    const ds = despaceText(text);
    for (const m of ds.matchAll(/(?<![Ss]ub)(?:GRAND\s+)?TOTAL[-:\s]*\$\s*(\d[\d,]*(?:\.\d{2})?)\b/gi)) {
      const val = parseFloat(m[1].replace(/,/g,''));
      if (val >= 10) totals.push(val);
    }
  }
  // Pattern 3: "Balance due $X.XX" / "Amount due $X.XX" where > $0 (what's actually owed)
  for (const m of text.matchAll(/(?:Balance\s+due|Amount\s+due)[:\s]*\$?\s*([\d,]+\.\d{2})/gi)) {
    const val = parseFloat(m[1].replace(/,/g,''));
    if (val > 0) totals.push(val);
  }
  // Pattern 3b: "Balance due $ NN NN .NN" — spaced decimal (PDF artifact)
  // e.g. "Balance Due $ 3 00 .00" → $300.00
  for (const m of text.matchAll(/(?:Balance\s+due|Amount\s+due)[:\s]*\$?\s*(\d+)\s+(\d{2,3})\s*\.\s*(\d{2})\b/gi)) {
    const val = parseFloat(`${m[1]}${m[2]}.${m[3]}`);
    if (val > 0) totals.push(val);
  }
  // Pattern 3c: "Balance due $ NN NN" — spaced whole dollar (PDF artifact)
  for (const m of text.matchAll(/(?:Balance\s+due|Amount\s+due)[:\s]*\$?\s*(\d+)\s+(\d{2,3})\b(?!\s*[.,\d])/gi)) {
    if (m[1].length > 2) continue;
    const val = parseFloat(`${m[1]}${m[2]}`);
    if (val > 0) totals.push(val);
  }
  if (totals.length) {
    total = Math.max(...totals);
  } else {
    // Fallback A: largest dollar amount ≥ $10 with decimal places
    const amounts = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)]
      .map(m => parseFloat(m[1].replace(/,/g,'')))
      .filter(n => n >= 10);
    if (amounts.length) total = Math.max(...amounts);
  }
  if (!total) {
    // Fallback B: whole dollar amounts ≥ $10 (e.g. "$190" with no cents)
    const wholeAmounts = [...text.matchAll(/\$\s*(\d{2,})\b(?![.\d])/g)]
      .map(m => parseFloat(m[1]))
      .filter(n => n >= 10 && n < 1000000); // sanity bounds
    // Fallback B2: comma-formatted amounts with no decimal (e.g. "$3,300")
    const commaAmounts = [...text.matchAll(/\$\s*(\d{1,3}(?:,\d{3})+)\b(?![.\d])/g)]
      .map(m => parseFloat(m[1].replace(/,/g,'')))
      .filter(n => n >= 100 && n < 10000000);
    const allWhole = [...wholeAmounts, ...commaAmounts];
    if (allWhole.length) total = Math.max(...allWhole);
  }

  // ── GST detection — did the invoice explicitly charge GST? ─────────────────
  // Catches: "GST $30.00", "GST 10%", "INCLUDES GST", "Tax 10%", "10% Tax $150"
  const gstAmt = text.match(/\bGST\b[^$\d]{0,10}\$?\s*([\d,]+\.\d{2})/i);
  const hasExplicitGSTAmount = gstAmt && parseFloat(gstAmt[1].replace(/,/g,'')) > 0;
  const hasGSTLabel = /(?:includes?\s+gst|gst\s*10(?:\.0)?\s*%|tax\s*10(?:\.0)?\s*%|10\s*%\s*(?:tax|gst))/i.test(text);
  // GST-by-arithmetic: columnar templates (e.g. INV12245) detach the "Total GST $X" label from
  // its amount, so the adjacency patterns above miss it. If the invoice mentions GST AND there
  // exist amounts sub / gst / grand with gst ≈ sub×10% and sub+gst ≈ grand, GST was charged.
  let gstArith = false;
  if (/\bGST\b/i.test(text)) {
    const cents = [...new Set(
      [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)]
        .map(m => Math.round(parseFloat(m[1].replace(/,/g,'')) * 100))
        .filter(c => c > 0)
    )];
    const near = (c, t) => cents.some(x => Math.abs(x - t) <= 1);
    for (const sub of cents) {
      if (sub < 5000) continue;                 // subtotal ≥ $50
      const gst = Math.round(sub * 0.10);
      if (near(cents, gst) && near(cents, sub + gst)) { gstArith = true; break; }
    }
  }
  const hasGST = !!(hasExplicitGSTAmount || hasGSTLabel || gstArith);

  // Detect already-paid invoices (AMOUNT DUE: $0.00 + Less Amount Paid shown)
  const alreadyPaid = /AMOUNT\s+DUE[:\s]+\$?\s*0[\.,]00/i.test(text)
    && /Less\s+Amount\s+Paid/i.test(text);

  // ── Invoice type classification ───────────────────────────────────────────
  // AP keywords (checked first — more distinctive than event keywords)
  const AP_RE = /\b(coach(?:ing)?|SEO|search\s+engine|marketing|advertising|retainer|listing(?:s)?|software|consult(?:ing|ant)?|legal|accounting|bookkeep|insurance|hostin|domain|subscri|management\s+fee|advisory|planning|office\s+supply|stationery|printing|public\s+relation|web\s+design|graphic\s+design)\b/i;
  // Event/performer keywords
  const EVENT_RE = /\b(perform|entertainment|DJ|band|musician|music|photo(?:graphy|grapher)?|video(?:graphy|grapher)?|magic(?:ian)?|circus|juggl|dance|dancer|comedy|comedian|theatre|gig|show|booking|wedding\s+entertain|birthday\s+party|corporate\s+event|live\s+music|guitarist|singer|vocalist|emcee|\bMC\b|caricature|busker|artist\s+fee|roving|face\s+paint|balloon|illusionist|hypnotist|mentalist|string\s+quartet|jazz\s+band|cover\s+band|tribute\s+band|function\s+band|event\s+coverage)\b/i;

  let invoiceTypeHint = 'unknown';
  if (AP_RE.test(text)) invoiceTypeHint = 'ap';
  else if (EVENT_RE.test(text)) invoiceTypeHint = 'event';

  // ── Performance / event date ──────────────────────────────────────────────
  // Prefer an event date found in the BODY (line items); fall back to the invoice/issue date as
  // a best guess. `perfDateGuess` flags anything that isn't an explicitly-labelled event date so
  // the UI can show a "best guess — verify" note. Handles /, -, . separators, 2- or 4-digit years,
  // ordinals ("9th May"), worded months ("28-Apr-26", "8 May 2026"), and D/M with no year ("18/4").
  let performanceDate = '';
  let perfDateGuess = false;
  const mn2 = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
  const FULL_MONTHS = {january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12'};
  // Validate a worded month: full name, 3-letter abbrev, or a clean prefix ("Sept"). Rejects
  // lookalikes like "Mayfield" (not a prefix of any month) to avoid false positives.
  const monthNum = (w) => {
    w = String(w || '').toLowerCase().replace(/[^a-z]/g, '');
    if (FULL_MONTHS[w]) return FULL_MONTHS[w];
    const abbr = mn2[w.slice(0,3)];
    if (abbr && Object.keys(FULL_MONTHS).some(fm => fm.startsWith(w))) return abbr;
    return null;
  };
  const invYear = (date && /^\d{4}/.test(date)) ? date.slice(0,4) : String(new Date().getFullYear());

  // Pattern A: explicit "Event/Performance/Service date" label → confident (NOT flagged a guess).
  const perfLabelM = text.match(
    /(?:date\s+of\s+(?:service|performance|event)|service\s+date|event\s+date|performance\s+date)\s*[:\s]+(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?\s+\d{2,4})/i
  );
  if (perfLabelM) {
    const raw = perfLabelM[1].trim();
    const nm = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (nm) performanceDate = parseDate(nm[1], nm[2], nm[3]);
    else {
      const wm = raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(\d{2,4})$/);
      if (wm) { const mo = monthNum(wm[2]); if (mo) performanceDate = parseDate(wm[1], mo, wm[3]); }
    }
  }

  // Pattern B: scan the body for date-like tokens (the event date usually sits in the line items).
  if (!performanceDate) {
    const descIdx = text.search(/\b(?:description|item|quantity|service|performance)\b|@|for\s*:/i);
    const body = descIdx >= 0 ? text.slice(descIdx) : text;
    const after = (idx, len) => body.slice(idx + len, idx + len + 35);
    const skip  = (idx) => /\b(?:due|issue|issued|invoice|tax)\b[^\d]{0,15}$/i.test(body.slice(Math.max(0, idx - 18), idx));
    const cands = [];
    const okDM = (d, mo) => { d = +d; mo = +mo; return d >= 1 && d <= 31 && mo >= 1 && mo <= 12; };
    // numeric  DD ? MM ? YY(YY)  with /  -  or .  (full date)
    for (const m of body.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g)) {
      if (skip(m.index) || !okDM(m[1], m[2])) continue;
      const pd = parseDate(m[1], m[2], m[3]); if (pd) cands.push({ i: m.index, iso: pd });
    }
    // worded month, day-first: "9th May 2026", "9 May 26", "28-Apr-26", "Saturday 9th May 2026"
    for (const m of body.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-\/]+([A-Za-z]{3,9})\.?[\s\-\/]+(\d{2,4})\b/g)) {
      if (skip(m.index) || +m[1] < 1 || +m[1] > 31) continue;
      const mo = monthNum(m[2]); if (!mo) continue;
      const pd = parseDate(m[1], mo, m[3]); if (pd) cands.push({ i: m.index, iso: pd });
    }
    // worded month, MONTH-FIRST: "April 18, 2026", "Apr 18 26", "April 18th 2026"
    for (const m of body.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/g)) {
      if (skip(m.index) || +m[2] < 1 || +m[2] > 31) continue;
      const mo = monthNum(m[1]); if (!mo) continue;
      const pd = parseDate(m[2], mo, m[3]); if (pd) cands.push({ i: m.index, iso: pd });
    }
    // worded month with NO year ("18th April", "April 18th") → assume invoice year. The negative
    // lookahead/behind stops it double-matching when a year is actually present (handled above).
    for (const m of body.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]{3,9})\b(?![\s\-\/]*\d)/g)) {
      if (skip(m.index) || +m[1] < 1 || +m[1] > 31) continue;
      const mo = monthNum(m[2]); if (!mo) continue;
      const pd = parseDate(m[1], mo, invYear); if (pd) cands.push({ i: m.index, iso: pd });
    }
    for (const m of body.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)\b(?![\s,\-\/]*\d)/g)) {
      if (skip(m.index) || +m[2] < 1 || +m[2] > 31) continue;
      const mo = monthNum(m[1]); if (!mo) continue;
      const pd = parseDate(m[2], mo, invYear); if (pd) cands.push({ i: m.index, iso: pd });
    }
    // D/M with NO year ("18/4", "9/5") → assume invoice year. Lookbehind/ahead avoid matching a
    // fragment of a full date ("05/26" inside "16/05/26"); also skip address fragments ("2/4 Kennedy St").
    for (const m of body.matchAll(/(?<![\d\/.\-])(\d{1,2})\/(\d{1,2})(?![\d\/.\-])/g)) {
      if (skip(m.index) || !okDM(m[1], m[2])) continue;
      if (/^\s*[A-Za-z][A-Za-z ]{0,20}\b(st|street|rd|road|ave|avenue|ct|court|cres|crescent|dr|drive|lane|pl|place|vic|nsw|qld|sa|wa|nt|tas|act)\b|^\s*\w*\s*\d{4}\b/i.test(after(m.index, m[0].length))) continue;
      const pd = parseDate(m[1], m[2], invYear); if (pd) cands.push({ i: m.index, iso: pd });
    }
    cands.sort((a, b) => a.i - b.i);
    // Multiple event dates on one invoice → take the FIRST. Prefer one that differs from the
    // invoice date, else the first found (covers "event date == invoice date" invoices).
    const chosen = cands.find(c => c.iso !== date) || cands[0];
    if (chosen) { performanceDate = chosen.iso; perfDateGuess = true; }
  }

  // Pattern C: nothing usable in the body → fall back to the invoice/issue date as a best guess.
  if (!performanceDate && date) { performanceDate = date; perfDateGuess = true; }

  // ── Expense detection (best-effort guess from raw text) ──────────────────
  // These are pre-filled into the expense fields in the Review modal.
  // The user can override any value — these are hints only.
  const detectedExpenses = { parking: 0, accommodation: 0, travel: 0 };

  // Number capture: supports thousands separators ($1,140) — commas stripped before parse.
  const expNum = '(\\d+(?:,\\d{3})*(?:\\.\\d{2})?)';
  const expVal = m => m ? parseFloat(String(m[1]).replace(/,/g, '')) : 0;
  // The LABELLED form ("Travel = $300", "travel: $150", "travel $150") is tried first so a
  // line like "8 x $80ph = $640  Travel = $300" maps $300 to travel — not the $640 fee.
  // Same-line whitespace only ([ \t], never \n) so the label can't reach a value on the next line.
  // The value-before-keyword form ("$150 travel") is the fallback for invoices without a "=" / ":".

  // Travel: "Travel = $300", "travel: $150", "travel $150", "$150 travel"
  const travelM = text.match(new RegExp('\\btravel(?:ling)?(?:[ \\t]+(?:allowance|expense|fee|cost|reimbursement))?[ \\t]*[:=\\-]?[ \\t]*\\$[ \\t]*' + expNum, 'i'))
                || text.match(new RegExp('\\+?[ \\t]*\\$[ \\t]*' + expNum + '[ \\t]+(?:travel|travelling|transportation)\\b', 'i'));
  if (travelM) detectedExpenses.travel = expVal(travelM);

  // Parking: "Parking = $20", "parking: $20", "parking fee $20", "$20 parking"
  const parkingM = text.match(new RegExp('\\bparking(?:[ \\t]+(?:expense|fee|cost|reimbursement))?[ \\t]*[:=\\-]?[ \\t]*\\$[ \\t]*' + expNum, 'i'))
                 || text.match(new RegExp('\\$[ \\t]*' + expNum + '[ \\t]+parking\\b', 'i'));
  if (parkingM) detectedExpenses.parking = expVal(parkingM);
  // Sense-check: parking is almost always $5–$100. A larger value is nearly always a mis-grab of an
  // adjacent line amount (e.g. a $300 fee printed next to the word "Parking"), so drop it — better to
  // leave parking blank for manual entry than carry a wrong reimbursement onto the bill.
  if (detectedExpenses.parking > 100) detectedExpenses.parking = 0;

  // Accommodation: "Accom = $200", "accommodation: $200", "hotel $200", "$200 accommodation"
  const accomM = text.match(new RegExp('\\b(?:accommodation|accom|hotel|motel|lodging)(?:[ \\t]+(?:expense|fee|cost))?[ \\t]*[:=\\-]?[ \\t]*\\$[ \\t]*' + expNum, 'i'))
               || text.match(new RegExp('\\$[ \\t]*' + expNum + '[ \\t]+(?:accommodation|accom|hotel|motel|lodging)\\b', 'i'));
  if (accomM) detectedExpenses.accommodation = expVal(accomM);

  return { name, invoiceNumber, date, performanceDate, perfDateGuess, total, abn, hasGST, alreadyPaid, invoiceTypeHint, detectedExpenses };
}

// ══════════════════════════════════════════════════════════════════════════════
// Structured field extraction — categorise raw PDF text into a reviewable table
// ══════════════════════════════════════════════════════════════════════════════
// Normalisation helpers
function digitsOnly(s){ return String(s||'').replace(/\D/g,''); }

// Join letter-spaced runs that the PDF extractor splits into single glyphs:
// "I N V O I C E" → "INVOICE" (3+ single letters separated by single spaces).
function despaceText(t){
  return String(t||'').replace(/\b(?:[A-Za-z]\s){2,}[A-Za-z]\b/g, m => m.replace(/\s+/g,''));
}
function normalizeABN(s){
  const d = digitsOnly(s);
  if (d.length !== 11) return { value:d, display:d, valid:false };
  return { value:d, display:`${d.slice(0,2)} ${d.slice(2,5)} ${d.slice(5,8)} ${d.slice(8,11)}`, valid:true };
}
function normalizeMobile(s){
  let d = digitsOnly(s);
  if (d.length === 11 && d.startsWith('61')) d = '0' + d.slice(2);   // +61 4xx → 04xx
  else if (d.length === 9 && d.startsWith('4')) d = '0' + d;          // 4xx... → 04xx
  if (!(d.length === 10 && d.startsWith('04'))) return { value:d, display:d, valid:false };
  return { value:d, display:`${d.slice(0,4)} ${d.slice(4,7)} ${d.slice(7,10)}`, valid:true };
}
function normalizeBSB(s){
  const d = digitsOnly(s);
  if (d.length !== 6) return { value:d, display:d, valid:false };
  return { value:d, display:`${d.slice(0,3)}-${d.slice(3,6)}`, valid:true };
}

const FT_CATEGORIES = ['Performance','Travel','Parking','Accommodation','Setup','Other'];

// Best-effort line-item parser. Pairs a $amount with adjacent description text and
// guesses a category. Rough by design — the user confirms/corrects in the modal.
function extractLineItems(raw){
  const text = despaceText(raw).replace(/\s{2,}/g,' ');
  const items = [];
  const cat = (desc) => {
    const d = desc.toLowerCase();
    if (/travel|mileage|\bkm\b|transport|fuel|petrol|toll/.test(d)) return 'Travel';
    if (/park/.test(d)) return 'Parking';
    if (/accom|hotel|motel|lodging|airbnb|overnight/.test(d)) return 'Accommodation';
    if (/set[\s-]?up|bump[\s-]?(in|out)|pack[\s-]?down|rehears/.test(d)) return 'Setup';
    return 'Performance';
  };
  const SKIP = /^(total|sub\s?total|gst|amount|balance|due|invoice|tax|payment|account|bsb|abn|date|description|qty|quantity|unit|price|rate|item|ref|reference|terms|issued|bank|pay\b)/i;
  // "$600 description"  OR  "description $600"
  const re = /\$\s?(\d[\d,]*(?:\.\d{2})?)\s+([A-Za-z][A-Za-z0-9 '’()&,.:\-–—]{2,55}?)(?=\s+\$|\s*$)|([A-Za-z][A-Za-z0-9 '’()&,.:\-–—]{2,55}?)\s*[:\-–—]?\s*\$\s?(\d[\d,]*(?:\.\d{2})?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let desc = (m[2] || m[3] || '').trim();
    const amt = parseFloat((m[1] || m[4] || '').replace(/,/g,''));
    desc = desc.replace(/\s+(total|subtotal|gst|amount|balance|due|invoice|tax|pay)\b.*$/i,'').trim();
    if (!desc || !(amt > 0) || desc.length < 3) continue;
    if (SKIP.test(desc)) continue;
    items.push({ description: desc, amount: amt, category: cat(desc) });
    if (items.length >= 12) break;
  }
  return items;
}

// Returns { fields:[{key,label,value,applies,target,warn,multiline}], lineItems:[...] }
function extractStructuredFields(rawText, data){
  data = data || {};
  const raw = rawText || '';
  const text = despaceText(raw).replace(/\s{2,}/g,' ');
  const MEC_RE = /melbourne\s+entertainment|melbentco|mlebourne|ent\s+co\s+pty/i;
  const fields = [];
  const push = (key, label, value, opts) =>
    fields.push(Object.assign({ key, label, value: (value==null?'':String(value)), applies:false, target:null, warn:'', multiline:false }, opts||{}));

  // — Identity & matching —
  push('contractorName', 'Contractor name', data.name, { applies:true, target:'name' });
  let stage = '';
  const stageM = text.match(/\(((?:DJ|MC)\s+[A-Z][\w'’]+)\)/) || text.match(/\b((?:DJ|MC)\s+[A-Z][\w'’]+)\b/);
  if (stageM) stage = stageM[1].trim();
  push('stageName', 'Stage / act name', stage);
  let entity = '';
  const ptyM = text.match(/\b([A-Z][A-Za-z&]+(?:\s+[A-Z][A-Za-z&]+){0,5}\s+PTY\.?\s*LTD\.?)/);
  const tradeM = text.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\s+(?:PHOTOGRAPHY|PRODUCTIONS?|ENTERTAINMENT|MUSIC|EVENTS?|STUDIOS?))\b/);
  if (ptyM) entity = ptyM[1].trim(); else if (tradeM) entity = tradeM[1].trim();
  push('entityName', 'Trading / entity name', entity);
  // (Issued-to removed — it's always Melbourne Entertainment Company.)

  // — Invoice metadata —
  push('invoiceNumber', 'Invoice number', data.invoiceNumber, { applies:true, target:'inv' });
  push('invoiceDate', 'Invoice date', data.date, { applies:true, target:'date' });
  let due = '';
  const dueM = text.match(/due\s*date[:\s]+(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i);
  if (dueM) due = dueM[1];
  push('dueDate', 'Due date', due);
  push('performanceDate', 'Performance / event date', data.performanceDate, { applies:true, target:'perfdate' });

  // — Money —
  let subtotal = '';
  const subM = text.match(/Sub[\s-]?total[:\s]*\$?\s*([\d,]+\.\d{2})/i);
  if (subM) subtotal = '$' + subM[1];
  push('subtotal', 'Subtotal (ex-GST)', subtotal);
  // GST amount: capture an explicit GST amount ($ optional — many invoices print bare numbers
  // like "INCLUDES GST 10%  220.00"). If none found but GST applies, show total ÷ 11 as an
  // estimate. Only show "Nil" on a clear zero/GST-free signal — NOT by matching the trailing
  // "0.00" of a larger number (the old bug: "220.00" was read as GST 0.00 → Nil).
  let gstVal = '';
  const money = '([\\d,]+\\.\\d{2})';
  const gstAmtM =
       text.match(new RegExp('INCLUDES?\\s+GST(?:[^A-Za-z\\d]{0,4}10%?)?[^A-Za-z\\d]{0,4}\\$?\\s*' + money, 'i'))
    || text.match(new RegExp('(?:Total\\s+GST|GST\\s+Total|GST\\s+(?:Amount|Payable|Component))[^A-Za-z\\d]{0,6}\\$?\\s*' + money, 'i'))
    || text.match(new RegExp('\\bGST\\b\\s*(?:\\(?10%?\\)?)?[:\\s]*\\$\\s*' + money, 'i'));
  const gstNum = gstAmtM ? parseFloat(gstAmtM[1].replace(/,/g,'')) : NaN;
  const fmt2 = n => (Math.round(n * 100) / 100).toFixed(2);
  const explicitNil = /\bGST\b[^A-Za-z\d]{0,6}(?:nil|n\/a|free|exempt|\$?\s*0\.00\b)/i.test(text)
                   || /\bno\s+gst\b|\bgst[\s-]*free\b|\bexcl(?:udes|uding)?\.?\s+gst\b/i.test(text);
  if (gstNum > 0) gstVal = '$' + fmt2(gstNum);
  else if (data.hasGST) {
    const est = data.total ? data.total / 11 : 0;       // GST-inclusive total → GST = total ÷ 11
    gstVal = est > 0 ? `$${fmt2(est)} (est.)` : '(GST charged)';
  } else if (explicitNil) gstVal = 'Nil';
  push('gstAmount', 'GST amount', gstVal);
  push('total', 'Total (inc GST)', data.total ? Number(data.total).toFixed(2) : '', { applies:true, target:'total' });

  // — Payment —
  let bankName = '';
  const bankM = text.match(/\b(Commonwealth(?:\s+Bank)?|CBA|National\s+Australia\s+Bank|NAB|ANZ|Westpac|Bendigo(?:\s+Bank)?|ING|Macquarie|Bank\s+of\s+Melbourne|St\.?\s*George|Suncorp|Bankwest|UBank|Great\s+Southern\s+Bank|Bank\s+Australia|ME\s+Bank|Heritage|Beyond\s+Bank|Newcastle\s+Permanent)\b/i);
  if (bankM) bankName = bankM[1].trim();
  push('bankName', 'Bank', bankName, { secondary:true });
  let acctName = '';
  const acctNameM = text.match(/Account\s*Name\s*[:\s]+([A-Za-z][A-Za-z .'\-]{2,40}?)(?=\s+(?:BSB|Account|Acc\b|A\/C|Bank|ABN|Number|No\b|Pay)|\s*$)/i);
  if (acctNameM) acctName = acctNameM[1].trim();
  push('bankAccountName', 'Bank account name', acctName, { secondary:true });
  const bsbM = text.match(/\bBSB\b[:\s#]*([0-9]{3}[\s\-]?[0-9]{3})\b/i);
  const bsbN = bsbM ? normalizeBSB(bsbM[1]) : null;
  push('bsb', 'BSB', bsbN ? bsbN.display : '', { secondary:true, warn: (bsbM && !bsbN.valid) ? 'Check — not 6 digits' : '' });
  let acctNum = '';
  const acctNumM = text.match(/(?:Account|Acc|A\/C)\s*(?:No\.?|Number|#)\s*[:\s]*([0-9][\d\s]{4,11}[0-9])\b/i);
  if (acctNumM) acctNum = digitsOnly(acctNumM[1]);
  push('accountNumber', 'Bank account number', acctNum, { secondary:true });
  let payid = '';
  const payidM = text.match(/PayID\s*[:\s]*([A-Za-z0-9@._\-+]{3,40})/i);
  if (payidM) payid = payidM[1];
  push('payID', 'PayID / BPAY', payid, { secondary:true });

  // — Contact —
  const mobM = text.match(/(?:\+?61[\s\-]?4|0\s?4)(?:[\s\-]?\d){8}/);
  const mobN = mobM ? normalizeMobile(mobM[0]) : null;
  push('mobile', 'Mobile', mobN ? mobN.display : '', { secondary:true, warn: (mobM && !mobN.valid) ? 'Check format' : '' });
  let email = '';
  const emailM = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  if (emailM) email = emailM[0];
  push('email', 'Email', email, { secondary:true });
  let addr = '';
  const addrM = raw.match(/\d+[A-Za-z]?\s+[A-Za-z][A-Za-z ]+\b(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ct|Court|Cres|Crescent|Pl|Place|Lane|Ln|Way|Hwy|Highway|Pde|Parade|Blvd|Tce|Terrace)\b[^\n]*?\b(?:VIC|NSW|QLD|SA|WA|NT|TAS|ACT)\b\s*\d{4}/i);
  if (addrM) addr = addrM[0].replace(/\s{2,}/g,' ').trim();
  push('address', 'Address', addr, { secondary:true });
  push('abn', 'ABN', data.abn ? normalizeABN(data.abn).display : '', { applies:true, target:'abn' });
  let mecRef = '';
  const mecRefM = text.match(/\b([A-Z]{2,3}-\d{2,4})\b/);
  if (mecRefM) mecRef = mecRefM[1];
  push('mecBookingRef', 'MEC booking ref', mecRef);

  // — Catch-all —
  push('other', 'Other / notes', '', { multiline:true });

  return { fields, lineItems: extractLineItems(raw) };
}

function appendInvoiceRow(tbody, id, data, match, filename, dupWarning) {
  // Build match badge — with Zoho detail or Stage 1 contractor search
  let matchBadge;
  if (match) {
    const superLbl = match.superEligible
      ? `<span style="color:#27AE60;font-weight:600">✓ Super</span>`
      : `<span style="color:#888">✗ No super</span>`;
    const gstLbl = match.gst ? 'GST ✓' : 'No GST';
    const fundLbl = match.fundName
      ? `<br><span style="color:#888;font-size:9px">Fund: ${escHtml(match.fundName)}</span>`
      : (match.superEligible ? `<br><span style="color:#c0392b;font-size:9px">⚠ No fund on file</span>` : '');
    matchBadge = `<span class="badge badge-ok match-status-ok">${escHtml(match.name)}</span>
      <div style="font-size:10px;color:#555;margin-top:2px;line-height:1.5">
        ${gstLbl} → Type ${match.type} · ${superLbl}${fundLbl}
      </div>`;
  } else {
    matchBadge = `<span class="badge badge-warn match-status-warn">Not found in Zoho</span>`;
  }

  // Route to AP tbody if auto-classified as non-event; matched contractors always go to event
  const hint = data.invoiceTypeHint || 'unknown';
  const isAP = !match && hint === 'ap';
  // ABN: use PDF value, or fall back to Zoho-matched record's ABN
  const zohoABNFill = (!data.abn && match && match.abn) ? match.abn : null;
  const resolvedABN = data.abn || zohoABNFill || '';
  // ABN note: "from Zoho" badge if auto-filled, warning if still missing
  const abnMissingNote = !resolvedABN
    ? `<div style="font-size:10px;color:#c0392b;margin-top:2px">⚠ ABN missing</div>`
    : (zohoABNFill ? `<div style="font-size:10px;color:#60A5FA;margin-top:2px">from Zoho</div>` : '');

  // Duplicate warning banner
  const dupNote = dupWarning
    ? `<div style="font-size:10px;color:#7B341E;background:#FFFBEB;border:1px solid #F6AD55;border-radius:3px;padding:2px 5px;margin-top:2px">⚠ ${dupWarning}</div>`
    : '';

  // Use Zoho matched name as source of truth; fall back to PDF-extracted name
  const displayName = match ? match.name : data.name;
  const pdfNameNote = (match && data.name && data.name.trim().toLowerCase() !== match.name.trim().toLowerCase())
    ? `<div style="font-size:10px;color:#999;margin-top:1px">PDF: ${escHtml(data.name)}</div>` : '';

  // Duo/group super: flag invoices where the performer may be working as a multi-act under one ABN.
  // Flagged rows DEFAULT to NO super withheld; the operator confirms the treatment in Review.
  const mpFlag = multiPerfFlag(id, match, data.name, data.total, data.performanceDate || data.date);
  const superDefaultOn = (match && ['C', 'D'].includes(match.type)) ? false : !mpFlag.level;
  const mpMarker = mpFlag.level
    ? `<div style="font-size:9px;color:#B7791F;margin-top:2px;line-height:1.2" title="${escHtml('Possible multi-performer — ' + mpFlag.reasons.join('; ') + '. Super defaulted OFF; confirm in Review.')}">⚠ duo/group?</div>`
    : '';

  const tr = document.createElement('tr');
  if (dupWarning) tr.style.background = '#FFFBEB';
  tr.id = 'row-' + id;
  tr.innerHTML = `
    <td style="position:relative">
      <div style="position:relative">
        <input type="text" value="${escHtml(displayName)}" placeholder="Start typing to search Zoho…"
          oninput="searchContractorsS1('${id}', this.value)"
          onchange="updateMatch(this,'${id}')"
          onblur="setTimeout(()=>hideDropdownS1('${id}'),200)"
          id="name-${id}" style="width:100%">
        <div id="s1drop-${id}" class="contractor-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #CBD5E0;border-radius:0 0 5px 5px;max-height:180px;overflow-y:auto;z-index:50;box-shadow:0 6px 16px rgba(0,0,0,0.2)"></div>
      </div>
      ${pdfNameNote}${dupNote}</td>
    <td><input type="text" value="${escHtml(data.invoiceNumber)}" id="inv-${id}"></td>
    <td style="min-width:115px">
      ${!isAP ? `<input type="date" value="${data.performanceDate||''}" id="perfdate-${id}"
        style="font-size:11px;padding:2px 4px;width:115px"
        title="Performance / event date — confirm in the Review screen">` : `<input type="date" value="${data.date}" id="date-${id}" style="font-size:11px;padding:2px 4px;width:115px">`}
      <!-- Keep hidden invoice date field for backward compatibility with extractRow() -->
      ${!isAP ? `<input type="hidden" id="date-${id}" value="${data.date}">` : ''}
    </td>
    <td><input type="number" value="${data.total||''}" step="0.01" id="total-${id}" placeholder="e.g. 580.00"></td>
    <td>
      <div style="display:flex;gap:4px;align-items:center;">
        <input type="text" value="${escHtml(resolvedABN)}" placeholder="XX XXX XXX XXX"
               id="abn-${id}" style="width:105px;font-size:12px;${zohoABNFill ? 'border-color:#60A5FA' : ''}" maxlength="14"
               title="${zohoABNFill ? 'ABN imported from Zoho (not on invoice PDF)' : ''}">
      </div>
      ${abnMissingNote}
    </td>
    <td id="match-${id}">${matchBadge}
      <input type="hidden" id="itype-${id}" value="${isAP ? 'ap' : 'event'}">
    </td>
    <td style="text-align:center;vertical-align:middle;">
      <input type="checkbox" id="s1-super-${id}" ${superDefaultOn ? 'checked' : ''}
        style="cursor:pointer;width:15px;height:15px;accent-color:#27AE60"
        title="Deduct super for this invoice (12% by default, or the contractor's Zoho rate). Defaults ON for sole traders (Type A/B), OFF for companies/partnerships and for possible duo/group invoices. Untick to skip super for this contractor. To exclude the whole invoice, remove it with the ✕ button.">
      ${mpMarker}
    </td>
    <td style="white-space:nowrap">
      <button class="btn btn-secondary btn-sm" onclick="openReviewModal('${id}')" id="rv-btn-${id}" title="Review invoice — verify &amp; correct extracted fields" style="margin-right:3px">👁 Review</button>
      <button class="btn btn-secondary btn-sm" onclick="showFieldTable('${id}')" title="Open the parsed field table — review &amp; apply extracted values" style="margin-right:3px;font-size:10px">📊</button>
      <button class="btn btn-danger btn-sm" onclick="removeRow('${id}')">✕</button>
    </td>`;

  if (isAP) {
    // Route to the AP review section
    const apTbody = document.getElementById('ap-review-tbody');
    if (apTbody) {
      apTbody.appendChild(tr);
      // Show the AP section and update its count
      const apSection = document.getElementById('ap-review-section');
      if (apSection) apSection.classList.remove('hidden');
      const apCount = document.getElementById('ap-review-count');
      if (apCount) apCount.textContent = `(${apTbody.querySelectorAll('tr').length} bill${apTbody.querySelectorAll('tr').length>1?'s':''})`;
    }
  } else {
    tbody.appendChild(tr);
  }
  updateProcessCount();
}

function updateMatch(input, id) {
  const name = input.value;
  const abn = document.getElementById('abn-'+id)?.value?.replace(/\s/g,'') || '';
  const match = matchContractor(name, abn);
  const total = parseFloat(document.getElementById('total-'+id)?.value) || 0;
  const date = document.getElementById('date-'+id)?.value || '';
  const cell = document.getElementById('match-' + id);
  
  let html = match
    ? `<span class="badge badge-ok match-status-ok">${match.name}</span>`
    : `<span class="badge badge-warn match-status-warn">Not found in Zoho</span>`;
  
  // Booking cross-check: prefer explicitly-linked bookings from Review modal
  const bm = getBookingMatchForRow(name, total, date, invoiceBookingData['id_'+id] || null);
  if (bm) {
    if (bm.alreadyPaid) {
      html += `<br><span style="color:var(--red);font-size:11px;font-weight:600">⚠ Already marked paid in Zoho</span>`;
    } else if (bm.costMatch === true) {
      html += `<br><span style="color:var(--green);font-size:11px">✓ Amount matches booking ($${bm.entertainer.cost})</span>`;
    } else if (bm.costMatch === false) {
      html += `<br><span style="color:var(--amber);font-size:11px">⚠ Booking cost: $${bm.entertainer.cost} — diff: $${bm.costDiff?.toFixed(2)}</span>`;
    } else {
      html += `<br><span style="color:#888;font-size:11px">Found in ${bm.booking.bookingName}</span>`;
    }
  }
  
  cell.innerHTML = html;
}

function removeRow(id) {
  const el = document.getElementById('row-' + id);
  if (el) el.remove();
  // Revoke the object URL to free memory
  if (invoiceFileData['id_' + id]) {
    URL.revokeObjectURL(invoiceFileData['id_' + id]);
    delete invoiceFileData['id_' + id];
  }
  updateProcessCount();
}

function clearAllInvoices() {
  const rowCount = document.querySelectorAll('#pdf-tbody tr[id], #ap-review-tbody tr[id], #manual-tbody tr[id]').length;
  if (!rowCount) return;
  if (!confirm(`Remove all ${rowCount} invoice${rowCount!==1?'s':''}? This cannot be undone.`)) return;

  // Revoke all PDF object URLs to free memory
  Object.keys(invoiceFileData).forEach(k => {
    try { URL.revokeObjectURL(invoiceFileData[k]); } catch(e) {}
    delete invoiceFileData[k];
  });
  // Clear all data stores
  [invoiceGSTData, invoiceExpenseData, invoiceBookingData, invoiceRawText].forEach(store => {
    Object.keys(store).forEach(k => delete store[k]);
  });
  if (window.invoiceSuperData) Object.keys(invoiceSuperData).forEach(k => delete invoiceSuperData[k]);
  Object.keys(invoiceSuperShareData).forEach(k => delete invoiceSuperShareData[k]);
  if (window.invoicePaidData)  Object.keys(invoicePaidData).forEach(k => delete invoicePaidData[k]);
  if (window.invoiceTypeData)  Object.keys(invoiceTypeData).forEach(k => delete invoiceTypeData[k]);
  Object.keys(invoicePerfGuess).forEach(k => delete invoicePerfGuess[k]);
  reviewedRows.clear();
  flaggedRows.clear();

  // Clear all table rows
  ['pdf-tbody','ap-review-tbody','manual-tbody'].forEach(id => {
    const tb = document.getElementById(id);
    if (tb) tb.innerHTML = '';
  });

  // Clear the upload list and hide the results/AP sections
  const list = document.getElementById('pdf-list');
  if (list) list.innerHTML = '';
  document.getElementById('pdf-results')?.classList.add('hidden');
  document.getElementById('ap-review-section')?.classList.add('hidden');

  // Restore the drop zone to its full (large) initial size
  const pdfDrop = document.getElementById('pdf-drop');
  if (pdfDrop) {
    pdfDrop.style.cssText = 'padding:56px 20px;min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;';
    const icon = pdfDrop.querySelector('.icon');
    if (icon) { icon.style.display = ''; icon.style.fontSize = '46px'; icon.style.marginBottom = '10px'; }
    const labels = pdfDrop.querySelectorAll('.label');
    if (labels[0]) { labels[0].style.cssText = 'font-size:16px'; labels[0].innerHTML = '<strong>Click to upload PDFs</strong> — or drag &amp; drop multiple invoices here'; }
    if (labels[1]) { labels[1].style.cssText = 'margin-top:4px;font-size:12px;color:#aaa'; }
  }

  // Re-add the single blank manual row
  addManualRow();
  updateProcessCount();
}

// ══════════════════════════════════════════════════════════════════════════════
// Review Invoice Modal
// ══════════════════════════════════════════════════════════════════════════════
let reviewModalRowId = null;
const reviewedRows = new Set();
const flaggedRows   = new Set();

// Align the progress rail's pill nodes vertically with their corresponding cards.
// Each .rv-rail-node is absolutely positioned so its centre matches the centre of the matching
// .rv-card. Phase labels (Match / Enter) sit at the top of each card group. Called on modal
// open and on resize (debounced).
function alignReviewRail() {
  const rail = document.querySelector('.rv-rail');
  if (!rail) return;
  const workCol = rail.parentElement && rail.parentElement.querySelector('div[style*="flex:1"]');
  if (!workCol) return;
  const cards = workCol.querySelectorAll('.rv-card');
  const nodes = rail.querySelectorAll('.rv-rail-node');
  if (!cards.length || !nodes.length || cards.length !== nodes.length) return;
  rail.style.position = 'relative';
  rail.style.height = workCol.offsetHeight + 'px';
  // Hide the connecting lines + phase labels — they don't fit when nodes are absolutely positioned
  rail.querySelectorAll('.rv-rail-line, .rv-rail-phase').forEach(el => el.style.display = 'none');
  const railTop = rail.getBoundingClientRect().top;
  cards.forEach((card, i) => {
    const node = nodes[i];
    if (!node) return;
    const cardRect = card.getBoundingClientRect();
    const cardCentre = cardRect.top + cardRect.height / 2;
    const topPx = cardCentre - railTop - (node.offsetHeight / 2);
    node.style.position = 'absolute';
    node.style.left = '0';
    node.style.top = topPx + 'px';
  });
}

let _railAlignTimer = null;
function scheduleRailAlign() {
  if (_railAlignTimer) clearTimeout(_railAlignTimer);
  // Two passes: 50ms (catches most cases) + 250ms (covers slow reflow from images / fonts /
  // PDF load). Cheap to run, robust to timing variation.
  _railAlignTimer = setTimeout(() => {
    alignReviewRail();
    setTimeout(alignReviewRail, 200);
  }, 50);
}

window.addEventListener('resize', () => { if (typeof scheduleRailAlign === 'function') scheduleRailAlign(); });

function openReviewModal(id) {
  const url = invoiceFileData['id_' + id];
  reviewModalRowId = id;

  // Populate fields from current Stage 1 inputs
  const g = el => document.getElementById(el);
  g('rv-name').value     = g('name-'+id)?.value     || '';
  g('rv-inv').value      = g('inv-'+id)?.value      || '';
  g('rv-date').value     = g('date-'+id)?.value     || '';
  g('rv-perfdate').value = g('perfdate-'+id)?.value || '';
  g('rv-total').value    = g('total-'+id)?.value    || '';
  g('rv-abn').value      = g('abn-'+id)?.value      || '';

  // GST checkbox — three signals, OR them together. PDF extraction sometimes misses GST
  // (e.g. Jeremy Bennett: extractor failed; Ellie Carragher: company invoice via talent manager).
  // Tick if ANY of: (a) PDF extraction found GST, (b) matched Zoho contractor has gst=true,
  // (c) ABR for the invoice ABN says the entity is GST-registered.
  const storedGST = invoiceGSTData['id_' + id];
  const abn0check = (g('rv-abn')?.value||'').replace(/\s/g,'');
  const matchForGST = (typeof contractors !== 'undefined' && Array.isArray(contractors))
    ? contractors.find(c =>
        (c.name||'').toLowerCase() === (g('rv-name')?.value||'').toLowerCase() ||
        (abn0check.length===11 && c.abn && c.abn.replace(/\s/g,'') === abn0check))
    : null;
  const abrGSTFlag = abrRowData && abrRowData['id_' + id] && abrRowData['id_' + id].isGST;
  const gstShouldTick = storedGST === true
                     || (matchForGST && matchForGST.gst === true)
                     || abrGSTFlag === true;
  g('rv-gst').checked = gstShouldTick ? true : (storedGST === false ? false : !!storedGST);
  // Persist back so downstream code sees the same value
  invoiceGSTData['id_' + id] = !!g('rv-gst').checked;

  // Super checkbox — sync with the Stage 1 "Withhold super?" toggle (the source of truth),
  // then a stored review override, then a sensible default (on unless matched company/partnership).
  const storedSuper = invoiceSuperData?.['id_' + id];
  const s1SuperEl = document.getElementById('s1-super-' + id);
  if (s1SuperEl) {
    g('rv-super') && (g('rv-super').checked = s1SuperEl.checked);
  } else if (storedSuper !== undefined) {
    g('rv-super') && (g('rv-super').checked = !!storedSuper);
  } else {
    const abn0check = (g('rv-abn')?.value||'').replace(/\s/g,'');
    const matchCheck = contractors.find(c => c.name.toLowerCase() === (g('rv-name')?.value||'').toLowerCase() || (abn0check.length===11 && c.abn && c.abn.replace(/\s/g,'')=== abn0check));
    g('rv-super') && (g('rv-super').checked = matchCheck ? !['C','D'].includes(matchCheck.type) : true);
  }

  // Restore expense splits
  const storedExp = invoiceExpenseData['id_' + id] || {};
  g('rv-exp-parking').value       = storedExp.parking       || '';
  g('rv-exp-accommodation').value = storedExp.accommodation || '';
  if (g('rv-exp-travel')) g('rv-exp-travel').value = storedExp.travel || '';
  if (g('rv-exp-other')) g('rv-exp-other').value = storedExp.other || '';

  // Duo / group super panel — shown when this invoice is flagged as a possible multi-performer act.
  // Restore the share input first so rvUpdateServiceFee()/the mode picker see the saved value.
  const storedShare = invoiceSuperShareData['id_' + id];
  if (g('rv-mp-share')) g('rv-mp-share').value = (storedShare != null ? storedShare : '');
  rvSyncMultiPerfPanel(id);

  rvUpdateServiceFee();

  // Trigger perf date day-of-week display
  updatePerfDateDOW();

  // Best-guess perf-date warning — surfaced HERE (Review), not on the Stage 1 row.
  // The amber box + amber input border tells the user to confirm the auto-detected date.
  const perfGuessWarn = g('rv-perfdate-warn');
  const perfInput = g('rv-perfdate');
  const isGuess = !!invoicePerfGuess['id_' + id] && !!(perfInput && perfInput.value);
  if (perfGuessWarn) perfGuessWarn.style.display = isGuess ? 'block' : 'none';
  if (perfInput) perfInput.style.borderColor = isGuess ? '#B45309' : '#CBD5E0';

  // Modal title
  const name = g('rv-name').value || 'Invoice';
  const inv  = g('rv-inv').value;
  g('review-modal-title').textContent = inv ? `${name} — ${inv}` : name;

  // Same-contractor batch banner
  const batchBanner = g('rv-contractor-batch-banner');
  if (batchBanner) {
    const thisName = (g('rv-name').value || '').trim().toLowerCase();
    if (thisName) {
      // Find all rows for the same contractor that are not yet reviewed
      const allRows = [
        ...Array.from(document.querySelectorAll('#pdf-tbody tr[id]')),
        ...Array.from(document.querySelectorAll('#manual-tbody tr[id]')),
      ];
      const sameContractorUnreviewed = allRows.filter(tr => {
        const rowId = tr.id.replace('row-', '');
        if (rowId === String(id)) return false; // skip current invoice
        const rowName = (document.getElementById('name-'+rowId)?.value || '').trim().toLowerCase();
        return rowName === thisName && !reviewedRows.has(String(rowId));
      });
      const sameContractorAll = allRows.filter(tr => {
        const rowId = tr.id.replace('row-', '');
        const rowName = (document.getElementById('name-'+rowId)?.value || '').trim().toLowerCase();
        return rowName === thisName;
      });
      const totalForContractor = sameContractorAll.length + 1; // +1 for current
      if (sameContractorUnreviewed.length > 0) {
        batchBanner.style.display = 'flex';
        batchBanner.innerHTML = `<span style="font-size:13px">📋</span> <span><strong>${sameContractorUnreviewed.length} more unreviewed invoice${sameContractorUnreviewed.length>1?'s':''}</strong> for ${escHtml(g('rv-name').value||'')} (${totalForContractor} total) — <span style="opacity:.8">Confirm &amp; Next will take you there</span></span>`;
      } else if (totalForContractor > 1) {
        batchBanner.style.display = 'flex';
        batchBanner.innerHTML = `<span style="font-size:13px">✓</span> <span style="color:#1F9D63">All ${totalForContractor} invoices for ${escHtml(g('rv-name').value||'')} reviewed</span>`;
      } else {
        batchBanner.style.display = 'none';
      }
    } else {
      batchBanner.style.display = 'none';
    }
  }

  // Reviewed / flagged badges
  const badge = g('rv-reviewed-badge');
  if (badge) badge.style.display = reviewedRows.has(String(id)) ? 'inline' : 'none';
  // Restore flag button state in modal
  const flagBtn = g('rv-flag-btn');
  if (flagBtn) {
    if (flaggedRows.has(String(id))) {
      flagBtn.style.background = '#E6D3A8';
      flagBtn.style.color = '#8A5B12';
      flagBtn.textContent = '⚠ Flagged';
    } else {
      flagBtn.style.background = '#FBF1DE';
      flagBtn.style.color = '#8A5B12';
      flagBtn.textContent = '⚠ Needs attention';
    }
  }

  // Populate comparison panels
  updateReviewStatus();

  // If ABN field is empty, try to populate from matched Zoho contractor record
  const abnBadge = g('rv-abn-zoho-badge');
  if (abnBadge) abnBadge.style.display = 'none';
  const abnFieldVal = (g('rv-abn').value || '').replace(/\s/g, '');
  if (!abnFieldVal) {
    const nameVal = (g('rv-name').value || '').toLowerCase().trim();
    const matchedC = contractors.find(c => c.name && c.name.toLowerCase().trim() === nameVal);
    if (matchedC && matchedC.abn) {
      const zohoABN = matchedC.abn.replace(/\s/g, '');
      if (zohoABN.length === 11) {
        // Format as XX XXX XXX XXX
        const fmt = zohoABN.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4');
        g('rv-abn').value = fmt;
        g('rv-abn').title = 'ABN imported from Zoho (not on invoice PDF)';
        g('rv-abn').style.borderColor = '#2F6FB3';
        if (abnBadge) abnBadge.style.display = 'inline';
      }
    }
  }

  // Auto-trigger ABR JSONP lookup if ABN is present (populates ABR panel)
  const abn0 = (g('rv-abn').value || '').replace(/\s/g, '');
  if (abn0.length === 11 && /^\d{11}$/.test(abn0)) {
    reviewRunABR(); // async — updates ABR panel in background
  }

  // Load PDF — validate the blob first. Drag/drop & Gmail PDFs are in-browser blob URLs that DON'T
  // survive a Chrome page-refresh; the session restores field data but not the PDF, so a stale URL
  // would otherwise render a confusing "file moved/edited/deleted" page. Fail gracefully instead.
  const noPdfMsg = document.getElementById('rv-no-pdf-msg');
  const uploadWidget = document.getElementById('rv-pdf-upload-widget');
  const pdfFrame = g('rv-pdf-frame');
  const rvShowNoPdf = (title, body) => {
    if (pdfFrame) { pdfFrame.style.display = 'none'; pdfFrame.src = ''; }
    if (noPdfMsg) {
      noPdfMsg.style.display = 'flex';
      noPdfMsg.innerHTML =
        '<div style="font-size:46px;opacity:.35">📄</div>' +
        '<div style="font-size:14px;font-weight:600;color:#2F6FB3">' + title + '</div>' +
        '<div style="font-size:12px;max-width:360px;line-height:1.6;color:#5B6B7B">' + body + '</div>';
    }
    if (uploadWidget) uploadWidget.style.display = 'flex';
  };
  const rvShowPdf = (u) => {
    if (pdfFrame) { pdfFrame.style.display = ''; pdfFrame.src = u + '#navpanes=0&zoom=page-width'; }
    if (noPdfMsg) noPdfMsg.style.display = 'none';
    if (uploadWidget) uploadWidget.style.display = 'none';
  };
  if (url) {
    fetch(url).then(r => { if (!r.ok) throw 0; rvShowPdf(url); }).catch(() => {
      try { URL.revokeObjectURL(url); } catch (e) {}
      delete invoiceFileData['id_' + id];
      rvShowNoPdf('PDF preview cleared by a page refresh',
        'Your invoice data is safe — only the preview was lost. PDF previews can\'t survive a browser refresh; drag &amp; drop or upload the PDF again below to view it here.');
    });
  } else {
    rvShowNoPdf('No PDF to preview',
      'This invoice was entered without a readable PDF. Fill in the fields on the left, or upload a PDF below to view it alongside.');
  }

  // Show modal
  const modal = g('review-modal');
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Update Previous / Next button states
  rvUpdateNextPrevButtons();

  // Reflect completion state on the progress rail
  rvUpdateRail();

  // Focus contractor field after render
  setTimeout(() => g('rv-name')?.focus(), 80);
}

function updatePerfDateDOW() {
  const val = document.getElementById('rv-perfdate')?.value;
  const lbl = document.getElementById('rv-perfdate-dow');
  if (!lbl) return;
  if (!val) { lbl.textContent = ''; return; }
  try {
    const d = new Date(val + 'T12:00:00');
    const day = d.toLocaleDateString('en-AU', {weekday:'long'});
    const full = d.toLocaleDateString('en-AU', {day:'numeric', month:'long', year:'numeric'});
    lbl.textContent = `${day}, ${full}`;
  } catch(e) { lbl.textContent = ''; }
}

// When the user manually edits the performance date, it's no longer a best-guess —
// clear the amber warning + border.
function rvClearPerfGuess() {
  if (reviewModalRowId != null) invoicePerfGuess['id_' + reviewModalRowId] = false;
  const warn = document.getElementById('rv-perfdate-warn');
  const input = document.getElementById('rv-perfdate');
  if (warn) warn.style.display = 'none';
  if (input) input.style.borderColor = '#CBD5E0';
}

// Render readable [weekday], [date] [month] [year] for an ISO date string
function fmtReadableDOW(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-AU', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
  } catch(e) { return ''; }
}

// ── Load a locally-selected PDF into the review modal viewer ──
function rvLoadLocalPDF(input) {
  const file = input.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const frame = document.getElementById('rv-pdf-frame');
  const noPdfMsg = document.getElementById('rv-no-pdf-msg');
  const uploadWidget = document.getElementById('rv-pdf-upload-widget');
  if (frame) { frame.src = url + '#navpanes=0&zoom=page-width'; frame.style.display = ''; }
  if (noPdfMsg) noPdfMsg.style.display = 'none';
  if (uploadWidget) uploadWidget.style.display = 'none';
  // Also store for this row so it persists if modal re-opened
  if (reviewModalRowId) invoiceFileData['id_' + reviewModalRowId] = url;
}

// ── Validation check before Confirm ──
function rvValidateBeforeConfirm() {
  // Only the essentials are required. Invoice # auto-generates, ABN is pulled from Zoho when
  // not printed, and the performance date isn't always derivable — so none of those block
  // confirming (this was the "prompts for info that doesn't exist" bug).
  const missingFields = [];
  const name  = (document.getElementById('rv-name')?.value  || '').trim();
  const inv   = (document.getElementById('rv-inv')?.value   || '').trim();
  const total = (document.getElementById('rv-total')?.value || '').trim();
  const perf  = (document.getElementById('rv-perfdate')?.value || '').trim();
  const abn   = (document.getElementById('rv-abn')?.value   || '').replace(/\s/g,'');
  if (!name)  missingFields.push({ key:'name',  label:'Contractor name',  targetId:'rv-name',  type:'text',   placeholder:'e.g. James Brown' });
  if (!total) missingFields.push({ key:'total', label:'Total (inc. GST)', targetId:'rv-total', type:'number', placeholder:'0.00' });
  // Mandatory super decision: the user MUST pick Solo or Duo/Group in Step 5.
  const superMode = document.querySelector('input[name="rv-mp-mode"]:checked')?.value;
  if (!superMode) missingFields.push({ key:'super', label:'Solo / Duo-group decision (Step 5)', targetId:'rv-mp-solo-row', type:'note', placeholder:'Pick one in Step 5' });

  // Already-paid check — driven ONLY by the booking(s) the user TICKED in the Zoho picker
  // (a red dot = paid). Reads the live checkboxes (invoiceBookingData isn't saved until Confirm),
  // so it never fuzzy-matches an unrelated booking like it used to.
  let alreadyPaidWarn = '';
  let paidBookingId = '';
  try {
    const checked = Array.from(document.querySelectorAll('.rv-booking-cb:checked'));
    const paidCb = checked.find(cb => cb.dataset.paid === '1');
    if (paidCb) {
      paidBookingId = paidCb.dataset.bid || '';
      const bn = paidCb.dataset.name ? ` (“${paidCb.dataset.name}”)` : '';
      alreadyPaidWarn = `The booking you selected${bn} appears <strong>already marked paid in Zoho</strong>. Confirm only if you intend to pay it again.`;
    }
  } catch (e) { /* non-fatal */ }

  if (!missingFields.length && !alreadyPaidWarn) return Promise.resolve(true); // nothing to flag

  const headerTxt = alreadyPaidWarn && !missingFields.length ? '⚠ Already paid in Zoho'
                  : alreadyPaidWarn ? '⚠ Check before confirming'
                  : '⚠ Missing fields';
  const bookingLink = paidBookingId
    ? `<a href="https://crm.zoho.com/crm/org657079535/tab/Potentials/${paidBookingId}" target="_blank" rel="noopener"
         style="display:inline-block;margin-top:7px;font-size:11px;font-weight:600;color:#2F6FB3;text-decoration:none;background:#EAF2FB;border:1px solid rgba(96,165,250,0.35);border-radius:5px;padding:4px 9px">↗ Check that Zoho booking</a>`
    : '';
  const paidBanner = alreadyPaidWarn
    ? `<div style="font-size:12px;color:#B91C1C;background:rgba(197,48,48,0.15);border:1px solid rgba(252,129,129,0.4);border-radius:6px;padding:8px 10px;margin-bottom:${missingFields.length?'12px':'16px'};line-height:1.5">${alreadyPaidWarn}${bookingLink}</div>`
    : '';

  // Build popup with an editable input for each missing field
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:#F4F6F8;border:1px solid #E4E8EC;border-radius:10px;padding:22px 26px;max-width:400px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,0.55)">
      <div style="font-size:14px;font-weight:700;color:#8A5B12;margin-bottom:6px">${headerTxt}</div>
      ${paidBanner}
      ${missingFields.length ? '<div style="font-size:12px;color:#5B6B7B;margin-bottom:14px">Fill in below and click <strong style="color:#1B2733">Confirm</strong>, or <strong style="color:#1B2733">Go back</strong> to complete the form.</div>' : ''}
      <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:16px">
        ${missingFields.map(f => `
          <div>
            <label style="font-size:10px;color:#5B6B7B;font-weight:600;text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:3px">${f.label}</label>
            <input type="${f.type}" id="rv-val-${f.key}" placeholder="${f.placeholder}"
              ${f.type==='number' ? 'step="0.01" min="0"' : ''}
              style="width:100%;font-size:12px;padding:6px 9px;border:1px solid #C0362C;border-radius:5px;background:#FFFFFF;color:#1B2733;outline:none">
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="rv-val-cancel" style="background:#F0F3F6;color:#ccc;border:1px solid #CBD5E0;border-radius:5px;padding:6px 14px;font-size:12px;cursor:pointer">Go back</button>
        <button id="rv-val-ok" style="background:#27AE60;color:#1B2733;border:none;border-radius:5px;padding:6px 16px;font-size:12px;font-weight:700;cursor:pointer">✓ Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Focus the first input
  setTimeout(() => overlay.querySelector('input')?.focus(), 60);

  return new Promise(resolve => {
    overlay.querySelector('#rv-val-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('#rv-val-ok').onclick = () => {
      // Copy non-empty popup values back to the actual form fields before confirming
      missingFields.forEach(f => {
        const popupInput = overlay.querySelector('#rv-val-' + f.key);
        const formInput  = document.getElementById(f.targetId);
        if (popupInput && formInput && (popupInput.value || '').trim()) {
          formInput.value = popupInput.value.trim();
          if (f.targetId === 'rv-perfdate') updatePerfDateDOW();
          if (f.targetId === 'rv-total') rvUpdateServiceFee();
        }
      });
      overlay.remove();
      resolve(true);
    };
    // Also allow Enter key to confirm
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Enter') { overlay.querySelector('#rv-val-ok').click(); }
      if (e.key === 'Escape') { overlay.querySelector('#rv-val-cancel').click(); }
    });
  });
}

function closeReviewModal() {
  const modal = document.getElementById('review-modal');
  if (modal) modal.style.display = 'none';
  const frame = document.getElementById('rv-pdf-frame');
  if (frame) { frame.src = ''; frame.style.display = ''; }
  const noPdfMsg = document.getElementById('rv-no-pdf-msg');
  if (noPdfMsg) noPdfMsg.style.display = 'none';
  document.body.style.overflow = '';
  reviewModalRowId = null;
}

// A reviewable row must have at least a name or a total — the blank starter manual row is
// skipped so "Last Invoice — Finish" doesn't navigate into an empty Review screen.
function reviewableRowIds() {
  return [
    ...Array.from(document.querySelectorAll('#pdf-tbody tr[id]')),
    ...Array.from(document.querySelectorAll('#ap-review-tbody tr[id]')),
    ...Array.from(document.querySelectorAll('#manual-tbody tr[id]')),
  ].map(tr => tr.id.replace('row-', '')).filter(Boolean).filter(id => {
    const n = (document.getElementById('name-' + id)?.value || '').trim();
    const t = (document.getElementById('total-' + id)?.value || '').trim();
    return !!(n || t) || String(reviewModalRowId) === String(id);
  });
}

function reviewViewPrevious() {
  // Navigate to the previous invoice in DOM order without confirming the current one
  const allRows = reviewableRowIds();
  const currentIdx = allRows.indexOf(String(reviewModalRowId));
  if (currentIdx <= 0) return; // already at the first
  const prevId = allRows[currentIdx - 1];
  closeReviewModal();
  setTimeout(() => openReviewModal(prevId), 80);
}

function reviewViewNext() {
  // Navigate to the next invoice in DOM order without confirming the current one
  const allRows = reviewableRowIds();
  const currentIdx = allRows.indexOf(String(reviewModalRowId));
  if (currentIdx < 0 || currentIdx >= allRows.length - 1) return; // already at the last
  const nextId = allRows[currentIdx + 1];
  closeReviewModal();
  setTimeout(() => openReviewModal(nextId), 80);
}

// Remove the current invoice from the run without leaving the Review modal.
// Cleans up all per-invoice data stores, then advances to the next invoice
// (preferring an unreviewed one) — or closes the modal if none remain.
function reviewRemoveInvoice() {
  const id = reviewModalRowId;
  if (id == null) return;

  const nm = (document.getElementById('name-' + id)?.value || '').trim();
  if (!confirm(`Remove this invoice${nm ? ' for ' + nm : ''} from the run?\n\nIt will be taken out of the list and won't be included in any export. This can't be undone.`)) return;

  // Decide where to go next BEFORE the row is removed.
  const allRows = reviewableRowIds();
  const currentIdx = allRows.indexOf(String(id));
  const candidates = [
    ...allRows.slice(currentIdx + 1),
    ...allRows.slice(0, currentIdx),
  ].filter(rid => String(rid) !== String(id));
  const nextId = candidates.find(rid => !reviewedRows.has(String(rid))) || candidates[0] || null;

  // Drop it from the review/flag tracking sets.
  reviewedRows.delete(String(id));
  flaggedRows.delete(String(id));

  // Clear every per-invoice data store keyed by this id (mirrors clearAllInvoices).
  [invoiceGSTData, invoiceExpenseData, invoiceBookingData, invoiceRawText, invoiceSuperShareData, invoiceSuperModeData,
   window.invoiceSuperData, window.invoicePaidData, window.invoiceTypeData].forEach(store => {
    if (store) delete store['id_' + id];
  });
  delete invoicePerfGuess['id_' + id];

  // Close, then remove the row (revokes its PDF URL + updates the process count).
  closeReviewModal();
  removeRow(id);

  if (nextId) setTimeout(() => openReviewModal(nextId), 80);
}

async function reviewConfirmAndNext() {
  // Collect all reviewable row IDs in DOM order (skips the blank starter row)
  const allRows = reviewableRowIds();

  const currentId = reviewModalRowId;

  // Validate before saving
  const ok = await rvValidateBeforeConfirm();
  if (!ok) return;

  // Save & close current invoice (this sets reviewedRows and nulls reviewModalRowId)
  reviewLooksGood();

  // Find next unreviewed row after the one we just confirmed
  const currentIdx = allRows.indexOf(String(currentId));
  const candidates = [
    ...allRows.slice(currentIdx + 1),
    ...allRows.slice(0, currentIdx),
  ];
  const nextId = candidates.find(id => !reviewedRows.has(String(id)));

  if (nextId) {
    // Small delay so the modal close animation completes before re-opening
    setTimeout(() => openReviewModal(nextId), 80);
  } else {
    // All invoices reviewed — modal already closed by reviewLooksGood()
    setTimeout(() => {
      const total = allRows.length;
      alert(`✓ All ${total} invoice${total!==1?'s':''} reviewed! You can now proceed to Stage 2.`);
    }, 80);
  }
}

function rvUpdateNextPrevButtons() {
  // Called from openReviewModal — updates Previous button visibility and Next button label
  const allRows = reviewableRowIds();

  const currentIdx = allRows.indexOf(String(reviewModalRowId));

  // Previous button — dim if at the first invoice
  const prevBtn = document.getElementById('rv-prev-btn');
  if (prevBtn) {
    prevBtn.style.opacity = currentIdx <= 0 ? '0.35' : '1';
    prevBtn.style.pointerEvents = currentIdx <= 0 ? 'none' : '';
  }

  // Next button (non-actioning scan) — dim if at the last invoice
  const nextScanBtn = document.getElementById('rv-next-btn');
  if (nextScanBtn) {
    const atLast = currentIdx < 0 || currentIdx >= allRows.length - 1;
    nextScanBtn.style.opacity = atLast ? '0.35' : '1';
    nextScanBtn.style.pointerEvents = atLast ? 'none' : '';
  }

  // Confirm & Next button — change text if this is the last unreviewed
  const nextBtn = document.getElementById('rv-save-next-btn');
  if (nextBtn) {
    const candidates = [
      ...allRows.slice(currentIdx + 1),
      ...allRows.slice(0, currentIdx),
    ];
    const hasNext = candidates.some(id => !reviewedRows.has(String(id)));
    if (hasNext) {
      nextBtn.innerHTML = '✓ Confirm &amp; Next';
      nextBtn.title = 'Save and automatically open the next unreviewed invoice';
    } else {
      nextBtn.textContent = '✓ Last Invoice — Finish';
      nextBtn.title = 'All invoices reviewed. Confirm and close the review screen.';
    }
  }
}

// Tab-key focus trap within the review modal
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('review-modal');
  if (!modal) return;
  modal.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeReviewModal(); return; }
    if (e.key !== 'Tab') return;
    const els = Array.from(modal.querySelectorAll(
      'input:not([tabindex="-1"]):not([disabled]), button:not([tabindex="-1"]):not([disabled])'
    )).filter(el => el.offsetParent !== null);
    if (!els.length) return;
    const idx = els.indexOf(document.activeElement);
    e.preventDefault();
    if (e.shiftKey) {
      els[(idx - 1 + els.length) % els.length].focus();
    } else {
      els[(idx + 1) % els.length].focus();
    }
  });
  // Offer to restore a previous session if one exists
  setTimeout(sessionCheckRestore, 300);
});

function reviewFlagIssue() {
  const id = reviewModalRowId;
  if (!id) return;
  flaggedRows.add(String(id));
  // Update Stage 1 button to amber "⚠ Attention" state
  const btn = document.getElementById('rv-btn-'+id);
  if (btn) {
    btn.style.background = '#FFFBEB';
    btn.style.border = '1px solid #E8A020';
    btn.style.color = '#92400E';
    btn.style.fontWeight = '600';
    btn.innerHTML = '⚠ Attention';
  }
  // Update flag button in modal
  const flagBtn = document.getElementById('rv-flag-btn');
  if (flagBtn) { flagBtn.style.background = '#E6D3A8'; flagBtn.textContent = '⚠ Flagged'; }
  closeReviewModal();
}

function reviewSearchContractor(query) {
  const drop = document.getElementById('rv-drop');
  if (!drop) return;
  const q = (query || '').trim().toLowerCase();
  if (q.length < 2) { drop.style.display = 'none'; return; }
  const matches = contractors.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.xeroName && c.xeroName.toLowerCase().includes(q)) ||
    (c.abn && c.abn.includes(q))
  ).slice(0, 8);
  if (!matches.length) {
    drop.innerHTML = '<div style="padding:8px;font-size:12px;color:#888">No matches</div>';
    drop.style.display = 'block'; return;
  }
  drop.innerHTML = matches.map(c => {
    const tl = `<span class="badge badge-${(c.type||'a').toLowerCase()}" style="font-size:9px;padding:1px 5px;margin-left:4px">${c.type}</span>`;
    const sl = c.superEligible ? '<span style="color:#27AE60;font-size:10px;margin-left:4px">✓ Super</span>' : '';
    // Surface the xeroName as a secondary line when it differs from the primary name — helps
    // the user spot that "Pete (Indigo) Mitchell" is the right pick for a "JAZZ TO ROCK" invoice.
    const xn = c.xeroName && c.xeroName.toLowerCase() !== c.name.toLowerCase()
      ? `<div style="font-size:10px;color:#94A3B8;margin-top:1px">↗ Xero: ${escHtml(c.xeroName)}</div>`
      : '';
    return `<div class="contractor-option" onmousedown="reviewSelectContractor('${c.zohoId}')">
      <span class="opt-name">${escHtml(c.name)}</span>${tl}${sl}${xn}
      <span class="opt-abn">${c.abn||'—'}</span>
    </div>`;
  }).join('');
  drop.style.display = 'block';
}

function reviewSelectContractor(zohoId) {
  const c = contractors.find(x => x.zohoId === zohoId);
  if (!c) return;
  document.getElementById('rv-name').value = c.name;
  // Fill ABN from the Zoho record — important for invoices that don't print an ABN
  // (e.g. MEC-template invoices like INV12245). Show the "from Zoho" badge so it's clear.
  if (c.abn) {
    const abnEl = document.getElementById('rv-abn');
    if (abnEl) abnEl.value = c.abn;
    const badge = document.getElementById('rv-abn-zoho-badge');
    if (badge) badge.style.display = 'inline-block';
  }
  if (c.gst !== undefined) document.getElementById('rv-gst').checked = !!c.gst;
  document.getElementById('rv-drop').style.display = 'none';
  if (typeof rvUpdateTotalBreakdown === 'function') rvUpdateTotalBreakdown();
  updateReviewStatus();
}

// Helper: human-readable contractor type description
function rvTypeDesc(type) {
  return {
    'A': 'Individual — no GST',
    'B': 'Individual — GST registered',
    'C': 'Company / Trust — no GST',
    'D': 'Company / Trust — GST registered'
  }[(type||'').toUpperCase()] || `Type ${type}`;
}

// Helper: ABR entity type code → readable label
function rvAbrEntityDesc(r) {
  return {
    'IND': 'Individual / Sole Trader',
    'PRV': 'Proprietary Company (Pty Ltd)',
    'PUB': 'Public Company',
    'TRT': 'Trust',
    'PTR': 'Partnership',
    'LTD': 'Limited Company',
    'CCIV': 'Corporate Collective Investment Vehicle'
  }[r.entityTypeCode] || (r.entityTypeDesc || r.entityTypeCode || 'Unknown entity');
}

function updateReviewStatus() {
  const zohoEl = document.getElementById('rv-zoho-content');
  const abrEl  = document.getElementById('rv-abr-content');
  if (!zohoEl) return;

  const nameVal = (document.getElementById('rv-name')?.value || '').trim();
  const abnVal  = (document.getElementById('rv-abn')?.value  || '').replace(/\s/g, '');

  // ── Comparison table helpers ──
  const cmp = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const YES = (txt) => `<span style="color:#1F9D63;font-weight:600">✓ ${txt}</span>`;
  const NO  = (txt) => `<span style="color:#5B6B7B">${txt}</span>`;
  const WARN= (txt) => `<span style="color:#C0362C;font-weight:600">⚠ ${txt}</span>`;
  const MUTED = (txt) => `<span style="color:#5B6B7B">${txt}</span>`;

  // ── Zoho column ──
  const match = contractors.find(c =>
    c.name.toLowerCase() === nameVal.toLowerCase() ||
    (abnVal.length === 11 && c.abn && c.abn.replace(/\s/g, '') === abnVal)
  );

  if (match) {
    const isPartnership = /partner/i.test(match.structure || '');
    const typeDesc = isPartnership
      ? ('Partnership' + (match.gst ? ' — GST registered' : ' — no GST'))
      : rvTypeDesc(match.type);
    const fundNote = match.fundName ? ` <span style="color:#5B6B7B;font-size:10px">(${escHtml(match.fundName)})</span>` : '';
    // Surface the exact Xero entity name (the bill "From"). If Zoho has none, flag it —
    // that's why a bill would fall back to the Team-record name.
    const xn = (match.xeroName || '').trim();
    const xeroNote = xn
      ? (xn !== (match.name || '').trim()
          ? `<br><span style="color:#5B6B7B;font-size:9px">→ Xero: ${escHtml(xn)}</span>`
          : '')
      : `<br><span style="color:#B45309;font-size:9px">⚠ no Xero entity name in Zoho — bill will use this name</span>`;
    cmp('rv-cmp-zoho-name',   `<span style="color:#1B2733;font-weight:600">${escHtml(match.name)}</span>${xeroNote}`);
    cmp('rv-cmp-zoho-entity', `${escHtml(typeDesc)} · <strong style="color:#1B2733">Type ${match.type}</strong>`);
    cmp('rv-cmp-zoho-gst',    match.gst ? YES('Registered') : NO('Not registered'));
    cmp('rv-cmp-zoho-super',  match.superEligible ? YES('Deducted') + fundNote : NO('Not required'));
    cmp('rv-cmp-zoho-abn',    match.abn ? MUTED(match.abn) : MUTED('—'));
  } else if (nameVal) {
    const zohoSearchURL = `https://crm.zoho.com/crm/org657079535/search?searchword=${encodeURIComponent(nameVal)}&isRelevance=false`;
    const notFound = `${WARN('Not in Zoho')} <a href="${zohoSearchURL}" target="_blank" style="color:#2F6FB3;font-size:10px;text-decoration:none;margin-left:4px">🔍 Search</a>`;
    cmp('rv-cmp-zoho-name',   notFound);
    cmp('rv-cmp-zoho-entity', MUTED('—'));
    cmp('rv-cmp-zoho-gst',    MUTED('—'));
    cmp('rv-cmp-zoho-super',  MUTED('—'));
    cmp('rv-cmp-zoho-abn',    MUTED('—'));
  } else {
    ['rv-cmp-zoho-name','rv-cmp-zoho-entity','rv-cmp-zoho-gst','rv-cmp-zoho-super','rv-cmp-zoho-abn'].forEach(id => cmp(id, MUTED('—')));
  }

  // ── ABR column ──
  if (!abrEl) return;
  if (abnVal.length === 11 && abrCache[abnVal]) {
    const r = abrCache[abnVal];
    const entityDesc = rvAbrEntityDesc(r);
    const icon = r.isCompany ? '🏢 ' : '👤 ';
    cmp('rv-cmp-abr-name',   `<span style="color:#1B2733;font-weight:600">${icon}${escHtml(r.entityName || '—')}</span>`);
    cmp('rv-cmp-abr-entity', MUTED(escHtml(entityDesc)));
    cmp('rv-cmp-abr-gst',    r.isGST ? YES('Registered') : NO('Not registered'));
    cmp('rv-cmp-abr-super',  !r.isCompany ? YES('Eligible (individual)') : NO('Not required'));
    cmp('rv-cmp-abr-abn',    r.isActive ? YES('Active') : WARN('Not active'));
  } else if (abnVal.length === 11) {
    ['rv-cmp-abr-name','rv-cmp-abr-entity','rv-cmp-abr-gst','rv-cmp-abr-super'].forEach(id => cmp(id, MUTED('—')));
    cmp('rv-cmp-abr-abn', MUTED('Pending lookup…'));
  } else {
    ['rv-cmp-abr-name','rv-cmp-abr-entity','rv-cmp-abr-gst','rv-cmp-abr-super','rv-cmp-abr-abn'].forEach(id => cmp(id, MUTED('—')));
  }

  // Mirror Step 1's identity popover into Step 5's hover so both look identical. Clone-and-strip-IDs
  // keeps the DOM valid (no duplicate IDs) while showing the same full Zoho / ABR table.
  const stepSrc = document.getElementById('rv-step1-id-pop');
  const stepDst = document.getElementById('rv-super-id-mirror');
  if (stepSrc && stepDst) {
    stepDst.innerHTML = '';
    Array.from(stepSrc.children).forEach(child => {
      const c = child.cloneNode(true);
      if (c.id) c.removeAttribute('id');
      c.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      stepDst.appendChild(c);
    });
  }

  // ── Booking links (right-side date panel) ──
  const bookLinkEl = document.getElementById('rv-booking-link');
  if (bookLinkEl) {
    const perfVal  = document.getElementById('rv-perfdate')?.value || '';
    const dateVal  = document.getElementById('rv-date')?.value || '';
    const abnVal2  = (document.getElementById('rv-abn')?.value||'').replace(/\s/g,'');
    const PAY_VIEW = 'https://crm.zoho.com/crm/org657079535/tab/Potentials/custom-view/2877869000001220059/list';
    const payViewBtn = `<a href="${PAY_VIEW}" target="_blank"
      style="display:inline-block;background:#FBF1DE;color:#8A5B12;border:1px solid #E6D3A8;border-radius:5px;padding:3px 9px;font-size:11px;text-decoration:none">📋 Pay Entertainer view</a>`;

    // Resolve matched contractor
    const zohoMatch = contractors.find(c =>
      c.name.toLowerCase() === nameVal.toLowerCase() ||
      (abnVal2.length === 11 && c.abn && c.abn.replace(/\s/g,'') === abnVal2)
    );
    const teamBtn = zohoMatch?.zohoId
      ? `<a href="https://crm.zoho.com/crm/org657079535/tab/CustomModule3/${zohoMatch.zohoId}" target="_blank"
          style="display:inline-block;background:rgba(96,165,250,0.1);color:#2F6FB3;border:1px solid #BBD6F2;border-radius:5px;padding:3px 9px;font-size:11px;text-decoration:none">👤 Team record in Zoho</a>`
      : '';

    let html = '';

    if (zohoMatch?.zohoId && bookings.length) {
      // ── Exact-ID lookup: show full booking history for this contractor ──
      const refDate = perfVal || dateVal || '';
      const cbList  = getContractorBookings(zohoMatch.zohoId, refDate);
      if (cbList.length) {
        // Mini-table: show up to 12 closest bookings in a scrollable panel, with checkboxes
        const storedSel = invoiceBookingData['id_' + reviewModalRowId] || null;
        const storedIds = new Set((storedSel || []).map(s => s.bookingId));
        // Auto-select: restore stored, or default to closest 1 booking if nothing stored
        const autoSelect = id => storedSel ? storedIds.has(id) : false;

        // Split into UNPAID (select to pay) and ALREADY-PAID (history, for double-pay checks).
        // Each list keeps the date-proximity order from getContractorBookings.
        const unpaidList = cbList.filter(m => !m.entertainer.paid);
        const paidList   = cbList.filter(m =>  m.entertainer.paid);
        let autoDefaultDone = false;   // default-check the closest UNPAID booking only
        const renderRow = (m) => {
          const url = `https://crm.zoho.com/crm/org657079535/tab/Potentials/${m.booking.id}`;
          const evtDate = m.booking.eventDate
            ? new Date(m.booking.eventDate+'T12:00:00').toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short',year:'2-digit'})
            : '—';
          const daysLabel = m.daysDiff < 9999 ? `${Math.round(m.daysDiff)}d` : '';
          const paidDot = m.entertainer.paid
            ? '<span style="color:#C0362C;font-weight:700" title="Already paid in Zoho">●</span>'
            : '<span style="color:#1F9D63;font-weight:700" title="Not yet marked paid in Zoho">●</span>';
          const cost = m.entertainer.cost != null ? `$${m.entertainer.cost.toLocaleString()}` : '—';
          let isChecked = autoSelect(m.booking.id);
          if (!storedSel && !autoDefaultDone && !m.entertainer.paid) { isChecked = true; autoDefaultDone = true; }
          const cbId = 'rvcb-' + m.booking.id;
          return `<tr style="border-bottom:1px solid #F0F3F6;${m.entertainer.paid?'opacity:0.75':''}">
            <td style="padding:3px 4px;width:22px;vertical-align:middle">
              <input type="checkbox" class="rv-booking-cb" id="${cbId}"
                onchange="rvBookingSelectionChanged(true)"
                data-bid="${m.booking.id}"
                data-cost="${m.entertainer.cost || 0}"
                data-date="${m.booking.eventDate || ''}"
                data-name="${escHtml(m.booking.bookingName||'')}"
                data-paid="${m.entertainer.paid ? '1' : ''}"
                ${isChecked ? 'checked' : ''}
                style="accent-color:#1F9D63;cursor:pointer;width:13px;height:13px">
            </td>
            <td style="padding:3px 4px;white-space:nowrap;text-align:center">${paidDot}</td>
            <td style="padding:3px 4px;white-space:nowrap;font-size:10px;color:#5B6B7B">${evtDate}</td>
            <td style="padding:3px 4px;font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              <a href="${url}" target="_blank" style="color:#2F6FB3;text-decoration:none" title="${escHtml(m.booking.bookingName||'')}">${escHtml(m.booking.bookingName||'—')}</a>
            </td>
            <td style="padding:3px 4px;white-space:nowrap;font-size:10px;color:#5B6B7B;text-align:right">${cost}</td>
            <td style="padding:3px 4px;white-space:nowrap;font-size:10px;color:#5B6B7B;text-align:right">${daysLabel}</td>
          </tr>`;
        };
        const sectionRow = (label, color) =>
          `<tr><td colspan="6" style="padding:5px 6px;background:#F2F5F8;font-size:9px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:${color}">${label}</td></tr>`;
        const thStyle = 'padding:4px 4px;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#5B6B7B;border-bottom:1px solid #E4E8EC';
        const thead = `<thead><tr>
            <th style="${thStyle};width:22px"></th>
            <th style="${thStyle};text-align:center">Paid?</th>
            <th style="${thStyle};text-align:left">Event date</th>
            <th style="${thStyle};text-align:left">Booking</th>
            <th style="${thStyle};text-align:right">Cost<br><span id="rv-cost-tally" style="font-weight:700;font-size:10px;color:#1F9D63">—</span></th>
            <th style="${thStyle};text-align:right">Near</th>
          </tr></thead>`;
        let body = '';
        if (unpaidList.length)
          body += sectionRow('🟢 Unpaid — select the booking(s) this invoice covers', '#1F9D63')
                + unpaidList.slice(0,15).map(renderRow).join('');
        if (paidList.length)
          body += sectionRow('🔴 Already paid (history — watch for double-invoicing)', '#B91C1C')
                + paidList.slice(0,8).map(renderRow).join('');
        if (!body) body = '<tr><td colspan="6" style="padding:6px;color:#5B6B7B;font-size:10px">No bookings found.</td></tr>';
        const extraUnpaid = Math.max(0, unpaidList.length - 15);
        const extraPaid   = Math.max(0, paidList.length - 8);
        const remaining = (extraUnpaid || extraPaid)
          ? `<div style="font-size:10px;color:#5B6B7B;padding:3px 5px">${extraUnpaid?`+ ${extraUnpaid} more unpaid `:''}${extraPaid?`· ${extraPaid} more paid`:''} — see Pay Entertainer view</div>` : '';
        const totalBar = `<div id="rv-booking-total-bar" style="display:flex;align-items:center;gap:6px;padding:4px 7px;background:#F2F5F8;border:1px solid #FFFFFF;border-radius:5px;margin-top:3px;flex-wrap:wrap"></div>`;
        html = `<div style="overflow-y:auto;max-height:260px;border:1px solid #FFFFFF;border-radius:5px;background:#F7F9FB"><table style="width:100%;border-collapse:collapse">${thead}<tbody>${body}</tbody></table></div>${remaining}${totalBar}`;
      } else {
        // Matched contractor but no bookings in cache window
        html = `<div style="font-size:11px;color:#5B6B7B">No bookings in cache (cache covers ~12 months). Check Zoho directly.</div>`;
      }
    } else if (!bookings.length) {
      // No Zoho booking data loaded this session — the table can't be built.
      html = `<div style="font-size:11px;color:#8A5B12;background:#FBF1DE;border:1px solid #E6D3A8;border-radius:6px;padding:8px 10px;line-height:1.5">
        ⚠ <strong>No Zoho bookings loaded this session.</strong> Go to <strong>Step 1</strong> and hit <strong>↻ Refresh from Zoho</strong> — the booking(s) for this contractor will then appear here to tick.</div>`;
    } else if (nameVal) {
      // ── Fuzzy fallback when contractor not matched ──
      const totalVal = parseFloat(document.getElementById('rv-total')?.value||'0');
      const allMatches = findAllBookingMatches(nameVal, totalVal, perfVal, dateVal);
      if (allMatches.length) {
        const matchLinks = allMatches.slice(0, 3).map((m, i) => {
          const url = `https://crm.zoho.com/crm/org657079535/tab/Potentials/${m.booking.id}`;
          const evtDate = m.booking.eventDate ? new Date(m.booking.eventDate+'T12:00:00').toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'}) : '';
          const paidLabel = m.entertainer.paid ? ' · <span style="color:#C0362C">paid</span>' : '';
          const costLabel = m.costMatch === true ? ' · <span style="color:#1F9D63">cost ✓</span>' : '';
          const accent = i===0 ? 'rgba(52,211,153,0.1)' : '#F4F6F8';
          const border = i===0 ? '#BCE3CE' : '#F0F3F6';
          const col = i===0 ? '#1F9D63' : '#5B6B7B';
          return `<a href="${url}" target="_blank" style="display:block;background:${accent};color:${col};border:1px solid ${border};border-radius:5px;padding:3px 8px;font-size:11px;text-decoration:none;margin-bottom:2px">
            📅 ${escHtml(m.booking.bookingName||'')} <span style="font-size:10px;color:#5B6B7B">${evtDate}${paidLabel}${costLabel}</span></a>`;
        }).join('');
        const warn = '<div style="font-size:10px;color:#8A5B12;margin-bottom:3px">⚠ Fuzzy match — contractor not linked in Zoho</div>';
        html = warn + matchLinks;
      } else {
        const searchUrl = `https://crm.zoho.com/crm/org657079535/search?searchword=${encodeURIComponent(nameVal)}&isRelevance=false`;
        html = `<a href="${searchUrl}" target="_blank"
          style="display:inline-block;background:#F0F3F6;color:#5B6B7B;border:1px solid #FFFFFF;border-radius:5px;padding:3px 9px;font-size:11px;text-decoration:none">🔍 Search "${escHtml(nameVal)}" in Zoho</a>`;
      }
    }
    // Always show utility buttons
    html += `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">${payViewBtn}${teamBtn}</div>`;
    bookLinkEl.innerHTML = html;
    // Initialise totals bar now that checkboxes are in the DOM
    rvBookingSelectionChanged();
  }
}

function reviewOpenABR() {
  const abn = (document.getElementById('rv-abn')?.value || '').replace(/\s/g, '');
  if (abn.length !== 11 || !/^\d{11}$/.test(abn)) {
    const el = document.getElementById('rv-cmp-abr-abn');
    if (el) el.innerHTML = '<span style="color:#C0362C">Enter a valid 11-digit ABN first</span>';
    return;
  }
  // Open the ABR public record in a new browser tab
  window.open(`https://www.abr.business.gov.au/ABN/View?abn=${abn}`, '_blank');
  // Also run the JSONP lookup to populate the comparison panel
  reviewRunABR();
}

// Auto-calculated Subtotal / GST / Total breakdown shown in the prominent Total card.
// Live red-highlight of empty key fields (name / invoice # / event date / total) so they
// stand out before the user clicks Confirm.
function rvHighlightMissing() {
  ['rv-name','rv-inv','rv-perfdate','rv-total'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const empty = !(el.value || '').trim();
    el.style.borderColor = empty ? '#C0362C' : '#CBD5E0';
    el.style.boxShadow  = empty ? '0 0 0 2px rgba(252,129,129,0.30)' : '';
  });
  rvUpdateRail();
}

// ── Progress rail (Review modal) — reflects which of the 5 steps are complete ──
// Match phase: 1 contractor, 2 booking · Enter phase: 3 invoice facts, 4 reimbursements, 5 super.
// Steps 4/5 become reachable once a total is present (reimbursements optional; super has a default).
function rvUpdateRail() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const num = id => parseFloat(document.getElementById(id)?.value || '0') || 0;
  const name = val('rv-name');
  const abn  = val('rv-abn').replace(/\s/g, '');
  // Step 1 — contractor identified: matched in Zoho by name/ABN, or a valid 11-digit ABN (ABR-derived)
  const matched = !!(name && (
    (typeof contractors !== 'undefined' && contractors.some(c =>
      (c.name || '').toLowerCase() === name.toLowerCase() ||
      (abn.length === 11 && c.abn && String(c.abn).replace(/\s/g, '') === abn)))
    || abn.length === 11));
  // Step 2 — a booking is ticked AND its value matches the invoice total (same rule as the
  // on-screen "matches invoice" badge). An over/under-quote leaves it OPEN as a problem flag.
  const checkedCbs = Array.from(document.querySelectorAll('.rv-booking-cb:checked'));
  const bookingTotal = checkedCbs.reduce((s, cb) => s + (parseFloat(cb.dataset.cost) || 0), 0);
  const total = num('rv-total');
  const bookingMatched = checkedCbs.length > 0 && Math.abs(bookingTotal - total) <= 1;
  // Step 5 — the operator must explicitly pick Solo or Duo/Group; we never auto-decide.
  const superModePicked = !!document.querySelector('input[name="rv-mp-mode"]:checked');
  const stepDone = {
    1: matched,
    2: bookingMatched,
    3: !!val('rv-inv') && total > 0,
    4: total > 0,        // reimbursements optional — complete once the total is in
    5: superModePicked   // mandatory pick — until the radio is set, this stays open
  };
  // Sequential gating — a step only goes green once ALL prior steps are also green.
  const cumulative = { 1: stepDone[1] };
  for (let i = 2; i <= 5; i++) cumulative[i] = cumulative[i-1] && stepDone[i];
  let active = 0;
  for (let i = 1; i <= 5; i++) { if (!cumulative[i]) { active = i; break; } }
  for (let i = 1; i <= 5; i++) {
    const node = document.getElementById('rv-rail-' + i);
    if (!node) continue;
    node.classList.remove('rv-rail-node--done', 'rv-rail-node--active');
    node.innerHTML = String(i);
    if (cumulative[i]) node.classList.add('rv-rail-node--done');
    else if (i === active) node.classList.add('rv-rail-node--active');
  }
}

function rvUpdateTotalBreakdown() {
  const total = parseFloat(document.getElementById('rv-total')?.value || '0') || 0;
  const gstOn = !!document.getElementById('rv-gst')?.checked;
  rvHighlightMissing();
  const subEl = document.getElementById('rv-bd-subtotal');
  const gstEl = document.getElementById('rv-bd-gst');
  const totEl = document.getElementById('rv-bd-total');
  if (!subEl || !gstEl || !totEl) return;
  const money = n => '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const subtotal = gstOn ? total / 1.1 : total;
  const gstAmt   = gstOn ? total - subtotal : 0;
  subEl.textContent = total ? money(subtotal) : '—';
  gstEl.textContent = gstOn ? (total ? money(gstAmt) : '—') : '$0.00';
  totEl.textContent = total ? money(total) : '—';
}

function rvUpdateServiceFee() {
  rvUpdateTotalBreakdown();
  const num = id => parseFloat(document.getElementById(id)?.value || '0') || 0;
  const total = num('rv-total');
  const parking = num('rv-exp-parking');
  const accommodation = num('rv-exp-accommodation');
  const other = num('rv-exp-other');
  const travel = num('rv-exp-travel'); // legacy field (removed from UI) — always 0
  const reimbTotal = parking + accommodation + other + travel;
  // Super base = total minus the pure reimbursements (parking, accom, other). Travel stays in.
  const gstOn = !!document.getElementById('rv-gst')?.checked;
  const superBaseRaw = total - parking - accommodation - other;
  // When GST applies, super is assessed on the ex-GST service amount — reflect that in the display.
  const superBase = gstOn ? superBaseRaw / 1.1 : superBaseRaw;
  const money = n => '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Build reimbursement line items inside the Total card so pricing assembles live ──
  const reimbEl = document.getElementById('rv-bd-reimb');
  if (reimbEl) {
    const line = (lbl, amt) => amt > 0
      ? `<div style="display:flex;justify-content:space-between;color:#5B6B7B"><span>— ${lbl} <span style="color:#7A8896;font-size:9px">no super</span></span><span style="color:#1B2733">${money(amt)}</span></div>`
      : '';
    const lines = line('Parking', parking) + line('Accommodation', accommodation) + line('Other', other);
    reimbEl.innerHTML = reimbTotal > 0
      ? lines + `<div style="display:flex;justify-content:space-between;color:#1F9D63;font-weight:600"><span>Super base (service)</span><span>${money(superBase)}</span></div>`
      : '';
  }

  // ── Parking over $25 → proof-of-receipt + flag-the-producer prompt ──
  const pWarn = document.getElementById('rv-parking-warn');
  if (pWarn) {
    if (parking > 25) {
      pWarn.style.display = 'block';
      pWarn.innerHTML = `⚠ <strong>Parking ${money(parking)} is over $25.</strong> Ask the contractor for a proof-of-receipt, and flag the producer to on-invoice the client.`;
    } else {
      pWarn.style.display = 'none';
    }
  }

  // Legacy inline service-fee text now lives in the Total card (rv-bd-reimb)
  const el = document.getElementById('rv-service-fee-display');
  if (el) el.innerHTML = '';

  // Refresh Card 5 inline identity strip (saves the user a hover)
  rvUpdateInlineIdentity();
  scheduleRailAlign();
}

// ── Duo / group super panel (Review modal) ────────────────────────────────────
// Shows/hides the amber multi-performer prompt for the current invoice and seeds its mode.
// Mandatory super decision: the user MUST pick 'solo' or 'group' per invoice. The hidden
// rv-super checkbox is driven by the radio so the rest of the export pipeline keeps working
// against the same canonical 'withhold super' flag.
// Populate the inline identity strip in Card 5 — saves the user from having to hover.
function rvUpdateInlineIdentity() {
  const el = document.getElementById('rv-super-identity-inline');
  if (!el) return;
  const name = (document.getElementById('rv-name')?.value || '').trim();
  const abn  = (document.getElementById('rv-abn')?.value || '').trim().replace(/\s/g,'');
  const gstOn = !!document.getElementById('rv-gst')?.checked;
  // Look up the matched contractor by NAME (Zoho record), and capture the ABR data we have
  // for the invoice's ABN (which may differ from Zoho's stored ABN — talent-manager case).
  let zohoRec = null;
  if (name && typeof contractors !== 'undefined' && Array.isArray(contractors)) {
    zohoRec = contractors.find(c => (c.name||'').toLowerCase() === name.toLowerCase()) || null;
  }
  // ABR data for THIS invoice's ABN, if we've already looked it up
  let abrData = null;
  if (typeof abrRowData !== 'undefined' && reviewModalRowId) {
    abrData = abrRowData['id_' + reviewModalRowId] || null;
  }
  // Decide which entity type to surface. Priority:
  //   1. ABR-derived (truth from the invoice ABN, e.g. "Pty Ltd") — uses isCompany flag
  //   2. Zoho record's type field
  //   3. Inferred from GST checkbox
  // NB: abrData fields are { isCompany, isGST, entityName, entityTypeDesc } — NOT entityType.
  const zohoAbn0 = (zohoRec && zohoRec.abn || '').replace(/\s/g,'');
  const abnsDiffer = abn && zohoAbn0 && abn !== zohoAbn0;
  let entity = '—';
  let entitySource = '';
  if (abrData && (abrData.isCompany === true || abrData.isCompany === false)) {
    // Prefer ABR when we have a definitive entity classification — especially when ABNs differ
    // from Zoho (talent-manager case: Ellie's invoice ABN belongs to LJN CREATIVE PTY LTD).
    if (abrData.isCompany) {
      entity = gstOn ? 'Partnerships, Companies, or Trusts (plus GST)' : 'Partnerships, Companies, or Trusts (no GST)';
    } else {
      entity = gstOn ? 'Individual Sole Trader (plus GST)' : 'Individual Sole Trader (no GST)';
    }
    entitySource = 'from ABR';
  } else if (zohoRec) {
    const t = zohoRec.type || (gstOn ? 'B' : 'A');
    entity = ({ A:'Individual Sole Trader (no GST)', B:'Individual Sole Trader (plus GST)',
                C:'Partnerships, Companies, or Trusts (no GST)', D:'Partnerships, Companies, or Trusts (plus GST)' })[t] || t;
    entitySource = 'from Zoho';
  }
  if (!name && !abn) { el.style.display = 'none'; return; }

  // ABN-mismatch warning — invoice ABN differs from Zoho's stored ABN for this contractor.
  // Almost always means a talent manager / company is invoicing on the performer's behalf.
  // The invoice ABN is the source of truth for super eligibility + GST.
  const abrIsCompany = abrData && abrData.isCompany === true;
  const warn = (abnsDiffer || abrIsCompany)
    ? `<div style="margin-top:6px;padding:7px 10px;background:#FFFBEA;border:1px solid #FDE68A;border-radius:5px;color:#7A5A12;font-size:11px;line-height:1.5">
         ⚠ <strong>Invoice ABN differs from Zoho record${abrIsCompany ? ' — entity is a company/trust' : ''}.</strong>
         ${abrIsCompany ? `Pick <em>Not applicable — entity structure</em> below so super isn't withheld${zohoRec && zohoRec.name ? ' (the bill goes to ' + escHtml((abrData && abrData.entityName) || 'this company') + ', not ' + escHtml(zohoRec.name) + ' personally)' : ''}.` : 'Verify which ABN is correct before approving.'}
       </div>`
    : '';

  el.style.display = 'block';
  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center">
      <span><strong style="color:#1B2733">${escHtml(name) || '—'}</strong></span>
      ${abn ? `<span style="color:#7A8896">ABN ${escHtml(abn)}</span>` : ''}
      <span style="color:#7A8896">${escHtml(entity)}${entitySource ? ` <span style="color:#94A3B8;font-size:10px">(${entitySource})</span>` : ''}</span>
      <span style="color:${gstOn ? '#1F9D63' : '#94A3B8'};font-weight:600">${gstOn ? '+ GST' : 'no GST'}</span>
    </div>
    ${warn}`;
}

function rvSyncMultiPerfPanel(id) {
  const panel = document.getElementById('rv-multiperf');
  const plain = document.getElementById('rv-super-plain');
  if (!panel) return;
  if (plain) plain.style.display = 'none';
  const g = el => document.getElementById(el);

  // Advisory hint — multi-performer detection still flags possible duo/group bookings, but the
  // user still picks. We don't auto-decide.
  const name  = g('rv-name')?.value || '';
  const abn   = (g('rv-abn')?.value || '').replace(/\s/g, '');
  const total = parseFloat(g('rv-total')?.value || '0') || 0;
  const date  = g('rv-date')?.value || g('rv-perfdate')?.value || '';
  const match = matchContractor(name, abn);
  const flag  = multiPerfFlag(id, match, name, total, date);
  const hint  = g('rv-super-hint');
  if (hint) {
    if (flag.level) {
      hint.style.display = 'block';
      const reasonEl = g('rv-multiperf-reason');
      if (reasonEl) reasonEl.textContent = flag.reasons.join('; ') + '.';
    } else {
      hint.style.display = 'none';
    }
  }

  // Detect a non-individual entity (Zoho structure or type, plus ABR fallback). For these, super
  // isn't withheld at all, so we auto-pick 'na' instead of prompting the operator for solo/duo.
  const nonIndividualByZoho = !!(match && (
    ['C','D'].includes(match.type) ||
    /pty|company|trust|ltd|corp|partner/i.test(match.structure || '')
  ));
  const nonIndividualByABR  = !!(typeof abrCache !== 'undefined' && abrCache[abn] && abrCache[abn].isCompany);
  const isNonIndividual = nonIndividualByZoho || nonIndividualByABR;
  // Friendly label for the auto-na banner
  let entityKind = 'Company / Trust / Partnership';
  if (match) {
    if (/partner/i.test(match.structure || '')) entityKind = 'Partnership';
    else if (/trust/i.test(match.structure || '')) entityKind = 'Trust';
    else if (/pty|company|ltd|corp/i.test(match.structure || '')) entityKind = 'Company';
  }

  // Restore the picked mode: stored mode wins; on a previously-reviewed row infer from rv-super
  // (legacy migration); on a non-individual entity auto-pick 'na'; otherwise leave unpicked.
  const stored = invoiceSuperModeData['id_' + id];
  let mode = (stored === 'solo' || stored === 'group' || stored === 'na') ? stored : null;
  if (!mode && typeof reviewedRows !== 'undefined' && reviewedRows.has(String(id))) {
    mode = g('rv-super')?.checked ? 'solo' : 'group';
  }
  if (!mode && isNonIndividual) mode = 'na';

  // Show the auto-na banner only when 'na' applies AND the entity is genuinely non-individual.
  const autoNaBanner = g('rv-super-auto-na');
  if (autoNaBanner) {
    if (mode === 'na' && isNonIndividual) {
      autoNaBanner.style.display = 'block';
      const kindEl = g('rv-super-auto-na-kind'); if (kindEl) kindEl.textContent = entityKind;
    } else {
      autoNaBanner.style.display = 'none';
    }
  }

  if (mode) {
    rvSetSuperMode(mode, /*persist*/ false);
  } else {
    document.querySelectorAll('input[name="rv-mp-mode"]').forEach(r => r.checked = false);
    const unset = g('rv-super-unset'); if (unset) unset.style.display = 'block';
    if (typeof rvUpdateRail === 'function') rvUpdateRail();
    if (typeof rvUpdateGroupSection === 'function') rvUpdateGroupSection();
  }
}

// Apply a super mode. 'solo' → super withheld; 'group' → no super. Drives the canonical rv-super
// flag and persists the choice so re-opens of the same invoice restore it.
function rvSetSuperMode(mode, persist) {
  if (persist === undefined) persist = true;
  const id = reviewModalRowId;
  const superCb = document.getElementById('rv-super');
  document.querySelectorAll('input[name="rv-mp-mode"]').forEach(r => { r.checked = (r.value === mode); });
  if (mode === 'solo')      { if (superCb) superCb.checked = true; }
  else if (mode === 'group'){ if (superCb) superCb.checked = false; }
  else if (mode === 'na')   { if (superCb) superCb.checked = false; }
  if (persist && id != null) invoiceSuperModeData['id_' + id] = mode;
  const unset = document.getElementById('rv-super-unset'); if (unset) unset.style.display = 'none';
  if (typeof rvUpdateServiceFee === 'function') rvUpdateServiceFee();
  if (typeof rvUpdateRail === 'function') rvUpdateRail();
  if (typeof rvUpdateGroupSection === 'function') rvUpdateGroupSection();
}

// Backward-compat alias for any legacy callsite that still passes 'share'/'none'.
function rvSetMultiPerfMode(mode) { rvSetSuperMode(mode === 'solo' ? 'solo' : 'group'); }

// ── Step 6 (mockup) — Group breakdown panel. Only visible when 'Duo / group' is picked.
//    No data feeds the export yet; this is a planning-only UI we can iterate on. ─────────
function rvUpdateGroupSection() {
  const card = document.getElementById('rv-card-6-group');
  if (!card) return;
  const mode = document.querySelector('input[name="rv-mp-mode"]:checked')?.value;
  if (mode === 'group') {
    card.style.display = '';
    rvGroupSyncRows();
  } else {
    card.style.display = 'none';
  }
}

function rvGroupSyncRows() {
  const countEl = document.getElementById('rv-grp-count');
  if (!countEl) return;
  const count = Math.max(2, Math.min(12, parseInt(countEl.value || '2', 10) || 2));
  const container = document.getElementById('rv-grp-rows');
  if (!container) return;
  container.innerHTML = '';
  const inp = 'font-size:11px;padding:4px 6px;width:100%;border:1px solid #CBD5E0;border-radius:4px;background:#FFFFFF;color:#1B2733;outline:none';
  for (let i = 1; i <= count; i++) {
    const isLead = i === 1;
    const row = document.createElement('div');
    row.className = 'rv-grp-row';
    row.style.cssText = 'background:#FFFFFF;border:1px solid #E4E8EC;border-radius:6px;padding:8px 10px';
    const badgeBg = isLead ? '#EAF7EF' : '#EAF2FB';
    const badgeFg = isLead ? '#1F6E48' : '#2F6FB3';
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="width:22px;height:22px;border-radius:50%;background:${badgeBg};color:${badgeFg};font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none">${i}</span>
        ${isLead ? '<span style="font-size:10px;font-weight:600;color:#1F6E48;background:#EAF7EF;border:1px solid #BCE3CE;border-radius:20px;padding:1px 7px">Lead</span>' : ''}
        <div style="flex:1;min-width:130px;position:relative">
          <input type="text" placeholder="🔍 Search Zoho team…" style="font-size:12px;padding:6px 9px;width:100%;border:1px solid #CBD5E0;border-radius:5px;background:#FFFFFF;color:#1B2733;outline:none">
        </div>
        <span class="rv-id-chip" tabindex="-1" style="margin-left:0;font-size:10px">🛈 ID
          <span class="rv-id-pop" style="width:260px">
            <div style="font-size:10px;color:#7A8896;line-height:1.5">Pick a Zoho team member above to see their entity / ABN / GST / Xero name here — same identity check as Step 1.</div>
          </span>
        </span>
        <div style="display:flex;align-items:center;gap:3px">
          <span style="font-size:11px;color:#7A8896;font-weight:600">$</span>
          <input type="number" placeholder="0.00" step="0.01" min="0" oninput="rvGroupUpdateSum()" style="font-size:12px;padding:6px 8px;width:90px;border:1px solid #CBD5E0;border-radius:5px;background:#FFFFFF;color:#1B2733;outline:none;text-align:right">
        </div>
        <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#5B6B7B;white-space:nowrap;cursor:pointer">
          <input type="checkbox" style="cursor:pointer;accent-color:#1D7A8C">GST
        </label>
        <button type="button" onclick="const d=this.closest('.rv-grp-row').querySelector('.rv-grp-detail'); d.style.display=(d.style.display==='block'?'none':'block'); this.textContent=(d.style.display==='block'?'▴ less':'▾ more');" style="background:#F2F5F8;border:1px solid #CBD5E0;color:#5B6B7B;cursor:pointer;border-radius:4px;padding:3px 7px;font-size:10px" title="Expand reimbursements + file upload">▾ more</button>
      </div>
      <div class="rv-grp-detail" style="display:none;margin-top:9px;padding-top:9px;border-top:1px dashed #E4E8EC">
        <div style="font-size:10px;color:#5B6B7B;font-weight:600;text-transform:uppercase;letter-spacing:.3px;margin-bottom:5px">Reimbursements (no super)</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:10px;color:#5B6B7B">
          <div><label style="display:block;margin-bottom:2px">🚗 Parking $</label><input type="number" placeholder="0" min="0" step="0.01" style="${inp}"></div>
          <div><label style="display:block;margin-bottom:2px">🏨 Accom $</label><input type="number" placeholder="0" min="0" step="0.01" style="${inp}"></div>
          <div><label style="display:block;margin-bottom:2px">📦 Other $</label><input type="number" placeholder="0" min="0" step="0.01" style="${inp}"></div>
        </div>
        ${isLead
          ? '<div style="margin-top:9px;font-size:10px;color:#7A8896;font-style:italic">Lead performer — no separate upload needed (this invoice IS the lead\'s).</div>'
          : '<div style="margin-top:9px"><label style="font-size:10px;color:#5B6B7B;font-weight:600;display:block;margin-bottom:3px">📎 This performer\'s own invoice (split evidence)</label><input type="file" accept="application/pdf" style="font-size:10px"><div style="font-size:10px;color:#7A8896;margin-top:2px">Required so MEC can split the bills and apply super correctly per performer.</div></div>'}
      </div>`;
    container.appendChild(row);
  }
  rvGroupUpdateSum();
}

function rvGroupUpdateSum() {
  const rows = document.querySelectorAll('#rv-grp-rows .rv-grp-row');
  let sum = 0;
  rows.forEach(row => {
    const rate = row.querySelector('input[type="number"]');
    sum += parseFloat(rate?.value || '0') || 0;
  });
  const out = document.getElementById('rv-grp-sum-display');
  if (out) out.textContent = '$' + sum.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let rvABRTimer = null;
function rvAutoABR(val) {
  const clean = (val || '').replace(/\s/g, '');
  if (clean.length === 11 && /^\d{11}$/.test(clean)) {
    clearTimeout(rvABRTimer);
    rvABRTimer = setTimeout(reviewRunABR, 600);
  }
}

async function reviewRunABR() {
  const abn = document.getElementById('rv-abn')?.value || '';
  const clean = abn.replace(/\s/g, '');
  if (clean.length !== 11 || !/^\d{11}$/.test(clean)) return;
  // Show loading state in ABN cell of comparison table
  const abrAbnCell = document.getElementById('rv-cmp-abr-abn');
  if (abrAbnCell) abrAbnCell.innerHTML = '<span style="color:#5B6B7B"><span class="spinner"></span> Looking up…</span>';
  const r = await lookupABN(clean);
  updateReviewStatus();
  if (!r && abrAbnCell) {
    abrAbnCell.innerHTML = '<span style="color:#C0362C">⚠ Lookup failed</span>';
  }
}

// Called whenever a booking checkbox is toggled — updates total bar, auto-fills perf date(s),
// renders one editable date input per ticked booking, and flags the Total card if the invoice
// total is HIGHER than the matched Zoho booking value.
function rvBookingSelectionChanged(userInitiated) {
  const allCbs = document.querySelectorAll('.rv-booking-cb');
  const checked = Array.from(allCbs).filter(cb => cb.checked);

  // Persist the current selection IMMEDIATELY (not just on Confirm) so that re-renders of the
  // booking list — which happen on GST toggle, name/ABN edits, etc. via updateReviewStatus() —
  // restore exactly what's ticked instead of snapping back to the closest-unpaid auto-default.
  if (reviewModalRowId != null) {
    invoiceBookingData['id_' + reviewModalRowId] = checked.map(cb => ({
      bookingId:   cb.dataset.bid,
      bookingName: cb.dataset.name,
      eventDate:   cb.dataset.date,
      cost:        parseFloat(cb.dataset.cost) || 0
    }));
  }

  // Auto-fill performance date from the FIRST checked booking's event date.
  // Fill ONLY when the field is empty, OR when the user actively (re)selected a booking
  // (userInitiated). The initial auto-default render passes no flag, so it will NOT overwrite
  // a date the invoice already gave us (this was clobbering the extracted line-item date).
  const perfEl = document.getElementById('rv-perfdate');
  if (perfEl && checked.length >= 1) {
    const firstDate = checked[0].dataset.date || '';
    if (firstDate && (!perfEl.value || userInitiated || invoicePerfGuess['id_' + reviewModalRowId])) {
      perfEl.value = firstDate;
      updatePerfDateDOW();
      rvClearPerfGuess(); // a date the user pinned to a chosen booking is no longer a guess
    }
  }

  // ── Multiple event dates: one editable date input per ticked booking ──
  // The first booking fills the main rv-perfdate field; bookings 2..N get extra inputs here.
  rvRenderExtraPerfDates(checked);

  // Auto-fill Total (inc. GST) from booking cost if total is currently empty and one booking selected
  const totalEl = document.getElementById('rv-total');
  if (totalEl && !totalEl.value && checked.length === 1) {
    const cost = parseFloat(checked[0].dataset.cost) || 0;
    if (cost > 0) {
      totalEl.value = cost.toFixed(2);
      rvUpdateServiceFee();
    }
  }

  const selectedTotal = checked.reduce((s, cb) => s + (parseFloat(cb.dataset.cost) || 0), 0);
  const invoiceTotal  = parseFloat(document.getElementById('rv-total')?.value || '0');

  // Running tally under the COST column header — sums the cost of every ticked booking.
  const tallyEl = document.getElementById('rv-cost-tally');
  if (tallyEl) {
    if (!checked.length) { tallyEl.textContent = '—'; tallyEl.style.color = '#1F9D63'; }
    else {
      tallyEl.textContent = '$' + selectedTotal.toLocaleString('en-AU', {minimumFractionDigits:2, maximumFractionDigits:2});
      // green if it matches the invoice total, amber if it differs
      const match = invoiceTotal > 0 && Math.abs(selectedTotal - invoiceTotal) <= 1;
      tallyEl.style.color = match ? '#1F9D63' : '#8A5B12';
    }
  }

  // ── Total-card flag: quiet red border when the invoice is billed for MORE than Zoho expected ──
  rvFlagTotalVsBooking(invoiceTotal, selectedTotal, checked.length);

  // Booking selection drives the rail's "Match" phase (step 2)
  rvUpdateRail();

  const bar = document.getElementById('rv-booking-total-bar');
  if (!bar) return;
  if (checked.length === 0) { bar.style.display = 'none'; return; }

  const diff = Math.abs(selectedTotal - invoiceTotal);
  const match = diff <= 1 && invoiceTotal > 0;
  const matchColor = match ? '#1F9D63' : '#8A5B12';
  const matchIcon  = match ? '✓ matches invoice' : `≠ $${diff.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})} difference`;

  bar.style.display = 'flex';
  bar.innerHTML = `
    <span style="color:#5B6B7B;font-size:10px">${checked.length} booking${checked.length>1?'s':''} selected:</span>
    <span style="color:#1B2733;font-size:11px;font-weight:600">$${selectedTotal.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
    <span style="color:${matchColor};font-size:10px;font-weight:600;margin-left:4px">${matchIcon}</span>
  `;
}

// Render an editable date input for each ticked booking beyond the first.
// Editing one writes the new date back onto its checkbox's data-date so it flows through to
// the saved booking links (and the Xero "Event(s):" reference) on Confirm.
function rvRenderExtraPerfDates(checked) {
  const wrap = document.getElementById('rv-perfdate-extra');
  if (!wrap) return;
  if (!checked || checked.length <= 1) { wrap.innerHTML = ''; return; }
  const extras = checked.slice(1);
  wrap.innerHTML = extras.map((cb, i) => {
    const bid = cb.dataset.bid || '';
    const dateVal = cb.dataset.date || '';
    const bname = cb.dataset.name || '';
    const readable = dateVal ? fmtReadableDOW(dateVal) : '';
    return `<div style="flex:0 0 200px;max-width:240px">
      <div style="color:#5B6B7B;font-size:9px;margin-bottom:2px;font-weight:600;letter-spacing:.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(bname)}">EVENT DATE ${i + 2}${bname ? ` · <span style="color:#2F6FB3;font-weight:500">${escHtml(bname)}</span>` : ''}</div>
      <input type="date" value="${dateVal}" data-extra-bid="${bid}"
        onchange="rvExtraPerfDateChanged('${bid}', this.value); this.nextElementSibling.textContent=fmtReadableDOW(this.value)"
        onclick="try{this.showPicker()}catch(e){}"
        style="font-size:12px;padding:6px 9px;width:100%;border:1px solid #CBD5E0;border-radius:5px;background:#FFFFFF;color:#1B2733;outline:none;color-scheme:dark;cursor:pointer">
      <div style="font-size:11px;color:#5B6B7B;font-weight:600;margin-top:2px">${readable}</div>
    </div>`;
  }).join('');
}

// Write an edited extra date back onto the matching booking checkbox
function rvExtraPerfDateChanged(bid, val) {
  const cb = document.querySelector(`.rv-booking-cb[data-bid="${bid}"]`);
  if (cb) cb.dataset.date = val;
}

// Quiet red flag on the Total card when the invoice total exceeds the Zoho booking value.
function rvFlagTotalVsBooking(invoiceTotal, selectedTotal, numChecked) {
  const card = document.getElementById('rv-total-card');
  const warn = document.getElementById('rv-total-warn');
  if (!card) return;
  const over = numChecked > 0 && selectedTotal > 0 && invoiceTotal > selectedTotal + 1;
  if (over) {
    const diff = invoiceTotal - selectedTotal;
    card.style.borderColor = 'rgba(252,129,129,0.85)';
    card.style.background   = 'rgba(197,48,48,0.10)';
    if (warn) {
      warn.style.display = 'block';
      warn.textContent = `▲ $${diff.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})} over Zoho quote`;
      warn.title = `This invoice is billed for more than the matched Zoho booking value ($${selectedTotal.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}). Confirm the higher amount is correct before paying.`;
    }
  } else {
    card.style.borderColor = '#9FD9BA';
    card.style.background   = '#EAF7EF';
    if (warn) warn.style.display = 'none';
  }
}

function reviewLooksGood() {
  const id = reviewModalRowId;
  if (!id) return;

  // Write edited values back to Stage 1 inputs
  const setVal = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  setVal('name-'+id,     document.getElementById('rv-name')?.value     || '');
  setVal('inv-'+id,      document.getElementById('rv-inv')?.value      || '');
  setVal('date-'+id,     document.getElementById('rv-date')?.value     || '');
  setVal('perfdate-'+id, document.getElementById('rv-perfdate')?.value || '');
  setVal('total-'+id,    document.getElementById('rv-total')?.value    || '');
  setVal('abn-'+id,      document.getElementById('rv-abn')?.value      || '');

  // Persist GST toggle to invoiceGSTData store
  invoiceGSTData['id_' + id] = document.getElementById('rv-gst')?.checked || false;

  // Persist super toggle — and sync the Stage 1 "Withhold super?" checkbox, which is what
  // collectRows reads (the per-row super source of truth).
  if (!window.invoiceSuperData) window.invoiceSuperData = {};
  const rvSuperChecked = document.getElementById('rv-super')?.checked ?? true;
  window.invoiceSuperData['id_' + id] = rvSuperChecked;
  const s1SuperEl = document.getElementById('s1-super-' + id);
  if (s1SuperEl) s1SuperEl.checked = rvSuperChecked;

  // Duo / group: persist this performer's super-assessable share (only when the panel is shown,
  // 'share' mode is selected, and a positive amount is entered). Otherwise clear any prior override.
  const mpVisible = document.getElementById('rv-multiperf')?.style.display !== 'none';
  const mpMode    = document.querySelector('input[name="rv-mp-mode"]:checked')?.value;
  const shareNum  = parseFloat(document.getElementById('rv-mp-share')?.value || '');
  if (mpVisible && mpMode === 'share' && isFinite(shareNum) && shareNum > 0) {
    invoiceSuperShareData['id_' + id] = shareNum;
  } else {
    delete invoiceSuperShareData['id_' + id];
  }

  // Save expense splits
  const expParking       = parseFloat(document.getElementById('rv-exp-parking')?.value || '0') || 0;
  const expAccommodation = parseFloat(document.getElementById('rv-exp-accommodation')?.value || '0') || 0;
  const expTravel        = parseFloat(document.getElementById('rv-exp-travel')?.value || '0') || 0;
  const expOther         = parseFloat(document.getElementById('rv-exp-other')?.value || '0') || 0;
  if (expParking > 0 || expAccommodation > 0 || expTravel > 0 || expOther > 0) {
    invoiceExpenseData['id_' + id] = { parking: expParking, accommodation: expAccommodation, travel: expTravel, other: expOther };
  } else {
    delete invoiceExpenseData['id_' + id];
  }

  // Save selected booking matches
  const checkedCbs = document.querySelectorAll('.rv-booking-cb:checked');
  if (checkedCbs.length > 0) {
    invoiceBookingData['id_' + id] = Array.from(checkedCbs).map(cb => ({
      bookingId:   cb.dataset.bid,
      bookingName: cb.dataset.name,
      eventDate:   cb.dataset.date,
      cost:        parseFloat(cb.dataset.cost) || 0
    }));
  } else {
    delete invoiceBookingData['id_' + id];
  }

  // Fire match update so Stage 1 match cell reflects any name change
  const nameEl = document.getElementById('name-'+id);
  if (nameEl) updateMatch(nameEl, id);

  // If ABN changed, refresh the ABR badge in Stage 1 match cell
  const rv_abn = document.getElementById('rv-abn')?.value || '';
  const s1_abn = document.getElementById('abn-'+id)?.value || '';
  if (rv_abn.replace(/\s/g,'') !== s1_abn.replace(/\s/g,'') && rv_abn.trim()) {
    doABNLookup(id); // async — updates match cell in background
  }

  // Mark row as reviewed
  reviewedRows.add(String(id));

  // Update Stage 1 "Review" button to ✓ Reviewed state
  const btn = document.getElementById('rv-btn-'+id);
  if (btn) {
    btn.style.background = '#EDFAF3';
    btn.style.border = '1px solid #27AE60';
    btn.style.color = '#1A7A40';
    btn.style.fontWeight = '600';
    btn.innerHTML = '✓ Reviewed';
  }

  closeReviewModal();
  // Auto-save session state so a page refresh can offer to restore
  setTimeout(sessionSave, 200);
}

// ── Extracted-fields modal ──────────────────────────────────────────────────
let fieldTableRowId = null;
let fieldTableData = null;

// Gather the row's current values to seed the parser (reflects any manual edits).
function currentRowData(id){
  const g = x => document.getElementById(x + '-' + id);
  return {
    name:          g('name')?.value || '',
    invoiceNumber: g('inv')?.value || '',
    date:          g('date')?.value || '',
    performanceDate: g('perfdate')?.value || '',
    total:         parseFloat(g('total')?.value) || 0,
    abn:           g('abn')?.value || '',
    hasGST:        invoiceGSTData['id_' + id] || false,
  };
}

function showFieldTable(id) {
  const raw = invoiceRawText['id_' + id];
  const name = document.getElementById('name-' + id)?.value
            || document.getElementById('rv-name')?.value || 'Invoice';
  if (!raw) { alert('No extracted text available for this row.'); return; }
  fieldTableRowId = id;
  fieldTableData = extractStructuredFields(raw, currentRowData(id));
  document.getElementById('raw-text-title').textContent = `Extracted fields — ${name}`;
  document.getElementById('raw-text-body').textContent = raw;
  renderFieldTable();
  document.getElementById('field-table-container').style.display = 'block';
  document.getElementById('raw-text-body').style.display = 'none';
  const tb = document.getElementById('ft-toggle-btn'); if (tb) tb.textContent = '📄 Raw text';
  document.getElementById('raw-text-overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
// Back-compat alias (older callers / Escape handler)
function showRawText(id){ showFieldTable(id); }

function renderFieldRow(f){
  const esc = escHtml;
  const filled = f.value !== '' && f.value != null;
  const badge = f.applies
    ? '<span title="Populates the invoice form on Apply" style="color:#3182CE;font-size:9px;margin-left:5px;white-space:nowrap">▶ form</span>' : '';
  const warn = f.warn ? `<div style="color:#C05621;font-size:10px;margin-top:2px">⚠ ${esc(f.warn)}</div>` : '';
  const input = f.multiline
    ? `<textarea id="ft-f-${f.key}" rows="2" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid #CBD5E0;border-radius:4px;resize:vertical">${esc(f.value)}</textarea>`
    : `<input type="text" id="ft-f-${f.key}" value="${esc(f.value)}" style="width:100%;font-size:12px;padding:5px 7px;border:1px solid ${filled?'#CBD5E0':'#F6AD55'};border-radius:4px;background:${filled?'#fff':'#FFFBEB'}">`;
  return `<tr style="border-top:1px solid #EDF2F7"><td style="padding:5px 8px 5px 0;color:#2D3748;font-weight:600;vertical-align:top;width:38%">${esc(f.label)}${badge}</td><td style="padding:5px 0">${input}${warn}</td></tr>`;
}

function renderFieldTable(){
  if (!fieldTableData) return;
  const primary   = fieldTableData.fields.filter(f => !f.secondary);
  const secondary = fieldTableData.fields.filter(f => f.secondary);

  let html = '<table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>';
  primary.forEach(f => { html += renderFieldRow(f); });
  html += '</tbody></table>';

  // Secondary (bank / contact) fields — collapsed by default behind one click.
  if (secondary.length) {
    const filledCount = secondary.filter(f => f.value !== '' && f.value != null).length;
    html += `<details style="margin-top:12px;border:1px solid #E2E8F0;border-radius:6px;overflow:hidden">
      <summary style="cursor:pointer;padding:7px 10px;background:#F7FAFC;font-size:12px;font-weight:600;color:#4A5568">
        Payment &amp; contact details <span style="font-weight:400;color:#A0AEC0">(${filledCount}/${secondary.length} found — click to expand)</span>
      </summary>
      <div style="padding:2px 10px 6px"><table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>`;
    secondary.forEach(f => { html += renderFieldRow(f); });
    html += '</tbody></table></div></details>';
  }
  html += '<div style="margin-top:16px"><div style="font-size:11px;font-weight:700;color:#2D3748;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Line items <span style="font-weight:400;text-transform:none;color:#718096">— best-effort; confirm &amp; categorise. Travel / Parking / Accommodation feed the expense splits.</span></div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>'
        + '<th style="text-align:left;padding:3px 6px;color:#718096;font-size:10px">Description</th>'
        + '<th style="text-align:right;padding:3px 6px;color:#718096;font-size:10px;width:92px">Amount $</th>'
        + '<th style="text-align:left;padding:3px 6px;color:#718096;font-size:10px;width:135px">Category</th>'
        + '<th style="width:26px"></th></tr></thead><tbody id="ft-li-tbody"></tbody></table>';
  html += '<button onclick="ftAddLineItem()" style="margin-top:6px;font-size:11px;background:#EDF2F7;border:1px solid #CBD5E0;border-radius:4px;padding:3px 10px;cursor:pointer">+ Add line</button></div>';
  document.getElementById('field-table-container').innerHTML = html;
  renderLineItemRows();
}

function renderLineItemRows(){
  const tb = document.getElementById('ft-li-tbody');
  if (!tb || !fieldTableData) return;
  tb.innerHTML = fieldTableData.lineItems.map((it,i) => {
    const opts = FT_CATEGORIES.map(c => `<option ${c===it.category?'selected':''}>${c}</option>`).join('');
    return `<tr style="border-top:1px solid #EDF2F7">
      <td style="padding:3px 6px"><input id="ft-li-${i}-desc" value="${escHtml(it.description)}" style="width:100%;font-size:12px;padding:3px 5px;border:1px solid #CBD5E0;border-radius:4px"></td>
      <td style="padding:3px 6px"><input id="ft-li-${i}-amt" type="number" step="0.01" value="${it.amount}" style="width:100%;text-align:right;font-size:12px;padding:3px 5px;border:1px solid #CBD5E0;border-radius:4px"></td>
      <td style="padding:3px 6px"><select id="ft-li-${i}-cat" style="width:100%;font-size:12px;padding:3px 5px;border:1px solid #CBD5E0;border-radius:4px">${opts}</select></td>
      <td style="padding:3px 6px;text-align:center"><button onclick="ftRemoveLineItem(${i})" title="Remove" style="background:none;border:none;color:#C53030;cursor:pointer;font-size:13px">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" style="padding:6px;color:#A0AEC0;font-size:11px">No line items detected — add one if needed.</td></tr>';
}

function ftSyncLineItemsFromInputs(){
  if (!fieldTableData) return;
  const items = [];
  let i = 0;
  while (document.getElementById('ft-li-' + i + '-desc')) {
    items.push({
      description: document.getElementById('ft-li-' + i + '-desc').value,
      amount: parseFloat(document.getElementById('ft-li-' + i + '-amt').value) || 0,
      category: document.getElementById('ft-li-' + i + '-cat').value,
    });
    i++;
  }
  fieldTableData.lineItems = items;
}
function ftAddLineItem(){ ftSyncLineItemsFromInputs(); fieldTableData.lineItems.push({description:'',amount:0,category:'Performance'}); renderLineItemRows(); }
function ftRemoveLineItem(i){ ftSyncLineItemsFromInputs(); fieldTableData.lineItems.splice(i,1); renderLineItemRows(); }

function toggleRawTextView(){
  const c = document.getElementById('field-table-container');
  const pre = document.getElementById('raw-text-body');
  const btn = document.getElementById('ft-toggle-btn');
  const showingFields = c.style.display !== 'none';
  if (showingFields){ c.style.display='none'; pre.style.display='block'; if(btn) btn.textContent='📊 Fields'; }
  else { c.style.display='block'; pre.style.display='none'; if(btn) btn.textContent='📄 Raw text'; }
}

function applyFieldTable(){
  const id = fieldTableRowId;
  if (id == null || !fieldTableData) return;
  ftSyncLineItemsFromInputs();
  const getF = key => { const el = document.getElementById('ft-f-' + key); return el ? el.value.trim() : ''; };
  const setRow = (suffix, val) => { const el = document.getElementById(suffix + '-' + id); if (el && val !== '' && val != null) el.value = val; };

  setRow('name', getF('contractorName'));
  setRow('inv', getF('invoiceNumber'));
  const totalV = parseFloat(getF('total'));
  if (!isNaN(totalV)) setRow('total', totalV);
  setRow('perfdate', getF('performanceDate'));
  setRow('date', getF('invoiceDate'));
  const abnV = digitsOnly(getF('abn'));
  if (abnV) setRow('abn', abnV);

  // Line items → expense splits
  let parking = 0, accommodation = 0, travel = 0;
  fieldTableData.lineItems.forEach(it => {
    if (it.category === 'Parking') parking += it.amount;
    else if (it.category === 'Accommodation') accommodation += it.amount;
    else if (it.category === 'Travel') travel += it.amount;
  });
  if (parking || accommodation || travel) {
    const prevOther = invoiceExpenseData['id_' + id]?.other || 0;
    invoiceExpenseData['id_' + id] = { parking, accommodation, travel, other: prevOther };
  }

  // Re-run Zoho matching on the (possibly updated) name
  const nameEl = document.getElementById('name-' + id);
  if (nameEl && typeof updateMatch === 'function') updateMatch(nameEl, id);

  // Mirror into the Review modal if it's open on this row
  if (typeof reviewModalRowId !== 'undefined' && reviewModalRowId === id) {
    const setRV = (rid, val) => { const el = document.getElementById(rid); if (el && val !== '' && val != null) el.value = val; };
    setRV('rv-name', getF('contractorName'));
    setRV('rv-inv', getF('invoiceNumber'));
    if (!isNaN(totalV)) setRV('rv-total', totalV);
    setRV('rv-perfdate', getF('performanceDate'));
    if (abnV) setRV('rv-abn', abnV);
    if (parking) setRV('rv-exp-parking', parking);
    if (accommodation) setRV('rv-exp-accommodation', accommodation);
    if (travel) setRV('rv-exp-travel', travel);
    if (typeof rvUpdateServiceFee === 'function') rvUpdateServiceFee();
    if (typeof updateReviewStatus === 'function') updateReviewStatus();
  }

  const btn = document.getElementById('ft-apply-btn');
  if (btn){ const orig = btn.textContent; btn.textContent = '✓ Applied'; btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); }
}

function closeRawText() {
  document.getElementById('raw-text-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

function copyRawText() {
  const text = document.getElementById('raw-text-body').textContent;
  const btn = document.getElementById('raw-text-copy-btn');
  const orig = btn.textContent;
  const finish = (ok) => {
    btn.textContent = ok ? '✓ Copied!' : '✕ Failed';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => finish(true)).catch(() => finish(false));
  } else {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      finish(true);
    } catch { finish(false); }
  }
}

function updateProcessCount() {
  // Count only rows that actually hold an invoice (a name or a total) — this skips the
  // always-present blank manual-entry starter row, which otherwise inflated the count by 1.
  const hasData = tr => {
    const id = tr.id.replace('row-', '');
    const n = (document.getElementById('name-'  + id)?.value || '').trim();
    const t = parseFloat(document.getElementById('total-' + id)?.value || '0') || 0;
    return !!(n || t > 0);
  };
  const pdfRows    = Array.from(document.querySelectorAll('#pdf-tbody tr[id]')).filter(hasData).length;
  const apRows     = Array.from(document.querySelectorAll('#ap-review-tbody tr[id]')).filter(hasData).length;
  const manualRows = Array.from(document.querySelectorAll('#manual-tbody tr[id]')).filter(hasData).length;
  const total = pdfRows + apRows + manualRows;
  document.getElementById('process-count').textContent = total
    ? `${total} invoice${total!==1?'s':''} ready to process${apRows ? ` (incl. ${apRows} AP)` : ''}` : '';
  const btn = document.getElementById('process-btn');
  if (btn) btn.innerHTML = total ? `Process &amp; Review ${total} Invoice${total!==1?'s':''} →` : 'Process &amp; Review Invoices →';
}

// ── Manual entry ──
function addManualRow() {
  const id = 'm' + (++manualRowId);
  const today = new Date().toISOString().split('T')[0];
  const tbody = document.getElementById('manual-tbody');
  const tr = document.createElement('tr');
  tr.id = 'row-' + id;
  tr.innerHTML = `
    <td style="position:relative">
      <div style="position:relative">
        <input type="text" placeholder="Start typing to search Zoho…"
          oninput="searchContractorsS1('${id}', this.value)"
          onchange="updateMatch(this,'${id}')"
          onblur="setTimeout(()=>hideDropdownS1('${id}'),200)"
          id="name-${id}" style="width:100%">
        <div id="s1drop-${id}" class="contractor-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #CBD5E0;border-radius:0 0 5px 5px;max-height:180px;overflow-y:auto;z-index:50;box-shadow:0 6px 16px rgba(0,0,0,0.2)"></div>
      </div>
    </td>
    <td><input type="text" placeholder="INV-001" id="inv-${id}"></td>
    <input type="hidden" value="${today}" id="date-${id}">
    <td><input type="number" step="0.01" placeholder="580.00" id="total-${id}"></td>
    <td>
      <div style="display:flex;gap:4px;align-items:center;">
        <input type="text" placeholder="XX XXX XXX XXX"
               id="abn-${id}" style="width:105px;font-size:12px;" maxlength="14">
      </div>
    </td>
    <td id="match-${id}"><span style="color:#ccc;font-size:12px">— type name —</span></td>
    <td style="text-align:center;vertical-align:middle;">
      <input type="checkbox" id="s1-super-${id}" checked style="cursor:pointer;width:15px;height:15px;accent-color:#27AE60"
        title="Withhold 12% super for this invoice. Defaults ON for sole traders (Type A/B); has no effect for companies/partnerships (C/D). To exclude the whole invoice, remove it with the ✕ button.">
    </td>
    <td style="white-space:nowrap">
      <button class="btn btn-secondary btn-sm" onclick="openReviewModal('${id}')" id="rv-btn-${id}" title="Review invoice — verify &amp; correct fields" style="margin-right:3px">👁 Review</button>
      <button class="btn btn-danger btn-sm" onclick="removeRow('${id}')">✕</button>
    </td>`;
  tbody.appendChild(tr);
  updateProcessCount();
}

// ══════════════════════════════════════════════════════════════════════════════
// Contractor Matching
// ══════════════════════════════════════════════════════════════════════════════
// Words that appear in many names and should never drive a match on their own
const MATCH_STOPWORDS = new Set(['melbourne','entertainment','company','music','productions',
  'pty','ltd','trust','group','australia','services','events','management','media']);

function extractAllAbns(abnField) {
  // Extract all 11-digit ABN sequences from a field (handles "24425317762 // 64127155462 (Jazz to Rock)")
  if (!abnField) return [];
  return [...abnField.matchAll(/\b(\d{11})\b/g)].map(m => m[1]);
}

// ── Duplicate detection ─────────────────────────────────────────────────────
// Returns a warning string if this invoice looks like a duplicate already in the table
function checkDuplicate(abn, invoiceNumber, total, date) {
  // Gather all existing rows from all three tbodies
  const allRows = [
    ...document.querySelectorAll('#pdf-tbody tr[id]'),
    ...document.querySelectorAll('#ap-review-tbody tr[id]'),
    ...document.querySelectorAll('#manual-tbody tr[id]'),
  ];
  for (const tr of allRows) {
    const rowId = tr.id.replace('row-','');
    const existingAbn = document.getElementById('abn-'+rowId)?.value.replace(/\s/g,'') || '';
    const existingInv = document.getElementById('inv-'+rowId)?.value.trim() || '';
    const existingTotal = document.getElementById('total-'+rowId)?.value.trim() || '';
    const existingDate = document.getElementById('date-'+rowId)?.value || '';

    // Match 1: same ABN + same non-empty invoice number
    if (abn && existingAbn && abn === existingAbn && invoiceNumber && existingInv && invoiceNumber === existingInv) {
      return `Duplicate: same ABN + invoice # (${invoiceNumber})`;
    }
    // Match 2: same ABN + same total + same date (catches invoices without invoice numbers)
    if (abn && existingAbn && abn === existingAbn &&
        total && existingTotal && String(total) === existingTotal &&
        date && existingDate && date === existingDate) {
      return `Duplicate: same ABN + amount + date ($${total}, ${date})`;
    }
  }
  return null;
}

function matchContractor(name, abn) {
  if (!contractors.length) return null;

  // Bail immediately if the name is clearly MEC (the recipient, not the contractor)
  if (name && /melbourne\s+entertainment|melbentco|mlebourne/i.test(name)) return null;

  // ABN match — most reliable, try first (checks ALL ABNs stored in the contractor field)
  const cleanAbn = (abn || '').replace(/\s/g,'');
  if (cleanAbn.length === 11) {
    const byABN = contractors.find(c => {
      const allAbns = extractAllAbns(c.abn);
      return allAbns.some(a => a === cleanAbn);
    });
    if (byABN) return byABN;
  }

  if (!name) return null; // name matching requires a name

  const needle = name.toLowerCase().trim();

  // Exact name match — check both c.name (Zoho name) AND c.xeroName (Xero entity name).
  // Lets us match invoices billed under an entity name like "JAZZ TO ROCK ENTERTAINMENT PTY"
  // back to the Zoho record whose primary name is "Pete (Indigo) Mitchell".
  let found = contractors.find(c =>
    c.name.toLowerCase() === needle ||
    (c.xeroName && c.xeroName.toLowerCase() === needle)
  );
  if (found) return found;

  // Contains match (only if needle is ≥ 4 chars and not a stopword)
  if (needle.length >= 4 && !MATCH_STOPWORDS.has(needle)) {
    found = contractors.find(c => {
      const cn = c.name.toLowerCase();
      const xn = (c.xeroName || '').toLowerCase();
      return cn.includes(needle) || needle.includes(cn)
          || (xn && (xn.includes(needle) || needle.includes(xn)));
    });
    if (found) return found;
  }

  // Word-level match — only on meaningful words (not stopwords, min 4 chars)
  // Require ≥2 shared words to reduce false positives (e.g. "jazz" alone shouldn't match)
  const words = needle.split(/\s+/).filter(w => w.length >= 4 && !MATCH_STOPWORDS.has(w));
  if (words.length) {
    const minHits = Math.min(2, words.length);
    found = contractors.find(c => {
      const cn = c.name.toLowerCase().split(/\s+/);
      const xn = (c.xeroName || '').toLowerCase().split(/\s+/);
      const allWords = cn.concat(xn);
      const hits = words.filter(w => allWords.some(cw => cw === w && !MATCH_STOPWORDS.has(cw))).length;
      return hits >= minHits;
    });
  }
  return found || null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Calculations (Super-inclusive model)
// ══════════════════════════════════════════════════════════════════════════════
// Resolve the super % for a contractor: their Zoho Super_Percentage if set (>0), else 12% default.
function superRateFor(contractor) {
  const v = contractor && (contractor.superPercentage ?? contractor.super_percentage ?? contractor.superPct);
  const n = parseFloat(v);
  return (isFinite(n) && n > 0) ? n : 12;
}

// `rate` is the super % to apply. Defaults to 12 (the SG rate from 1 July 2025); a contractor's
// Zoho `Super_Percentage` overrides it when set higher (e.g. a performer on 15%). Pass the
// contractor's rate through from processInvoices/exports — see superRateFor().
function calculateAmounts(total, type, rate) {
  const r = n => Math.round(n * 100) / 100;
  const pct = (typeof rate === 'number' && rate > 0) ? rate : 12;
  if (type === 'A') {
    // No GST, super-inclusive: total = cash + super; super = total × pct/(100+pct)
    const super_ = r(total * pct / (100 + pct));
    const cash = r(total - super_);
    return { cash, super: super_, gst: 0, unitAmount: cash, taxAmount: 0 };
  }
  if (type === 'B') {
    // GST-registered, super-inclusive: total = exGST × 1.1. The ex-GST fee is treated as
    // INCLUSIVE of super, so super = exGST × pct/(100+pct) and ex-GST cash = exGST − super
    // (i.e. exGST ÷ 1.12 at the 12% rate). GST is then added back on top. Matches Type A.
    const exGST = r(total / 1.1);
    const gst = r(total - exGST);
    const super_ = r(exGST * pct / (100 + pct));
    const cashExGST = r(exGST - super_);
    const cash = r(cashExGST + gst);
    return { cash, super: super_, gst, unitAmount: cashExGST, taxAmount: gst };
  }
  if (type === 'C') {
    return { cash: total, super: 0, gst: 0, unitAmount: total, taxAmount: 0 };
  }
  if (type === 'D') {
    const exGST = r(total / 1.1);
    const gst = r(total - exGST);
    return { cash: total, super: 0, gst, unitAmount: exGST, taxAmount: gst };
  }
  return { cash: total, super: 0, gst: 0, unitAmount: total, taxAmount: 0 };
}

// ══════════════════════════════════════════════════════════════════════════════
// Process Invoices
// ══════════════════════════════════════════════════════════════════════════════
function collectRows() {
  const rows = [];
  // Helper to extract a row's data by id
  function extractRow(tr, source, defaultType) {
    const id = tr.id.replace('row-','');
    if (!id) return null;
    const name = document.getElementById('name-'+id)?.value.trim() || '';
    const inv  = document.getElementById('inv-'+id)?.value.trim() || '';
    const date = document.getElementById('date-'+id)?.value || '';
    const total = parseFloat(document.getElementById('total-'+id)?.value) || 0;
    const abn = document.getElementById('abn-'+id)?.value.replace(/\s/g,'') || '';
    const abrData = abrRowData['id_'+id] || null;
    const hasGST = invoiceGSTData['id_'+id] || false;
    // Already-paid now comes only from PDF auto-detection ($0 due) + Zoho booking check.
    // (The old manual "Exclude" checkbox was replaced by the "Withhold super?" toggle; to
    // exclude an invoice from the run, remove it with the red ✕ button instead.)
    const alreadyPaid = invoicePaidData['id_'+id] || false;
    // Per-row super-withholding toggle (the Stage 1 "Withhold super?" checkbox). Undefined if
    // the checkbox isn't present → treated as default (decided by type in processInvoices).
    const superCb = document.getElementById('s1-super-'+id);
    const withholdSuper = superCb ? superCb.checked : undefined;
    const invoiceType = document.getElementById('itype-'+id)?.value || defaultType;
    if (!name && !total) return null;
    const perfDate = document.getElementById('perfdate-'+id)?.value || '';
    // Expense splits
    const expenses = invoiceExpenseData['id_'+id] || null;
    const expTotal = expenses ? ((expenses.parking||0) + (expenses.accommodation||0) + (expenses.travel||0) + (expenses.other||0)) : 0;
    const serviceFee = total - expTotal;
    // Super is withheld on service fee + travel (time-based), but NOT on parking/accommodation/other
    // (pure reimbursements — e.g. parking, accom, and "other" out-of-pocket purchases like a table or cord)
    const superExcluded = expenses ? ((expenses.parking||0) + (expenses.accommodation||0) + (expenses.other||0)) : 0;
    // Duo/group override: when the operator has set this performer's own share (Review modal),
    // super is assessed on that amount instead of the service fee. Payment is unchanged — Bill 1 is
    // total minus this (smaller) super, so the performer receives the partner's portion in cash.
    const shareOverride = invoiceSuperShareData['id_'+id];
    const hasShareOverride = shareOverride != null && shareOverride !== '' && isFinite(parseFloat(shareOverride)) && parseFloat(shareOverride) > 0;
    const superBase = hasShareOverride ? parseFloat(shareOverride) : (total - superExcluded);
    // Explicitly-linked bookings from the Review modal (takes precedence over fuzzy match for paid check)
    const linkedBookings = invoiceBookingData['id_'+id] || null;
    return {name, invoiceNumber:inv, date, perfDate, total, serviceFee, superBase, expenses, abn, abrData, hasGST, alreadyPaid, withholdSuper, invoiceType, source, rowId: id, linkedBookings};
  }
  // PDF event rows
  document.querySelectorAll('#pdf-tbody tr[id]').forEach(tr => {
    const r = extractRow(tr, 'pdf', 'event');
    if (r) rows.push(r);
  });
  // PDF AP rows (routed to ap-review-tbody)
  document.querySelectorAll('#ap-review-tbody tr[id]').forEach(tr => {
    const r = extractRow(tr, 'pdf', 'ap');
    if (r) rows.push(r);
  });
  // Manual rows
  document.querySelectorAll('#manual-tbody tr[id]').forEach(tr => {
    const r = extractRow(tr, 'manual', 'event');
    if (r) rows.push(r);
  });
  return rows;
}

function processInvoices() {
  const rows = collectRows();
  if (!rows.length) { alert('No invoice data to process.'); return; }

  // Warn if event rows still have unmatched contractors
  const unmatchedCount = [
    ...document.querySelectorAll('#pdf-tbody .match-status-warn'),
    ...document.querySelectorAll('#manual-tbody .match-status-warn'),
  ].length;
  if (unmatchedCount > 0) {
    const go = confirm(
      `⚠ ${unmatchedCount} invoice(s) still show "Not found in Zoho".\n\n` +
      `These won't have super calculated or be correctly coded in the export.\n\n` +
      `Use the Zoho search in the Matched/ABR column to link them, then try again.\n\n` +
      `Continue anyway without linking them?`
    );
    if (!go) return;
  }

  processed = rows.map((row, i) => {
    // Use row.abn (already cleaned in collectRows) — NOT a DOM lookup (row.id not set yet)
    const contractor = matchContractor(row.name, row.abn);
    let type = 'UNKNOWN';
    let matchSource = 'none';

    if (contractor) {
      // Default to a valid type if the Zoho record has none (else account/tax/super come out
      // blank in the export — e.g. Heidi Milne). GST-registered → B, otherwise A.
      type = contractor.type || (contractor.gst ? 'B' : 'A');
      matchSource = 'zoho';
    } else if (row.abrData && row.abrData.isActive) {
      // Derive type from ABR: sole traders default to super-eligible (s12(8))
      const isCompany = row.abrData.isCompany;
      const isGST = row.abrData.isGST;
      type = isCompany ? (isGST ? 'D' : 'C') : (isGST ? 'B' : 'A');
      matchSource = 'abr';
    }

    // GST override: invoice is the legal document — if it charges GST, use the GST-inclusive type
    // regardless of what Zoho says. The gstMismatch flag still alerts the user to investigate.
    // A (no GST, super) → B (GST, super) | C (no GST, no super) → D (GST, no super)
    if (type !== 'UNKNOWN' && row.hasGST && contractor && !contractor.gst) {
      type = type === 'A' ? 'B' : type === 'C' ? 'D' : type;
    }

    const superRate = superRateFor(contractor);
    const amounts = (type !== 'UNKNOWN') ? calculateAmounts(row.serviceFee ?? row.total, type, superRate) : null;

    // GST mismatch: invoice charges GST but Zoho says contractor is not GST-registered
    const gstMismatch = contractor && row.hasGST && !contractor.gst
      ? { contractorId: contractor.id, contractorName: contractor.name, invoiceGST: true, zohoGST: false }
      : null;

    // Booking cross-check: use explicitly-linked bookings from Review modal if available,
    // otherwise fall back to fuzzy match
    const bookingMatch = getBookingMatchForRow(row.name, row.total, row.date, row.linkedBookings);
    // Only flag "paid in Zoho" when the user actually LINKED (ticked) a booking in Review and
    // that exact booking is paid — never from a fuzzy guess against an unrelated event.
    const hasLinkedBooking = !!(row.linkedBookings && row.linkedBookings.length);
    const alreadyPaidInZoho = hasLinkedBooking && !!(bookingMatch?.alreadyPaid);
    const manuallyExcluded = false;
    // Exclusion removed (May 2026): all invoices are payable. alreadyPaidInZoho is kept purely
    // to show an informational "⚠ Warning" chip (linking to the Zoho booking) in Stage 2.
    const alreadyPaid = false;

    // Super withholding: applies to sole traders (types A/B) only. Driven by the per-row
    // "Withhold super?" toggle — defaults ON for A/B, OFF for C/D — NOT by the Zoho flag
    // (which was unreliable and left some sole traders with no super). The user can override
    // per row. Type C/D never accrue super (calculateAmounts returns super:0 for them).
    const superByType = ['A','B'].includes(type);
    const withholdSuper = (row.withholdSuper != null) ? (row.withholdSuper && superByType) : superByType;

    return {
      ...row,
      contractor,
      type,
      amounts,
      matched: type !== 'UNKNOWN',
      matchSource,
      gstMismatch,
      alreadyPaid,
      alreadyPaidInZoho,
      manuallyExcluded,
      withholdSuper,
      superRate,
      bookingMatch,
      id: i,
    };
  });

  // Sort event rows A→Z by contractor name before rendering
  processed.sort((a, b) => {
    if (a.invoiceType === 'ap' && b.invoiceType !== 'ap') return 1;
    if (a.invoiceType !== 'ap' && b.invoiceType === 'ap') return -1;
    const na = (a.contractor?.name || a.name || '').toLowerCase();
    const nb = (b.contractor?.name || b.name || '').toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });

  buildResultsView();
  gotoStep(3);
}

// ══════════════════════════════════════════════════════════════════════════════
// Manual type override for unmatched contractors
// ══════════════════════════════════════════════════════════════════════════════
// ── Stage 1 contractor search (pre-processing) — uses `contractors` (processed array)
function searchContractorsS1(rowId, query) {
  const drop = document.getElementById('s1drop-' + rowId);
  if (!drop) return;
  const q = (query || '').trim().toLowerCase();
  if (q.length < 2) { drop.style.display = 'none'; return; }
  const matches = contractors.filter(c =>
    c.name.toLowerCase().includes(q) || (c.abn && c.abn.includes(q))
  ).slice(0, 8);
  if (!matches.length) {
    drop.innerHTML = '<div style="padding:8px;font-size:12px;color:#888">No matches</div>';
    drop.style.display = 'block'; return;
  }
  drop.innerHTML = matches.map(c => {
    const tl = `<span class="badge badge-${(c.type||'a').toLowerCase()}" style="font-size:9px;padding:1px 5px;margin-left:4px">${c.type}</span>`;
    const sl = c.superEligible ? '<span style="color:#27AE60;font-size:10px;margin-left:4px">✓ Super</span>' : '';
    return `<div class="contractor-option" onclick="linkContractorS1('${rowId}','${c.zohoId}')"
      onmouseenter="s1ShowBookingTooltip(this,'${c.zohoId}')"
      onmouseleave="s1HideBookingTooltip(this)"
      style="position:relative">
      <span class="opt-name">${escHtml(c.name)}</span>${tl}${sl}
      <span class="opt-abn">${c.abn||'—'}</span>
    </div>`;
  }).join('');
  drop.style.display = 'block';
}

function s1ShowBookingTooltip(el, zohoId) {
  s1HideBookingTooltip(el); // clear any existing
  const recent = getContractorBookings(zohoId, null).slice(0, 5);
  if (!recent.length) return;

  const tip = document.createElement('div');
  tip.className = 's1-booking-tooltip';
  tip.style.cssText = [
    'position:absolute', 'left:100%', 'top:0', 'z-index:200',
    'background:#1B2A4A', 'border:1px solid #2A3E5C', 'border-radius:6px',
    'padding:10px 12px', 'min-width:320px', 'max-width:480px',
    'box-shadow:0 8px 24px rgba(0,0,0,0.5)', 'font-size:11px', 'color:#ddd',
    'pointer-events:none'
  ].join(';');

  const rows = recent.map(({ booking, entertainer }) => {
    const ents = (booking.entertainers || []);
    const entCols = ents.slice(0, 6).map(e => {
      const highlight = e.id === zohoId ? 'font-weight:700;color:#93c5fd' : 'color:#aaa';
      const paid = e.paid
        ? '<span style="color:#4ADE80;margin-left:3px">✓</span>'
        : '<span style="color:#FC8181;margin-left:3px">✗</span>';
      const cost = e.cost ? `$${Number(e.cost).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';
      return `<td style="padding:2px 5px;${highlight}">${escHtml(e.name||'—')}</td><td style="padding:2px 5px;color:#9DB5CC">${cost}${paid}</td>`;
    }).join('');
    const dateStr = booking.eventDate
      ? new Date(booking.eventDate + 'T12:00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'numeric'})
      : '—';
    return `<tr>
      <td style="padding:2px 5px;color:#8BAAC0;white-space:nowrap">${dateStr}</td>
      <td style="padding:2px 5px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(booking.bookingName||'')}">${escHtml((booking.bookingName||'').slice(0,22))}${(booking.bookingName||'').length>22?'…':''}</td>
      ${entCols}
    </tr>`;
  }).join('');

  tip.innerHTML = `
    <div style="font-weight:700;color:#93c5fd;margin-bottom:6px;font-size:11px">Recent bookings</div>
    <table style="border-collapse:collapse;width:100%">
      <thead><tr>
        <th style="padding:2px 5px;color:#8BAAC0;font-weight:600;font-size:10px;text-align:left">Date</th>
        <th style="padding:2px 5px;color:#8BAAC0;font-weight:600;font-size:10px;text-align:left">Booking</th>
        <th colspan="8" style="padding:2px 5px;color:#8BAAC0;font-weight:600;font-size:10px;text-align:left">Entertainers (name · $cost · paid?)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.appendChild(tip);
}

function s1HideBookingTooltip(el) {
  el.querySelectorAll('.s1-booking-tooltip').forEach(t => t.remove());
}

function hideDropdownS1(rowId) {
  const d = document.getElementById('s1drop-' + rowId);
  if (d) d.style.display = 'none';
}

function linkContractorS1(rowId, contractorId) {
  const c = contractors.find(x => x.zohoId === contractorId);
  if (!c) return;
  const nameEl = document.getElementById('name-' + rowId);
  const abnEl  = document.getElementById('abn-'  + rowId);
  if (nameEl) nameEl.value = c.name;
  if (abnEl && c.abn) abnEl.value = c.abn;
  const matchCell = document.getElementById('match-' + rowId);
  if (matchCell) {
    const superLbl = c.superEligible
      ? `<span style="color:#27AE60;font-weight:600">✓ Super</span>`
      : `<span style="color:#888">✗ No super</span>`;
    const gstLbl = c.gst ? 'GST ✓' : 'No GST';
    const fundLbl = c.fundName
      ? `<br><span style="color:#888;font-size:9px">Fund: ${escHtml(c.fundName)}</span>`
      : (c.superEligible ? `<br><span style="color:#c0392b;font-size:9px">⚠ No fund on file</span>` : '');
    matchCell.innerHTML = `
      <span class="badge badge-ok match-status-ok">${escHtml(c.name)}</span>
      <div style="font-size:10px;color:#555;margin-top:2px;line-height:1.5">
        ${gstLbl} → Type ${c.type} · ${superLbl}${fundLbl}
      </div>
      <input type="hidden" id="itype-${rowId}" value="event">`;
  }
  // Update the "Withhold super?" toggle default based on the linked contractor's type
  // (sole traders A/B → on; companies/partnerships C/D → off).
  const s1SuperEl = document.getElementById('s1-super-' + rowId);
  if (s1SuperEl) s1SuperEl.checked = !['C','D'].includes(c.type);
  hideDropdownS1(rowId);
}

// ── Stage 2 contractor search & link ─────────────────────────────────────────
function searchContractors(rowId, query) {
  const drop = document.getElementById('cdrop-' + rowId);
  if (!drop) return;
  const q = (query || '').trim().toLowerCase();
  if (q.length < 2) { drop.style.display = 'none'; return; }
  const matches = EMBEDDED_CONTRACTORS.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.abn && c.abn.includes(q))
  ).slice(0, 10);
  if (!matches.length) {
    drop.innerHTML = '<div style="padding:7px 10px;font-size:12px;color:#718096">No matches — use type selector below</div>';
    drop.style.display = 'block';
    return;
  }
  drop.innerHTML = matches.map(c => {
    const typeLabel = c.type ? `<span class="badge badge-${c.type.toLowerCase()}">${c.type}</span>` : '';
    const abnLabel = c.abn ? `<span class="opt-abn">ABN ${c.abn}</span>` : '';
    return `<div class="contractor-option" onmousedown="linkContractor(${rowId},'${c.id}')">
      <span class="opt-name">${escHtml(c.name)}</span>${typeLabel}${abnLabel}
    </div>`;
  }).join('');
  drop.style.display = 'block';
}

function hideDropdown(rowId) {
  const drop = document.getElementById('cdrop-' + rowId);
  if (drop) drop.style.display = 'none';
}

function linkContractor(rowId, contractorId) {
  const c = EMBEDDED_CONTRACTORS.find(c => c.id === contractorId);
  if (!c) return;
  const p = processed.find(x => x.id === rowId);
  if (!p) return;
  // Use the full Zoho contractor record — gets accurate type + super fund details
  p.matched = true;
  p.matchSource = 'manual-link';
  p.type = c.type || 'A';
  p.contractor = {
    name: c.name,
    superEligible: !!(c.super),
    superPercentage: c.superPercentage ?? null,
    tfn: c.tfn || null,
    dob: c.dob || null,
    fundName: c.fundName || null,
    fundUSI: c.fundUSI || null,
    fundABN: c.fundABN || null,
    memberNumber: c.memberNumber || null,
    xeroName: c.xeroName || null,
    email: c.email || null,
    phone: c.phone || null,
    abn: c.abn || p.abn || null,
  };
  p.superRate = superRateFor(p.contractor);
  p.amounts = calculateAmounts(p.serviceFee ?? p.total, p.type, p.superRate);
  buildResultsView();
}

function setManualType(id, type) {
  if (!type) return;
  const p = processed.find(x => x.id === id);
  if (!p) return;
  p.type = type;
  p.matched = true;
  p.matchSource = 'manual';
  p.superRate = superRateFor(p.contractor);
  p.amounts = calculateAmounts(p.serviceFee ?? p.total, type, p.superRate);
  // Synthetic contractor record — name from extracted PDF, no super fund details
  p.contractor = {
    name: p.name || '(unknown)',
    superEligible: ['A','B'].includes(type),
    tfn: null,
    fundName: null,
    fundUSI: null,
    fundABN: null,
    memberNumber: null,
    abn: p.abn || null,
  };
  buildResultsView();
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 3: Results View
// ══════════════════════════════════════════════════════════════════════════════
// Re-sort the Stage 2 results table by name or amount and re-render.
function sortResults(criterion) {
  if (!Array.isArray(processed)) return;
  const key = p => (p.contractor?.name || p.name || '').toLowerCase();
  const tot = p => (p.total || 0);
  processed.sort((a,b) => {
    if (a.invoiceType === 'ap' && b.invoiceType !== 'ap') return 1;   // AP rows last
    if (a.invoiceType !== 'ap' && b.invoiceType === 'ap') return -1;
    if (criterion === 'total-desc') return tot(b) - tot(a);
    if (criterion === 'total-asc')  return tot(a) - tot(b);
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  });
  buildResultsView();
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 3 row hover-breakdown popover — full money breakdown for cross-checking.
// ══════════════════════════════════════════════════════════════════════════════
// Triggered by hovering any row in the Event Contractor Invoices table. Shows
// invoice total → expense lines → service portion → super maths → cash split →
// GST claim, with the account code each line will be coded to in Xero. Built so
// the operator can manually verify the calculations match the source PDF.
function ensureBreakdownPopover() {
  let pop = document.getElementById('row-breakdown-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'row-breakdown-popover';
    pop.style.cssText = 'position:fixed;display:none;z-index:1500;background:#fff;border:1px solid #CBD5E0;border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,0.18);padding:14px 16px;font-size:12px;line-height:1.55;max-width:380px;color:#1B2733;pointer-events:none';
    document.body.appendChild(pop);
  }
  return pop;
}
function showRowBreakdown(event, rowId) {
  const p = processed.find(x => String(x.id) === String(rowId));
  if (!p) return;
  const pop = ensureBreakdownPopover();
  pop.innerHTML = buildBreakdownHtml(p);
  pop.style.display = 'block';
  positionPopover(pop, event);
}
function hideRowBreakdown() {
  const pop = document.getElementById('row-breakdown-popover');
  if (pop) pop.style.display = 'none';
}
function moveRowBreakdown(event) {
  const pop = document.getElementById('row-breakdown-popover');
  if (pop && pop.style.display === 'block') positionPopover(pop, event);
}
function positionPopover(pop, event) {
  const margin = 14;
  pop.style.left = (event.clientX + margin) + 'px';
  pop.style.top  = (event.clientY + margin) + 'px';
  requestAnimationFrame(() => {
    const r = pop.getBoundingClientRect();
    if (r.right  > window.innerWidth  - 10) pop.style.left = (event.clientX - r.width  - margin) + 'px';
    if (r.bottom > window.innerHeight - 10) pop.style.top  = (event.clientY - r.height - margin) + 'px';
  });
}
// Synthetic p from the Review modal's live form inputs — feeds the same breakdown popover
// the Step 3 table rows use. Lets the operator hover the green Total card and see the full
// derivation (perf fee → super → cash split → GST claim) without occupying card real estate.
function rvBuildSyntheticP_() {
  const num  = id => parseFloat(document.getElementById(id) && document.getElementById(id).value || '0') || 0;
  const text = id => (document.getElementById(id) && document.getElementById(id).value) || '';
  const total = num('rv-total');
  const gstOn = !!(document.getElementById('rv-gst') && document.getElementById('rv-gst').checked);
  const parking       = num('rv-exp-parking');
  const accommodation = num('rv-exp-accommodation');
  const other         = num('rv-exp-other');
  const expTotal = parking + accommodation + other;
  // Derive Type from GST checkbox + super decision (NA = company / no super)
  const naMode  = !!document.querySelector('input[name="rv-super-mode"][value="na"]:checked');
  const duoMode = !!document.querySelector('input[name="rv-super-mode"][value="duo"]:checked');
  const isCompany = naMode;
  const typeCode  = gstOn ? (isCompany ? 'D' : 'B') : (isCompany ? 'C' : 'A');
  const withholdSuper = !isCompany;
  // Duo with share override — super applies to the override amount, not the full service portion
  const shareInput = document.getElementById('rv-share-override');
  const shareOverride = shareInput && shareInput.value && parseFloat(shareInput.value) > 0 ? parseFloat(shareInput.value) : null;
  const superBase = (duoMode && shareOverride) ? shareOverride : (total - expTotal);
  // Best-effort contractor lookup for fund name (read-only — we don't write back)
  const name = text('rv-name');
  let ctc = null;
  if (typeof contractors !== 'undefined' && Array.isArray(contractors) && name) {
    ctc = contractors.find(c => (c.name || '').toLowerCase() === name.toLowerCase()) || null;
  }
  const superRate = (ctc && ctc.superRate) || 12;
  const fundName  = (ctc && ctc.fundName) || '—';
  return {
    id: '__rv_preview__',
    name: name || '(no name)',
    invoiceNumber: text('rv-inv'),
    perfDate: text('rv-perfdate'),
    date: text('rv-date'),
    total: total,
    type: typeCode,
    serviceFee: total - expTotal,
    superBase: superBase,
    expenses: { parking, accommodation, other, travel: 0 },
    withholdSuper: withholdSuper,
    superRate: superRate,
    contractor: { name: name, fundName: fundName, superRate: superRate },
    amounts: calculateAmounts(total - expTotal, typeCode, superRate)
  };
}
function rvShowBreakdownPopover(event) {
  const p = rvBuildSyntheticP_();
  if (!p.total) return;  // nothing meaningful to show with $0
  const pop = ensureBreakdownPopover();
  pop.innerHTML = buildBreakdownHtml(p);
  pop.style.display = 'block';
  positionPopover(pop, event);
}

function buildBreakdownHtml(p) {
  const r2 = n => Math.round((n||0)*100)/100;
  const $ = n => '$' + (typeof fmt === 'function' ? fmt(n||0) : (n||0).toFixed(2));
  const a = p.amounts || {};
  const total = p.total || 0;
  const typeCode = p.type || 'A';
  const isGST = ['B','D'].includes(typeCode);
  const exp = p.expenses || {};
  const parking = exp.parking || 0;
  const accom   = exp.accommodation || 0;
  const travel  = exp.travel || 0;
  const other   = exp.other || 0;
  // Reimbursements = parking + accom + other. Travel is NOT a reimbursement here — it sits
  // with the performance fee because super applies to it (super on time-based work, regardless
  // of whether the time was at venue or in-transit).
  const reimbTotal = parking + accom + other;
  // Performance fee = invoice total − reimbursements (inc GST for Type B/D, ex GST for A/C)
  const perfFeeIncGST = total - reimbTotal;
  const perfFeeExGST  = isGST ? r2(perfFeeIncGST / 1.1) : perfFeeIncGST;
  const perfFeeGST    = isGST ? r2(perfFeeIncGST - perfFeeExGST) : 0;
  // Super is calculated on perf-fee ex-GST as a SUPER-INCLUSIVE base — super = ex-GST × 12/112
  const superOn = (typeof superDeductionsEnabled === 'function') ? superDeductionsEnabled() : true;
  const superRate = p.superRate || 12;
  const willWithholdSuper = p.withholdSuper && superOn && (a.super || 0) > 0;
  const superAmt = willWithholdSuper ? r2(perfFeeExGST * superRate / (100 + superRate)) : 0;
  const cashToPerformer = r2(total - superAmt);
  // GST claim — full GST on the bill (B/D only). Per-line breakdown for transparency.
  const totalExGST = isGST ? r2(total / 1.1) : total;
  const totalGST   = isGST ? r2(total - totalExGST) : 0;
  const gstOn      = amt => isGST ? r2(amt - amt / 1.1) : 0;
  const acct  = (typeof ACCOUNT_CODES !== 'undefined') ? ACCOUNT_CODES : {};
  const acctServ = acct[typeCode] || '301';
  const fundName = (p.contractor && p.contractor.fundName) || '—';
  const typeLabel = { A:'Individual Sole Trader (no GST)', B:'Individual Sole Trader (plus GST)', C:'Partnerships, Companies, or Trusts (no GST)', D:'Partnerships, Companies, or Trusts (plus GST)' }[typeCode] || typeCode;

  // ── Section: REIMBURSEMENTS ───────────────────────────────────────────────
  const reimbRow = (label, amt, acctCode) => amt > 0 ? `
    <tr><td style="padding-left:14px;color:#5B6B7B">— ${label}</td><td style="text-align:right;color:#5B6B7B;font-size:11px;padding-left:12px">→ ${acctCode}</td><td style="text-align:right">${$(amt)}</td></tr>` : '';
  const reimbSection = reimbTotal > 0 ? `
    <div style="font-weight:600;color:#1B2733;margin:12px 0 4px;font-size:12px">Reimbursements <span style="font-weight:400;color:#94A3B8;font-size:11px">(no super, paid back to performer)</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      ${reimbRow('Parking',       parking, '449')}
      ${reimbRow('Accommodation', accom,   '493-C')}
      ${reimbRow('Other',         other,   acctServ)}
      <tr style="border-top:1px dashed #CBD5E0"><td>Total reimbursements</td><td></td><td style="text-align:right;font-weight:600">${$(reimbTotal)}</td></tr>
    </table>` : '';

  // ── Section: PERFORMANCE FEE ─────────────────────────────────────────────
  const perfFeeSection = `
    <div style="font-weight:600;color:#1B2733;margin:12px 0 4px;font-size:12px">Performance fee <span style="font-weight:400;color:#94A3B8;font-size:11px">(super applies to this)</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr><td>Invoice total</td><td style="text-align:right">${$(total)}</td></tr>
      ${reimbTotal > 0 ? `<tr><td>− Reimbursements</td><td style="text-align:right;color:#5B6B7B">−${$(reimbTotal)}</td></tr>` : ''}
      ${reimbTotal > 0 ? `<tr style="border-top:1px dashed #CBD5E0"><td><strong>Performance fee ${isGST?'(inc GST)':''}</strong></td><td style="text-align:right;font-weight:600">${$(perfFeeIncGST)}</td></tr>` : ''}
      ${isGST ? `<tr><td style="padding-left:14px;color:#5B6B7B;font-size:11px">ex-GST <span style="color:#2F6FB3;font-weight:600">(super applies to this)</span></td><td style="text-align:right;color:#5B6B7B;font-size:11px">${$(perfFeeExGST)}</td></tr>` : ''}
      ${isGST ? `<tr><td style="padding-left:14px;color:#5B6B7B;font-size:11px">GST on perf fee</td><td style="text-align:right;color:#5B6B7B;font-size:11px">${$(perfFeeGST)}</td></tr>` : ''}
    </table>`;

  // ── Section: SUPER DEDUCTION (simpler math: ÷ 1.12 then split) ──────────
  const performerNetExGST = Math.round((perfFeeExGST - superAmt) * 100) / 100;
  const divisor = (100 + superRate) / 100;
  const superSection = superAmt > 0 ? `
    <div style="font-weight:600;color:#1B2733;margin:12px 0 4px;font-size:12px">Super deduction <span style="font-weight:400;color:#94A3B8;font-size:11px">(on perf fee ${isGST?'ex-GST':''} ${$(perfFeeExGST)})</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr><td colspan="2" style="font-size:11px;color:#5B6B7B;padding-bottom:4px">Of ${$(perfFeeExGST)} ex-GST perf fee:</td></tr>
      <tr><td style="padding-left:10px">&rarr; Performer&rsquo;s share (ex-GST) <span style="color:#94A3B8;font-size:11px">(${$(perfFeeExGST)} &divide; ${divisor})</span></td><td style="text-align:right">${$(performerNetExGST)}</td></tr>
      <tr><td style="padding-left:10px">&rarr; Super (the rest)</td><td style="text-align:right;font-weight:700;color:#1F9D63">${$(superAmt)}</td></tr>
      <tr><td colspan="2" style="font-size:11px;color:#5B6B7B;padding-top:2px">  super paid to <strong style="color:#1B2733">${escHtml(fundName)}</strong></td></tr>
      <tr style="border-top:1px dashed #CBD5E0"><td style="font-size:11px;color:#5B6B7B">Check: ${$(performerNetExGST)} + ${$(superAmt)}</td><td style="text-align:right;font-size:11px;color:#5B6B7B">= ${$(perfFeeExGST)} &#x2713;</td></tr>
    </table>` : '';

  // ── Section: WHERE THE MONEY GOES (two-box cash split + sub-breakdown) ──
  const r2x = n => Math.round((n||0)*100)/100;
  const perfFeeNetIncGST = r2x(perfFeeIncGST - superAmt);
  const performerLines = [
    {
      label: superAmt > 0
        ? `Perf fee net (inc GST)<span style="color:#94A3B8"> &middot; ${$(perfFeeIncGST)} &minus; ${$(superAmt)} super</span>`
        : 'Performance fee',
      amt: perfFeeNetIncGST
    },
    { label: 'Parking',       amt: parking },
    { label: 'Accommodation', amt: accom   },
    { label: 'Travel',        amt: travel  },
    { label: 'Other',         amt: other   },
  ].filter(x => x.amt > 0);
  const performerSubLines = performerLines.length > 1 ? `
    <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #C6EBD3;font-size:11px;color:#5B6B7B;line-height:1.55">
      ${performerLines.map(x => `<div style="display:flex;justify-content:space-between"><span>${x.label}</span><span>${$(x.amt)}</span></div>`).join('')}
    </div>` : '';
  const moneySplitSection = `
    <div style="font-weight:600;color:#1B2733;margin:12px 0 6px;font-size:12px">Where the ${$(total)} goes</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div style="background:#EBF8F0;border:1px solid #9AE6B4;border-radius:8px;padding:9px 11px">
        <div style="font-size:10px;color:#1F9D63;font-weight:700;letter-spacing:.4px;text-transform:uppercase">→ Performer</div>
        <div style="font-size:16px;color:#1B2733;font-weight:700;margin-top:2px">${$(cashToPerformer)}</div>
        ${performerSubLines}
      </div>
      ${superAmt > 0 ? `
      <div style="background:#EBF4FF;border:1px solid #A3BFFA;border-radius:8px;padding:9px 11px">
        <div style="font-size:10px;color:#3B5AB8;font-weight:700;letter-spacing:.4px;text-transform:uppercase">→ Super fund</div>
        <div style="font-size:16px;color:#1B2733;font-weight:700;margin-top:2px">${$(superAmt)}</div>
        <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #BFD0F5;font-size:11px;color:#5B6B7B">→ ${escHtml(fundName)}</div>
      </div>` : `
      <div style="background:#F7FAFC;border:1px dashed #CBD5E0;border-radius:8px;padding:9px 11px;color:#94A3B8">
        <div style="font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase">No super</div>
        <div style="font-size:13px;margin-top:2px">withheld this run</div>
      </div>`}
    </div>`;

  // ── Section: GST CLAIM ───────────────────────────────────────────────────
  // Parking + accom always have GST (vendor is GST-registered). Service/Travel/Other depend on
  // the contractor's GST status. So even Type A contractors with parking + accom show a GST claim.
  const gstOnAlways = amt => Math.round((amt - amt / 1.1) * 100) / 100;
  const fullGstClaim = isGST
    ? Math.round((total - total / 1.1) * 100) / 100
    : gstOnAlways(parking + accom);
  const gstSection = fullGstClaim > 0 ? `
    <div style="font-weight:600;color:#1B2733;margin:12px 0 4px;font-size:12px">GST claim (MEC)</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr><td>GST claimable</td><td style="text-align:right;color:#1F9D63;font-weight:700">${$(fullGstClaim)}</td></tr>
      ${isGST ? `<tr><td style="padding-left:14px;font-size:11px;color:#5B6B7B">on performance fee</td><td style="text-align:right;font-size:11px;color:#5B6B7B">${$(perfFeeGST)}</td></tr>` : ''}
      ${parking > 0 ? `<tr><td style="padding-left:14px;font-size:11px;color:#5B6B7B">on parking <span style="color:#94A3B8">(always)</span></td><td style="text-align:right;font-size:11px;color:#5B6B7B">${$(gstOnAlways(parking))}</td></tr>` : ''}
      ${accom > 0   ? `<tr><td style="padding-left:14px;font-size:11px;color:#5B6B7B">on accommodation <span style="color:#94A3B8">(always)</span></td><td style="text-align:right;font-size:11px;color:#5B6B7B">${$(gstOnAlways(accom))}</td></tr>` : ''}
      ${isGST && travel > 0 ? `<tr><td style="padding-left:14px;font-size:11px;color:#5B6B7B">on travel</td><td style="text-align:right;font-size:11px;color:#5B6B7B">${$(gstOn(travel))}</td></tr>` : ''}
      ${isGST && other > 0 ? `<tr><td style="padding-left:14px;font-size:11px;color:#5B6B7B">on other</td><td style="text-align:right;font-size:11px;color:#5B6B7B">${$(gstOn(other))}</td></tr>` : ''}
    </table>` : '';

  return `
    <div style="border-bottom:1px solid #E2E8F0;padding-bottom:8px;margin-bottom:6px">
      <div style="font-weight:700;font-size:13px;color:#1B2733">${escHtml((p.contractor && p.contractor.name) || p.name || '—')}</div>
      <div style="font-size:11px;color:#5B6B7B;margin-top:2px">Inv ${escHtml(p.invoiceNumber||'—')} · Type ${typeCode} — ${typeLabel}</div>
    </div>

    <div style="font-weight:600;color:#1B2733;margin:6px 0 4px;font-size:12px">Invoice</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr><td>Invoice total ${isGST?'(inc GST)':''}</td><td style="text-align:right;font-weight:700">${$(total)}</td></tr>
      ${isGST ? `<tr><td style="padding-left:14px;color:#5B6B7B;font-size:11px">Subtotal (ex-GST)</td><td style="text-align:right;color:#5B6B7B;font-size:11px">${$(totalExGST)}</td></tr>` : ''}
      ${isGST ? `<tr><td style="padding-left:14px;color:#5B6B7B;font-size:11px">GST (10%)</td><td style="text-align:right;color:#5B6B7B;font-size:11px">${$(totalGST)}</td></tr>` : ''}
    </table>

    ${reimbSection}
    ${perfFeeSection}
    ${superSection}
    ${moneySplitSection}
    ${gstSection}
  `;
}

function buildResultsView() {
  // Split event vs AP invoices
  const eventProcessed = processed.filter(p => p.invoiceType !== 'ap');
  const apProcessed    = processed.filter(p => p.invoiceType === 'ap');

  const matched = eventProcessed.filter(p => p.matched);
  const unmatched = eventProcessed.filter(p => !p.matched);
  // Super is driven by the per-row withholdSuper flag (sole traders / A-B) AND the global
  // "Withhold super deductions" toggle — when the toggle is OFF, super is hidden everywhere.
  const superOn = (typeof superDeductionsEnabled === 'function') ? superDeductionsEnabled() : true;
  const showsSuper = p => p.withholdSuper && superOn && (p.amounts?.super||0) > 0;
  const superRows = matched.filter(showsSuper);
  // Super uses the assessable-base recompute (matches what exportXeroCSV emits) — if a
  // performer has parking/accom/other excluded, super applies only to the service portion.
  const r2 = n => Math.round((n||0)*100)/100;
  // Super = performance-fee-ex-GST × rate/(100+rate). p.superBase is INC-GST for B/D.
  const superFor = p => {
    if (!showsSuper(p)) return 0;
    if (p.superBase != null && p.superBase !== (p.serviceFee ?? p.total)) {
      const baseEx = ['B','D'].includes(p.type) ? (p.superBase / 1.1) : p.superBase;
      const rate = p.superRate || 12;
      return Math.round(baseEx * rate / (100 + rate) * 100) / 100;
    }
    return p.amounts?.super || 0;
  };
  const totalSuper = r2(superRows.reduce((sum,p) => sum + superFor(p), 0));
  // Cash to performer = FULL invoice − super (parking + accom + travel + other all pay to
  // the performer too, so they belong in this total — they only get excluded from the SUPER
  // BASE, not from cash). Previously this used p.amounts.cash which is only the service slice.
  const cashFor = p => r2((p.total||0) - superFor(p));
  const totalCash = r2(matched.reduce((s,p) => s + cashFor(p), 0));
  // Column totals for the Stage 2 footer row.
  const totalInvoice = r2(matched.reduce((s,p) => s + (p.total||0), 0));
  // GST claimable = full GST on the bill for B/D contractors (all line items have GST in our
  // model). p.amounts.gst was only the service-portion GST — same scope bug as cash.
  const gstFor = p => ['B','D'].includes(p.type) ? r2((p.total||0) - (p.total||0)/1.1) : 0;
  const totalGstCredit = r2(matched.reduce((s,p) => s + gstFor(p), 0));

  // Stats
  document.getElementById('summary-stats').innerHTML = `
    <div class="stat"><div class="val">${processed.length}</div><div class="lbl">Total invoices</div></div>
    <div class="stat"><div class="val">${superRows.length}</div><div class="lbl">Super-eligible</div></div>
    <div class="stat"><div class="val">$${fmt(totalSuper)}</div><div class="lbl">Total super liability</div></div>
    <div class="stat"><div class="val">$${fmt(totalCash)}</div><div class="lbl">Total cash payments</div></div>`;

  // Unmatched warning
  const warnEl = document.getElementById('unmatched-warn');
  if (unmatched.length) {
    warnEl.classList.remove('hidden');
    warnEl.innerHTML = `<strong>⚠ ${unmatched.length} contractor${unmatched.length>1?'s':''} could not be matched</strong>
      to the Zoho database: ${unmatched.map(p=>`<em>${p.name||'(unnamed)'}</em>`).join(', ')}.
      Select a contractor type (A/B/C/D) in the row below to include them in exports.`;
  } else {
    warnEl.classList.add('hidden');
  }

  // ── Super-details completeness gate (only when super withholding is ON) ──
  // Lists every super-eligible contractor in the run whose Zoho record is missing mandatory
  // super/SAFF fields, with one-click "copy form link" / "email" chase actions.
  // NOTE: ZOHO_ORG + ZOHO_MODULE hoisted up here so the gap-warning chase iteration can
  // reference them. They used to be declared further down (just before the Results table),
  // which created a temporal-dead-zone error when ANY contractor was missing super details —
  // the .map() callback threw "Cannot access 'ZOHO_ORG' before initialization" and the whole
  // table rebuild (incl. the TOTALS row + per-row super cells) never completed.
  const ZOHO_ORG = '657079535';
  const ZOHO_MODULE = 'CustomModule3';
  const gapEl = document.getElementById('super-gap-warn');
  if (gapEl) {
    const incomplete = superDeductionsEnabled()
      ? eventProcessed.filter(p => p.matched && p.withholdSuper && p.contractor
                                && (p.amounts?.super || 0) > 0
                                && missingSuperFields(p.contractor).length)
      : [];
    // de-dupe by contractor
    const seen = new Set(); const uniq = [];
    incomplete.forEach(p => { const k = p.contractor.zohoId || p.contractor.name; if (!seen.has(k)) { seen.add(k); uniq.push(p); } });
    if (uniq.length) {
      gapEl.classList.remove('hidden');
      gapEl.style.cssText = 'background:#FFF5F5;border:1px solid #FEB2B2;border-left:4px solid #C53030;border-radius:6px;padding:12px 16px;margin-bottom:14px';
      const rows = uniq.map(p => {
        const c = p.contractor;
        const id = c.zohoId || '';
        const miss = missingSuperFields(c).join(', ');
        const safeName = escHtml(c.name || p.name || '');
        const zohoUrl = id ? `https://crm.zoho.com/crm/org${ZOHO_ORG}/tab/${ZOHO_MODULE}/${id}` : '';
        const zohoBtnHtml = id
          ? `<a href="${zohoUrl}" target="_blank" rel="noopener" style="font-size:11px;background:#FEFCBF;color:#975A16;border:1px solid #F6E05E;border-radius:4px;padding:3px 9px;cursor:pointer;font-weight:600;text-decoration:none;display:inline-block">↗ Open in Zoho</a>`
          : '<span style="font-size:10px;color:#9B2C2C">no Zoho id</span>';
        return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 0;border-top:1px solid #FED7D7">
          <span style="font-weight:600;color:#742A2A">${safeName}</span>
          <span style="font-size:11px;color:#9B2C2C">missing: ${escHtml(miss)}</span>
          <span style="flex:1"></span>
          ${zohoBtnHtml}
        </div>`;
      }).join('');
      gapEl.innerHTML = `<div style="font-weight:700;color:#C53030;margin-bottom:4px">⚠ ${uniq.length} contractor${uniq.length>1?'s':''} can't have super paid yet — details incomplete</div>
        <div style="font-size:12px;color:#742A2A;margin-bottom:6px">Open each contractor's Zoho profile and trigger the Super Details form workflow from there — Zoho's email template handles the prefill encryption natively. They'll still appear in the contractor bills; only their super is held until complete.</div>
        ${rows}`;
    } else {
      gapEl.classList.add('hidden');
      gapEl.innerHTML = '';
    }
  }

  // Results table — ZOHO_ORG + ZOHO_MODULE already hoisted above for the gap-warn chase.
  const zohoLink = (id) => id
    ? `<a href="https://crm.zoho.com/crm/org${ZOHO_ORG}/tab/${ZOHO_MODULE}/${id}"
         target="_blank" rel="noopener"
         style="font-size:10px;color:var(--teal);text-decoration:none;display:inline-flex;align-items:center;gap:2px;margin-top:3px"
         title="Open contractor record in Zoho CRM">🔗 Zoho record</a>`
    : '';

  const checksCell = (p) => {
    const rowId = p.id;
    const alreadyPaid = p.alreadyPaid || false;
    const alreadyPaidInZoho = p.alreadyPaidInZoho || false;
    const manuallyExcluded = p.manuallyExcluded || false;
    const bm = p.bookingMatch;
    const warnings = [];
    if (alreadyPaid && !alreadyPaidInZoho && !manuallyExcluded) {
      warnings.push(`<span style="background:#FEF2F2;color:#C53030;border:1px solid #FEB2B2;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:600">⚠ Invoice shows $0 due</span>`);
    }
    if (alreadyPaidInZoho) {
      warnings.push(`<span style="background:#FEF2F2;color:#C53030;border:1px solid #FEB2B2;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:600">⚠ Paid in Zoho bookings</span>`);
      // Override button — lets user force-include if Zoho data is wrong
      warnings.push(`<button onclick="overridePaidExclusion(${rowId})"
        style="font-size:10px;background:#EBF8FF;color:#2B6CB0;border:1px solid #90CDF4;border-radius:4px;padding:2px 7px;cursor:pointer;font-weight:600"
        title="Force-include in exports — use if the Zoho booking is incorrectly marked paid">
        ↩ Override — include in export
      </button>`);
    }
    if (manuallyExcluded) {
      warnings.push(`<button onclick="overridePaidExclusion(${rowId})"
        style="font-size:10px;background:#EBF8FF;color:#2B6CB0;border:1px solid #90CDF4;border-radius:4px;padding:2px 7px;cursor:pointer;font-weight:600"
        title="Re-include in exports">
        ↩ Include in export
      </button>`);
    }
    if (bm && !alreadyPaid && bm.costMatch === false) {
      const diff = (bm.costDiff !== null && bm.costDiff !== undefined) ? ` · diff $${Math.abs(bm.costDiff).toFixed(2)}` : '';
      warnings.push(`<span style="background:#FFFBEB;color:#B7791F;border:1px solid #F6E05E;border-radius:4px;padding:2px 6px;font-size:10px" title="The Zoho booking record shows a different amount to this invoice">⚠ Zoho quote: $${bm.entertainer.cost} vs invoice: $${fmt(p.total)}${diff}</span>`);
    }
    if (bm && !alreadyPaid && bm.costMatch === true) {
      warnings.push(`<span style="background:#F0FFF4;color:#276749;border:1px solid #9AE6B4;border-radius:4px;padding:2px 6px;font-size:10px">✓ Invoice matches Zoho booking ($${bm.entertainer.cost})</span>`);
    }
    if (bm && bm.booking?.id) {
      const bookUrl = `https://crm.zoho.com/crm/org${ZOHO_ORG}/tab/Potentials/${bm.booking.id}`;
      warnings.push(`<a href="${bookUrl}" target="_blank" rel="noopener" style="font-size:10px;color:var(--teal);text-decoration:none">📅 ${escHtml(bm.booking.bookingName||'Booking')}</a>`);
    }
    if (!p.perfDate && p.invoiceType !== 'ap') {
      warnings.push(`<span style="background:#FFFBEB;color:#B7791F;border:1px solid #F6E05E;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:600" title="No performance date found on this invoice — enter it manually in Stage 1">⚠ No performance date</span>`);
    }
    return warnings.length
      ? `<div style="display:flex;flex-direction:column;gap:3px;font-size:11px">${warnings.join('')}</div>`
      : `<span style="color:#aaa;font-size:11px">—</span>`;
  };

  // Show/hide AP panel
  document.getElementById('ap-panel').classList.toggle('hidden', apProcessed.length === 0);

  // Render AP table
  const apTbody = document.getElementById('ap-tbody');
  apTbody.innerHTML = apProcessed.map(p => {
    // Infer a description hint from what we know
    const descHint = p.invoiceNumber ? `Inv: ${p.invoiceNumber}` : '—';
    // contractor may be null for ABR-matched rows — safe fallback
    const nameDisplay = p.contractor?.name || p.name || '—';
    return `<tr style="background:#FFFDF0">
      <td><strong>${escHtml(nameDisplay)}</strong></td>
      <td style="font-size:12px">${p.invoiceNumber||'—'}</td>
      <td style="font-size:12px">${p.date||'—'}</td>
      <td><strong>$${fmt(p.total)}</strong></td>
      <td style="font-size:11px;color:#888">${descHint}</td>
    </tr>`;
  }).join('');

  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = eventProcessed.map(p => {
    // Wrap each row in its own try-catch so one bad row can't blank the whole table
    try {
      if (!p.matched) return `<tr style="background:#FDF0F0" id="result-row-${p.id}">
        <td>
          <strong>${escHtml(p.name||'—')}</strong>
          <div style="font-size:10px;color:#c0392b;margin-top:1px">Not matched in Zoho</div>
        </td>
        <td style="font-size:12px">${p.invoiceNumber||'—'}</td>
        <td style="font-size:12px">${p.date||'—'}</td>
        <td colspan="2">
          <div style="display:flex;flex-direction:column;gap:5px">
            <div class="contractor-search-wrap">
              <input type="text" placeholder="🔍 Link to Zoho contractor…"
                oninput="searchContractors(${p.id}, this.value)"
                onblur="setTimeout(()=>hideDropdown(${p.id}),200)"
                style="font-size:12px;padding:4px 7px;width:210px;border:1px solid #FC8181;border-radius:4px;background:#fff">
              <div id="cdrop-${p.id}" class="contractor-dropdown" style="display:none"></div>
            </div>
            <div style="font-size:11px;color:#888;display:flex;align-items:center;gap:5px">
              <span>or set type:</span>
              <select onchange="setManualType(${p.id}, this.value)"
                style="font-size:11px;padding:2px 4px;border:1px solid #CBD5E0;border-radius:3px;background:#fff;cursor:pointer">
                <option value="">A / B / C / D</option>
                <option value="A">A – Individual Sole Trader (no GST)</option>
                <option value="B">B – Individual Sole Trader (plus GST)</option>
                <option value="C">C – Partnerships / Companies / Trusts (no GST)</option>
                <option value="D">D – Partnerships / Companies / Trusts (plus GST)</option>
              </select>
            </div>
          </div>
        </td>
        <td>$${fmt(p.total)}</td>
        <td colspan="3" style="color:#aaa;font-size:12px">— link or type above →</td>
        <td style="text-align:center"><button onclick="event.stopPropagation();removeContractorRow('${p.id}')" title="Remove from this pay run" style="background:transparent;border:1px solid #FCA5A5;color:#C53030;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:11px;line-height:1;padding:0">✕</button></td>
      </tr>`;

      const a = p.amounts || { cash: p.total||0, super: 0, gst: 0, unitAmount: p.total||0, taxAmount: 0 };
      const gstCell = (a.gst > 0) ? `<span class="badge badge-ok">$${fmt(a.gst)}</span>` : '—';
      const gstWarn = p.gstMismatch
        ? `<div style="margin-top:4px"><span class="gst-mismatch-pill s2-tip" onclick="showGSTUpdatePrompt(${p.id})">⚠ GST mismatch — tap to review<span class="s2-tip-box"><strong>GST mismatch</strong>This invoice charges GST, but Zoho has this contractor as not GST-registered. Tap to review and update the contractor record. The export uses the GST-inclusive type so the bill is still correct.</span></span></div>`
        : '';
      const zohoBtn = zohoLink(p.contractor?.id);
      const displayName = p.contractor?.name || p.name || '—';
      const typeCode = p.type || 'A';
      // ABR-only rows: super estimated but not verified against Zoho — show a prompt
      const abrSuperNote = (p.matchSource === 'abr' && ['A','B'].includes(typeCode) && a.super > 0)
        ? `<div style="margin-top:3px"><span class="s2-tip" style="font-size:10px;background:#FFF3E8;color:#C05621;border:1px solid #FBD38D;border-radius:4px;padding:2px 6px;cursor:help">⚠ ABR-only: super estimated — verify<span class="s2-tip-box"><strong>Super estimated from ABR</strong>No Zoho record was found for this contractor — super has been estimated from their ABR registration. Verify they are actually super-eligible before paying.</span></span></div>` : '';
      // Already-paid-in-Zoho is now informational only (no strikethrough, not excluded).
      // Show a warning chip that links to the Zoho booking in a new tab.
      const paidBookingId = p.alreadyPaidInZoho ? p.bookingMatch?.booking?.id : null;
      const paidWarn = p.alreadyPaidInZoho
        ? (paidBookingId
            ? `<a href="https://crm.zoho.com/crm/org${ZOHO_ORG}/tab/Potentials/${paidBookingId}" target="_blank" rel="noopener" class="s2-tip"
                 style="margin-left:6px;font-size:10px;background:#FEF3C7;color:#92400E;border:1px solid #FCD34D;border-radius:4px;padding:1px 6px;text-decoration:none;font-weight:700;vertical-align:middle;white-space:nowrap">⚠ Warning<span class="s2-tip-box"><strong>Possibly already paid</strong>Our records show this invoice may already have been paid in Zoho. Click to open the booking and check before paying it again.</span></a>`
            : `<span class="s2-tip"
                 style="margin-left:6px;font-size:10px;background:#FEF3C7;color:#92400E;border:1px solid #FCD34D;border-radius:4px;padding:1px 6px;font-weight:700;vertical-align:middle;white-space:nowrap;cursor:help">⚠ Warning<span class="s2-tip-box"><strong>Possibly already paid</strong>Our records show this invoice may already have been paid in Zoho. Check the booking before paying it again.</span></span>`)
        : '';
      // ROW-LEVEL super/cash/gst — computed directly from p to avoid any cross-scope closure
      // weirdness that might come from the helper functions. The math here MUST match the
      // dashboard widget; if it doesn't, the console.warn below will tell us.
      const rowSuperOn = superOn;
      let rowSuperVal = 0;
      if (p.withholdSuper && rowSuperOn && (a.super || 0) > 0) {
        if (p.superBase != null && p.superBase !== (p.serviceFee ?? p.total)) {
          const baseEx = ['B','D'].includes(typeCode) ? (p.superBase / 1.1) : p.superBase;
          const r = p.superRate || 12;
          rowSuperVal = Math.round(baseEx * r / (100 + r) * 100) / 100;
        } else {
          rowSuperVal = a.super || 0;
        }
      }
      const showSuperCell = rowSuperVal > 0;
      // Clickable name → re-open the Review modal for a final sense-check (cross-check the PDF
      // + fields) without going back to Enter Invoice Data.
      const nameCell = p.rowId
        ? `<strong><a onclick="openReviewModal('${p.rowId}')" title="Open the Review screen to cross-check this invoice" style="color:var(--navy);cursor:pointer;text-decoration:underline;text-decoration-style:dotted">${escHtml(displayName)}</a></strong>`
        : `<strong>${escHtml(displayName)}</strong>`;
      // Super-details incomplete chip (only when super withholding is ON for this run + this row)
      const superGap = (superDeductionsEnabled() && p.withholdSuper && p.contractor && (a.super||0) > 0)
        ? missingSuperFields(p.contractor) : [];
      const superGapWarn = superGap.length
        ? `<span class="s2-tip" style="margin-left:6px;font-size:10px;background:#FFF5F5;color:#C53030;border:1px solid #FEB2B2;border-radius:4px;padding:1px 6px;font-weight:700;cursor:help">⚠ Super details incomplete<span class="s2-tip-box"><strong>Super can't be paid yet</strong>Missing in Zoho: ${escHtml(superGap.join(', '))}. Use the chase buttons in the banner above to send their pre-filled form.</span></span>`
        : '';
      // Full-bill maths (fixes the scope bug where parking/accom/travel were excluded
      // from Cash to Performer and from GST Credit). superRow = super actually withheld;
      // rowCash = invoice total − super; rowGst = full GST on bill (B/D only).
      // Use the inline values above instead of the helper functions — guarantees consistency.
      const rowSuper = rowSuperVal;
      const rowCash  = Math.round(((p.total || 0) - rowSuperVal) * 100) / 100;
      const rowGst   = ['B','D'].includes(typeCode)
        ? Math.round(((p.total || 0) - (p.total || 0) / 1.1) * 100) / 100
        : Math.round((((p.expenses?.parking||0) + (p.expenses?.accommodation||0))
                     - ((p.expenses?.parking||0) + (p.expenses?.accommodation||0)) / 1.1) * 100) / 100;
      const rowGstCell = rowGst > 0 ? `<span class="badge badge-ok">$${fmt(rowGst)}</span>` : '—';
      // Diagnostic: if dashboard sums say super > 0 for this row but rowSuperVal is 0, log it.
      // Helps debug the "dashboard says $283.93, rows show $0" symptom.
      if (showsSuper(p) && rowSuperVal === 0) {
        console.warn('[buildResultsView] row super mismatch', {
          id: p.id, name: p.contractor?.name || p.name,
          withholdSuper: p.withholdSuper, superOn, amountsSuper: a.super,
          superBase: p.superBase, serviceFee: p.serviceFee, total: p.total,
          typeCode, superRate: p.superRate,
        });
      }
      // Small × button to remove this row from the current pay run (does NOT delete the
      // underlying invoice from Step 2 — re-processing brings it back. Use this to drop a
      // stale/duplicate row, or one that's been paid outside the pay run.)
      // Defensive: stringify p.id so 0 doesn't become "" via falsy coercion in template.
      const pidStr = (p.id !== undefined && p.id !== null) ? String(p.id) : '';
      const removeBtn = pidStr
        ? `<button type="button" onclick="event.stopPropagation();removeContractorRow('${pidStr}');return false;"
            title="Remove from this pay run"
            style="background:transparent;border:1px solid #E2E8F0;color:#94A3B8;width:24px;height:24px;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;padding:0;vertical-align:middle;font-weight:600"
            onmouseover="this.style.background='#FEF2F2';this.style.color='#C53030';this.style.borderColor='#FEB2B2'"
            onmouseout="this.style.background='transparent';this.style.color='#94A3B8';this.style.borderColor='#E2E8F0'">✕</button>`
        : '<span style="color:#CBD5E0">—</span>';
      return `<tr onmouseenter="showRowBreakdown(event, '${p.id}')" onmouseleave="hideRowBreakdown()" onmousemove="moveRowBreakdown(event)" style="cursor:default">
        <td>${nameCell}${superGapWarn}${paidWarn}${gstWarn}${abrSuperNote}${zohoBtn}</td>
        <td>${p.invoiceNumber||'—'}</td>
        <td>${p.date||'—'}</td>
        <td><span class="badge badge-${typeCode.toLowerCase()}">${typeCode}</span></td>
        <td>$${fmt(p.total)}</td>
        <td><strong>$${fmt(rowCash)}</strong></td>
        <td>${showSuperCell ? `<strong style="color:var(--green)">$${fmt(rowSuper)}</strong>` : (a.super > 0 ? `<span style="color:#aaa;font-size:11px" title="Super not withheld for this invoice">—</span>` : '—')}</td>
        <td><code style="font-size:11px">${ACCOUNT_CODES[typeCode]||typeCode}</code></td>
        <td>${rowGstCell}</td>
        <td style="text-align:center">${removeBtn}</td>
      </tr>`;
    } catch(rowErr) {
      // Show the row with an error message so we can see what went wrong
      const safeName = escHtml(p.name || p.invoiceNumber || `Row ${p.id}`);
      return `<tr style="background:#FFF5F5">
        <td colspan="9" style="color:#C53030;font-size:11px;padding:8px 12px">
          ⚠ Render error on <strong>${safeName}</strong>: ${escHtml(String(rowErr))}
        </td>
      </tr>`;
    }
  }).join('')
  // TOTALS footer row — sums across matched contractor rows.
  + (matched.length ? `<tr style="background:#F1F5F9;border-top:2px solid #CBD5E0;font-weight:700">
      <td style="color:var(--navy)">TOTALS <span style="font-weight:400;color:#888;font-size:11px">(${matched.length} to pay)</span></td>
      <td></td><td></td><td></td>
      <td>$${fmt(totalInvoice)}</td>
      <td style="color:var(--navy)">$${fmt(totalCash)}</td>
      <td style="color:var(--green)">$${fmt(totalSuper)}</td>
      <td></td>
      <td>${totalGstCredit > 0 ? '$'+fmt(totalGstCredit) : '—'}</td>
      <td></td>
    </tr>` : '');

  // Export counts — exclude already-paid rows
  const xeroMatched = matched.filter(p => !p.alreadyPaid);
  const xeroAP = apProcessed.filter(p => !p.alreadyPaid);
  const xeroCount = xeroMatched.length + xeroAP.length;
  const superExport = superRows.filter(p => !p.alreadyPaid);
  const superCount = superExport.length;
  const paidCount = processed.filter(p => p.alreadyPaid).length;
  const paidNote = paidCount ? ` · ${paidCount} excluded (paid)` : '';
  const xeroPreviewEl = document.getElementById('xero-preview-count');
  if (xeroPreviewEl) xeroPreviewEl.textContent =
    `${xeroCount} bill${xeroCount!==1?'s':''} (${xeroMatched.length} contractor + ${xeroAP.length} AP supplier)${paidNote}`;
  // SAFF preview: count distinct super-eligible members (rows are aggregated per member)
  const saffMembers = new Set(superExport.filter(p => (p.amounts?.super||0) > 0)
    .map(p => p.contractor?.zohoId || (p.contractor?.name || p.name || '').toLowerCase()));
  const saffEl = document.getElementById('saff-preview-count');
  if (saffEl) saffEl.textContent =
    `${saffMembers.size} member${saffMembers.size!==1?'s':''} in the SAFF file${paidNote}`;
  const zipEl = document.getElementById('zip-preview-count');
  if (zipEl) { const nPdf = processed.filter(p => invoiceFileData['id_' + p.rowId]).length;
    zipEl.textContent = `${nPdf} invoice PDF${nPdf!==1?'s':''} available to download`; }
  initSaffPeriodDefaults();
  const superBillsCount = superExport.filter(p => (p.amounts?.super || 0) > 0).length;
  const superBillsEl = document.getElementById('super-bills-preview-count');
  const consolidateSuper = document.getElementById('super-consolidate')?.checked;
  if (superBillsEl) superBillsEl.textContent = superBillsCount === 0
    ? `No super bills this run${paidNote}`
    : consolidateSuper
      ? `1 consolidated bill (${superBillsCount} line${superBillsCount!==1?'s':''}) to ${CLEARINGHOUSE_NAME}${paidNote}`
      : `${superBillsCount} super bill${superBillsCount!==1?'s':''} to ${CLEARINGHOUSE_NAME}${paidNote}`;

}

// ══════════════════════════════════════════════════════════════════════════════
// Super deduction toggle
// ══════════════════════════════════════════════════════════════════════════════
function superDeductionsEnabled() {
  return document.getElementById('super-deduction-enabled')?.checked === true;
}

function updateSuperToggleUI() {
  const on = superDeductionsEnabled();
  const status = document.getElementById('super-toggle-status');
  const superCard = document.querySelector('#saff-preview-count')?.closest('.export-card');
  if (status) {
    status.style.color = on ? '#27AE60' : '#C05621';
    status.textContent = on
      ? '✓ Super deductions ON (default from 1 July)'
      : '⚠ Super deductions OFF — deduction lines excluded from Xero CSV; Super CSV disabled';
  }
  // Dim the Super CSV card when disabled
  if (superCard) superCard.style.opacity = on ? '' : '0.45';
  // Re-render the results table so the Super Contribution column reflects the toggle.
  if (Array.isArray(processed) && processed.length && typeof buildResultsView === 'function') {
    buildResultsView();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Export: Xero Bills CSV
// ══════════════════════════════════════════════════════════════════════════════
// Build a Xero reference string: first two initials of name + "-" + invoice number
// e.g. "Kim Calapardo" + "INV001" → "KC-INV001"
function xeroReference(name, invNum) {
  const initials = (name || '').trim().split(/\s+/).slice(0,2).map(w => w[0]?.toUpperCase() || '').join('');
  return invNum ? `${initials}-${invNum}` : initials;
}

// ══════════════════════════════════════════════════════════════════════════════
// Xero bill DESCRIPTION builders — shared between exportXeroCSV and buildXeroInvoicesData.
// ══════════════════════════════════════════════════════════════════════════════
// Produces multi-line, step-by-step math descriptions so the performer (reading their
// Xero remittance) can follow every calculation: invoice → GST split → super divide →
// what they receive net. Designed to pre-empt "wait, how did you get $X?" questions.
function buildXeroFeeDescription_(opts) {
  // opts: { invNum, dateReadable, perfFeeIncGST, isGST, superAmt, superRate, superBaseExGST? }
  //   superBaseExGST: ex-GST base on which super was calculated (defaults to perfFee/1.1 for
  //   GST contractors, perfFee for non-GST). Pass explicitly for duo-override cases.
  const fix = n => (Math.round((n||0)*100)/100).toFixed(2);
  const head = `Inv ${opts.invNum || '—'}${opts.dateReadable ? ' · ' + opts.dateReadable : ''} · Performance fee`;
  const lines = [head];

  const perfFee  = opts.perfFeeIncGST || 0;
  const rate     = opts.superRate || 12;
  const divisor  = (100 + rate) / 100;     // 1.12 at 12%
  const superAmt = opts.superAmt || 0;

  // Performance fee breakdown
  if (opts.isGST) {
    const ex  = perfFee / 1.1;
    const gst = perfFee - ex;
    lines.push(`Performance fee: $${fix(perfFee)} (inc GST)`);
    lines.push(`  = $${fix(ex)} (ex-GST) + $${fix(gst)} (10% GST)`);
  } else {
    lines.push(`Performance fee: $${fix(perfFee)}`);
  }

  // Super math (explicit ÷ 1.12 and subtraction)
  if (superAmt > 0) {
    const baseForSuper = opts.superBaseExGST != null
      ? opts.superBaseExGST
      : (opts.isGST ? (perfFee / 1.1) : perfFee);
    const exSuper = baseForSuper - superAmt;
    const baseLabel = opts.isGST ? ' ex-GST' : '';
    lines.push('');
    lines.push(`${rate}% super on $${fix(baseForSuper)}${baseLabel}:`);
    lines.push(`  $${fix(baseForSuper)} ÷ ${divisor.toFixed(2)} = $${fix(exSuper)} (ex-super portion)`);
    const fundLabel = opts.fundName && opts.fundName !== '—' ? `paid to ${opts.fundName}` : 'paid to your super fund';
    lines.push(`  $${fix(baseForSuper)} − $${fix(exSuper)} = $${fix(superAmt)} super → ${fundLabel}`);

    const netInc = perfFee - superAmt;
    lines.push('');
    lines.push(`You receive on this line: $${fix(netInc)}${opts.isGST ? ' (inc GST)' : ''}`);
    lines.push(`  = $${fix(perfFee)} (invoice) − $${fix(superAmt)} (super)`);
    if (opts.isGST) {
      const netEx = netInc / 1.1;
      const netGst = netInc - netEx;
      lines.push(`  In Xero this line shows as $${fix(netEx)} ex-GST + $${fix(netGst)} GST = $${fix(netInc)}`);
    }
  }

  return lines.join('\n');
}

function buildXeroExpenseDescription_(opts) {
  return `${opts.label} · Inv ${opts.invNum || '—'}${opts.dateReadable ? ' · ' + opts.dateReadable : ''}`;
}

function exportXeroCSV() {
  // Xero Bills import template — 25 columns
  // Columns: *ContactName, EmailAddress, POAddressLine1-4, POCity, PORegion, POPostalCode,
  //          POCountry, *InvoiceNumber, Reference, *InvoiceDate, *DueDate, InventoryItemCode,
  //          Description, *Quantity, *UnitAmount, *AccountCode, *TaxType,
  //          TrackingName1, TrackingOption1, TrackingName2, TrackingOption2, Currency
  //
  // Notes:
  //   • Reference  = "Event(s): DD.MM.YY [DD.MM.YY …]" — matches the format used in Xero's bills list.
  //   • InventoryItemCode is left blank — populating it causes Xero to override the AccountCode
  //     and TaxType with whatever the inventory item has saved (often blank), breaking imports.
  //   • Travel expenses use the same sub-contractors AccountCode as the main fee (not 493) because
  //     they are a direct cost of sale and super may be calculated on them.
  //   • InvoiceDate falls back to perfDate then today if the invoice had no date (e.g. Liam Krebs).
  const HDR = ['*ContactName','EmailAddress','POAddressLine1','POAddressLine2','POAddressLine3',
               'POAddressLine4','POCity','PORegion','POPostalCode','POCountry',
               '*InvoiceNumber','Reference','*InvoiceDate','*DueDate','InventoryItemCode',
               'Description','*Quantity','*UnitAmount','*AccountCode','*TaxType',
               'TrackingName1','TrackingOption1','TrackingName2','TrackingOption2','Currency'];
  const rows = [HDR];

  // Helper: build one data row with blanks for all unused columns.
  // InventoryItemCode (col index 14) is always blank — see note above.
  const mkRow = (contact, invNum, ref, invDate, dueDate, desc, qty, amount, acctCode, taxType) =>
    [contact, '', '', '', '', '', '', '', '', '',
     invNum, ref, invDate, dueDate, /*InventoryItemCode*/ '',
     desc, qty, amount, acctCode, taxType,
     '', '', '', '', ''];

  // Resolve a non-empty invoice date: invoice date → perf date → today
  const todayISO = () => new Date().toISOString().split('T')[0];
  const resolveDate = p => formatDateXero(p.date || p.perfDate || todayISO());

  // ── Event contractor invoices (with super logic) ─────────────────────────────
  processed.filter(p => p.matched && p.invoiceType !== 'ap' && !p.alreadyPaid).forEach(p => {
    const a = p.amounts;
    // contractor may be null for ABR-derived rows (no Zoho match, e.g. Queen of Hearts) —
    // use a safe fallback so the export never crashes on a missing contractor.
    const c = p.contractor || {};
    const cName     = p.contractor?.name || p.name || '(Unknown)';
    // The Xero bill "From"/ContactName uses the exact Xero entity name when we have it
    // (e.g. "Jazz to Rock Entertainment Pty Ltd"), so it matches the existing Xero contact and
    // doesn't create a duplicate. Falls back to the contractor name. Descriptions still use cName.
    const billContact = c.xeroName || cName;
    const invNum    = p.invoiceNumber || autoInvNum(p);
    const dateXero  = resolveDate(p);
    const dateReadable = formatDateReadable(p.perfDate || p.date);
    const typeCode  = p.type || 'A';   // default so account/tax never export blank (e.g. Heidi)
    const acctCode  = ACCOUNT_CODES[typeCode];
    const taxType   = TAX_TYPES[typeCode];
    const eventRef  = buildEventReference(p); // e.g. "Event(s): 09.05.26"
    const isGSTContractor = ['B','D'].includes(typeCode);

    // Super withheld for this invoice (on superBase = service fee + travel; never on
    // parking/accommodation). This is also what Bill 2 (the clearing-house bill) charges.
    const willWithholdSuper = p.withholdSuper && superDeductionsEnabled();
    const superAmt = willWithholdSuper
      ? (p.superBase != null && p.superBase !== (p.serviceFee ?? p.total)
          ? calculateAmounts(p.superBase, p.type, p.superRate).super
          : a.super)
      : 0;

    // Reference shown in Xero = the *InvoiceNumber field (bills have no separate Reference
    // import column). Same descriptive flow as the super bill, minus "| Super".
    const eventDates = (eventRef.replace(/^Event\(s\):\s*/, '').trim())
                     || formatDateReadable(p.perfDate || p.date) || dateXero;
    const billRef = `Event Date(s): ${eventDates} | ${invNum}`;

    // Multi-line description — step-by-step math (perf fee → GST split → super ÷ → net)
    const perfFeeIncGST_csv = (p.total || 0) - ((p.expenses && (p.expenses.parking||0)+(p.expenses.accommodation||0)+(p.expenses.other||0)) || 0);
    const assessableInc_csv = (p.superBase != null ? p.superBase : (p.serviceFee ?? p.total)) || 0;
    const superBaseExGST_csv = isGSTContractor ? (assessableInc_csv / 1.1) : assessableInc_csv;
    const feeDesc = buildXeroFeeDescription_({
      invNum, dateReadable, perfFeeIncGST: perfFeeIncGST_csv, isGST: isGSTContractor,
      superAmt, superRate: p.superRate || 12, superBaseExGST: superBaseExGST_csv,
      fundName: c.fundName || (p.contractor && p.contractor.fundName) || null
    });

    // Bill 1 pays the contractor NET as a single fee line — NO negative super line on the bill.
    // Super is its own separate bill (Bill 2 → clearing house). For GST contractors the fee line
    // is net-of-super ex-GST (Xero re-adds 10% via "GST on Expenses").
    // NOTE (accountant): claiming GST on the net slightly reduces the GST credit vs the gross
    // invoice — kept this way per the requested clean two-bill split (no in-bill deduction line).
    const grossFee = a.unitAmount + a.super;   // ex-GST service fee (B) / full service fee (A)
    const feeAmount = isGSTContractor
      ? (grossFee - superAmt / 1.1)
      : (grossFee - superAmt);
    // One fee line per EVENT DATE when an invoice covers multiple bookings — split by each
    // booking's cost, with the LAST line absorbing rounding so the lines always sum to the net
    // fee (bill total unchanged). Same billRef → Xero keeps them on ONE bill. Single-date invoices
    // are unchanged (one line, original description).
    const feeLBs = (p.linkedBookings || []).filter(b => (b.cost || 0) > 0);
    if (feeLBs.length > 1) {
      const totalCost = feeLBs.reduce((sum, b) => sum + (b.cost || 0), 0);
      let allocated = 0;
      feeLBs.forEach((lb, i) => {
        const last = i === feeLBs.length - 1;
        const amt = last ? (feeAmount - allocated) : Math.round(feeAmount * (lb.cost / totalCost) * 100) / 100;
        allocated += amt;
        const dr = formatDateReadable(lb.eventDate) || dateReadable;
        // First line carries the full perf-fee/super breakdown; subsequent dates just label the event.
        const lineDesc = (i === 0)
          ? buildXeroFeeDescription_({
              invNum, dateReadable: dr, perfFeeIncGST: perfFeeIncGST_csv,
              isGST: isGSTContractor, superAmt, superRate: p.superRate || 12,
              superBaseExGST: superBaseExGST_csv,
              fundName: c.fundName || (p.contractor && p.contractor.fundName) || null
            })
          : `Performance fee (this date) · Event ${dr} · Inv ${invNum}`;
        rows.push(mkRow(billContact, billRef, eventRef, dateXero, addDaysToXeroCSVDate(dateXero, 7), lineDesc, 1, amt.toFixed(2), acctCode, taxType));
      });
    } else {
      rows.push(mkRow(billContact, billRef, eventRef, dateXero, addDaysToXeroCSVDate(dateXero, 7), feeDesc, 1, feeAmount.toFixed(2), acctCode, taxType));
    }

    // Lines 2+ — expense splits (parking / accommodation / travel). Same billRef so Xero keeps
    // them on the one bill. Travel uses the sub-contractor account (direct cost of sale).
    if (p.expenses) {
      // Parking + Accommodation: always GST-inclusive (vendor is GST-registered) — MEC claims GST
      // even when the contractor isn't GST-registered. Travel + Other: follow contractor status.
      const expItems = [
        { label: 'Parking',          amount: p.expenses.parking       || 0, account: '449',    alwaysGST: true  },
        { label: 'Accommodation',    amount: p.expenses.accommodation || 0, account: '493-C',  alwaysGST: true  },
        { label: 'Travel',           amount: p.expenses.travel        || 0, account: acctCode, alwaysGST: false },
        { label: 'Other (no super)', amount: p.expenses.other         || 0, account: acctCode, alwaysGST: false },
      ];
      expItems.filter(x => x.amount > 0).forEach(x => {
        const itemHasGST = x.alwaysGST || isGSTContractor;
        const itemTaxType = itemHasGST ? 'GST on Expenses' : 'GST Free Expenses';
        const exGSTAmt = itemHasGST ? (x.amount / 1.1) : x.amount;
        const expDesc = buildXeroExpenseDescription_({ label: x.label, invNum, dateReadable });
        rows.push(mkRow(billContact, billRef, eventRef, '', '', expDesc, 1, exGSTAmt.toFixed(2), x.account, itemTaxType));
      });
    }
  });

  // ── Other AP invoices (supplier bills — no super, no splits) ─────────────────
  processed.filter(p => p.invoiceType === 'ap' && !p.alreadyPaid).forEach(p => {
    const invNum    = p.invoiceNumber || autoInvNum(p);
    const dateXero  = resolveDate(p);
    const dateReadable = formatDateReadable(p.date);
    const supplierName = p.name || '(Unknown Supplier)';
    const apTaxType  = p.hasGST ? 'GST on Expenses' : 'GST Free Expenses';
    const apAcctCode = '310';
    const apDesc = [supplierName, p.invoiceNumber ? `Inv: ${p.invoiceNumber}` : null, dateReadable].filter(Boolean).join(' | ');
    const apAmount = p.hasGST ? (p.total / 1.1).toFixed(2) : p.total.toFixed(2);
    rows.push(mkRow(supplierName, invNum, '', dateXero, addDaysToXeroCSVDate(dateXero, 7), apDesc, 1, apAmount, apAcctCode, apTaxType));
  });

  downloadCSV(rows, `MEC_Xero_Bills_Contractor_${today()}.csv`);
}

// ══════════════════════════════════════════════════════════════════════════════
// PUSH TO XERO — live API push of contractor bills via the Apps Script proxy.
// ══════════════════════════════════════════════════════════════════════════════
// Mirrors exportXeroCSV's data shape but emits Xero JSON Invoice objects:
//   - One Invoice per contractor bill (event contractor or AP supplier).
//   - LineItems[] groups all rows that the CSV path would emit under one bill.
//   - Each Invoice can optionally carry an _attachment {filename, base64} which
//     the proxy strips off and PUTs to /Invoices/{id}/Attachments/{filename}.
// All bills are pushed as DRAFT — Nathan still reviews + approves in Xero.
//
// ── Xero AU tax type codes (these are the API codes, not the display names):
//      INPUT          = "GST on Expenses"        (Type B/D contractors + AP-with-GST)
//      EXEMPTEXPENSES = "GST Free Expenses"      (Type A/C contractors + AP-no-GST)
//      BASEXCLUDED    = "BAS Excluded"           (used for the test push only)
function xeroTaxType_(typeCode) {
  return ['B','D'].includes(typeCode) ? 'INPUT' : 'EXEMPTEXPENSES';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const v = r.result || '';
      const i = v.indexOf(',');
      resolve(i >= 0 ? v.slice(i + 1) : v);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Build the JSON Invoice array Xero expects. Parallel to exportXeroCSV's row
// construction so the two exports stay in lockstep on tax types, account codes,
// super-deduction maths, multi-event splitting, expense lines, etc.
function buildXeroInvoicesData() {
  const out = [];
  if (!Array.isArray(processed)) return out;
  const todayISO = () => new Date().toISOString().split('T')[0];
  // Xero's JSON API requires ISO yyyy-MM-dd (the CSV import wants dd/MM/yyyy — different beast).
  // Accept any of: dd/MM/yyyy (CSV form), yyyy-MM-dd (already ISO), or a Date object.
  const toISO = v => {
    if (!v) return todayISO();
    if (v instanceof Date) return v.toISOString().split('T')[0];
    const m = String(v).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      const d = m[1].padStart(2,'0'), mo = m[2].padStart(2,'0');
      const y = m[3].length === 2 ? ('20' + m[3]) : m[3];
      return `${y}-${mo}-${d}`;
    }
    const m2 = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
    // Last resort: try Date() parsing
    const d2 = new Date(v);
    return isNaN(d2) ? todayISO() : d2.toISOString().split('T')[0];
  };
  const resolveDate = p => toISO(p.date || p.perfDate || todayISO());
  const r2 = n => Math.round((n || 0) * 100) / 100;

  // ── Event contractor bills ─────────────────────────────────────────────────
  processed.filter(p => p && p.matched && p.invoiceType !== 'ap' && !p.alreadyPaid).forEach(p => {
    const a = p.amounts || {};
    const c = p.contractor || {};
    const cName = c.name || p.name || '(Unknown)';
    const billContact = c.xeroName || cName;
    const invNum = p.invoiceNumber || autoInvNum(p);
    const dateXero = resolveDate(p);
    const dateReadable = formatDateReadable(p.perfDate || p.date) || '';
    const typeCode = p.type || 'A';
    const acctCode = ACCOUNT_CODES[typeCode];
    const taxType = xeroTaxType_(typeCode);
    const eventRef = buildEventReference(p);
    const isGSTContractor = ['B','D'].includes(typeCode);

    const willWithholdSuper = p.withholdSuper && superDeductionsEnabled();
    const superAmt = willWithholdSuper
      ? (p.superBase != null && p.superBase !== (p.serviceFee ?? p.total)
          ? calculateAmounts(p.superBase, p.type, p.superRate).super
          : (a.super || 0))
      : 0;

    const assessable = (p.superBase != null ? p.superBase : (p.serviceFee ?? p.total)) || 0;
    const superNote = superAmt > 0
      ? ` | $${assessable.toFixed(2)} Total Assessable - $${superAmt.toFixed(2)} superannuation (12%) deducted and remitted to your super fund on your behalf`
      : '';

    const grossFee = (a.unitAmount || 0) + (a.super || 0);
    const feeAmount = isGSTContractor
      ? (grossFee - superAmt / 1.1)
      : (grossFee - superAmt);

    const lineItems = [];

    // Fee — split per event date when multi-event, otherwise single line
    const feeLBs = (p.linkedBookings || []).filter(b => (b.cost || 0) > 0);
    if (feeLBs.length > 1) {
      const totalCost = feeLBs.reduce((sum, b) => sum + (b.cost || 0), 0);
      let allocated = 0;
      const perfFeeIncGST_pushMulti = (p.total || 0) - ((p.expenses && (p.expenses.parking||0)+(p.expenses.accommodation||0)+(p.expenses.other||0)) || 0);
      const assessableInc_pushM = (p.superBase != null ? p.superBase : (p.serviceFee ?? p.total)) || 0;
      const superBaseExGST_pushM = isGSTContractor ? (assessableInc_pushM / 1.1) : assessableInc_pushM;
      feeLBs.forEach((lb, i) => {
        const last = i === feeLBs.length - 1;
        const amt = last ? r2(feeAmount - allocated) : r2(feeAmount * (lb.cost / totalCost));
        allocated += amt;
        const dr = formatDateReadable(lb.eventDate) || dateReadable;
        // First line carries the full perf-fee/super breakdown; subsequent dates just label the event.
        const desc = (i === 0)
          ? buildXeroFeeDescription_({
              invNum, dateReadable: dr, perfFeeIncGST: perfFeeIncGST_pushMulti,
              isGST: isGSTContractor, superAmt, superRate: p.superRate || 12,
              superBaseExGST: superBaseExGST_pushM,
              fundName: (p.contractor && p.contractor.fundName) || null
            })
          : `Performance fee (this date) · Event ${dr} · Inv ${invNum}`;
        lineItems.push({
          Description: desc,
          Quantity: 1,
          UnitAmount: amt,
          AccountCode: acctCode,
          TaxType: taxType
        });
      });
    } else {
      const perfFeeIncGST_push = (p.total || 0) - ((p.expenses && (p.expenses.parking||0)+(p.expenses.accommodation||0)+(p.expenses.other||0)) || 0);
      const assessableInc_push = (p.superBase != null ? p.superBase : (p.serviceFee ?? p.total)) || 0;
      const superBaseExGST_push = isGSTContractor ? (assessableInc_push / 1.1) : assessableInc_push;
      const desc = buildXeroFeeDescription_({
        invNum, dateReadable, perfFeeIncGST: perfFeeIncGST_push, isGST: isGSTContractor,
        superAmt, superRate: p.superRate || 12, superBaseExGST: superBaseExGST_push,
        fundName: (p.contractor && p.contractor.fundName) || null
      });
      lineItems.push({
        Description: desc,
        Quantity: 1,
        UnitAmount: r2(feeAmount),
        AccountCode: acctCode,
        TaxType: taxType
      });
    }

    // Expense lines — parking (449), accommodation (493-C), travel + other (acctCode)
    if (p.expenses) {
      // Parking + Accom: always GST-inclusive (vendor is GST-registered). Travel + Other follow contractor.
      const items = [
        { label: 'Parking',           amount: p.expenses.parking       || 0, account: '449',    alwaysGST: true  },
        { label: 'Accommodation',     amount: p.expenses.accommodation || 0, account: '493-C',  alwaysGST: true  },
        { label: 'Travel',            amount: p.expenses.travel        || 0, account: acctCode, alwaysGST: false },
        { label: 'Other (no super)',  amount: p.expenses.other         || 0, account: acctCode, alwaysGST: false },
      ];
      items.filter(x => x.amount > 0).forEach(x => {
        const itemHasGST = x.alwaysGST || isGSTContractor;
        const itemTaxType = itemHasGST ? 'INPUT' : 'EXEMPTEXPENSES';
        const exGSTAmt = itemHasGST ? (x.amount / 1.1) : x.amount;
        const expDesc = buildXeroExpenseDescription_({ label: x.label, invNum, dateReadable });
        lineItems.push({
          Description: expDesc,
          Quantity: 1,
          UnitAmount: r2(exGSTAmt),
          AccountCode: x.account,
          TaxType: itemTaxType
        });
      });
    }

    // PDF filename mirrors the Invoice PDFs ZIP convention: "Name - Event 26.05.26 - Inv 1016.pdf"
    const safeName = s => String(s||'').replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g,' ').trim();
    const evRaw = eventRef.replace(/^Event\(s\):\s*/, '').trim();
    const evDates = evRaw ? evRaw.split(/\s+/).filter(Boolean) : [];
    const evLabel = evDates.length ? `${evDates.length > 1 ? 'Events' : 'Event'} ${evDates.join(', ')}` : '';
    const pdfFilename = safeName(`${cName}${evLabel ? ' - ' + evLabel : ''} - Inv ${invNum}`) + '.pdf';
    // Xero ACCPAY quirk: the UI label "Reference" comes from the API's InvoiceNumber field —
    // setting InvoiceNumber to the formatted billRef puts "Event Date(s): X | Y" where you expect
    // to see it. API's Reference field is a secondary, less-prominent field — keep eventRef there.
    const eventDatesPush = (eventRef.replace(/^Event\(s\):\s*/, '').trim())
                       || formatDateReadable(p.perfDate || p.date) || dateXero;
    const billRefPush = `Event Date(s): ${eventDatesPush} | ${invNum}`;
    out.push({
      Type: 'ACCPAY',
      Status: 'DRAFT',
      Contact: { Name: billContact },
      Date: dateXero,
      DueDate: addDaysISO(dateXero, 7),
      InvoiceNumber: billRefPush,
      Reference: eventRef,
      LineAmountTypes: 'Exclusive',
      LineItems: lineItems,
      _rowId: p.rowId,
      _contactName: billContact,
      _pdfFilename: pdfFilename
    });
  });

  // ── AP supplier bills (simpler, no super, account code 310) ────────────────
  processed.filter(p => p && p.invoiceType === 'ap' && !p.alreadyPaid).forEach(p => {
    const invNum = p.invoiceNumber || autoInvNum(p);
    const dateXero = resolveDate(p);
    const dateReadable = formatDateReadable(p.date) || '';
    const supplierName = p.name || '(Unknown Supplier)';
    const apTaxType = p.hasGST ? 'INPUT' : 'EXEMPTEXPENSES';
    const apAcctCode = '310';
    const apDesc = [supplierName, p.invoiceNumber ? `Inv: ${p.invoiceNumber}` : null, dateReadable].filter(Boolean).join(' | ');
    const apAmount = p.hasGST ? ((p.total || 0) / 1.1) : (p.total || 0);
    const apSafeName = s => String(s||'').replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g,' ').trim();
    const apPdfFilename = apSafeName(`${supplierName} - Inv ${invNum}`) + '.pdf';
    out.push({
      Type: 'ACCPAY',
      Status: 'DRAFT',
      Contact: { Name: supplierName },
      Date: dateXero,
      DueDate: addDaysISO(dateXero, 7),
      InvoiceNumber: invNum,
      LineAmountTypes: 'Exclusive',
      LineItems: [{
        Description: apDesc,
        Quantity: 1,
        UnitAmount: r2(apAmount),
        AccountCode: apAcctCode,
        TaxType: apTaxType
      }],
      _rowId: p.rowId,
      _contactName: supplierName,
      _pdfFilename: apPdfFilename
    });
  });

  return out;
}

// Main orchestrator — wired to the "↗ Push to Xero" button.
async function pushToXero() {
  if (!Array.isArray(processed) || !processed.length) {
    showBanner('Nothing to push — process some invoices first.', 'warn');
    return;
  }
  const proxyUrl = (localStorage.getItem('xeroProxyUrl') || '').trim();
  if (!proxyUrl) {
    showBanner('Open ⚙ Settings and paste your Xero Push URL first.', 'warn');
    return;
  }
  const accessKey = (localStorage.getItem('xeroAccessKey') || '').trim();
  if (!accessKey) {
    showBanner('Open ⚙ Settings and paste your Xero Access Key first.', 'warn');
    return;
  }

  const invoices = buildXeroInvoicesData();
  if (!invoices.length) {
    showBanner('No bills to push — every row is excluded (already paid, unmatched, etc.).', 'warn');
    return;
  }

  // Confirm before live push
  const apCount = invoices.filter(i => i.Contact.Name && processed.find(p => p.rowId === i._rowId && p.invoiceType === 'ap')).length;
  const contractorCount = invoices.length - apCount;
  const msg =
    `Push ${invoices.length} draft bill${invoices.length>1?'s':''} to Xero?

` +
    `  • ${contractorCount} contractor bill${contractorCount!==1?'s':''}
` +
    `  • ${apCount} supplier bill${apCount!==1?'s':''}

` +
    `Bills appear in Xero → Bills to pay → Drafts. Nothing is approved or paid until you do that manually in Xero.

` +
    `Each PDF will be attached to its bill where available.`;
  if (!confirm(msg)) return;

  const btn = document.getElementById('push-xero-btn');
  const originalBtn = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Preparing PDFs…'; }
  showBanner(`Preparing ${invoices.length} bill${invoices.length>1?'s':''} for Xero…`, 'info');

  // Fetch PDFs as base64 and attach. Skip silently if a PDF isn't available.
  let attachedCount = 0;
  for (const inv of invoices) {
    const rowId = inv._rowId;
    const pdfUrl = rowId && (typeof invoiceFileData !== 'undefined') && invoiceFileData['id_' + rowId];
    if (pdfUrl) {
      try {
        const blob = await (await fetch(pdfUrl)).blob();
        const base64 = await blobToBase64(blob);
        // Filename comes from buildXeroInvoicesData using the same convention as the
        // Invoice PDFs ZIP — "Name - Event 26.05.26 - Inv 1016.pdf" — so Xero's attachment
        // list matches what's on your computer when you'd previously downloaded the ZIP.
        const filename = inv._pdfFilename || `${(inv._contactName||'Invoice').replace(/[^a-zA-Z0-9 \-_.]/g,'_')} - ${(inv.InvoiceNumber||'Bill').replace(/[^a-zA-Z0-9 \-_.]/g,'_')}.pdf`;
        inv._attachment = { filename, base64 };
        attachedCount++;
      } catch (e) { /* PDF unavailable — skip silently, bill still pushes */ }
    }
  }

  if (btn) btn.innerHTML = `⏳ Pushing ${invoices.length} bill${invoices.length>1?'s':''}…`;

  try {
    const url = `${proxyUrl}?action=createBills&key=${encodeURIComponent(accessKey)}`;
    // NOTE: use text/plain (not application/json) to avoid the CORS preflight
    // OPTIONS request — Apps Script web apps don't answer OPTIONS so the browser
    // aborts with "Failed to fetch". Apps Script's doPost still reads the body
    // from e.postData.contents regardless of Content-Type.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ invoices })
    });
    const data = await res.json().catch(() => ({ httpStatus: res.status, response: { raw: 'non-JSON response' } }));
    showXeroResultPanel(data, invoices.length, attachedCount);
  } catch (err) {
    showBanner('Push to Xero failed: ' + (err && err.message || err), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalBtn || '↗ Push to Xero'; }
  }
}

function showXeroResultPanel(data, requestedCount, attachedCount) {
  const overlay = document.getElementById('xero-result-overlay');
  const titleEl = document.getElementById('xero-result-title');
  const bodyEl  = document.getElementById('xero-result-body');
  if (!overlay || !titleEl || !bodyEl) {
    // Fallback if modal isn't in the DOM (older cached HTML)
    console.warn('Xero result modal not found — falling back to alert');
    alert('Xero push complete. See console for details.');
    console.log(data);
    return;
  }

  const httpStatus = data && data.httpStatus;
  const r = data && data.response;
  const httpOk = httpStatus >= 200 && httpStatus < 300;

  let successCount = 0;
  let failures = [];

  if (httpOk && r && Array.isArray(r.Invoices)) {
    r.Invoices.forEach(inv => {
      const hasErr = inv.HasErrors || (Array.isArray(inv.ValidationErrors) && inv.ValidationErrors.length);
      if (hasErr) {
        failures.push({
          contact: (inv.Contact && inv.Contact.Name) || '(unknown contact)',
          invoiceNumber: inv.InvoiceNumber || '',
          errors: (inv.ValidationErrors || []).map(e => e.Message).filter(Boolean).join('; ') || 'unknown error'
        });
      } else if (inv.InvoiceID) {
        successCount++;
      }
    });
  }

  // Attachment outcomes (proxy returns data.attachments[])
  const attachReports = Array.isArray(data && data.attachments) ? data.attachments : [];
  const attachOk   = attachReports.filter(a => a.ok).length;
  const attachFail = attachReports.filter(a => !a.ok).length;

  const allOk = httpOk && successCount === requestedCount && !failures.length;
  const allFail = successCount === 0;
  const titleColor = allOk ? '#1A7F37' : (allFail ? '#C0362C' : '#B7791F');
  const titleText = allOk
    ? `✓ ${successCount} bill${successCount!==1?'s':''} pushed to Xero`
    : (allFail
        ? `✕ Push failed — 0 of ${requestedCount} bills created`
        : `⚠ ${successCount} of ${requestedCount} bills pushed — ${failures.length} failed`);
  titleEl.style.color = titleColor;
  titleEl.textContent = titleText;

  const summaryRows = [
    `Requested: <strong>${requestedCount}</strong> bill${requestedCount!==1?'s':''}`,
    `Created in Xero: <strong>${successCount}</strong>`,
    failures.length ? `Failed: <strong style="color:#C0362C">${failures.length}</strong>` : null,
    attachReports.length ? `PDFs attached: <strong>${attachOk}</strong>${attachFail ? ` <span style="color:#C0362C">(${attachFail} failed)</span>` : ''}` : null,
    `HTTP status: <strong>${httpStatus || '—'}</strong>`
  ].filter(Boolean).map(t => `<div style="margin:3px 0">${t}</div>`).join('');

  const failuresHtml = failures.length ? `
    <div style="margin-top:14px;padding:12px 14px;background:#FFF5F5;border:1px solid #FECACA;border-radius:8px">
      <div style="font-weight:600;color:#C0362C;margin-bottom:6px">${failures.length} bill${failures.length>1?'s':''} could not be created in Xero:</div>
      <ul style="margin:0;padding-left:20px;font-size:12px;color:#7F1D1D;line-height:1.6">
        ${failures.map(f => `<li><strong>${escHtml(f.contact)}</strong>${f.invoiceNumber ? ' · '+escHtml(f.invoiceNumber) : ''} — ${escHtml(f.errors)}</li>`).join('')}
      </ul>
      <div style="margin-top:8px;font-size:11px;color:#7F1D1D">Tip: fix the underlying data in the Review modal (e.g. missing fee, bad account code) and push again. The bills that already succeeded are already in Xero — don't push them twice or you'll get duplicates.</div>
    </div>` : '';

  const attachFailHtml = attachFail ? `
    <div style="margin-top:10px;padding:10px 14px;background:#FFFBEA;border:1px solid #FDE68A;border-radius:8px;font-size:12px;color:#7A5A12">
      ⚠ ${attachFail} PDF${attachFail!==1?'s':''} couldn't be attached. The bill itself was created — you can drag the PDF onto it manually in Xero.
    </div>` : '';

  const nextStepHtml = successCount > 0 ? `
    <div style="margin-top:14px;padding:12px 14px;background:#F0F9FF;border:1px solid #BFDBFE;border-radius:8px;font-size:13px;color:#1E40AF">
      <div style="font-weight:600;margin-bottom:4px">Next step</div>
      Open Xero → <strong>Business → Bills to pay → Drafts</strong>. Review each bill, attach any PDFs that didn't auto-attach, then click <strong>Approve</strong> to move them into Awaiting Payment.
    </div>` : '';

  const httpErrorHtml = !httpOk ? `
    <div style="margin-top:14px;padding:12px 14px;background:#FFF5F5;border:1px solid #FECACA;border-radius:8px">
      <div style="font-weight:600;color:#C0362C;margin-bottom:6px">Proxy / Xero rejected the request (HTTP ${httpStatus || '?'})</div>
      <div style="font-size:12px;color:#7F1D1D">Most common causes: expired access key, scope mismatch (re-authorise after adding accounting.attachments), tenant disconnected, or bad payload. Raw response below.</div>
    </div>` : '';

  const rawHtml = r ? `
    <details style="margin-top:12px">
      <summary style="cursor:pointer;color:#5B6B7B;font-size:12px;padding:4px 0">Raw Xero response (debug)</summary>
      <pre style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;padding:10px;font-size:11px;overflow:auto;max-height:240px;white-space:pre-wrap;word-break:break-word">${escHtml(JSON.stringify(r, null, 2))}</pre>
    </details>` : '';

  bodyEl.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;font-size:13px;color:#1B2733;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px 14px">
      ${summaryRows}
    </div>
    ${nextStepHtml}
    ${httpErrorHtml}
    ${failuresHtml}
    ${attachFailHtml}
    ${rawHtml}
  `;

  overlay.style.display = 'flex';
}

function closeXeroResult() {
  const overlay = document.getElementById('xero-result-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════════════════════
// Export: Xero Super Bills CSV (Bill 2 — billed to the clearing house)
// ══════════════════════════════════════════════════════════════════════════════
// One bill per super-eligible contractor invoice, addressed to the clearing-house
// supplier. Single description line carrying performer / event date(s) / invoice # /
// invoice total / super % / super $. Coded to 478-C, BAS Excluded. These are paid as a
// SEPARATE ABA batch from the contractor bills, so they live in their own CSV file.
// ══════════════════════════════════════════════════════════════════════════════
// PUSH SUPER BILLS TO XERO — parallel to pushToXero/buildXeroInvoicesData but for
// the clearing-house bills (account 478-C, BAS Excluded). Honours "Combine into one
// bill" — when off, one ACCPAY bill per super-eligible invoice; when on, one
// consolidated bill with a line per contractor.
// ══════════════════════════════════════════════════════════════════════════════
function buildXeroSuperInvoicesData() {
  const out = [];
  if (!superDeductionsEnabled()) return out;
  if (!Array.isArray(processed)) return out;
  const r2 = n => Math.round((n||0) * 100) / 100;
  const todayISO = () => new Date().toISOString().split('T')[0];
  const toISO = v => {
    if (!v) return todayISO();
    const m = String(v).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      const d = m[1].padStart(2,'0'), mo = m[2].padStart(2,'0');
      const y = m[3].length === 2 ? ('20' + m[3]) : m[3];
      return `${y}-${mo}-${d}`;
    }
    const m2 = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
    const d2 = new Date(v);
    return isNaN(d2) ? todayISO() : d2.toISOString().split('T')[0];
  };
  const resolveDate = p => toISO(p.date || p.perfDate || todayISO());

  const consolidate = !!document.getElementById('super-consolidate')?.checked;
  const todayIso = todayISO();
  const todayReadable = formatDateReadable(todayIso) || todayIso;
  const conRef = `MEC Super ${todayReadable}`;

  const superRows = processed.filter(p => p && p.matched && p.invoiceType !== 'ap'
                                       && !p.alreadyPaid && p.withholdSuper)
                              .map(p => {
    const superAmt = (p.superBase != null && p.superBase !== (p.serviceFee ?? p.total))
      ? calculateAmounts(p.superBase, p.type, p.superRate).super
      : (p.amounts?.super || 0);
    if (!(superAmt > 0)) return null;
    const cName = p.contractor?.name || p.name || '(Unknown)';
    const invNum = p.invoiceNumber || autoInvNum(p);
    const eventRef = buildEventReference(p);
    const eventDates = (eventRef.replace(/^Event\(s\):\s*/, '').trim())
                     || formatDateReadable(p.perfDate || p.date) || resolveDate(p);
    const rate = p.superRate || 12;
    const desc = `Super ${rate}% on $${(p.total||0).toFixed(2)} | ${cName} | Event Date(s): ${eventDates} | INV-${invNum} | $${superAmt.toFixed(2)}`;
    return { p, cName, invNum, eventDates, rate, superAmt: r2(superAmt), desc, dateXero: resolveDate(p) };
  }).filter(Boolean);

  if (!superRows.length) return out;

  if (consolidate) {
    const lineItems = superRows.map(r => ({
      Description: r.desc,
      Quantity: 1,
      UnitAmount: r.superAmt,
      AccountCode: SUPER_ACCOUNT,
      TaxType: 'BASEXCLUDED'
    }));
    out.push({
      Type: 'ACCPAY',
      Status: 'DRAFT',
      Contact: { Name: CLEARINGHOUSE_NAME },
      Date: todayIso,
      DueDate: addDaysISO(todayIso, 7),
      InvoiceNumber: conRef,
      Reference: conRef,
      LineAmountTypes: 'Exclusive',
      LineItems: lineItems,
      _isSuperBill: true,
      _contactName: CLEARINGHOUSE_NAME
    });
  } else {
    superRows.forEach(r => {
      // Reference starts with "Super" + uses INV- prefix on the source invoice number.
      const billRef = `Super | ${r.cName} | Event Date(s): ${r.eventDates} | INV-${r.invNum}`;
      out.push({
        Type: 'ACCPAY',
        Status: 'DRAFT',
        Contact: { Name: CLEARINGHOUSE_NAME },
        Date: r.dateXero,
        DueDate: addDaysISO(r.dateXero, 7),
        InvoiceNumber: billRef,
        Reference: `Super · Event(s): ${r.eventDates}`,
        LineAmountTypes: 'Exclusive',
        LineItems: [{
          Description: r.desc,
          Quantity: 1,
          UnitAmount: r.superAmt,
          AccountCode: SUPER_ACCOUNT,
          TaxType: 'BASEXCLUDED'
        }],
        _isSuperBill: true,
        _contactName: CLEARINGHOUSE_NAME
      });
    });
  }
  return out;
}

async function pushSuperBillsToXero() {
  if (!superDeductionsEnabled()) {
    showBanner('Super is OFF for this run. Tick the super toggle first.', 'warn');
    return;
  }
  if (!Array.isArray(processed) || !processed.length) {
    showBanner('Nothing to push — process invoices first.', 'warn');
    return;
  }
  const proxyUrl = (localStorage.getItem('xeroProxyUrl') || '').trim();
  const accessKey = (localStorage.getItem('xeroAccessKey') || '').trim();
  if (!proxyUrl || !accessKey) {
    showBanner('Open ⚙ Settings and paste your Xero Push URL + Access Key first.', 'warn');
    return;
  }

  const invoices = buildXeroSuperInvoicesData();
  if (!invoices.length) {
    showBanner('No super-eligible invoices in this run — no super bills to push.', 'info');
    return;
  }

  const totalSuper = invoices.reduce((sum, inv) =>
    sum + (inv.LineItems || []).reduce((s, li) => s + (li.UnitAmount || 0), 0), 0);

  const ok = confirm(
    `Push ${invoices.length} super bill${invoices.length>1?'s':''} to Xero as DRAFTs?\n\n` +
    `  • Contact: ${CLEARINGHOUSE_NAME}\n` +
    `  • Total super: $${totalSuper.toFixed(2)}\n` +
    `  • Account: ${SUPER_ACCOUNT} (BAS Excluded)\n\n` +
    `These appear in Xero → Bills to pay → Drafts. Pay as a separate ABA batch from contractor bills.`
  );
  if (!ok) return;

  const btn = document.getElementById('push-super-xero-btn');
  const orig = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Pushing…'; }
  showBanner(`Pushing ${invoices.length} super bill${invoices.length>1?'s':''} to Xero…`, 'info');

  try {
    const res = await fetch(`${proxyUrl}?action=createBills&key=${encodeURIComponent(accessKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ invoices })
    });
    const data = await res.json().catch(() => ({ httpStatus: res.status, response: { raw: 'non-JSON response' } }));
    showXeroResultPanel(data, invoices.length, 0);
  } catch (err) {
    showBanner('Push Super Bills to Xero failed: ' + (err && err.message || err), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig || '↗ Push Super Bills to Xero'; }
  }
}

function exportSuperBillsCSV() {
  if (!superDeductionsEnabled()) {
    showBanner('Super is currently OFF for this run. Tick “Include super contributions in this pay run” to generate the super bills.', 'warn');
    return;
  }
  const HDR = ['*ContactName','EmailAddress','POAddressLine1','POAddressLine2','POAddressLine3',
               'POAddressLine4','POCity','PORegion','POPostalCode','POCountry',
               '*InvoiceNumber','Reference','*InvoiceDate','*DueDate','InventoryItemCode',
               'Description','*Quantity','*UnitAmount','*AccountCode','*TaxType',
               'TrackingName1','TrackingOption1','TrackingName2','TrackingOption2','Currency'];
  const rows = [HDR];
  const mkRow = (contact, invNum, ref, invDate, dueDate, desc, qty, amount, acctCode, taxType) =>
    [contact, '', '', '', '', '', '', '', '', '',
     invNum, ref, invDate, dueDate, /*InventoryItemCode*/ '',
     desc, qty, amount, acctCode, taxType,
     '', '', '', '', ''];
  const todayISO = () => new Date().toISOString().split('T')[0];
  const resolveDate = p => formatDateXero(p.date || p.perfDate || todayISO());

  // Consolidate = ONE bill to the clearing house with a line per contractor (all rows share the
  // same *InvoiceNumber + dates, so Xero groups them). Otherwise one bill per invoice (default).
  const consolidate = document.getElementById('super-consolidate')?.checked;
  const dateAll = formatDateXero(todayISO());
  const conRef  = `MEC Super ${formatDateReadable(todayISO())}`;

  processed.filter(p => p.matched && p.invoiceType !== 'ap' && !p.alreadyPaid
                     && p.withholdSuper && p.amounts?.super > 0)
    .forEach(p => {
      const cName    = p.contractor?.name || p.name || '(Unknown)';
      const invNum   = p.invoiceNumber || autoInvNum(p);
      const dateXero = resolveDate(p);
      const eventRef = buildEventReference(p); // "Event(s): DD.MM.YY …"
      const superAmt = (p.superBase != null && p.superBase !== (p.serviceFee ?? p.total))
        ? calculateAmounts(p.superBase, p.type, p.superRate).super
        : p.amounts.super;
      if (!(superAmt > 0)) return;

      const eventDates = (eventRef.replace(/^Event\(s\):\s*/, '').trim())
                       || formatDateReadable(p.perfDate || p.date) || dateXero;
      // The reference must go in the *InvoiceNumber field: Xero bills have no separate "Reference"
      // import column (see BillTemplate.csv), and the bills list shows InvoiceNumber as the
      // reference. Exact format requested: "Full Name | Event Date(s): … | Invoice Number | Super".
      // It's also naturally unique per contractor+invoice, so two performers sharing an invoice
      // number (Sabrina & Jake both "011") no longer merge into one Xero bill — and there's no
      // initials hack to mangle bracketed aliases like "Jake (Jacob) Fehily" into "J(".
      const rate = p.superRate || 12;
      // "Super" prefix + INV- prefix on the source invoice number, per request.
      const desc = `Super ${rate}% on $${(p.total||0).toFixed(2)} | ${cName} | Event Date(s): ${eventDates} | INV-${invNum} | $${superAmt.toFixed(2)}`;
      if (consolidate) {
        rows.push(mkRow(CLEARINGHOUSE_NAME, conRef, conRef, dateAll, dateAll,
                        desc, 1, superAmt.toFixed(2), SUPER_ACCOUNT, 'BAS Excluded'));
      } else {
        const ref = `Super | ${cName} | Event Date(s): ${eventDates} | INV-${invNum}`;
        rows.push(mkRow(CLEARINGHOUSE_NAME, ref, ref, dateXero, dateXero,
                        desc, 1, superAmt.toFixed(2), SUPER_ACCOUNT, 'BAS Excluded'));
      }
    });

  if (rows.length === 1) {
    showBanner('No super-eligible contractor invoices in this run — no super bills to generate.', 'info');
    return;
  }
  downloadCSV(rows, `MEC_Xero_Bills_Super_${today()}.csv`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Export: Super Clearing House CSV
// ══════════════════════════════════════════════════════════════════════════════
function exportSuperCSV() {
  if (!superDeductionsEnabled()) {
    showBanner('Super is currently OFF for this run. Tick “Include super contributions in this pay run” to enable the Super CSV.', 'warn');
    return;
  }
  const rows = [['EmployerName','MemberFirstName','MemberLastName','TFN',
                  'FundName','FundUSI','FundABN','MemberAccountNumber',
                  'ContributionType','ContributionAmount','PaymentDate',
                  'PayPeriodStart','PayPeriodEnd']];

  // Dates as DD/MM/YYYY — NOT the compact YYYYMMDD that today() returns (Xero/clearing-house
  // upload rejected "20260520" with "could not be converted to a date").
  const todayISO = new Date().toISOString().split('T')[0];
  const payDate = formatDateXero(todayISO);
  processed.filter(p => p.matched && p.invoiceType !== 'ap' && !p.alreadyPaid && p.withholdSuper && p.amounts?.super > 0)
    .forEach(p => {
      const c = p.contractor || {};
      const fullName = c.name || p.name || '';
      const nameParts = fullName.split(' ');
      const firstName = nameParts.slice(0,-1).join(' ') || fullName;
      const lastName = nameParts.length > 1 ? nameParts[nameParts.length-1] : '';
      const periodDate = formatDateXero(p.date || todayISO);
      rows.push([
        'Melbourne Entertainment Company',
        firstName, lastName,
        c.tfn || '',
        c.fundName || '',
        c.fundUSI || '',
        c.fundABN || '',
        c.memberNumber || '',
        'SGC',
        p.amounts.super.toFixed(2),
        payDate,
        periodDate,
        periodDate,
      ]);
    });

  downloadCSV(rows, `MEC_Super_Contributions_${today()}.csv`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Export: AustralianSuper SAFF (SuperStream) CSV — QuickSuper Contribution spec (cols A–AM)
// ══════════════════════════════════════════════════════════════════════════════
// One row PER super-eligible contractor (super amounts summed if they have several invoices in
// the run). Built to the QuickSuper Contribution CSV File Specification. Upload via the
// AustralianSuper Employer Portal / QuickSuper → Contribution Files → Upload File.
// Dates use the spec's D-MMM-YY format (e.g. 6-MAY-26). TFN/DOB are sensitive — handled in
// memory only (never committed to the repo).
const SAFF_HEADER = [
  'Your File Reference','Your File Date','Contribution Period Start Date','Contribution Period End Date',
  'Employer ID','Payroll ID','Name Title','Family Name','Given Name','Other Given Name','Name Suffix',
  'Date of Birth','Gender','Tax File Number','Phone Number','Mobile Number','Email Address',
  'Address Line 1','Address Line 2','Address Line 3','Address Line 4','Suburb','State','Post Code','Country',
  'Employment Start Date','Employment End Date','Employment End Reason',
  'Fund ID','Fund Name','Fund Employer ID','Member ID',
  'Employer Super Guarantee Amount','Employer Additional Amount','Member Salary Sacrifice Amount',
  'Member Additional Amount','Other Contributor Type','Other Contributor Name','Your Contribution Reference'
];

function fmtSaffDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const [y, m, d] = iso.slice(0,10).split('-');
  // DD/MM/YYYY — QuickSuper/AustralianSuper's validator expects a NUMERIC date in this format.
  // (The worded "DD-MMM-YYYY" failed to parse → fields read as "not provided"; 2-digit years
  // were misread as 19xx. Numeric 4-digit DD/MM/YYYY avoids both.)
  return `${d}/${m}/${y}`;
}

// Map a Zoho gender label/value to the SAFF code (M/F/I/N). N = not stated (safe default).
function saffGender(g) {
  const v = String(g || '').trim().toLowerCase();
  if (!v) return 'N';
  if (v === 'f' || v.startsWith('female')) return 'F';
  if (v === 'm' || v.startsWith('male'))   return 'M';
  if (v === 'i' || v.startsWith('intersex') || v.startsWith('indeterminate') || v.startsWith('non')) return 'I';
  return 'N';
}

// SuperStream wants the State/Territory CODE (VIC/NSW/…), not the full name. Normalise whatever
// is typed in Zoho ("Victoria", "vic", "VIC") to the code; pass through anything already short.
function saffState(s) {
  const v = String(s || '').trim().toLowerCase().replace(/\./g, '');
  if (!v) return '';
  const map = {
    'victoria':'VIC','vic':'VIC',
    'new south wales':'NSW','nsw':'NSW',
    'queensland':'QLD','qld':'QLD',
    'south australia':'SA','sa':'SA',
    'western australia':'WA','wa':'WA',
    'tasmania':'TAS','tas':'TAS',
    'northern territory':'NT','nt':'NT',
    'australian capital territory':'ACT','act':'ACT'
  };
  return map[v] || String(s).trim().toUpperCase();
}

function saffGivenName(c, p) {
  // Prefer the Zoho Given Name; strip bracketed aliases e.g. "Ian (Henry)" → "Ian".
  let g = (c.firstName || '').replace(/\(.*?\)/g, '').trim();
  if (!g) { const parts = (c.name || p.name || '').split(/\s+/); g = parts.slice(0,-1).join(' ') || (c.name||p.name||''); }
  return g;
}
function saffFamilyName(c, p) {
  let f = (c.lastName || '').trim();
  if (!f) { const parts = (c.name || p.name || '').split(/\s+/); f = parts.length > 1 ? parts[parts.length-1] : ''; }
  return f;
}

// Pre-fill the contribution-period inputs with the CURRENT pay week (Monday → Sunday),
// only if the user hasn't already set them. They stay editable for in-arrears runs.
function initSaffPeriodDefaults() {
  const startEl = document.getElementById('saff-period-start');
  const endEl   = document.getElementById('saff-period-end');
  if (!startEl || !endEl) return;
  if (startEl.value && endEl.value) return; // respect any value the user set
  const now = new Date();
  const day = now.getDay();                 // 0=Sun,1=Mon,…
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7)); // back to this week's Monday
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const iso = d => d.toISOString().split('T')[0];
  startEl.value = iso(monday);
  endEl.value   = iso(sunday);
}

function exportSAFFCSV() {
  if (!superDeductionsEnabled()) {
    showBanner('Super is currently OFF for this run. Tick “Include super contributions in this pay run” to generate the SAFF file.', 'warn');
    return;
  }
  const startEl = document.getElementById('saff-period-start');
  const endEl   = document.getElementById('saff-period-end');
  const periodStart = startEl?.value || '';
  const periodEnd   = endEl?.value   || '';
  if (!periodStart || !periodEnd) { alert('Please set the Contribution Period start and end dates first.'); return; }
  if (periodEnd < periodStart) { alert('Contribution Period End cannot be before the Start date.'); return; }

  const todayISO = new Date().toISOString().split('T')[0];
  const fileRef  = `MEC Super Wk ${fmtSaffDate(periodStart)}`;
  const fileDate = fmtSaffDate(todayISO);

  // Aggregate super by contractor (one SAFF row per member; sum if multiple invoices this run).
  const byMember = new Map();
  processed.filter(p => p.matched && p.invoiceType !== 'ap' && !p.alreadyPaid
                     && p.withholdSuper && p.amounts?.super > 0)
    .forEach(p => {
      const c = p.contractor || {};
      const superAmt = (p.superBase != null && p.superBase !== (p.serviceFee ?? p.total))
        ? calculateAmounts(p.superBase, p.type, p.superRate).super
        : p.amounts.super;
      if (!(superAmt > 0)) return;
      const key = c.zohoId || (c.name || p.name || 'unknown').toLowerCase();
      if (!byMember.has(key)) byMember.set(key, { c, p, total: 0, refs: [] });
      const e = byMember.get(key);
      e.total += superAmt;
      if (p.invoiceNumber) e.refs.push(p.invoiceNumber);
    });

  if (byMember.size === 0) { showBanner('No super-eligible contractors in this run — nothing to export.', 'info'); return; }

  const rows = [SAFF_HEADER.slice()];
  const warnings = [];
  byMember.forEach(({ c, p, total, refs }) => {
    const family = saffFamilyName(c, p);
    const given  = saffGivenName(c, p);
    const dob    = fmtSaffDate(c.dob || '');
    const gender = saffGender(c.gender);
    const usi    = c.fundUSI || '';
    const member = c.memberNumber || '';
    const sg     = total.toFixed(2);

    // Validate mandatory member fields and collect a per-person warning.
    const missing = [];
    if (!family) missing.push('family name');
    if (!given)  missing.push('given name');
    // Address Line 1 is NOT required (AustralianSuper accepts it blank); the rest are.
    missingSuperFields(c).forEach(m => missing.push(m));
    if (missing.length) warnings.push(`• ${given} ${family}: missing ${missing.join(', ')}`);

    rows.push([
      fileRef, fileDate, fmtSaffDate(periodStart), fmtSaffDate(periodEnd),
      '',                          // E Employer ID
      c.zohoId || '',              // F Payroll ID (stable, unique)
      '',                          // G Name Title
      family, given, '', '',       // H/I/J/K
      dob, gender,                 // L/M
      c.tfn || '',                 // N TFN
      '', c.phone || '', c.email || '',   // O/P/Q
      c.address || '', '', '', '', // R/S/T/U
      c.suburb || '', saffState(c.state), c.postcode || '', 'AU',  // V/W/X/Y
      '', '', '',                  // Z/AA/AB employment
      usi, c.fundName || '', '', member,  // AC/AD/AE/AF
      sg, '', '', '', '', '',      // AG SG amount, AH/AI/AJ/AK/AL
      refs.join('; ')              // AM Your Contribution Reference (invoice #s)
    ]);
  });

  // Filename = AustralianSuper auto-fills its "Description" from this, so make it clear + readable
  // and use DD-MM-YYYY (not the reversed YYYYMMDD).
  const ddmmyyyy = iso => { const [y,m,d] = iso.slice(0,10).split('-'); return `${d}-${m}-${y}`; };
  downloadCSV(rows, `MEC Super Contribution ${ddmmyyyy(periodStart)} to ${ddmmyyyy(periodEnd)}.csv`);

  if (warnings.length) {
    alert('⚠ SAFF generated, but ' + warnings.length + ' member(s) are missing mandatory fields. '
        + 'AustralianSuper may reject these rows until the data is completed in Zoho:\n\n'
        + warnings.join('\n')
        + '\n\nFix the gaps in Zoho, click Refresh from Zoho, and re-export.');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Override paid exclusion — force-include a Zoho-marked-paid row in exports
// ══════════════════════════════════════════════════════════════════════════════
// Drop a row from the current pay run. Doesn't touch Step 2's invoice data, so re-running
// Process Invoices will bring it back — this is purely a "exclude from this run" knob.
function removeContractorRow(rowId) {
  const p = processed.find(x => String(x.id) === String(rowId));
  if (!p) { console.warn('removeContractorRow: row not found', rowId); return; }
  const name = (p.contractor && p.contractor.name) || p.name || 'this invoice';
  const ok = confirm(`Remove ${name} (Inv ${p.invoiceNumber || '—'}) from this pay run?\n\nThe invoice data isn't deleted — re-clicking "Process Invoices" will bring it back. This just drops it from the current Step 3 view + exports.`);
  if (!ok) return;
  // Hide the hover popover BEFORE re-rendering — otherwise it persists because the source <tr>'s
  // mouseleave never fires (the <tr> just disappears from the DOM).
  if (typeof hideRowBreakdown === 'function') hideRowBreakdown();
  processed = processed.filter(x => String(x.id) !== String(rowId));
  buildResultsView();
  if (typeof showBanner === 'function') showBanner(`Removed ${name} from this pay run.`, 'info');
}

function overridePaidExclusion(id) {
  const p = processed.find(x => x.id === id);
  if (!p) return;
  // Clear both paid flags so row is included in exports
  p.alreadyPaid = false;
  p.alreadyPaidInZoho = false;
  p.manuallyExcluded = false;
  // Also uncheck the Stage 1 exclude checkbox if it exists
  const cb = document.getElementById('s1-paid-' + (p.rowId || id));
  if (cb) cb.checked = false;
  buildResultsView();
}

// ══════════════════════════════════════════════════════════════════════════════
// GST Mismatch Modal
// ══════════════════════════════════════════════════════════════════════════════
let gstModalRowId = null;

function showGSTUpdatePrompt(id) {
  const p = processed.find(x => x.id === id);
  if (!p || !p.gstMismatch) return;
  gstModalRowId = id;

  const name = escHtml(p.gstMismatch.contractorName);
  document.getElementById('gst-modal-body').innerHTML =
    `<strong>${name}</strong> is invoicing <strong>with GST</strong>, but their Zoho record ` +
    `shows them as <strong>not GST-registered</strong>. ` +
    `Currently processed as Type&nbsp;<strong>${p.type}</strong>. ` +
    `Click <em>Check ABR Now</em> to verify their current registration status.`;

  document.getElementById('gst-modal-abr').style.display = 'none';
  document.getElementById('gst-modal-update-btn').style.display = 'none';
  document.getElementById('gst-modal-abr-result').textContent = '';
  document.getElementById('gst-modal-overlay').classList.add('open');

  // Auto-trigger ABR check if we have an ABN
  const rawAbn = p.contractor?.abn || p.abn || '';
  const abns = extractAllAbns(rawAbn);
  if (abns.length && document.getElementById('abr-guid')?.value.trim()) {
    runABRCheckForModal();
  }
}

function closeGSTModal() {
  document.getElementById('gst-modal-overlay').classList.remove('open');
  gstModalRowId = null;
}

async function runABRCheckForModal() {
  const p = processed.find(x => x.id === gstModalRowId);
  if (!p) return;

  const abrDiv = document.getElementById('gst-modal-abr');
  const abrResult = document.getElementById('gst-modal-abr-result');
  const updateBtn = document.getElementById('gst-modal-update-btn');

  abrDiv.style.display = 'block';
  abrResult.innerHTML = '<span class="spinner"></span> Checking ABR…';
  updateBtn.style.display = 'none';

  const rawAbn = p.contractor?.abn || p.abn || '';
  const abns = extractAllAbns(rawAbn);
  if (!abns.length) {
    abrResult.textContent = 'No valid ABN found for this contractor.';
    return;
  }

  const guid = document.getElementById('abr-guid')?.value.trim();
  if (!guid) {
    abrResult.textContent = 'ABR GUID not set — enter it in the Settings section above.';
    return;
  }

  // Try each ABN until we get a result
  let abrData = null;
  let usedAbn = null;
  for (const abn of abns) {
    const r = await lookupABN(abn);
    if (r && r.isActive) { abrData = r; usedAbn = abn; break; }
  }

  if (!abrData) {
    abrResult.textContent = 'ABR lookup failed or ABN not active. Check your GUID and network.';
    return;
  }

  const fmtAbn = usedAbn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');
  if (abrData.isGST) {
    abrResult.innerHTML =
      `✅ <strong>${escHtml(abrData.entityName)}</strong> (ABN ${fmtAbn}) is ` +
      `<strong style="color:var(--green)">GST-registered</strong> according to the ABR. ` +
      `Their Zoho record should be updated.`;
    updateBtn.style.display = '';
  } else {
    abrResult.innerHTML =
      `ℹ️ <strong>${escHtml(abrData.entityName)}</strong> (ABN ${fmtAbn}) is ` +
      `<strong style="color:#c0392b">NOT GST-registered</strong> according to the ABR. ` +
      `The invoice may have been raised in error — check with the contractor.`;
    updateBtn.style.display = 'none';
  }
}

function confirmGSTUpdate() {
  const p = processed.find(x => x.id === gstModalRowId);
  if (!p) return;
  const name = p.gstMismatch?.contractorName || 'this contractor';
  const contractorId = p.gstMismatch?.contractorId || '';
  const msg = `Please update ${name} in Zoho CRM to be registered for GST (set Registered_for_GST to true). Zoho ID: ${contractorId}`;

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(msg).then(() => {
      const btn = document.getElementById('gst-modal-update-btn');
      const orig = btn.textContent;
      btn.textContent = '✓ Copied to clipboard!';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
    });
  } else {
    // Fallback: show the message in an alert the user can copy
    window.prompt('Copy this message and paste it to Claude:', msg);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Utilities
// ══════════════════════════════════════════════════════════════════════════════
function downloadCSV(rows, filename) {
  const csv = rows.map(row =>
    row.map(cell => {
      // Collapse any newlines to spaces — Xero imports choke on blank/multi-line
      // description cells, so every cell is kept strictly single-line.
      const s = String(cell ?? '').replace(/[\r\n]+/g, ' ');
      return (s.includes(',') || s.includes('"'))
        ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  ).join('\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Bulk re-download of uploaded invoice PDFs as a ZIP ──
// Renames each PDF "Name - Invoice# - Event date" (Windows-safe) so they sort cleanly and
// drag straight onto the matching Xero bills. Manually-entered rows (no PDF) are skipped.
async function downloadInvoicesZip() {
  if (typeof JSZip === 'undefined') { alert('ZIP library not loaded yet — check your connection and reload the page.'); return; }
  const rows = (Array.isArray(processed) ? processed : []).filter(p => invoiceFileData['id_' + p.rowId]);
  if (!rows.length) { alert('No uploaded invoice PDFs to download.\n\n(Manually-entered invoices have no PDF attached.)'); return; }
  const safe = s => String(s || '').replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  const zip = new JSZip();
  const used = {};
  let added = 0;
  for (const p of rows) {
    try {
      const blob = await (await fetch(invoiceFileData['id_' + p.rowId])).blob();
      const cName  = p.contractor?.name || p.name || 'Unknown';
      const invNum = p.invoiceNumber || autoInvNum(p);
      // Structure: "Name - Event(s) <dates> - Inv <number>". Plural "Events" + comma-separated
      // when there's more than one event date.
      const evRaw = buildEventReference(p).replace(/^Event\(s\):\s*/, '').trim();
      const dates = evRaw ? evRaw.split(/\s+/).filter(Boolean) : [];
      const evLabel = dates.length ? `${dates.length > 1 ? 'Events' : 'Event'} ${dates.join(', ')}` : '';
      const base = safe(`${cName}${evLabel ? ' - ' + evLabel : ''} - Inv ${invNum}`);
      let name = base + '.pdf', n = 2;
      while (used[name]) name = `${base} (${n++}).pdf`;
      used[name] = true;
      zip.file(name, blob);
      added++;
    } catch (e) { console.warn('ZIP: could not read PDF for row', p.rowId, e); }
  }
  if (!added) { alert('Could not read any of the invoice PDFs to zip.'); return; }
  const out = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(out);
  a.download = `MEC Invoices ${today()}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Add N days to an ISO yyyy-MM-dd date and return the new ISO date (NET 7 / 14 / etc).
function addDaysISO(isoDate, n) {
  if (!isoDate) return isoDate;
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoDate;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + (n||0));
  return d.toISOString().split('T')[0];
}
// Same idea for Xero CSV format (dd/MM/yyyy)
function addDaysToXeroCSVDate(xeroDate, n) {
  if (!xeroDate) return xeroDate;
  const m = String(xeroDate).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return xeroDate;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  d.setUTCDate(d.getUTCDate() + (n||0));
  const dd = String(d.getUTCDate()).padStart(2,'0');
  const mm = String(d.getUTCMonth()+1).padStart(2,'0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

function formatDateXero(d) {
  if (!d) return '';
  // Xero accepts DD/MM/YYYY
  if (d.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [y,m,day] = d.split('-');
    return `${day}/${m}/${y}`;
  }
  return d;
}

// Format YYYY-MM-DD → DD.MM.YY  (used in Xero Reference field)
function formatDateDotShort(d) {
  if (!d || !d.match(/^\d{4}-\d{2}-\d{2}$/)) return '';
  const [y,m,day] = d.split('-');
  return `${day}.${m}.${y.slice(2)}`;
}

// Build "Event(s): DD.MM.YY" Reference string for Xero bills.
// Uses linked booking event dates when multiple bookings are selected; falls back to
// the single performance date or the invoice date.
function buildEventReference(p) {
  const seen = new Set();
  const dates = [];
  if (p.linkedBookings && p.linkedBookings.length > 0) {
    p.linkedBookings.forEach(lb => {
      const fmt = formatDateDotShort(lb.eventDate);
      if (fmt && !seen.has(fmt)) { seen.add(fmt); dates.push(fmt); }
    });
  }
  if (!dates.length) {
    const fmt = formatDateDotShort(p.perfDate || p.date);
    if (fmt) dates.push(fmt);
  }
  return dates.length ? `Event(s): ${dates.join(', ')}` : '';
}

function formatDateReadable(d) {
  if (!d) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (d.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const [y,m,day] = d.split('-');
    return `${parseInt(day)} ${months[parseInt(m)-1]} ${y}`;
  }
  return d;
}

function today() {
  return new Date().toISOString().split('T')[0].replace(/-/g,'');
}

function autoInvNum(p) {
  return 'INV-' + (p.id + 1).toString().padStart(3,'0');
}

function fmt(n) {
  return (n||0).toLocaleString('en-AU', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Initial blank row added by bootstrap() ──

// ══════════════════════════════════════════════════════════════════════════════
// Session Persistence  — sessionStorage save/restore + beforeunload warning
// Uses sessionStorage (survives F5 page refresh but not tab close), so an
// accidental Reload can be recovered. PDFs cannot be stored — they must be
// re-uploaded, but all field values, reviewed/flagged status and expense splits
// are fully restored.
// ══════════════════════════════════════════════════════════════════════════════
const SESSION_KEY = 'mec_invoice_session';

function sessionHasWork() {
  const rows = document.querySelectorAll('#pdf-tbody tr[id], #manual-tbody tr[id]');
  // "has work" if there's more than the single blank starter row, or any reviewed/flagged rows
  return reviewedRows.size > 0 || flaggedRows.size > 0 || rows.length > 1
    || (rows.length === 1 && (document.getElementById('name-' + rows[0].id.replace('row-', ''))?.value || '').trim());
}

function sessionSave() {
  try {
    const rows = [];
    document.querySelectorAll('#pdf-tbody tr[id], #ap-review-tbody tr[id], #manual-tbody tr[id]').forEach(tr => {
      const id = tr.id.replace('row-', '');
      const name = document.getElementById('name-'+id)?.value || '';
      if (!name.trim()) return; // skip blank rows
      rows.push({
        id,
        name,
        inv:      document.getElementById('inv-'+id)?.value      || '',
        perfdate: document.getElementById('perfdate-'+id)?.value || '',
        total:    document.getElementById('total-'+id)?.value    || '',
        abn:      document.getElementById('abn-'+id)?.value      || '',
        reviewed: reviewedRows.has(String(id)),
        flagged:  flaggedRows.has(String(id)),
        gst:      invoiceGSTData['id_'+id]     ?? null,
        superOn:  invoiceSuperData?.['id_'+id] ?? null,
        expense:  invoiceExpenseData['id_'+id] || null,
        bookings: invoiceBookingData['id_'+id] || null,
      });
    });
    if (!rows.length) return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ts: Date.now(), rows }));
  } catch(e) { /* sessionStorage unavailable */ }
}

function sessionCheckRestore() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const { ts, rows } = JSON.parse(raw);
    if (!rows?.length) return;
    const ageMin = Math.round((Date.now() - ts) / 60000);
    if (ageMin > 60 * 8) { sessionStorage.removeItem(SESSION_KEY); return; } // discard after 8 hours

    const reviewedCount = rows.filter(r => r.reviewed).length;
    const flaggedCount  = rows.filter(r => r.flagged).length;
    const ageLabel = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin/60)}h ago`;
    const msg = [
      `🔄 Restore unsaved session from ${ageLabel}?`,
      `  • ${rows.length} invoice${rows.length!==1?'s':''}`,
      reviewedCount ? `  • ${reviewedCount} already reviewed` : null,
      flaggedCount  ? `  • ${flaggedCount} flagged` : null,
      '',
      'All field values will be restored. PDFs need to be re-uploaded using the "👁 Review" button.'
    ].filter(l => l !== null).join('\n');

    if (!confirm(msg)) { sessionStorage.removeItem(SESSION_KEY); return; }

    // Clear the starter blank row
    const manualTbody = document.getElementById('manual-tbody');
    if (manualTbody) manualTbody.innerHTML = '';

    // Recreate each saved row as a manual row with all data restored
    rows.forEach(r => {
      addManualRow();
      const newId = 'm' + manualRowId; // ID just created by addManualRow

      // Populate visible fields
      const set = (elId, val) => { const el = document.getElementById(elId); if (el && val != null && val !== '') el.value = val; };
      set('name-'+newId, r.name);
      set('inv-'+newId,  r.inv);
      set('total-'+newId, r.total);
      set('abn-'+newId,  r.abn);

      // Restore data stores under new ID
      if (r.gst    != null) invoiceGSTData['id_'+newId]    = r.gst;
      if (r.superOn != null) { if (!window.invoiceSuperData) window.invoiceSuperData = {}; invoiceSuperData['id_'+newId] = r.superOn; }
      if (r.expense)  invoiceExpenseData['id_'+newId] = r.expense;
      if (r.bookings) {
        invoiceBookingData['id_'+newId] = r.bookings;
        // Restore perfdate from booking data
        if (!r.perfdate && r.bookings[0]?.eventDate) r.perfdate = r.bookings[0].eventDate;
      }
      // Store perfdate in a data attribute for openReviewModal to pick up
      if (r.perfdate) {
        const tr = document.getElementById('row-'+newId);
        if (tr) tr.dataset.perfdate = r.perfdate;
        // Create a hidden perfdate element for openReviewModal compatibility
        const ph = document.createElement('input');
        ph.type = 'hidden'; ph.id = 'perfdate-'+newId; ph.value = r.perfdate;
        const nameEl = document.getElementById('name-'+newId);
        if (nameEl) nameEl.closest('td')?.appendChild(ph);
      }

      // Restore reviewed / flagged state
      if (r.reviewed) {
        reviewedRows.add(String(newId));
        const btn = document.getElementById('rv-btn-'+newId);
        if (btn) { btn.style.background='#EDFAF3'; btn.style.border='1px solid #27AE60'; btn.style.color='#1A7A40'; btn.style.fontWeight='600'; btn.innerHTML='✓ Reviewed'; }
      }
      if (r.flagged) {
        flaggedRows.add(String(newId));
        const btn = document.getElementById('rv-btn-'+newId);
        if (btn) { btn.style.background='#FFFBEB'; btn.style.border='1px solid #E8A020'; btn.style.color='#92400E'; btn.style.fontWeight='600'; btn.innerHTML='⚠ Attention'; }
      }

      // Trigger match update so the Zoho match badge shows
      const nameEl = document.getElementById('name-'+newId);
      if (nameEl && r.name) updateMatch(nameEl, newId);
    });

    // Show the results section
    document.getElementById('pdf-results')?.classList.remove('hidden');
    updateProcessCount();
    sessionStorage.removeItem(SESSION_KEY); // clear after successful restore
  } catch(e) { console.warn('Session restore failed:', e); }
}

// Warn before accidental close/refresh if work is in progress; auto-save so we can offer restore
window.addEventListener('beforeunload', e => {
  if (sessionHasWork()) {
    sessionSave();
    e.preventDefault();
    e.returnValue = ''; // triggers browser's "Leave site?" dialog
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Gmail Integration
// ══════════════════════════════════════════════════════════════════════════════
// ── Gmail helper: find all bookings for a contractor by display name (no date filter) ──
// refDate: email send date — used to sort by proximity so we pick the booking closest
// to when the invoice was submitted (not the furthest future booking)
function gmailFindContractorBookings(senderName, refDate) {
  if (!senderName || !bookings || !bookings.length) return [];
  // Strip company/org names in parentheses (e.g. "Tash Mitchell (Aurora Entertainment)" → "Tash Mitchell")
  const cleanSender = senderName.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const needle = cleanSender.toLowerCase();
  const needleWords = needle.split(/\W+/).filter(w => w.length > 1);
  const needleFirst = needleWords[0] || '';
  const results = [];
  for (const booking of bookings) {
    for (const ent of (booking.entertainers || [])) {
      const entName = (ent.name || '').toLowerCase();
      const entWords = entName.split(/\W+/).filter(w => w.length > 1);
      const entFirst = entWords[0] || '';
      // When both sides have a first+last name, require first names to match
      // (prevents "Pete Mitchell" matching "Tash Mitchell")
      if (needleWords.length >= 2 && entWords.length >= 2 && entFirst !== needleFirst) continue;
      if (_bookingNameMatches(entName, needle)) {
        results.push({ booking, entertainer: ent });
      }
    }
  }
  // Sort by proximity to email date (past bookings near the email preferred over far-future ones)
  return results.sort((a, b) => {
    if (refDate) {
      const refMs = refDate.getTime();
      const proximityScore = bk => {
        if (!bk.booking.eventDate) return Infinity;
        const bkMs = new Date(bk.booking.eventDate + 'T12:00:00').getTime();
        const diff = bkMs - refMs;
        // Prefer past/near bookings: future bookings > 14 days ahead get a big penalty
        return Math.abs(diff) + (diff > 14 * 86400000 ? 9999999 : 0);
      };
      return proximityScore(a) - proximityScore(b);
    }
    // Fallback: most recent first
    const da = a.booking.eventDate ? new Date(a.booking.eventDate) : new Date(0);
    const db = b.booking.eventDate ? new Date(b.booking.eventDate) : new Date(0);
    return db - da;
  });
}

const GMAIL_CLIENT_ID = '364638129753-6t8pj27l7brvbf6ilhjqlno4oq3j5lr2.apps.googleusercontent.com';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

let gmailTokenClient = null;
let gmailAccessToken = null;
let gmailStagingItems = [];
let gmailInvoiceFetchedLabelId = null;

function gmailInit() {
  if (typeof google === 'undefined' || !google.accounts) return;
  gmailTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GMAIL_CLIENT_ID,
    scope: GMAIL_SCOPE,
    callback: async (response) => {
      if (response.error) {
        alert('Google sign-in failed: ' + response.error);
        return;
      }
      gmailAccessToken = response.access_token;
      await gmailOnSignedIn();
    }
  });
}

function gmailDaysChanged(val) {
  const customInput = document.getElementById('gmail-days-custom');
  if (!customInput) return;
  if (val === 'custom') {
    customInput.style.display = 'inline-block';
    customInput.focus();
  } else {
    customInput.style.display = 'none';
  }
}

function gmailSignIn() {
  if (typeof google === 'undefined' || !google.accounts) {
    alert('Google Identity Services is still loading. Please wait a moment and try again.');
    return;
  }
  if (!gmailTokenClient) gmailInit();
  gmailTokenClient.requestAccessToken({ hint: 'pay.melbentco@gmail.com' });
}

async function gmailOnSignedIn() {
  try {
    const resp = await gmailAPIFetch('/profile');
    const profile = await resp.json();
    const emailEl = document.getElementById('gmail-connected-email');
    if (emailEl) emailEl.textContent = profile.emailAddress || 'connected';
    document.getElementById('gmail-auth-section').style.display = 'none';
    document.getElementById('gmail-connected-section').style.display = 'block';
    await gmailEnsureLabel();
  } catch(e) {
    console.error('Gmail sign-in error:', e);
    alert('Error connecting to Gmail: ' + e.message);
  }
}

function gmailSignOut() {
  if (gmailAccessToken) {
    google.accounts.oauth2.revoke(gmailAccessToken, () => {});
    gmailAccessToken = null;
  }
  gmailStagingItems = [];
  document.getElementById('gmail-auth-section').style.display = 'block';
  document.getElementById('gmail-connected-section').style.display = 'none';
  document.getElementById('gmail-staging').style.display = 'none';
}

function gmailAPIFetch(path, options = {}) {
  if (!gmailAccessToken) throw new Error('Not authenticated with Gmail');
  const url = path.startsWith('http') ? path : `${GMAIL_API}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + gmailAccessToken,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

async function gmailEnsureLabel() {
  try {
    const resp = await gmailAPIFetch('/labels');
    const data = await resp.json();
    const existing = (data.labels || []).find(l => l.name === 'Invoice Fetched');
    if (existing) { gmailInvoiceFetchedLabelId = existing.id; return; }
    const createResp = await gmailAPIFetch('/labels', {
      method: 'POST',
      body: JSON.stringify({ name: 'Invoice Fetched', labelListVisibility: 'labelShow', messageListVisibility: 'show' })
    });
    const newLabel = await createResp.json();
    gmailInvoiceFetchedLabelId = newLabel.id;
  } catch(e) {
    console.warn('Could not ensure Invoice Fetched label:', e);
  }
}

async function gmailScanInbox() {
  const btn = document.getElementById('gmail-scan-btn');
  const statusEl = document.getElementById('gmail-scan-status');
  btn.disabled = true;
  btn.textContent = '⏳ Scanning…';
  statusEl.textContent = '';
  // Revoke any cached attachment blob URLs from a previous scan before discarding the items.
  gmailStagingItems.forEach(i => { if (i.pdfBlobUrl) { try { URL.revokeObjectURL(i.pdfBlobUrl); } catch (e) {} } });
  gmailStagingItems = [];

  const sel = document.getElementById('gmail-days-back');
  const daysBack = sel?.value === 'custom'
    ? parseInt(document.getElementById('gmail-days-custom')?.value || '14', 10)
    : parseInt(sel?.value || '60', 10);
  const dateFilter = `newer_than:${daysBack}d`;

  // Exclusions: Dan Murphy's (AP purchasing, not contractor invoices),
  // remittance advices, and MEC's own auto-reply thread noise
  const exclusions = '-from:danmurphys.com.au -subject:remittance -subject:"remittance advice" -subject:"This inbox is for pay"';

  try {
    // Search 1: emails with PDF attachments, not yet labeled (due for submission)
    const q1 = `has:attachment filename:pdf -label:"Invoice Fetched" -label:"Last Invoice Processed" ${exclusions} ${dateFilter}`;
    // Search 2: invoice-subject emails without attachments (likely contain links)
    const q2 = `(subject:invoice OR subject:"tax invoice") -has:attachment -label:"Invoice Fetched" -label:"Last Invoice Processed" ${exclusions} ${dateFilter}`;
    // Search 3: PDF emails ALREADY labeled "Invoice Fetched" (shown in a separate section so you
    // can see what's been done and re-fetch one for testing).
    const q3 = `has:attachment filename:pdf label:"Invoice Fetched" ${exclusions} ${dateFilter}`;

    statusEl.textContent = 'Searching inbox…';
    const [r1, r2, r3] = await Promise.all([
      gmailAPIFetch('/messages?q=' + encodeURIComponent(q1) + '&maxResults=50').then(r => r.json()),
      gmailAPIFetch('/messages?q=' + encodeURIComponent(q2) + '&maxResults=20').then(r => r.json()),
      gmailAPIFetch('/messages?q=' + encodeURIComponent(q3) + '&maxResults=50').then(r => r.json()),
    ]);

    // Deduplicate — attachment emails take priority, then links, then already-fetched
    const seen = new Map();
    for (const m of (r1.messages || [])) seen.set(m.id, 'attachment');
    for (const m of (r2.messages || [])) { if (!seen.has(m.id)) seen.set(m.id, 'link'); }
    for (const m of (r3.messages || [])) { if (!seen.has(m.id)) seen.set(m.id, 'attachment'); }

    if (seen.size === 0) {
      statusEl.textContent = '✅ No new invoice emails found.';
      btn.disabled = false; btn.textContent = '🔍 Scan for Invoices';
      return;
    }

    let processed = 0;
    for (const [msgId, expectedType] of seen) {
      statusEl.textContent = 'Reading ' + (++processed) + '/' + seen.size + '…';
      try {
        const msgResp = await gmailAPIFetch('/messages/' + msgId + '?format=full');
        const msg = await msgResp.json();
        gmailProcessMessage(msg, expectedType);
      } catch(e) { console.warn('Error reading message', msgId, e); }
    }

    gmailRenderStaging();
    // Read each attachment PDF to flag known suppliers (Dan Murphy's etc.) and untick them.
    await gmailDetectSuppliers();
  } catch(e) {
    console.error('Gmail scan error:', e);
    statusEl.textContent = '❌ Error: ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = '🔍 Scan for Invoices';
}

function gmailHeader(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// Decode Gmail base64url body data as UTF-8 (atob alone yields a Latin-1 string, which is what
// produced the "Â" mojibake before non-breaking spaces / curly quotes in the email viewer).
function gmailDecodeB64(data) {
  const bin = atob((data || '').replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { return bin; }
}

function gmailBodyText(payload) {
  if (!payload) return '';
  function fromParts(parts) {
    if (!parts) return '';
    for (const p of parts) {
      if (p.mimeType === 'text/plain' && p.body?.data)
        return gmailDecodeB64(p.body.data);
      if (p.parts) { const t = fromParts(p.parts); if (t) return t; }
    }
    for (const p of parts) {
      if (p.mimeType === 'text/html' && p.body?.data)
        return gmailDecodeB64(p.body.data).replace(/<[^>]+>/g,' ');
    }
    return '';
  }
  if (payload.body?.data) return gmailDecodeB64(payload.body.data);
  return fromParts(payload.parts || []);
}

function gmailExtractInvoiceLinks(text) {
  const urls = (text.match(/https?:\/\/[^\s<>"]+/g) || []);
  return urls.filter(u => {
    const l = u.toLowerCase();
    return l.includes('invoice') || l.includes('/inv') || l.includes('xero') ||
           l.includes('freshbooks') || l.includes('wave') || l.includes('billing');
  });
}

function gmailFindAttachments(payload) {
  const found = [];
  if (!payload) return found;
  for (const part of (payload.parts || [])) {
    if ((part.mimeType === 'application/pdf' || part.filename?.toLowerCase().endsWith('.pdf')) && part.body?.attachmentId) {
      found.push({ filename: part.filename || 'invoice.pdf', attachmentId: part.body.attachmentId, size: part.body.size || 0 });
    }
    found.push(...gmailFindAttachments(part));
  }
  return found;
}

function gmailProcessMessage(msg, expectedType) {
  const headers = msg.payload?.headers || [];
  const subject = gmailHeader(headers, 'subject') || '(no subject)';
  const from = gmailHeader(headers, 'from') || '';
  const dateStr = gmailHeader(headers, 'date');
  const dateFormatted = dateStr ? new Date(dateStr).toLocaleDateString('en-AU', {day:'2-digit', month:'short', year:'numeric'}) : '';

  // Check Gmail star (team uses this to flag emails being worked on)
  const starred = (msg.labelIds || []).includes('STARRED');
  // Already imported? (labeled "Invoice Fetched") — shown in a separate section, unticked by default.
  const fetched = !!gmailInvoiceFetchedLabelId && (msg.labelIds || []).includes(gmailInvoiceFetchedLabelId);
  const emailDateObj = dateStr ? new Date(dateStr) : null;

  // Match sender display name against Zoho contractor database + booking payment status
  const senderDisplay = from.replace(/<[^>]+>/g, '').replace(/"/g, '').trim();
  const zohoMatch = typeof matchContractor === 'function' ? matchContractor(senderDisplay, null) : null;
  const zohoBookings = zohoMatch ? gmailFindContractorBookings(senderDisplay, emailDateObj) : [];
  const todayMs = Date.now();
  const pastBookings   = zohoBookings.filter(b => b.booking.eventDate && new Date(b.booking.eventDate+'T23:59:59').getTime() <= todayMs);
  const futureBookings = zohoBookings.filter(b => !b.booking.eventDate || new Date(b.booking.eventDate+'T23:59:59').getTime() > todayMs);
  const unpaidBookings = pastBookings.filter(b => !b.entertainer.paid);
  const allPaid = pastBookings.length > 0 && unpaidBookings.length === 0;

  // Capture the email body for the import-review modal (HTML preferred; plain text fallback).
  const bodyHtml = gmailBodyHtml(msg.payload);
  const bodyTextFallback = gmailBodyText(msg.payload);
  const base = { messageId: msg.id, subject, from, date: dateFormatted, emailDateObj, selected: true, starred, fetched,
    zohoMatch, zohoBookings, pastBookings, futureBookings, unpaidBookings, allPaid, bodyHtml, bodyTextFallback };

  // Detect remittance/receipt-type emails — flag and uncheck by default
  const suspectWords = /remittance|receipt|payment\s+confirmation|payment\s+advice|paid\s+to\s+you/i;
  const isSuspect = suspectWords.test(subject);

  const attachments = gmailFindAttachments(msg.payload);
  if (attachments.length > 0) {
    for (const att of attachments) {
      const attSuspect = isSuspect || suspectWords.test(att.filename || '');
      const warning = attSuspect ? 'remittance' : allPaid ? 'already-paid' : null;
      gmailStagingItems.push({
        ...base,
        type: 'attachment',
        filename: att.filename,
        attachmentId: att.attachmentId,
        size: att.size,
        selected: !attSuspect && !allPaid && !fetched,   // auto-uncheck if suspect, already paid, or already fetched
        warning
      });
    }
    return;
  }

  const body = gmailBodyText(msg.payload);
  const links = gmailExtractInvoiceLinks(body);
  if (links.length > 0) {
    for (const link of links.slice(0, 2)) {
      gmailStagingItems.push({ ...base, type: 'link', filename: 'Invoice link', linkUrl: link, selected: false });
    }
    return;
  }

  // No PDF, no recognisable link — show for awareness
  gmailStagingItems.push({ ...base, type: 'unknown', filename: '—', selected: false });
}

function gmailSortStaging(mode) {
  if (!gmailStagingItems.length) return;
  gmailStagingItems.sort((a, b) => {
    if (mode === 'date-desc') {
      const da = a.emailDateObj ? a.emailDateObj.getTime() : 0;
      const db = b.emailDateObj ? b.emailDateObj.getTime() : 0;
      return db - da;
    }
    if (mode === 'date-asc') {
      const da = a.emailDateObj ? a.emailDateObj.getTime() : 0;
      const db = b.emailDateObj ? b.emailDateObj.getTime() : 0;
      return da - db;
    }
    if (mode === 'sender') {
      const na = (a.zohoMatch?.name || a.from || '').toLowerCase();
      const nb = (b.zohoMatch?.name || b.from || '').toLowerCase();
      return na.localeCompare(nb);
    }
    if (mode === 'unpaid') {
      // Unpaid past bookings first, then all-paid, then not-in-zoho
      const score = item => {
        if (item.unpaidBookings?.length > 0) return 0;
        if (item.allPaid) return 1;
        return 2;
      };
      return score(a) - score(b);
    }
    return 0;
  });
  gmailRenderStaging();
  // Restore sort select value after re-render
  const sel = document.getElementById('gmail-sort-select');
  if (sel) sel.value = mode;
}

function gmailRenderStaging() {
  const container = document.getElementById('gmail-staging');
  const tbody = document.getElementById('gmail-staging-tbody');
  const summary = document.getElementById('gmail-staging-summary');
  if (!gmailStagingItems.length) { container.style.display = 'none'; return; }

  const readyCt   = gmailStagingItems.filter(i => i.type === 'attachment' && !i.warning).length;
  const paidCt    = gmailStagingItems.filter(i => i.warning === 'already-paid').length;
  const remitCt   = gmailStagingItems.filter(i => i.warning === 'remittance').length;
  const supplierCt= gmailStagingItems.filter(i => i.warning === 'supplier').length;
  const linkCt    = gmailStagingItems.filter(i => i.type === 'link').length;
  const unkCt     = gmailStagingItems.filter(i => i.type === 'unknown').length;
  const fetchedCt = gmailStagingItems.filter(i => i.fetched).length;
  let s = `<strong style="color:#27AE60">📎 ${readyCt} ready to import</strong>`;
  if (fetchedCt) s += ` &nbsp;·&nbsp; <span style="color:#5A7A86">✓ ${fetchedCt} already fetched</span>`;
  if (paidCt)    s += ` &nbsp;·&nbsp; <strong style="color:#C05621">⚠ ${paidCt} may already be paid</strong>`;
  if (remitCt)   s += ` &nbsp;·&nbsp; <span style="color:#C05621">${remitCt} remittance</span>`;
  if (supplierCt)s += ` &nbsp;·&nbsp; <span style="color:#9333EA">🍷 ${supplierCt} supplier</span>`;
  if (linkCt)    s += ` &nbsp;·&nbsp; <span style="color:#E8A020">🔗 ${linkCt} link only</span>`;
  if (unkCt)     s += ` &nbsp;·&nbsp; <span style="color:#888">${unkCt} no PDF</span>`;
  summary.innerHTML = s;

  tbody.innerHTML = '';
  // Render in two stacked sections: due-for-submission first, already-fetched below.
  const anyFetched = gmailStagingItems.some(i => i.fetched);
  const order = [
    ...gmailStagingItems.map((it, i) => ({ it, i })).filter(x => !x.it.fetched),
    ...gmailStagingItems.map((it, i) => ({ it, i })).filter(x => x.it.fetched),
  ];
  const sectionDone = { due: false, fetched: false };
  order.forEach(({ it: item, i: idx }) => {
    if (anyFetched && !item.fetched && !sectionDone.due) {
      const dh = document.createElement('tr');
      dh.innerHTML = `<td colspan="10" style="background:#E8F4F7;color:#1D7A8C;font-size:11px;font-weight:700;padding:6px 12px;letter-spacing:.5px">📥 DUE FOR SUBMISSION</td>`;
      tbody.appendChild(dh);
      sectionDone.due = true;
    }
    if (item.fetched && !sectionDone.fetched) {
      const fh = document.createElement('tr');
      fh.innerHTML = `<td colspan="10" style="background:#EDF2F7;color:#5A7A86;font-size:11px;font-weight:700;padding:6px 12px;letter-spacing:.5px">✓ ALREADY FETCHED (previously imported) · tick a row to re-import for testing</td>`;
      tbody.appendChild(fh);
      sectionDone.fetched = true;
    }
    const tr = document.createElement('tr');
    if (item.fetched) tr.style.opacity = '0.7';
    const canImport = item.type === 'attachment';
    const typeIcon = item.type === 'attachment' ? '📎' : item.type === 'link' ? '🔗' : '❓';
    const badge = item.warning === 'supplier'
      ? `<span style="color:#9333EA;font-size:11px;font-weight:600" title="Detected as a ${item.supplier || 'supplier'} tax invoice (a purchase, not a contractor performance invoice). Unticked by default — open the row to review and include it if you do want it.">🍷 ${item.supplier || 'Supplier'}</span>`
      : item.warning === 'remittance'
      ? `<span style="color:#C05621;font-size:11px;font-weight:600" title="Looks like a remittance advice or payment confirmation — not a contractor invoice. Unchecked by default.">⚠ Remittance?</span>`
      : item.warning === 'already-paid'
      ? `<span style="color:#C05621;font-size:11px;font-weight:600" title="All Zoho bookings for this contractor appear already paid — this invoice may already have been processed. Unchecked by default.">⚠ May be paid</span>`
      : item.type === 'attachment'
      ? `<span style="color:#27AE60;font-size:11px;font-weight:600">✓ Ready</span>`
      : item.type === 'link'
      ? `<span style="color:#E8A020;font-size:11px">Link only</span>`
      : `<span style="color:#aaa;font-size:11px">No PDF</span>`;
    const fromClean = item.from.replace(/<[^>]+>/g,'').replace(/"/g,'').trim();
    const actionCell = item.type === 'link'
      ? `<button onclick="window.open('${item.linkUrl.replace(/'/g,"\\'")}','_blank')" style="font-size:11px;padding:3px 8px;cursor:pointer;background:#E8A020;color:#fff;border:none;border-radius:4px" title="${item.linkUrl}">Open ↗</button>`
      : '';

    // Zoho booking badge — click to open popover listing past/future bookings
    let zohoBadge = '';
    if (item.zohoMatch) {
      const firstName = (item.zohoMatch.name || '').split(' ')[0];
      const pastCount   = (item.pastBookings   || []).length;
      const futureCount = (item.futureBookings  || []).length;
      const unpaidCount = item.unpaidBookings.length;
      if (unpaidCount > 0) {
        zohoBadge = `<button onclick="gmailShowBookings(${idx},event)" style="background:none;border:none;cursor:pointer;color:#1D7A8C;font-size:11px;font-weight:600;padding:0;text-align:left"
          title="${unpaidCount} unpaid past booking(s) — click to see list">✓ ${firstName} — ${unpaidCount} unpaid ▾</button>`;
      } else if (item.allPaid) {
        zohoBadge = `<button onclick="gmailShowBookings(${idx},event)" style="background:none;border:none;cursor:pointer;color:#C05621;font-size:11px;font-weight:600;padding:0;text-align:left"
          title="All past bookings for ${firstName} appear already paid — click to see list">⚠ ${firstName} — all paid ▾</button>`;
      } else if (futureCount > 0) {
        zohoBadge = `<button onclick="gmailShowBookings(${idx},event)" style="background:none;border:none;cursor:pointer;color:#718096;font-size:11px;font-weight:600;padding:0;text-align:left"
          title="No past bookings found — ${futureCount} upcoming — click to see list">↗ ${firstName} — upcoming ▾</button>`;
      } else {
        zohoBadge = `<span style="color:#aaa;font-size:11px">✓ ${firstName} in Zoho</span>`;
      }
    } else {
      zohoBadge = `<span style="color:#aaa;font-size:11px">? Not in Zoho</span>`;
    }

    // PDF preview button (fetch and open attachment in new tab)
    const previewBtn = canImport
      ? `<button id="gmail-prev-${idx}" onclick="gmailPreviewAttachment(${idx})" title="Preview this PDF attachment"
          style="background:#E8F4F7;color:#1D7A8C;border:1px solid #BFD7E0;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap">👁 PDF</button>`
      : '';

    // Star indicator
    const starCell = item.starred
      ? `<span title="Starred in Gmail — this email may already be in progress" style="font-size:14px;cursor:default">⭐</span>`
      : '';

    tr.innerHTML = `
      <td><input type="checkbox" ${canImport && item.selected ? 'checked' : ''} ${!canImport ? 'disabled' : ''}
          onchange="gmailStagingItems[${idx}].selected=this.checked;gmailUpdateSelectAll()"></td>
      <td style="text-align:center">${typeIcon}</td>
      <td style="text-align:center">${starCell}</td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${item.subject.replace(/"/g,'&quot;')}">${item.subject}</td>
      <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#444;font-size:12px" title="${item.from.replace(/"/g,'&quot;')}">${item.zohoMatch?.name || fromClean}</td>
      <td style="font-size:12px;white-space:nowrap">${item.date}</td>
      <td style="max-width:160px">${zohoBadge}</td>
      <td style="font-size:12px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${item.filename}">${item.filename}</td>
      <td>${badge}</td>
      <td style="white-space:nowrap">${previewBtn}${actionCell ? ' ' + actionCell : ''}</td>`;
    // Click anywhere on the row (except a control) to open the import-review modal.
    tr.style.cursor = 'pointer';
    tr.title = 'Click to review this email + PDF and decide whether to import it';
    tr.addEventListener('click', e => {
      if (e.target.closest('button, input, a, select')) return;
      gmailOpenReview(idx);
    });
    tbody.appendChild(tr);
  });

  container.style.display = 'block';
  gmailUpdateSelectAll();
}

function gmailUpdateSelectAll() {
  const allImportable = gmailStagingItems.filter(i => i.type === 'attachment');
  const allSelected = allImportable.length > 0 && allImportable.every(i => i.selected);
  const cb = document.getElementById('gmail-select-all');
  if (cb) cb.checked = allSelected;
  gmailUpdateImportCount();
}

// Live ticked-count → shown on BOTH Import buttons (top & bottom of the list)
function gmailUpdateImportCount() {
  const n = gmailStagingItems.filter(i => i.selected && i.type === 'attachment').length;
  const label = n ? `📥 Import ${n} Selected PDF${n !== 1 ? 's' : ''}` : '📥 Import Selected PDFs';
  ['gmail-import-btn', 'gmail-import-btn-bottom'].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    b.textContent = label;
    b.disabled = (n === 0);
    b.style.opacity = n ? '' : '0.5';
    b.style.cursor = n ? 'pointer' : 'not-allowed';
  });
}

function gmailToggleAll(checked) {
  gmailStagingItems.forEach(item => { if (item.type === 'attachment') item.selected = checked; });
  gmailRenderStaging();
}

async function gmailImportSelected() {
  const selected = gmailStagingItems.filter(i => i.selected && i.type === 'attachment');
  if (!selected.length) { showBanner('No PDF invoices selected.', 'warn'); return; }

  const btn = document.getElementById('gmail-import-btn');
  const statusEl = document.getElementById('gmail-import-status');
  btn.disabled = true;
  if (!gmailInvoiceFetchedLabelId) await gmailEnsureLabel();

  let imported = 0, errors = 0;
  for (const item of selected) {
    statusEl.textContent = 'Downloading: ' + item.filename + '…';
    try {
      const attResp = await gmailAPIFetch('/messages/' + item.messageId + '/attachments/' + item.attachmentId);
      const attData = await attResp.json();
      if (!attData.data) throw new Error('No attachment data returned');

      const b64 = attData.data.replace(/-/g,'+').replace(/_/g,'/');
      const bytes = atob(b64);
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const blob = new Blob([buf], { type: 'application/pdf' });
      const file = new File([blob], item.filename, { type: 'application/pdf' });

      await gmailIngestPDF(file, item);
      await gmailApplyLabel(item.messageId);
      item.status = 'imported';
      imported++;
    } catch(e) {
      console.error('Import error for', item.filename, e);
      item.status = 'error';
      errors++;
    }
  }

  btn.disabled = false;
  statusEl.textContent = '✅ ' + imported + ' imported' + (errors ? ', ' + errors + ' failed' : '') + '. Switching to PDF tab…';
  gmailRenderStaging();

  // Switch to PDF view so user sees the newly-added invoices
  setTimeout(() => switchTab('pdf'), 1200);
}

async function gmailIngestPDF(file, item) {
  // Show file in the pdf-list strip
  const list = document.getElementById('pdf-list');
  const strip = document.createElement('div');
  strip.className = 'pdf-item';
  const statusId = 'gmail-pstatus-' + item.messageId;
  strip.innerHTML = `<span class="name">📧 ${item.filename}</span>
    <span style="font-size:11px;color:#888;margin-left:6px">${item.from.replace(/<[^>]+>/g,'').trim()}</span>
    <span id="${statusId}" class="pdf-status pdf-warn"><span class="spinner"></span> Reading…</span>`;
  list.appendChild(strip);
  list.style.maxHeight = '80px';

  const tbody = document.getElementById('pdf-tbody');
  // Separator if table already has rows
  if (tbody.querySelectorAll('tr[id]').length > 0) {
    const sep = document.createElement('tr');
    sep.innerHTML = `<td colspan="8" style="background:#EDF2F7;color:#718096;font-size:11px;font-weight:600;padding:4px 10px;letter-spacing:0.5px">— Gmail import: ${item.filename} —</td>`;
    tbody.appendChild(sep);
  }

  try {
    const data = await extractPDFData(file);
    const id = 'pdf-gmail-' + Date.now() + Math.random().toString(36).slice(2);
    const match = matchContractor(data.name, data.abn);
    const dupWarning = checkDuplicate(data.abn, data.invoiceNumber, data.total, data.date);
    appendInvoiceRow(tbody, id, data, match, item.filename, dupWarning);
    invoiceGSTData['id_' + id] = !!data.hasGST;
    invoicePaidData['id_' + id] = !!data.alreadyPaid;
    invoicePerfGuess['id_' + id] = !!data.perfDateGuess;
    invoiceTypeData['id_' + id] = data.invoiceTypeHint || 'unknown';
    if (data.detectedExpenses) {
      const de = data.detectedExpenses;
      if (de.parking > 0 || de.accommodation > 0 || de.travel > 0) {
        invoiceExpenseData['id_' + id] = { parking: de.parking, accommodation: de.accommodation, travel: de.travel, other: 0 };
      }
    }
    invoiceFileData['id_' + id] = URL.createObjectURL(file);
    invoiceRawText['id_' + id] = data._rawText || '';
    if (data.abn && document.getElementById('abr-guid')?.value.trim()) doABNLookup(id);
    document.getElementById(statusId).className = 'pdf-status pdf-ok';
    document.getElementById(statusId).textContent = '✓ Extracted';
  } catch(e) {
    const id = 'pdf-gmail-err-' + Date.now();
    appendInvoiceRow(tbody, id, {name:'', invoiceNumber:'', date:'', total:0}, null, item.filename);
    invoiceFileData['id_' + id] = URL.createObjectURL(file);
    document.getElementById(statusId).className = 'pdf-status pdf-warn';
    document.getElementById(statusId).textContent = '⚠ Could not read — enter manually';
  }

  document.getElementById('pdf-results').classList.remove('hidden');
  const totalRows = tbody.querySelectorAll('tr[id]').length;
  document.getElementById('pdf-info').textContent =
    `${totalRows} invoice${totalRows!==1?'s':''} loaded (including Gmail imports). Review and correct fields below.`;
  updateProcessCount();
  sortInvoiceRows('name');
}

// ── Bookings popover ──
let _gmailPopoverIdx = -1;
function gmailShowBookings(idx, evt) {
  evt.stopPropagation();
  const popover = document.getElementById('gmail-bookings-popover');
  if (_gmailPopoverIdx === idx) {
    popover.style.display = 'none';
    _gmailPopoverIdx = -1;
    return;
  }
  _gmailPopoverIdx = idx;
  const item = gmailStagingItems[idx];
  const contractorName = item.zohoMatch?.name || 'this contractor';
  const pastList   = item.pastBookings   || [];
  const futureList = item.futureBookings || [];
  const unpaidPast = pastList.filter(b => !b.entertainer.paid);

  function bookingRow(b) {
    const url = `https://crm.zoho.com/crm/org657079535/tab/Potentials/${b.booking.id}`;
    const evtDate = b.booking.eventDate
      ? new Date(b.booking.eventDate+'T12:00:00').toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short',year:'numeric'})
      : '—';
    const cost = b.entertainer.cost != null ? `$${Number(b.entertainer.cost).toLocaleString()}` : '';
    const dot = b.entertainer.paid
      ? '<span style="color:#FC8181;font-weight:900" title="Paid in Zoho">●</span>'
      : '<span style="color:#4ADE80;font-weight:900" title="Not yet paid">●</span>';
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f5f5f5">
      ${dot}
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.booking.bookingName || '(unnamed)'}</div>
        <div style="color:#888;font-size:11px">${evtDate}</div>
      </div>
      <span style="color:#555;white-space:nowrap">${cost}</span>
      <a href="${url}" target="_blank" style="color:#1D7A8C;font-size:11px;text-decoration:none;white-space:nowrap;flex-shrink:0">Zoho ↗</a>
    </div>`;
  }

  const headerColor = unpaidPast.length > 0 ? '#1D7A8C' : '#C05621';
  const headerText = unpaidPast.length > 0
    ? `${unpaidPast.length} unpaid past booking${unpaidPast.length!==1?'s':''} — ${contractorName}`
    : pastList.length > 0 ? `✓ All past bookings paid — ${contractorName}` : `${contractorName} — no past bookings`;

  let html = `<div style="font-weight:700;font-size:12px;color:${headerColor};margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #eee">${headerText}</div>`;

  if (pastList.length === 0) {
    html += `<div style="color:#888;font-size:12px;margin-bottom:8px">No past events found.</div>`;
  } else {
    for (const b of pastList.slice(0, 10)) html += bookingRow(b);
    if (pastList.length > 10) html += `<div style="color:#888;font-size:11px;margin-top:4px">+${pastList.length-10} more past events</div>`;
  }

  if (futureList.length > 0) {
    html += `<div style="font-weight:700;font-size:11px;color:#718096;margin:10px 0 6px;padding-top:8px;border-top:1px solid #eee;text-transform:uppercase;letter-spacing:.5px">Upcoming (next ${Math.min(futureList.length,5)})</div>`;
    for (const b of futureList.slice(0, 5)) html += bookingRow(b);
  }

  html += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid #eee;text-align:right">
    <button onclick="document.getElementById('gmail-bookings-popover').style.display='none';_gmailPopoverIdx=-1"
      style="font-size:11px;color:#888;background:none;border:none;cursor:pointer">Close ✕</button>
  </div>`;

  popover.innerHTML = html;
  // Position near the button
  const rect = evt.target.getBoundingClientRect();
  const top = Math.min(rect.bottom + 4, window.innerHeight - 300);
  const left = Math.min(rect.left, window.innerWidth - 440);
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
  popover.style.display = 'block';
}
document.addEventListener('click', e => {
  const p = document.getElementById('gmail-bookings-popover');
  if (p && !p.contains(e.target)) { p.style.display = 'none'; _gmailPopoverIdx = -1; }
});

// ── PDF attachment preview ──
async function gmailPreviewAttachment(idx) {
  const item = gmailStagingItems[idx];
  if (!item || item.type !== 'attachment' || !item.attachmentId) return;
  const btn = document.getElementById('gmail-prev-' + idx);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const resp = await gmailAPIFetch('/messages/' + item.messageId + '/attachments/' + item.attachmentId);
    const data = await resp.json();
    if (!data.data) throw new Error('No data');
    const b64 = data.data.replace(/-/g,'+').replace(/_/g,'/');
    const bytes = atob(b64);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    const blob = new Blob([buf], {type:'application/pdf'});
    const blobUrl = URL.createObjectURL(blob);
    const overlay = document.getElementById('gmail-pdf-overlay');
    const frame   = document.getElementById('gmail-pdf-frame');
    const title   = document.getElementById('gmail-pdf-title');
    if (title)   title.textContent = item.filename || 'Invoice PDF';
    if (frame)   frame.src = blobUrl;
    if (overlay) { overlay.style.display = 'flex'; overlay._blobUrl = blobUrl; }
  } catch(e) {
    alert('Could not load PDF: ' + e.message);
  }
  if (btn) { btn.disabled = false; btn.textContent = '👁 PDF'; }
}

function gmailClosePDF() {
  const overlay = document.getElementById('gmail-pdf-overlay');
  const frame   = document.getElementById('gmail-pdf-frame');
  if (overlay) overlay.style.display = 'none';
  if (frame)   { if (overlay._blobUrl) { URL.revokeObjectURL(overlay._blobUrl); overlay._blobUrl = null; } frame.src = ''; }
}

// ══════════════════════════════════════════════════════════════════════════════
// Supplier detection (Dan Murphy's etc.) + import-review modal
// ══════════════════════════════════════════════════════════════════════════════

// Return the supplier label if the text matches a known retail/AP supplier, else null.
function detectSupplier(text) {
  if (!KNOWN_SUPPLIERS.length) return null;
  const t = (text || '').toLowerCase();
  const digits = (text || '').replace(/\D/g, '');
  for (const s of KNOWN_SUPPLIERS) {
    if (s.keywords.some(k => k && t.includes(k))) return s.label;
    if (s.abn && s.abn.length >= 9 && digits.includes(s.abn)) return s.label;
  }
  return null;
}

// Fetch an attachment's bytes once and cache a blob URL on the staging item (reused by the
// supplier scan, the PDF preview and the import-review modal).
async function gmailFetchAttachmentBlobUrl(item) {
  if (item.pdfBlobUrl) return item.pdfBlobUrl;
  const resp = await gmailAPIFetch('/messages/' + item.messageId + '/attachments/' + item.attachmentId);
  const data = await resp.json();
  if (!data.data) throw new Error('No attachment data returned');
  const b64 = data.data.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = atob(b64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  const blob = new Blob([buf], { type: 'application/pdf' });
  item._pdfBlob = blob;
  item.pdfBlobUrl = URL.createObjectURL(blob);
  return item.pdfBlobUrl;
}

// Extract the original HTML body of an email (for the import-review modal's left pane).
function gmailBodyHtml(payload) {
  if (!payload) return '';
  const dec = gmailDecodeB64;
  function find(parts) {
    if (!parts) return '';
    for (const p of parts) {
      if (p.mimeType === 'text/html' && p.body?.data) return dec(p.body.data);
      if (p.parts) { const h = find(p.parts); if (h) return h; }
    }
    return '';
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) return dec(payload.body.data);
  return find(payload.parts || []);
}

// Post-scan pass: read each attachment PDF and flag known suppliers. Low email volume makes the
// extra fetch+parse acceptable; failures are swallowed so one bad PDF can't break the scan.
async function gmailDetectSuppliers() {
  if (!KNOWN_SUPPLIERS.length) return;
  const statusEl = document.getElementById('gmail-scan-status');
  const items = gmailStagingItems.filter(i => i.type === 'attachment' && i.attachmentId && !i.warning && !i.fetched);
  let n = 0;
  for (const item of items) {
    n++;
    if (statusEl) statusEl.textContent = `Checking PDFs for suppliers… ${n}/${items.length}`;
    try {
      await gmailFetchAttachmentBlobUrl(item);
      const file = new File([item._pdfBlob], item.filename || 'invoice.pdf', { type: 'application/pdf' });
      const data = await extractPDFData(file);
      item.pdfText = data?._rawText || '';
      const sup = detectSupplier(`${item.pdfText} ${item.subject || ''} ${item.from || ''}`);
      if (sup) { item.supplier = sup; item.warning = 'supplier'; item.selected = false; }
    } catch (e) { /* leave row unflagged on parse error */ }
  }
  const flagged = gmailStagingItems.filter(i => i.supplier).length;
  if (statusEl) statusEl.textContent = `✅ Scan complete${flagged ? ` · ${flagged} supplier invoice(s) flagged & unticked` : ''}.`;
  gmailRenderStaging();
}

// ── Import-review modal: original email (left) + PDF (right) + Include/Exclude + prev/next ──
let gmailReviewIdx = -1;

async function gmailOpenReview(idx) {
  const item = gmailStagingItems[idx];
  if (!item) return;
  gmailReviewIdx = idx;
  const g = id => document.getElementById(id);
  const fromClean = (item.from || '').replace(/<[^>]+>/g, '').replace(/"/g, '').trim();
  g('gmail-rev-subject').textContent = item.subject || '(no subject)';
  g('gmail-rev-meta').textContent =
    `${fromClean} · ${item.date || ''}` +
    (item.zohoMatch ? ` · ✓ ${item.zohoMatch.name} in Zoho` : ' · ? not in Zoho') +
    (item.supplier ? ` · 🍷 ${item.supplier} (supplier)` : '');

  // Left pane — original HTML email (sandboxed; no scripts run)
  const emailFrame = g('gmail-rev-email');
  emailFrame.srcdoc = item.bodyHtml
    || `<pre style="font-family:system-ui;white-space:pre-wrap;padding:14px;color:#333;font-size:13px">${escHtml(item.bodyTextFallback || '(no email body available)')}</pre>`;

  // Right pane — the attached PDF (fetched + cached on demand)
  const pdfFrame = g('gmail-rev-pdf');
  const pdfNone  = g('gmail-rev-pdf-none');
  g('gmail-rev-pdfname').textContent = (item.type === 'attachment' && item.filename) ? '— ' + item.filename : '';
  if (item.type === 'attachment' && item.attachmentId) {
    pdfNone.style.display = 'none';
    pdfFrame.style.display = 'block';
    pdfFrame.src = '';
    try {
      const url = await gmailFetchAttachmentBlobUrl(item);
      if (gmailReviewIdx === idx) pdfFrame.src = url;   // ignore if user navigated away while loading
    } catch (e) {
      pdfFrame.style.display = 'none';
      pdfNone.textContent = 'Could not load the PDF.';
      pdfNone.style.display = 'flex';
    }
  } else {
    pdfFrame.style.display = 'none';
    pdfFrame.src = '';
    pdfNone.textContent = item.type === 'link' ? 'This email has an invoice link, not a PDF attachment.' : 'No PDF attached to this email.';
    pdfNone.style.display = 'flex';
  }

  gmailReviewUpdateButtons();
  g('gmail-review-overlay').style.display = 'flex';
}

function gmailReviewUpdateButtons() {
  const item = gmailStagingItems[gmailReviewIdx];
  if (!item) return;
  const g = id => document.getElementById(id);
  const importable = item.type === 'attachment';
  const inc = g('gmail-rev-include');
  const exc = g('gmail-rev-exclude');
  inc.disabled = !importable;
  inc.style.opacity = importable ? '1' : '0.4';
  inc.style.cursor = importable ? 'pointer' : 'not-allowed';
  const willImport = importable && item.selected;
  inc.style.outline = willImport ? '2px solid #4ADE80' : 'none';
  exc.style.outline = !willImport ? '2px solid #F87171' : 'none';
  const st = g('gmail-rev-status');
  if (!importable)        { st.textContent = 'No PDF — can’t import'; st.style.background = '#475569'; st.style.color = '#e2e8f0'; }
  else if (item.selected) { st.textContent = '✓ Will be imported';   st.style.background = '#166534'; st.style.color = '#fff'; }
  else                    { st.textContent = '✗ Excluded';           st.style.background = '#7F1D1D'; st.style.color = '#fff'; }
  g('gmail-rev-counter').textContent = `${gmailReviewIdx + 1} of ${gmailStagingItems.length}`;
  const gp = g('gmail-rev-progress'); if (gp) gp.textContent = `Reviewing ${gmailReviewIdx + 1} of ${gmailStagingItems.length}`;
}

function gmailReviewSetInclude(include) {
  const item = gmailStagingItems[gmailReviewIdx];
  if (!item || item.type !== 'attachment') return;
  item.selected = !!include;
  gmailRenderStaging();   // reflect the tick/untick in the list behind the modal
  // Advance to the next invoice so decisions flow; on the last one, just refresh the buttons.
  if (gmailReviewIdx < gmailStagingItems.length - 1) gmailReviewNav(1);
  else gmailReviewUpdateButtons();
}

async function gmailReviewNav(dir) {
  let n = gmailReviewIdx + dir;
  if (n < 0) n = 0;
  if (n >= gmailStagingItems.length) n = gmailStagingItems.length - 1;
  if (n === gmailReviewIdx) return;
  await gmailOpenReview(n);
}

function gmailCloseReview() {
  const overlay = document.getElementById('gmail-review-overlay');
  if (overlay) overlay.style.display = 'none';
  const ef = document.getElementById('gmail-rev-email'); if (ef) ef.srcdoc = '';
  const pf = document.getElementById('gmail-rev-pdf');   if (pf) pf.src = '';
  gmailReviewIdx = -1;   // blob URLs stay cached on items; revoked on next scan
}

async function gmailApplyLabel(messageId) {
  if (!gmailInvoiceFetchedLabelId) return;
  try {
    await gmailAPIFetch('/messages/' + messageId + '/modify', {
      method: 'POST',
      body: JSON.stringify({ addLabelIds: [gmailInvoiceFetchedLabelId], removeLabelIds: [] })
    });
  } catch(e) { console.warn('Could not apply label to', messageId, e); }
}

// ══════════════════════════════════════════════════════════════════════════════
// Bootstrap — load config + data from external JSON, then initialise the UI.
// (Data lives in config.json / contractors.json / bookings.json so they can be
//  overwritten without touching this file. Requires the page to be SERVED — Netlify —
//  not opened as a local file:// (fetch is blocked for local files).)
// ══════════════════════════════════════════════════════════════════════════════
function applyConfig(cfg){
  if (!cfg) return;
  if (cfg.accountCodes)      ACCOUNT_CODES      = cfg.accountCodes;
  if (cfg.taxTypes)          TAX_TYPES          = cfg.taxTypes;
  if (cfg.clearinghouseName) CLEARINGHOUSE_NAME = cfg.clearinghouseName;
  if (cfg.superAccount)      SUPER_ACCOUNT      = cfg.superAccount;
  if (cfg.superFormUrl)      SUPER_FORM_URL     = cfg.superFormUrl;
  if (Array.isArray(cfg.variableLineupPerformers)) VARIABLE_LINEUP_PERFORMERS = cfg.variableLineupPerformers.map(s => String(s).toLowerCase().trim());
  if (Array.isArray(cfg.multiPerformerOfferings))  MULTI_OFFERINGS            = cfg.multiPerformerOfferings.map(s => String(s).toLowerCase().trim());
  if (Array.isArray(cfg.ambiguousOfferings))       AMBIGUOUS_OFFERINGS        = cfg.ambiguousOfferings.map(s => String(s).toLowerCase().trim());
  if (Array.isArray(cfg.knownSuppliers)) KNOWN_SUPPLIERS = cfg.knownSuppliers.map(s => ({
    label: s.label || s.name || 'Supplier',
    keywords: (s.keywords || s.match || []).map(k => String(k).toLowerCase().trim()).filter(Boolean),
    abn: String(s.abn || '').replace(/\D/g, '')
  }));
}

// ── Super-details completeness (shared by the Stage-2 gate, exports and the Talent List) ──
// Returns the list of SAFF-mandatory member fields a contractor is still missing. Address Line 1
// is intentionally NOT required (AustralianSuper accepts it blank); suburb/state/postcode ARE.
function missingSuperFields(c) {
  if (!c) return ['record'];
  const miss = [];
  if (!c.dob)          miss.push('date of birth');
  if (!c.gender)       miss.push('gender');
  if (!c.fundUSI)      miss.push('fund USI');
  if (!c.memberNumber) miss.push('member number');
  if (!c.suburb)       miss.push('suburb');
  if (!c.state)        miss.push('state');
  if (!c.postcode)     miss.push('postcode');
  return miss;
}

// Maps contractor record fields → Zoho form URL parameter names.
// IMPORTANT: these names must match the exact field labels in the Zoho form. Zoho's URL
// prefill uses the field's display label (e.g. "ABN" stays "ABN", "Full Name" → "Name"
// depending on field type). If a prefilled value doesn't appear on the form, inspect the
// form HTML and adjust the right-hand side to match the actual input name= attribute.
// (You can right-click any form field → Inspect → look at name="..." to get the exact key.)
const ZOHO_FORM_FIELD_MAP = {
  name:          'Name',                  // Full name field
  email:         'Email',                  // Email address
  phone:         'PhoneNumber',            // Phone (often "PhoneNumber" or "MobileNumber")
  abn:           'ABN',                    // ABN
  bsb:           'BSB',                    // BSB
  accountNumber: 'AccountNumber',          // Bank account number
  fundName:      'SuperFundName',          // Super fund name
  fundABN:       'SuperFundABN',           // Super fund ABN
  fundUSI:       'SuperFundUSI',           // Super fund USI / SPIN
  memberNumber:  'MemberNumber',           // Super member number
  tfn:           'TFN',                    // Tax file number
  address:       'ResidentialAddress',     // Residential address
  dob:           'DateOfBirth',            // Date of birth
};

// Build a Zoho form URL with as much pre-fill data as we have. Each contractor field is
// passed as a URL param using ZOHO_FORM_FIELD_MAP. Works without Zoho's session token —
// when the link is pasted into any browser, Zoho populates the matching fields.
function superFormLink(c) {
  if (!c) return SUPER_FORM_URL;
  const params = new URLSearchParams();
  // Optional fallback — still passes the CRM entity id, in case Zoho is configured to
  // also use it for the submission-side link-back.
  const id = c.zohoId || c.id;
  if (id) params.set('crm_entity_id', id);
  // Pre-fill values
  const setIf = (key, val) => { if (val != null && String(val).trim() !== '') params.set(key, String(val).trim()); };
  setIf(ZOHO_FORM_FIELD_MAP.name,          c.name);
  setIf(ZOHO_FORM_FIELD_MAP.email,         c.email);
  setIf(ZOHO_FORM_FIELD_MAP.phone,         c.phone || c.mobile);
  setIf(ZOHO_FORM_FIELD_MAP.abn,           c.abn);
  setIf(ZOHO_FORM_FIELD_MAP.bsb,           c.bsb);
  setIf(ZOHO_FORM_FIELD_MAP.accountNumber, c.accountNumber || c.accountNo);
  setIf(ZOHO_FORM_FIELD_MAP.fundName,      c.fundName);
  setIf(ZOHO_FORM_FIELD_MAP.fundABN,       c.fundABN);
  setIf(ZOHO_FORM_FIELD_MAP.fundUSI,       c.fundUSI);
  setIf(ZOHO_FORM_FIELD_MAP.memberNumber,  c.memberNumber);
  setIf(ZOHO_FORM_FIELD_MAP.tfn,           c.tfn);
  setIf(ZOHO_FORM_FIELD_MAP.address,       c.address || c.residentialAddress);
  setIf(ZOHO_FORM_FIELD_MAP.dob,           c.dob);
  return SUPER_FORM_URL + '?' + params.toString();
}

// Resolve a contractor object by zohoId or name — needed because the "Copy form link" /
// "Email form" buttons only have those two pieces of info, not the full record.
function findContractorRecord_(zohoId, name) {
  if (typeof contractors === 'undefined' || !Array.isArray(contractors)) return null;
  let c = null;
  if (zohoId) c = contractors.find(x => x && (x.zohoId === zohoId || x.id === zohoId));
  if (!c && name) c = contractors.find(x => x && (x.name||'').toLowerCase() === name.toLowerCase());
  return c || { zohoId: zohoId, name: name };  // minimal fallback
}

// Copy a contractor's pre-filled form link to the clipboard.
function copySuperFormLink(zohoId, name) {
  const c = findContractorRecord_(zohoId, name);
  const link = superFormLink(c);
  navigator.clipboard?.writeText(link).then(
    () => alert('✓ Copied super-details form link for ' + (name || 'contractor') + '.\n\nSend it to them so they can complete their details. Fields we know already are pre-filled.'),
    () => prompt('Copy this super-details form link:', link)
  );
}

// Open a pre-addressed chase email to a contractor missing super details.
function emailSuperForm(email, zohoId, name) {
  const c = findContractorRecord_(zohoId, name);
  const link = superFormLink(c);
  const subj = 'Action needed: your super details for MEC payments';
  const body = `Hi ${name || ''},\n\n`
    + `Before we can pay you, we need your superannuation details on file. Could you take 2 minutes `
    + `to complete this short, pre-filled form? Without it we can't process your super.\n\n${link}\n\nThanks,\nThe MEC Team`;
  const to = email || '';
  window.open(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`, '_blank');
}

async function bootstrap(){
  try {
    const [cfg, contr, book] = await Promise.all([
      fetch('config.json').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('contractors.json').then(r => r.json()),
      fetch('bookings.json').then(r => r.json()),
    ]);
    applyConfig(cfg);
    EMBEDDED_CONTRACTORS      = contr.contractors || contr;
    EMBEDDED_CONTRACTORS_META = contr.meta || {generated:'', recordCount:(contr.contractors||contr).length};
    EMBEDDED_BOOKINGS         = book.bookings || book;
    EMBEDDED_BOOKINGS_META    = book.meta || {generated:'', recordCount:(book.bookings||book).length};
  } catch(e){
    console.error('Data load failed', e);
    alert('Could not load the data files (contractors.json / bookings.json).\n\nThis tool must be opened via its web address (Netlify), not as a local file. ('+e.message+')');
  }
  try { initEmbeddedData(); } catch(e){ console.error('initEmbeddedData failed', e); }
  gotoStep('refresh');   // land on Step 1 — Refresh from Zoho
  addManualRow();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
else bootstrap();

