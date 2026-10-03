// App bootstrap, navigation and hash router.
import { h, fill, api, get, state, toast } from './util.js';
import {
  renderDashboard, renderList, renderRecord, renderReports, renderReport, renderSettings, renderAccount, renderPrint, notFound, setTheme,
} from './views.js';

const $ = (id) => document.getElementById(id);
const GROUP_ORDER = ['Operations', 'Workforce', 'Procurement', 'Finance', 'Administration'];

try { setTheme(localStorage.getItem('erp-theme') || 'system'); } catch { /* storage unavailable */ }

function showLogin() {
  state.user = null;
  $('shell').hidden = true;
  $('print-root').hidden = true;
  $('login').hidden = false;
  $('login-form').username.focus();
}

async function loadMeta() {
  const meta = await get('/meta');
  state.meta = meta;
  state.settings = meta.settings;
  state.reports = meta.reports;
}

function buildNav() {
  const nav = $('nav');
  const link = (href, icon, label) => h('a', { class: 'nav-link', href }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon), label);
  const groups = {};
  for (const r of Object.values(state.meta.resources)) (groups[r.group] ||= []).push(r);
  fill(nav, 
    link('#/dashboard', '📈', 'Dashboard'),
    GROUP_ORDER.filter((g) => groups[g]).map((g) => [
      h('div', { class: 'nav-group' }, g),
      groups[g].map((r) => link(`#/r/${r.key}`, r.icon, r.label)),
      g === 'Finance' ? link('#/reports', '📊', 'Reports') : null,
      g === 'Administration' ? link('#/settings', '⚙️', 'Company Settings') : null,
    ]),
    !groups.Administration ? [h('div', { class: 'nav-group' }, 'Administration'), link('#/settings', '⚙️', 'Company Settings')] : null,
    !groups.Finance ? link('#/reports', '📊', 'Reports') : null);
  $('company-name').textContent = state.settings.company_name || '';
  fill($('user-chip'), state.user.full_name, h('small', {}, state.user.role.replace('_', ' ')));
}

function highlightNav(hash) {
  for (const a of $('nav').querySelectorAll('a')) {
    const href = a.getAttribute('href');
    a.classList.toggle('active', hash === href || hash.startsWith(`${href}/`) || hash.startsWith(`${href}?`));
  }
}

async function startApp(user) {
  state.user = user;
  await loadMeta();
  $('login').hidden = true;
  $('shell').hidden = false;
  buildNav();
  route();
}

let routeSeq = 0;
async function route() {
  if (!state.user) return;
  const seq = ++routeSeq;
  const hash = location.hash || '#/dashboard';
  const [pathPart, queryPart = ''] = hash.slice(1).split('?');
  const segs = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const params = Object.fromEntries(new URLSearchParams(queryPart));
  const view = $('view');
  $('sidebar').classList.remove('open');

  const isPrint = segs[0] === 'print';
  $('shell').hidden = isPrint;
  $('print-root').hidden = !isPrint;
  highlightNav(hash);

  try {
    if (isPrint && segs[1] && segs[2] && state.meta.resources[segs[1]]?.printable) return await renderPrint($('print-root'), segs[1], segs[2]);
    if (!segs.length || segs[0] === 'dashboard') await renderDashboard(view);
    else if (segs[0] === 'r' && segs[1] && !segs[2]) await renderList(view, segs[1], params);
    else if (segs[0] === 'r' && segs[1] && /^\d+$/.test(segs[2] || '')) await renderRecord(view, segs[1], segs[2]);
    else if (segs[0] === 'reports' && !segs[1]) renderReports(view);
    else if (segs[0] === 'reports') await renderReport(view, segs[1], params);
    else if (segs[0] === 'settings') renderSettings(view, buildNav);
    else if (segs[0] === 'account') renderAccount(view);
    else notFound(view);
  } catch (err) {
    if (seq !== routeSeq || err.status === 401) return;
    fill(view, h('div', { class: 'card card-pad' }, h('h2', {}, 'Something went wrong'), h('p', {}, err.message),
      h('a', { href: '#/dashboard' }, 'Back to dashboard')));
  }
  if (seq === routeSeq && !isPrint && !('q' in params)) { window.scrollTo(0, 0); }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('login-error').textContent = '';
  try {
    const { user } = await api('POST', '/login', { username: f.username.value, password: f.password.value });
    f.password.value = '';
    await startApp(user);
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/logout', {}); } catch { /* ignore */ }
  showLogin();
});
$('menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
window.addEventListener('hashchange', route);
window.addEventListener('erp:unauthorized', () => { if (state.user) { toast('Your session has expired. Please sign in again.', true); showLogin(); } });

(async () => {
  try {
    const { user } = await get('/me');
    await startApp(user);
  } catch {
    showLogin();
  }
})();
