'use strict';

const LEGACY_STORAGE_KEY = 'meu-financeiro-data-v1';
const APP_VERSION = 3;
const RELEASE_VERSION = '1.2.1';
const REMOTE_TABLE = 'user_app_state';
const APP_URL = 'https://gabrielcoutoabreu.github.io/Meu-Financeiro/';
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const MONTH_ABBR = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

const NAV_ITEMS = [
  ['dashboard', '⌂', 'Visão geral'],
  ['transactions', '⇄', 'Movimentações'],
  ['patrimony', '▣', 'Contas e cartões'],
  ['planning', '◎', 'Planejamento'],
  ['reports', '▥', 'Relatórios'],
  ['settings', '⚙', 'Configurações']
];

const PAGE_META = {
  dashboard: ['Visão geral', 'Seu mês financeiro em uma única tela.'],
  transactions: ['Movimentações', 'Ganhos, gastos, transferências e compras no cartão.'],
  patrimony: ['Contas e cartões', 'Saldos, faturas e limite disponível.'],
  planning: ['Planejamento', 'Orçamentos mensais e objetivos financeiros.'],
  reports: ['Relatórios', 'Análises por categoria, evolução e exportação.'],
  settings: ['Configurações', 'Preferências, segurança e cópias dos dados.']
};

let state = defaultState();
let authSession = null;
let authReady = false;
let supabaseClient = null;
let syncTimer = null;
let syncPollTimer = null;
let syncMeta = { status: 'local', pending: false, lastSyncedAt: '', lastRemoteUpdatedAt: '', remoteVersion: 0, message: '' };
let ui = {
  page: 'dashboard',
  month: monthKey(new Date()),
  planningTab: 'budgets',
  transactionSearch: '',
  transactionType: 'all',
  transactionStatus: 'all',
  deferredInstallPrompt: null,
  authMode: 'signin',
  authMessage: ''
};

function uid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isoDate(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

function monthKey(dateOrString) {
  const d = typeof dateOrString === 'string' ? parseDate(dateOrString) : dateOrString;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthDate(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1, 12);
}

function formatMonthShort(keyOrDate) {
  const d = typeof keyOrDate === 'string' ? monthDate(keyOrDate) : keyOrDate;
  return `${MONTH_ABBR[d.getMonth()]}/${String(d.getFullYear()).slice(-2)}`;
}

function shiftMonth(key, amount) {
  const d = monthDate(key);
  d.setMonth(d.getMonth() + amount);
  return monthKey(d);
}

function shiftDateMonths(value, amount) {
  const d = parseDate(value);
  if (!d) return value;
  const originalDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + amount);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(originalDay, lastDay));
  return isoDate(d);
}

function shiftDateDays(value, amount) {
  const d = parseDate(value);
  if (!d) return value;
  d.setDate(d.getDate() + amount);
  return isoDate(d);
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function num(value) {
  const normalized = String(value ?? '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function defaultState() {
  return {
    version: APP_VERSION,
    preferences: {
      darkMode: false,
      basis: 'cash',
      showInstallHelp: true,
      name: 'Meu Financeiro'
    },
    accounts: [],
    cards: [],
    transactions: [],
    budgets: [],
    goals: [],
    categories: [
      'Alimentação', 'Moradia', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Serviços', 'Dívidas', 'Taxas', 'Vestuário', 'Viagem', 'Salário', 'Receitas variáveis', 'Investimentos', 'Presentes', 'Cashback', 'Outros'
    ],
    members: ['Pessoal', 'Família', 'Casa']
  };
}

function normalizeState(data) {
  const base = defaultState();
  return {
    version: APP_VERSION,
    preferences: { ...base.preferences, ...(data.preferences || {}) },
    accounts: Array.isArray(data.accounts) ? data.accounts : base.accounts,
    cards: Array.isArray(data.cards) ? data.cards : base.cards,
    transactions: Array.isArray(data.transactions) ? data.transactions : base.transactions,
    budgets: Array.isArray(data.budgets) ? data.budgets : base.budgets,
    goals: Array.isArray(data.goals) ? data.goals : base.goals,
    categories: Array.isArray(data.categories) ? data.categories : base.categories,
    members: Array.isArray(data.members) ? data.members : base.members
  };
}

function userStorageKey(userId) {
  return `meu-financeiro-data-v2-${userId}`;
}

function syncStorageKey(userId) {
  return `meu-financeiro-sync-v2-${userId}`;
}

function hasMeaningfulData(candidate) {
  if (!candidate) return false;
  return ['accounts', 'cards', 'transactions', 'budgets', 'goals'].some(key => Array.isArray(candidate[key]) && candidate[key].length > 0);
}

function readStoredState(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? normalizeState(JSON.parse(raw)) : null;
  } catch (error) {
    console.error('Falha ao carregar os dados locais:', error);
    return null;
  }
}

function loadStateForUser(userId) {
  const userState = readStoredState(userStorageKey(userId));
  if (userState) return userState;
  const legacy = readStoredState(LEGACY_STORAGE_KEY);
  return legacy || defaultState();
}

function loadSyncMeta(userId) {
  try {
    const raw = localStorage.getItem(syncStorageKey(userId));
    const base = { status: navigator.onLine ? 'syncing' : 'offline', pending: false, lastSyncedAt: '', lastRemoteUpdatedAt: '', remoteVersion: 0, message: '' };
    return raw ? { ...base, ...JSON.parse(raw) } : base;
  } catch {
    return { status: navigator.onLine ? 'syncing' : 'offline', pending: false, lastSyncedAt: '', lastRemoteUpdatedAt: '', remoteVersion: 0, message: '' };
  }
}

function saveSyncMeta() {
  if (!authSession?.user?.id) return;
  localStorage.setItem(syncStorageKey(authSession.user.id), JSON.stringify(syncMeta));
}

function persist(options = {}) {
  if (authSession?.user?.id) {
    localStorage.setItem(userStorageKey(authSession.user.id), JSON.stringify(state));
    if (options.sync !== false) {
      syncMeta.pending = true;
      syncMeta.status = navigator.onLine ? 'pending' : 'offline';
      syncMeta.message = navigator.onLine ? 'Alterações aguardando sincronização.' : 'Sem internet. Alterações salvas neste dispositivo.';
      saveSyncMeta();
      scheduleCloudSync();
    }
  } else {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(state));
  }
  applyTheme();
  updateSyncIndicator();
}

function deviceName() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isWindows = /windows/i.test(navigator.userAgent);
  if (isIOS) return 'iPhone/iPad';
  if (isWindows) return 'Windows';
  return navigator.platform || 'Navegador';
}

function syncStatusInfo() {
  if (!authSession) return { icon: '☁', label: 'Desconectado', tone: 'ignored' };
  if (!navigator.onLine || syncMeta.status === 'offline') return { icon: '◌', label: 'Offline', tone: 'pending' };
  if (syncMeta.status === 'conflict') return { icon: '!', label: 'Conflito', tone: 'ignored' };
  if (syncMeta.status === 'error') return { icon: '!', label: 'Erro', tone: 'ignored' };
  if (syncMeta.status === 'syncing' || syncMeta.status === 'pending') return { icon: '↻', label: 'Sincronizando', tone: 'pending' };
  return { icon: '✓', label: 'Sincronizado', tone: 'confirmed' };
}

function updateSyncIndicator() {
  const info = syncStatusInfo();
  document.querySelectorAll('[data-sync-indicator]').forEach(el => {
    el.textContent = info.icon;
    el.title = info.label;
    el.setAttribute('aria-label', info.label);
  });
  const label = document.querySelector('[data-sync-label]');
  if (label) {
    label.textContent = info.label;
    label.className = `chip ${info.tone}`;
  }
}

function scheduleCloudSync(delay = 650) {
  clearTimeout(syncTimer);
  if (!authSession || !navigator.onLine) return;
  syncTimer = setTimeout(() => pushStateToCloud(), delay);
}

async function fetchRemoteState() {
  if (!authSession?.user?.id || !supabaseClient) return { row: null, error: null };
  const { data, error } = await supabaseClient
    .from(REMOTE_TABLE)
    .select('user_id,data,version,updated_at,device_name')
    .eq('user_id', authSession.user.id)
    .maybeSingle();
  return { row: data, error };
}

async function pushStateToCloud({ force = false } = {}) {
  if (!authSession?.user?.id || !supabaseClient) return;
  if (!navigator.onLine) {
    syncMeta.status = 'offline';
    syncMeta.pending = true;
    saveSyncMeta();
    updateSyncIndicator();
    return;
  }

  syncMeta.status = 'syncing';
  syncMeta.message = 'Enviando alterações para a nuvem...';
  saveSyncMeta();
  updateSyncIndicator();

  try {
    const { row: remote, error: readError } = await fetchRemoteState();
    if (readError) throw readError;

    if (!force && remote?.updated_at && syncMeta.lastRemoteUpdatedAt && remote.updated_at !== syncMeta.lastRemoteUpdatedAt) {
      syncMeta.status = 'conflict';
      syncMeta.pending = true;
      syncMeta.message = 'Há alterações mais recentes em outro dispositivo. Escolha qual versão manter em Configurações.';
      saveSyncMeta();
      render();
      return;
    }

    const nextVersion = Math.max(Number(remote?.version || 0), Number(syncMeta.remoteVersion || 0)) + 1;
    const updatedAt = new Date().toISOString();
    const { data, error } = await supabaseClient
      .from(REMOTE_TABLE)
      .upsert({
        user_id: authSession.user.id,
        data: state,
        version: nextVersion,
        updated_at: updatedAt,
        device_name: deviceName()
      }, { onConflict: 'user_id' })
      .select('version,updated_at')
      .single();
    if (error) throw error;

    syncMeta.status = 'synced';
    syncMeta.pending = false;
    syncMeta.lastSyncedAt = new Date().toISOString();
    syncMeta.lastRemoteUpdatedAt = data.updated_at;
    syncMeta.remoteVersion = Number(data.version || nextVersion);
    syncMeta.message = 'Todos os dados estão sincronizados.';
    saveSyncMeta();
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    updateSyncIndicator();
  } catch (error) {
    console.error('Falha na sincronização:', error);
    syncMeta.status = navigator.onLine ? 'error' : 'offline';
    syncMeta.pending = true;
    syncMeta.message = error?.message || 'Não foi possível sincronizar agora.';
    saveSyncMeta();
    updateSyncIndicator();
  }
}

