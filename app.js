'use strict';

const LEGACY_STORAGE_KEY = 'meu-financeiro-data-v1';
const APP_VERSION = 7;
const RELEASE_VERSION = '2.1.1';
const REMOTE_TABLE = 'user_app_state';
const PLUGGY_ITEMS_TABLE = 'pluggy_items';
const PLUGGY_ACCOUNTS_TABLE = 'pluggy_accounts';
const PLUGGY_TRANSACTIONS_TABLE = 'pluggy_transactions';
const PLUGGY_INVESTMENTS_TABLE = 'pluggy_investments';
const APP_URL = 'https://gabrielcoutoabreu.github.io/Meu-Financeiro/';
const MEU_PLUGGY_URL = 'https://meu.pluggy.ai/';
const OPEN_FINANCE_RETURN_KEY = 'mf-open-finance-awaiting-meupluggy';
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const shortDateTime = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
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
  patrimony: ['Contas e cartões', 'Saldos, faturas, investimentos e limite disponível.'],
  planning: ['Planejamento', 'Orçamentos mensais e objetivos financeiros.'],
  reports: ['Relatórios', 'Análises por categoria, evolução e exportação.'],
  settings: ['Configurações', 'Preferências, segurança e cópias dos dados.']
};

let state = defaultState();
let authSession = null;
let authReady = false;
let supabaseClient = null;
let pluggyItems = [];
let pluggyItemsLoading = false;
let pluggyAccounts = [];
let pluggyTransactions = [];
let pluggyInvestments = [];
let pluggyRemoteStatus = new Map();
let pluggyDataLoading = false;
let openFinanceReturnCheckRunning = false;
let pluggyAccountMap = new Map();
let pluggyNeutralBankIds = new Set();
let pluggySuppressedIds = new Set();
let pluggyInternalTransferIds = new Set();
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
  reportRange: '6m',
  reportStart: '',
  reportEnd: '',
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

function monthStart(key) {
  return `${key}-01`;
}

function monthEnd(key) {
  const d = monthDate(key);
  return isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12));
}

function dateKey(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : isoDate(parsed);
}

function formatDateBr(value) {
  const d = parseDate(dateKey(value));
  return d ? shortDate.format(d) : '—';
}

function reportRangeBounds() {
  const preset = ui.reportRange || '6m';
  const endMonth = ui.month;

  if (preset === 'custom') {
    let start = dateKey(ui.reportStart) || monthStart(shiftMonth(endMonth, -5));
    let end = dateKey(ui.reportEnd) || monthEnd(endMonth);
    if (start > end) [start, end] = [end, start];
    return { start, end, preset };
  }

  if (preset === 'all') {
    const dates = allTransactions().map(tx => dateKey(transactionViewDate(tx))).filter(Boolean).sort();
    if (dates.length) return { start: dates[0], end: dates[dates.length - 1], preset };
    return { start: monthStart(endMonth), end: monthEnd(endMonth), preset };
  }

  const months = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 };
  const count = months[preset] || 6;
  return {
    start: monthStart(shiftMonth(endMonth, -(count - 1))),
    end: monthEnd(endMonth),
    preset
  };
}

function reportRangeLabel(range = reportRangeBounds()) {
  if (range.start.slice(0, 7) === range.end.slice(0, 7) && range.start.endsWith('-01')) {
    return formatMonthShort(range.start.slice(0, 7));
  }
  return `${formatDateBr(range.start)} a ${formatDateBr(range.end)}`;
}

function periodTransactions(range = reportRangeBounds(), includePending = true) {
  return allTransactions().filter(tx => {
    if (!validForCalculations(tx)) return false;
    if (!includePending && tx.status !== 'confirmed') return false;
    const key = dateKey(transactionViewDate(tx));
    return key && key >= range.start && key <= range.end;
  });
}

function periodTotals(range = reportRangeBounds()) {
  const confirmed = periodTransactions(range, false);
  const income = confirmed.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + num(tx.amount), 0);
  const expense = confirmed.filter(tx => tx.type === 'expense' || tx.type === 'card').reduce((sum, tx) => sum + num(tx.amount), 0);
  return { income, expense, result: income - expense, count: confirmed.length };
}