async function pullStateFromCloud({ force = false, quiet = false } = {}) {
  if (!authSession?.user?.id || !supabaseClient || !navigator.onLine) return false;
  if (syncMeta.pending && !force) return false;

  if (!quiet) {
    syncMeta.status = 'syncing';
    syncMeta.message = 'Verificando dados na nuvem...';
    updateSyncIndicator();
  }

  try {
    const { row, error } = await fetchRemoteState();
    if (error) throw error;
    if (!row) {
      await pushStateToCloud({ force: true });
      return true;
    }

    const changed = !syncMeta.lastRemoteUpdatedAt || row.updated_at !== syncMeta.lastRemoteUpdatedAt;
    if (changed || force) {
      state = normalizeState(row.data || {});
      localStorage.setItem(userStorageKey(authSession.user.id), JSON.stringify(state));
      syncMeta.lastRemoteUpdatedAt = row.updated_at || '';
      syncMeta.remoteVersion = Number(row.version || 0);
    }
    syncMeta.status = 'synced';
    syncMeta.pending = false;
    syncMeta.lastSyncedAt = new Date().toISOString();
    syncMeta.message = changed ? 'Dados atualizados a partir da nuvem.' : 'Todos os dados estão sincronizados.';
    saveSyncMeta();
    if (changed) render(); else updateSyncIndicator();
    return changed;
  } catch (error) {
    console.error('Falha ao baixar dados da nuvem:', error);
    syncMeta.status = 'error';
    syncMeta.message = error?.message || 'Não foi possível consultar a nuvem.';
    saveSyncMeta();
    updateSyncIndicator();
    return false;
  }
}

async function initialCloudSync() {
  if (!authSession?.user?.id) return;
  if (!navigator.onLine) {
    syncMeta.status = 'offline';
    syncMeta.message = 'Offline. Usando os dados salvos neste dispositivo.';
    saveSyncMeta();
    render();
    return;
  }

  syncMeta.status = 'syncing';
  render();
  try {
    const { row, error } = await fetchRemoteState();
    if (error) throw error;

    if (row) {
      if (syncMeta.pending && syncMeta.lastRemoteUpdatedAt && row.updated_at !== syncMeta.lastRemoteUpdatedAt) {
        syncMeta.status = 'conflict';
        syncMeta.message = 'Este dispositivo e a nuvem têm alterações diferentes.';
      } else if (syncMeta.pending) {
        await pushStateToCloud();
        return;
      } else {
        state = normalizeState(row.data || {});
        localStorage.setItem(userStorageKey(authSession.user.id), JSON.stringify(state));
        syncMeta.status = 'synced';
        syncMeta.pending = false;
        syncMeta.lastRemoteUpdatedAt = row.updated_at || '';
        syncMeta.remoteVersion = Number(row.version || 0);
        syncMeta.lastSyncedAt = new Date().toISOString();
        syncMeta.message = 'Dados carregados da nuvem.';
      }
    } else {
      await pushStateToCloud({ force: true });
      return;
    }
    saveSyncMeta();
    render();
  } catch (error) {
    console.error('Falha ao iniciar sincronização:', error);
    syncMeta.status = 'error';
    syncMeta.pending = true;
    syncMeta.message = error?.message || 'Não foi possível acessar a nuvem.';
    saveSyncMeta();
    render();
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.preferences.darkMode ? 'dark' : 'light';
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = state.preferences.darkMode ? '#172221' : '#0f766e';
}

function transactionViewDate(tx) {
  if (state.preferences.basis === 'cash') return tx.paidDate || tx.dueDate || tx.date;
  return tx.date;
}

function isInMonth(dateValue, key = ui.month) {
  return dateValue && monthKey(dateValue) === key;
}

function validForCalculations(tx) {
  return tx.status !== 'ignored';
}

function accountBalance(accountId) {
  const account = state.accounts.find(item => item.id === accountId);
  let balance = num(account?.initialBalance);
  state.transactions.filter(validForCalculations).filter(tx => tx.status === 'confirmed').forEach(tx => {
    if (tx.type === 'income' && tx.accountId === accountId) balance += num(tx.amount);
    if (tx.type === 'expense' && tx.accountId === accountId) balance -= num(tx.amount);
    if (tx.type === 'transfer') {
      if (tx.accountId === accountId) balance -= num(tx.amount);
      if (tx.destinationAccountId === accountId) balance += num(tx.amount);
    }
  });
  return balance;
}

function monthTransactions(key = ui.month, includePending = true) {
  return state.transactions.filter(tx => {
    if (!validForCalculations(tx)) return false;
    if (!includePending && tx.status !== 'confirmed') return false;
    return isInMonth(transactionViewDate(tx), key);
  });
}

function monthTotals(key = ui.month) {
  const confirmed = monthTransactions(key, false);
  const income = confirmed.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + num(tx.amount), 0);
  const expense = confirmed.filter(tx => tx.type === 'expense' || tx.type === 'card').reduce((sum, tx) => sum + num(tx.amount), 0);
  return { income, expense, result: income - expense };
}

function categoryTotals(key = ui.month) {
  const map = new Map();
  monthTransactions(key, false)
    .filter(tx => tx.type === 'expense' || tx.type === 'card')
    .forEach(tx => map.set(tx.category || 'Sem categoria', (map.get(tx.category || 'Sem categoria') || 0) + num(tx.amount)));
  return [...map.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

function budgetSpent(budget) {
  return monthTransactions(budget.month, false)
    .filter(tx => (tx.type === 'expense' || tx.type === 'card') && tx.category === budget.category)
    .reduce((sum, tx) => sum + num(tx.amount), 0);
}

function cardInvoice(cardId, key = ui.month) {
  return state.transactions
    .filter(tx => validForCalculations(tx) && tx.type === 'card' && tx.cardId === cardId && isInMonth(tx.date, key))
    .reduce((sum, tx) => sum + num(tx.amount), 0);
}

function totalNetWorth() {
  const accounts = state.accounts.reduce((sum, account) => sum + accountBalance(account.id), 0);
  const cards = state.cards.reduce((sum, card) => sum + cardInvoice(card.id), 0);
  return accounts - cards;
}

function nameById(collection, id, fallback = '—') {
  return collection.find(item => item.id === id)?.name || fallback;
}

function typeLabel(type) {
  return { income: 'Ganho', expense: 'Gasto', transfer: 'Transferência', card: 'Cartão' }[type] || type;
}

function typeIcon(type) {
  return { income: '↓', expense: '↑', transfer: '⇄', card: '▰' }[type] || '•';
}

function pageShell(content, extraAction = '') {
  const [title, subtitle] = PAGE_META[ui.page];
  const monthControl = ui.page === 'settings' ? '' : `
    <div class="month-control" aria-label="Mês selecionado">
      <button class="icon-button" data-action="prev-month" aria-label="Mês anterior">‹</button>
      <div class="month-label">${esc(formatMonthShort(ui.month))}</div>
      <button class="icon-button" data-action="next-month" aria-label="Próximo mês">›</button>
    </div>`;

  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">R$</div>
        <div><div class="brand-title">${esc(state.preferences.name || 'Meu Financeiro')}</div><div class="brand-subtitle">Controle pessoal</div></div>
      </div>
      <nav class="nav">
        ${NAV_ITEMS.map(([page, icon, label]) => `<button class="nav-button ${ui.page === page ? 'active' : ''}" data-page="${page}"><span class="nav-icon">${icon}</span>${label}</button>`).join('')}
      </nav>
      <div class="sidebar-footer"><strong>☁ Sincronização segura.</strong><br>${esc(authSession?.user?.email || '')}</div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div><h1 class="page-title">${title}</h1><p class="page-subtitle">${subtitle}</p></div>
        <div class="top-actions">${monthControl}${extraAction}<button class="icon-button" data-action="sync-now" data-sync-indicator aria-label="Sincronizar">${syncStatusInfo().icon}</button><button class="icon-button" data-page="settings" aria-label="Configurações">⚙</button></div>
      </header>
      ${installHelp()}
      ${content}
    </main>
    ${bottomNav()}
  `;
}

function bottomNav() {
  const items = NAV_ITEMS.filter(([page]) => ['dashboard', 'transactions', 'patrimony', 'planning', 'reports'].includes(page));
  return `<nav class="bottom-nav">${items.map(([page, icon, label]) => `<button class="${ui.page === page ? 'active' : ''}" data-page="${page}"><span class="nav-icon">${icon}</span><span>${label.split(' ')[0]}</span></button>`).join('')}</nav>`;
}

function installHelp() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone || !state.preferences.showInstallHelp) return '';
  return `<div class="install-banner"><p><strong>Instalável:</strong> use “Adicionar à Tela de Início” no Safari do iPhone ou “Instalar este site como aplicativo” no Edge.</p><div class="row-actions"><button class="button small primary" data-action="install-app">Instalar</button><button class="icon-button" data-action="dismiss-install" aria-label="Fechar">×</button></div></div>`;
}

function render() {
  applyTheme();
  const app = document.getElementById('app');
  if (!authReady) {
    app.innerHTML = `<main class="auth-shell"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">R$</div><div><h1>Meu Financeiro</h1><p>Preparando seu acesso seguro...</p></div></div><div class="auth-loading">Sincronizando configuração</div></section></main>`;
    return;
  }
  if (!authSession) {
    app.innerHTML = renderAuth();
    return;
  }
  let content = '';
  if (ui.page === 'dashboard') content = renderDashboard();
  if (ui.page === 'transactions') content = renderTransactions();
  if (ui.page === 'patrimony') content = renderPatrimony();
  if (ui.page === 'planning') content = renderPlanning();
  if (ui.page === 'reports') content = renderReports();
  if (ui.page === 'settings') content = renderSettings();
  app.innerHTML = content;
  updateSyncIndicator();
}

function renderAuth() {
  const mode = ui.authMode;
  const message = ui.authMessage ? `<div class="auth-message">${esc(ui.authMessage)}</div>` : '';
  if (mode === 'forgot') {
    return `<main class="auth-shell"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">R$</div><div><h1>Recuperar senha</h1><p>Enviaremos um link para o seu e-mail.</p></div></div>${message}<form id="forgot-form" class="auth-form"><div class="field"><label>E-mail</label><input class="input" name="email" type="email" autocomplete="email" required></div><button class="button primary auth-submit" type="submit">Enviar link de recuperação</button></form><button class="auth-link" type="button" data-action="auth-mode" data-mode="signin">Voltar para entrar</button></section></main>`;
  }
  if (mode === 'signup') {
    return `<main class="auth-shell"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">R$</div><div><h1>Criar conta</h1><p>Use o mesmo login em todos os seus dispositivos.</p></div></div>${message}<form id="signup-form" class="auth-form"><div class="field"><label>E-mail</label><input class="input" name="email" type="email" autocomplete="email" required></div><div class="field"><label>Senha</label><input class="input" name="password" type="password" autocomplete="new-password" minlength="8" required></div><div class="field"><label>Confirmar senha</label><input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required></div><button class="button primary auth-submit" type="submit">Criar conta</button></form><button class="auth-link" type="button" data-action="auth-mode" data-mode="signin">Já tenho uma conta</button></section></main>`;
  }
  if (mode === 'recovery') {
    return `<main class="auth-shell"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">R$</div><div><h1>Nova senha</h1><p>Defina a nova senha da sua conta.</p></div></div>${message}<form id="recovery-form" class="auth-form"><div class="field"><label>Nova senha</label><input class="input" name="password" type="password" autocomplete="new-password" minlength="8" required></div><div class="field"><label>Confirmar senha</label><input class="input" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required></div><button class="button primary auth-submit" type="submit">Atualizar senha</button></form></section></main>`;
  }
  return `<main class="auth-shell"><section class="auth-card"><div class="auth-brand"><div class="brand-mark">R$</div><div><h1>Meu Financeiro</h1><p>Seus dados financeiros sincronizados entre dispositivos.</p></div></div>${message}<form id="signin-form" class="auth-form"><div class="field"><label>E-mail</label><input class="input" name="email" type="email" autocomplete="email" required></div><div class="field"><label>Senha</label><input class="input" name="password" type="password" autocomplete="current-password" required></div><button class="button primary auth-submit" type="submit">Entrar</button></form><div class="auth-actions"><button class="auth-link" type="button" data-action="auth-mode" data-mode="forgot">Esqueci minha senha</button><button class="auth-link" type="button" data-action="auth-mode" data-mode="signup">Criar conta</button></div><div class="auth-security">☁ Dados na nuvem + cópia local para uso offline.</div></section></main>`;
}

function renderDashboard() {
  const totals = monthTotals();
  const previous = monthTotals(shiftMonth(ui.month, -1));
  const categories = categoryTotals().slice(0, 6);
  const maxCategory = Math.max(1, ...categories.map(item => item.total));
  const budgets = state.budgets.filter(item => item.month === ui.month).slice(0, 4);
  const recent = monthTransactions().sort((a, b) => (transactionViewDate(b) || '').localeCompare(transactionViewDate(a) || '')).slice(0, 6);
  const pending = monthTransactions().filter(tx => tx.status === 'pending').reduce((sum, tx) => sum + num(tx.amount), 0);
  const resultChange = previous.result ? ((totals.result - previous.result) / Math.abs(previous.result)) * 100 : 0;
  const gettingStarted = state.accounts.length === 0 && state.transactions.length === 0 ? `
    <article class="card getting-started" style="margin-bottom:16px">
      <div class="card-header"><div><h2 class="card-title">Comece por aqui</h2><p class="card-note">Este aplicativo trabalha com lançamentos manuais. Cadastre primeiro suas contas e, se desejar, seus cartões.</p></div></div>
      <div class="toolbar"><button class="button primary" data-action="add-account">+ Cadastrar conta</button><button class="button" data-action="add-card">+ Cadastrar cartão</button></div>
    </article>` : '';

  const content = `
    ${gettingStarted}
    <section class="grid kpis">
      ${kpi('Patrimônio líquido', money.format(totalNetWorth()), `${state.accounts.length} contas e ${state.cards.length} cartões`, totalNetWorth() >= 0 ? 'positive' : 'negative')}
      ${kpi('Ganhos confirmados', money.format(totals.income), 'No período selecionado', 'positive')}
      ${kpi('Gastos confirmados', money.format(totals.expense), `${state.preferences.basis === 'cash' ? 'Visão por caixa' : 'Visão por competência'}`, 'negative')}
      ${kpi('Resultado do mês', money.format(totals.result), `${resultChange >= 0 ? '+' : ''}${resultChange.toFixed(0)}% versus mês anterior`, totals.result >= 0 ? 'positive' : 'negative')}
    </section>

    <section class="grid two" style="margin-top:16px">
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Gastos por categoria</h2><p class="card-note">Somente transações confirmadas</p></div><button class="button small" data-page="reports">Detalhar</button></div>
        ${categories.length ? `<div class="chart">${categories.map(item => `<div class="chart-row"><div class="chart-label">${esc(item.category)}</div><div class="chart-track"><div class="chart-bar" style="width:${(item.total / maxCategory) * 100}%"></div></div><div class="chart-value">${money.format(item.total)}</div></div>`).join('')}</div>` : empty('Ainda não há gastos confirmados neste mês.')}
      </article>

      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Orçamentos do mês</h2><p class="card-note">Acompanhamento por categoria</p></div><button class="button small" data-page="planning">Gerenciar</button></div>
        ${budgets.length ? `<div class="stack">${budgets.map(renderBudgetProgress).join('')}</div>` : empty('Crie limites para acompanhar seus gastos.')}
      </article>
    </section>

    <section class="grid two" style="margin-top:16px">
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Movimentações recentes</h2><p class="card-note">Ordenadas pela data usada na visualização</p></div><button class="button small primary" data-action="add-transaction">+ Lançar</button></div>
        ${recent.length ? recent.map(renderTransactionRow).join('') : empty('Nenhuma movimentação neste mês.')}
      </article>
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Atenção</h2><p class="card-note">Pendências e limites</p></div></div>
        <div class="stack">
          <div class="list-row"><div><div class="row-title">Transações pendentes</div><div class="row-subtitle">Confirme pagamentos e recebimentos</div></div><div class="row-value warning">${money.format(pending)}</div></div>
          ${budgetAlerts().slice(0, 4).map(alert => `<div class="list-row"><div><div class="row-title">${esc(alert.title)}</div><div class="row-subtitle">${esc(alert.message)}</div></div><span class="chip ${alert.level}">${alert.percent.toFixed(0)}%</span></div>`).join('') || '<div class="list-row"><div><div class="row-title">Tudo sob controle</div><div class="row-subtitle">Nenhum orçamento próximo do limite.</div></div><span class="chip confirmed">OK</span></div>'}
        </div>
      </article>
    </section>`;

  return pageShell(content, `<button class="button primary" data-action="add-transaction"><span class="desktop-label">Nova movimentação</span><span>＋</span></button>`);
}

function kpi(label, value, meta, tone = '') {
  return `<article class="card"><div class="kpi-label">${label}</div><div class="kpi-value ${tone}">${value}</div><div class="kpi-meta">${meta}</div></article>`;
}

function renderBudgetProgress(budget) {
  const spent = budgetSpent(budget);
  const percent = budget.limit ? (spent / budget.limit) * 100 : 0;
  const level = percent >= 100 ? 'danger' : percent >= budget.alertAt ? 'warning' : '';
  return `<div class="progress-row"><div class="progress-meta"><strong>${esc(budget.category)}</strong><span>${money.format(spent)} de ${money.format(budget.limit)}</span></div><div class="progress ${level}"><span style="width:${clamp(percent, 0, 100)}%"></span></div></div>`;
}

function budgetAlerts() {
  return state.budgets.filter(budget => budget.month === ui.month).map(budget => {
    const spent = budgetSpent(budget);
    const percent = budget.limit ? (spent / budget.limit) * 100 : 0;
    return {
      title: budget.category,
      message: percent >= 100 ? `Orçamento excedido em ${money.format(spent - budget.limit)}.` : `Restam ${money.format(Math.max(0, budget.limit - spent))}.`,
      percent,
      level: percent >= 100 ? 'ignored' : percent >= budget.alertAt ? 'pending' : 'confirmed'
    };
  }).filter(item => item.percent >= 80).sort((a, b) => b.percent - a.percent);
}

function renderTransactions() {
  const search = ui.transactionSearch.trim().toLowerCase();
  const rows = state.transactions
    .filter(tx => isInMonth(transactionViewDate(tx)))
    .filter(tx => ui.transactionType === 'all' || tx.type === ui.transactionType)
    .filter(tx => ui.transactionStatus === 'all' || tx.status === ui.transactionStatus)
    .filter(tx => !search || [tx.description, tx.category, tx.subcategory, tx.member, ...(tx.tags || [])].join(' ').toLowerCase().includes(search))
    .sort((a, b) => (transactionViewDate(b) || '').localeCompare(transactionViewDate(a) || ''));

  const content = `
    <article class="card">
      <div class="toolbar">
        <input class="input search" id="transaction-search" placeholder="Buscar descrição, categoria, membro ou tag" value="${esc(ui.transactionSearch)}">
        <select class="select filter-select" id="transaction-type-filter">
          ${selectOptions([['all','Todos os tipos'],['income','Ganhos'],['expense','Gastos'],['card','Cartão'],['transfer','Transferências']], ui.transactionType)}
        </select>
        <select class="select filter-select" id="transaction-status-filter">
          ${selectOptions([['all','Todas as situações'],['confirmed','Confirmadas'],['pending','Pendentes'],['ignored','Ignoradas']], ui.transactionStatus)}
        </select>
        <button class="button primary" data-action="add-transaction">+ Nova</button>
      </div>
      <div>${rows.length ? rows.map(tx => renderTransactionRow(tx, true)).join('') : empty('Nenhuma movimentação encontrada com estes filtros.')}</div>
    </article>`;

  return pageShell(content, `<button class="button primary" data-action="add-transaction">＋ <span class="desktop-label">Nova</span></button>`);
}

function renderTransactionRow(tx, actions = false) {
  const isPositive = tx.type === 'income';
  const isNeutral = tx.type === 'transfer';
  const date = transactionViewDate(tx);
  const source = tx.type === 'card' ? nameById(state.cards, tx.cardId, 'Cartão') : nameById(state.accounts, tx.accountId, 'Sem conta');
  const installment = num(tx.installmentTotal) > 1 ? ` · ${tx.installmentCurrent}/${tx.installmentTotal}` : '';
  const subtitle = `${typeLabel(tx.type)} · ${esc(tx.category || 'Sem categoria')} · ${esc(source)}${installment}`;
  const valueClass = isNeutral ? '' : isPositive ? 'positive' : 'negative';
  const sign = isPositive ? '+' : isNeutral ? '' : '−';
  return `<div class="list-row">
    <div class="row-main"><div class="avatar">${typeIcon(tx.type)}</div><div><div class="row-title">${esc(tx.description)}</div><div class="row-subtitle">${subtitle} · ${date ? shortDate.format(parseDate(date)) : 'Sem data'}</div></div></div>
    <div class="row-actions"><div style="text-align:right"><div class="row-value ${valueClass}">${sign}${money.format(tx.amount)}</div><span class="chip ${tx.status}">${tx.status === 'confirmed' ? 'Confirmada' : tx.status === 'pending' ? 'Pendente' : 'Ignorada'}</span></div>${actions ? `<button class="icon-button" data-action="edit-transaction" data-id="${tx.id}" aria-label="Editar">✎</button><button class="icon-button" data-action="delete-transaction" data-id="${tx.id}" aria-label="Excluir">×</button>` : ''}</div>
  </div>`;
}

function renderPatrimony() {
  const accountCards = state.accounts.map(account => `<article class="card account-card"><div class="card-header"><div><h2 class="card-title">${esc(account.name)}</h2><p class="card-note">${esc(account.type)}${account.institution ? ` · ${esc(account.institution)}` : ''}</p></div><div class="row-actions"><button class="icon-button" data-action="edit-account" data-id="${account.id}" aria-label="Editar">✎</button><button class="icon-button" data-action="delete-account" data-id="${account.id}" aria-label="Excluir">×</button></div></div><div class="account-balance ${accountBalance(account.id) >= 0 ? 'positive' : 'negative'}">${money.format(accountBalance(account.id))}</div><div class="card-note">Saldo inicial: ${money.format(account.initialBalance)}</div></article>`).join('');

  const cardCards = state.cards.map(card => {
    const invoice = cardInvoice(card.id);
    const available = card.limit - invoice;
    return `<article class="card credit-card"><div class="card-header"><div><div class="card-brand">${esc(card.brand || 'Cartão')}</div><h2 class="card-title">${esc(card.name)}</h2></div><div class="row-actions"><button class="icon-button" data-action="edit-card" data-id="${card.id}" aria-label="Editar">✎</button><button class="icon-button" data-action="delete-card" data-id="${card.id}" aria-label="Excluir">×</button></div></div><div class="card-limit">${money.format(invoice)}</div><div class="card-note">Fatura de ${esc(formatMonthShort(ui.month))}</div><div class="progress-row" style="margin-top:16px"><div class="progress-meta"><span>Limite disponível</span><strong class="${available < 0 ? 'negative' : ''}">${money.format(available)}</strong></div><div class="progress ${invoice > card.limit ? 'danger' : invoice / card.limit >= .8 ? 'warning' : ''}"><span style="width:${clamp((invoice / card.limit) * 100, 0, 100)}%"></span></div><div class="card-note">Fecha dia ${card.closingDay} · vence dia ${card.dueDay} · paga por ${esc(nameById(state.accounts, card.linkedAccountId))}</div></div></article>`;
  }).join('');

  const content = `
    <section>
      <div class="card-header"><div><h2 class="card-title">Contas</h2><p class="card-note">Saldos atualizados pelas movimentações confirmadas.</p></div><button class="button primary" data-action="add-account">+ Conta</button></div>
      <div class="grid three">${accountCards || empty('Cadastre sua primeira conta.')}</div>
    </section>
    <section style="margin-top:26px">
      <div class="card-header"><div><h2 class="card-title">Cartões de crédito</h2><p class="card-note">Compras no cartão não reduzem diretamente o saldo bancário.</p></div><button class="button primary" data-action="add-card">+ Cartão</button></div>
      <div class="grid three">${cardCards || empty('Cadastre seu primeiro cartão.')}</div>
    </section>`;

  return pageShell(content);
}

function renderPlanning() {
  const budgets = state.budgets.filter(item => item.month === ui.month);
  const budgetContent = `<div class="card-header"><div><h2 class="card-title">Orçamentos mensais</h2><p class="card-note">Defina limites por categoria.</p></div><button class="button primary" data-action="add-budget">+ Orçamento</button></div><div class="grid two">${budgets.map(budget => {
    const spent = budgetSpent(budget);
    const percent = budget.limit ? (spent / budget.limit) * 100 : 0;
    const level = percent >= 100 ? 'danger' : percent >= budget.alertAt ? 'warning' : '';
    return `<article class="card"><div class="card-header"><div><h3 class="card-title">${esc(budget.category)}</h3><p class="card-note">Alerta em ${budget.alertAt}%</p></div><div class="row-actions"><button class="icon-button" data-action="edit-budget" data-id="${budget.id}">✎</button><button class="icon-button" data-action="delete-budget" data-id="${budget.id}">×</button></div></div><div class="kpi-value ${percent > 100 ? 'negative' : ''}">${percent.toFixed(0)}%</div><div class="progress ${level}"><span style="width:${clamp(percent,0,100)}%"></span></div><div class="progress-meta" style="margin-top:8px"><span>${money.format(spent)} utilizados</span><strong>${money.format(budget.limit)}</strong></div></article>`;
  }).join('') || empty('Nenhum orçamento para este mês.')}</div>`;

  const goalContent = `<div class="card-header"><div><h2 class="card-title">Objetivos financeiros</h2><p class="card-note">Transforme metas em valores mensuráveis.</p></div><button class="button primary" data-action="add-goal">+ Objetivo</button></div><div class="grid two">${state.goals.map(goal => {
    const progress = goal.target ? (goal.current / goal.target) * 100 : 0;
    const deadline = parseDate(goal.deadline);
    const monthsLeft = deadline ? Math.max(1, Math.ceil((deadline - new Date()) / (1000 * 60 * 60 * 24 * 30.44))) : 1;
    const monthly = Math.max(0, goal.target - goal.current) / monthsLeft;
    return `<article class="card goal-card"><div class="card-header"><div><h3 class="card-title">${esc(goal.name)}</h3><p class="card-note">Prazo: ${deadline ? shortDate.format(deadline) : 'não informado'}</p></div><div class="row-actions"><button class="icon-button" data-action="contribute-goal" data-id="${goal.id}" title="Registrar aporte">＋</button><button class="icon-button" data-action="edit-goal" data-id="${goal.id}">✎</button><button class="icon-button" data-action="delete-goal" data-id="${goal.id}">×</button></div></div><div class="kpi-value">${money.format(goal.current)}</div><div class="card-note">de ${money.format(goal.target)}</div><div class="progress" style="margin-top:14px"><span style="width:${clamp(progress,0,100)}%"></span></div><div class="progress-meta" style="margin-top:8px"><span>${progress.toFixed(0)}% concluído</span><strong>${money.format(monthly)}/mês</strong></div>${goal.notes ? `<p class="card-note" style="margin-top:12px">${esc(goal.notes)}</p>` : ''}</article>`;
  }).join('') || empty('Nenhum objetivo cadastrado.')}</div>`;

  const content = `<div class="tabs"><button class="tab ${ui.planningTab === 'budgets' ? 'active' : ''}" data-action="planning-tab" data-tab="budgets">Orçamentos</button><button class="tab ${ui.planningTab === 'goals' ? 'active' : ''}" data-action="planning-tab" data-tab="goals">Objetivos</button></div>${ui.planningTab === 'budgets' ? budgetContent : goalContent}`;
  return pageShell(content);
}

function renderReports() {
  const categories = categoryTotals();
  const maxCategory = Math.max(1, ...categories.map(item => item.total));
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(ui.month, i - 5));
  const results = months.map(key => ({ key, ...monthTotals(key) }));
  const maxFlow = Math.max(1, ...results.flatMap(item => [item.income, item.expense]));
  const ignored = state.transactions.filter(tx => tx.status === 'ignored').length;
  const pending = state.transactions.filter(tx => tx.status === 'pending').length;
  const uncategorized = state.transactions.filter(tx => !tx.category).length;

  const content = `
    <section class="grid two">
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Distribuição dos gastos</h2><p class="card-note">Por categoria no mês selecionado</p></div></div>
        ${categories.length ? `<div class="chart">${categories.map(item => `<div class="chart-row"><div class="chart-label">${esc(item.category)}</div><div class="chart-track"><div class="chart-bar" style="width:${(item.total / maxCategory) * 100}%"></div></div><div class="chart-value">${money.format(item.total)}</div></div>`).join('')}</div>` : empty('Sem gastos confirmados para analisar.')}
      </article>
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Qualidade dos dados</h2><p class="card-note">Itens que merecem revisão</p></div></div>
        <div class="stack">
          <div class="list-row"><span>Transações pendentes</span><strong class="${pending ? 'warning' : 'positive'}">${pending}</strong></div>
          <div class="list-row"><span>Transações ignoradas</span><strong>${ignored}</strong></div>
          <div class="list-row"><span>Sem categoria</span><strong class="${uncategorized ? 'warning' : 'positive'}">${uncategorized}</strong></div>
          <div class="list-row"><span>Registros totais</span><strong>${state.transactions.length}</strong></div>
        </div>
      </article>
    </section>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Entradas e saídas — 6 meses</h2><p class="card-note">Comparativo baseado em transações confirmadas</p></div></div>
      <div class="chart">${results.map(item => `<div class="chart-row"><div class="chart-label">${esc(formatMonthShort(item.key))}</div><div><div class="chart-track" title="Ganhos"><div class="chart-bar" style="width:${(item.income / maxFlow) * 100}%"></div></div><div class="chart-track" title="Gastos" style="margin-top:5px"><div class="chart-bar" style="width:${(item.expense / maxFlow) * 100}%;background:var(--negative)"></div></div></div><div class="chart-value ${item.result >= 0 ? 'positive' : 'negative'}">${money.format(item.result)}</div></div>`).join('')}</div>
    </article>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Exportação</h2><p class="card-note">Gere arquivos para planilha ou uma cópia completa.</p></div></div>
      <div class="toolbar"><button class="button primary" data-action="export-csv">Exportar transações em CSV</button><button class="button" data-action="backup-json">Baixar cópia JSON</button></div>
    </article>`;

  return pageShell(content);
}