function periodCategoryTotals(range = reportRangeBounds()) {
  const map = new Map();
  periodTransactions(range, false)
    .filter(tx => tx.type === 'expense' || tx.type === 'card')
    .forEach(tx => map.set(tx.category || 'Sem categoria', (map.get(tx.category || 'Sem categoria') || 0) + num(tx.amount)));
  return [...map.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

function periodMonthlyResults(range = reportRangeBounds()) {
  const grouped = new Map();
  periodTransactions(range, false).forEach(tx => {
    const key = dateKey(transactionViewDate(tx)).slice(0, 7);
    if (!key) return;
    if (!grouped.has(key)) grouped.set(key, { income: 0, expense: 0 });
    const bucket = grouped.get(key);
    if (tx.type === 'income') bucket.income += num(tx.amount);
    if (tx.type === 'expense' || tx.type === 'card') bucket.expense += num(tx.amount);
  });

  const months = [];
  let key = range.start.slice(0, 7);
  const last = range.end.slice(0, 7);
  let safety = 0;
  while (key <= last && safety < 120) {
    const bucket = grouped.get(key) || { income: 0, expense: 0 };
    months.push({ key, ...bucket, result: bucket.income - bucket.expense });
    key = shiftMonth(key, 1);
    safety++;
  }
  return months;
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
      hideDashboardValues: false,
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

function pluggyDateLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function simpleDate(value) {
  if (!value) return '';
  const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function pluggyTransferEvidence(row) {
  const operation = String(row.operation_type || '').toUpperCase();
  const category = normalizeSearchText(row.category);
  const description = normalizeSearchText(`${row.description || ''} ${row.description_raw || ''}`);
  const transferOperations = new Set(['PIX', 'TED', 'DOC', 'TRANSFERENCIA_MESMA_INSTITUICAO', 'PORTABILIDADE_SALARIO']);
  return transferOperations.has(operation)
    || category.includes('same person transfer')
    || category.includes('transfer - pix')
    || category.includes('transfer - ted')
    || category.includes('transfer - doc')
    || category.includes('transfer - internal')
    || /(^|\b)(pix|ted|doc|tef|transferencia|transf)(\b|$)/i.test(description);
}

function pluggyExplicitOwnTransfer(row) {
  const operation = String(row.operation_type || '').toUpperCase();
  const category = normalizeSearchText(row.category);
  const description = normalizeSearchText(`${row.description || ''} ${row.description_raw || ''}`);
  if (category.includes('same person transfer')) return true;
  if (operation === 'PORTABILIDADE_SALARIO') return true;
  return /(mesma titularidade|mesmo titular|mesma pessoa|conta propria|entre minhas contas|entre contas proprias)/i.test(description);
}

function rebuildOpenFinanceIndexes() {
  pluggyAccountMap = new Map(pluggyAccounts.map(account => [account.pluggy_account_id, account]));
  pluggyNeutralBankIds = new Set();
  pluggySuppressedIds = new Set();
  pluggyInternalTransferIds = new Set();

  const bankRows = pluggyTransactions.filter(row => {
    const account = pluggyAccountMap.get(row.pluggy_account_id);
    return String(account?.type || '').toUpperCase() === 'BANK';
  });

  // Classificações explícitas de transferência entre contas do mesmo titular.
  bankRows.forEach(row => {
    if (pluggyExplicitOwnTransfer(row)) pluggyInternalTransferIds.add(row.pluggy_transaction_id);
  });

  // Pareia saída e entrada de mesmo valor entre duas contas bancárias conectadas.
  // Exige evidência de transferência (PIX/TED/DOC/transferência) em pelo menos uma das pontas.
  const credits = bankRows.filter(row => String(row.transaction_type || '').toUpperCase() === 'CREDIT');
  const usedCredits = new Set();
  bankRows
    .filter(row => String(row.transaction_type || '').toUpperCase() === 'DEBIT')
    .forEach(debit => {
      const amount = Math.abs(num(debit.amount));
      const debitTime = new Date(debit.transaction_date).getTime();
      if (!amount || !Number.isFinite(debitTime)) return;

      const candidates = credits
        .filter(credit => {
          if (usedCredits.has(credit.pluggy_transaction_id)) return false;
          if (credit.pluggy_account_id === debit.pluggy_account_id) return false;
          if (Math.abs(Math.abs(num(credit.amount)) - amount) >= 0.01) return false;
          const creditTime = new Date(credit.transaction_date).getTime();
          if (!Number.isFinite(creditTime) || Math.abs(creditTime - debitTime) > 2 * 86400000) return false;
          return pluggyTransferEvidence(debit) || pluggyTransferEvidence(credit);
        })
        .sort((a, b) => {
          const at = Math.abs(new Date(a.transaction_date).getTime() - debitTime);
          const bt = Math.abs(new Date(b.transaction_date).getTime() - debitTime);
          const aStrong = pluggyTransferEvidence(debit) && pluggyTransferEvidence(a) ? -1 : 0;
          const bStrong = pluggyTransferEvidence(debit) && pluggyTransferEvidence(b) ? -1 : 0;
          return aStrong - bStrong || at - bt;
        });

      const matched = candidates[0];
      if (!matched) return;
      pluggyInternalTransferIds.add(debit.pluggy_transaction_id);
      pluggyInternalTransferIds.add(matched.pluggy_transaction_id);
      usedCredits.add(matched.pluggy_transaction_id);
    });

  // Pagamentos de cartão continuam patrimonialmente neutros.
  const cardCredits = pluggyTransactions.filter(row => {
    const account = pluggyAccountMap.get(row.pluggy_account_id);
    return String(account?.type || '').toUpperCase() === 'CREDIT' && num(row.amount) < 0;
  });
  const usedCardCredits = new Set();

  bankRows.forEach(row => {
    if (String(row.transaction_type || '').toUpperCase() !== 'DEBIT') return;
    if (pluggyInternalTransferIds.has(row.pluggy_transaction_id)) return;

    const description = normalizeSearchText(`${row.description || ''} ${row.description_raw || ''}`);
    const explicitCardPayment = /(pagamento|pagto|pgto|pgt).*?(cartao|fatura)|(cartao|fatura).*?(pagamento|pagto|pgto|pgt)/i.test(description);
    const amount = Math.abs(num(row.amount));
    const time = new Date(row.transaction_date).getTime();

    let matched = null;
    if (amount > 0 && Number.isFinite(time)) {
      matched = cardCredits.find(other => {
        if (usedCardCredits.has(other.pluggy_transaction_id)) return false;
        const otherTime = new Date(other.transaction_date).getTime();
        const otherDescription = normalizeSearchText(`${other.description || ''} ${other.description_raw || ''}`);
        const creditLooksLikePayment = /(pagamento|pagto|pgto|pgt|fatura)/i.test(otherDescription);
        return Math.abs(Math.abs(num(other.amount)) - amount) < 0.01
          && Math.abs(otherTime - time) <= 3 * 86400000
          && (explicitCardPayment || creditLooksLikePayment);
      });
    }

    if (explicitCardPayment || matched) pluggyNeutralBankIds.add(row.pluggy_transaction_id);
    if (matched) {
      pluggySuppressedIds.add(matched.pluggy_transaction_id);
      usedCardCredits.add(matched.pluggy_transaction_id);
    }
  });
}

function normalizePluggyTransaction(row) {
  const account = pluggyAccountMap.get(row.pluggy_account_id);
  if (!account || pluggySuppressedIds.has(row.pluggy_transaction_id)) return null;

  const signedAmount = num(row.amount);
  const amount = Math.abs(signedAmount);
  const accountType = String(account.type || '').toUpperCase();
  const txType = String(row.transaction_type || '').toUpperCase();
  let type = 'expense';

  if (accountType === 'CREDIT') {
    type = signedAmount > 0 ? 'card' : 'card_payment';
  } else if (pluggyInternalTransferIds.has(row.pluggy_transaction_id)) {
    type = 'transfer';
  } else if (pluggyNeutralBankIds.has(row.pluggy_transaction_id)) {
    type = 'card_payment';
  } else {
    type = txType === 'CREDIT' ? 'income' : 'expense';
  }

  const date = pluggyDateLocal(row.transaction_date);
  const dueDate = simpleDate(row.bill_forecast_date) || date;
  const status = String(row.status || '').toUpperCase() === 'POSTED' ? 'confirmed' : 'pending';
  const defaultCategory = type === 'transfer' ? 'Transferência interna' : (type === 'card_payment' ? 'Transferência' : 'Sem categoria');

  return {
    id: `pluggy:${row.pluggy_transaction_id}`,
    pluggyId: row.pluggy_transaction_id,
    description: row.description || row.description_raw || 'Movimentação Open Finance',
    amount,
    type,
    date,
    dueDate,
    paidDate: '',
    accountId: accountType === 'BANK' ? `pluggy-account:${row.pluggy_account_id}` : '',
    destinationAccountId: '',
    cardId: accountType === 'CREDIT' ? `pluggy-card:${row.pluggy_account_id}` : '',
    category: row.category || defaultCategory,
    subcategory: '',
    member: '',
    tags: [],
    status,
    paymentMethod: 'Open Finance',
    installmentCurrent: row.installment_number || 1,
    installmentTotal: row.total_installments || 1,
    notes: '',
    origin: 'openfinance',
    sourceLabel: account.name || account.institution_name || 'Open Finance',
    readOnly: true,
    internalTransfer: type === 'transfer'
  };
}

function openFinanceTransactions() {
  return pluggyTransactions.map(normalizePluggyTransaction).filter(Boolean);
}

function investmentTypeLabel(type) {
  const key = String(type || '').toUpperCase();
  return {
    FIXED_INCOME: 'Renda fixa',
    MUTUAL_FUND: 'Fundo de investimento',
    EQUITY: 'Ações',
    ETF: 'ETF',
    SECURITY: 'Título',
    COE: 'COE',
    PENSION: 'Previdência',
    CRYPTO: 'Criptoativo'
  }[key] || String(type || '').replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase()) || 'Investimento';
}

function investmentStatusLabel(status) {
  const key = String(status || '').toUpperCase();
  if (key === 'ACTIVE') return { label: 'Ativo', tone: 'confirmed' };
  if (key === 'TOTAL_WITHDRAWAL') return { label: 'Resgatado', tone: 'ignored' };
  if (key === 'MATURED') return { label: 'Vencido', tone: 'ignored' };
  if (key === 'INACTIVE') return { label: 'Inativo', tone: 'ignored' };
  return { label: key ? key.replaceAll('_', ' ') : 'Investimento', tone: 'ignored' };
}

function institutionForItem(itemId) {
  const institutions = [...new Set(pluggyAccounts
    .filter(account => account.pluggy_item_id === itemId)
    .map(account => account.institution_name)
    .filter(Boolean))];
  if (institutions.length === 1) return institutions[0];
  if (institutions.length > 1) return institutions.join(' / ');
  return pluggyItems.find(item => item.item_id === itemId)?.connector_name || 'MeuPluggy';
}

function totalInvestmentBalance() {
  return pluggyInvestments.reduce((sum, investment) => sum + num(investment.balance), 0);
}

function allTransactions() {
  return [...state.transactions, ...openFinanceTransactions()];
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
  return allTransactions().filter(tx => {
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
  const manualAccounts = state.accounts.reduce((sum, account) => sum + accountBalance(account.id), 0);
  const manualCards = state.cards.reduce((sum, card) => sum + cardInvoice(card.id), 0);
  const bankBalances = pluggyAccounts.filter(account => String(account.type).toUpperCase() === 'BANK').reduce((sum, account) => sum + num(account.balance), 0);
  const creditBalances = pluggyAccounts.filter(account => String(account.type).toUpperCase() === 'CREDIT').reduce((sum, account) => sum + Math.max(0, num(account.balance)), 0);
  const investmentBalances = totalInvestmentBalance();
  return manualAccounts + bankBalances + investmentBalances - manualCards - creditBalances;
}

function nameById(collection, id, fallback = '—') {
  return collection.find(item => item.id === id)?.name || fallback;
}

function typeLabel(type) {
  return { income: 'Ganho', expense: 'Gasto', transfer: 'Transferência', card: 'Cartão', card_payment: 'Pagamento do cartão' }[type] || type;
}

function typeIcon(type) {
  return { income: '↓', expense: '↑', transfer: '⇄', card: '▰', card_payment: '✓' }[type] || '•';
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
        <div class="top-actions">${monthControl}${extraAction}<button class="icon-button" data-action="sync-now" data-sync-indicator aria-label="Atualizar todos os dados">${syncStatusInfo().icon}</button><button class="icon-button" data-page="settings" aria-label="Configurações">⚙</button></div>
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

function openCashFlowDetails(kind) {
  const cash = monthCashFlowBreakdown();
  const config = {
    income: { title: 'Entradas no caixa', rows: cash.rows.filter(tx => tx.type === 'income'), total: cash.income },
    direct: { title: 'Gastos pagos diretamente pela conta', rows: cash.rows.filter(tx => tx.type === 'expense'), total: cash.directExpenses },
    cards: { title: 'Faturas liquidadas', rows: cash.rows.filter(tx => tx.type === 'card_payment'), total: cash.cardPayments }
  }[kind];
  if (!config) return;
  const rows = [...config.rows].sort((a, b) => (cashFlowDate(b) || '').localeCompare(cashFlowDate(a) || ''));
  const body = `
    <div class="cash-detail-summary"><span>${rows.length} movimentações</span><strong>${money.format(config.total)}</strong></div>
    <div class="category-detail-list">${rows.length ? rows.map(tx => renderTransactionRow(tx)).join('') : empty('Nenhuma movimentação encontrada.')}</div>`;
  openInfoModal(`${config.title} · ${formatMonthShort(ui.month)}`, body);
}

function renderDashboard() {
  const totals = monthTotals();
  const previous = monthTotals(shiftMonth(ui.month, -1));
  const categories = categoryTotals().slice(0, 6);
  const maxCategory = Math.max(1, ...categories.map(item => item.total));
  const budgets = state.budgets.filter(item => item.month === ui.month).slice(0, 4);
  const recent = monthTransactions().sort((a, b) => (transactionViewDate(b) || '').localeCompare(transactionViewDate(a) || '')).slice(0, 6);
  const pending = monthTransactions().filter(tx => tx.status === 'pending' && ['income','expense','card'].includes(tx.type)).reduce((sum, tx) => sum + num(tx.amount), 0);
  const resultChange = previous.result ? ((totals.result - previous.result) / Math.abs(previous.result)) * 100 : 0;
  const gettingStarted = state.accounts.length === 0 && state.transactions.length === 0 && pluggyAccounts.length === 0 && pluggyInvestments.length === 0 ? `
    <article class="card getting-started" style="margin-bottom:16px">
      <div class="card-header"><div><h2 class="card-title">Comece por aqui</h2><p class="card-note">Cadastre contas manualmente ou conecte seu banco pelo Open Finance.</p></div></div>
      <div class="toolbar"><button class="button primary" data-action="connect-bank">🏦 Conectar banco</button><button class="button" data-action="add-account">+ Conta manual</button></div>
    </article>` : '';

  const content = `
    ${gettingStarted}
    <section class="grid kpis">
      ${kpi('Patrimônio líquido', money.format(totalNetWorth()), `${state.accounts.length + pluggyAccounts.filter(a => String(a.type).toUpperCase() === 'BANK').length} contas, ${state.cards.length + pluggyAccounts.filter(a => String(a.type).toUpperCase() === 'CREDIT').length} cartões e ${pluggyInvestments.length} investimentos`, totalNetWorth() >= 0 ? 'positive' : 'negative')}
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
  const rows = allTransactions()
    .filter(tx => isInMonth(transactionViewDate(tx)))
    .filter(tx => ui.transactionType === 'all' || tx.type === ui.transactionType)
    .filter(tx => ui.transactionStatus === 'all' || tx.status === ui.transactionStatus)
    .filter(tx => !search || [tx.description, tx.category, tx.subcategory, tx.member, ...(tx.tags || [])].join(' ').toLowerCase().includes(search))
    .sort((a, b) => (transactionViewDate(b) || '').localeCompare(transactionViewDate(a) || ''));

  const content = `
    <article class="card transactions-card">
      <div class="toolbar transaction-toolbar">
        <input class="input search" id="transaction-search" placeholder="Buscar descrição, categoria, membro ou tag" value="${esc(ui.transactionSearch)}">
        <select class="select filter-select" id="transaction-type-filter">
          ${selectOptions([['all','Todos os tipos'],['income','Ganhos'],['expense','Gastos'],['card','Cartão'],['card_payment','Pagamento cartão'],['transfer','Transferências']], ui.transactionType)}
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
  const isNeutral = tx.type === 'transfer' || tx.type === 'card_payment';
  const date = transactionViewDate(tx);
  const source = tx.origin === 'openfinance'
    ? (tx.sourceLabel || 'Open Finance')
    : (tx.type === 'card' ? nameById(state.cards, tx.cardId, 'Cartão') : nameById(state.accounts, tx.accountId, 'Sem conta'));
  const installment = num(tx.installmentTotal) > 1 ? ` · ${tx.installmentCurrent}/${tx.installmentTotal}` : '';
  const origin = tx.origin === 'openfinance' ? ' · Open Finance' : ' · Manual';
  const subtitle = `${typeLabel(tx.type)} · ${esc(tx.category || 'Sem categoria')} · ${esc(source)}${installment}${origin}`;
  const valueClass = tx.type === 'card_payment' ? 'positive' : isNeutral ? '' : isPositive ? 'positive' : 'negative';
  const sign = isPositive ? '+' : tx.type === 'card_payment' ? '−' : isNeutral ? '' : '−';
  const canEdit = actions && !tx.readOnly && tx.origin !== 'openfinance';
  return `<div class="list-row transaction-row">
    <div class="row-main transaction-main"><div class="avatar">${typeIcon(tx.type)}</div><div class="row-content"><div class="row-title">${esc(tx.description)}</div><div class="row-subtitle">${subtitle} · ${date ? shortDate.format(parseDate(date)) : 'Sem data'}</div></div></div>
    <div class="row-actions transaction-actions"><div class="row-summary"><div class="row-value ${valueClass}">${sign}${money.format(tx.amount)}</div><span class="chip ${tx.status}">${tx.status === 'confirmed' ? 'Confirmada' : tx.status === 'pending' ? 'Pendente' : 'Ignorada'}</span></div>${canEdit ? `<button class="icon-button" data-action="edit-transaction" data-id="${tx.id}" aria-label="Editar">✎</button><button class="icon-button" data-action="delete-transaction" data-id="${tx.id}" aria-label="Excluir">×</button>` : ''}</div>
  </div>`;
}

function pluggyStatusLabel(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'SUCCESS' || value === 'PARTIAL_SUCCESS' || value === 'UPDATED') return { label: 'Conectado', tone: 'confirmed' };
  if (value.includes('WAITING') || value.includes('PENDING')) return { label: 'Aguardando', tone: 'pending' };
  if (value.includes('ERROR') || value.includes('FAILED')) return { label: 'Atenção', tone: 'ignored' };
  return { label: value ? value.replaceAll('_', ' ') : 'Conectado', tone: 'confirmed' };
}

function renderPluggyConnections() {
  if (pluggyItemsLoading) return `<div class="open-finance-empty"><span class="spinner-dot"></span> Carregando conexões bancárias…</div>`;
  if (!pluggyItems.length) return `<div class="open-finance-empty">Nenhum banco conectado ainda. Use <strong>Conectar banco</strong> para iniciar o Open Finance.</div>`;
  return `<div class="pluggy-list">${pluggyItems.map(item => {
    const remote = pluggyRemoteStatus.get(item.item_id) || null;
    const status = pluggyStatusLabel(remote?.status || item.status);
    const appUpdated = item.last_sync_at ? shortDateTime.format(new Date(item.last_sync_at)) : '';
    const bankUpdated = remote?.lastUpdatedAt ? shortDateTime.format(new Date(remote.lastUpdatedAt)) : '';
    const inferredInstitution = institutionForItem(item.item_id);
    const displayName = inferredInstitution && inferredInstitution !== 'MeuPluggy' ? inferredInstitution : (item.connector_name || 'Instituição conectada');
    const syncDetail = bankUpdated
      ? `Última coleta bancária: ${esc(bankUpdated)}`
      : (appUpdated ? `Última importação no app: ${esc(appUpdated)}` : 'Aguardando primeira sincronização');
    return `<div class="pluggy-row"><div class="row-main"><div class="bank-avatar">🏦</div><div><div class="row-title">${esc(displayName)}</div><div class="row-subtitle">MeuPluggy · ID ${esc(String(item.item_id || '').slice(0, 8))}</div><div class="bank-sync-meta">${syncDetail}</div></div></div><span class="chip ${status.tone}">${esc(status.label)}</span></div>`;
  }).join('')}</div>`;
}

function accountSubtypeLabel(value) {
  const key = String(value || '').toUpperCase();
  return {
    CHECKING_ACCOUNT: 'Conta-corrente',
    SAVINGS_ACCOUNT: 'Poupança',
    CREDIT_CARD: 'Cartão de crédito'
  }[key] || String(value || '').replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase()) || 'Conta bancária';
}

function renderPatrimony() {
  const manualAccountCards = state.accounts.map(account => `<article class="card account-card"><div class="card-header"><div><h2 class="card-title">${esc(account.name)}</h2><p class="card-note">${esc(account.type)}${account.institution ? ` · ${esc(account.institution)}` : ''} · Manual</p></div><div class="row-actions"><button class="icon-button" data-action="edit-account" data-id="${account.id}" aria-label="Editar">✎</button><button class="icon-button" data-action="delete-account" data-id="${account.id}" aria-label="Excluir">×</button></div></div><div class="account-balance ${accountBalance(account.id) >= 0 ? 'positive' : 'negative'}">${money.format(accountBalance(account.id))}</div><div class="card-note">Saldo inicial: ${money.format(account.initialBalance)}</div></article>`).join('');

  const manualCardCards = state.cards.map(card => {
    const invoice = cardInvoice(card.id);
    const available = card.limit - invoice;
    return `<article class="card credit-card"><div class="card-header"><div><div class="card-brand">${esc(card.brand || 'Cartão')} · Manual</div><h2 class="card-title">${esc(card.name)}</h2></div><div class="row-actions"><button class="icon-button" data-action="edit-card" data-id="${card.id}" aria-label="Editar">✎</button><button class="icon-button" data-action="delete-card" data-id="${card.id}" aria-label="Excluir">×</button></div></div><div class="card-limit">${money.format(invoice)}</div><div class="card-note">Fatura de ${esc(formatMonthShort(ui.month))}</div><div class="progress-row" style="margin-top:16px"><div class="progress-meta"><span>Limite disponível</span><strong class="${available < 0 ? 'negative' : ''}">${money.format(available)}</strong></div><div class="progress ${invoice > card.limit ? 'danger' : invoice / card.limit >= .8 ? 'warning' : ''}"><span style="width:${clamp((invoice / card.limit) * 100, 0, 100)}%"></span></div><div class="card-note">Fecha dia ${card.closingDay} · vence dia ${card.dueDay} · paga por ${esc(nameById(state.accounts, card.linkedAccountId))}</div></div></article>`;
  }).join('');

  const openBankCards = pluggyAccounts.filter(account => String(account.type).toUpperCase() === 'BANK').map(account => `<article class="card account-card open-finance-account"><div class="card-header"><div><div class="card-brand">OPEN FINANCE</div><h2 class="card-title">${esc(account.name)}</h2><p class="card-note">${esc(accountSubtypeLabel(account.subtype))} · ${esc(account.institution_name || 'MeuPluggy')}</p></div><span class="chip confirmed">Automática</span></div><div class="account-balance ${num(account.balance) >= 0 ? 'positive' : 'negative'}">${money.format(num(account.balance))}</div><div class="card-note">Saldo informado pela instituição</div></article>`).join('');

  const openCreditCards = pluggyAccounts.filter(account => String(account.type).toUpperCase() === 'CREDIT').map(account => {
    const balance = Math.max(0, num(account.balance));
    const available = account.available_credit_limit == null ? null : num(account.available_credit_limit);
    const totalLimit = available == null ? null : Math.max(0, available + balance);
    const percent = totalLimit ? (balance / totalLimit) * 100 : 0;
    const closeDate = simpleDate(account.balance_close_date);
    const dueDate = simpleDate(account.balance_due_date);
    return `<article class="card credit-card open-finance-account"><div class="card-header"><div><div class="card-brand">OPEN FINANCE · CRÉDITO</div><h2 class="card-title">${esc(account.name)}</h2><p class="card-note">${esc(account.institution_name || 'MeuPluggy')}</p></div><span class="chip confirmed">Automático</span></div><div class="card-limit">${money.format(balance)}</div><div class="card-note">Saldo/fatura em aberto</div>${available != null ? `<div class="progress-row" style="margin-top:16px"><div class="progress-meta"><span>Limite disponível</span><strong>${money.format(available)}</strong></div>${totalLimit ? `<div class="progress ${percent >= 100 ? 'danger' : percent >= 80 ? 'warning' : ''}"><span style="width:${clamp(percent, 0, 100)}%"></span></div><div class="card-note">Limite estimado: ${money.format(totalLimit)}</div>` : ''}</div>` : ''}${closeDate || dueDate ? `<div class="card-note" style="margin-top:10px">${closeDate ? `Fecha ${shortDate.format(parseDate(closeDate))}` : ''}${closeDate && dueDate ? ' · ' : ''}${dueDate ? `Vence ${shortDate.format(parseDate(dueDate))}` : ''}</div>` : ''}</article>`;
  }).join('');

  const openInvestmentCards = pluggyInvestments.map(investment => {
    const balance = num(investment.balance);
    const original = investment.amount_original == null ? null : num(investment.amount_original);
    const withdrawal = investment.amount_withdrawal == null ? null : num(investment.amount_withdrawal);
    const status = investmentStatusLabel(investment.status);
    const dueDate = simpleDate(investment.due_date);
    const type = investmentTypeLabel(investment.type);
    const subtype = investment.subtype ? String(investment.subtype).replaceAll('_', ' ') : '';
    const institution = institutionForItem(investment.pluggy_item_id);
    return `<article class="card investment-card open-finance-account">
      <div class="card-header"><div><div class="card-brand">OPEN FINANCE · ${esc(type.toUpperCase())}</div><h2 class="card-title">${esc(investment.name || subtype || 'Investimento')}</h2><p class="card-note">${esc(institution)}${subtype ? ` · ${esc(subtype)}` : ''}</p></div><span class="chip ${status.tone}">${esc(status.label)}</span></div>
      <div class="investment-balance ${balance >= 0 ? 'positive' : 'negative'}">${money.format(balance)}</div>
      <div class="card-note">Saldo atual informado pela instituição</div>
      <div class="investment-details">
        ${original != null ? `<div><span>Valor aplicado</span><strong>${money.format(original)}</strong></div>` : ''}
        ${withdrawal != null ? `<div><span>Disponível para resgate</span><strong>${money.format(withdrawal)}</strong></div>` : ''}
        ${investment.issuer ? `<div><span>Emissor</span><strong>${esc(investment.issuer)}</strong></div>` : ''}
        ${dueDate ? `<div><span>Vencimento</span><strong>${shortDate.format(parseDate(dueDate))}</strong></div>` : ''}
      </div>
    </article>`;
  }).join('');

  const financeSummary = pluggyDataLoading
    ? `<div class="open-finance-empty"><span class="spinner-dot"></span> Atualizando dados financeiros…</div>`
    : (pluggyAccounts.length || pluggyInvestments.length)
      ? `<div class="open-finance-summary"><span><strong>${pluggyAccounts.filter(a => String(a.type).toUpperCase() === 'BANK').length}</strong> contas</span><span><strong>${pluggyAccounts.filter(a => String(a.type).toUpperCase() === 'CREDIT').length}</strong> cartões</span><span><strong>${pluggyInvestments.length}</strong> investimentos · ${money.format(totalInvestmentBalance())}</span><span><strong>${pluggyTransactions.length}</strong> movimentações armazenadas</span></div>`
      : '';

  const content = `
    <section class="card open-finance-card">
      <div class="card-header open-finance-header"><div><div class="open-finance-kicker">OPEN FINANCE · PLUGGY</div><h2 class="card-title">Bancos conectados</h2><p class="card-note">Atualizar dados sincroniza a nuvem e, em seguida, verifica uma nova coleta Open Finance antes de importar contas, cartões, transações e investimentos.</p></div><div class="open-finance-actions"><button class="button" data-action="refresh-open-finance">↻ Atualizar dados</button><button class="button primary" data-action="connect-bank">🏦 Conectar banco</button></div></div>
      ${renderPluggyConnections()}
      ${financeSummary}
    </section>

    <section style="margin-top:26px">
      <div class="card-header"><div><h2 class="card-title">Contas Open Finance</h2><p class="card-note">Saldos atuais informados pelas instituições conectadas.</p></div></div>
      <div class="grid three">${openBankCards || empty(pluggyDataLoading ? 'Carregando contas…' : 'Nenhuma conta bancária importada.')}</div>
    </section>

    <section style="margin-top:26px">
      <div class="card-header"><div><h2 class="card-title">Cartões Open Finance</h2><p class="card-note">Saldo em aberto e limite disponível quando fornecido pelo banco.</p></div></div>
      <div class="grid three">${openCreditCards || empty(pluggyDataLoading ? 'Carregando cartões…' : 'Nenhum cartão importado.')}</div>
    </section>

    <section style="margin-top:26px">
      <div class="card-header investment-section-header"><div><h2 class="card-title">Investimentos Open Finance</h2><p class="card-note">Posição atual dos ativos informada pelas instituições conectadas.</p></div>${pluggyInvestments.length ? `<div class="investment-summary"><span>Patrimônio investido</span><strong>${money.format(totalInvestmentBalance())}</strong></div>` : ''}</div>
      <div class="grid three">${openInvestmentCards || empty(pluggyDataLoading ? 'Carregando investimentos…' : 'Nenhum investimento importado.')}</div>
    </section>

    <section style="margin-top:26px">
      <div class="card-header"><div><h2 class="card-title">Contas manuais</h2><p class="card-note">Use somente para contas que não estão conectadas ao Open Finance.</p></div><button class="button primary" data-action="add-account">+ Conta</button></div>
      <div class="grid three">${manualAccountCards || empty('Nenhuma conta manual cadastrada.')}</div>
    </section>

    <section style="margin-top:26px">
      <div class="card-header"><div><h2 class="card-title">Cartões manuais</h2><p class="card-note">Use somente para cartões que não estão conectados ao Open Finance.</p></div><button class="button primary" data-action="add-card">+ Cartão</button></div>
      <div class="grid three">${manualCardCards || empty('Nenhum cartão manual cadastrado.')}</div>
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
  const range = reportRangeBounds();
  const periodLabel = reportRangeLabel(range);
  const categories = periodCategoryTotals(range);
  const totals = periodTotals(range);
  const maxCategory = Math.max(1, ...categories.map(item => item.total));
  const results = periodMonthlyResults(range);
  const maxFlow = Math.max(1, ...results.flatMap(item => [item.income, item.expense]));
  const reportTransactions = periodTransactions(range, true);
  const ignored = allTransactions().filter(tx => {
    const key = dateKey(transactionViewDate(tx));
    return tx.status === 'ignored' && key && key >= range.start && key <= range.end;
  }).length;
  const pending = reportTransactions.filter(tx => tx.status === 'pending').length;
  const uncategorized = reportTransactions.filter(tx => !tx.category || tx.category === 'Sem categoria').length;
  const internalTransfers = reportTransactions.filter(tx => tx.type === 'transfer' || tx.type === 'card_payment').length;

  const presets = [
    ['1m', '1 mês'],
    ['3m', '3 meses'],
    ['6m', '6 meses'],
    ['12m', '12 meses'],
    ['all', 'Todo histórico'],
    ['custom', 'Personalizado']
  ];

  const customRange = ui.reportRange === 'custom' ? `
    <div class="report-custom-range">
      <div class="field"><label>Data inicial</label><input class="input" id="report-start" type="date" value="${esc(range.start)}"></div>
      <div class="field"><label>Data final</label><input class="input" id="report-end" type="date" value="${esc(range.end)}"></div>
    </div>` : '';

  const content = `
    <article class="card report-period-card">
      <div class="card-header"><div><h2 class="card-title">Período do relatório</h2><p class="card-note">Escolha um intervalo maior ou defina datas específicas. Transferências entre suas próprias contas e pagamentos de cartão ficam fora das entradas e saídas.</p></div><span class="chip confirmed report-period-label">${esc(periodLabel)}</span></div>
      <div class="report-period-presets">${presets.map(([value, label]) => `<button class="button small report-period-button ${ui.reportRange === value ? 'primary active' : ''}" data-action="report-period" data-period="${value}">${label}</button>`).join('')}</div>
      ${customRange}
    </article>

    <section class="grid kpis report-kpis" style="margin-top:16px">
      <article class="card"><div class="kpi-label">Entradas confirmadas</div><div class="kpi-value positive">${money.format(totals.income)}</div><div class="kpi-meta">${esc(periodLabel)}</div></article>
      <article class="card"><div class="kpi-label">Saídas confirmadas</div><div class="kpi-value negative">${money.format(totals.expense)}</div><div class="kpi-meta">${esc(periodLabel)}</div></article>
      <article class="card"><div class="kpi-label">Resultado</div><div class="kpi-value ${totals.result >= 0 ? 'positive' : 'negative'}">${money.format(totals.result)}</div><div class="kpi-meta">Entradas menos saídas</div></article>
      <article class="card"><div class="kpi-label">Movimentações</div><div class="kpi-value">${reportTransactions.length}</div><div class="kpi-meta">${totals.count} confirmadas</div></article>
    </section>

    <section class="grid two" style="margin-top:16px">
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Distribuição dos gastos</h2><p class="card-note">Por categoria no período selecionado</p></div></div>
        ${categories.length ? `<div class="chart">${categories.map(item => `<div class="chart-row"><div class="chart-label">${esc(item.category)}</div><div class="chart-track"><div class="chart-bar" style="width:${(item.total / maxCategory) * 100}%"></div></div><div class="chart-value">${money.format(item.total)}</div></div>`).join('')}</div>` : empty('Sem gastos confirmados para analisar neste período.')}
      </article>
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Qualidade dos dados</h2><p class="card-note">Itens do período que merecem revisão</p></div></div>
        <div class="stack">
          <div class="list-row"><span>Transações pendentes</span><strong class="${pending ? 'warning' : 'positive'}">${pending}</strong></div>
          <div class="list-row"><span>Transações ignoradas</span><strong>${ignored}</strong></div>
          <div class="list-row"><span>Sem categoria</span><strong class="${uncategorized ? 'warning' : 'positive'}">${uncategorized}</strong></div>
          <div class="list-row"><span>Transferências internas fora do fluxo</span><strong>${internalTransfers}</strong></div>
          <div class="list-row"><span>Registros no período</span><strong>${reportTransactions.length}</strong></div>
        </div>
      </article>
    </section>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Entradas e saídas</h2><p class="card-note">Evolução mensal · ${esc(periodLabel)}</p></div></div>
      <div class="chart report-flow-chart">${results.map(item => `<div class="chart-row"><div class="chart-label">${esc(formatMonthShort(item.key))}</div><div><div class="chart-track" title="Ganhos"><div class="chart-bar" style="width:${(item.income / maxFlow) * 100}%"></div></div><div class="chart-track" title="Gastos" style="margin-top:5px"><div class="chart-bar" style="width:${(item.expense / maxFlow) * 100}%;background:var(--negative)"></div></div></div><div class="chart-value ${item.result >= 0 ? 'positive' : 'warning'}">${item.result >= 0 ? '+' : '−'}${money.format(Math.abs(item.result))}</div></div>`).join('')}</div>
    </article>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Exportação</h2><p class="card-note">Exporte somente o período selecionado ou gere uma cópia completa.</p></div></div>
      <div class="toolbar"><button class="button primary" data-action="export-report-csv">Exportar período em CSV</button><button class="button" data-action="export-csv">Exportar tudo em CSV</button><button class="button" data-action="backup-json">Baixar cópia JSON</button></div>
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
      <div class="toolbar settings-actions" style="margin-top:14px"><button class="button primary" data-action="sync-now">Atualizar tudo</button><button class="button" data-action="force-pull">Recarregar da nuvem</button><button class="button" data-action="logout">Sair deste dispositivo</button></div>
    </article>

    <article class="card" style="margin-top:16px">
      <div class="setting-row"><div><div class="setting-title">Tema escuro</div><div class="setting-note">Adapta a interface para ambientes com pouca luz.</div></div><label class="switch"><input type="checkbox" id="dark-mode" ${state.preferences.darkMode ? 'checked' : ''}><span></span></label></div>
      <div class="setting-row"><div><div class="setting-title">Visão por caixa</div><div class="setting-note">Quando ativada, usa pagamento, recebimento ou vencimento; desativada, usa a data original da transação (competência).</div></div><label class="switch"><input type="checkbox" id="cash-basis" ${state.preferences.basis === 'cash' ? 'checked' : ''}><span></span></label></div>
      <div class="setting-row setting-row-name"><div><div class="setting-title">Nome do aplicativo</div><div class="setting-note">Personalize o título exibido na barra lateral.</div></div><div class="setting-name-control"><input class="input" id="app-name" value="${esc(state.preferences.name || '')}" maxlength="40"></div></div>
    </article>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Backup e exportação</h2><p class="card-note">A nuvem sincroniza automaticamente, mas você ainda pode gerar uma cópia independente.</p></div></div>
      <div class="toolbar settings-actions"><button class="button primary" data-action="backup-json">Baixar cópia JSON</button><button class="button" data-action="restore-json">Restaurar cópia</button><button class="button" data-action="export-csv">Exportar CSV</button><button class="button danger" data-action="reset-data">Apagar dados manuais</button></div>
    </article>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Privacidade e funcionamento</h2><p class="card-note">Dados manuais e Open Finance protegidos pelo login e pelas regras RLS.</p></div></div>
      <div class="stack">
        <div class="list-row"><div><div class="row-title">Lançamentos</div><div class="row-subtitle">Movimentações podem ser manuais ou importadas pela Pluggy/Open Finance.</div></div><span class="chip confirmed">Manual + Open Finance</span></div>
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

let unifiedSyncRunning = false;

async function manualSync() {
  if (unifiedSyncRunning) {
    showToast('A atualização já está em andamento.', { tone: 'info', duration: 2200 });
    return;
  }

  const toast = showToast('Atualizando seus dados…', { tone: 'info', duration: 0 });

  if (!navigator.onLine) {
    syncMeta.status = 'offline';
    syncMeta.pending = true;
    syncMeta.message = 'Sem internet. As alterações permanecem salvas neste dispositivo.';
    saveSyncMeta();
    updateSyncIndicator();
    finishToast(toast, 'Sem internet — dados salvos neste dispositivo.', 'warning');
    return;
  }

  unifiedSyncRunning = true;
  try {
    updateToastText(toast, 'Sincronizando preferências e dados locais com a nuvem…', 'info');
    if (syncMeta.pending) await pushStateToCloud();
    else await pullStateFromCloud({ force: true, quiet: true });

    const cloudConflict = syncMeta.status === 'conflict';
    const cloudError = !['synced', 'conflict'].includes(syncMeta.status);

    updateToastText(toast, 'Atualizando bancos, cartões, transações e investimentos…', 'info');
    const openFinanceResult = await refreshOpenFinance({ quiet: true });

    if (ui.page === 'intelligence' || ui.page === 'patrimony') render();

    if (openFinanceResult?.requiresMeuPluggy) {
      finishToast(toast, cloudConflict
        ? 'Open Finance verificado. Há também um conflito de sincronização na nuvem.'
        : 'Nuvem sincronizada. Para uma nova coleta bancária, atualize no MeuPluggy.', 'warning', 5200);
      openMeuPluggyRefreshDialog(openFinanceResult.refreshData || {});
      return;
    }

    if (!openFinanceResult?.success) {
      finishToast(toast, cloudConflict
        ? 'Há um conflito na nuvem e o Open Finance não pôde ser atualizado.'
        : 'A nuvem foi verificada, mas não foi possível atualizar o Open Finance.', 'error', 5200);
      return;
    }

    if (cloudConflict) {
      finishToast(toast, 'Open Finance atualizado. Existe um conflito na nuvem para revisar em Configurações.', 'warning', 5200);
    } else if (cloudError) {
      finishToast(toast, 'Open Finance atualizado, mas a sincronização da nuvem precisa de atenção.', 'warning', 5200);
    } else {
      finishToast(toast, 'Tudo atualizado: nuvem, bancos, cartões, transações e investimentos.', 'success', 4200);
    }
  } catch (error) {
    console.error('Falha na atualização unificada:', error);
    finishToast(toast, 'Erro ao atualizar os dados. Tente novamente.', 'error', 4200);
  } finally {
    unifiedSyncRunning = false;
    updateSyncIndicator();
  }
}

async function loadPluggyItems({ quiet = false } = {}) {
  if (!authSession?.user?.id || !supabaseClient) return;
  pluggyItemsLoading = true;
  if (ui.page === 'patrimony') render();
  try {
    const { data, error } = await supabaseClient
      .from(PLUGGY_ITEMS_TABLE)
      .select('item_id,connector_name,status,last_sync_at,created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    pluggyItems = Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Falha ao carregar conexões Pluggy:', error?.message || error);
    if (!quiet) showToast('Não foi possível carregar as conexões bancárias.', { tone: 'error' });
  } finally {
    pluggyItemsLoading = false;
    if (ui.page === 'patrimony') render();
  }
}

async function loadOpenFinanceData({ quiet = false } = {}) {
  if (!authSession?.user?.id || !supabaseClient) return;
  pluggyDataLoading = true;
  if (ui.page === 'patrimony') render();
  try {
    const userId = authSession.user.id;
    const { data: accounts, error: accountsError } = await supabaseClient
      .from(PLUGGY_ACCOUNTS_TABLE)
      .select('pluggy_account_id,pluggy_item_id,institution_name,name,type,subtype,balance,currency_code,available_credit_limit,balance_close_date,balance_due_date,synced_at')
      .eq('user_id', userId)
      .order('name', { ascending: true });
    if (accountsError) throw accountsError;

    const transactions = [];
    const pageSize = 1000;
    for (let from = 0; from < 10000; from += pageSize) {
      const { data: page, error: pageError } = await supabaseClient
        .from(PLUGGY_TRANSACTIONS_TABLE)
        .select('pluggy_transaction_id,pluggy_account_id,transaction_date,description,description_raw,amount,transaction_type,status,category,provider_id,operation_type,installment_number,total_installments,total_amount,bill_id,bill_forecast_date,synced_at')
        .eq('user_id', userId)
        .order('transaction_date', { ascending: false })
        .range(from, from + pageSize - 1);
      if (pageError) throw pageError;
      transactions.push(...(page || []));
      if (!page || page.length < pageSize) break;
    }

    const { data: investments, error: investmentsError } = await supabaseClient
      .from(PLUGGY_INVESTMENTS_TABLE)
      .select('pluggy_investment_id,pluggy_item_id,name,type,subtype,code,provider_id,currency_code,balance,amount,amount_original,amount_withdrawal,amount_profit,taxes,taxes2,quantity,unit_value,rate,rate_type,fixed_annual_rate,last_month_rate,last_twelve_months_rate,annual_rate,reference_date,due_date,issue_date,issuer,status,synced_at')
      .eq('user_id', userId)
      .order('balance', { ascending: false });
    if (investmentsError) throw investmentsError;

    pluggyAccounts = Array.isArray(accounts) ? accounts : [];
    pluggyTransactions = transactions;
    pluggyInvestments = Array.isArray(investments) ? investments : [];
    rebuildOpenFinanceIndexes();
  } catch (error) {
    console.error('Falha ao carregar dados Open Finance:', error?.message || error);
    if (!quiet) showToast('Não foi possível carregar os dados do Open Finance.', { tone: 'error' });
  } finally {
    pluggyDataLoading = false;
    render();
  }
}


function setPluggyRemoteStatus(items = []) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item?.itemId) continue;
    pluggyRemoteStatus.set(item.itemId, item);
  }
}

async function loadPluggyRemoteStatus({ quiet = true } = {}) {
  if (!authSession?.user?.id || !navigator.onLine || !supabaseClient || !pluggyItems.length) return null;
  try {
    const { data, error } = await supabaseClient.functions.invoke('pluggy-refresh-items', {
      body: { action: 'status' }
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    setPluggyRemoteStatus(data?.items || []);
    if (ui.page === 'patrimony') render();
    return data;
  } catch (error) {
    console.error('Falha ao consultar o estado bancário na Pluggy:', error?.message || error);
    if (!quiet) showToast('Não foi possível consultar a data da última coleta bancária.', { tone: 'warning' });
    return null;
  }
}

function updateToastText(node, message, tone = 'info') {
  if (!node?.isConnected) return null;
  node.className = `toast toast-${tone}`;
  node.textContent = message;
  return node;
}

function openMeuPluggyRefreshDialog(refreshData = {}) {
  const items = Array.isArray(refreshData?.items) ? refreshData.items : [];
  const rows = items.map(item => {
    const institution = institutionForItem(item.itemId) || item.connector || 'Instituição';
    const last = item.lastUpdatedAt ? shortDateTime.format(new Date(item.lastUpdatedAt)) : 'não informada';
    const reason = item.result === 'meupluggy_manual_only'
      ? 'Atualização manual pelo MeuPluggy'
      : item.result === 'frequency_limited'
        ? 'Aguardar a frequência permitida'
        : 'Atualização direta indisponível';
    return `<div class="refresh-status-row"><div><strong>${esc(institution)}</strong><span>${esc(reason)}</span></div><small>Última coleta bancária: ${esc(last)}</small></div>`;
  }).join('');

  document.getElementById('modal-root').innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal open-finance-refresh-modal" role="dialog" aria-modal="true" aria-label="Atualização bancária">
        <div class="modal-header">
          <h2 class="modal-title">Atualização bancária</h2>
          <button class="icon-button" type="button" data-action="close-modal" aria-label="Fechar">×</button>
        </div>
        <div class="modal-body">
          <div class="open-finance-help">
            <strong>O MeuPluggy não permite que o Meu Financeiro force uma nova coleta bancária pela API.</strong>
            <p>Para buscar transações mais recentes, atualize Santander e Bradesco no MeuPluggy. Quando você voltar para este aplicativo, os dados serão verificados automaticamente.</p>
            <p class="card-note">Mesmo após a atualização, transações de Open Finance regulado podem levar algum tempo para serem disponibilizadas pela instituição.</p>
          </div>
          <div class="refresh-status-list">${rows}</div>
        </div>
        <div class="modal-footer open-finance-refresh-actions">
          <button class="button" type="button" data-action="verify-open-finance-now">Já atualizei · verificar agora</button>
          <button class="button primary" type="button" data-action="open-meupluggy-refresh">Abrir MeuPluggy</button>
        </div>
      </section>
    </div>`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pluggyRefreshFinished(items = []) {
  if (!Array.isArray(items) || !items.length) return true;
  return items.every(item => {
    const status = String(item.status || '').toUpperCase();
    const execution = String(item.executionStatus || '').toUpperCase();
    return !['UPDATING', 'CREATED', 'LOGIN_IN_PROGRESS', 'LOGIN_MFA_IN_PROGRESS', 'WAITING_USER_INPUT'].includes(status)
      && !['CREATED', 'LOGIN_IN_PROGRESS', 'LOGIN_MFA_IN_PROGRESS', 'WAITING_USER_INPUT'].includes(execution);
  });
}

async function waitForPluggyRefresh(toast = null, attempts = 24) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    await sleep(i === 0 ? 1800 : 3000);
    const { data, error } = await supabaseClient.functions.invoke('pluggy-refresh-items', {
      body: { action: 'status' }
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    last = data;
    setPluggyRemoteStatus(data?.items || []);
    if (ui.page === 'patrimony') render();
    if (pluggyRefreshFinished(data?.items || [])) return data;
    updateToastText(toast, `Coleta bancária em andamento… tentativa ${i + 1}/${attempts}`, 'info');
  }
  return last;
}

async function importOpenFinanceOnly({ quiet = false, toast = null, afterExternalRefresh = false } = {}) {
  if (!authSession?.user?.id) return null;

  const beforeIds = new Set(pluggyTransactions.map(tx => tx.pluggy_transaction_id));

  if (!toast && !quiet) {
    toast = showToast(afterExternalRefresh ? 'Verificando novos dados do MeuPluggy…' : 'Importando dados disponíveis da Pluggy…', { tone: 'info', duration: 0 });
  } else if (toast) {
    updateToastText(toast, afterExternalRefresh ? 'Verificando novos dados do MeuPluggy…' : 'Importando dados disponíveis da Pluggy…', 'info');
  }

  try {
    const { data, error } = await supabaseClient.functions.invoke('pluggy-import-data', { body: { days: 365 } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);

    await Promise.all([
      loadOpenFinanceData({ quiet: true }),
      loadPluggyItems({ quiet: true })
    ]);
    await loadPluggyRemoteStatus({ quiet: true });

    const newTransactions = pluggyTransactions.filter(tx => !beforeIds.has(tx.pluggy_transaction_id)).length;
    const totalNow = pluggyTransactions.length;
    const accounts = pluggyAccounts.length;
    const investments = pluggyInvestments.length;

    try { localStorage.removeItem(OPEN_FINANCE_RETURN_KEY); } catch {}

    if (!quiet) {
      if (newTransactions > 0) {
        finishToast(toast, `Atualização concluída: ${newTransactions.toLocaleString('pt-BR')} nova${newTransactions === 1 ? '' : 's'} movimentação${newTransactions === 1 ? '' : 'ões'}. Total: ${totalNow.toLocaleString('pt-BR')}.`, 'success', 5200);
      } else {
        const suffix = afterExternalRefresh
          ? ' Nenhuma nova movimentação foi disponibilizada ainda.'
          : '';
        finishToast(toast, `Dados verificados: ${accounts} contas/cartões, ${investments} investimentos e ${totalNow.toLocaleString('pt-BR')} movimentações.${suffix}`, afterExternalRefresh ? 'warning' : 'success', 5200);
      }
    }

    return {
      success: true,
      newTransactions,
      totalTransactions: totalNow,
      data
    };
  } catch (error) {
    console.error('Falha ao importar dados Open Finance:', error?.message || error);
    if (!quiet) finishToast(toast, 'Não foi possível importar os dados Open Finance agora.', 'error', 4400);
    return { success: false, error };
  }
}

async function refreshOpenFinance({ quiet = false, importOnly = false, afterExternalRefresh = false } = {}) {
  if (!authSession?.user?.id) return showToast('Entre na sua conta antes de atualizar o Open Finance.', { tone: 'warning' });
  if (!navigator.onLine) return showToast('É necessário estar conectado à internet para atualizar o Open Finance.', { tone: 'warning' });

  if (importOnly) {
    return importOpenFinanceOnly({ quiet, afterExternalRefresh });
  }

  const toast = quiet ? null : showToast('Verificando se os bancos permitem uma nova coleta…', { tone: 'info', duration: 0 });

  try {
    const { data: refreshData, error: refreshError } = await supabaseClient.functions.invoke('pluggy-refresh-items', {
      body: { action: 'refresh' }
    });

    if (refreshError) throw refreshError;
    if (refreshData?.error) throw new Error(refreshData.error);

    setPluggyRemoteStatus(refreshData?.items || []);
    if (ui.page === 'patrimony') render();

    const items = Array.isArray(refreshData?.items) ? refreshData.items : [];
    const started = Number(refreshData?.triggered || 0);
    const alreadyUpdating = Number(refreshData?.alreadyUpdating || 0);
    const blocked = Number(refreshData?.blocked || 0);

    if (started > 0 || alreadyUpdating > 0) {
      updateToastText(toast, `Coleta bancária iniciada em ${started + alreadyUpdating} conexão${started + alreadyUpdating === 1 ? '' : 'ões'}…`, 'info');
      await waitForPluggyRefresh(toast);
      return importOpenFinanceOnly({ quiet, toast });
    }

    const requiresMeuPluggy = items.length > 0 && items.every(item =>
      ['meupluggy_manual_only', 'not_allowed', 'frequency_limited', 'rejected'].includes(item.result)
    );

    if (blocked > 0 && requiresMeuPluggy) {
      if (!quiet) {
        finishToast(toast, 'A coleta direta não é permitida para o MeuPluggy. Atualize os bancos no MeuPluggy.', 'warning', 3900);
        openMeuPluggyRefreshDialog(refreshData);
      }
      return { success: false, requiresMeuPluggy: true, refreshData };
    }

    return importOpenFinanceOnly({ quiet, toast });

  } catch (error) {
    console.error('Falha ao atualizar Open Finance:', error?.message || error);
    if (!quiet) finishToast(toast, 'Não foi possível verificar a atualização bancária agora.', 'error', 4400);
    return { success: false, error };
  }
}

async function verifyAfterMeuPluggyReturn({ automatic = false } = {}) {
  if (openFinanceReturnCheckRunning || !authSession?.user?.id || !navigator.onLine) return;
  let pending = false;
  try { pending = Boolean(localStorage.getItem(OPEN_FINANCE_RETURN_KEY)); } catch {}
  if (!pending && automatic) return;

  openFinanceReturnCheckRunning = true;
  try {
    await sleep(automatic ? 1400 : 0);
    await refreshOpenFinance({ importOnly: true, afterExternalRefresh: true });
  } finally {
    openFinanceReturnCheckRunning = false;
  }
}

async function savePluggyItem(item, connectorName = '') {
  const itemId = item?.id;
  if (!itemId || !authSession?.user?.id) throw new Error('A Pluggy não retornou o identificador da conexão.');
  const record = {
    user_id: authSession.user.id,
    item_id: itemId,
    connector_name: connectorName || item?.connector?.name || item?.connectorName || 'Instituição conectada',
    status: item?.executionStatus || item?.status || 'SUCCESS',
    last_sync_at: new Date().toISOString()
  };
  const { error } = await supabaseClient
    .from(PLUGGY_ITEMS_TABLE)
    .upsert(record, { onConflict: 'user_id,item_id' });
  if (error) throw error;
}

async function connectBankWithPluggy() {
  if (!authSession?.user?.id) return showToast('Entre na sua conta antes de conectar um banco.', { tone: 'warning' });
  if (!navigator.onLine) return showToast('É necessário estar conectado à internet para abrir o Open Finance.', { tone: 'warning' });
  if (typeof window.PluggyConnect !== 'function') return showToast('O componente da Pluggy não carregou. Reabra o aplicativo e tente novamente.', { tone: 'error', duration: 4200 });

  const toast = showToast('Preparando conexão segura com a Pluggy…', { tone: 'info', duration: 0 });
  try {
    const { data, error } = await supabaseClient.functions.invoke('pluggy-connect-token', { body: {} });
    if (error) throw error;
    if (!data?.accessToken) throw new Error(data?.error || 'Connect Token não retornado.');

    let selectedConnectorName = '';
    finishToast(toast, 'Abrindo Open Finance…', 'success', 1400);

    const pluggyConnect = new window.PluggyConnect({
      connectToken: data.accessToken,
      includeSandbox: false,
      countries: ['BR'],
      connectorTypes: ['PERSONAL_BANK'],
      language: 'pt',
      theme: state.preferences.darkMode ? 'dark' : 'light',
      forceOauthInBrowser: true,
      onEvent: (payload) => {
        if (payload?.event === 'SELECTED_INSTITUTION' && payload?.connector?.name) selectedConnectorName = payload.connector.name;
      },
      onSuccess: async ({ item }) => {
        const doneToast = showToast('Banco conectado. Salvando a conexão…', { tone: 'info', duration: 0 });
        try {
          await savePluggyItem(item, selectedConnectorName);
          await loadPluggyItems({ quiet: true });
          await refreshOpenFinance({ quiet: true });
          finishToast(doneToast, 'Banco conectado e dados financeiros atualizados.', 'success', 3600);
        } catch (saveError) {
          console.error('Falha ao salvar item Pluggy:', saveError?.message || saveError);
          finishToast(doneToast, 'O banco conectou, mas não foi possível salvar a referência no Supabase.', 'error', 5000);
        }
      },
      onError: (error) => {
        const status = error?.data?.item?.executionStatus || '';
        const pending = status === 'USER_AUTHORIZATION_PENDING' || String(status).includes('WAITING');
        showToast(pending ? 'A autorização bancária ainda está pendente. Conclua a etapa solicitada pelo banco.' : (error?.message || 'A conexão bancária não foi concluída.'), { tone: pending ? 'warning' : 'error', duration: 5200 });
      }
    });

    pluggyConnect.init();
  } catch (error) {
    console.error('Falha ao abrir Pluggy Connect:', error?.message || error);
    finishToast(toast, 'Não foi possível iniciar o Open Finance. Tente novamente.', 'error', 4200);
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

function exportTransactionsCsv(transactions, filename, toastMessage) {
  const headers = ['Descrição','Valor','Tipo','Data','Vencimento','Pagamento','Situação','Origem','Conta/Cartão','Categoria','Subcategoria','Membro','Tags','Forma de pagamento','Parcela','Observações'];
  const quote = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  const lines = [headers.map(quote).join(';')];
  [...transactions].sort((a,b) => (transactionViewDate(a) || '').localeCompare(transactionViewDate(b) || '')).forEach(tx => {
    const source = tx.origin === 'openfinance'
      ? (tx.sourceLabel || 'Open Finance')
      : (tx.type === 'card' ? nameById(state.cards, tx.cardId, '') : nameById(state.accounts, tx.accountId, ''));
    lines.push([
      tx.description, Number(tx.amount).toFixed(2).replace('.',','), typeLabel(tx.type), tx.date, tx.dueDate, tx.paidDate, tx.status,
      tx.origin === 'openfinance' ? 'Open Finance' : 'Manual', source,
      tx.category, tx.subcategory, tx.member, (tx.tags || []).join(', '), tx.paymentMethod, `${tx.installmentCurrent || 1}/${tx.installmentTotal || 1}`, tx.notes
    ].map(quote).join(';'));
  });
  downloadBlob(filename, '\ufeff' + lines.join('\n'), 'text/csv;charset=utf-8');
  showToast(toastMessage);
}

function exportCsv() {
  exportTransactionsCsv(allTransactions(), `meu-financeiro-transacoes-${isoDate()}.csv`, 'Arquivo CSV gerado com dados manuais e Open Finance.');
}

function exportReportCsv() {
  const range = reportRangeBounds();
  const rows = periodTransactions(range, true);
  const suffix = `${range.start}-a-${range.end}`;
  exportTransactionsCsv(rows, `meu-financeiro-relatorio-${suffix}.csv`, `CSV do período ${reportRangeLabel(range)} gerado.`);
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
  await Promise.all([loadPluggyItems({ quiet: true }), loadOpenFinanceData({ quiet: true })]);
  await loadPluggyRemoteStatus({ quiet: true });
  startSyncPolling();
}

async function logoutCurrentDevice() {
  if (syncMeta.pending && navigator.onLine) await pushStateToCloud();
  const { error } = await supabaseClient.auth.signOut({ scope: 'local' });
  if (error) { showToast('Não foi possível sair agora.'); return; }
  stopSyncPolling();
  authSession = null;
  state = defaultState();
  pluggyItems = [];
  pluggyAccounts = [];
  pluggyTransactions = [];
  pluggyInvestments = [];
  pluggyRemoteStatus = new Map();
  rebuildOpenFinanceIndexes();
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
  if (pageButton) { ui.page = pageButton.dataset.page; render(); if (ui.page === 'patrimony') Promise.all([loadPluggyItems({ quiet: true }), loadOpenFinanceData({ quiet: true })]).then(() => loadPluggyRemoteStatus({ quiet: true })); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === 'auth-mode') { ui.authMode = button.dataset.mode || 'signin'; ui.authMessage = ''; render(); return; }
  if (action === 'sync-now') { manualSync(); return; }
  if (action === 'toggle-dashboard-privacy') {
    state.preferences.hideDashboardValues = !state.preferences.hideDashboardValues;
    persist();
    render();
    return;
  }
  if (action === 'more-menu') { openMoreMenu(); return; }
  if (action === 'more-page') {
    const targetPage = button.dataset.targetPage || 'dashboard';
    closeModal();
    ui.page = targetPage;
    render();
    if (ui.page === 'patrimony') Promise.all([loadPluggyItems({ quiet: true }), loadOpenFinanceData({ quiet: true })]).then(() => loadPluggyRemoteStatus({ quiet: true }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (action === 'connect-bank') { connectBankWithPluggy(); return; }
  if (action === 'refresh-open-finance') { manualSync(); return; }
  if (action === 'open-meupluggy-refresh') {
    try { localStorage.setItem(OPEN_FINANCE_RETURN_KEY, new Date().toISOString()); } catch {}
    closeModal();
    showToast('Atualize Santander e Bradesco no MeuPluggy. Ao retornar, o Meu Financeiro verificará os dados automaticamente.', { tone: 'info', duration: 5200 });
    window.open(MEU_PLUGGY_URL, '_blank', 'noopener');
    return;
  }
  if (action === 'verify-open-finance-now') {
    closeModal();
    verifyAfterMeuPluggyReturn({ automatic: false });
    return;
  }
  if (action === 'force-cloud') { pushStateToCloud({ force: true }).then(() => render()); return; }
  if (action === 'force-pull') {
    if (syncMeta.pending && !window.confirm('Usar a versão da nuvem? Alterações ainda não sincronizadas deste dispositivo serão substituídas.')) return;
    syncMeta.pending = false; saveSyncMeta(); pullStateFromCloud({ force: true }).then(() => render()); return;
  }
  if (action === 'logout') { logoutCurrentDevice(); return; }
  if (action === 'prev-month') { ui.month = shiftMonth(ui.month, -1); render(); }
  if (action === 'next-month') { ui.month = shiftMonth(ui.month, 1); render(); }
  if (action === 'report-period') {
    ui.reportRange = button.dataset.period || '6m';
    if (ui.reportRange === 'custom') {
      if (!ui.reportStart) ui.reportStart = monthStart(shiftMonth(ui.month, -5));
      if (!ui.reportEnd) ui.reportEnd = monthEnd(ui.month);
    }
    render();
    return;
  }
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
  if (action === 'export-report-csv') exportReportCsv();
  if (action === 'backup-json') backupJson();
  if (action === 'restore-json') document.getElementById('restore-file').click();
  if (action === 'reset-data') {
    if (window.confirm('Apagar todos os dados manuais desta conta? Os dados importados pelo Open Finance permanecerão no Supabase e poderão ser atualizados novamente.')) {
      state = defaultState(); persist(); ui.month = monthKey(new Date()); render(); showToast('Dados manuais apagados.');
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
  if (event.target.id === 'report-start') { ui.reportStart = event.target.value; render(); }
  if (event.target.id === 'report-end') { ui.reportEnd = event.target.value; render(); }
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
  if (document.visibilityState !== 'visible' || !authSession || !navigator.onLine) return;
  if (!syncMeta.pending) pullStateFromCloud({ quiet: true });
  verifyAfterMeuPluggyReturn({ automatic: true });
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
          pluggyItems = [];
          pluggyAccounts = [];
          pluggyTransactions = [];
          pluggyInvestments = [];
          pluggyRemoteStatus = new Map();
          rebuildOpenFinanceIndexes();
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

// ===== Revisão financeira — v1.7.0 =====
// Separa fluxo de caixa, consumo e patrimônio; traduz categorias e trata regras pessoais.

const PLUGGY_CATEGORY_PT = new Map(Object.entries({
  'income': 'Receitas',
  'salary': 'Salário',
  'retirement': 'Aposentadoria',
  'entrepreneurial activities': 'Atividade empresarial',
  'government aid': 'Benefícios governamentais',
  'non-recurring income': 'Receitas eventuais',
  'loans and financing': 'Empréstimos e financiamentos',
  'late payment and overdraft costs': 'Juros e cheque especial',
  'interests charged': 'Juros cobrados',
  'loans': 'Empréstimos',
  'financing': 'Financiamento',
  'real estate financing': 'Financiamento imobiliário',
  'vehicle financing': 'Financiamento de veículo',
  'student loan': 'Financiamento estudantil',
  'investments': 'Investimentos',
  'automatic investment': 'Aplicação automática',
  'fixed income': 'Renda fixa',
  'mutual funds': 'Fundos de investimento',
  'variable income': 'Renda variável',
  'margin': 'Margem',
  'proceeds interests and dividends': 'Rendimentos e dividendos',
  'proceeds interests': 'Rendimentos e dividendos',
  'pension': 'Previdência',
  'same person transfer': 'Transferência entre contas próprias',
  'same person transfer - cash': 'Transferência própria - Dinheiro',
  'same person transfer - pix': 'Transferência própria - PIX',
  'same person transfer - ted': 'Transferência própria - TED',
  'transfers': 'Transferências',
  'transfer - bank slip (boleto)': 'Transferência - Boleto',
  'transfer - cash': 'Transferência - Dinheiro',
  'transfer - check': 'Transferência - Cheque',
  'transfer - doc': 'Transferência - DOC',
  'transfer - foreign exchange': 'Transferência - Câmbio',
  'transfer - internal': 'Transferência interna',
  'transfer - pix': 'Transferência - PIX',
  'transfer - ted': 'Transferência - TED',
  'credit card payment': 'Pagamento de cartão',
  'third-party transfers': 'Transferências para terceiros',
  'bank slip': 'Boleto',
  'debt card': 'Cartão de débito',
  'legal obligations': 'Obrigações legais',
  'blocked balances': 'Valores bloqueados',
  'alimony': 'Pensão alimentícia',
  'services': 'Serviços',
  'telecommunications': 'Telecomunicações',
  'internet': 'Internet',
  'mobile': 'Celular',
  'tv': 'TV',
  'education': 'Educação',
  'online courses': 'Cursos online',
  'university': 'Faculdade',
  'school': 'Escola',
  'kindergarten': 'Educação infantil',
  'wellness and fitness': 'Saúde e bem-estar',
  'gyms and fitness centers': 'Academia',
  'sports practice': 'Prática esportiva',
  'wellness': 'Bem-estar',
  'tickets': 'Ingressos',
  'stadiums and arenas': 'Estádios e arenas',
  'landmarks and museums': 'Museus e atrações',
  'cinema, theater and concerts': 'Cinema, teatro e shows',
  'shopping': 'Compras',
  'online shopping': 'Compras online',
  'electronics': 'Eletrônicos',
  'pet supplies and vet': 'Pets e veterinário',
  'clothing': 'Vestuário',
  'kids and toys': 'Crianças e brinquedos',
  'bookstore': 'Livraria',
  'sports goods': 'Artigos esportivos',
  'office supplies': 'Material de escritório',
  'cashback': 'Cashback',
  'digital services': 'Serviços digitais',
  'gaming': 'Jogos',
  'video streaming': 'Streaming de vídeo',
  'music streaming': 'Streaming de música',
  'groceries': 'Supermercado',
  'food and drinks': 'Alimentação',
  'eating out': 'Restaurantes',
  'food delivery': 'Delivery',
  'travel': 'Viagem',
  'airport and airlines': 'Passagens aéreas',
  'accommodation': 'Hospedagem',
  'mileage programs': 'Milhas',
  'bus tickets': 'Passagens rodoviárias',
  'donations': 'Doações',
  'gambling': 'Apostas',
  'lottery': 'Loteria',
  'online bet': 'Apostas online',
  'taxes': 'Impostos',
  'income taxes': 'Imposto de renda',
  'taxes on investments': 'Impostos sobre investimentos',
  'tax on financial operations': 'IOF',
  'bank fees': 'Tarifas bancárias',
  'account fees': 'Tarifas de conta',
  'wire transfer fees and atm fees': 'Tarifas de transferências e saques',
  'credit card fees': 'Tarifas de cartão',
  'housing': 'Moradia',
  'rent': 'Aluguel',
  'houseware': 'Casa e utensílios',
  'urban land and building tax': 'IPTU',
  'utilities': 'Contas da casa',
  'water': 'Água',
  'electricity': 'Energia elétrica',
  'gas': 'Gás',
  'healthcare': 'Saúde',
  'dentist': 'Dentista',
  'pharmacy': 'Farmácia',
  'optometry': 'Ótica e visão',
  'hospital clinics and labs': 'Hospitais, clínicas e exames',
  'transportation': 'Transporte',
  'taxi and ride-hailing': 'Táxi e transporte por aplicativo',
  'public transportation': 'Transporte público',
  'car rental': 'Aluguel de veículo',
  'bicycle': 'Bicicleta',
  'automotive': 'Automóvel',
  'gas stations': 'Combustível',
  'parking': 'Estacionamento',
  'tolls and in-vehicle payment': 'Pedágios',
  'vehicle ownership taxes and fees': 'Impostos e taxas do veículo',
  'vehicle maintenance': 'Manutenção do veículo',
  'traffic tickets': 'Multas de trânsito',
  'insurance': 'Seguros',
  'life insurance': 'Seguro de vida',
  'home insurance': 'Seguro residencial',
  'health insurance': 'Plano de saúde',
  'vehicle insurance': 'Seguro do veículo',
  'leisure': 'Lazer',
  'other': 'Outros'
}));

function localizedCategory(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Sem categoria';
  return PLUGGY_CATEGORY_PT.get(normalizeSearchText(raw)) || raw;
}

function pluggyIsSalary(row) {
  const description = normalizeSearchText(`${row?.description || ''} ${row?.description_raw || ''}`);
  const category = normalizeSearchText(row?.category);
  return description.includes('ted conta salario gabriel couto de abreu')
    || category === 'salary'
    || /(^|\b)salario(\b|$)/i.test(description);
}

function pluggyExplicitOwnTransfer(row) {
  if (pluggyIsSalary(row)) return false;
  const category = normalizeSearchText(row.category);
  const description = normalizeSearchText(`${row.description || ''} ${row.description_raw || ''}`);
  if (category.includes('same person transfer')) return true;
  return /(mesma titularidade|mesmo titular|mesma pessoa|conta propria|entre minhas contas|entre contas proprias)/i.test(description);
}

function rebuildOpenFinanceIndexes() {
  pluggyAccountMap = new Map(pluggyAccounts.map(account => [account.pluggy_account_id, account]));
  pluggyNeutralBankIds = new Set();
  pluggySuppressedIds = new Set();
  pluggyInternalTransferIds = new Set();

  const bankRows = pluggyTransactions.filter(row => {
    const account = pluggyAccountMap.get(row.pluggy_account_id);
    return String(account?.type || '').toUpperCase() === 'BANK';
  });

  bankRows.forEach(row => {
    if (!pluggyIsSalary(row) && pluggyExplicitOwnTransfer(row)) pluggyInternalTransferIds.add(row.pluggy_transaction_id);
  });

  const credits = bankRows.filter(row => String(row.transaction_type || '').toUpperCase() === 'CREDIT' && !pluggyIsSalary(row));
  const usedCredits = new Set();

  bankRows
    .filter(row => String(row.transaction_type || '').toUpperCase() === 'DEBIT' && !pluggyIsSalary(row))
    .forEach(debit => {
      const amount = Math.abs(num(debit.amount));
      const debitTime = new Date(debit.transaction_date).getTime();
      if (!amount || !Number.isFinite(debitTime)) return;

      const candidates = credits
        .filter(credit => {
          if (usedCredits.has(credit.pluggy_transaction_id)) return false;
          if (credit.pluggy_account_id === debit.pluggy_account_id) return false;
          if (Math.abs(Math.abs(num(credit.amount)) - amount) >= 0.01) return false;
          const creditTime = new Date(credit.transaction_date).getTime();
          if (!Number.isFinite(creditTime) || Math.abs(creditTime - debitTime) > 3 * 86400000) return false;
          return pluggyTransferEvidence(debit) || pluggyTransferEvidence(credit);
        })
        .sort((a, b) => {
          const at = Math.abs(new Date(a.transaction_date).getTime() - debitTime);
          const bt = Math.abs(new Date(b.transaction_date).getTime() - debitTime);
          const aStrong = pluggyTransferEvidence(debit) && pluggyTransferEvidence(a) ? -1 : 0;
          const bStrong = pluggyTransferEvidence(debit) && pluggyTransferEvidence(b) ? -1 : 0;
          return aStrong - bStrong || at - bt;
        });

      const matched = candidates[0];
      if (!matched) return;
      pluggyInternalTransferIds.add(debit.pluggy_transaction_id);
      pluggyInternalTransferIds.add(matched.pluggy_transaction_id);
      usedCredits.add(matched.pluggy_transaction_id);
    });

  // Saída da conta usada para quitar cartão: sai do caixa, mas não volta a ser consumo.
  const cardCredits = pluggyTransactions.filter(row => {
    const account = pluggyAccountMap.get(row.pluggy_account_id);
    return String(account?.type || '').toUpperCase() === 'CREDIT' && num(row.amount) < 0;
  });
  const usedCardCredits = new Set();

  bankRows.forEach(row => {
    if (String(row.transaction_type || '').toUpperCase() !== 'DEBIT') return;
    if (pluggyInternalTransferIds.has(row.pluggy_transaction_id)) return;

    const description = normalizeSearchText(`${row.description || ''} ${row.description_raw || ''}`);
    const category = normalizeSearchText(row.category);
    const explicitCardPayment = /(pagamento|pagto|pgto|pgt|gastos).*?(cartao|fatura)|(cartao|fatura).*?(pagamento|pagto|pgto|pgt)/i.test(description)
      || category.includes('credit card payment');
    const amount = Math.abs(num(row.amount));
    const time = new Date(row.transaction_date).getTime();

    let matched = null;
    if (amount > 0 && Number.isFinite(time)) {
      matched = cardCredits.find(other => {
        if (usedCardCredits.has(other.pluggy_transaction_id)) return false;
        const otherTime = new Date(other.transaction_date).getTime();
        const otherDescription = normalizeSearchText(`${other.description || ''} ${other.description_raw || ''}`);
        const otherCategory = normalizeSearchText(other.category);
        const creditLooksLikePayment = /(pagamento|pagto|pgto|pgt|fatura)/i.test(otherDescription) || otherCategory.includes('credit card payment');
        return Math.abs(Math.abs(num(other.amount)) - amount) < 0.01
          && Math.abs(otherTime - time) <= 3 * 86400000
          && (explicitCardPayment || creditLooksLikePayment);
      });
    }

    if (explicitCardPayment || matched) pluggyNeutralBankIds.add(row.pluggy_transaction_id);
    if (matched) {
      pluggySuppressedIds.add(matched.pluggy_transaction_id);
      usedCardCredits.add(matched.pluggy_transaction_id);
    }
  });
}

function normalizePluggyTransaction(row) {
  const account = pluggyAccountMap.get(row.pluggy_account_id);
  if (!account || pluggySuppressedIds.has(row.pluggy_transaction_id)) return null;

  const signedAmount = num(row.amount);
  const amount = Math.abs(signedAmount);
  const accountType = String(account.type || '').toUpperCase();
  const txType = String(row.transaction_type || '').toUpperCase();
  const salary = accountType === 'BANK' && txType === 'CREDIT' && pluggyIsSalary(row);
  let type = 'expense';

  if (salary) {
    type = 'income';
  } else if (accountType === 'CREDIT') {
    type = signedAmount > 0 ? 'card' : 'card_payment';
  } else if (pluggyInternalTransferIds.has(row.pluggy_transaction_id)) {
    type = 'transfer';
  } else if (pluggyNeutralBankIds.has(row.pluggy_transaction_id)) {
    type = 'card_payment';
  } else {
    type = txType === 'CREDIT' ? 'income' : 'expense';
  }

  const date = pluggyDateLocal(row.transaction_date);
  const dueDate = simpleDate(row.bill_forecast_date) || date;
  const status = String(row.status || '').toUpperCase() === 'POSTED' ? 'confirmed' : 'pending';
  const defaultCategory = type === 'transfer'
    ? 'Transferência interna'
    : type === 'card_payment'
      ? 'Pagamento de cartão'
      : 'Sem categoria';
  const category = salary ? 'Salário' : localizedCategory(row.category || defaultCategory);

  return {
    id: `pluggy:${row.pluggy_transaction_id}`,
    pluggyId: row.pluggy_transaction_id,
    description: row.description || row.description_raw || 'Movimentação Open Finance',
    amount,
    type,
    date,
    dueDate,
    paidDate: '',
    accountId: accountType === 'BANK' ? `pluggy-account:${row.pluggy_account_id}` : '',
    destinationAccountId: '',
    cardId: accountType === 'CREDIT' ? `pluggy-card:${row.pluggy_account_id}` : '',
    category,
    subcategory: '',
    member: '',
    tags: salary ? ['salário'] : [],
    status,
    paymentMethod: 'Open Finance',
    installmentCurrent: row.installment_number || 1,
    installmentTotal: row.total_installments || 1,
    notes: '',
    origin: 'openfinance',
    sourceLabel: account.name || account.institution_name || 'Open Finance',
    readOnly: true,
    internalTransfer: type === 'transfer'
  };
}

function cashFlowDate(tx) {
  return tx.paidDate || tx.date || tx.dueDate || '';
}

function consumptionDate(tx) {
  return tx.date || tx.dueDate || tx.paidDate || '';
}

function isAccountCashMovement(tx) {
  if (!validForCalculations(tx) || tx.status !== 'confirmed') return false;
  if (tx.type === 'transfer' || tx.type === 'card') return false;
  if (!['income', 'expense', 'card_payment'].includes(tx.type)) return false;
  return Boolean(tx.accountId);
}

function cashFlowTransactionsForMonth(key = ui.month) {
  return allTransactions().filter(tx => isAccountCashMovement(tx) && isInMonth(cashFlowDate(tx), key));
}

function monthCashFlowTotals(key = ui.month) {
  const rows = cashFlowTransactionsForMonth(key);
  const income = rows.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + num(tx.amount), 0);
  const expense = rows.filter(tx => tx.type === 'expense' || tx.type === 'card_payment').reduce((sum, tx) => sum + num(tx.amount), 0);
  return { income, expense, result: income - expense, count: rows.length };
}

function monthCashFlowBreakdown(key = ui.month) {
  const rows = cashFlowTransactionsForMonth(key);
  const income = rows.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + num(tx.amount), 0);
  const directExpenses = rows.filter(tx => tx.type === 'expense').reduce((sum, tx) => sum + num(tx.amount), 0);
  const cardPayments = rows.filter(tx => tx.type === 'card_payment').reduce((sum, tx) => sum + num(tx.amount), 0);
  const outflow = directExpenses + cardPayments;
  return { rows, income, directExpenses, cardPayments, outflow, variation: income - outflow };
}

function monthConsumptionTransactions(key = ui.month) {
  return allTransactions().filter(tx => {
    if (!validForCalculations(tx) || !isInMonth(consumptionDate(tx), key)) return false;
    if (tx.type === 'expense') return tx.status === 'confirmed';
    if (tx.type === 'card') return tx.status === 'confirmed' || tx.status === 'pending';
    return false;
  });
}

function monthConsumptionTotal(key = ui.month) {
  return monthConsumptionTransactions(key).reduce((sum, tx) => sum + num(tx.amount), 0);
}

function monthPendingCardTotal(key = ui.month) {
  return monthConsumptionTransactions(key)
    .filter(tx => tx.type === 'card' && tx.status === 'pending')
    .reduce((sum, tx) => sum + num(tx.amount), 0);
}

function monthPendingTransactions(key = ui.month) {
  return allTransactions().filter(tx => {
    if (!validForCalculations(tx) || tx.status !== 'pending') return false;
    if (!['income', 'expense', 'card'].includes(tx.type)) return false;
    const viewDate = tx.type === 'card' ? consumptionDate(tx) : transactionViewDate(tx);
    return isInMonth(viewDate, key);
  });
}

function totalBankCashBalance() {
  const manual = state.accounts.reduce((sum, account) => sum + accountBalance(account.id), 0);
  const imported = pluggyAccounts
    .filter(account => String(account.type).toUpperCase() === 'BANK')
    .reduce((sum, account) => sum + num(account.balance), 0);
  return manual + imported;
}

function totalCreditDebt() {
  const manual = state.cards.reduce((sum, card) => sum + cardInvoice(card.id), 0);
  const imported = pluggyAccounts
    .filter(account => String(account.type).toUpperCase() === 'CREDIT')
    .reduce((sum, account) => sum + Math.max(0, num(account.balance)), 0);
  return manual + imported;
}

function categoryTotals(key = ui.month) {
  const map = new Map();
  monthConsumptionTransactions(key).forEach(tx => {
    const category = localizedCategory(tx.category);
    map.set(category, (map.get(category) || 0) + num(tx.amount));
  });
  return [...map.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

function budgetSpent(budget) {
  return monthConsumptionTransactions(budget.month)
    .filter(tx => localizedCategory(tx.category) === localizedCategory(budget.category))
    .reduce((sum, tx) => sum + num(tx.amount), 0);
}

function periodCashFlowTransactions(range = reportRangeBounds()) {
  return allTransactions().filter(tx => {
    if (!isAccountCashMovement(tx)) return false;
    const key = dateKey(cashFlowDate(tx));
    return key && key >= range.start && key <= range.end;
  });
}

function periodConsumptionTransactions(range = reportRangeBounds()) {
  return allTransactions().filter(tx => {
    if (!validForCalculations(tx)) return false;
    const key = dateKey(consumptionDate(tx));
    if (!key || key < range.start || key > range.end) return false;
    if (tx.type === 'expense') return tx.status === 'confirmed';
    if (tx.type === 'card') return tx.status === 'confirmed' || tx.status === 'pending';
    return false;
  });
}

function periodTotals(range = reportRangeBounds()) {
  const rows = periodCashFlowTransactions(range);
  const income = rows.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + num(tx.amount), 0);
  const expense = rows.filter(tx => tx.type === 'expense' || tx.type === 'card_payment').reduce((sum, tx) => sum + num(tx.amount), 0);
  return { income, expense, result: income - expense, count: rows.length };
}

function periodCategoryTotals(range = reportRangeBounds()) {
  const map = new Map();
  periodConsumptionTransactions(range).forEach(tx => {
    const category = localizedCategory(tx.category);
    map.set(category, (map.get(category) || 0) + num(tx.amount));
  });
  return [...map.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

function periodMonthlyResults(range = reportRangeBounds()) {
  const grouped = new Map();
  periodCashFlowTransactions(range).forEach(tx => {
    const key = dateKey(cashFlowDate(tx)).slice(0, 7);
    if (!key) return;
    if (!grouped.has(key)) grouped.set(key, { income: 0, expense: 0 });
    const bucket = grouped.get(key);
    if (tx.type === 'income') bucket.income += num(tx.amount);
    if (tx.type === 'expense' || tx.type === 'card_payment') bucket.expense += num(tx.amount);
  });

  const months = [];
  let key = range.start.slice(0, 7);
  const last = range.end.slice(0, 7);
  let safety = 0;
  while (key <= last && safety < 120) {
    const bucket = grouped.get(key) || { income: 0, expense: 0 };
    months.push({ key, ...bucket, result: bucket.income - bucket.expense });
    key = shiftMonth(key, 1);
    safety++;
  }
  return months;
}

function typeLabel(type) {
  return {
    income: 'Entrada em conta',
    expense: 'Gasto em conta',
    transfer: 'Transferência interna',
    card: 'Compra no cartão',
    card_payment: 'Liquidação de cartão'
  }[type] || type;
}

function renderTransactionRow(tx, actions = false) {
  const isPositive = tx.type === 'income';
  const isTransfer = tx.type === 'transfer';
  const date = transactionViewDate(tx);
  const source = tx.origin === 'openfinance'
    ? (tx.sourceLabel || 'Open Finance')
    : (tx.type === 'card' ? nameById(state.cards, tx.cardId, 'Cartão') : nameById(state.accounts, tx.accountId, 'Sem conta'));
  const installment = num(tx.installmentTotal) > 1 ? ` · ${tx.installmentCurrent}/${tx.installmentTotal}` : '';
  const origin = tx.origin === 'openfinance' ? ' · Open Finance' : ' · Manual';
  const subtitle = `${typeLabel(tx.type)} · ${esc(localizedCategory(tx.category))} · ${esc(source)}${installment}${origin}`;
  const valueClass = isTransfer ? '' : isPositive ? 'positive' : 'negative';
  const sign = isPositive ? '+' : isTransfer ? '' : '−';
  const canEdit = actions && !tx.readOnly && tx.origin !== 'openfinance';
  return `<div class="list-row transaction-row">
    <div class="row-main transaction-main"><div class="avatar">${typeIcon(tx.type)}</div><div class="row-content"><div class="row-title">${esc(tx.description)}</div><div class="row-subtitle">${subtitle} · ${date ? shortDate.format(parseDate(date)) : 'Sem data'}</div></div></div>
    <div class="row-actions transaction-actions"><div class="row-summary"><div class="row-value ${valueClass}">${sign}${money.format(tx.amount)}</div><span class="chip ${tx.status}">${tx.status === 'confirmed' ? 'Confirmada' : tx.status === 'pending' ? 'Pendente' : 'Ignorada'}</span></div>${canEdit ? `<button class="icon-button" data-action="edit-transaction" data-id="${tx.id}" aria-label="Editar">✎</button><button class="icon-button" data-action="delete-transaction" data-id="${tx.id}" aria-label="Excluir">×</button>` : ''}</div>
  </div>`;
}

function renderDashboard() {
  const cash = monthCashFlowTotals();
  const cashBreakdown = monthCashFlowBreakdown();
  const previousCash = monthCashFlowTotals(shiftMonth(ui.month, -1));
  const categories = categoryTotals().slice(0, 6);
  const maxCategory = Math.max(1, ...categories.map(item => item.total));
  const budgets = state.budgets.filter(item => item.month === ui.month).slice(0, 4);
  const recent = monthTransactions().sort((a, b) => (transactionViewDate(b) || '').localeCompare(transactionViewDate(a) || '')).slice(0, 6);
  const pendingRows = monthPendingTransactions();
  const pending = pendingRows.reduce((sum, tx) => sum + num(tx.amount), 0);
  const resultChange = previousCash.result ? ((cash.result - previousCash.result) / Math.abs(previousCash.result)) * 100 : 0;
  const consumption = monthConsumptionTotal();
  const pendingCard = monthPendingCardTotal();
  const bankCash = totalBankCashBalance();
  const investments = totalInvestmentBalance();
  const cardDebt = totalCreditDebt();
  const netWorth = totalNetWorth();
  const gettingStarted = state.accounts.length === 0 && state.transactions.length === 0 && pluggyAccounts.length === 0 && pluggyInvestments.length === 0 ? `
    <article class="card getting-started" style="margin-bottom:16px">
      <div class="card-header"><div><h2 class="card-title">Comece por aqui</h2><p class="card-note">Cadastre contas manualmente ou conecte seu banco pelo Open Finance.</p></div></div>
      <div class="toolbar"><button class="button primary" data-action="connect-bank">🏦 Conectar banco</button><button class="button" data-action="add-account">+ Conta manual</button></div>
    </article>` : '';

  const content = `
    ${gettingStarted}

    <div class="dashboard-section-heading"><div><h2>Disponibilidade e caixa · ${esc(formatMonthShort(ui.month))}</h2><p>O saldo atual mostra quanto você tem nas contas hoje. A variação mensal mostra apenas quanto esse saldo aumentou ou diminuiu no período — não representa déficit.</p></div></div>
    <section class="grid kpis dashboard-cash-kpis">
      <article class="card cash-balance-card"><div class="kpi-label">Saldo disponível em contas</div><div class="kpi-value ${bankCash >= 0 ? 'positive' : 'negative'}">${money.format(bankCash)}</div><div class="kpi-meta">Saldo bancário atual · sem investimentos e sem limite de crédito</div></article>
      <button class="card kpi-action-card" data-action="cash-details" data-kind="income"><div class="kpi-label">Entradas no caixa</div><div class="kpi-value positive">${money.format(cashBreakdown.income)}</div><div class="kpi-meta">Recebimentos efetivos · toque para detalhar</div></button>
      <button class="card kpi-action-card" data-action="cash-details" data-kind="direct"><div class="kpi-label">Gastos pagos pela conta</div><div class="kpi-value negative">${money.format(cashBreakdown.directExpenses)}</div><div class="kpi-meta">PIX, débitos e pagamentos diretos · toque para detalhar</div></button>
      <button class="card kpi-action-card" data-action="cash-details" data-kind="cards"><div class="kpi-label">Faturas liquidadas</div><div class="kpi-value">${money.format(cashBreakdown.cardPayments)}</div><div class="kpi-meta">Saída de caixa, mas não novo consumo · toque para detalhar</div></button>
    </section>
    <article class="card cash-variation-card ${cashBreakdown.variation >= 0 ? 'cash-up' : 'cash-down'}">
      <div><div class="kpi-label">Variação do saldo no período</div><div class="cash-variation-explanation">Entradas menos gastos pagos pela conta e faturas liquidadas.</div></div>
      <div class="cash-variation-value">${cashBreakdown.variation >= 0 ? '+' : '−'}${money.format(Math.abs(cashBreakdown.variation))}</div>
      <div class="cash-variation-note">${cashBreakdown.variation >= 0 ? 'Seu caixa aumentou neste mês.' : 'Seu caixa diminuiu neste mês. Isso não significa que sua conta esteja negativa.'}</div>
    </article>

    <div class="dashboard-section-heading dashboard-section-spaced"><div><h2>Patrimônio</h2><p>Posição atual separada do fluxo mensal. Sua reserva de emergência permanece aqui.</p></div></div>
    <section class="grid dashboard-wealth-kpis">
      ${kpi('Patrimônio líquido', money.format(netWorth), 'Contas + investimentos − cartões', netWorth >= 0 ? 'positive' : 'negative')}
      ${kpi('Investimentos / reserva', money.format(investments), `${pluggyInvestments.length} ativos fora do fluxo mensal`, 'positive')}
      ${kpi('Cartões em aberto', money.format(cardDebt), 'Dívida atual; o pagamento não vira novo consumo', cardDebt > 0 ? 'negative' : '')}
    </section>

    <section class="grid two" style="margin-top:16px">
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Gastos por categoria</h2><p class="card-note">${money.format(consumption)} realizados no mês · ${money.format(pendingCard)} ainda pendentes no cartão</p></div><button class="button small" data-page="reports">Detalhar</button></div>
        ${categories.length ? `<div class="chart">${categories.map(item => `<div class="chart-row"><div class="chart-label">${esc(item.category)}</div><div class="chart-track"><div class="chart-bar" style="width:${(item.total / maxCategory) * 100}%"></div></div><div class="chart-value">${money.format(item.total)}</div></div>`).join('')}</div>` : empty('Ainda não há gastos realizados neste mês.')}
      </article>

      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Orçamentos do mês</h2><p class="card-note">Compras pendentes do cartão já consomem o orçamento da categoria.</p></div><button class="button small" data-page="planning">Gerenciar</button></div>
        ${budgets.length ? `<div class="stack">${budgets.map(renderBudgetProgress).join('')}</div>` : empty('Crie limites para acompanhar seus gastos.')}
      </article>
    </section>

    <section class="grid two" style="margin-top:16px">
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Movimentações recentes</h2><p class="card-note">Conta, cartão e transferências permanecem visíveis separadamente.</p></div><button class="button small primary" data-action="add-transaction">+ Lançar</button></div>
        ${recent.length ? recent.map(renderTransactionRow).join('') : empty('Nenhuma movimentação neste mês.')}
      </article>
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Atenção</h2><p class="card-note">Pendências e limites</p></div></div>
        <div class="stack">
          <button class="list-row attention-link" data-action="show-pending-transactions"><div><div class="row-title">Transações pendentes</div><div class="row-subtitle">${pendingRows.length} registros · toque para visualizar</div></div><div class="row-value warning">${money.format(pending)}</div></button>
          ${budgetAlerts().slice(0, 4).map(alert => `<div class="list-row"><div><div class="row-title">${esc(alert.title)}</div><div class="row-subtitle">${esc(alert.message)}</div></div><span class="chip ${alert.level}">${alert.percent.toFixed(0)}%</span></div>`).join('') || '<div class="list-row"><div><div class="row-title">Tudo sob controle</div><div class="row-subtitle">Nenhum orçamento próximo do limite.</div></div><span class="chip confirmed">OK</span></div>'}
        </div>
      </article>
    </section>`;

  return pageShell(content, `<button class="button primary" data-action="add-transaction"><span class="desktop-label">Nova movimentação</span><span>＋</span></button>`);
}

function openInfoModal(title, body) {
  document.getElementById('modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="width:min(860px,100%)"><div class="modal-header"><h2 class="modal-title">${esc(title)}</h2><button class="icon-button" type="button" data-action="close-modal" aria-label="Fechar">×</button></div><div class="modal-body">${body}</div><div class="modal-footer"><button class="button primary" type="button" data-action="close-modal">Fechar</button></div></section></div>`;
}

function openReportCategoryDetails(category) {
  const range = reportRangeBounds();
  const rows = periodConsumptionTransactions(range)
    .filter(tx => localizedCategory(tx.category) === category)
    .sort((a, b) => (consumptionDate(b) || '').localeCompare(consumptionDate(a) || ''));
  const total = rows.reduce((sum, tx) => sum + num(tx.amount), 0);
  const pending = rows.filter(tx => tx.status === 'pending').reduce((sum, tx) => sum + num(tx.amount), 0);
  const body = `
    <div class="category-detail-summary">
      <div><span>Total da categoria</span><strong>${money.format(total)}</strong></div>
      <div><span>Movimentações</span><strong>${rows.length}</strong></div>
      <div><span>Pendente no cartão</span><strong>${money.format(pending)}</strong></div>
      <div><span>Período</span><strong>${esc(reportRangeLabel(range))}</strong></div>
    </div>
    <div class="category-detail-list">${rows.length ? rows.map(tx => renderTransactionRow(tx)).join('') : empty('Nenhuma movimentação encontrada.')}</div>`;
  openInfoModal(category, body);
}

function renderReports() {
  const range = reportRangeBounds();
  const periodLabel = reportRangeLabel(range);
  const categories = periodCategoryTotals(range);
  const totals = periodTotals(range);
  const consumptionRows = periodConsumptionTransactions(range);
  const consumption = consumptionRows.reduce((sum, tx) => sum + num(tx.amount), 0);
  const pendingConsumption = consumptionRows.filter(tx => tx.type === 'card' && tx.status === 'pending').reduce((sum, tx) => sum + num(tx.amount), 0);
  const maxCategory = Math.max(1, ...categories.map(item => item.total));
  const results = periodMonthlyResults(range);
  const maxFlow = Math.max(1, ...results.flatMap(item => [item.income, item.expense]));
  const reportTransactions = periodTransactions(range, true);
  const ignored = allTransactions().filter(tx => {
    const key = dateKey(transactionViewDate(tx));
    return tx.status === 'ignored' && key && key >= range.start && key <= range.end;
  }).length;
  const pending = reportTransactions.filter(tx => tx.status === 'pending').length;
  const uncategorized = consumptionRows.filter(tx => localizedCategory(tx.category) === 'Sem categoria').length;
  const internalTransfers = reportTransactions.filter(tx => tx.type === 'transfer' || tx.type === 'card_payment').length;

  const presets = [
    ['1m', '1 mês'], ['3m', '3 meses'], ['6m', '6 meses'], ['12m', '12 meses'], ['all', 'Todo histórico'], ['custom', 'Personalizado']
  ];

  const customRange = ui.reportRange === 'custom' ? `
    <div class="report-custom-range">
      <div class="field"><label>Data inicial</label><input class="input" id="report-start" type="date" value="${esc(range.start)}"></div>
      <div class="field"><label>Data final</label><input class="input" id="report-end" type="date" value="${esc(range.end)}"></div>
    </div>` : '';

  const content = `
    <article class="card report-period-card">
      <div class="card-header"><div><h2 class="card-title">Período do relatório</h2><p class="card-note">Fluxo de caixa e consumo são analisados separadamente. Transferências próprias ficam neutras.</p></div><span class="chip confirmed report-period-label">${esc(periodLabel)}</span></div>
      <div class="report-period-presets">${presets.map(([value, label]) => `<button class="button small report-period-button ${ui.reportRange === value ? 'primary active' : ''}" data-action="report-period" data-period="${value}">${label}</button>`).join('')}</div>
      ${customRange}
    </article>

    <section class="grid kpis report-kpis" style="margin-top:16px">
      <article class="card"><div class="kpi-label">Entradas no caixa</div><div class="kpi-value positive">${money.format(totals.income)}</div><div class="kpi-meta">Recebimentos efetivos</div></article>
      <article class="card"><div class="kpi-label">Saídas efetivas</div><div class="kpi-value negative">${money.format(totals.expense)}</div><div class="kpi-meta">Movimento bancário, incluindo faturas</div></article>
      <article class="card report-variation-card"><div class="kpi-label">Variação do caixa</div><div class="kpi-value ${totals.result >= 0 ? 'positive' : 'warning'}">${totals.result >= 0 ? '+' : '−'}${money.format(Math.abs(totals.result))}</div><div class="kpi-meta">Variação no período; não representa saldo negativo</div></article>
      <article class="card"><div class="kpi-label">Consumo no período</div><div class="kpi-value negative">${money.format(consumption)}</div><div class="kpi-meta">${money.format(pendingConsumption)} pendentes no cartão</div></article>
    </section>

    <section class="grid two" style="margin-top:16px">
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Distribuição dos gastos</h2><p class="card-note">Inclui compras pendentes do cartão. Clique em uma categoria para ver os detalhes.</p></div></div>
        ${categories.length ? `<div class="chart">${categories.map(item => `<button class="chart-row chart-row-button" data-action="report-category-details" data-category="${esc(item.category)}"><div class="chart-label">${esc(item.category)}</div><div class="chart-track"><div class="chart-bar" style="width:${(item.total / maxCategory) * 100}%"></div></div><div class="chart-value">${money.format(item.total)}</div></button>`).join('')}</div>` : empty('Sem gastos realizados para analisar neste período.')}
      </article>
      <article class="card">
        <div class="card-header"><div><h2 class="card-title">Qualidade dos dados</h2><p class="card-note">Itens do período que merecem revisão</p></div></div>
        <div class="stack">
          <div class="list-row"><span>Transações pendentes</span><strong class="${pending ? 'warning' : 'positive'}">${pending}</strong></div>
          <div class="list-row"><span>Transações ignoradas</span><strong>${ignored}</strong></div>
          <div class="list-row"><span>Sem categoria</span><strong class="${uncategorized ? 'warning' : 'positive'}">${uncategorized}</strong></div>
          <div class="list-row"><span>Transferências / liquidações fora do consumo</span><strong>${internalTransfers}</strong></div>
          <div class="list-row"><span>Registros no período</span><strong>${reportTransactions.length}</strong></div>
        </div>
      </article>
    </section>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Movimentação do caixa</h2><p class="card-note">Entradas e saídas efetivas das contas. O valor à direita é a variação mensal, não o saldo da conta · ${esc(periodLabel)}</p></div></div>
      <div class="chart report-flow-chart">${results.map(item => `<div class="chart-row"><div class="chart-label">${esc(formatMonthShort(item.key))}</div><div><div class="chart-track" title="Entradas"><div class="chart-bar" style="width:${(item.income / maxFlow) * 100}%"></div></div><div class="chart-track" title="Saídas" style="margin-top:5px"><div class="chart-bar" style="width:${(item.expense / maxFlow) * 100}%;background:var(--negative)"></div></div></div><div class="chart-value ${item.result >= 0 ? 'positive' : 'warning'}">${item.result >= 0 ? '+' : '−'}${money.format(Math.abs(item.result))}</div></div>`).join('')}</div>
    </article>

    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Exportação</h2><p class="card-note">Exporte somente o período selecionado ou gere uma cópia completa.</p></div></div>
      <div class="toolbar"><button class="button primary" data-action="export-report-csv">Exportar período em CSV</button><button class="button" data-action="export-csv">Exportar tudo em CSV</button><button class="button" data-action="backup-json">Baixar cópia JSON</button></div>
    </article>`;

  return pageShell(content);
}


function renderTransactions() {
  const search = ui.transactionSearch.trim().toLowerCase();
  const rows = allTransactions()
    .filter(tx => {
      const viewDate = tx.type === 'card' ? consumptionDate(tx) : transactionViewDate(tx);
      return isInMonth(viewDate);
    })
    .filter(tx => ui.transactionType === 'all' || tx.type === ui.transactionType)
    .filter(tx => ui.transactionStatus === 'all' || tx.status === ui.transactionStatus)
    .filter(tx => !search || [tx.description, localizedCategory(tx.category), tx.subcategory, tx.member, ...(tx.tags || [])].join(' ').toLowerCase().includes(search))
    .sort((a, b) => {
      const ad = a.type === 'card' ? consumptionDate(a) : transactionViewDate(a);
      const bd = b.type === 'card' ? consumptionDate(b) : transactionViewDate(b);
      return (bd || '').localeCompare(ad || '');
    });

  const content = `
    <article class="card transactions-card">
      <div class="toolbar transaction-toolbar">
        <input class="input search" id="transaction-search" placeholder="Buscar descrição, categoria, membro ou tag" value="${esc(ui.transactionSearch)}">
        <select class="select filter-select" id="transaction-type-filter">
          ${selectOptions([['all','Todas'],['income','Entradas em conta'],['expense','Gastos em conta'],['card','Compras no cartão'],['card_payment','Liquidações de cartão'],['transfer','Transferências internas']], ui.transactionType)}
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


// ===== v1.8.0 — experiência mobile inspirada em apps financeiros modernos =====

const CATEGORY_VISUALS = {
  'Alimentação': ['🍔', 'cat-food'],
  'Moradia': ['⌂', 'cat-home'],
  'Transporte': ['🚗', 'cat-transport'],
  'Saúde': ['❤', 'cat-health'],
  'Educação': ['📚', 'cat-education'],
  'Lazer': ['🎬', 'cat-leisure'],
  'Serviços': ['⚙', 'cat-services'],
  'Dívidas': ['💳', 'cat-debt'],
  'Taxas': ['%', 'cat-fees'],
  'Vestuário': ['👕', 'cat-shopping'],
  'Viagem': ['✈', 'cat-travel'],
  'Salário': ['💰', 'cat-income'],
  'Receitas variáveis': ['↗', 'cat-income'],
  'Investimentos': ['📈', 'cat-investment'],
  'Presentes': ['🎁', 'cat-gifts'],
  'Cashback': ['↩', 'cat-income'],
  'Outros': ['•••', 'cat-other'],
  'Sem categoria': ['?', 'cat-other'],
  'Transferência interna': ['⇄', 'cat-transfer'],
  'Pagamento de cartão': ['✓', 'cat-card']
};

function categoryVisual(category) {
  const localized = localizedCategory(category || 'Sem categoria');
  return { category: localized, icon: CATEGORY_VISUALS[localized]?.[0] || '•', tone: CATEGORY_VISUALS[localized]?.[1] || 'cat-other' };
}

function dashboardMoney(value) {
  return state.preferences.hideDashboardValues ? 'R$ ••••••' : money.format(value);
}

function dashboardSignedMoney(value) {
  if (state.preferences.hideDashboardValues) return 'R$ ••••••';
  return `${value >= 0 ? '+' : '−'}${money.format(Math.abs(value))}`;
}

function renderTransactionRow(tx, actions = false) {
  const isPositive = tx.type === 'income';
  const isTransfer = tx.type === 'transfer';
  const date = transactionViewDate(tx);
  const source = tx.origin === 'openfinance'
    ? (tx.sourceLabel || 'Open Finance')
    : (tx.type === 'card' ? nameById(state.cards, tx.cardId, 'Cartão') : nameById(state.accounts, tx.accountId, 'Sem conta'));
  const installment = num(tx.installmentTotal) > 1 ? ` · ${tx.installmentCurrent}/${tx.installmentTotal}` : '';
  const origin = tx.origin === 'openfinance' ? 'Open Finance' : 'Manual';
  const visual = categoryVisual(tx.category);
  const valueClass = isTransfer ? 'transfer-value' : isPositive ? 'positive' : 'negative';
  const sign = isPositive ? '+' : isTransfer ? '' : '−';
  const canEdit = actions && !tx.readOnly && tx.origin !== 'openfinance';

  return `<div class="list-row transaction-row v18-transaction-row">
    <div class="row-main transaction-main">
      <div class="category-avatar ${visual.tone}">${visual.icon}</div>
      <div class="row-content">
        <div class="row-title">${esc(tx.description)}</div>
        <div class="row-subtitle">${esc(visual.category)} · ${esc(source)}${installment}</div>
        <div class="transaction-meta-mobile">${date ? formatDateBr(date) : 'Sem data'} · ${origin}</div>
      </div>
    </div>
    <div class="row-actions transaction-actions">
      <div class="row-summary">
        <div class="row-value ${valueClass}">${sign}${money.format(tx.amount)}</div>
        <span class="chip ${tx.status}">${tx.status === 'confirmed' ? 'Confirmada' : tx.status === 'pending' ? 'Pendente' : 'Ignorada'}</span>
      </div>
      ${canEdit ? `<button class="icon-button transaction-edit-button" data-action="edit-transaction" data-id="${tx.id}" aria-label="Editar">✎</button><button class="icon-button transaction-edit-button" data-action="delete-transaction" data-id="${tx.id}" aria-label="Excluir">×</button>` : ''}
    </div>
  </div>`;
}

function dashboardCategoryDonut(categories, total) {
  if (!categories.length || total <= 0) return `<div class="donut-empty"><div>Sem gastos</div><small>no período</small></div>`;
  let acc = 0;
  const palette = ['var(--chart-1)','var(--chart-2)','var(--chart-3)','var(--chart-4)','var(--chart-5)','var(--chart-6)'];
  const stops = categories.slice(0, 6).map((item, index) => {
    const start = acc;
    acc += (item.total / total) * 100;
    return `${palette[index % palette.length]} ${start.toFixed(2)}% ${Math.min(acc,100).toFixed(2)}%`;
  });
  if (acc < 100) stops.push(`var(--surface-2) ${acc.toFixed(2)}% 100%`);
  return `<div class="donut-chart" style="--donut:${stops.join(',')}"><div class="donut-center"><small>Consumo</small><strong>${dashboardMoney(total)}</strong></div></div>`;
}

function dashboardCardsPreview() {
  const imported = pluggyAccounts.filter(a => String(a.type).toUpperCase() === 'CREDIT').map(account => {
    const invoice = Math.max(0, num(account.balance));
    const available = account.available_credit_limit == null ? null : num(account.available_credit_limit);
    const totalLimit = available == null ? null : Math.max(0, invoice + available);
    const percent = totalLimit ? clamp((invoice / totalLimit) * 100, 0, 100) : 0;
    return {
      name: account.name || 'Cartão',
      institution: account.institution_name || 'Open Finance',
      invoice,
      available,
      percent,
      due: simpleDate(account.balance_due_date)
    };
  });

  const manual = state.cards.map(card => {
    const invoice = cardInvoice(card.id);
    const available = num(card.limit) - invoice;
    return {
      name: card.name,
      institution: card.brand || 'Manual',
      invoice,
      available,
      percent: card.limit ? clamp((invoice / card.limit) * 100, 0, 100) : 0,
      due: card.dueDay ? `dia ${card.dueDay}` : ''
    };
  });

  const cards = [...imported, ...manual].slice(0, 4);
  if (!cards.length) return empty('Nenhum cartão conectado ou cadastrado.');

  return `<div class="dashboard-card-strip">${cards.map(card => `
    <article class="mini-credit-card">
      <div class="mini-card-top"><div><small>${esc(card.institution)}</small><strong>${esc(card.name)}</strong></div><span>▰</span></div>
      <div class="mini-card-label">Fatura atual</div>
      <div class="mini-card-invoice">${dashboardMoney(card.invoice)}</div>
      <div class="mini-card-progress"><span style="width:${card.percent}%"></span></div>
      <div class="mini-card-footer"><span>Disponível ${card.available == null ? '—' : dashboardMoney(card.available)}</span><span>${card.due ? `Vence ${esc(card.due)}` : ''}</span></div>
    </article>`).join('')}</div>`;
}

function renderDashboard() {
  const cashBreakdown = monthCashFlowBreakdown();
  const categories = categoryTotals().slice(0, 6);
  const consumption = monthConsumptionTotal();
  const pendingCard = monthPendingCardTotal();
  const bankCash = totalBankCashBalance();
  const investments = totalInvestmentBalance();
  const cardDebt = totalCreditDebt();
  const netWorth = totalNetWorth();
  const budgets = state.budgets.filter(item => item.month === ui.month).slice(0, 4);
  const recent = monthTransactions()
    .sort((a, b) => (transactionViewDate(b) || '').localeCompare(transactionViewDate(a) || ''))
    .slice(0, 5);
  const pendingRows = monthPendingTransactions();
  const pending = pendingRows.reduce((sum, tx) => sum + num(tx.amount), 0);
  const gettingStarted = state.accounts.length === 0 && state.transactions.length === 0 && pluggyAccounts.length === 0 && pluggyInvestments.length === 0 ? `
    <article class="card getting-started" style="margin-bottom:16px">
      <div class="card-header"><div><h2 class="card-title">Comece por aqui</h2><p class="card-note">Cadastre contas manualmente ou conecte seu banco pelo Open Finance.</p></div></div>
      <div class="toolbar"><button class="button primary" data-action="connect-bank">🏦 Conectar banco</button><button class="button" data-action="add-account">+ Conta manual</button></div>
    </article>` : '';

  const categoryRows = categories.map((item, index) => {
    const visual = categoryVisual(item.category);
    const pct = consumption ? (item.total / consumption) * 100 : 0;
    return `<button class="category-summary-row" data-action="dashboard-category-details" data-category="${esc(visual.category)}">
      <span class="category-avatar ${visual.tone}">${visual.icon}</span>
      <span class="category-summary-main"><strong>${esc(visual.category)}</strong><small>${pct.toFixed(0)}% do consumo</small></span>
      <span class="category-summary-value">${dashboardMoney(item.total)}</span>
    </button>`;
  }).join('');

  const content = `
    ${gettingStarted}
    <section class="balance-hero">
      <div class="balance-hero-top">
        <div><span class="eyebrow">Saldo disponível em contas</span><h2>${dashboardMoney(bankCash)}</h2><p>Seu dinheiro disponível hoje, sem investimentos e sem limite de crédito.</p></div>
        <button class="privacy-button" data-action="toggle-dashboard-privacy" aria-label="${state.preferences.hideDashboardValues ? 'Mostrar valores do resumo' : 'Ocultar valores do resumo'}">${state.preferences.hideDashboardValues ? '◉' : '◌'}</button>
      </div>
      <div class="balance-flow">
        <button data-action="cash-details" data-kind="income"><span class="flow-icon income">↓</span><span><small>Entradas</small><strong>${dashboardMoney(cashBreakdown.income)}</strong></span></button>
        <button data-action="cash-details" data-kind="direct"><span class="flow-icon expense">↑</span><span><small>Gastos em conta</small><strong>${dashboardMoney(cashBreakdown.directExpenses)}</strong></span></button>
        <button data-action="cash-details" data-kind="cards"><span class="flow-icon card">▰</span><span><small>Faturas</small><strong>${dashboardMoney(cashBreakdown.cardPayments)}</strong></span></button>
      </div>
      <div class="balance-variation">
        <span>Variação do saldo em ${esc(formatMonthShort(ui.month))}</span>
        <strong class="${cashBreakdown.variation >= 0 ? 'positive' : 'warning'}">${dashboardSignedMoney(cashBreakdown.variation)}</strong>
        <small>${cashBreakdown.variation >= 0 ? 'Seu caixa aumentou neste mês.' : 'Seu caixa diminuiu, mas isso não significa saldo negativo.'}</small>
      </div>
    </section>

    <section class="quick-finance-grid">
      <article class="quick-finance-card"><span class="quick-icon">🛒</span><div><small>Consumo do mês</small><strong>${dashboardMoney(consumption)}</strong><span>${dashboardMoney(pendingCard)} pendentes no cartão</span></div></article>
      <article class="quick-finance-card"><span class="quick-icon">📈</span><div><small>Investimentos</small><strong>${dashboardMoney(investments)}</strong><span>${pluggyInvestments.length} ativos importados</span></div></article>
      <article class="quick-finance-card"><span class="quick-icon">◎</span><div><small>Patrimônio líquido</small><strong>${dashboardMoney(netWorth)}</strong><span>Contas + investimentos − cartões</span></div></article>
      <article class="quick-finance-card"><span class="quick-icon">💳</span><div><small>Cartões em aberto</small><strong>${dashboardMoney(cardDebt)}</strong><span>Pagamento não vira novo consumo</span></div></article>
    </section>

    <section class="grid two dashboard-v18-grid" style="margin-top:18px">
      <article class="card spending-card">
        <div class="card-header"><div><h2 class="card-title">Gastos por categoria</h2><p class="card-note">Compras pendentes do cartão já entram no consumo.</p></div><button class="button small" data-page="reports">Ver relatório</button></div>
        <div class="spending-overview">
          ${dashboardCategoryDonut(categories, consumption)}
          <div class="category-summary-list">${categoryRows || empty('Ainda não há gastos neste mês.')}</div>
        </div>
      </article>

      <article class="card budget-v18-card">
        <div class="card-header"><div><h2 class="card-title">Planejamento do mês</h2><p class="card-note">Acompanhe seus limites por categoria.</p></div><button class="button small" data-page="planning">Gerenciar</button></div>
        ${budgets.length ? `<div class="stack">${budgets.map(renderBudgetProgress).join('')}</div>` : empty('Crie limites para acompanhar seus gastos.')}
        ${budgetAlerts().length ? `<div class="budget-alert-summary"><span>⚠</span><div><strong>${budgetAlerts().length} categoria${budgetAlerts().length === 1 ? '' : 's'} em atenção</strong><small>Revise os limites antes do fim do mês.</small></div></div>` : ''}
      </article>
    </section>

    <section class="card dashboard-cards-section" style="margin-top:18px">
      <div class="card-header"><div><h2 class="card-title">Meus cartões</h2><p class="card-note">Fatura atual, limite disponível e vencimento em uma única visão.</p></div><button class="button small" data-page="patrimony">Ver todos</button></div>
      ${dashboardCardsPreview()}
    </section>

    <section class="grid two dashboard-v18-grid" style="margin-top:18px">
      <article class="card recent-v18-card">
        <div class="card-header"><div><h2 class="card-title">Últimas movimentações</h2><p class="card-note">Conta, cartão e transferências organizados por categoria.</p></div><button class="button small" data-page="transactions">Ver todas</button></div>
        ${recent.length ? recent.map(renderTransactionRow).join('') : empty('Nenhuma movimentação neste mês.')}
      </article>
      <article class="card attention-v18-card">
        <div class="card-header"><div><h2 class="card-title">Atenção</h2><p class="card-note">Pendências e limites do mês</p></div></div>
        <div class="stack">
          <button class="attention-tile" data-action="show-pending-transactions"><span class="attention-icon">!</span><div><strong>Transações pendentes</strong><small>${pendingRows.length} registros aguardando confirmação</small></div><b>${dashboardMoney(pending)}</b></button>
          ${budgetAlerts().slice(0, 3).map(alert => `<div class="attention-tile"><span class="attention-icon budget">◎</span><div><strong>${esc(alert.title)}</strong><small>${esc(alert.message)}</small></div><b>${alert.percent.toFixed(0)}%</b></div>`).join('') || '<div class="attention-ok"><span>✓</span><div><strong>Tudo sob controle</strong><small>Nenhum orçamento próximo do limite.</small></div></div>'}
        </div>
      </article>
    </section>`;

  return pageShell(content, `<button class="button primary desktop-add-transaction" data-action="add-transaction"><span class="desktop-label">Nova movimentação</span><span>＋</span></button>`);
}

function renderTransactions() {
  const search = ui.transactionSearch.trim().toLowerCase();
  const rows = allTransactions()
    .filter(tx => {
      const viewDate = tx.type === 'card' ? consumptionDate(tx) : transactionViewDate(tx);
      return isInMonth(viewDate);
    })
    .filter(tx => ui.transactionType === 'all' || tx.type === ui.transactionType)
    .filter(tx => ui.transactionStatus === 'all' || tx.status === ui.transactionStatus)
    .filter(tx => !search || [tx.description, localizedCategory(tx.category), tx.subcategory, tx.member, ...(tx.tags || [])].join(' ').toLowerCase().includes(search))
    .sort((a, b) => {
      const ad = a.type === 'card' ? consumptionDate(a) : transactionViewDate(a);
      const bd = b.type === 'card' ? consumptionDate(b) : transactionViewDate(b);
      return (bd || '').localeCompare(ad || '');
    });

  const groups = new Map();
  rows.forEach(tx => {
    const date = tx.type === 'card' ? consumptionDate(tx) : transactionViewDate(tx);
    const key = dateKey(date) || 'sem-data';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tx);
  });

  const groupedHtml = [...groups.entries()].map(([date, group]) => {
    const dayLabel = date === 'sem-data' ? 'Sem data' : (() => {
      const d = parseDate(date);
      const today = isoDate();
      const yesterday = shiftDateDays(today, -1);
      if (date === today) return 'Hoje';
      if (date === yesterday) return 'Ontem';
      return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'short' }).format(d);
    })();
    const net = group.reduce((sum, tx) => sum + (tx.type === 'income' ? num(tx.amount) : tx.type === 'transfer' ? 0 : -num(tx.amount)), 0);
    return `<section class="transaction-day-group">
      <div class="transaction-day-header"><strong>${esc(dayLabel)}</strong><span>${net === 0 ? '' : `${net > 0 ? '+' : '−'}${money.format(Math.abs(net))}`}</span></div>
      ${group.map(tx => renderTransactionRow(tx, true)).join('')}
    </section>`;
  }).join('');

  const content = `
    <article class="card transactions-card v18-transactions-card">
      <div class="transaction-page-summary">
        <div><small>${esc(formatMonthShort(ui.month))}</small><strong>${rows.length} movimentações</strong></div>
        <button class="button primary transaction-new-mobile" data-action="add-transaction">＋ Nova</button>
      </div>
      <div class="toolbar transaction-toolbar v18-toolbar">
        <input class="input search" id="transaction-search" placeholder="Buscar movimentação" value="${esc(ui.transactionSearch)}">
        <select class="select filter-select" id="transaction-type-filter">
          ${selectOptions([['all','Todos os tipos'],['income','Entradas'],['expense','Gastos em conta'],['card','Compras no cartão'],['card_payment','Faturas liquidadas'],['transfer','Transferências']], ui.transactionType)}
        </select>
        <select class="select filter-select" id="transaction-status-filter">
          ${selectOptions([['all','Todas'],['confirmed','Confirmadas'],['pending','Pendentes'],['ignored','Ignoradas']], ui.transactionStatus)}
        </select>
      </div>
      <div>${groupedHtml || empty('Nenhuma movimentação encontrada com estes filtros.')}</div>
    </article>`;

  return pageShell(content, `<button class="button primary desktop-add-transaction" data-action="add-transaction">＋ <span class="desktop-label">Nova</span></button>`);
}

function bottomNav() {
  return `<nav class="bottom-nav v18-bottom-nav" aria-label="Navegação principal">
    <button class="${ui.page === 'dashboard' ? 'active' : ''}" data-page="dashboard"><span class="nav-icon">⌂</span><span>Início</span></button>
    <button class="${ui.page === 'transactions' ? 'active' : ''}" data-page="transactions"><span class="nav-icon">⇄</span><span>Transações</span></button>
    <button class="bottom-add-button" data-action="add-transaction" aria-label="Nova movimentação"><span>＋</span></button>
    <button class="${ui.page === 'planning' ? 'active' : ''}" data-page="planning"><span class="nav-icon">◎</span><span>Planejar</span></button>
    <button class="${['patrimony','reports','settings'].includes(ui.page) ? 'active' : ''}" data-action="more-menu"><span class="nav-icon">•••</span><span>Mais</span></button>
  </nav>`;
}

function openMoreMenu() {
  const body = `<div class="more-menu-grid">
    <button data-action="more-page" data-target-page="patrimony"><span>▣</span><div><strong>Contas e cartões</strong><small>Saldos, faturas e investimentos</small></div></button>
    <button data-action="more-page" data-target-page="reports"><span>▥</span><div><strong>Relatórios</strong><small>Análises por período e categoria</small></div></button>
    <button data-action="more-page" data-target-page="settings"><span>⚙</span><div><strong>Configurações</strong><small>Conta, sincronização e preferências</small></div></button>
  </div>`;
  openInfoModal('Mais opções', body);
}

function openDashboardCategoryDetails(category) {
  const rows = monthConsumptionTransactions(ui.month)
    .filter(tx => localizedCategory(tx.category) === category)
    .sort((a, b) => (consumptionDate(b) || '').localeCompare(consumptionDate(a) || ''));
  const total = rows.reduce((sum, tx) => sum + num(tx.amount), 0);
  const body = `<div class="cash-detail-summary"><span>${rows.length} movimentações em ${esc(formatMonthShort(ui.month))}</span><strong>${money.format(total)}</strong></div>
    <div class="category-detail-list">${rows.length ? rows.map(tx => renderTransactionRow(tx)).join('') : empty('Nenhuma movimentação encontrada.')}</div>`;
  openInfoModal(category, body);
}


// Ações de drill-down adicionadas na v1.7.0.
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;

  if (action === 'cash-details') {
    openCashFlowDetails(button.dataset.kind || 'income');
    return;
  }

  if (action === 'show-pending-transactions') {
    ui.page = 'transactions';
    ui.transactionStatus = 'pending';
    ui.transactionType = 'all';
    ui.transactionSearch = '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if (action === 'report-category-details') {
    openReportCategoryDetails(button.dataset.category || 'Sem categoria');
  }

  if (action === 'dashboard-category-details') {
    openDashboardCategoryDetails(button.dataset.category || 'Sem categoria');
  }
});


// ===== Meu Financeiro v1.9.0 — Previsibilidade e Automação =====
// Mantém as regras financeiras da v1.7/v1.8 e adiciona planejamento futuro,
// central de revisão e regras personalizadas para dados Open Finance.

function defaultState() {
  return {
    version: APP_VERSION,
    preferences: {
      darkMode: false,
      basis: 'cash',
      hideDashboardValues: false,
      showInstallHelp: true,
      name: 'Meu Financeiro'
    },
    accounts: [],
    cards: [],
    transactions: [],
    budgets: [],
    goals: [],
    scheduledTransactions: [],
    categoryRules: [],
    transactionOverrides: [],
    reviewedPluggyIds: [],
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
    preferences: { ...base.preferences, ...(data?.preferences || {}) },
    accounts: Array.isArray(data?.accounts) ? data.accounts : base.accounts,
    cards: Array.isArray(data?.cards) ? data.cards : base.cards,
    transactions: Array.isArray(data?.transactions) ? data.transactions : base.transactions,
    budgets: Array.isArray(data?.budgets) ? data.budgets : base.budgets,
    goals: Array.isArray(data?.goals) ? data.goals : base.goals,
    scheduledTransactions: Array.isArray(data?.scheduledTransactions) ? data.scheduledTransactions : base.scheduledTransactions,
    categoryRules: Array.isArray(data?.categoryRules) ? data.categoryRules : base.categoryRules,
    transactionOverrides: Array.isArray(data?.transactionOverrides) ? data.transactionOverrides : base.transactionOverrides,
    reviewedPluggyIds: Array.isArray(data?.reviewedPluggyIds) ? data.reviewedPluggyIds : base.reviewedPluggyIds,
    categories: Array.isArray(data?.categories) ? data.categories : base.categories,
    members: Array.isArray(data?.members) ? data.members : base.members
  };
}

function hasMeaningfulData(candidate) {
  if (!candidate) return false;
  return ['accounts', 'cards', 'transactions', 'budgets', 'goals', 'scheduledTransactions', 'categoryRules']
    .some(key => Array.isArray(candidate[key]) && candidate[key].length > 0);
}

function applyV19Classification(tx) {
  if (!tx?.pluggyId) return tx;
  const result = { ...tx, tags: [...(tx.tags || [])] };
  const override = state.transactionOverrides.find(item => item.pluggyId === tx.pluggyId);
  if (override) {
    if (override.category) result.category = override.category;
    if (override.subcategory != null) result.subcategory = override.subcategory;
    if (override.member != null) result.member = override.member;
    if (Array.isArray(override.tags)) result.tags = [...override.tags];
    result.classificationSource = 'override';
    return result;
  }

  const searchable = normalizeSearchText(`${tx.description || ''} ${tx.sourceLabel || ''}`);
  const rules = [...state.categoryRules]
    .filter(rule => rule && rule.enabled !== false && String(rule.match || '').trim())
    .sort((a, b) => String(b.match || '').length - String(a.match || '').length);
  const rule = rules.find(item => searchable.includes(normalizeSearchText(item.match)));
  if (rule) {
    if (rule.category) result.category = rule.category;
    if (rule.subcategory != null) result.subcategory = rule.subcategory;
    if (rule.member != null) result.member = rule.member;
    if (Array.isArray(rule.tags) && rule.tags.length) result.tags = [...new Set([...result.tags, ...rule.tags])];
    result.classificationSource = 'rule';
    result.classificationRuleId = rule.id;
  }
  return result;
}

function openFinanceTransactions() {
  return pluggyTransactions
    .map(normalizePluggyTransaction)
    .filter(Boolean)
    .map(applyV19Classification);
}

function addReviewedPluggyId(pluggyId) {
  if (!pluggyId) return;
  if (!state.reviewedPluggyIds.includes(pluggyId)) state.reviewedPluggyIds.push(pluggyId);
  if (state.reviewedPluggyIds.length > 5000) state.reviewedPluggyIds = state.reviewedPluggyIds.slice(-5000);
}

function suggestRuleMatch(description) {
  const cleaned = String(description || '')
    .replace(/\b\d{2,}\b/g, ' ')
    .replace(/[*/#:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(word => word.length >= 3).slice(0, 4);
  return words.join(' ') || cleaned.slice(0, 40);
}

function reviewCandidates() {
  const reviewed = new Set(state.reviewedPluggyIds);
  const cutoff = shiftDateDays(isoDate(), -60);
  return openFinanceTransactions()
    .filter(tx => tx.pluggyId && !reviewed.has(tx.pluggyId))
    .filter(tx => ['expense', 'card', 'income'].includes(tx.type))
    .filter(tx => !(tx.type === 'income' && localizedCategory(tx.category) === 'Salário'))
    .filter(tx => tx.classificationSource !== 'rule' && tx.classificationSource !== 'override')
    .filter(tx => {
      const key = dateKey(tx.type === 'card' ? consumptionDate(tx) : transactionViewDate(tx));
      return !key || key >= cutoff;
    })
    .sort((a, b) => {
      const ad = dateKey(a.type === 'card' ? consumptionDate(a) : transactionViewDate(a));
      const bd = dateKey(b.type === 'card' ? consumptionDate(b) : transactionViewDate(b));
      return (bd || '').localeCompare(ad || '');
    });
}

function openReviewCenter() {
  const all = reviewCandidates();
  const rows = all.slice(0, 40);
  const body = `
    <div class="review-summary">
      <div><span>Pendentes de revisão</span><strong>${all.length}</strong></div>
      <p>Confirme as sugestões do Open Finance ou ensine uma regra. Regras novas passam a valer também para movimentações antigas com descrição semelhante.</p>
      ${all.length ? `<button class="button small" data-action="review-confirm-all">Confirmar ${Math.min(40, all.length)} sugestões exibidas</button>` : ''}
    </div>
    <div class="review-list">${rows.length ? rows.map(tx => {
      const visual = categoryVisual(localizedCategory(tx.category));
      const date = tx.type === 'card' ? consumptionDate(tx) : transactionViewDate(tx);
      return `<article class="review-row">
        <span class="category-avatar ${visual.tone}">${visual.icon}</span>
        <div class="review-main"><strong>${esc(tx.description)}</strong><small>${esc(tx.sourceLabel || 'Open Finance')} · ${formatDateBr(date)} · ${esc(localizedCategory(tx.category || 'Sem categoria'))}${tx.subcategory ? ` › ${esc(tx.subcategory)}` : ''}</small></div>
        <div class="review-value ${tx.type === 'income' ? 'positive' : 'negative'}">${tx.type === 'income' ? '+' : '−'}${money.format(tx.amount)}</div>
        <div class="review-actions"><button class="button small" data-action="review-confirm" data-pluggy-id="${esc(tx.pluggyId)}">Confirmar</button><button class="button small primary" data-action="review-classify" data-pluggy-id="${esc(tx.pluggyId)}">Classificar</button></div>
      </article>`;
    }).join('') : `<div class="review-empty"><span>✓</span><strong>Tudo revisado</strong><p>Não há movimentações recentes aguardando sua confirmação.</p></div>`}</div>
    ${all.length > 40 ? `<p class="card-note" style="margin-top:12px">Mostrando as 40 movimentações mais recentes de ${all.length}. Conforme você revisa, as próximas aparecem.</p>` : ''}`;
  openInfoModal('Revisar movimentações', body);
}

function openReviewClassifyForm(pluggyId) {
  const tx = openFinanceTransactions().find(item => item.pluggyId === pluggyId);
  if (!tx) return showToast('Movimentação não encontrada.', { tone: 'warning' });
  const formId = 'review-classify-form';
  const suggested = suggestRuleMatch(tx.description);
  const body = `<form id="${formId}" class="form-grid">
    <div class="field full"><label>Movimentação</label><div class="review-form-transaction"><strong>${esc(tx.description)}</strong><span>${money.format(tx.amount)} · ${esc(tx.sourceLabel || 'Open Finance')}</span></div></div>
    <div class="field"><label>Categoria *</label><input class="input" name="category" list="categories-list" required value="${esc(localizedCategory(tx.category || 'Outros'))}">${categoryDatalist()}</div>
    <div class="field"><label>Subcategoria</label><input class="input" name="subcategory" value="${esc(tx.subcategory || '')}" placeholder="Ex.: Supermercado"></div>
    <div class="field"><label>Membro</label><input class="input" name="member" list="members-list-review" value="${esc(tx.member || '')}"><datalist id="members-list-review">${state.members.map(item => `<option value="${esc(item)}">`).join('')}</datalist></div>
    <div class="field"><label>Tags</label><input class="input" name="tags" value="${esc((tx.tags || []).join(', '))}" placeholder="fixo, trabalho..."></div>
    <div class="field full review-rule-field"><label class="check-line"><input type="checkbox" name="createRule" checked> Criar regra automática para movimentações semelhantes</label></div>
    <div class="field full"><label>Quando a descrição contiver</label><input class="input" name="match" value="${esc(suggested)}"><div class="form-help">Exemplo: usar “UBER” faz futuras movimentações que contenham UBER receberem esta classificação. A regra também é aplicada ao histórico importado.</div></div>
  </form>`;
  openModal('Classificar movimentação', body, formId, 'Salvar classificação', true);
  document.getElementById(formId)?.addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const record = {
      pluggyId,
      category: String(data.category || '').trim() || 'Outros',
      subcategory: String(data.subcategory || '').trim(),
      member: String(data.member || '').trim(),
      tags: String(data.tags || '').split(',').map(item => item.trim()).filter(Boolean)
    };
    state.transactionOverrides = state.transactionOverrides.filter(item => item.pluggyId !== pluggyId);
    state.transactionOverrides.push(record);
    addReviewedPluggyId(pluggyId);

    if (data.createRule === 'on' && String(data.match || '').trim()) {
      const match = String(data.match).trim();
      const existing = state.categoryRules.find(rule => normalizeSearchText(rule.match) === normalizeSearchText(match));
      const ruleData = {
        match,
        category: record.category,
        subcategory: record.subcategory,
        member: record.member,
        tags: record.tags,
        enabled: true,
        updatedAt: new Date().toISOString()
      };
      if (existing) Object.assign(existing, ruleData);
      else state.categoryRules.push({ id: uid(), createdAt: new Date().toISOString(), ...ruleData });
    }

    persist();
    closeModal();
    render();
    showToast('Classificação salva e aplicada.', { tone: 'success' });
  });
}

function recurrenceLabel(value) {
  return { none: 'Única', monthly: 'Mensal', weekly: 'Semanal', yearly: 'Anual' }[value] || value || 'Única';
}

function scheduleStatusInfo(item) {
  if (item.status === 'paid') return { label: item.type === 'income' ? 'Recebido' : 'Pago', tone: 'confirmed' };
  if (item.status === 'skipped') return { label: 'Ignorado', tone: 'ignored' };
  const due = dateKey(item.dueDate);
  if (due && due < isoDate()) return { label: 'Vencido', tone: 'pending overdue' };
  return { label: item.type === 'income' ? 'A receber' : 'A pagar', tone: 'pending' };
}

function scheduledRowsForMonth(key = ui.month) {
  return state.scheduledTransactions
    .filter(item => dateKey(item.dueDate)?.slice(0, 7) === key)
    .sort((a, b) => (dateKey(a.dueDate) || '').localeCompare(dateKey(b.dueDate) || ''));
}

function createScheduledOccurrences(base, recurrence = 'none', repeatCount = 1) {
  const count = recurrence === 'none' ? 1 : clamp(Math.floor(num(repeatCount) || 1), 1, 60);
  const seriesId = count > 1 ? uid() : '';
  for (let i = 0; i < count; i++) {
    let dueDate = base.dueDate;
    if (i > 0 && recurrence === 'monthly') dueDate = shiftDateMonths(base.dueDate, i);
    if (i > 0 && recurrence === 'weekly') dueDate = shiftDateDays(base.dueDate, i * 7);
    if (i > 0 && recurrence === 'yearly') dueDate = shiftDateMonths(base.dueDate, i * 12);
    state.scheduledTransactions.push({
      ...base,
      id: uid(),
      dueDate,
      status: 'pending',
      recurrence,
      seriesId,
      occurrence: i + 1,
      occurrenceTotal: count,
      createdAt: new Date().toISOString()
    });
  }
}

function openScheduleForm(id = '', presetType = 'expense') {
  const editing = state.scheduledTransactions.find(item => item.id === id);
  const item = editing || {
    description: '', amount: '', type: presetType, dueDate: isoDate(), category: presetType === 'income' ? 'Receitas variáveis' : 'Outros',
    subcategory: '', member: '', tags: [], notes: '', recurrence: 'none', occurrenceTotal: 1
  };
  const formId = 'schedule-form';
  const body = `<form id="${formId}" class="form-grid">
    <input type="hidden" name="id" value="${esc(id)}">
    <div class="field full"><label>Descrição *</label><input class="input" name="description" required maxlength="100" value="${esc(item.description)}" placeholder="Ex.: Internet, condomínio, salário"></div>
    <div class="field"><label>Tipo *</label><select class="select" name="type">${selectOptions([['expense','Conta a pagar'],['income','Valor a receber']], item.type)}</select></div>
    <div class="field"><label>Valor *</label><input class="input" name="amount" required type="number" min="0.01" step="0.01" value="${esc(item.amount)}"></div>
    <div class="field"><label>Vencimento / previsão *</label><input class="input" name="dueDate" type="date" required value="${esc(item.dueDate)}"></div>
    <div class="field"><label>Categoria</label><input class="input" name="category" list="categories-list" value="${esc(item.category || '')}">${categoryDatalist()}</div>
    <div class="field"><label>Subcategoria</label><input class="input" name="subcategory" value="${esc(item.subcategory || '')}"></div>
    <div class="field"><label>Membro</label><input class="input" name="member" list="members-list-schedule" value="${esc(item.member || '')}"><datalist id="members-list-schedule">${state.members.map(member => `<option value="${esc(member)}">`).join('')}</datalist></div>
    ${editing ? '' : `<div class="field"><label>Recorrência</label><select class="select" name="recurrence">${selectOptions([['none','Não repetir'],['monthly','Mensal'],['weekly','Semanal'],['yearly','Anual']], item.recurrence || 'none')}</select></div>
    <div class="field"><label>Quantidade de ocorrências</label><input class="input" name="repeatCount" type="number" min="1" max="60" value="${esc(item.occurrenceTotal || 12)}"><div class="form-help">Até 60 ocorrências. Ex.: 12 para um ano de contas mensais.</div></div>`}
    <div class="field full"><label>Tags</label><input class="input" name="tags" value="${esc((item.tags || []).join(', '))}" placeholder="fixo, casa, trabalho"></div>
    <div class="field full"><label>Observações</label><textarea class="textarea" name="notes">${esc(item.notes || '')}</textarea><div class="form-help">Itens da Agenda são projeções e não entram como gasto real. O movimento efetivo continua vindo do Open Finance ou de um lançamento manual.</div></div>
  </form>`;
  openModal(editing ? 'Editar compromisso' : (presetType === 'income' ? 'Novo valor a receber' : 'Nova conta a pagar'), body, formId, editing ? 'Atualizar' : 'Adicionar', true);
  document.getElementById(formId)?.addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const base = {
      description: String(data.description || '').trim(),
      amount: num(data.amount),
      type: data.type === 'income' ? 'income' : 'expense',
      dueDate: data.dueDate,
      category: String(data.category || '').trim() || (data.type === 'income' ? 'Receitas variáveis' : 'Outros'),
      subcategory: String(data.subcategory || '').trim(),
      member: String(data.member || '').trim(),
      tags: String(data.tags || '').split(',').map(value => value.trim()).filter(Boolean),
      notes: String(data.notes || '').trim()
    };
    if (editing) Object.assign(editing, base);
    else createScheduledOccurrences(base, data.recurrence || 'none', num(data.repeatCount) || 1);
    persist(); closeModal(); render();
    showToast(editing ? 'Compromisso atualizado.' : 'Compromisso adicionado à Agenda.', { tone: 'success' });
  });
}

function nextDueDateForDay(day, from = isoDate()) {
  const d = parseDate(from);
  if (!d || !day) return '';
  const y = d.getFullYear();
  const m = d.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  let candidate = new Date(y, m, Math.min(day, last), 12);
  if (isoDate(candidate) < from) {
    const next = new Date(y, m + 1, 1, 12);
    const nextLast = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    candidate = new Date(next.getFullYear(), next.getMonth(), Math.min(day, nextLast), 12);
  }
  return isoDate(candidate);
}

function knownCardObligations(endDate = shiftDateDays(isoDate(), 45)) {
  const today = isoDate();
  const earliest = shiftDateDays(today, -45);
  const imported = pluggyAccounts
    .filter(account => String(account.type).toUpperCase() === 'CREDIT')
    .map(account => ({
      id: `card:${account.pluggy_account_id}`,
      description: `Fatura ${account.name || account.institution_name || 'Cartão'}`,
      amount: Math.max(0, num(account.balance)),
      dueDate: simpleDate(account.balance_due_date),
      type: 'card',
      source: 'Open Finance'
    }))
    .filter(item => item.amount > 0 && item.dueDate && item.dueDate >= earliest && item.dueDate <= endDate);

  const manual = state.cards.map(card => {
    const dueDate = nextDueDateForDay(num(card.dueDay), today);
    const invoiceMonth = shiftMonth(monthKey(dueDate), dueDate.slice(8, 10) <= String(num(card.dueDay)).padStart(2, '0') ? -1 : 0);
    const amount = cardInvoice(card.id, invoiceMonth);
    return { id: `manual-card:${card.id}`, description: `Fatura ${card.name}`, amount, dueDate, type: 'card', source: 'Manual' };
  }).filter(item => item.amount > 0 && item.dueDate && item.dueDate <= endDate);

  return [...imported, ...manual].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function financialProjection() {
  const today = isoDate();
  const end = monthEnd(ui.month);
  if (end < today) return { available: false, today, end, projected: totalBankCashBalance(), income: 0, expense: 0, cards: 0, scheduled: [] };
  const scheduled = state.scheduledTransactions.filter(item => item.status === 'pending' && dateKey(item.dueDate) && dateKey(item.dueDate) <= end);
  const income = scheduled.filter(item => item.type === 'income').reduce((sum, item) => sum + num(item.amount), 0);
  const expense = scheduled.filter(item => item.type === 'expense').reduce((sum, item) => sum + num(item.amount), 0);
  const cardRows = knownCardObligations(end);
  const cards = cardRows.reduce((sum, item) => sum + num(item.amount), 0);
  return {
    available: true,
    today,
    end,
    bankCash: totalBankCashBalance(),
    income,
    expense,
    cards,
    scheduled,
    cardRows,
    projected: totalBankCashBalance() + income - expense - cards
  };
}

function upcomingFinancialItems(limit = 7) {
  const today = isoDate();
  const end = shiftDateDays(today, 45);
  const schedules = state.scheduledTransactions
    .filter(item => item.status === 'pending' && dateKey(item.dueDate) && dateKey(item.dueDate) <= end)
    .map(item => ({ ...item, source: 'Agenda' }));
  return [...schedules, ...knownCardObligations(end)]
    .sort((a, b) => (dateKey(a.dueDate) || '').localeCompare(dateKey(b.dueDate) || ''))
    .slice(0, limit);
}

function renderUpcomingItem(item, compact = false) {
  const due = dateKey(item.dueDate);
  const overdue = due && due < isoDate() && item.status === 'pending';
  const isIncome = item.type === 'income';
  const icon = item.type === 'card' ? '💳' : isIncome ? '↓' : '↑';
  return `<div class="upcoming-row ${overdue ? 'is-overdue' : ''}">
    <span class="upcoming-icon ${isIncome ? 'income' : item.type === 'card' ? 'card' : 'expense'}">${icon}</span>
    <div class="upcoming-main"><strong>${esc(item.description)}</strong><small>${formatDateBr(due)}${overdue ? ' · vencido' : ''}${item.source ? ` · ${esc(item.source)}` : ''}</small></div>
    <strong class="${isIncome ? 'positive' : ''}">${isIncome ? '+' : '−'}${dashboardMoney(item.amount)}</strong>
    ${compact ? '' : `<div class="upcoming-actions">${item.type !== 'card' && item.status === 'pending' ? `<button class="button small" data-action="schedule-paid" data-id="${esc(item.id)}">${isIncome ? 'Recebi' : 'Paguei'}</button>` : ''}</div>`}
  </div>`;
}

function openCategoryRuleForm(id = '') {
  const editing = state.categoryRules.find(rule => rule.id === id);
  const rule = editing || { match: '', category: 'Outros', subcategory: '', member: '', tags: [], enabled: true };
  const formId = 'category-rule-form';
  const body = `<form id="${formId}" class="form-grid">
    <div class="field full"><label>Quando a descrição contiver *</label><input class="input" name="match" required value="${esc(rule.match || '')}" placeholder="Ex.: UBER, IFOOD, SUPERMERCADO BH"><div class="form-help">Não diferencia maiúsculas/minúsculas. Use uma expressão específica o bastante para evitar classificações erradas.</div></div>
    <div class="field"><label>Categoria *</label><input class="input" name="category" list="categories-list" required value="${esc(rule.category || 'Outros')}">${categoryDatalist()}</div>
    <div class="field"><label>Subcategoria</label><input class="input" name="subcategory" value="${esc(rule.subcategory || '')}"></div>
    <div class="field"><label>Membro</label><input class="input" name="member" list="members-list-rule" value="${esc(rule.member || '')}"><datalist id="members-list-rule">${state.members.map(member => `<option value="${esc(member)}">`).join('')}</datalist></div>
    <div class="field"><label>Tags</label><input class="input" name="tags" value="${esc((rule.tags || []).join(', '))}"></div>
    <div class="field full"><label class="check-line"><input type="checkbox" name="enabled" ${rule.enabled !== false ? 'checked' : ''}> Regra ativa</label></div>
  </form>`;
  openModal(editing ? 'Editar regra' : 'Nova regra automática', body, formId, editing ? 'Atualizar' : 'Criar regra', true);
  document.getElementById(formId)?.addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const record = {
      match: String(data.match || '').trim(),
      category: String(data.category || '').trim() || 'Outros',
      subcategory: String(data.subcategory || '').trim(),
      member: String(data.member || '').trim(),
      tags: String(data.tags || '').split(',').map(value => value.trim()).filter(Boolean),
      enabled: data.enabled === 'on',
      updatedAt: new Date().toISOString()
    };
    if (editing) Object.assign(editing, record);
    else state.categoryRules.push({ id: uid(), createdAt: new Date().toISOString(), ...record });
    persist(); closeModal(); render();
    showToast('Regra salva. A classificação foi atualizada.', { tone: 'success' });
  });
}

function renderAgendaContent() {
  ui.scheduleFilter = ui.scheduleFilter || 'all';
  const monthRows = scheduledRowsForMonth();
  const allOverdueRows = state.scheduledTransactions
    .filter(item => item.status === 'pending' && dateKey(item.dueDate) && dateKey(item.dueDate) < isoDate())
    .sort((a, b) => (dateKey(a.dueDate) || '').localeCompare(dateKey(b.dueDate) || ''));
  const pendingRows = monthRows.filter(item => item.status === 'pending');
  const income = pendingRows.filter(item => item.type === 'income').reduce((sum, item) => sum + num(item.amount), 0);
  const expense = pendingRows.filter(item => item.type === 'expense').reduce((sum, item) => sum + num(item.amount), 0);
  const overdue = allOverdueRows.reduce((sum, item) => sum + num(item.amount), 0);
  const projection = financialProjection();

  const sourceRows = ui.scheduleFilter === 'overdue' ? allOverdueRows : monthRows;
  const filtered = sourceRows.filter(item => {
    if (ui.scheduleFilter === 'pending') return item.status === 'pending';
    if (ui.scheduleFilter === 'overdue') return true;
    if (ui.scheduleFilter === 'income') return item.type === 'income';
    if (ui.scheduleFilter === 'expense') return item.type === 'expense';
    return true;
  });

  const list = filtered.map(item => {
    const status = scheduleStatusInfo(item);
    const visual = categoryVisual(item.category || 'Outros');
    const series = item.seriesId ? ` · ${item.occurrence}/${item.occurrenceTotal} · ${recurrenceLabel(item.recurrence)}` : '';
    return `<article class="schedule-row">
      <span class="category-avatar ${visual.tone}">${item.type === 'income' ? '↓' : visual.icon}</span>
      <div class="schedule-main"><strong>${esc(item.description)}</strong><small>${formatDateBr(item.dueDate)} · ${esc(item.category || 'Outros')}${series}</small></div>
      <div class="schedule-value ${item.type === 'income' ? 'positive' : 'negative'}">${item.type === 'income' ? '+' : '−'}${money.format(item.amount)}<span class="chip ${status.tone}">${status.label}</span></div>
      <div class="schedule-actions">
        ${item.status === 'pending' ? `<button class="button small" data-action="schedule-paid" data-id="${item.id}">${item.type === 'income' ? 'Recebi' : 'Paguei'}</button>` : `<button class="button small" data-action="schedule-pending" data-id="${item.id}">Reabrir</button>`}
        <button class="icon-button" data-action="edit-schedule" data-id="${item.id}" aria-label="Editar">✎</button>
        <button class="icon-button" data-action="delete-schedule" data-id="${item.id}" aria-label="Excluir">×</button>
      </div>
    </article>`;
  }).join('');

  return `<div class="agenda-v19">
    <section class="agenda-summary-grid">
      <article class="card"><span>A pagar</span><strong class="negative">${money.format(expense)}</strong><small>${esc(formatMonthShort(ui.month))}</small></article>
      <article class="card"><span>A receber</span><strong class="positive">${money.format(income)}</strong><small>${esc(formatMonthShort(ui.month))}</small></article>
      <article class="card"><span>Vencido</span><strong class="${overdue ? 'warning' : 'positive'}">${money.format(overdue)}</strong><small>Compromissos pendentes</small></article>
      <article class="card"><span>Saldo projetado</span><strong class="${projection.available && projection.projected < 0 ? 'negative' : 'positive'}">${projection.available ? money.format(projection.projected) : '—'}</strong><small>${projection.available ? `até ${formatDateBr(projection.end)}` : 'Selecione o mês atual ou futuro'}</small></article>
    </section>
    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Agenda financeira</h2><p class="card-note">Contas previstas ficam separadas das movimentações reais para evitar duplicidade com o Open Finance.</p></div><div class="row-actions"><button class="button" data-action="open-schedule-income">+ A receber</button><button class="button primary" data-action="open-schedule-expense">+ A pagar</button></div></div>
      <div class="schedule-filters">
        ${[['all','Todos'],['pending','Pendentes'],['overdue','Vencidos'],['expense','A pagar'],['income','A receber']].map(([value,label]) => `<button class="chip-filter ${ui.scheduleFilter === value ? 'active' : ''}" data-action="schedule-filter" data-filter="${value}">${label}</button>`).join('')}
      </div>
      <div class="schedule-list">${list || empty('Nenhum compromisso para este mês.')}</div>
    </article>
  </div>`;
}

function renderAutomationContent() {
  const reviewCount = reviewCandidates().length;
  const rules = [...state.categoryRules].sort((a, b) => String(a.match).localeCompare(String(b.match)));
  return `<div class="automation-v19">
    <section class="grid two">
      <article class="card review-entry-card">
        <div class="review-entry-icon">✓</div>
        <div><span>Central de revisão</span><strong>${reviewCount ? `${reviewCount} para revisar` : 'Tudo revisado'}</strong><p>Confirme categorias importadas e ensine o aplicativo a classificar descrições recorrentes.</p></div>
        <button class="button primary" data-action="open-review-center">Revisar agora</button>
      </article>
      <article class="card rule-info-card"><span>Automação ativa</span><strong>${state.categoryRules.filter(rule => rule.enabled !== false).length} regras</strong><p>As regras são aplicadas localmente aos dados da Pluggy e sincronizadas junto com o seu estado do aplicativo.</p><button class="button" data-action="open-rule">+ Nova regra</button></article>
    </section>
    <article class="card" style="margin-top:16px">
      <div class="card-header"><div><h2 class="card-title">Regras de categorização</h2><p class="card-note">Ao encontrar o texto na descrição, o Meu Financeiro substitui a categoria exibida sem alterar o dado original da Pluggy.</p></div><button class="button primary" data-action="open-rule">+ Regra</button></div>
      <div class="rule-list">${rules.length ? rules.map(rule => {
        const visual = categoryVisual(rule.category || 'Outros');
        return `<div class="rule-row ${rule.enabled === false ? 'is-disabled' : ''}">
          <span class="category-avatar ${visual.tone}">${visual.icon}</span>
          <div class="rule-main"><strong>Contém “${esc(rule.match)}”</strong><small>→ ${esc(rule.category || 'Outros')}${rule.subcategory ? ` › ${esc(rule.subcategory)}` : ''}${rule.member ? ` · ${esc(rule.member)}` : ''}</small></div>
          <span class="chip ${rule.enabled === false ? 'ignored' : 'confirmed'}">${rule.enabled === false ? 'Pausada' : 'Ativa'}</span>
          <div class="row-actions"><button class="button small" data-action="toggle-rule" data-id="${rule.id}">${rule.enabled === false ? 'Ativar' : 'Pausar'}</button><button class="icon-button" data-action="edit-rule" data-id="${rule.id}">✎</button><button class="icon-button" data-action="delete-rule" data-id="${rule.id}">×</button></div>
        </div>`;
      }).join('') : empty('Nenhuma regra criada. Classifique uma movimentação na Central de revisão para criar a primeira automaticamente.')}</div>
    </article>
  </div>`;
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

  const tab = ['agenda','budgets','goals','automation'].includes(ui.planningTab) ? ui.planningTab : 'budgets';
  const tabs = `<div class="tabs planning-v19-tabs"><button class="tab ${tab === 'agenda' ? 'active' : ''}" data-action="planning-tab" data-tab="agenda">Agenda</button><button class="tab ${tab === 'budgets' ? 'active' : ''}" data-action="planning-tab" data-tab="budgets">Orçamentos</button><button class="tab ${tab === 'goals' ? 'active' : ''}" data-action="planning-tab" data-tab="goals">Objetivos</button><button class="tab ${tab === 'automation' ? 'active' : ''}" data-action="planning-tab" data-tab="automation">Automação</button></div>`;
  const selected = tab === 'agenda' ? renderAgendaContent() : tab === 'budgets' ? budgetContent : tab === 'goals' ? goalContent : renderAutomationContent();
  return pageShell(`${tabs}${selected}`);
}

function renderDashboard() {
  const cashBreakdown = monthCashFlowBreakdown();
  const categories = categoryTotals().slice(0, 6);
  const consumption = monthConsumptionTotal();
  const pendingCard = monthPendingCardTotal();
  const bankCash = totalBankCashBalance();
  const investments = totalInvestmentBalance();
  const cardDebt = totalCreditDebt();
  const netWorth = totalNetWorth();
  const budgets = state.budgets.filter(item => item.month === ui.month).slice(0, 4);
  const recent = monthTransactions().sort((a, b) => (transactionViewDate(b) || '').localeCompare(transactionViewDate(a) || '')).slice(0, 5);
  const pendingRows = monthPendingTransactions();
  const pending = pendingRows.reduce((sum, tx) => sum + num(tx.amount), 0);
  const projection = financialProjection();
  const upcoming = upcomingFinancialItems(5);
  const reviewCount = reviewCandidates().length;
  const scheduledOverdue = state.scheduledTransactions.filter(item => item.status === 'pending' && dateKey(item.dueDate) && dateKey(item.dueDate) < isoDate()).length;
  const gettingStarted = state.accounts.length === 0 && state.transactions.length === 0 && pluggyAccounts.length === 0 && pluggyInvestments.length === 0 ? `
    <article class="card getting-started" style="margin-bottom:16px"><div class="card-header"><div><h2 class="card-title">Comece por aqui</h2><p class="card-note">Cadastre contas manualmente ou conecte seu banco pelo Open Finance.</p></div></div><div class="toolbar"><button class="button primary" data-action="connect-bank">🏦 Conectar banco</button><button class="button" data-action="add-account">+ Conta manual</button></div></article>` : '';

  const categoryRows = categories.map(item => {
    const visual = categoryVisual(item.category);
    const pct = consumption ? (item.total / consumption) * 100 : 0;
    return `<button class="category-summary-row" data-action="dashboard-category-details" data-category="${esc(visual.category)}"><span class="category-avatar ${visual.tone}">${visual.icon}</span><span class="category-summary-main"><strong>${esc(visual.category)}</strong><small>${pct.toFixed(0)}% do consumo</small></span><span class="category-summary-value">${dashboardMoney(item.total)}</span></button>`;
  }).join('');

  const content = `
    ${gettingStarted}
    <section class="balance-hero">
      <div class="balance-hero-top"><div><span class="eyebrow">Saldo disponível em contas</span><h2>${dashboardMoney(bankCash)}</h2><p>Seu dinheiro disponível hoje, sem investimentos e sem limite de crédito.</p></div><button class="privacy-button" data-action="toggle-dashboard-privacy" aria-label="${state.preferences.hideDashboardValues ? 'Mostrar valores do resumo' : 'Ocultar valores do resumo'}">${state.preferences.hideDashboardValues ? '◉' : '◌'}</button></div>
      <div class="balance-flow"><button data-action="cash-details" data-kind="income"><span class="flow-icon income">↓</span><span><small>Entradas</small><strong>${dashboardMoney(cashBreakdown.income)}</strong></span></button><button data-action="cash-details" data-kind="direct"><span class="flow-icon expense">↑</span><span><small>Gastos em conta</small><strong>${dashboardMoney(cashBreakdown.directExpenses)}</strong></span></button><button data-action="cash-details" data-kind="cards"><span class="flow-icon card">▰</span><span><small>Faturas</small><strong>${dashboardMoney(cashBreakdown.cardPayments)}</strong></span></button></div>
      <div class="balance-variation"><span>Variação do saldo em ${esc(formatMonthShort(ui.month))}</span><strong class="${cashBreakdown.variation >= 0 ? 'positive' : 'warning'}">${dashboardSignedMoney(cashBreakdown.variation)}</strong><small>${cashBreakdown.variation >= 0 ? 'Seu caixa aumentou neste mês.' : 'Seu caixa diminuiu, mas isso não significa saldo negativo.'}</small></div>
    </section>

    <section class="forecast-card ${projection.available ? '' : 'is-history'}">
      <div class="forecast-main"><div><span class="eyebrow">Saldo projetado</span><h3>${projection.available ? dashboardMoney(projection.projected) : '—'}</h3><p>${projection.available ? `Estimativa até ${formatDateBr(projection.end)} com compromissos já conhecidos.` : 'A projeção é exibida para o mês atual ou meses futuros.'}</p></div><span class="forecast-icon">↗</span></div>
      ${projection.available ? `<div class="forecast-breakdown"><div><span>Saldo hoje</span><strong>${dashboardMoney(projection.bankCash)}</strong></div><div><span>A receber</span><strong class="positive">+${dashboardMoney(projection.income)}</strong></div><div><span>Contas previstas</span><strong>−${dashboardMoney(projection.expense)}</strong></div><div><span>Faturas conhecidas</span><strong>−${dashboardMoney(projection.cards)}</strong></div></div>` : ''}
      <button class="forecast-link" data-action="open-agenda">Ver Agenda financeira →</button>
    </section>

    <section class="quick-finance-grid">
      <article class="quick-finance-card"><span class="quick-icon">🛒</span><div><small>Consumo do mês</small><strong>${dashboardMoney(consumption)}</strong><span>${dashboardMoney(pendingCard)} pendentes no cartão</span></div></article>
      <article class="quick-finance-card"><span class="quick-icon">📈</span><div><small>Investimentos</small><strong>${dashboardMoney(investments)}</strong><span>${pluggyInvestments.length} ativos importados</span></div></article>
      <article class="quick-finance-card"><span class="quick-icon">◎</span><div><small>Patrimônio líquido</small><strong>${dashboardMoney(netWorth)}</strong><span>Contas + investimentos − cartões</span></div></article>
      <article class="quick-finance-card"><span class="quick-icon">💳</span><div><small>Cartões em aberto</small><strong>${dashboardMoney(cardDebt)}</strong><span>Pagamento não vira novo consumo</span></div></article>
    </section>

    <section class="grid two dashboard-v18-grid dashboard-v19-priority" style="margin-top:18px">
      <article class="card upcoming-card"><div class="card-header"><div><h2 class="card-title">Próximos compromissos</h2><p class="card-note">Agenda + faturas conhecidas nos próximos 45 dias.</p></div><button class="button small" data-action="open-agenda">Ver agenda</button></div><div class="upcoming-list">${upcoming.length ? upcoming.map(item => renderUpcomingItem(item, true)).join('') : empty('Nenhum compromisso previsto para os próximos dias.')}</div></article>
      <article class="card review-dashboard-card"><div class="review-dashboard-top"><span class="review-dashboard-icon">✓</span><div><small>Revisão inteligente</small><strong>${reviewCount ? `${reviewCount} movimentações` : 'Tudo revisado'}</strong><p>${reviewCount ? 'Confirme categorias e crie regras para reduzir correções repetitivas.' : 'As movimentações recentes estão classificadas ou confirmadas.'}</p></div></div><button class="button ${reviewCount ? 'primary' : ''}" data-action="open-review-center">${reviewCount ? 'Revisar agora' : 'Abrir revisão'}</button>${state.categoryRules.length ? `<div class="review-rule-note">⚡ ${state.categoryRules.filter(rule => rule.enabled !== false).length} regras automáticas ativas</div>` : ''}</article>
    </section>

    <section class="grid two dashboard-v18-grid" style="margin-top:18px">
      <article class="card spending-card"><div class="card-header"><div><h2 class="card-title">Gastos por categoria</h2><p class="card-note">Compras pendentes do cartão já entram no consumo.</p></div><button class="button small" data-page="reports">Ver relatório</button></div><div class="spending-overview">${dashboardCategoryDonut(categories, consumption)}<div class="category-summary-list">${categoryRows || empty('Ainda não há gastos neste mês.')}</div></div></article>
      <article class="card budget-v18-card"><div class="card-header"><div><h2 class="card-title">Planejamento do mês</h2><p class="card-note">Acompanhe seus limites por categoria.</p></div><button class="button small" data-page="planning">Gerenciar</button></div>${budgets.length ? `<div class="stack">${budgets.map(renderBudgetProgress).join('')}</div>` : empty('Crie limites para acompanhar seus gastos.')}${budgetAlerts().length ? `<div class="budget-alert-summary"><span>⚠</span><div><strong>${budgetAlerts().length} categoria${budgetAlerts().length === 1 ? '' : 's'} em atenção</strong><small>Revise os limites antes do fim do mês.</small></div></div>` : ''}</article>
    </section>

    <section class="card dashboard-cards-section" style="margin-top:18px"><div class="card-header"><div><h2 class="card-title">Meus cartões</h2><p class="card-note">Fatura atual, limite disponível e vencimento em uma única visão.</p></div><button class="button small" data-page="patrimony">Ver todos</button></div>${dashboardCardsPreview()}</section>

    <section class="grid two dashboard-v18-grid" style="margin-top:18px">
      <article class="card recent-v18-card"><div class="card-header"><div><h2 class="card-title">Últimas movimentações</h2><p class="card-note">Conta, cartão e transferências organizados por categoria.</p></div><button class="button small" data-page="transactions">Ver todas</button></div>${recent.length ? recent.map(renderTransactionRow).join('') : empty('Nenhuma movimentação neste mês.')}</article>
      <article class="card attention-v18-card"><div class="card-header"><div><h2 class="card-title">Atenção</h2><p class="card-note">Pendências, vencimentos e limites</p></div></div><div class="stack"><button class="attention-tile" data-action="show-pending-transactions"><span class="attention-icon">!</span><div><strong>Transações pendentes</strong><small>${pendingRows.length} registros aguardando confirmação</small></div><b>${dashboardMoney(pending)}</b></button>${scheduledOverdue ? `<button class="attention-tile" data-action="open-agenda"><span class="attention-icon">📅</span><div><strong>Agenda vencida</strong><small>${scheduledOverdue} compromisso${scheduledOverdue === 1 ? '' : 's'} ainda pendente${scheduledOverdue === 1 ? '' : 's'}</small></div><b>Ver</b></button>` : ''}${budgetAlerts().slice(0, 2).map(alert => `<div class="attention-tile"><span class="attention-icon budget">◎</span><div><strong>${esc(alert.title)}</strong><small>${esc(alert.message)}</small></div><b>${alert.percent.toFixed(0)}%</b></div>`).join('') || (!scheduledOverdue ? '<div class="attention-ok"><span>✓</span><div><strong>Tudo sob controle</strong><small>Nenhum orçamento próximo do limite.</small></div></div>' : '')}</div></article>
    </section>`;
  return pageShell(content, `<button class="button primary desktop-add-transaction" data-action="add-transaction"><span class="desktop-label">Nova movimentação</span><span>＋</span></button>`);
}

function pageShell(content, extraAction = '') {
  const [title, subtitle] = PAGE_META[ui.page] || ['Meu Financeiro', 'Controle financeiro pessoal.'];
  const monthControl = ui.page === 'settings' ? '' : `<div class="month-control" aria-label="Mês selecionado"><button class="icon-button" data-action="prev-month" aria-label="Mês anterior">‹</button><div class="month-label">${esc(formatMonthShort(ui.month))}</div><button class="icon-button" data-action="next-month" aria-label="Próximo mês">›</button></div>`;
  const reviewCount = pluggyTransactions.length ? reviewCandidates().length : 0;
  return `
    <aside class="sidebar"><div class="brand"><div class="brand-mark">R$</div><div><div class="brand-title">${esc(state.preferences.name || 'Meu Financeiro')}</div><div class="brand-subtitle">Controle pessoal</div></div></div><nav class="nav">${NAV_ITEMS.map(([page, icon, label]) => `<button class="nav-button ${ui.page === page ? 'active' : ''}" data-page="${page}"><span class="nav-icon">${icon}</span>${label}</button>`).join('')}<button class="nav-button review-nav-button" data-action="open-review-center"><span class="nav-icon">✓</span>Revisar${reviewCount ? `<span class="nav-badge">${reviewCount > 99 ? '99+' : reviewCount}</span>` : ''}</button></nav><div class="sidebar-footer"><strong>☁ Sincronização segura.</strong><br>${esc(authSession?.user?.email || '')}</div></aside>
    <main class="main"><header class="topbar"><div><h1 class="page-title">${title}</h1><p class="page-subtitle">${subtitle}</p></div><div class="top-actions">${monthControl}${extraAction}<button class="icon-button" data-action="sync-now" data-sync-indicator aria-label="Atualizar todos os dados">${syncStatusInfo().icon}</button><button class="icon-button" data-page="settings" aria-label="Configurações">⚙</button></div></header>${installHelp()}${content}</main>${bottomNav()}`;
}

function openMoreMenu() {
  const reviewCount = reviewCandidates().length;
  const body = `<div class="more-menu-grid v19-more-menu">
    <button data-action="open-agenda"><span>📅</span><div><strong>Agenda financeira</strong><small>Contas, receitas e saldo projetado</small></div></button>
    <button data-action="open-review-center"><span>✓</span><div><strong>Revisar movimentações${reviewCount ? ` · ${reviewCount}` : ''}</strong><small>Categorias e regras automáticas</small></div></button>
    <button data-action="more-page" data-target-page="patrimony"><span>▣</span><div><strong>Contas e cartões</strong><small>Saldos, faturas e investimentos</small></div></button>
    <button data-action="more-page" data-target-page="reports"><span>▥</span><div><strong>Relatórios</strong><small>Análises por período e categoria</small></div></button>
    <button data-action="more-page" data-target-page="settings"><span>⚙</span><div><strong>Configurações</strong><small>Conta, sincronização e preferências</small></div></button>
  </div>`;
  openInfoModal('Mais opções', body);
}

// Ações exclusivas da v1.9.0. O listener anterior continua cuidando das ações legadas.
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;

  if (action === 'open-review-center') { closeModal(); openReviewCenter(); return; }
  if (action === 'review-confirm') {
    addReviewedPluggyId(button.dataset.pluggyId || ''); persist(); openReviewCenter(); render(); return;
  }
  if (action === 'review-confirm-all') {
    reviewCandidates().slice(0, 40).forEach(tx => addReviewedPluggyId(tx.pluggyId)); persist(); openReviewCenter(); render(); showToast('Sugestões confirmadas.', { tone: 'success' }); return;
  }
  if (action === 'review-classify') { openReviewClassifyForm(button.dataset.pluggyId || ''); return; }

  if (action === 'open-agenda') { closeModal(); ui.page = 'planning'; ui.planningTab = 'agenda'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (action === 'open-schedule-expense') { openScheduleForm('', 'expense'); return; }
  if (action === 'open-schedule-income') { openScheduleForm('', 'income'); return; }
  if (action === 'edit-schedule') { openScheduleForm(id); return; }
  if (action === 'schedule-filter') { ui.scheduleFilter = button.dataset.filter || 'all'; render(); return; }
  if (action === 'schedule-paid') {
    const item = state.scheduledTransactions.find(row => row.id === id);
    if (!item) return;
    item.status = 'paid'; item.paidAt = isoDate(); persist(); render(); showToast(item.type === 'income' ? 'Valor marcado como recebido na Agenda.' : 'Conta marcada como paga na Agenda.', { tone: 'success' }); return;
  }
  if (action === 'schedule-pending') {
    const item = state.scheduledTransactions.find(row => row.id === id);
    if (!item) return;
    item.status = 'pending'; item.paidAt = ''; persist(); render(); return;
  }
  if (action === 'delete-schedule') { confirmDelete('Excluir este compromisso da Agenda?', () => { state.scheduledTransactions = state.scheduledTransactions.filter(row => row.id !== id); }); return; }

  if (action === 'open-rule') { openCategoryRuleForm(); return; }
  if (action === 'edit-rule') { openCategoryRuleForm(id); return; }
  if (action === 'toggle-rule') {
    const rule = state.categoryRules.find(row => row.id === id); if (!rule) return; rule.enabled = rule.enabled === false; persist(); render(); return;
  }
  if (action === 'delete-rule') { confirmDelete('Excluir esta regra de categorização?', () => { state.categoryRules = state.categoryRules.filter(row => row.id !== id); }); return; }
});



// ===== Meu Financeiro v2.0.0 — Cartões e Relatórios =====
// Central de cartões, parcelas futuras, filtros avançados, comparação de períodos
// e análise explícita por Caixa x Consumo. Não altera os dados originais da Pluggy.

ui.reportMode = ui.reportMode || 'cash';
ui.reportSource = ui.reportSource || 'all';
ui.reportCategory = ui.reportCategory || 'all';
ui.reportSubcategory = ui.reportSubcategory || 'all';
ui.reportMember = ui.reportMember || 'all';
ui.reportStatus = ui.reportStatus || 'all';
ui.reportOrigin = ui.reportOrigin || 'all';
ui.reportTypeV2 = ui.reportTypeV2 || 'all';
ui.reportSearchV2 = ui.reportSearchV2 || '';
ui.cardCenterMonth = ui.cardCenterMonth || ui.month;

function v2CardCatalog() {
  const imported = pluggyAccounts
    .filter(account => String(account.type || '').toUpperCase() === 'CREDIT')
    .map(account => {
      const invoice = Math.max(0, num(account.balance));
      const available = account.available_credit_limit == null ? null : num(account.available_credit_limit);
      const limit = available == null ? null : Math.max(0, available + invoice);
      return {
        id: `pluggy-card:${account.pluggy_account_id}`,
        kind: 'openfinance',
        pluggyAccountId: account.pluggy_account_id,
        name: account.name || 'Cartão',
        institution: account.institution_name || 'MeuPluggy',
        brand: accountSubtypeLabel(account.subtype) || 'Crédito',
        currentInvoice: invoice,
        available,
        limit,
        closeDate: simpleDate(account.balance_close_date),
        dueDate: simpleDate(account.balance_due_date),
        raw: account
      };
    });

  const manual = state.cards.map(card => ({
    id: card.id,
    kind: 'manual',
    name: card.name || 'Cartão manual',
    institution: card.brand || 'Manual',
    brand: card.brand || 'Cartão',
    currentInvoice: cardInvoice(card.id, ui.month),
    available: card.limit == null ? null : num(card.limit) - cardInvoice(card.id, ui.month),
    limit: card.limit == null ? null : num(card.limit),
    closeDate: card.closingDay ? `dia ${card.closingDay}` : '',
    dueDate: card.dueDay ? `dia ${card.dueDay}` : '',
    raw: card
  }));

  return [...imported, ...manual];
}

function v2CardById(cardId) {
  return v2CardCatalog().find(card => card.id === cardId) || null;
}

function v2CardTransactions(cardId, key = ui.month, includePending = true) {
  return allTransactions()
    .filter(tx => validForCalculations(tx) && tx.type === 'card' && tx.cardId === cardId)
    .filter(tx => includePending || tx.status === 'confirmed')
    .filter(tx => isInMonth(consumptionDate(tx), key))
    .sort((a, b) => (consumptionDate(b) || '').localeCompare(consumptionDate(a) || ''));
}

function v2CardMonthTotal(cardId, key = ui.month) {
  return v2CardTransactions(cardId, key, true).reduce((sum, tx) => sum + num(tx.amount), 0);
}

function v2CardInstallmentGroups(cardId) {
  const rows = allTransactions()
    .filter(tx => validForCalculations(tx) && tx.type === 'card' && tx.cardId === cardId && num(tx.installmentTotal) > 1);
  const groups = new Map();
  for (const tx of rows) {
    const normalized = normalizeSearchText(tx.description || '').replace(/\s+/g, ' ').trim();
    const key = `${normalized}|${num(tx.amount).toFixed(2)}|${num(tx.installmentTotal)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tx);
  }
  return [...groups.values()].map(group => group.sort((a, b) => {
    const installmentDiff = num(b.installmentCurrent) - num(a.installmentCurrent);
    if (installmentDiff) return installmentDiff;
    return (consumptionDate(b) || '').localeCompare(consumptionDate(a) || '');
  }));
}

function v2ProjectedInstallments(cardId, horizonMonths = 12) {
  const projections = [];
  const horizonEnd = shiftMonth(monthKey(new Date()), horizonMonths);
  for (const group of v2CardInstallmentGroups(cardId)) {
    const latest = group[0];
    const current = Math.max(1, num(latest.installmentCurrent));
    const total = Math.max(current, num(latest.installmentTotal));
    const baseDate = consumptionDate(latest);
    if (!baseDate || current >= total) continue;
    for (let installment = current + 1; installment <= total; installment++) {
      const offset = installment - current;
      const projectedDate = shiftDateMonths(baseDate, offset);
      const projectedMonth = projectedDate.slice(0, 7);
      if (projectedMonth > horizonEnd) break;
      const alreadyExists = group.some(row => num(row.installmentCurrent) === installment && isInMonth(consumptionDate(row), projectedMonth));
      if (alreadyExists) continue;
      projections.push({
        description: latest.description,
        amount: num(latest.amount),
        installment,
        total,
        date: projectedDate,
        month: projectedMonth,
        category: localizedCategory(latest.category),
        estimated: true
      });
    }
  }
  return projections.sort((a, b) => a.date.localeCompare(b.date));
}

function v2CardCommitmentMonths(cardId, startKey = ui.month, count = 6) {
  const projected = v2ProjectedInstallments(cardId, Math.max(12, count + 2));
  const months = [];
  for (let i = 0; i < count; i++) {
    const key = shiftMonth(startKey, i);
    const actual = v2CardMonthTotal(cardId, key);
    const estimated = projected.filter(row => row.month === key).reduce((sum, row) => sum + row.amount, 0);
    months.push({ key, actual, estimated, total: actual + estimated });
  }
  return months;
}

function v2CardLimitPercent(card, selectedMonth = ui.month) {
  if (!card?.limit) return 0;
  const used = card.kind === 'openfinance' && selectedMonth === monthKey(new Date())
    ? card.currentInvoice
    : v2CardMonthTotal(card.id, selectedMonth);
  return clamp((used / card.limit) * 100, 0, 100);
}

function v2RenderCardCenter(cardId, selectedMonth = ui.cardCenterMonth || ui.month) {
  const card = v2CardById(cardId);
  if (!card) return '<div class="empty">Cartão não encontrado.</div>';
  ui.cardCenterMonth = selectedMonth;
  const rows = v2CardTransactions(card.id, selectedMonth, true);
  const monthTotal = rows.reduce((sum, tx) => sum + num(tx.amount), 0);
  const pending = rows.filter(tx => tx.status === 'pending').reduce((sum, tx) => sum + num(tx.amount), 0);
  const currentMonth = monthKey(new Date());
  const displayInvoice = card.kind === 'openfinance' && selectedMonth === currentMonth ? card.currentInvoice : monthTotal;
  const available = card.limit == null ? null : Math.max(0, card.limit - displayInvoice);
  const percent = card.limit ? clamp((displayInvoice / card.limit) * 100, 0, 100) : 0;
  const monthTabs = [-2,-1,0,1,2].map(offset => shiftMonth(selectedMonth, offset));
  const commitments = v2CardCommitmentMonths(card.id, selectedMonth, 6);
  const maxCommitment = Math.max(1, ...commitments.map(item => item.total));
  const projections = v2ProjectedInstallments(card.id, 12).filter(item => item.month >= selectedMonth).slice(0, 20);
  const groupedSeries = v2CardInstallmentGroups(card.id)
    .map(group => group[0])
    .filter(tx => num(tx.installmentCurrent) < num(tx.installmentTotal))
    .sort((a, b) => (consumptionDate(b) || '').localeCompare(consumptionDate(a) || ''))
    .slice(0, 8);

  return `<div class="v2-card-center">
    <section class="v2-card-hero">
      <div class="v2-card-hero-top"><div><small>${esc(card.institution)}</small><h3>${esc(card.name)}</h3><span>${esc(card.brand)}</span></div><div class="v2-card-chip">${card.kind === 'openfinance' ? 'Open Finance' : 'Manual'}</div></div>
      <div class="v2-card-hero-grid">
        <div><span>${card.kind === 'openfinance' && selectedMonth === currentMonth ? 'Fatura/saldo em aberto' : `Compras em ${esc(formatMonthShort(selectedMonth))}`}</span><strong>${money.format(displayInvoice)}</strong></div>
        <div><span>Limite disponível</span><strong>${available == null ? '—' : money.format(available)}</strong></div>
        <div><span>Pendente no período</span><strong>${money.format(pending)}</strong></div>
      </div>
      ${card.limit ? `<div class="v2-limit-row"><div><span>Uso do limite</span><b>${percent.toFixed(0)}%</b></div><div class="v2-limit-track"><span style="width:${percent}%"></span></div><small>Limite total estimado: ${money.format(card.limit)}</small></div>` : ''}
      <div class="v2-card-dates">${card.closeDate ? `<span>Fecha: <b>${esc(card.closeDate)}</b></span>` : ''}${card.dueDate ? `<span>Vence: <b>${esc(card.dueDate)}</b></span>` : ''}</div>
    </section>

    <div class="v2-card-month-tabs">${monthTabs.map(key => `<button class="${key === selectedMonth ? 'active' : ''}" data-action="card-center-month" data-card-id="${esc(card.id)}" data-month="${key}">${esc(formatMonthShort(key))}</button>`).join('')}</div>

    <section class="v2-card-center-section">
      <div class="v2-section-title"><div><h3>Compras do período</h3><p>${rows.length} movimentações · total ${money.format(monthTotal)}</p></div></div>
      <div class="v2-card-transaction-list">${rows.length ? rows.map(tx => renderTransactionRow(tx)).join('') : empty('Nenhuma compra encontrada neste mês.')}</div>
    </section>

    <section class="v2-card-center-section">
      <div class="v2-section-title"><div><h3>Próximos 6 meses</h3><p>Compras já registradas + parcelas futuras estimadas.</p></div></div>
      <div class="v2-card-commitments">${commitments.map(item => `<div class="v2-commitment-row"><span>${esc(formatMonthShort(item.key))}</span><div class="v2-commitment-track"><i style="width:${(item.total / maxCommitment) * 100}%"></i></div><strong>${money.format(item.total)}</strong><small>${item.estimated ? `+ ${money.format(item.estimated)} estimados` : 'registrado'}</small></div>`).join('')}</div>
    </section>

    <section class="v2-card-center-section v2-installment-section">
      <div class="v2-section-title"><div><h3>Parcelamentos em andamento</h3><p>Ajuda a enxergar quanto dos próximos meses já está comprometido.</p></div></div>
      ${groupedSeries.length ? `<div class="v2-installment-list">${groupedSeries.map(tx => `<div class="v2-installment-row"><div><strong>${esc(tx.description)}</strong><span>${esc(localizedCategory(tx.category))} · parcela ${num(tx.installmentCurrent)}/${num(tx.installmentTotal)}</span></div><div><b>${money.format(tx.amount)}</b><small>${num(tx.installmentTotal) - num(tx.installmentCurrent)} restantes</small></div></div>`).join('')}</div>` : empty('Nenhum parcelamento em andamento identificado.')}
      ${projections.length ? `<div class="v2-estimate-note">Estimativas futuras são calculadas a partir das informações de parcelamento já importadas. Elas não substituem a fatura oficial do banco.</div>` : ''}
    </section>
  </div>`;
}

function openV2CardCenter(cardId, selectedMonth = ui.cardCenterMonth || ui.month) {
  const card = v2CardById(cardId);
  if (!card) return showToast('Cartão não encontrado.', { tone: 'warning' });
  openInfoModal(`Cartão · ${card.name}`, v2RenderCardCenter(cardId, selectedMonth));
}

function dashboardCardsPreview() {
  const cards = v2CardCatalog().slice(0, 4);
  if (!cards.length) return empty('Nenhum cartão conectado ou cadastrado.');
  return `<div class="dashboard-card-strip">${cards.map(card => {
    const currentMonth = monthKey(new Date());
    const invoice = card.kind === 'openfinance' ? card.currentInvoice : v2CardMonthTotal(card.id, ui.month);
    const available = card.limit == null ? null : Math.max(0, card.limit - invoice);
    const percent = card.limit ? clamp((invoice / card.limit) * 100, 0, 100) : 0;
    return `<button class="mini-credit-card v2-mini-credit-card" data-action="open-card-center" data-card-id="${esc(card.id)}">
      <div class="mini-card-top"><div><small>${esc(card.institution)}</small><strong>${esc(card.name)}</strong></div><span>▰</span></div>
      <div class="mini-card-label">${card.kind === 'openfinance' ? 'Fatura atual' : `Compras · ${esc(formatMonthShort(ui.month))}`}</div>
      <div class="mini-card-invoice">${dashboardMoney(invoice)}</div>
      <div class="mini-card-progress"><span style="width:${percent}%"></span></div>
      <div class="mini-card-footer"><span>Disponível ${available == null ? '—' : dashboardMoney(available)}</span><span>Ver detalhes ›</span></div>
    </button>`;
  }).join('')}</div>`;
}

function renderPatrimony() {
  const cards = v2CardCatalog();
  const importedCards = cards.filter(card => card.kind === 'openfinance');
  const manualCards = cards.filter(card => card.kind === 'manual');
  const openBankCards = pluggyAccounts.filter(account => String(account.type).toUpperCase() === 'BANK').map(account => `<article class="card account-card open-finance-account"><div class="card-header"><div><div class="card-brand">OPEN FINANCE</div><h2 class="card-title">${esc(account.name)}</h2><p class="card-note">${esc(accountSubtypeLabel(account.subtype))} · ${esc(account.institution_name || 'MeuPluggy')}</p></div><span class="chip confirmed">Automática</span></div><div class="account-balance ${num(account.balance) >= 0 ? 'positive' : 'negative'}">${money.format(num(account.balance))}</div><div class="card-note">Saldo informado pela instituição</div></article>`).join('');

  const importedCardHtml = importedCards.map(card => {
    const invoice = card.currentInvoice;
    const percent = card.limit ? clamp((invoice / card.limit) * 100, 0, 100) : 0;
    return `<article class="card credit-card open-finance-account v2-credit-card"><div class="card-header"><div><div class="card-brand">OPEN FINANCE · CRÉDITO</div><h2 class="card-title">${esc(card.name)}</h2><p class="card-note">${esc(card.institution)}</p></div><span class="chip confirmed">Automático</span></div><div class="card-limit">${money.format(invoice)}</div><div class="card-note">Fatura/saldo em aberto informado pelo banco</div>${card.limit ? `<div class="progress-row" style="margin-top:16px"><div class="progress-meta"><span>Limite disponível</span><strong>${money.format(Math.max(0, card.limit - invoice))}</strong></div><div class="progress ${percent >= 100 ? 'danger' : percent >= 80 ? 'warning' : ''}"><span style="width:${percent}%"></span></div><div class="card-note">Limite total estimado: ${money.format(card.limit)}</div></div>` : ''}<div class="v2-card-actions"><button class="button primary" data-action="open-card-center" data-card-id="${esc(card.id)}">Ver fatura e parcelas</button></div></article>`;
  }).join('');

  const manualAccountCards = state.accounts.map(account => `<article class="card account-card"><div class="card-header"><div><h2 class="card-title">${esc(account.name)}</h2><p class="card-note">${esc(account.type)}${account.institution ? ` · ${esc(account.institution)}` : ''} · Manual</p></div><div class="row-actions"><button class="icon-button" data-action="edit-account" data-id="${account.id}" aria-label="Editar">✎</button><button class="icon-button" data-action="delete-account" data-id="${account.id}" aria-label="Excluir">×</button></div></div><div class="account-balance ${accountBalance(account.id) >= 0 ? 'positive' : 'negative'}">${money.format(accountBalance(account.id))}</div><div class="card-note">Saldo inicial: ${money.format(account.initialBalance)}</div></article>`).join('');

  const manualCardHtml = manualCards.map(card => {
    const invoice = v2CardMonthTotal(card.id, ui.month);
    const available = card.limit == null ? null : card.limit - invoice;
    const percent = card.limit ? clamp((invoice / card.limit) * 100, 0, 100) : 0;
    return `<article class="card credit-card v2-credit-card"><div class="card-header"><div><div class="card-brand">${esc(card.brand || 'Cartão')} · MANUAL</div><h2 class="card-title">${esc(card.name)}</h2></div><div class="row-actions"><button class="icon-button" data-action="edit-card" data-id="${card.id}" aria-label="Editar">✎</button><button class="icon-button" data-action="delete-card" data-id="${card.id}" aria-label="Excluir">×</button></div></div><div class="card-limit">${money.format(invoice)}</div><div class="card-note">Compras de ${esc(formatMonthShort(ui.month))}</div>${card.limit ? `<div class="progress-row" style="margin-top:16px"><div class="progress-meta"><span>Limite disponível</span><strong class="${available < 0 ? 'negative' : ''}">${money.format(available)}</strong></div><div class="progress ${percent >= 100 ? 'danger' : percent >= 80 ? 'warning' : ''}"><span style="width:${percent}%"></span></div></div>` : ''}<div class="v2-card-actions"><button class="button primary" data-action="open-card-center" data-card-id="${esc(card.id)}">Ver fatura e parcelas</button></div></article>`;
  }).join('');

  const openInvestmentCards = pluggyInvestments.map(investment => {
    const balance = num(investment.balance);
    const original = investment.amount_original == null ? null : num(investment.amount_original);
    const withdrawal = investment.amount_withdrawal == null ? null : num(investment.amount_withdrawal);
    const dueDate = simpleDate(investment.due_date);
    const status = investmentStatusInfo(investment.status);
    const institution = institutionForItem(investment.pluggy_item_id);
    const subtype = investmentSubtypeLabel(investment.subtype || investment.type);
    return `<article class="card investment-card"><div class="card-header"><div><div class="card-brand">INVESTIMENTO · OPEN FINANCE</div><h2 class="card-title">${esc(investment.name || subtype || 'Investimento')}</h2><p class="card-note">${esc(institution)}${subtype ? ` · ${esc(subtype)}` : ''}</p></div><span class="chip ${status.tone}">${esc(status.label)}</span></div><div class="investment-balance ${balance >= 0 ? 'positive' : 'negative'}">${money.format(balance)}</div><div class="card-note">Saldo atual informado pela instituição</div><div class="investment-details">${original != null ? `<div><span>Valor aplicado</span><strong>${money.format(original)}</strong></div>` : ''}${withdrawal != null ? `<div><span>Disponível para resgate</span><strong>${money.format(withdrawal)}</strong></div>` : ''}${investment.issuer ? `<div><span>Emissor</span><strong>${esc(investment.issuer)}</strong></div>` : ''}${dueDate ? `<div><span>Vencimento</span><strong>${shortDate.format(parseDate(dueDate))}</strong></div>` : ''}</div></article>`;
  }).join('');

  const financeSummary = pluggyDataLoading
    ? `<div class="open-finance-empty"><span class="spinner-dot"></span> Atualizando dados financeiros…</div>`
    : (pluggyAccounts.length || pluggyInvestments.length)
      ? `<div class="open-finance-summary"><span><strong>${pluggyAccounts.filter(a => String(a.type).toUpperCase() === 'BANK').length}</strong> contas</span><span><strong>${importedCards.length}</strong> cartões</span><span><strong>${pluggyInvestments.length}</strong> investimentos · ${money.format(totalInvestmentBalance())}</span><span><strong>${pluggyTransactions.length}</strong> movimentações armazenadas</span></div>`
      : '';

  const content = `<section class="card open-finance-card"><div class="card-header open-finance-header"><div><div class="open-finance-kicker">OPEN FINANCE · PLUGGY</div><h2 class="card-title">Bancos conectados</h2><p class="card-note">Um único comando sincroniza a nuvem e atualiza bancos, cartões, transações e investimentos.</p></div><div class="open-finance-actions"><button class="button" data-action="refresh-open-finance">↻ Atualizar dados</button><button class="button primary" data-action="connect-bank">🏦 Conectar banco</button></div></div>${renderPluggyConnections()}${financeSummary}</section>
    <section class="v2-patrimony-highlight" style="margin-top:26px"><div class="card-header"><div><h2 class="card-title">Central de cartões</h2><p class="card-note">Faturas, compras por mês, limite e parcelas futuras.</p></div></div><div class="grid three">${importedCardHtml || manualCardHtml ? importedCardHtml + manualCardHtml : empty('Nenhum cartão disponível.')}</div></section>
    <section style="margin-top:26px"><div class="card-header"><div><h2 class="card-title">Contas Open Finance</h2><p class="card-note">Saldos atuais informados pelas instituições conectadas.</p></div></div><div class="grid three">${openBankCards || empty(pluggyDataLoading ? 'Carregando contas…' : 'Nenhuma conta bancária importada.')}</div></section>
    <section style="margin-top:26px"><div class="card-header investment-section-header"><div><h2 class="card-title">Investimentos Open Finance</h2><p class="card-note">Posição atual dos ativos informada pelas instituições conectadas.</p></div>${pluggyInvestments.length ? `<div class="investment-summary"><span>Patrimônio investido</span><strong>${money.format(totalInvestmentBalance())}</strong></div>` : ''}</div><div class="grid three">${openInvestmentCards || empty(pluggyDataLoading ? 'Carregando investimentos…' : 'Nenhum investimento importado.')}</div></section>
    <section style="margin-top:26px"><div class="card-header"><div><h2 class="card-title">Contas manuais</h2><p class="card-note">Para contas que não estão conectadas ao Open Finance.</p></div><button class="button primary" data-action="add-account">+ Conta</button></div><div class="grid three">${manualAccountCards || empty('Nenhuma conta manual cadastrada.')}</div></section>
    <section style="margin-top:26px"><div class="card-header"><div><h2 class="card-title">Cadastrar cartão manual</h2><p class="card-note">Use para cartões fora do Open Finance.</p></div><button class="button primary" data-action="add-card">+ Cartão</button></div>${manualCards.length ? `<p class="card-note">Os cartões manuais já aparecem na Central de cartões acima.</p>` : empty('Nenhum cartão manual cadastrado.')}</section>`;
  return pageShell(content);
}

function v2TxSourceId(tx) {
  return tx.cardId || tx.accountId || tx.sourceLabel || 'sem-origem';
}

function v2TxSourceLabel(tx) {
  if (tx.origin === 'openfinance') return tx.sourceLabel || 'Open Finance';
  if (tx.type === 'card') return nameById(state.cards, tx.cardId, 'Cartão manual');
  return nameById(state.accounts, tx.accountId, 'Conta manual');
}

function v2ModeDate(tx, mode = ui.reportMode) {
  return mode === 'consumption' ? consumptionDate(tx) : cashFlowDate(tx);
}

function v2ModeCandidate(tx, mode = ui.reportMode) {
  if (mode === 'consumption') return tx.type === 'expense' || tx.type === 'card';
  return ['income', 'expense', 'card_payment'].includes(tx.type) && Boolean(tx.accountId);
}

function v2ReportBaseRows(range = reportRangeBounds(), mode = ui.reportMode) {
  return allTransactions().filter(tx => {
    if (!v2ModeCandidate(tx, mode)) return false;
    const key = dateKey(v2ModeDate(tx, mode));
    return key && key >= range.start && key <= range.end;
  });
}

function v2ReportRows(range = reportRangeBounds(), mode = ui.reportMode) {
  const search = normalizeSearchText(ui.reportSearchV2 || '');
  return v2ReportBaseRows(range, mode).filter(tx => {
    if (ui.reportSource !== 'all' && v2TxSourceId(tx) !== ui.reportSource) return false;
    if (ui.reportCategory !== 'all' && localizedCategory(tx.category) !== ui.reportCategory) return false;
    if (ui.reportSubcategory !== 'all' && String(tx.subcategory || 'Sem subcategoria') !== ui.reportSubcategory) return false;
    if (ui.reportMember !== 'all' && String(tx.member || 'Sem membro') !== ui.reportMember) return false;
    if (ui.reportStatus !== 'all' && tx.status !== ui.reportStatus) return false;
    if (ui.reportOrigin !== 'all' && tx.origin !== ui.reportOrigin) return false;
    if (ui.reportTypeV2 !== 'all' && tx.type !== ui.reportTypeV2) return false;
    if (search) {
      const haystack = normalizeSearchText([tx.description, localizedCategory(tx.category), tx.subcategory, tx.member, ...(tx.tags || []), v2TxSourceLabel(tx)].join(' '));
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function v2CalculatedRows(rows, mode = ui.reportMode) {
  return rows.filter(tx => {
    if (!validForCalculations(tx)) return false;
    if (mode === 'cash') return tx.status === 'confirmed';
    if (tx.type === 'expense') return tx.status === 'confirmed';
    if (tx.type === 'card') return tx.status === 'confirmed' || tx.status === 'pending';
    return false;
  });
}

function v2ReportMetrics(range = reportRangeBounds(), mode = ui.reportMode) {
  const rawRows = v2ReportRows(range, mode);
  const rows = v2CalculatedRows(rawRows, mode);
  if (mode === 'cash') {
    const income = rows.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + num(tx.amount), 0);
    const direct = rows.filter(tx => tx.type === 'expense').reduce((sum, tx) => sum + num(tx.amount), 0);
    const cards = rows.filter(tx => tx.type === 'card_payment').reduce((sum, tx) => sum + num(tx.amount), 0);
    return { rawRows, rows, income, direct, cards, outflow: direct + cards, variation: income - direct - cards, total: direct + cards, pending: 0 };
  }
  const direct = rows.filter(tx => tx.type === 'expense').reduce((sum, tx) => sum + num(tx.amount), 0);
  const cards = rows.filter(tx => tx.type === 'card').reduce((sum, tx) => sum + num(tx.amount), 0);
  const pending = rows.filter(tx => tx.type === 'card' && tx.status === 'pending').reduce((sum, tx) => sum + num(tx.amount), 0);
  return { rawRows, rows, income: 0, direct, cards, outflow: 0, variation: 0, total: direct + cards, pending };
}

function v2ReportCategoryTotals(range = reportRangeBounds(), mode = ui.reportMode) {
  const rows = v2ReportMetrics(range, mode).rows.filter(tx => mode === 'cash' ? tx.type === 'expense' : ['expense', 'card'].includes(tx.type));
  const map = new Map();
  rows.forEach(tx => {
    const category = localizedCategory(tx.category);
    map.set(category, (map.get(category) || 0) + num(tx.amount));
  });
  return [...map.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

function v2RangeComparisons(range = reportRangeBounds()) {
  const start = parseDate(range.start);
  const end = parseDate(range.end);
  const days = start && end ? Math.max(1, Math.round((end - start) / 86400000) + 1) : 30;
  const previousEnd = shiftDateDays(range.start, -1);
  const previousStart = shiftDateDays(previousEnd, -(days - 1));
  return {
    previous: { start: previousStart, end: previousEnd, preset: 'comparison' },
    yearAgo: { start: shiftDateMonths(range.start, -12), end: shiftDateMonths(range.end, -12), preset: 'comparison' }
  };
}

function v2PctChange(current, previous) {
  if (Math.abs(previous) < 0.005) return Math.abs(current) < 0.005 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function v2PctText(value) {
  if (value == null || !Number.isFinite(value)) return 'sem base';
  return `${value > 0 ? '+' : ''}${value.toFixed(1).replace('.', ',')}%`;
}

function v2ReportMonthlySeries(range = reportRangeBounds(), mode = ui.reportMode) {
  const rows = v2ReportMetrics(range, mode).rows;
  const grouped = new Map();
  rows.forEach(tx => {
    const key = dateKey(v2ModeDate(tx, mode)).slice(0, 7);
    if (!key) return;
    if (!grouped.has(key)) grouped.set(key, { a: 0, b: 0 });
    const bucket = grouped.get(key);
    if (mode === 'cash') {
      if (tx.type === 'income') bucket.a += num(tx.amount);
      if (tx.type === 'expense' || tx.type === 'card_payment') bucket.b += num(tx.amount);
    } else {
      if (tx.type === 'expense') bucket.a += num(tx.amount);
      if (tx.type === 'card') bucket.b += num(tx.amount);
    }
  });
  const months = [];
  let key = range.start.slice(0, 7);
  const last = range.end.slice(0, 7);
  let safety = 0;
  while (key <= last && safety < 120) {
    const bucket = grouped.get(key) || { a: 0, b: 0 };
    months.push({ key, ...bucket, total: bucket.a + bucket.b });
    key = shiftMonth(key, 1);
    safety++;
  }
  return months;
}

function v2UniqueOptions(rows, getter) {
  return [...new Set(rows.map(getter).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
}

function v2SelectOptions(values, current, allLabel) {
  return `<option value="all">${esc(allLabel)}</option>${values.map(value => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(value)}</option>`).join('')}`;
}

function v2ReportFilterCount() {
  return ['reportSource','reportCategory','reportSubcategory','reportMember','reportStatus','reportOrigin','reportTypeV2']
    .filter(key => ui[key] && ui[key] !== 'all').length + (ui.reportSearchV2 ? 1 : 0);
}

function v2ReportCategoryDetails(category) {
  const range = reportRangeBounds();
  const rows = v2ReportMetrics(range, ui.reportMode).rows
    .filter(tx => localizedCategory(tx.category) === category)
    .sort((a, b) => (v2ModeDate(b, ui.reportMode) || '').localeCompare(v2ModeDate(a, ui.reportMode) || ''));
  const total = rows.reduce((sum, tx) => sum + num(tx.amount), 0);
  const body = `<div class="category-detail-summary"><div><span>Total da categoria</span><strong>${money.format(total)}</strong></div><div><span>Movimentações</span><strong>${rows.length}</strong></div><div><span>Modo</span><strong>${ui.reportMode === 'cash' ? 'Caixa' : 'Consumo'}</strong></div><div><span>Período</span><strong>${esc(reportRangeLabel(range))}</strong></div></div><div class="category-detail-list">${rows.length ? rows.map(tx => renderTransactionRow(tx)).join('') : empty('Nenhuma movimentação encontrada.')}</div>`;
  openInfoModal(category, body);
}

function openReportCategoryDetails(category) {
  v2ReportCategoryDetails(category);
}

function renderReports() {
  const range = reportRangeBounds();
  const periodLabel = reportRangeLabel(range);
  const mode = ui.reportMode === 'consumption' ? 'consumption' : 'cash';
  const metrics = v2ReportMetrics(range, mode);
  const categories = v2ReportCategoryTotals(range, mode);
  const series = v2ReportMonthlySeries(range, mode);
  const comparisons = v2RangeComparisons(range);
  const previous = v2ReportMetrics(comparisons.previous, mode);
  const yearAgo = v2ReportMetrics(comparisons.yearAgo, mode);
  const compareMetric = mode === 'cash' ? metrics.outflow : metrics.total;
  const previousMetric = mode === 'cash' ? previous.outflow : previous.total;
  const yearMetric = mode === 'cash' ? yearAgo.outflow : yearAgo.total;
  const comparePrevious = v2PctChange(compareMetric, previousMetric);
  const compareYear = v2PctChange(compareMetric, yearMetric);
  const maxCategory = Math.max(1, ...categories.map(item => item.total));
  const maxSeries = Math.max(1, ...series.flatMap(item => [item.a, item.b]));
  const baseRows = v2ReportBaseRows(range, mode);
  const sourcesMap = new Map();
  baseRows.forEach(tx => sourcesMap.set(v2TxSourceId(tx), v2TxSourceLabel(tx)));
  const categoriesOptions = v2UniqueOptions(baseRows, tx => localizedCategory(tx.category));
  const subcategoryOptions = v2UniqueOptions(baseRows, tx => tx.subcategory || 'Sem subcategoria');
  const memberOptions = v2UniqueOptions(baseRows, tx => tx.member || 'Sem membro');
  const sourceOptions = [...sourcesMap.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  const topCategory = categories[0];
  const largest = [...metrics.rows].filter(tx => mode === 'cash' ? tx.type !== 'income' : true).sort((a, b) => num(b.amount) - num(a.amount))[0];
  const ignored = baseRows.filter(tx => tx.status === 'ignored').length;
  const pendingRaw = baseRows.filter(tx => tx.status === 'pending').length;
  const uncategorized = baseRows.filter(tx => localizedCategory(tx.category) === 'Sem categoria').length;
  const filterCount = v2ReportFilterCount();
  const presets = [['1m','1 mês'],['3m','3 meses'],['6m','6 meses'],['12m','12 meses'],['all','Todo histórico'],['custom','Personalizado']];
  const customRange = ui.reportRange === 'custom' ? `<div class="report-custom-range"><div class="field"><label>Data inicial</label><input class="input" id="report-start" type="date" value="${esc(range.start)}"></div><div class="field"><label>Data final</label><input class="input" id="report-end" type="date" value="${esc(range.end)}"></div></div>` : '';
  const typeOptions = mode === 'cash'
    ? [['all','Todos os tipos'],['income','Entradas'],['expense','Gastos em conta'],['card_payment','Faturas liquidadas']]
    : [['all','Todos os tipos'],['expense','Gastos em conta'],['card','Compras no cartão']];

  const content = `<section class="v2-report-header card">
      <div class="v2-report-title-row"><div><div class="open-finance-kicker">RELATÓRIOS 2.0</div><h2>Entenda o dinheiro por duas perspectivas</h2><p>Caixa mostra quando o dinheiro entrou ou saiu da conta. Consumo mostra quando o gasto aconteceu, incluindo compras pendentes do cartão.</p></div><div class="v2-report-mode"><button class="${mode === 'cash' ? 'active' : ''}" data-action="report-mode-v2" data-mode="cash"><span>⇄</span><strong>Caixa</strong><small>movimento bancário</small></button><button class="${mode === 'consumption' ? 'active' : ''}" data-action="report-mode-v2" data-mode="consumption"><span>🛒</span><strong>Consumo</strong><small>quando você gastou</small></button></div></div>
      <div class="report-period-presets v2-period-presets">${presets.map(([value,label]) => `<button class="button small report-period-button ${ui.reportRange === value ? 'primary active' : ''}" data-action="report-period" data-period="${value}">${label}</button>`).join('')}</div>${customRange}
    </section>

    <section class="card v2-filter-card" style="margin-top:16px"><div class="card-header"><div><h2 class="card-title">Filtros avançados</h2><p class="card-note">Combine conta/cartão, categoria, status, origem e outros campos.</p></div><div class="row-actions">${filterCount ? `<span class="chip pending">${filterCount} ativos</span>` : '<span class="chip confirmed">Sem filtros</span>'}<button class="button small" data-action="report-reset-v2">Limpar</button></div></div><div class="v2-filter-grid">
      <div class="field v2-filter-search"><label>Buscar</label><input class="input" id="v2-report-search" placeholder="Descrição, tag, categoria..." value="${esc(ui.reportSearchV2)}"></div>
      <div class="field"><label>Conta / cartão</label><select class="select" id="v2-report-source"><option value="all">Todas as origens</option>${sourceOptions.map(([value,label]) => `<option value="${esc(value)}" ${ui.reportSource === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
      <div class="field"><label>Tipo</label><select class="select" id="v2-report-type">${typeOptions.map(([value,label]) => `<option value="${value}" ${ui.reportTypeV2 === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      <div class="field"><label>Categoria</label><select class="select" id="v2-report-category">${v2SelectOptions(categoriesOptions, ui.reportCategory, 'Todas as categorias')}</select></div>
      <div class="field"><label>Subcategoria</label><select class="select" id="v2-report-subcategory">${v2SelectOptions(subcategoryOptions, ui.reportSubcategory, 'Todas as subcategorias')}</select></div>
      <div class="field"><label>Membro</label><select class="select" id="v2-report-member">${v2SelectOptions(memberOptions, ui.reportMember, 'Todos os membros')}</select></div>
      <div class="field"><label>Situação</label><select class="select" id="v2-report-status">${selectOptions([['all','Todas'],['confirmed','Confirmadas'],['pending','Pendentes'],['ignored','Ignoradas']], ui.reportStatus)}</select></div>
      <div class="field"><label>Origem</label><select class="select" id="v2-report-origin">${selectOptions([['all','Todas'],['openfinance','Open Finance'],['manual','Manual']], ui.reportOrigin)}</select></div>
    </div></section>

    ${mode === 'cash' ? `<section class="grid kpis report-kpis v2-report-kpis" style="margin-top:16px"><article class="card"><div class="kpi-label">Entradas no caixa</div><div class="kpi-value positive">${money.format(metrics.income)}</div><div class="kpi-meta">Recebimentos efetivos</div></article><article class="card"><div class="kpi-label">Gastos em conta</div><div class="kpi-value negative">${money.format(metrics.direct)}</div><div class="kpi-meta">PIX, débito e pagamentos diretos</div></article><article class="card"><div class="kpi-label">Faturas liquidadas</div><div class="kpi-value">${money.format(metrics.cards)}</div><div class="kpi-meta">Saída de caixa sem novo consumo</div></article><article class="card report-variation-card"><div class="kpi-label">Variação do caixa</div><div class="kpi-value ${metrics.variation >= 0 ? 'positive' : 'warning'}">${metrics.variation >= 0 ? '+' : '−'}${money.format(Math.abs(metrics.variation))}</div><div class="kpi-meta">Não representa saldo negativo</div></article></section>` : `<section class="grid kpis report-kpis v2-report-kpis" style="margin-top:16px"><article class="card"><div class="kpi-label">Consumo total</div><div class="kpi-value negative">${money.format(metrics.total)}</div><div class="kpi-meta">Gastos + compras no cartão</div></article><article class="card"><div class="kpi-label">Gastos em conta</div><div class="kpi-value negative">${money.format(metrics.direct)}</div><div class="kpi-meta">Despesas confirmadas</div></article><article class="card"><div class="kpi-label">Compras no cartão</div><div class="kpi-value">${money.format(metrics.cards)}</div><div class="kpi-meta">Confirmadas e pendentes</div></article><article class="card"><div class="kpi-label">Pendente no cartão</div><div class="kpi-value warning">${money.format(metrics.pending)}</div><div class="kpi-meta">Já entra no consumo</div></article></section>`}

    <section class="grid two v2-report-comparison-grid" style="margin-top:16px"><article class="card v2-comparison-card"><div class="card-header"><div><h2 class="card-title">Comparação do período</h2><p class="card-note">${mode === 'cash' ? 'Saídas efetivas' : 'Consumo'} · ${esc(periodLabel)}</p></div></div><div class="v2-comparison-main"><div><small>Período atual</small><strong>${money.format(compareMetric)}</strong></div><div><small>Período anterior</small><strong>${money.format(previousMetric)}</strong><span class="${comparePrevious != null && comparePrevious > 0 ? 'negative' : 'positive'}">${v2PctText(comparePrevious)}</span></div><div><small>Mesmo período há 1 ano</small><strong>${money.format(yearMetric)}</strong><span class="${compareYear != null && compareYear > 0 ? 'negative' : 'positive'}">${v2PctText(compareYear)}</span></div></div></article><article class="card v2-insight-card"><div class="card-header"><div><h2 class="card-title">Leituras rápidas</h2><p class="card-note">Sinais úteis a partir dos filtros atuais.</p></div></div><div class="v2-insight-list"><div><span>Maior movimentação</span><strong>${largest ? `${esc(largest.description)} · ${money.format(largest.amount)}` : '—'}</strong></div><div><span>Maior categoria</span><strong>${topCategory ? `${esc(topCategory.category)} · ${money.format(topCategory.total)}` : '—'}</strong></div><div><span>Média mensal</span><strong>${money.format(compareMetric / Math.max(1, series.length))}</strong></div><div><span>Registros no filtro</span><strong>${metrics.rawRows.length}</strong></div></div></article></section>

    <section class="grid two" style="margin-top:16px"><article class="card"><div class="card-header"><div><h2 class="card-title">${mode === 'cash' ? 'Gastos em conta por categoria' : 'Distribuição do consumo'}</h2><p class="card-note">Clique em uma categoria para abrir as movimentações.</p></div></div>${categories.length ? `<div class="chart v2-category-chart">${categories.slice(0, 12).map(item => `<button class="chart-row chart-row-button" data-action="report-category-details" data-category="${esc(item.category)}"><div class="chart-label">${esc(item.category)}</div><div class="chart-track"><div class="chart-bar" style="width:${(item.total / maxCategory) * 100}%"></div></div><div class="chart-value">${money.format(item.total)}</div></button>`).join('')}</div>` : empty('Sem dados para distribuir com os filtros atuais.')}</article><article class="card"><div class="card-header"><div><h2 class="card-title">Qualidade dos dados</h2><p class="card-note">Registros que merecem revisão antes de confiar no relatório.</p></div></div><div class="stack"><div class="list-row"><span>Pendentes no universo filtrável</span><strong class="${pendingRaw ? 'warning' : 'positive'}">${pendingRaw}</strong></div><div class="list-row"><span>Ignoradas</span><strong>${ignored}</strong></div><div class="list-row"><span>Sem categoria</span><strong class="${uncategorized ? 'warning' : 'positive'}">${uncategorized}</strong></div><div class="list-row"><span>Registros considerados no cálculo</span><strong>${metrics.rows.length}</strong></div><div class="list-row"><span>Modo financeiro</span><strong>${mode === 'cash' ? 'Caixa' : 'Consumo'}</strong></div></div></article></section>

    <article class="card" style="margin-top:16px"><div class="card-header"><div><h2 class="card-title">${mode === 'cash' ? 'Evolução do caixa' : 'Evolução do consumo'}</h2><p class="card-note">${mode === 'cash' ? 'Entradas x saídas efetivas' : 'Gastos em conta x compras no cartão'} · ${esc(periodLabel)}</p></div></div><div class="chart report-flow-chart v2-flow-chart">${series.map(item => `<div class="chart-row"><div class="chart-label">${esc(formatMonthShort(item.key))}</div><div><div class="chart-track" title="${mode === 'cash' ? 'Entradas' : 'Gastos em conta'}"><div class="chart-bar" style="width:${(item.a / maxSeries) * 100}%"></div></div><div class="chart-track" title="${mode === 'cash' ? 'Saídas' : 'Compras no cartão'}" style="margin-top:5px"><div class="chart-bar v2-secondary-bar" style="width:${(item.b / maxSeries) * 100}%"></div></div></div><div class="chart-value">${money.format(mode === 'cash' ? item.a - item.b : item.total)}</div></div>`).join('')}</div></article>

    <article class="card v2-report-transactions" style="margin-top:16px"><div class="card-header"><div><h2 class="card-title">Movimentações do relatório</h2><p class="card-note">Audite diretamente os registros que correspondem aos filtros selecionados.</p></div><span class="chip confirmed">${metrics.rawRows.length} registros</span></div><div>${metrics.rawRows.length ? metrics.rawRows.slice().sort((a,b) => (v2ModeDate(b,mode)||'').localeCompare(v2ModeDate(a,mode)||'')).slice(0,50).map(tx => renderTransactionRow(tx)).join('') : empty('Nenhuma movimentação encontrada.')}</div>${metrics.rawRows.length > 50 ? `<p class="card-note v2-report-limit-note">Mostrando as 50 movimentações mais recentes. O CSV inclui todas as ${metrics.rawRows.length}.</p>` : ''}</article>

    <article class="card" style="margin-top:16px"><div class="card-header"><div><h2 class="card-title">Exportação</h2><p class="card-note">As exportações respeitam período, modo e filtros da tela.</p></div></div><div class="toolbar"><button class="button primary" data-action="export-report-csv">Exportar movimentações filtradas</button><button class="button" data-action="export-v2-summary">Exportar resumo do relatório</button><button class="button" data-action="export-csv">Exportar tudo</button><button class="button" data-action="backup-json">Backup JSON</button></div></article>`;
  return pageShell(content);
}

function exportReportCsv() {
  const range = reportRangeBounds();
  const rows = v2ReportRows(range, ui.reportMode);
  const suffix = `${ui.reportMode}-${range.start}-a-${range.end}`;
  exportTransactionsCsv(rows, `meu-financeiro-relatorio-${suffix}.csv`, `CSV gerado com ${rows.length} movimentações e os filtros atuais.`);
}

function exportV2SummaryCsv() {
  const range = reportRangeBounds();
  const mode = ui.reportMode;
  const metrics = v2ReportMetrics(range, mode);
  const categories = v2ReportCategoryTotals(range, mode);
  const series = v2ReportMonthlySeries(range, mode);
  const q = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  const lines = [];
  lines.push(['Meu Financeiro','Relatório 2.0'].map(q).join(';'));
  lines.push(['Modo', mode === 'cash' ? 'Caixa' : 'Consumo'].map(q).join(';'));
  lines.push(['Período', `${range.start} a ${range.end}`].map(q).join(';'));
  lines.push([]);
  lines.push(['RESUMO','Indicador','Valor'].map(q).join(';'));
  if (mode === 'cash') {
    [['Resumo','Entradas',metrics.income],['Resumo','Gastos em conta',metrics.direct],['Resumo','Faturas liquidadas',metrics.cards],['Resumo','Variação do caixa',metrics.variation]].forEach(row => lines.push(row.map(q).join(';')));
  } else {
    [['Resumo','Consumo total',metrics.total],['Resumo','Gastos em conta',metrics.direct],['Resumo','Compras no cartão',metrics.cards],['Resumo','Pendente no cartão',metrics.pending]].forEach(row => lines.push(row.map(q).join(';')));
  }
  lines.push([]);
  lines.push(['CATEGORIAS','Categoria','Valor'].map(q).join(';'));
  categories.forEach(item => lines.push(['Categoria', item.category, item.total.toFixed(2).replace('.',',')].map(q).join(';')));
  lines.push([]);
  lines.push(['EVOLUÇÃO','Mês', mode === 'cash' ? 'Entradas' : 'Gastos em conta', mode === 'cash' ? 'Saídas' : 'Compras no cartão', 'Total/Variação'].map(q).join(';'));
  series.forEach(item => lines.push(['Mês', item.key, item.a.toFixed(2).replace('.',','), item.b.toFixed(2).replace('.',','), (mode === 'cash' ? item.a - item.b : item.total).toFixed(2).replace('.',',')].map(q).join(';')));
  downloadBlob(`meu-financeiro-resumo-${mode}-${range.start}-a-${range.end}.csv`, '\ufeff' + lines.join('\n'), 'text/csv;charset=utf-8');
  showToast('Resumo do relatório exportado.', { tone: 'success' });
}

function v2ResetReportFilters() {
  ui.reportSource = 'all';
  ui.reportCategory = 'all';
  ui.reportSubcategory = 'all';
  ui.reportMember = 'all';
  ui.reportStatus = 'all';
  ui.reportOrigin = 'all';
  ui.reportTypeV2 = 'all';
  ui.reportSearchV2 = '';
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'open-card-center') {
    openV2CardCenter(button.dataset.cardId || '', ui.month);
    return;
  }
  if (action === 'card-center-month') {
    openV2CardCenter(button.dataset.cardId || '', button.dataset.month || ui.month);
    return;
  }
  if (action === 'report-mode-v2') {
    ui.reportMode = button.dataset.mode === 'consumption' ? 'consumption' : 'cash';
    ui.reportTypeV2 = 'all';
    ui.reportStatus = 'all';
    render();
    return;
  }
  if (action === 'report-reset-v2') {
    v2ResetReportFilters();
    render();
    return;
  }
  if (action === 'export-v2-summary') {
    exportV2SummaryCsv();
  }
});

document.addEventListener('change', event => {
  const map = {
    'v2-report-source': 'reportSource',
    'v2-report-type': 'reportTypeV2',
    'v2-report-category': 'reportCategory',
    'v2-report-subcategory': 'reportSubcategory',
    'v2-report-member': 'reportMember',
    'v2-report-status': 'reportStatus',
    'v2-report-origin': 'reportOrigin'
  };
  const key = map[event.target.id];
  if (key) {
    ui[key] = event.target.value;
    render();
  }
});

document.addEventListener('input', event => {
  if (event.target.id !== 'v2-report-search') return;
  const value = event.target.value;
  ui.reportSearchV2 = value;
  const cursor = event.target.selectionStart ?? value.length;
  render();
  const input = document.getElementById('v2-report-search');
  if (input) {
    input.focus();
    try { input.setSelectionRange(cursor, cursor); } catch {}
  }
});



// ==========================================================
// Meu Financeiro v2.1.0 — Inteligência, Confiabilidade e Patrimônio 360°
// ==========================================================
// Esta versão preserva todas as regras financeiras da v2.0 e acrescenta:
// - Central de Inteligência com alertas transparentes e dispensáveis;
// - Saúde do Open Finance por instituição;
// - Verificações de consistência e anomalias potenciais (sem alterar dados);
// - Snapshots patrimoniais reais, gravados ao longo do uso;
// - Análise de composição patrimonial e investimentos;
// - Indicador de saúde financeira com critérios explicáveis.

if (!NAV_ITEMS.some(item => item[0] === 'intelligence')) {
  NAV_ITEMS.splice(Math.max(0, NAV_ITEMS.length - 1), 0, ['intelligence', '✦', 'Inteligência']);
}
PAGE_META.intelligence = ['Inteligência', 'Alertas, confiabilidade do Open Finance, patrimônio e investimentos em uma única visão.'];

const V21_DEFAULT_ALERT_PREFERENCES = {
  overdue: true,
  budget: true,
  cardLimit: true,
  bankStale: true,
  uncategorized: true,
  unusual: true,
  projection: true
};

const _v21DefaultStateV20 = defaultState;
defaultState = function() {
  const base = _v21DefaultStateV20();
  return {
    ...base,
    patrimonySnapshots: [],
    alertPreferences: { ...V21_DEFAULT_ALERT_PREFERENCES },
    dismissedAlerts: []
  };
};

const _v21NormalizeStateV20 = normalizeState;
normalizeState = function(data) {
  const normalized = _v21NormalizeStateV20(data || {});
  normalized.version = APP_VERSION;
  normalized.patrimonySnapshots = Array.isArray(data?.patrimonySnapshots) ? data.patrimonySnapshots : [];
  normalized.alertPreferences = { ...V21_DEFAULT_ALERT_PREFERENCES, ...(data?.alertPreferences || {}) };
  normalized.dismissedAlerts = Array.isArray(data?.dismissedAlerts) ? data.dismissedAlerts : [];
  return normalized;
};

function v21EnsureState() {
  if (!Array.isArray(state.patrimonySnapshots)) state.patrimonySnapshots = [];
  if (!state.alertPreferences || typeof state.alertPreferences !== 'object') state.alertPreferences = { ...V21_DEFAULT_ALERT_PREFERENCES };
  state.alertPreferences = { ...V21_DEFAULT_ALERT_PREFERENCES, ...state.alertPreferences };
  if (!Array.isArray(state.dismissedAlerts)) state.dismissedAlerts = [];
}

function v21CurrentCreditDebt() {
  const currentMonth = monthKey(new Date());
  const manual = state.cards.reduce((sum, card) => sum + cardInvoice(card.id, currentMonth), 0);
  const imported = pluggyAccounts
    .filter(account => String(account.type || '').toUpperCase() === 'CREDIT')
    .reduce((sum, account) => sum + Math.max(0, num(account.balance)), 0);
  return manual + imported;
}

function v21CurrentSnapshot() {
  const bankCash = totalBankCashBalance();
  const investments = totalInvestmentBalance();
  const cardDebt = v21CurrentCreditDebt();
  return {
    date: isoDate(),
    capturedAt: new Date().toISOString(),
    bankCash,
    investments,
    cardDebt,
    netWorth: bankCash + investments - cardDebt,
    bankAccounts: pluggyAccounts.filter(account => String(account.type || '').toUpperCase() === 'BANK').length + state.accounts.length,
    cards: pluggyAccounts.filter(account => String(account.type || '').toUpperCase() === 'CREDIT').length + state.cards.length,
    investmentCount: pluggyInvestments.length
  };
}

function v21SnapshotChanged(a, b) {
  if (!a || !b) return true;
  const keys = ['bankCash', 'investments', 'cardDebt', 'netWorth'];
  return keys.some(key => Math.abs(num(a[key]) - num(b[key])) >= 0.01)
    || num(a.bankAccounts) !== num(b.bankAccounts)
    || num(a.cards) !== num(b.cards)
    || num(a.investmentCount) !== num(b.investmentCount);
}

function v21RecordPatrimonySnapshot() {
  v21EnsureState();
  const snapshot = v21CurrentSnapshot();
  const index = state.patrimonySnapshots.findIndex(item => item?.date === snapshot.date);
  let changed = false;
  if (index >= 0) {
    if (v21SnapshotChanged(state.patrimonySnapshots[index], snapshot)) {
      state.patrimonySnapshots[index] = snapshot;
      changed = true;
    }
  } else {
    state.patrimonySnapshots.push(snapshot);
    changed = true;
  }
  if (state.patrimonySnapshots.length > 730) {
    state.patrimonySnapshots = state.patrimonySnapshots
      .filter(item => item?.date)
      .sort((a,b) => String(a.date).localeCompare(String(b.date)))
      .slice(-730);
    changed = true;
  }
  return changed;
}

const _v21PersistV20 = persist;
persist = function(options = {}) {
  v21EnsureState();
  v21RecordPatrimonySnapshot();
  return _v21PersistV20(options);
};

const _v21LoadOpenFinanceDataV20 = loadOpenFinanceData;
loadOpenFinanceData = async function(options = {}) {
  const result = await _v21LoadOpenFinanceDataV20(options);
  v21EnsureState();
  const changed = v21RecordPatrimonySnapshot();
  if (changed && authSession?.user?.id) _v21PersistV20();
  if (changed && ['intelligence', 'patrimony'].includes(ui.page)) render();
  return result;
};

const _v21LoadPluggyRemoteStatusV20 = loadPluggyRemoteStatus;
loadPluggyRemoteStatus = async function(options = {}) {
  const result = await _v21LoadPluggyRemoteStatusV20(options);
  if (ui.page === 'intelligence') render();
  return result;
};

function v21DateTime(value) {
  if (!value) return 'Não informado';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : shortDateTime.format(date);
}

function v21HoursSince(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, (Date.now() - time) / 3600000);
}

function v21FreshnessText(hours) {
  if (hours == null) return 'sem horário disponível';
  if (hours < 1) return 'há menos de 1 hora';
  if (hours < 24) return `há ${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} dia${days === 1 ? '' : 's'}`;
}

function v21CurrentProjection() {
  const originalMonth = ui.month;
  try {
    ui.month = monthKey(new Date());
    return financialProjection();
  } finally {
    ui.month = originalMonth;
  }
}

function v21IsoMax(values = []) {
  const valid = values.filter(Boolean).filter(value => Number.isFinite(new Date(value).getTime()));
  if (!valid.length) return '';
  return valid.sort((a,b) => new Date(b).getTime() - new Date(a).getTime())[0];
}

function v21OpenFinanceHealth() {
  const accountsByItem = new Map();
  pluggyAccounts.forEach(account => {
    const key = account.pluggy_item_id || '';
    if (!accountsByItem.has(key)) accountsByItem.set(key, []);
    accountsByItem.get(key).push(account);
  });
  const investmentsByItem = new Map();
  pluggyInvestments.forEach(investment => {
    const key = investment.pluggy_item_id || '';
    if (!investmentsByItem.has(key)) investmentsByItem.set(key, []);
    investmentsByItem.get(key).push(investment);
  });
  const accountItemMap = new Map(pluggyAccounts.map(account => [account.pluggy_account_id, account.pluggy_item_id]));
  const transactionsByItem = new Map();
  pluggyTransactions.forEach(tx => {
    const key = accountItemMap.get(tx.pluggy_account_id) || '';
    if (!transactionsByItem.has(key)) transactionsByItem.set(key, []);
    transactionsByItem.get(key).push(tx);
  });

  return pluggyItems.map(item => {
    const itemId = item.item_id;
    const remote = pluggyRemoteStatus.get(itemId) || {};
    const accounts = accountsByItem.get(itemId) || [];
    const investments = investmentsByItem.get(itemId) || [];
    const transactions = transactionsByItem.get(itemId) || [];
    const latestImport = v21IsoMax([
      item.last_sync_at,
      ...accounts.map(row => row.synced_at),
      ...investments.map(row => row.synced_at),
      ...transactions.slice(0, 100).map(row => row.synced_at)
    ]);
    const bankUpdated = remote.lastUpdatedAt || '';
    const reference = bankUpdated || latestImport;
    const hours = v21HoursSince(reference);
    const statusText = `${remote.status || ''} ${remote.executionStatus || ''} ${remote.error?.message || remote.statusDetail || ''}`.toUpperCase();
    let level = 'good';
    let label = 'Atualizado';
    if (/ERROR|FAILED|LOGIN_ERROR|ACCOUNT_NEEDS_ACTION|USER_ACTION/.test(statusText)) {
      level = 'error'; label = 'Atenção';
    } else if (hours == null) {
      level = 'unknown'; label = 'Sem histórico';
    } else if (hours > 72) {
      level = 'error'; label = 'Desatualizado';
    } else if (hours > 36) {
      level = 'warning'; label = 'Verificar';
    }
    const lastTx = transactions
      .map(tx => tx.transaction_date)
      .filter(Boolean)
      .sort((a,b) => new Date(b).getTime() - new Date(a).getTime())[0] || '';
    return {
      itemId,
      institution: institutionForItem(itemId) || item.connector_name || 'Instituição',
      level,
      label,
      hours,
      bankUpdated,
      latestImport,
      lastTx,
      accounts: accounts.length,
      cards: accounts.filter(account => String(account.type || '').toUpperCase() === 'CREDIT').length,
      investments: investments.length,
      transactions: transactions.length,
      remoteStatus: remote.status || item.status || '',
      executionStatus: remote.executionStatus || ''
    };
  });
}

function v21Median(values) {
  const sorted = values.map(num).filter(value => value > 0).sort((a,b) => a-b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function v21UncategorizedRows(days = 90) {
  const cutoff = shiftDateDays(isoDate(), -days);
  return openFinanceTransactions().filter(tx => {
    if (!['expense', 'card'].includes(tx.type) || !validForCalculations(tx)) return false;
    const key = dateKey(consumptionDate(tx));
    return key && key >= cutoff && localizedCategory(tx.category || 'Sem categoria') === 'Sem categoria';
  });
}

function v21PotentialDuplicateGroups(days = 120) {
  const cutoff = shiftDateDays(isoDate(), -days);
  const groups = new Map();
  pluggyTransactions.forEach(row => {
    const day = dateKey(row.transaction_date);
    if (!day || day < cutoff) return;
    const desc = normalizeSearchText(row.description || row.description_raw || '').replace(/\s+/g, ' ').trim();
    if (!desc || Math.abs(num(row.amount)) < 0.01) return;
    const signature = `${row.pluggy_account_id}|${day}|${Math.abs(num(row.amount)).toFixed(2)}|${desc}`;
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(row);
  });
  return [...groups.values()]
    .filter(group => new Set(group.map(row => row.pluggy_transaction_id)).size > 1)
    .sort((a,b) => b.length - a.length)
    .slice(0, 12);
}

function v21UnmatchedCardPayments(days = 90) {
  const cutoff = shiftDateDays(isoDate(), -days);
  const rawCardCredits = pluggyTransactions.filter(row => {
    const account = pluggyAccountMap.get(row.pluggy_account_id);
    return String(account?.type || '').toUpperCase() === 'CREDIT' && num(row.amount) < 0;
  });
  return openFinanceTransactions().filter(tx => {
    if (tx.type !== 'card_payment' || !String(tx.accountId || '').startsWith('pluggy-account:')) return false;
    const day = dateKey(cashFlowDate(tx));
    if (!day || day < cutoff) return false;
    const time = parseDate(day)?.getTime();
    if (!Number.isFinite(time)) return false;
    return !rawCardCredits.some(row => {
      const other = new Date(row.transaction_date).getTime();
      return Math.abs(Math.abs(num(row.amount)) - num(tx.amount)) < 0.01
        && Number.isFinite(other)
        && Math.abs(other - time) <= 3 * 86400000;
    });
  });
}

function v21UnusualConsumption(days = 60) {
  const cutoff = shiftDateDays(isoDate(), -days);
  const rows = allTransactions().filter(tx => {
    if (!['expense', 'card'].includes(tx.type) || !validForCalculations(tx)) return false;
    if (tx.type === 'expense' && tx.status !== 'confirmed') return false;
    if (tx.type === 'card' && !['confirmed', 'pending'].includes(tx.status)) return false;
    const key = dateKey(consumptionDate(tx));
    return key && key >= cutoff;
  });
  const byCategory = new Map();
  rows.forEach(tx => {
    const category = localizedCategory(tx.category || 'Sem categoria');
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(tx);
  });
  const unusual = [];
  byCategory.forEach((items, category) => {
    if (items.length < 5) return;
    const median = v21Median(items.map(item => item.amount));
    if (!median) return;
    items.forEach(tx => {
      const threshold = Math.max(500, median * 4);
      if (num(tx.amount) >= threshold) unusual.push({ tx, category, median, threshold });
    });
  });
  return unusual.sort((a,b) => num(b.tx.amount) - num(a.tx.amount)).slice(0, 12);
}

function v21Anomalies() {
  const health = v21OpenFinanceHealth();
  const uncategorized = v21UncategorizedRows();
  const duplicates = v21PotentialDuplicateGroups();
  const unmatchedCard = v21UnmatchedCardPayments();
  const unusual = v21UnusualConsumption();
  const anomalies = [];

  health.filter(item => ['warning', 'error'].includes(item.level)).forEach(item => anomalies.push({
    id: `bank-${item.itemId}`,
    severity: item.level,
    type: 'bank',
    title: `${item.institution}: coleta precisa de atenção`,
    description: item.hours == null ? 'Não há data confiável de coleta/importação.' : `Última referência ${v21FreshnessText(item.hours)}.`,
    count: 1
  }));
  if (uncategorized.length) anomalies.push({
    id: 'uncategorized', severity: 'warning', type: 'category', title: 'Movimentações sem categoria',
    description: `${uncategorized.length} movimentação${uncategorized.length === 1 ? '' : 'ões'} Open Finance dos últimos 90 dias ainda sem categoria.`, count: uncategorized.length
  });
  if (duplicates.length) anomalies.push({
    id: 'duplicates', severity: 'warning', type: 'duplicate', title: 'Possíveis lançamentos duplicados',
    description: `${duplicates.length} grupo${duplicates.length === 1 ? '' : 's'} com mesma conta, data, valor e descrição. Verifique antes de qualquer correção.`, count: duplicates.length
  });
  if (unmatchedCard.length) anomalies.push({
    id: 'card-unmatched', severity: 'unknown', type: 'card', title: 'Liquidações sem correspondência identificada',
    description: `${unmatchedCard.length} pagamento${unmatchedCard.length === 1 ? '' : 's'} de cartão não encontrou contrapartida de cartão na janela de ±3 dias. Isso pode ser normal para cartões externos.`, count: unmatchedCard.length
  });
  if (unusual.length) anomalies.push({
    id: 'unusual', severity: 'unknown', type: 'unusual', title: 'Gastos fora do padrão recente',
    description: `${unusual.length} gasto${unusual.length === 1 ? '' : 's'} ficou acima de 4× a mediana da própria categoria. É apenas um sinal de revisão, não um erro.`, count: unusual.length
  });
  return { anomalies, health, uncategorized, duplicates, unmatchedCard, unusual };
}

function v21CardUtilizationAlerts() {
  return pluggyAccounts
    .filter(account => String(account.type || '').toUpperCase() === 'CREDIT')
    .map(account => {
      const balance = Math.max(0, num(account.balance));
      const available = account.available_credit_limit == null ? null : Math.max(0, num(account.available_credit_limit));
      const limit = available == null ? null : balance + available;
      const percent = limit ? (balance / limit) * 100 : null;
      return { account, balance, available, limit, percent };
    })
    .filter(item => item.percent != null && item.percent >= 80)
    .sort((a,b) => b.percent - a.percent);
}

function v21DismissedSet() {
  v21EnsureState();
  return new Set(state.dismissedAlerts.map(item => typeof item === 'string' ? item : item?.id).filter(Boolean));
}

function v21Alerts({ includeDismissed = false } = {}) {
  v21EnsureState();
  const prefs = state.alertPreferences;
  const alerts = [];
  const today = isoDate();
  const currentMonth = monthKey(new Date());

  if (prefs.overdue) {
    const overdue = state.scheduledTransactions.filter(item => item.status === 'pending' && dateKey(item.dueDate) && dateKey(item.dueDate) < today);
    if (overdue.length) {
      const total = overdue.reduce((sum, item) => sum + num(item.amount), 0);
      alerts.push({ id: `overdue-${today}`, severity: 'error', icon: '!', title: `${overdue.length} compromisso${overdue.length === 1 ? '' : 's'} vencido${overdue.length === 1 ? '' : 's'}`, description: `${money.format(total)} aguardando baixa na Agenda.`, action: 'planning' });
    }
  }

  if (prefs.budget) {
    const currentBudgets = state.budgets.filter(item => item.month === currentMonth);
    currentBudgets.forEach(budget => {
      const spent = budgetSpent(budget);
      const percent = num(budget.limit) ? (spent / num(budget.limit)) * 100 : 0;
      if (percent >= Math.min(80, num(budget.alertAt) || 80)) alerts.push({
        id: `budget-${currentMonth}-${budget.id || budget.category}`,
        severity: percent >= 100 ? 'error' : 'warning', icon: '◎',
        title: `${budget.category}: ${percent.toFixed(0)}% do orçamento`,
        description: `${money.format(spent)} de ${money.format(budget.limit)} utilizados.`, action: 'planning'
      });
    });
  }

  if (prefs.cardLimit) {
    v21CardUtilizationAlerts().forEach(item => alerts.push({
      id: `card-limit-${currentMonth}-${item.account.pluggy_account_id}`,
      severity: item.percent >= 95 ? 'error' : 'warning', icon: '▰',
      title: `${item.account.name || 'Cartão'} em ${item.percent.toFixed(0)}% do limite`,
      description: `Em aberto ${money.format(item.balance)}${item.available != null ? ` · disponível ${money.format(item.available)}` : ''}.`, action: 'patrimony'
    }));
  }

  if (prefs.bankStale) {
    v21OpenFinanceHealth().filter(item => ['warning','error'].includes(item.level)).forEach(item => alerts.push({
      id: `bank-stale-${today}-${item.itemId}`, severity: item.level, icon: '🏦',
      title: `${item.institution} precisa ser atualizado`,
      description: item.hours == null ? 'Sem horário confiável de atualização.' : `Última referência ${v21FreshnessText(item.hours)}.`, action: 'intelligence'
    }));
  }

  if (prefs.uncategorized) {
    const uncategorized = v21UncategorizedRows(30);
    if (uncategorized.length) alerts.push({
      id: `uncategorized-${currentMonth}`, severity: 'warning', icon: '?',
      title: `${uncategorized.length} movimentação${uncategorized.length === 1 ? '' : 'ões'} sem categoria`,
      description: 'Revise para melhorar orçamentos e relatórios.', action: 'review'
    });
  }

  if (prefs.unusual) {
    const unusual = v21UnusualConsumption(45);
    if (unusual.length) alerts.push({
      id: `unusual-${currentMonth}`, severity: 'unknown', icon: '↗',
      title: `${unusual.length} gasto${unusual.length === 1 ? '' : 's'} fora do padrão`,
      description: 'Valores acima de 4× a mediana recente da categoria. Confira se fazem sentido.', action: 'intelligence'
    });
  }

  if (prefs.projection) {
    const projection = v21CurrentProjection();
    if (projection.available && projection.projected < 0) alerts.push({
      id: `projection-${currentMonth}`, severity: 'error', icon: '◌',
      title: 'Saldo projetado negativo',
      description: `A projeção até ${formatDateBr(projection.end)} está em ${money.format(projection.projected)}.`, action: 'planning'
    });
  }

  const dismissed = v21DismissedSet();
  return (includeDismissed ? alerts : alerts.filter(alert => !dismissed.has(alert.id)))
    .sort((a,b) => ({error:0, warning:1, unknown:2, good:3}[a.severity] ?? 9) - ({error:0, warning:1, unknown:2, good:3}[b.severity] ?? 9));
}

function v21CategorizationQuality() {
  const cutoff = shiftDateDays(isoDate(), -60);
  const rows = allTransactions().filter(tx => {
    if (!['expense','card'].includes(tx.type) || !validForCalculations(tx)) return false;
    const day = dateKey(consumptionDate(tx));
    return day && day >= cutoff;
  });
  if (!rows.length) return { percent: 100, total: 0, uncategorized: 0 };
  const uncategorized = rows.filter(tx => localizedCategory(tx.category || 'Sem categoria') === 'Sem categoria').length;
  return { percent: Math.max(0, ((rows.length - uncategorized) / rows.length) * 100), total: rows.length, uncategorized };
}

function v21HealthScore() {
  const bankHealth = v21OpenFinanceHealth();
  let dataScore = 30;
  if (bankHealth.length) {
    const values = bankHealth.map(item => item.level === 'good' ? 30 : item.level === 'unknown' ? 18 : item.level === 'warning' ? 15 : 5);
    dataScore = values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  const categoryQuality = v21CategorizationQuality();
  const categoryScore = 20 * (categoryQuality.percent / 100);

  const currentMonth = monthKey(new Date());
  const hasBudget = state.budgets.some(item => item.month === currentMonth);
  const hasAgenda = state.scheduledTransactions.some(item => item.status === 'pending' && dateKey(item.dueDate) >= monthStart(currentMonth));
  const planningScore = (hasBudget ? 10 : 0) + (hasAgenda ? 10 : 0);

  const projection = v21CurrentProjection();
  let liquidityScore = 15;
  if (totalBankCashBalance() < 0) liquidityScore = 0;
  else if (projection.available && projection.projected < 0) liquidityScore = 5;

  const cardAlerts = v21CardUtilizationAlerts();
  let cardScore = 15;
  if (cardAlerts.some(item => item.percent >= 95)) cardScore = 3;
  else if (cardAlerts.some(item => item.percent >= 80)) cardScore = 8;

  const score = Math.round(clamp(dataScore + categoryScore + planningScore + liquidityScore + cardScore, 0, 100));
  return {
    score,
    parts: [
      { label: 'Confiabilidade dos dados', score: dataScore, max: 30 },
      { label: 'Categorização', score: categoryScore, max: 20 },
      { label: 'Planejamento', score: planningScore, max: 20 },
      { label: 'Liquidez projetada', score: liquidityScore, max: 15 },
      { label: 'Uso dos cartões', score: cardScore, max: 15 }
    ],
    categoryQuality,
    projection
  };
}

function v21ScoreLabel(score) {
  if (score >= 85) return 'Muito boa';
  if (score >= 70) return 'Boa';
  if (score >= 50) return 'Atenção';
  return 'Precisa de revisão';
}

function v21MonthlySnapshots() {
  v21EnsureState();
  const sorted = state.patrimonySnapshots
    .filter(item => item?.date)
    .slice()
    .sort((a,b) => String(a.date).localeCompare(String(b.date)));
  const map = new Map();
  sorted.forEach(item => map.set(String(item.date).slice(0,7), item));
  return [...map.values()].slice(-12);
}

function v21InvestmentAnalytics() {
  const active = pluggyInvestments.filter(item => !['TOTAL_WITHDRAWAL','MATURED','INACTIVE'].includes(String(item.status || '').toUpperCase()));
  const total = active.reduce((sum, item) => sum + Math.max(0, num(item.balance)), 0);
  const original = active.reduce((sum, item) => sum + Math.max(0, num(item.amount_original)), 0);
  const profitRows = active.filter(item => item.amount_profit != null && Number.isFinite(num(item.amount_profit)));
  const profit = profitRows.reduce((sum, item) => sum + num(item.amount_profit), 0);
  const withdrawalRows = active.filter(item => item.amount_withdrawal != null);
  const withdrawal = withdrawalRows.reduce((sum, item) => sum + Math.max(0, num(item.amount_withdrawal)), 0);
  const byType = new Map();
  const byInstitution = new Map();
  active.forEach(item => {
    const value = Math.max(0, num(item.balance));
    const type = investmentTypeLabel(item.type || item.subtype || 'OTHER');
    const institution = institutionForItem(item.pluggy_item_id);
    byType.set(type, (byType.get(type) || 0) + value);
    byInstitution.set(institution, (byInstitution.get(institution) || 0) + value);
  });
  const today = isoDate();
  const horizon = shiftDateDays(today, 180);
  const maturities = active.filter(item => {
    const due = simpleDate(item.due_date);
    return due && due >= today && due <= horizon;
  }).sort((a,b) => simpleDate(a.due_date).localeCompare(simpleDate(b.due_date)));
  return {
    active,
    total,
    original,
    profit,
    profitAvailable: profitRows.length > 0,
    withdrawal,
    withdrawalAvailable: withdrawalRows.length > 0,
    returnPercent: original > 0 && profitRows.length ? (profit / original) * 100 : null,
    byType: [...byType.entries()].map(([label,value]) => ({label,value})).sort((a,b) => b.value-a.value),
    byInstitution: [...byInstitution.entries()].map(([label,value]) => ({label,value})).sort((a,b) => b.value-a.value),
    maturities
  };
}

function v21SeverityChip(level) {
  if (level === 'good') return 'confirmed';
  if (level === 'warning') return 'pending';
  if (level === 'error') return 'v21-error-chip';
  return 'ignored';
}

function v21RenderAlerts(alerts = v21Alerts()) {
  if (!alerts.length) return `<div class="v21-empty-good"><span>✓</span><div><strong>Nenhum alerta prioritário</strong><p>Os critérios habilitados não encontraram pendências importantes agora.</p></div></div>`;
  return `<div class="v21-alert-list">${alerts.map(alert => {
    let actionButton = '';
    if (alert.action === 'review') {
      actionButton = `<button class="button small" data-action="open-review-center">Revisar</button>`;
    } else if (String(alert.id || '').startsWith('unusual-')) {
      actionButton = `<button class="button small" data-action="v21-alert-details" data-alert-kind="unusual">Detalhes</button>`;
    } else if (String(alert.id || '').startsWith('bank-stale-')) {
      actionButton = `<button class="button small" data-action="v21-alert-details" data-alert-kind="bank" data-alert-id="${esc(alert.id)}">Detalhes</button>`;
    } else if (alert.action) {
      actionButton = `<button class="button small" data-page="${esc(alert.action)}">Abrir</button>`;
    }
    return `<article class="v21-alert-row ${alert.severity}">
      <span class="v21-alert-icon">${esc(alert.icon || '!')}</span>
      <div class="v21-alert-main"><strong>${esc(alert.title)}</strong><small>${esc(alert.description)}</small></div>
      <div class="v21-alert-actions">${actionButton}<button class="icon-button v21-dismiss" data-action="v21-dismiss-alert" data-alert-id="${esc(alert.id)}" aria-label="Dispensar alerta">×</button></div>
    </article>`;
  }).join('')}</div>`;
}

function v21OpenAlertDetails(kind, alertId = '') {
  if (kind === 'unusual') {
    const unusual = v21UnusualConsumption(45);
    const rows = unusual.map(item => {
      const tx = item.tx;
      const ratio = item.median > 0 ? num(tx.amount) / item.median : 0;
      return `<div class="v21-detail-row v211-unusual-detail"><div><strong>${esc(tx.description || 'Movimentação')}</strong><small>${esc(item.category)} · ${formatDateBr(consumptionDate(tx))} · ${esc(tx.sourceLabel || (tx.origin === 'openfinance' ? 'Open Finance' : 'Manual'))}</small><small>Mediana recente ${money.format(item.median)} · este gasto foi ${ratio.toFixed(1).replace('.', ',')}× a mediana</small></div><span class="chip ignored">fora do padrão</span><strong>${money.format(tx.amount)}</strong></div>`;
    }).join('');
    const total = unusual.reduce((sum, item) => sum + num(item.tx.amount), 0);
    const body = `<div class="cash-detail-summary"><span>${unusual.length} gasto${unusual.length === 1 ? '' : 's'} sinalizado${unusual.length === 1 ? '' : 's'} nos últimos 45 dias</span><strong>${money.format(total)}</strong></div><p class="card-note" style="margin:12px 0 16px">O alerta compara cada gasto com a mediana recente da mesma categoria. Ele é apenas um sinal de revisão e não altera nenhuma movimentação.</p><div class="v21-detail-section">${rows || empty('Nenhum gasto fora do padrão encontrado agora.')}</div>`;
    openInfoModal('Gastos fora do padrão · detalhes', body);
    return;
  }

  if (kind === 'bank') {
    const health = v21OpenFinanceHealth();
    const itemId = String(alertId || '').replace(/^bank-stale-\d{4}-\d{2}-\d{2}-/, '');
    const rows = health.filter(item => !itemId || item.itemId === itemId).map(item => `<div class="v21-detail-row"><div><strong>${esc(item.institution)}</strong><small>${item.hours == null ? 'Sem horário confiável de atualização' : `Última referência ${v21FreshnessText(item.hours)}`}</small></div><span class="chip ${item.level === 'good' ? 'confirmed' : item.level === 'warning' ? 'pending' : 'ignored'}">${esc(item.label || item.level)}</span></div>`).join('');
    openInfoModal('Saúde do Open Finance · detalhes', `<div class="v21-detail-section">${rows || empty('Nenhuma conexão correspondente encontrada.')}</div><div class="toolbar" style="margin-top:14px"><button class="button primary" data-action="refresh-open-finance">↻ Atualizar todos os dados</button></div>`);
  }
}

function v21DashboardBanner() {
  const alerts = v21Alerts().slice(0, 3);
  const score = v21HealthScore();
  if (!alerts.length && score.score >= 85) return `<button class="v21-dashboard-health compact good" data-page="intelligence"><span>✦</span><div><strong>Saúde financeira ${score.score}/100</strong><small>Nenhum alerta prioritário · ver detalhes</small></div><b>›</b></button>`;
  return `<button class="v21-dashboard-health ${alerts.some(item => item.severity === 'error') ? 'attention' : ''}" data-page="intelligence"><span>✦</span><div><strong>Saúde financeira ${score.score}/100 · ${v21ScoreLabel(score.score)}</strong><small>${alerts.length ? `${alerts.length} alerta${alerts.length === 1 ? '' : 's'} prioritário${alerts.length === 1 ? '' : 's'} · toque para revisar` : 'Veja os critérios e a evolução do patrimônio'}</small></div><b>›</b></button>`;
}

function v21PatrimonyStrip() {
  const snapshot = v21CurrentSnapshot();
  const investment = v21InvestmentAnalytics();
  return `<section class="v21-patrimony-strip">
    <div><span>Patrimônio líquido</span><strong class="${snapshot.netWorth >= 0 ? 'positive' : 'negative'}">${money.format(snapshot.netWorth)}</strong></div>
    <div><span>Disponível em contas</span><strong>${money.format(snapshot.bankCash)}</strong></div>
    <div><span>Investimentos</span><strong>${money.format(snapshot.investments)}</strong></div>
    <div><span>Cartões em aberto</span><strong>${money.format(snapshot.cardDebt)}</strong></div>
    <button class="button small" data-page="intelligence">Patrimônio 360°</button>
  </section>`;
}

function v21RenderOpenFinanceHealth(health) {
  if (!health.length) return empty('Nenhuma conexão Open Finance cadastrada.');
  return `<div class="v21-bank-health-list">${health.map(item => `<article class="v21-bank-health-row">
    <span class="v21-health-dot ${item.level}"></span>
    <div class="v21-bank-main"><strong>${esc(item.institution)}</strong><small>${item.accounts} conta${item.accounts === 1 ? '' : 's'} · ${item.cards} cartão${item.cards === 1 ? '' : 'ões'} · ${item.transactions} transações</small><small>Coleta: ${item.bankUpdated ? `${v21DateTime(item.bankUpdated)} (${v21FreshnessText(v21HoursSince(item.bankUpdated))})` : 'não informada'}</small><small>Importação: ${item.latestImport ? v21DateTime(item.latestImport) : 'não informada'}${item.lastTx ? ` · última transação ${formatDateBr(dateKey(item.lastTx))}` : ''}</small></div>
    <span class="chip ${v21SeverityChip(item.level)}">${esc(item.label)}</span>
  </article>`).join('')}</div>`;
}

function v21RenderAnomalies(bundle) {
  if (!bundle.anomalies.length) return `<div class="v21-empty-good"><span>✓</span><div><strong>Nenhum sinal de inconsistência</strong><p>As verificações automáticas não encontraram padrões que mereçam revisão.</p></div></div>`;
  return `<div class="v21-anomaly-list">${bundle.anomalies.map(item => `<article class="v21-anomaly-row"><span class="v21-health-dot ${item.severity}"></span><div><strong>${esc(item.title)}</strong><small>${esc(item.description)}</small></div><span class="chip ${v21SeverityChip(item.severity)}">${item.count}</span></article>`).join('')}</div>
    <p class="v21-disclaimer">Estas verificações são heurísticas. “Possível duplicidade” ou “fora do padrão” não significa erro; nenhuma movimentação é alterada automaticamente.</p>`;
}

function v21RenderPatrimonyEvolution() {
  const snapshots = v21MonthlySnapshots();
  if (!snapshots.length) return empty('O histórico patrimonial começa a ser registrado na v2.1.0.');
  const values = snapshots.map(item => num(item.netWorth));
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = Math.max(1, max - min);
  return `<div class="v21-wealth-chart">${snapshots.map(item => {
    const pct = clamp(((num(item.netWorth) - min) / span) * 100, 4, 100);
    return `<div class="v21-wealth-row"><span>${esc(formatMonthShort(item.date.slice(0,7)))}</span><div class="v21-wealth-track"><i style="width:${pct}%"></i></div><strong class="${num(item.netWorth) >= 0 ? 'positive' : 'negative'}">${money.format(item.netWorth)}</strong></div>`;
  }).join('')}</div><p class="v21-disclaimer">Snapshots usam saldos reais disponíveis no momento da sincronização. O histórico não é retroativo antes da v2.1.0.</p>`;
}

function v21RenderAllocation(snapshot) {
  const assets = Math.max(0, snapshot.bankCash) + Math.max(0, snapshot.investments);
  const cashPct = assets ? Math.max(0, snapshot.bankCash) / assets * 100 : 0;
  const invPct = assets ? Math.max(0, snapshot.investments) / assets * 100 : 0;
  const debtRatio = assets ? snapshot.cardDebt / assets * 100 : 0;
  return `<div class="v21-allocation">
    <div class="v21-allocation-total"><span>Ativos</span><strong>${money.format(assets)}</strong><small>Dívida de cartões: ${money.format(snapshot.cardDebt)} (${debtRatio.toFixed(1)}% dos ativos)</small></div>
    <div class="v21-allocation-bars"><div><span>Contas</span><div class="progress"><span style="width:${clamp(cashPct,0,100)}%"></span></div><strong>${cashPct.toFixed(1)}%</strong></div><div><span>Investimentos</span><div class="progress"><span style="width:${clamp(invPct,0,100)}%"></span></div><strong>${invPct.toFixed(1)}%</strong></div></div>
  </div>`;
}

function v21RenderInvestmentAnalysis(analytics) {
  if (!analytics.active.length) return empty('Nenhum investimento ativo importado pelo Open Finance.');
  const maxType = Math.max(1, ...analytics.byType.map(item => item.value));
  const maturityRows = analytics.maturities.slice(0, 8).map(item => `<div class="v21-maturity-row"><div><strong>${esc(item.name || investmentTypeLabel(item.type))}</strong><small>${esc(institutionForItem(item.pluggy_item_id))}</small></div><span>${formatDateBr(simpleDate(item.due_date))}</span><strong>${money.format(item.balance)}</strong></div>`).join('');
  return `<section class="grid kpis v21-investment-kpis">
      <article class="card"><div class="kpi-label">Investido</div><div class="kpi-value positive">${money.format(analytics.total)}</div><div class="kpi-meta">${analytics.active.length} ativo${analytics.active.length === 1 ? '' : 's'} em posição</div></article>
      <article class="card"><div class="kpi-label">Valor aplicado</div><div class="kpi-value">${analytics.original ? money.format(analytics.original) : '—'}</div><div class="kpi-meta">Quando informado pelas instituições</div></article>
      <article class="card"><div class="kpi-label">Resultado informado</div><div class="kpi-value ${analytics.profit >= 0 ? 'positive' : 'negative'}">${analytics.profitAvailable ? money.format(analytics.profit) : '—'}</div><div class="kpi-meta">${analytics.returnPercent != null ? `${analytics.returnPercent >= 0 ? '+' : ''}${analytics.returnPercent.toFixed(2)}% sobre valor aplicado` : 'Rentabilidade não disponível para todos os ativos'}</div></article>
      <article class="card"><div class="kpi-label">Disponível p/ resgate</div><div class="kpi-value">${analytics.withdrawalAvailable ? money.format(analytics.withdrawal) : '—'}</div><div class="kpi-meta">Campo informado pela Pluggy quando disponível</div></article>
    </section>
    <section class="grid two" style="margin-top:16px"><article class="card"><div class="card-header"><div><h3 class="card-title">Alocação por tipo</h3><p class="card-note">Distribuição da posição atual</p></div></div><div class="chart">${analytics.byType.map(item => `<div class="chart-row"><div class="chart-label">${esc(item.label)}</div><div class="chart-track"><div class="chart-bar" style="width:${(item.value/maxType)*100}%"></div></div><div class="chart-value">${money.format(item.value)}</div></div>`).join('')}</div></article><article class="card"><div class="card-header"><div><h3 class="card-title">Vencimentos em 180 dias</h3><p class="card-note">Somente ativos com vencimento informado</p></div></div>${maturityRows ? `<div class="v21-maturity-list">${maturityRows}</div>` : empty('Nenhum vencimento informado nos próximos 180 dias.')}</article></section>`;
}

function renderIntelligence() {
  v21EnsureState();
  v21RecordPatrimonySnapshot();
  const score = v21HealthScore();
  const alerts = v21Alerts();
  const anomalyBundle = v21Anomalies();
  const snapshot = v21CurrentSnapshot();
  const investment = v21InvestmentAnalytics();
  const scoreTone = score.score >= 85 ? 'good' : score.score >= 70 ? 'ok' : score.score >= 50 ? 'warning' : 'error';
  const parts = score.parts.map(part => `<div class="v21-score-part"><div><span>${esc(part.label)}</span><strong>${Math.round(part.score)}/${part.max}</strong></div><div class="progress"><span style="width:${clamp((part.score/part.max)*100,0,100)}%"></span></div></div>`).join('');
  const activePrefs = Object.entries(state.alertPreferences).map(([key, enabled]) => {
    const labels = { overdue:'Contas vencidas', budget:'Orçamentos', cardLimit:'Uso do limite', bankStale:'Open Finance desatualizado', uncategorized:'Sem categoria', unusual:'Gastos fora do padrão', projection:'Saldo projetado' };
    return `<label class="v21-pref"><input type="checkbox" data-v21-alert-pref="${esc(key)}" ${enabled ? 'checked' : ''}><span>${esc(labels[key] || key)}</span></label>`;
  }).join('');

  const content = `<section class="v21-hero card"><div class="v21-hero-score ${scoreTone}"><div class="v21-score-ring"><strong>${score.score}</strong><span>/100</span></div><div><small>Indicador de saúde financeira</small><h2>${esc(v21ScoreLabel(score.score))}</h2><p>É um indicador explicável, não uma nota de crédito. Usa qualidade dos dados, categorização, planejamento, liquidez projetada e uso dos cartões.</p></div></div><div class="v21-score-parts">${parts}</div></section>

    <section class="grid kpis v21-top-kpis" style="margin-top:16px"><article class="card"><div class="kpi-label">Patrimônio líquido</div><div class="kpi-value ${snapshot.netWorth >= 0 ? 'positive' : 'negative'}">${money.format(snapshot.netWorth)}</div><div class="kpi-meta">Contas + investimentos − cartões</div></article><article class="card"><div class="kpi-label">Saldo disponível</div><div class="kpi-value ${snapshot.bankCash >= 0 ? 'positive' : 'negative'}">${money.format(snapshot.bankCash)}</div><div class="kpi-meta">Somente recursos bancários</div></article><article class="card"><div class="kpi-label">Alertas ativos</div><div class="kpi-value ${alerts.some(item => item.severity === 'error') ? 'negative' : alerts.length ? 'warning' : 'positive'}">${alerts.length}</div><div class="kpi-meta">Critérios habilitados por você</div></article><article class="card"><div class="kpi-label">Dados categorizados</div><div class="kpi-value">${score.categoryQuality.percent.toFixed(0)}%</div><div class="kpi-meta">Últimos 60 dias · ${score.categoryQuality.total} registros</div></article></section>

    <section class="grid two" style="margin-top:16px"><article class="card"><div class="card-header"><div><h2 class="card-title">Alertas inteligentes</h2><p class="card-note">Somente sinais financeiros acionáveis; você pode dispensar cada alerta.</p></div><button class="button small" data-action="v21-restore-alerts">Restaurar dispensados</button></div>${v21RenderAlerts(alerts)}<details class="v21-alert-settings"><summary>Configurar tipos de alerta</summary><div>${activePrefs}</div></details></article><article class="card"><div class="card-header"><div><h2 class="card-title">Saúde do Open Finance</h2><p class="card-note">Coleta bancária, importação e volume por instituição. O botão usa a mesma atualização completa do restante do app.</p></div><button class="button small primary" data-action="refresh-open-finance">↻ Atualizar dados</button></div>${v21RenderOpenFinanceHealth(anomalyBundle.health)}</article></section>

    <section class="grid two" style="margin-top:16px"><article class="card"><div class="card-header"><div><h2 class="card-title">Evolução do patrimônio</h2><p class="card-note">Último snapshot real de cada mês, a partir da v2.1.</p></div><button class="button small" data-action="v21-record-snapshot">Registrar agora</button></div>${v21RenderPatrimonyEvolution()}</article><article class="card"><div class="card-header"><div><h2 class="card-title">Composição patrimonial</h2><p class="card-note">Ativos e dívida de cartões separados.</p></div></div>${v21RenderAllocation(snapshot)}</article></section>

    <article class="card" style="margin-top:16px"><div class="card-header"><div><h2 class="card-title">Verificação de consistência</h2><p class="card-note">Sinais para auditoria — nenhum dado é corrigido ou excluído automaticamente.</p></div><button class="button small" data-action="v21-integrity-details">Ver detalhes</button></div>${v21RenderAnomalies(anomalyBundle)}</article>

    <section style="margin-top:24px"><div class="card-header"><div><h2 class="card-title">Investimentos 360°</h2><p class="card-note">Posição, resultado informado, liquidez, alocação e vencimentos conforme os campos disponíveis na Pluggy.</p></div></div>${v21RenderInvestmentAnalysis(investment)}</section>`;
  return pageShell(content);
}

function v21OpenIntegrityDetails() {
  const bundle = v21Anomalies();
  const duplicateRows = bundle.duplicates.slice(0,8).map(group => `<div class="v21-detail-row"><div><strong>${esc(group[0]?.description || group[0]?.description_raw || 'Movimentação')}</strong><small>${formatDateBr(dateKey(group[0]?.transaction_date))} · mesma conta e valor</small></div><span class="chip pending">${group.length} registros</span><strong>${money.format(Math.abs(num(group[0]?.amount)))}</strong></div>`).join('');
  const unmatchedRows = bundle.unmatchedCard.slice(0,8).map(tx => `<div class="v21-detail-row"><div><strong>${esc(tx.description)}</strong><small>${esc(tx.sourceLabel || 'Open Finance')} · ${formatDateBr(cashFlowDate(tx))}</small></div><span class="chip ignored">revisar</span><strong>${money.format(tx.amount)}</strong></div>`).join('');
  const unusualRows = bundle.unusual.slice(0,8).map(item => `<div class="v21-detail-row"><div><strong>${esc(item.tx.description)}</strong><small>${esc(item.category)} · mediana ${money.format(item.median)}</small></div><span class="chip ignored">fora do padrão</span><strong>${money.format(item.tx.amount)}</strong></div>`).join('');
  const body = `<div class="v21-detail-section"><h3>Possíveis duplicidades</h3><p>Mesma conta, data, valor e descrição. São apenas candidatos: compras realmente repetidas também podem aparecer aqui.</p>${duplicateRows || empty('Nenhum candidato encontrado.')}</div><div class="v21-detail-section"><h3>Liquidações sem correspondência</h3><p>Pagamentos bancários classificados como liquidação de cartão sem contrapartida de cartão identificada em ±3 dias.</p>${unmatchedRows || empty('Nenhum caso encontrado.')}</div><div class="v21-detail-section"><h3>Gastos fora do padrão</h3><p>Valores pelo menos 4× acima da mediana recente da mesma categoria, desde que haja histórico suficiente.</p>${unusualRows || empty('Nenhum gasto sinalizado.')}</div><div class="v21-detail-section"><h3>Sem categoria</h3><p>${bundle.uncategorized.length} movimentação${bundle.uncategorized.length === 1 ? '' : 'ões'} Open Finance dos últimos 90 dias.</p>${bundle.uncategorized.length ? `<button class="button primary" data-action="open-review-center">Abrir Central de Revisão</button>` : ''}</div>`;
  openInfoModal('Detalhes da verificação', body);
}

const _v21PageShellV20 = pageShell;
pageShell = function(content, extraAction = '') {
  let enhanced = content;
  if (ui.page === 'dashboard') enhanced = `${v21DashboardBanner()}${content}`;
  if (ui.page === 'patrimony') enhanced = `${v21PatrimonyStrip()}${content}`;
  return _v21PageShellV20(enhanced, extraAction);
};

bottomNav = function() {
  return `<nav class="bottom-nav v18-bottom-nav" aria-label="Navegação principal">
    <button class="${ui.page === 'dashboard' ? 'active' : ''}" data-page="dashboard"><span class="nav-icon">⌂</span><span>Início</span></button>
    <button class="${ui.page === 'transactions' ? 'active' : ''}" data-page="transactions"><span class="nav-icon">⇄</span><span>Transações</span></button>
    <button class="bottom-add-button" data-action="add-transaction" aria-label="Nova movimentação"><span>＋</span></button>
    <button class="${ui.page === 'planning' ? 'active' : ''}" data-page="planning"><span class="nav-icon">◎</span><span>Planejar</span></button>
    <button class="${['patrimony','reports','settings','intelligence'].includes(ui.page) ? 'active' : ''}" data-action="more-menu"><span class="nav-icon">•••</span><span>Mais</span></button>
  </nav>`;
};

openMoreMenu = function() {
  const alerts = v21Alerts().length;
  const reviewCount = reviewCandidates().length;
  const body = `<div class="more-menu-grid v19-more-menu">
    <button data-action="v21-nav-page" data-target-page="intelligence"><span>✦</span><div><strong>Inteligência${alerts ? ` · ${alerts}` : ''}</strong><small>Alertas, Open Finance e patrimônio 360°</small></div></button>
    <button data-action="open-agenda"><span>📅</span><div><strong>Agenda financeira</strong><small>Contas, receitas e saldo projetado</small></div></button>
    <button data-action="open-review-center"><span>✓</span><div><strong>Revisar movimentações${reviewCount ? ` · ${reviewCount}` : ''}</strong><small>Categorias e regras automáticas</small></div></button>
    <button data-action="v21-nav-page" data-target-page="patrimony"><span>▣</span><div><strong>Contas e cartões</strong><small>Saldos, faturas e investimentos</small></div></button>
    <button data-action="v21-nav-page" data-target-page="reports"><span>▥</span><div><strong>Relatórios</strong><small>Análises por período e categoria</small></div></button>
    <button data-action="v21-nav-page" data-target-page="settings"><span>⚙</span><div><strong>Configurações</strong><small>Conta, sincronização e preferências</small></div></button>
  </div>`;
  openInfoModal('Mais opções', body);
};

const _v21RenderV20 = render;
render = function() {
  if (ui.page !== 'intelligence') return _v21RenderV20();
  applyTheme();
  const app = document.getElementById('app');
  if (!authReady || !authSession) return _v21RenderV20();
  app.innerHTML = renderIntelligence();
  updateSyncIndicator();
};

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'v21-dismiss-alert') {
    const id = button.dataset.alertId || '';
    if (!id) return;
    v21EnsureState();
    if (!v21DismissedSet().has(id)) state.dismissedAlerts.push({ id, dismissedAt: new Date().toISOString() });
    if (state.dismissedAlerts.length > 500) state.dismissedAlerts = state.dismissedAlerts.slice(-500);
    persist(); render();
    return;
  }
  if (action === 'v21-restore-alerts') {
    v21EnsureState(); state.dismissedAlerts = []; persist(); render(); showToast('Alertas dispensados foram restaurados.', { tone: 'success' }); return;
  }
  if (action === 'v21-record-snapshot') {
    const changed = v21RecordPatrimonySnapshot();
    if (changed) persist();
    render(); showToast(changed ? 'Snapshot patrimonial registrado.' : 'O snapshot de hoje já está atualizado.', { tone: 'success' }); return;
  }
  if (action === 'v21-nav-page') {
    const targetPage = button.dataset.targetPage || 'dashboard';
    closeModal();
    ui.page = targetPage;
    render();
    if (targetPage === 'patrimony') {
      Promise.all([loadPluggyItems({ quiet: true }), loadOpenFinanceData({ quiet: true })])
        .then(() => loadPluggyRemoteStatus({ quiet: true }));
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (action === 'v21-alert-details') {
    v21OpenAlertDetails(button.dataset.alertKind || '', button.dataset.alertId || '');
    return;
  }
  if (action === 'v21-integrity-details') { v21OpenIntegrityDetails(); return; }
});

document.addEventListener('change', event => {
  const key = event.target?.dataset?.v21AlertPref;
  if (!key) return;
  v21EnsureState();
  state.alertPreferences[key] = Boolean(event.target.checked);
  persist(); render();
});


initializeApp();