function renderSettings() {
  const info = syncStatusInfo();
  const lastSync = syncMeta.lastSyncedAt ? shortDate.format(new Date(syncMeta.lastSyncedAt)) + ' ' + new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit'}).format(new Date(syncMeta.lastSyncedAt)) : 'Ainda não sincronizado';
  const conflictActions = syncMeta.status === 'conflict' ? `<div class="sync-conflict"><strong>Conflito de sincronização</strong><p>${esc(syncMeta.message)}</p><div class="toolbar"><button class="button primary" data-action="force-cloud">Usar versão deste dispositivo</button><button class="button" data-action="force-pull">Usar versão da nuvem</button></div></div>` : '';
  const content = `<div class="settings-page">
    <article class="card settings-sync-card">
      <div class="card-header settings-card-header"><div><h2 class="card-title">Conta e sincronização</h2><p class="card-note">O mesmo login mantém os dados iguais no iPhone, Windows e outros dispositivos.</p></div><span class="chip ${info.tone}" data-sync-label>${info.label}</span></div>
      <div class="stack">
        <div class="list-row"><div><div class="row-title">Usuário</div><div class="row-subtitle">Conta conectada ao Supabase</div></div><strong>${esc(authSession?.user?.email || '')}</strong></div>
        <div class="list-row"><div><div class="row-title">Última sincronização</div><div class="row-subtitle">${esc(syncMeta.message || 'Sincronização automática ativa.')}</div></div><strong>${esc(lastSync)}</strong></div>
        <div class="list-row"><div><div class="row-title">Armazenamento</div><div class="row-subtitle">Nuvem central com cópia local para uso offline.</div></div><span class="chip confirmed">Supabase</span></div>
      </div>
      ${conflictActions}
      <div class="toolbar settings-actions" style="margin-top:14px"><button class="button primary" data-action="sync-now">Sincronizar agora</button><button class="button" data-action="force-pull">Recarregar da nuvem</button><button class="button" data-action="logout">Sair deste dispositivo</button></div>
    </article>

    <article class="card" style="margin-top:16px">
      <div class="setting-row"><div><div class="setting-title">Tema escuro</div><div class="setting-note">Adapta a interface para ambientes com pouca luz.</div></div><label class="switch"><input type="checkbox" id="dark-mode" ${state.preferences.darkMode ? 'checked' : ''}><span></span></label></div>
      <div class="setting-row"><div><div class="setting-title">Visão por caixa</div><div class="setting-note">Quando ativada, usa pagamento, recebimento ou vencimento; desativada, usa a data original da transação (competência).</div></div><label class="switch"><input type="checkbox" id="cash-basis" ${state.preferences.basis === 'cash' ? 'checked' : ''}><span></span></label></div>
      <div class="setting-row setting-row-name"><div><div class="setting-title">Nome do aplicativo</div><div class="setting-note">Personalize o título exibido na barra lateral.</div></div><div class="setting-name-control"><input class="input" id="app-name" value="${esc(state.preferences.name || '')}" maxlength="40"></div></div>
    </article>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Backup e exportação</h2><p class="card-note">A nuvem sincroniza automaticamente, mas você ainda pode gerar uma cópia independente.</p></div></div>
      <div class="toolbar settings-actions"><button class="button primary" data-action="backup-json">Baixar cópia JSON</button><button class="button" data-action="restore-json">Restaurar cópia</button><button class="button" data-action="export-csv">Exportar CSV</button><button class="button danger" data-action="reset-data">Apagar todos os dados</button></div>
    </article>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Privacidade e funcionamento</h2><p class="card-note">Entradas manuais, autenticação e sincronização entre dispositivos.</p></div></div>
      <div class="stack">
        <div class="list-row"><div><div class="row-title">Lançamentos</div><div class="row-subtitle">Ganhos, gastos, transferências e compras são cadastrados manualmente.</div></div><span class="chip confirmed">Manual</span></div>
        <div class="list-row"><div><div class="row-title">Segurança</div><div class="row-subtitle">O acesso aos dados depende do login e das regras RLS configuradas no Supabase.</div></div><span class="chip confirmed">RLS</span></div>
        <div class="list-row"><div><div class="row-title">Modo offline</div><div class="row-subtitle">Alterações ficam salvas neste dispositivo e são enviadas quando a internet voltar.</div></div><span class="chip pending">Local + nuvem</span></div>
        <div class="list-row"><div><div class="row-title">Versão</div><div class="row-subtitle">Aplicativo Web Progressivo (PWA) compatível com iPhone e Windows 11.</div></div><strong>${RELEASE_VERSION}</strong></div>
      </div>
    </article>
  </div>`;
  return pageShell(content);
}

function empty(message) {
  return `<div class="empty">${esc(message)}</div>`;
}

function selectOptions(options, selected) {
  return options.map(([value, label]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

function openModal(title, body, formId, submitLabel = 'Salvar', wide = false) {
  document.getElementById('modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="${wide ? 'width:min(860px,100%)' : ''}"><div class="modal-header"><h2 class="modal-title">${esc(title)}</h2><button class="icon-button" type="button" data-action="close-modal" aria-label="Fechar">×</button></div><div class="modal-body">${body}</div><div class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancelar</button><button class="button primary" type="submit" form="${formId}">${esc(submitLabel)}</button></div></section></div>`;
  setTimeout(() => document.querySelector(`#${formId} input, #${formId} select`)?.focus(), 30);
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

function showToast(message, options = {}) {
  const { tone = 'default', duration = 3000 } = options;
  const root = document.getElementById('toast-root');
  const node = document.createElement('div');
  node.className = `toast toast-${tone}`;
  node.textContent = message;
  root.appendChild(node);
  if (duration > 0) setTimeout(() => node.remove(), duration);
  return node;
}

function finishToast(node, message, tone = 'success', duration = 2600) {
  if (!node?.isConnected) return showToast(message, { tone, duration });
  node.className = `toast toast-${tone}`;
  node.textContent = message;
  setTimeout(() => node.remove(), duration);
  return node;
}

async function manualSync() {
  const toast = showToast('Sincronizando com a nuvem…', { tone: 'info', duration: 0 });

  if (!navigator.onLine) {
    syncMeta.status = 'offline';
    syncMeta.pending = true;
    syncMeta.message = 'Sem internet. As alterações permanecem salvas neste dispositivo.';
    saveSyncMeta();
    updateSyncIndicator();
    finishToast(toast, 'Sem internet — dados salvos neste dispositivo.', 'warning');
    return;
  }

  try {
    if (syncMeta.pending) await pushStateToCloud();
    else await pullStateFromCloud({ force: true });

    if (syncMeta.status === 'synced') {
      finishToast(toast, syncMeta.message || 'Sincronização concluída.', 'success');
    } else if (syncMeta.status === 'conflict') {
      finishToast(toast, 'Conflito detectado. Abra Configurações para escolher a versão.', 'warning', 3800);
    } else if (syncMeta.status === 'offline') {
      finishToast(toast, 'Sem internet — sincronização pendente.', 'warning');
    } else {
      finishToast(toast, syncMeta.message || 'Não foi possível sincronizar agora.', 'error', 3800);
    }
  } catch (error) {
    console.error('Falha na sincronização manual:', error);
    finishToast(toast, 'Erro ao sincronizar. Tente novamente.', 'error', 3800);
  }
}

function categoryDatalist() {
  return `<datalist id="categories-list">${state.categories.map(item => `<option value="${esc(item)}">`).join('')}</datalist>`;
}

function openTransactionForm(id = '') {
  const editing = state.transactions.find(item => item.id === id);
  const tx = editing || {
    description: '', amount: '', type: 'expense', date: isoDate(), dueDate: isoDate(), paidDate: '', accountId: state.accounts[0]?.id || '', destinationAccountId: state.accounts[1]?.id || '', cardId: state.cards[0]?.id || '', category: '', subcategory: '', member: '', tags: [], status: 'confirmed', paymentMethod: '', installmentCurrent: 1, installmentTotal: 1, recurrence: 'none', repeatCount: 1, notes: ''
  };
  const formId = 'transaction-form';
  const body = `<form id="${formId}" class="form-grid">
    <input type="hidden" name="id" value="${esc(id)}">
    <div class="field full"><label>Descrição *</label><input class="input" name="description" required maxlength="100" value="${esc(tx.description)}" placeholder="Ex.: supermercado, salário, aluguel"></div>
    <div class="field"><label>Valor ${editing ? '' : 'total'} *</label><input class="input" name="amount" required type="number" min="0.01" step="0.01" value="${esc(tx.amount)}"></div>
    <div class="field"><label>Tipo *</label><select class="select" name="type" id="tx-type">${selectOptions([['expense','Gasto em conta'],['income','Ganho'],['transfer','Transferência'],['card','Compra no cartão']], tx.type)}</select></div>
    <div class="field"><label>Data da operação *</label><input class="input" name="date" type="date" required value="${esc(tx.date)}"></div>
    <div class="field"><label>Vencimento</label><input class="input" name="dueDate" type="date" value="${esc(tx.dueDate || '')}"></div>
    <div class="field"><label>Pagamento/recebimento</label><input class="input" name="paidDate" type="date" value="${esc(tx.paidDate || '')}"></div>
    <div class="field"><label>Situação</label><select class="select" name="status">${selectOptions([['confirmed','Confirmada / realizada'],['pending','Pendente / prevista'],['ignored','Ignorada']], tx.status)}</select></div>
    <div class="field tx-account"><label>Conta de origem/destino</label><select class="select" name="accountId"><option value="">Selecione</option>${state.accounts.map(item => `<option value="${item.id}" ${item.id === tx.accountId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></div>
    <div class="field tx-destination"><label>Conta de destino (transferência)</label><select class="select" name="destinationAccountId"><option value="">Selecione</option>${state.accounts.map(item => `<option value="${item.id}" ${item.id === tx.destinationAccountId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></div>
    <div class="field tx-card"><label>Cartão</label><select class="select" name="cardId"><option value="">Selecione</option>${state.cards.map(item => `<option value="${item.id}" ${item.id === tx.cardId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Categoria</label><input class="input" name="category" list="categories-list" value="${esc(tx.category || '')}" placeholder="Ex.: Alimentação">${categoryDatalist()}</div>
    <div class="field"><label>Subcategoria</label><input class="input" name="subcategory" value="${esc(tx.subcategory || '')}" placeholder="Ex.: Supermercado"></div>
    <div class="field"><label>Membro</label><input class="input" name="member" list="members-list" value="${esc(tx.member || '')}"><datalist id="members-list">${state.members.map(item => `<option value="${esc(item)}">`).join('')}</datalist></div>
    <div class="field"><label>Forma de pagamento</label><input class="input" name="paymentMethod" value="${esc(tx.paymentMethod || '')}" placeholder="Pix, débito, boleto..."></div>
    <div class="field"><label>Parcelas</label><input class="input" name="installmentTotal" type="number" min="1" max="60" value="${esc(tx.installmentTotal || 1)}" ${editing ? 'disabled' : ''}></div>
    <div class="field"><label>Recorrência</label><select class="select" name="recurrence" ${editing ? 'disabled' : ''}>${selectOptions([['none','Não repetir'],['monthly','Mensal'],['weekly','Semanal'],['yearly','Anual']], tx.recurrence || 'none')}</select></div>
    <div class="field"><label>Quantidade de ocorrências</label><input class="input" name="repeatCount" type="number" min="1" max="60" value="${esc(tx.repeatCount || 1)}" ${editing ? 'disabled' : ''}></div>
    <div class="field"><label>Tags</label><input class="input" name="tags" value="${esc((tx.tags || []).join(', '))}" placeholder="viagem, trabalho, fixo"></div>
    <div class="field full"><label>Observações</label><textarea class="textarea" name="notes">${esc(tx.notes || '')}</textarea><div class="form-help">Compras parceladas criam lançamentos mensais. Recorrências criam a quantidade informada; use uma das opções por vez.</div></div>
  </form>`;
  openModal(editing ? 'Editar movimentação' : 'Nova movimentação', body, formId, editing ? 'Atualizar' : 'Adicionar', true);
  updateTransactionFields();
  document.getElementById('tx-type').addEventListener('change', updateTransactionFields);
  document.getElementById(formId).addEventListener('submit', event => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const data = Object.fromEntries(fd.entries());
    const type = data.type;
    if (type === 'transfer' && (!data.accountId || !data.destinationAccountId || data.accountId === data.destinationAccountId)) {
      showToast('Escolha contas de origem e destino diferentes.');
      return;
    }
    if (type === 'card' && !data.cardId) {
      showToast('Escolha o cartão da compra.');
      return;
    }
    if ((type === 'expense' || type === 'income') && !data.accountId) {
      showToast('Escolha uma conta.');
      return;
    }
    const base = {
      description: data.description.trim(), amount: num(data.amount), type, date: data.date, dueDate: data.dueDate || '', paidDate: data.paidDate || '',
      accountId: ['expense','income','transfer'].includes(type) ? data.accountId : '', destinationAccountId: type === 'transfer' ? data.destinationAccountId : '', cardId: type === 'card' ? data.cardId : '',
      category: data.category.trim() || (type === 'transfer' ? 'Transferência' : 'Outros'), subcategory: data.subcategory.trim(), member: data.member.trim(),
      tags: data.tags.split(',').map(item => item.trim()).filter(Boolean), status: data.status, paymentMethod: data.paymentMethod.trim(), notes: data.notes.trim(), recurrence: data.recurrence || 'none'
    };
    addLearnedValues(base);
    if (editing) {
      Object.assign(editing, base);
    } else {
      createGeneratedTransactions(base, num(data.installmentTotal) || 1, data.recurrence || 'none', num(data.repeatCount) || 1);
    }
    persist(); closeModal(); render(); showToast(editing ? 'Movimentação atualizada.' : 'Movimentação adicionada.');
  });
}

function updateTransactionFields() {
  const type = document.getElementById('tx-type')?.value;
  document.querySelectorAll('.tx-account').forEach(node => node.style.display = ['expense','income','transfer'].includes(type) ? '' : 'none');
  document.querySelectorAll('.tx-destination').forEach(node => node.style.display = type === 'transfer' ? '' : 'none');
  document.querySelectorAll('.tx-card').forEach(node => node.style.display = type === 'card' ? '' : 'none');
}

function createGeneratedTransactions(base, installmentTotal, recurrence, repeatCount) {
  if (installmentTotal > 1) {
    const installmentAmount = Math.round((base.amount / installmentTotal) * 100) / 100;
    const groupId = uid();
    for (let i = 0; i < installmentTotal; i++) {
      const amount = i === installmentTotal - 1 ? Math.round((base.amount - installmentAmount * (installmentTotal - 1)) * 100) / 100 : installmentAmount;
      state.transactions.push({ ...base, id: uid(), groupId, amount, date: shiftDateMonths(base.date, i), dueDate: base.dueDate ? shiftDateMonths(base.dueDate, i) : '', paidDate: i === 0 ? base.paidDate : '', installmentCurrent: i + 1, installmentTotal, recurrence: 'none' });
    }
    return;
  }
  const count = recurrence === 'none' ? 1 : repeatCount;
  for (let i = 0; i < count; i++) {
    let date = base.date, dueDate = base.dueDate, paidDate = i === 0 ? base.paidDate : '';
    if (i > 0 && recurrence === 'monthly') { date = shiftDateMonths(base.date, i); dueDate = base.dueDate ? shiftDateMonths(base.dueDate, i) : ''; }
    if (i > 0 && recurrence === 'weekly') { date = shiftDateDays(base.date, i * 7); dueDate = base.dueDate ? shiftDateDays(base.dueDate, i * 7) : ''; }
    if (i > 0 && recurrence === 'yearly') { date = shiftDateMonths(base.date, i * 12); dueDate = base.dueDate ? shiftDateMonths(base.dueDate, i * 12) : ''; }
    state.transactions.push({ ...base, id: uid(), date, dueDate, paidDate, installmentCurrent: 1, installmentTotal: 1 });
  }
}

function addLearnedValues(tx) {
  if (tx.category && !state.categories.includes(tx.category)) state.categories.push(tx.category);
  if (tx.member && !state.members.includes(tx.member)) state.members.push(tx.member);
}

function openAccountForm(id = '') {
  const editing = state.accounts.find(item => item.id === id);
  const item = editing || { name: '', type: 'Conta-corrente', institution: '', initialBalance: 0 };
  const formId = 'account-form';
  const body = `<form id="${formId}" class="form-grid"><div class="field full"><label>Nome *</label><input class="input" name="name" required value="${esc(item.name)}" placeholder="Ex.: Conta principal"></div><div class="field"><label>Tipo</label><select class="select" name="type">${selectOptions([['Conta-corrente','Conta-corrente'],['Poupança','Poupança'],['Dinheiro','Carteira / dinheiro'],['Investimento','Investimento'],['Financiamento','Financiamento'],['Conta digital','Conta digital'],['Outra','Outra']], item.type)}</select></div><div class="field"><label>Instituição</label><input class="input" name="institution" value="${esc(item.institution || '')}" placeholder="Opcional"></div><div class="field full"><label>Saldo inicial</label><input class="input" name="initialBalance" type="number" step="0.01" value="${esc(item.initialBalance)}"><div class="form-help">Use o saldo existente antes do primeiro lançamento registrado no aplicativo.</div></div></form>`;
  openModal(editing ? 'Editar conta' : 'Nova conta', body, formId);
  document.getElementById(formId).addEventListener('submit', event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const record = { name: data.name.trim(), type: data.type, institution: data.institution.trim(), initialBalance: num(data.initialBalance) };
    if (editing) Object.assign(editing, record); else state.accounts.push({ id: uid(), createdAt: isoDate(), ...record });
    persist(); closeModal(); render(); showToast(editing ? 'Conta atualizada.' : 'Conta criada.');
  });
}

function openCardForm(id = '') {
  const editing = state.cards.find(item => item.id === id);
  const item = editing || { name: '', brand: 'Visa', limit: 3000, closingDay: 20, dueDay: 1, linkedAccountId: state.accounts[0]?.id || '' };
  const formId = 'card-form';
  const body = `<form id="${formId}" class="form-grid"><div class="field full"><label>Nome *</label><input class="input" name="name" required value="${esc(item.name)}" placeholder="Ex.: Cartão principal"></div><div class="field"><label>Bandeira</label><input class="input" name="brand" value="${esc(item.brand || '')}" placeholder="Visa, Mastercard..."></div><div class="field"><label>Limite</label><input class="input" name="limit" type="number" min="0" step="0.01" value="${esc(item.limit)}"></div><div class="field"><label>Dia de fechamento</label><input class="input" name="closingDay" type="number" min="1" max="31" value="${esc(item.closingDay)}"></div><div class="field"><label>Dia de vencimento</label><input class="input" name="dueDay" type="number" min="1" max="31" value="${esc(item.dueDay)}"></div><div class="field full"><label>Conta usada no pagamento</label><select class="select" name="linkedAccountId"><option value="">Selecione</option>${state.accounts.map(account => `<option value="${account.id}" ${account.id === item.linkedAccountId ? 'selected' : ''}>${esc(account.name)}</option>`).join('')}</select></div></form>`;
  openModal(editing ? 'Editar cartão' : 'Novo cartão', body, formId);
  document.getElementById(formId).addEventListener('submit', event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const record = { name: data.name.trim(), brand: data.brand.trim(), limit: num(data.limit), closingDay: num(data.closingDay), dueDay: num(data.dueDay), linkedAccountId: data.linkedAccountId };
    if (editing) Object.assign(editing, record); else state.cards.push({ id: uid(), ...record });
    persist(); closeModal(); render(); showToast(editing ? 'Cartão atualizado.' : 'Cartão criado.');
  });
}

function openBudgetForm(id = '') {
  const editing = state.budgets.find(item => item.id === id);
  const item = editing || { category: '', limit: 0, month: ui.month, alertAt: 80 };
  const formId = 'budget-form';
  const body = `<form id="${formId}" class="form-grid"><div class="field full"><label>Categoria *</label><input class="input" name="category" required list="categories-list" value="${esc(item.category)}">${categoryDatalist()}</div><div class="field"><label>Limite mensal *</label><input class="input" name="limit" required type="number" min="0.01" step="0.01" value="${esc(item.limit)}"></div><div class="field"><label>Mês</label><input class="input" name="month" type="month" value="${esc(item.month)}"></div><div class="field full"><label>Alertar ao atingir (%)</label><input class="input" name="alertAt" type="number" min="1" max="100" value="${esc(item.alertAt)}"></div></form>`;
  openModal(editing ? 'Editar orçamento' : 'Novo orçamento', body, formId);
  document.getElementById(formId).addEventListener('submit', event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const duplicate = state.budgets.find(b => b.id !== id && b.category.toLowerCase() === data.category.trim().toLowerCase() && b.month === data.month);
    if (duplicate) { showToast('Já existe orçamento para esta categoria e mês.'); return; }
    const record = { category: data.category.trim(), limit: num(data.limit), month: data.month, alertAt: num(data.alertAt) };
    if (editing) Object.assign(editing, record); else state.budgets.push({ id: uid(), ...record });
    if (!state.categories.includes(record.category)) state.categories.push(record.category);
    ui.month = record.month; persist(); closeModal(); render(); showToast(editing ? 'Orçamento atualizado.' : 'Orçamento criado.');
  });
}

function openGoalForm(id = '') {
  const editing = state.goals.find(item => item.id === id);
  const item = editing || { name: '', target: 0, current: 0, deadline: shiftDateMonths(isoDate(), 12), notes: '' };
  const formId = 'goal-form';
  const body = `<form id="${formId}" class="form-grid"><div class="field full"><label>Objetivo *</label><input class="input" name="name" required value="${esc(item.name)}" placeholder="Ex.: Reserva de emergência"></div><div class="field"><label>Valor desejado *</label><input class="input" name="target" required type="number" min="0.01" step="0.01" value="${esc(item.target)}"></div><div class="field"><label>Valor acumulado</label><input class="input" name="current" type="number" min="0" step="0.01" value="${esc(item.current)}"></div><div class="field full"><label>Prazo</label><input class="input" name="deadline" type="date" value="${esc(item.deadline)}"></div><div class="field full"><label>Observações</label><textarea class="textarea" name="notes">${esc(item.notes || '')}</textarea></div></form>`;
  openModal(editing ? 'Editar objetivo' : 'Novo objetivo', body, formId);
  document.getElementById(formId).addEventListener('submit', event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const record = { name: data.name.trim(), target: num(data.target), current: num(data.current), deadline: data.deadline, notes: data.notes.trim() };
    if (editing) Object.assign(editing, record); else state.goals.push({ id: uid(), ...record });
    persist(); closeModal(); render(); showToast(editing ? 'Objetivo atualizado.' : 'Objetivo criado.');
  });
}

function openGoalContribution(id) {
  const goal = state.goals.find(item => item.id === id); if (!goal) return;
  const formId = 'goal-contribution-form';
  const body = `<form id="${formId}" class="form-grid"><div class="field full"><label>Objetivo</label><input class="input" value="${esc(goal.name)}" disabled></div><div class="field full"><label>Valor do aporte *</label><input class="input" name="amount" required type="number" min="0.01" step="0.01" autofocus></div></form>`;
  openModal('Registrar aporte', body, formId, 'Adicionar aporte');
  document.getElementById(formId).addEventListener('submit', event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    goal.current += num(data.amount); persist(); closeModal(); render(); showToast('Aporte registrado.');
  });
}

function confirmDelete(message, callback) {
  if (window.confirm(message)) { callback(); persist(); render(); showToast('Registro excluído.'); }
}

function exportCsv() {
  const headers = ['Descrição','Valor','Tipo','Data','Vencimento','Pagamento','Situação','Conta','Conta destino','Cartão','Categoria','Subcategoria','Membro','Tags','Forma de pagamento','Parcela','Observações'];
  const quote = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  const lines = [headers.map(quote).join(';')];
  state.transactions.sort((a,b) => (a.date || '').localeCompare(b.date || '')).forEach(tx => {
    lines.push([
      tx.description, Number(tx.amount).toFixed(2).replace('.',','), typeLabel(tx.type), tx.date, tx.dueDate, tx.paidDate, tx.status,
      nameById(state.accounts, tx.accountId, ''), nameById(state.accounts, tx.destinationAccountId, ''), nameById(state.cards, tx.cardId, ''),
      tx.category, tx.subcategory, tx.member, (tx.tags || []).join(', '), tx.paymentMethod, `${tx.installmentCurrent || 1}/${tx.installmentTotal || 1}`, tx.notes
    ].map(quote).join(';'));
  });
  downloadBlob(`meu-financeiro-transacoes-${isoDate()}.csv`, '\ufeff' + lines.join('\n'), 'text/csv;charset=utf-8');
  showToast('Arquivo CSV gerado.');
}

function backupJson() {
  downloadBlob(`meu-financeiro-backup-${isoDate()}.json`, JSON.stringify(state, null, 2), 'application/json');
  showToast('Cópia de segurança gerada.');
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function restoreJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const restored = normalizeState(JSON.parse(reader.result));
      state = restored; persist(); render(); showToast('Cópia restaurada com sucesso.');
    } catch (error) { showToast('Arquivo inválido ou corrompido.'); }
  };
  reader.readAsText(file);
}

async function installApp() {
  if (ui.deferredInstallPrompt) {
    ui.deferredInstallPrompt.prompt();
    await ui.deferredInstallPrompt.userChoice;
    ui.deferredInstallPrompt = null;
    return;
  }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  showToast(isIOS ? 'No Safari: Compartilhar → Adicionar à Tela de Início.' : 'No Edge: menu ⋯ → Aplicativos → Instalar este site como aplicativo.');
}

document.addEventListener('submit', async event => {
  if (!['signin-form', 'signup-form', 'forgot-form', 'recovery-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (!supabaseClient) return;
  const form = event.target;
  const values = Object.fromEntries(new FormData(form).entries());
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  ui.authMessage = '';
  try {
    if (form.id === 'signin-form') {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email: values.email.trim(), password: values.password });
      if (error) throw error;
      await activateSession(data.session);
      showToast('Login realizado. Seus dados serão sincronizados.');
    }
    if (form.id === 'signup-form') {
      if (values.password !== values.confirmPassword) throw new Error('As senhas não coincidem.');
      const { data, error } = await supabaseClient.auth.signUp({
        email: values.email.trim(),
        password: values.password,
        options: { emailRedirectTo: APP_URL }
      });
      if (error) throw error;
      if (data.session) await activateSession(data.session);
      else { ui.authMode = 'signin'; ui.authMessage = 'Conta criada. Confirme o e-mail antes de entrar.'; render(); }
    }
    if (form.id === 'forgot-form') {
      const { error } = await supabaseClient.auth.resetPasswordForEmail(values.email.trim(), { redirectTo: APP_URL });
      if (error) throw error;
      ui.authMode = 'signin'; ui.authMessage = 'Enviamos um link de recuperação para o seu e-mail.'; render();
    }
    if (form.id === 'recovery-form') {
      if (values.password !== values.confirmPassword) throw new Error('As senhas não coincidem.');
      const { error } = await supabaseClient.auth.updateUser({ password: values.password });
      if (error) throw error;
      ui.authMode = 'signin'; ui.authMessage = '';
      const { data } = await supabaseClient.auth.getSession();
      if (data.session) await activateSession(data.session);
      showToast('Senha atualizada com sucesso.');
    }
  } catch (error) {
    ui.authMessage = authErrorMessage(error);
    render();
  } finally {
    if (submit) submit.disabled = false;
  }
});

function authErrorMessage(error) {
  const message = String(error?.message || error || 'Falha na autenticação.');
  if (/invalid login credentials/i.test(message)) return 'E-mail ou senha incorretos.';
  if (/email not confirmed/i.test(message)) return 'Confirme seu e-mail antes de entrar.';
  if (/user already registered/i.test(message)) return 'Já existe uma conta com este e-mail.';
  if (/password/i.test(message) && /characters|weak|short/i.test(message)) return 'Use uma senha mais forte, com pelo menos 8 caracteres.';
  return message;
}

async function activateSession(session) {
  if (!session?.user?.id) return;
  authSession = session;
  state = loadStateForUser(session.user.id);
  syncMeta = loadSyncMeta(session.user.id);
  authReady = true;
  ui.authMode = 'signin';
  ui.authMessage = '';
  render();
  await initialCloudSync();
  startSyncPolling();
}

async function logoutCurrentDevice() {
  if (syncMeta.pending && navigator.onLine) await pushStateToCloud();
  const { error } = await supabaseClient.auth.signOut({ scope: 'local' });
  if (error) { showToast('Não foi possível sair agora.'); return; }
  stopSyncPolling();
  authSession = null;
  state = defaultState();
  syncMeta = { status: 'local', pending: false, lastSyncedAt: '', lastRemoteUpdatedAt: '', remoteVersion: 0, message: '' };
  ui.page = 'dashboard';
  render();
}

function startSyncPolling() {
  stopSyncPolling();
  syncPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine && authSession && !syncMeta.pending) pullStateFromCloud({ quiet: true });
  }, 30000);
}

function stopSyncPolling() {
  if (syncPollTimer) clearInterval(syncPollTimer);
  syncPollTimer = null;
}

document.addEventListener('click', event => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) { ui.page = pageButton.dataset.page; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === 'auth-mode') { ui.authMode = button.dataset.mode || 'signin'; ui.authMessage = ''; render(); return; }
  if (action === 'sync-now') { manualSync(); return; }
  if (action === 'force-cloud') { pushStateToCloud({ force: true }).then(() => render()); return; }
  if (action === 'force-pull') {
    if (syncMeta.pending && !window.confirm('Usar a versão da nuvem? Alterações ainda não sincronizadas deste dispositivo serão substituídas.')) return;
    syncMeta.pending = false; saveSyncMeta(); pullStateFromCloud({ force: true }).then(() => render()); return;
  }
  if (action === 'logout') { logoutCurrentDevice(); return; }
  if (action === 'prev-month') { ui.month = shiftMonth(ui.month, -1); render(); }
  if (action === 'next-month') { ui.month = shiftMonth(ui.month, 1); render(); }
  if (action === 'close-modal') {
    // Se o clique veio do fundo escurecido, fecha somente quando o próprio fundo foi tocado.
    // Cliques dentro da janela não devem fechá-la. Os botões × e Cancelar fecham normalmente.
    if (button.classList.contains('modal-backdrop') && event.target !== button) return;
    closeModal();
    return;
  }
  if (action === 'dismiss-install') { state.preferences.showInstallHelp = false; persist(); render(); }
  if (action === 'install-app') installApp();
  if (action === 'add-transaction') openTransactionForm();
  if (action === 'edit-transaction') openTransactionForm(id);
  if (action === 'delete-transaction') confirmDelete('Excluir esta movimentação?', () => state.transactions = state.transactions.filter(item => item.id !== id));
  if (action === 'add-account') openAccountForm();
  if (action === 'edit-account') openAccountForm(id);
  if (action === 'delete-account') {
    const used = state.transactions.some(tx => tx.accountId === id || tx.destinationAccountId === id) || state.cards.some(card => card.linkedAccountId === id);
    if (used) showToast('Esta conta está vinculada a movimentações ou cartões. Remova os vínculos antes.');
    else confirmDelete('Excluir esta conta?', () => state.accounts = state.accounts.filter(item => item.id !== id));
  }
  if (action === 'add-card') openCardForm();
  if (action === 'edit-card') openCardForm(id);
  if (action === 'delete-card') {
    const used = state.transactions.some(tx => tx.cardId === id);
    if (used) showToast('Este cartão possui compras vinculadas. Remova-as antes.');
    else confirmDelete('Excluir este cartão?', () => state.cards = state.cards.filter(item => item.id !== id));
  }
  if (action === 'planning-tab') { ui.planningTab = button.dataset.tab; render(); }
  if (action === 'add-budget') openBudgetForm();
  if (action === 'edit-budget') openBudgetForm(id);
  if (action === 'delete-budget') confirmDelete('Excluir este orçamento?', () => state.budgets = state.budgets.filter(item => item.id !== id));
  if (action === 'add-goal') openGoalForm();
  if (action === 'edit-goal') openGoalForm(id);
  if (action === 'contribute-goal') openGoalContribution(id);
  if (action === 'delete-goal') confirmDelete('Excluir este objetivo?', () => state.goals = state.goals.filter(item => item.id !== id));
  if (action === 'export-csv') exportCsv();
  if (action === 'backup-json') backupJson();
  if (action === 'restore-json') document.getElementById('restore-file').click();
  if (action === 'reset-data') {
    if (window.confirm('Apagar todos os dados financeiros desta conta? A exclusão será sincronizada com os outros dispositivos e não pode ser desfeita sem uma cópia de segurança.')) {
      state = defaultState(); persist(); ui.month = monthKey(new Date()); render(); showToast('Todos os dados foram apagados.');
    }
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'transaction-search') { ui.transactionSearch = event.target.value; render(); document.getElementById('transaction-search')?.focus(); }
  if (event.target.id === 'app-name') { state.preferences.name = event.target.value || 'Meu Financeiro'; persist(); }
});

document.addEventListener('change', event => {
  if (event.target.id === 'transaction-type-filter') { ui.transactionType = event.target.value; render(); }
  if (event.target.id === 'transaction-status-filter') { ui.transactionStatus = event.target.value; render(); }
  if (event.target.id === 'dark-mode') { state.preferences.darkMode = event.target.checked; persist(); render(); }
  if (event.target.id === 'cash-basis') { state.preferences.basis = event.target.checked ? 'cash' : 'accrual'; persist(); render(); }
  if (event.target.id === 'restore-file' && event.target.files?.[0]) { restoreJson(event.target.files[0]); event.target.value = ''; }
});

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  ui.deferredInstallPrompt = event;
});

window.addEventListener('appinstalled', () => {
  state.preferences.showInstallHelp = false; persist(); render(); showToast('Aplicativo instalado.');
});

window.addEventListener('online', () => {
  if (!authSession) return;
  syncMeta.status = syncMeta.pending ? 'pending' : 'syncing';
  saveSyncMeta();
  updateSyncIndicator();
  if (syncMeta.pending) pushStateToCloud(); else pullStateFromCloud({ quiet: true });
});

window.addEventListener('offline', () => {
  if (!authSession) return;
  syncMeta.status = 'offline';
  syncMeta.message = 'Sem internet. Seus dados continuam disponíveis neste dispositivo.';
  saveSyncMeta();
  updateSyncIndicator();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && authSession && navigator.onLine && !syncMeta.pending) pullStateFromCloud({ quiet: true });
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.error));
}

async function initializeApp() {
  applyTheme();
  render();
  try {
    const config = window.MEU_FINANCEIRO_CONFIG || {};
    if (!window.supabase?.createClient) throw new Error('Biblioteca de sincronização não carregada. Verifique sua conexão com a internet.');
    if (!config.supabaseUrl || !config.supabasePublishableKey) throw new Error('Configuração do Supabase ausente.');
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    supabaseClient.auth.onAuthStateChange((event, session) => {
      setTimeout(async () => {
        if (event === 'PASSWORD_RECOVERY') {
          authSession = session;
          authReady = true;
          ui.authMode = 'recovery';
          render();
          return;
        }
        if (event === 'SIGNED_OUT') {
          stopSyncPolling();
          authSession = null;
          authReady = true;
          state = defaultState();
          render();
          return;
        }
        if (session?.user?.id && (!authSession || authSession.user.id !== session.user.id)) await activateSession(session);
      }, 0);
    });

    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    authReady = true;
    if (data.session) await activateSession(data.session);
    else render();
  } catch (error) {
    console.error(error);
    authReady = true;
    authSession = null;
    ui.authMessage = error?.message || 'Não foi possível iniciar a sincronização.';
    render();
  }
}

initializeApp();
