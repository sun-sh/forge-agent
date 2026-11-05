import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { safeMarkdown, textContent, sessionOutcome } from './render.js';
import { readEventStream, StreamError } from './stream.js';
import { mountCustomProviders } from './providers.js';
import { mountMcp } from './mcp.js';
import { mountSkills } from './skills.js';
import { builtinCommands, filterCommands, parseCommand } from './commands.js';

function stored(key, fallback, storage = localStorage) { try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; } }
function saveStored(key, value, storage = localStorage) { try { value === null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch {} }
const bootUrl = new URL(location.href);
let token = bootUrl.searchParams.get('token') || stored('pforge.token', '', sessionStorage);
if (bootUrl.searchParams.has('token')) {
  saveStored('pforge.token', token, sessionStorage);
  bootUrl.searchParams.delete('token');
  history.replaceState(null, '', bootUrl.pathname + bootUrl.search + bootUrl.hash);
}
const $ = (id) => document.getElementById(id);
const state = {
  project: null, trust: null, model: null, models: [], providers: [], thinkingLevel: 'off', mode: 'agent',
  activeModelKey: null, activeThinkingLevel: 'off', pendingModelKey: null, pendingThinkingLevel: null,
  sessionId: null, sessionPath: null, running: false, assistant: null, tools: new Map(), projects: [], history: [],
  expandedProjects: new Set(Array.isArray(stored('pforge.expandedProjects', [])) ? stored('pforge.expandedProjects', []) : []),
  folderPath: null, folderParent: null, eventSource: null, runStartedAt: null, runFinishedAt: null,
  elapsedTimer: null, uiRequest: null, uiQueue: [], readOnly: false, lastEventId: 0,
  thinking: null, executionProcess: null, turnAnswer: null, verification: null, outcome: 'idle', error: null, loadingSession: false, historyQuery: '', widgets: new Map(),
  authRequired: false, recoveringAuth: false, changingConfig: false, changingMode: false, openingSettings: false, sending: false, runControl: null, modelThinkingLevels: {}, pickerAnchor: null, modePickerAnchor: null,
  workflow: 'direct', task: null,
  context: null, compacting: false, compactRequest: false, runtimeCommands: [], commandInput: null, commandIndex: 0, commandItems: [], commandCategory: 'all', commandDiscoveryError: '', contextAnchor: null,
  changes: { open: false, sessionId: null, files: [], selectedPath: null, fingerprint: null, diffStatus: 'idle', listRequest: 0, diffRequest: 0 }
};
const changesMedia = window.matchMedia?.('(max-width: 1180px)');

const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
async function api(path, init = {}) {
  let response;
  try { response = await fetch(path, { ...init, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-pforge-token': token, ...(init.headers || {}) } }); }
  catch { throw new Error('无法连接本地服务，请确认 forge-agent web 正在运行后重试'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showAuthRequired();
    const error = new Error(response.status === 401 ? '本地连接需要重新授权' : data.error || 'HTTP ' + response.status); error.status = response.status; throw error;
  }
  return data;
}
function setAuthBlocked(blocked) {
  document.querySelectorAll('.app-shell, .drawer, .model-picker, .mode-picker, .modal:not(#auth-modal)').forEach((node) => { node.inert = blocked; });
}
function showAuthRequired() {
  if (state.authRequired) return;
  state.authRequired = true;
  closeModelPicker(); closeModePicker();
  state.eventSource?.close();
  $('connection-label').textContent = '需要本地授权';
  $('auth-origin').textContent = location.origin;
  $('auth-error').textContent = '';
  state.authPreviousFocus = document.activeElement;
  setAuthBlocked(true);
  $('auth-modal').classList.remove('hidden');
  $('auth-connect').focus();
  state.authRetryTimer = setInterval(() => { void recoverAuthorization(true); }, 3000);
}
async function recoverAuthorization(quiet = false) {
  if (state.recoveringAuth) return false;
  state.recoveringAuth = true;
  if (!quiet) { setBusy($('auth-connect'), true, '连接中…'); $('auth-error').textContent = ''; }
  try {
    const response = await fetch('/api/settings', { credentials: 'same-origin', headers: { 'x-pforge-token': token } });
    if (!response.ok) throw new Error(response.status === 401 ? '此浏览器尚未收到本地连接。重新运行 forge-agent web 会自动打开已连接的窗口。' : '本地服务暂不可用（HTTP ' + response.status + '）');
    state.authRequired = false;
    clearInterval(state.authRetryTimer); state.authRetryTimer = null;
    $('auth-modal').classList.add('hidden');
    setAuthBlocked(false);
    if (await loadConfig()) {
      await resumeActiveSession();
      if (!$('drawer').classList.contains('hidden')) await openSettings();
    } else {
      showAuthRequired();
      return false;
    }
    state.authPreviousFocus?.focus();
    return true;
  } catch (error) {
    if (!quiet) $('auth-error').textContent = error instanceof TypeError ? '无法连接本地服务，请确认 forge-agent web 正在运行后重试' : error.message;
    return false;
  } finally { state.recoveringAuth = false; if (!quiet) setBusy($('auth-connect'), false); }
}
function toast(message, kind = 'info') {
  if (state.authRequired && message === '本地连接需要重新授权') return;
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.textContent = message;
  $('toast-root').append(node);
  setTimeout(() => node.remove(), 3600);
}
function shortPath(value) { return String(value || '').replace(/^.*[\\/]/, ''); }
function samePath(left, right) {
  const normalize = (value) => String(value || '').replace(/[\\/]+$/, '').replaceAll('/', '\\').toLowerCase();
  return normalize(left) === normalize(right);
}
function formatNumber(value) { return typeof value === 'number' ? new Intl.NumberFormat('zh-CN').format(value) : '—'; }
function formatTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function modelByKey(key) { return state.models.find((model) => model.key === key); }
function showStart() { toggleChanges(false); syncChangesSession(); $('toggle-changes').classList.add('hidden'); $('start-state').classList.remove('hidden'); $('conversation-view').classList.add('hidden'); }
function showChat() { $('toggle-changes').classList.remove('hidden'); $('start-state').classList.add('hidden'); $('conversation-view').classList.remove('hidden'); }
function continuationKind() {
  if (!state.sessionId || state.running || state.readOnly) return null;
  if (state.task) return ['interrupted', 'aborted', 'failed', 'needs_attention'].includes(state.task.status) && state.mode === 'agent' ? 'task' : null;
  return state.outcome === 'aborted' ? 'conversation' : null;
}
function renderComposerControl() {
  const stopping = state.runControl === 'stopping', resuming = state.runControl === 'resuming';
  const continuation = continuationKind(), draft = Boolean($('followup-prompt').value.trim());
  const compactLocked = state.compacting || state.compactRequest;
  const showStop = state.running || stopping, showResume = !showStop && (resuming || Boolean(continuation && !draft));
  $('stop-button').classList.toggle('hidden', !showStop); $('stop-button').disabled = !state.running || state.sending || state.loadingSession || Boolean(state.runControl);
  $('stop-button').setAttribute('aria-busy', String(stopping));
  $('stop-button').setAttribute('aria-label', stopping ? '正在停止当前执行' : '停止当前执行');
  $('resume-task-button').classList.toggle('hidden', !showResume);
  $('resume-task-button').disabled = !continuation || compactLocked || state.loadingSession || state.changingMode || state.changingConfig || state.sending || Boolean(state.runControl);
  $('resume-task-button').setAttribute('aria-busy', String(resuming));
  $('resume-task-button').title = continuation === 'task' ? '重新检查当前进度后继续任务' : '沿用当前上下文继续未完成的请求';
  $('resume-task-label').textContent = resuming ? '继续中…' : '继续';
  $('followup-send').classList.toggle('hidden', showStop || showResume);
  const status = $('composer-control-status');
  status.textContent = stopping ? '正在停止…' : '';
  status.classList.toggle('hidden', !stopping);
}
function setRunning(value) {
  state.running = value;
  const locked = value || state.compacting || state.compactRequest || state.loadingSession || Boolean(state.changingMode) || state.changingConfig || state.sending || Boolean(state.runControl);
  const executionLocked = state.compacting || state.compactRequest || state.loadingSession || Boolean(state.changingMode) || state.changingConfig || state.sending || Boolean(state.runControl);
  $('run-button').disabled = locked;
  $('followup-send').disabled = locked || state.readOnly;
  $('new-chat-button').disabled = locked;
  $('rename-button').disabled = locked;
  $('compact-button').disabled = locked || state.readOnly || !state.sessionId;
  // Model and reasoning changes made during a run are staged for the next prompt.
  $('model-picker-button').disabled = executionLocked;
  $('followup-model-picker-button').disabled = executionLocked;
  $('model-picker').setAttribute('aria-busy', String(state.changingConfig));
  $('chat-model-options').querySelectorAll('input').forEach((input) => { input.disabled = executionLocked; });
  $('thinking-select').disabled = executionLocked || !state.model?.available || (state.model.thinkingLevels || []).length < 2;
  $('manage-chat-models').disabled = locked;
  $('configure-thinking').disabled = locked;
  $('mode-select').disabled = locked;
  $('followup-mode-select').disabled = locked;
  $('mode-picker-button').disabled = locked;
  $('followup-mode-picker-button').disabled = locked;
  if (locked) closeModePicker();
  ['workflow-select', 'followup-workflow-select'].forEach((id) => { if ($(id)) $(id).disabled = locked || state.mode !== 'agent'; });
  ['settings-button', 'new-chat-button', 'brand-button', 'history-search-button', 'history-search-close', 'add-project-button', 'project-selector', 'followup-project-selector'].forEach((id) => { if ($(id)) $(id).disabled = locked; });
  $('history-query').disabled = locked;
  $('project-list').inert = locked;
  $('drawer-body').inert = locked;
  $('folder-modal').inert = locked;
  if (!value && state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
  if (value && !state.elapsedTimer) state.elapsedTimer = setInterval(updateElapsed, 1000);
  $('followup-prompt').placeholder = state.readOnly ? '选择可用模型后继续此会话；历史记录可正常查看' : '继续告诉 Forge...';
  renderComposerControl();
  renderContext();
  if (state.commandInput) renderCommandPicker();
}
function setProject(project) {
  state.project = project ? { path: project.path, name: project.name || shortPath(project.path), trust: project.trust } : null;
  $('current-project-name').textContent = state.project ? state.project.name : '选择项目';
  $('current-project-path').textContent = state.project ? state.project.path : '';
  $('project-selector-label').textContent = state.project ? state.project.name : '选择文件夹';
  $('followup-project-label').textContent = state.project ? state.project.name : '当前项目';
  state.trust = project && project.trust ? project.trust : null;
  renderTrust();
  if (state.project) {
    saveStored('pforge.project', state.project.path);
    const recent = stored('pforge.recentProjects', []);
    saveStored('pforge.recentProjects', [state.project, ...(Array.isArray(recent) ? recent : []).filter((item) => item.path && !samePath(item.path, state.project.path))].slice(0, 20));
  }
}
function renderTrust() {
  const label = $('trust-label');
  if (!label) return;
  if (!state.project || !state.trust) { label.textContent = '未选择项目'; label.className = 'trust-pill'; return; }
  label.textContent = state.trust.trusted ? '项目已信任' : state.trust.requiresTrust ? '需要信任项目' : '项目资源受限';
  label.className = 'trust-pill ' + (state.trust.trusted ? 'trusted' : 'untrusted');
}
const THINKING_LABELS = { off: '关闭', minimal: '轻量', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };
function renderModelOptions() {
  const query = $('chat-model-search').value.trim().toLowerCase();
  const available = state.models.filter((model) => model.available);
  const filtered = available.filter((model) => (model.name + ' ' + model.id + ' ' + model.providerName).toLowerCase().includes(query));
  const disabled = state.loadingSession || state.changingConfig || state.changingMode || state.sending;
  $('chat-model-options').innerHTML = filtered.map((model) => '<label class="chat-model-option ' + (model.key === state.model?.key ? 'selected' : '') + '"><input type="radio" name="chat-model" data-choose-model="' + esc(model.key) + '" ' + (model.key === state.model?.key ? 'checked ' : '') + (disabled ? 'disabled ' : '') + '><span><strong>' + esc(model.name) + '</strong><small>' + esc(model.providerName) + (model.reasoning ? ' · 推理' : '') + (model.input?.includes('image') ? ' · 图像' : '') + '</small></span><span class="model-selected-mark" aria-hidden="true">' + (model.key === state.model?.key ? '✓' : '') + '</span></label>').join('') || '<p class="model-picker-empty">' + (available.length ? '没有匹配的模型' : '还没有可用模型，请先添加服务。') + '</p>';
}
function renderThinking() {
  const model = state.model, select = $('thinking-select');
  const levels = model?.thinkingLevels || [];
  const adjustable = Boolean(model?.available && model.reasoning && levels.length > 1);
  select.innerHTML = levels.map((level) => '<option value="' + esc(level) + '">' + esc(THINKING_LABELS[level] || level) + '</option>').join('');
  select.value = levels.includes(state.thinkingLevel) ? state.thinkingLevel : levels[0] || '';
  select.classList.toggle('hidden', !adjustable);
  // During an active run, this selector remains available. Changes are staged
  // locally and applied before the next turn.
  select.disabled = !adjustable || state.compacting || state.compactRequest || state.loadingSession || state.changingConfig || Boolean(state.changingMode) || state.sending;
  $('configure-thinking').classList.toggle('hidden', !model || Boolean(model.reasoning));
  $('thinking-description').textContent = !model ? '选择模型后查看可用的推理强度。'
    : !model.available ? '此模型的认证暂不可用，请重新选择可用模型。'
    : !model.reasoning ? '此模型未启用可调推理。第三方模型可在服务设置中确认能力。'
    : !levels.length ? '此模型未声明可用档位，请检查模型能力配置。'
    : levels.length === 1 ? '此模型固定使用“' + (THINKING_LABELS[levels[0]] || levels[0]) + '”档位。'
    : state.thinkingLevel === 'off' ? '本次调用关闭推理。选择更高档位通常需要更多时间和用量。'
    : '仅显示此模型支持的档位；更高强度通常需要更多时间和用量。';
}
function setModel(model) {
  state.model = model || null;
  renderContext();
  ['model-picker-button', 'followup-model-picker-button'].forEach((id) => {
    const button = $(id), effort = button.querySelector('[data-effort-label]');
    button.querySelector('[data-model-label]').textContent = model?.name || '选择模型';
    effort.textContent = THINKING_LABELS[state.thinkingLevel] || state.thinkingLevel;
    effort.classList.toggle('hidden', !model?.reasoning || !(model.thinkingLevels || []).length);
    button.classList.toggle('has-pending-model', hasPendingSessionConfig());
    button.title = model ? model.providerName + ' · ' + model.id + (model.reasoning ? ' · 推理强度：' + effort.textContent : '') + (hasPendingSessionConfig() ? ' · 下一条消息生效' : '') : '添加服务并选择模型';
  });
  $('model-save-status').textContent = hasPendingSessionConfig() ? '已暂存：下一条消息生效，当前运行继续使用原配置。' : state.running ? '运行中可选择模型和推理强度，下一条消息生效。' : '';
  renderModelOptions(); renderThinking();
}
function hasPendingSessionConfig() { return Boolean(state.pendingModelKey || state.pendingThinkingLevel !== null); }
function supportedThinking(model, preferred) {
  const levels = model?.thinkingLevels || [];
  return levels.includes(preferred) ? preferred : levels[0] || 'off';
}
function applySessionConfig(data = {}) {
  if ('runMode' in data) state.runMode = data.runMode;
  if (data.mode) setMode(data.mode);
  if (data.workflow === 'direct' || data.workflow === 'planned') {
    state.workflow = data.workflow;
  }
  if ('readOnly' in data) state.readOnly = data.readOnly;
  if ('model' in data && !data.model) { state.model = null; state.activeModelKey = null; }
  if (data.model && data.model.key) {
    const model = { ...modelByKey(data.model.key), ...data.model };
    state.activeModelKey = model.key;
    if (!state.pendingModelKey) state.model = model;
    state.models = state.models.map((item) => item.key === model.key ? model : item);
  }
  if (typeof data.thinkingLevel === 'string') {
    state.activeThinkingLevel = data.thinkingLevel;
  }
  if (state.pendingModelKey) state.model = modelByKey(state.pendingModelKey) || state.model;
  state.thinkingLevel = supportedThinking(state.model, state.pendingThinkingLevel ?? state.activeThinkingLevel);
  setModel(state.model); syncModeControls();
}
function positionModelPicker() {
  positionPicker($('model-picker'), state.pickerAnchor, 380);
}
function positionPicker(picker, anchor, preferredWidth) {
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(preferredWidth, window.innerWidth - 24);
  picker.style.width = width + 'px';
  picker.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
  const above = rect.top - 20, below = window.innerHeight - rect.bottom - 20;
  if (above >= 250 || above >= below) {
    picker.style.bottom = Math.max(12, window.innerHeight - rect.top + 8) + 'px'; picker.style.top = 'auto';
    picker.style.maxHeight = Math.max(180, above) + 'px';
  } else {
    picker.style.top = Math.max(12, rect.bottom + 8) + 'px'; picker.style.bottom = 'auto';
    picker.style.maxHeight = Math.max(180, below) + 'px';
  }
}
function closeModelPicker(restoreFocus = false) {
  const anchor = state.pickerAnchor;
  state.pickerAnchor = null; $('model-picker').classList.add('hidden');
  ['model-picker-button', 'followup-model-picker-button'].forEach((id) => $(id).setAttribute('aria-expanded', 'false'));
  if (restoreFocus && anchor && !anchor.disabled) anchor.focus();
}
function toggleModelPicker(button) {
  if (state.compacting || state.compactRequest || state.loadingSession || state.changingConfig || state.changingMode || state.sending) return;
  if (state.pickerAnchor === button) { closeModelPicker(true); return; }
  closeCommandPicker(); closeContext(); closeModePicker(); closeModelPicker(); state.pickerAnchor = button;
  $('chat-model-search').value = ''; setModel(state.model);
  renderModelOptions(); renderThinking(); $('model-picker').classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true'); positionModelPicker(); $('chat-model-search').focus();
}
async function loadModels() {
  const settings = await api('/api/settings');
  state.models = settings.models || [];
  state.providers = settings.providers || [];
  state.modelThinkingLevels = settings.modelThinkingLevels || {};
  $('model-setup-note').classList.toggle('hidden', state.models.length > 0);
  if (state.sessionId) { setModel(state.model); return settings; }
  const preferredKey = state.pendingModelKey || settings.model;
  const selected = state.models.find((model) => model.key === preferredKey && model.available) || state.models.find((model) => model.available) || null;
  state.thinkingLevel = state.pendingThinkingLevel ?? settings.thinkingLevel ?? 'off';
  if (!state.pendingModelKey) state.activeModelKey = selected?.key || null;
  if (state.pendingThinkingLevel === null) state.activeThinkingLevel = settings.thinkingLevel || 'off';
  setModel(selected);
  return settings;
}
async function loadTrust(path = state.project && state.project.path) {
  if (!path) { state.trust = null; renderTrust(); return; }
  try { state.trust = (await api('/api/projects/trust?path=' + encodeURIComponent(path))).trust; renderTrust(); } catch (error) { toast(error.message, 'error'); }
}
function renderProjects() {
  const grouped = new Map();
  state.projects.forEach((project) => grouped.set(project.path, { ...project, sessions: [] }));
  state.history.forEach((group) => {
    if (!grouped.has(group.path)) grouped.set(group.path, { path: group.path, name: group.name, sessions: [] });
    grouped.get(group.path).sessions = group.sessions;
  });
  if (state.project && !grouped.has(state.project.path)) grouped.set(state.project.path, { ...state.project, sessions: [] });
  const query = state.historyQuery.trim().toLowerCase();
  $('project-list').innerHTML = Array.from(grouped.values()).filter((project) => !query || (project.name + ' ' + project.path).toLowerCase().includes(query) || project.sessions.some((session) => session.title.toLowerCase().includes(query))).map((project) => {
    const open = Boolean(query) || state.expandedProjects.has(project.path);
    const current = state.project && state.project.path === project.path;
    const sessions = (project.sessions || []).filter((session) => !query || (project.name + ' ' + project.path + ' ' + session.title).toLowerCase().includes(query)).map((session) => '<button class="session-item ' + (state.sessionPath && samePath(state.sessionPath, session.path) ? 'active' : '') + '" data-session="' + esc(session.path) + '" title="' + esc(session.title) + '"><span>' + esc(session.title || '未命名对话') + '</span><small>' + esc(new Date(session.updatedAt).toLocaleDateString() + ' ' + formatTime(session.updatedAt)) + '</small></button>').join('');
    const trust = project.trust && project.trust.trusted ? '<span class="project-trust">✓</span>' : '';
    return '<div class="project-group ' + (open ? 'open ' : '') + (current ? 'current' : '') + '" data-project="' + esc(project.path) + '"><button class="project-row" aria-expanded="' + open + '" data-project-toggle="' + esc(project.path) + '"><span class="project-chevron">' + (open ? '−' : '+') + '</span><span class="project-name">' + esc(project.name || shortPath(project.path)) + '</span>' + trust + '<span class="project-count">' + (project.sessions || []).length + '</span></button><div class="session-list">' + (sessions || '<div class="empty-sessions">还没有对话</div>') + '</div></div>';
  }).join('') || '<div class="sidebar-empty">选择一个文件夹开始</div>';
}
async function loadProjects() {
  const result = await Promise.all([api('/api/projects'), api('/api/history')]);
  const recent = stored('pforge.recentProjects', []);
  state.projects = [...(result[0].projects || [])];
  for (const project of Array.isArray(recent) ? recent : []) if (typeof project.path === 'string' && !state.projects.some((item) => samePath(item.path, project.path))) state.projects.push(project);
  state.history = result[1].projects || [];
  const saved = stored('pforge.project', null);
  const savedProject = saved && state.projects.find((project) => project.path === saved);
  if (!state.project) { setProject(savedProject || state.projects[0] || (saved ? { path: saved, name: shortPath(saved) } : null)); if (state.project) state.expandedProjects.add(state.project.path); }
  if (state.project) await loadTrust(state.project.path);
  renderProjects();
}
function createTurn(kind, label, text = '') {
  const article = document.createElement('article');
  article.className = 'turn ' + kind;
  article.innerHTML = '<div class="turn-avatar">' + (kind === 'user' ? '你' : kind === 'tool' ? '·' : 'F') + '</div><div class="turn-body"><div class="turn-header"><strong>' + esc(label) + '</strong></div><div class="turn-text ' + kind + '"></div></div>';
  const body = article.querySelector('.turn-body');
  if (kind === 'thinking') body.innerHTML = '<details class="thinking-block"><summary>执行过程 · ' + esc(label) + '</summary><div class="turn-text thinking"></div></details>';
  const node = article.querySelector('.turn-text');
  node.dataset.raw = text;
  node.textContent = text;
  if (kind === 'assistant') renderMarkdown(node, text);
  $('timeline').append(article);
  $('timeline').scrollTop = $('timeline').scrollHeight;
  return article;
}
const markdownBlocks = new WeakMap();
const pendingMarkdown = new Set();
let markdownTimer = null;
function decorateCode(pre) {
  const code = pre.querySelector('code');
  if (!code) return;
  if (code.classList.contains('language-diff')) {
    const lines = code.textContent.split('\n');
    code.replaceChildren(...lines.map((line, index) => { const span = document.createElement('span'); span.className = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''; span.textContent = line + (index < lines.length - 1 ? '\n' : ''); return span; }));
  }
  if (!pre.querySelector('.copy-code')) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'copy-code'; button.textContent = '复制代码';
    button.onclick = async () => { try { await navigator.clipboard.writeText(code.textContent); button.textContent = '已复制'; setTimeout(() => { button.textContent = '复制代码'; }, 1500); } catch { toast('复制失败，请手动选择代码', 'error'); } };
    pre.prepend(button);
  }
}
function renderMarkdown(node, text) {
  pendingMarkdown.delete(node);
  if (!pendingMarkdown.size && markdownTimer !== null) { clearTimeout(markdownTimer); markdownTimer = null; }
  node.dataset.raw = text;
  node.classList.add('markdown');
  const template = document.createElement('template');
  template.innerHTML = safeMarkdown(text, marked, DOMPurify);
  const previous = markdownBlocks.get(node) || [];
  const blocks = [...template.content.childNodes].map((child, index) => {
    const html = child.nodeType === 1 ? child.outerHTML : child.textContent;
    const saved = previous[index];
    if (saved?.node.parentNode === node && saved.html === html) return saved;
    // Keep an expanding fenced block and its copy button in place while tokens arrive.
    if (saved?.node.parentNode === node && saved.node.nodeName === 'PRE' && child.nodeName === 'PRE') {
      const code = saved.node.querySelector('code'), nextCode = child.querySelector('code');
      if (code && nextCode) {
        const left = saved.node.scrollLeft, top = saved.node.scrollTop;
        code.className = nextCode.className; code.textContent = nextCode.textContent;
        decorateCode(saved.node); saved.node.scrollLeft = left; saved.node.scrollTop = top;
        return { html, node: saved.node };
      }
    }
    if (child.nodeType === 1) {
      child.querySelectorAll('a').forEach((link) => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
      if (child.nodeName === 'PRE') decorateCode(child);
      child.querySelectorAll('pre').forEach(decorateCode);
    }
    return { html, node: child };
  });
  // Preserve completed blocks, selection and scroll instead of replacing the whole answer.
  let cursor = node.firstChild;
  for (const block of blocks) {
    if (block.node === cursor) cursor = cursor.nextSibling;
    else node.insertBefore(block.node, cursor);
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  markdownBlocks.set(node, blocks);
}
function flushStreamedMarkdown() {
  if (markdownTimer !== null) clearTimeout(markdownTimer);
  markdownTimer = null;
  if (!pendingMarkdown.size) return;
  const timeline = $('timeline'), follow = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 180;
  for (const node of [...pendingMarkdown]) if (node.isConnected) renderMarkdown(node, node.dataset.raw || '');
  pendingMarkdown.clear();
  if (follow) scrollTimeline(true);
}
function cancelStreamedMarkdown() {
  if (markdownTimer !== null) clearTimeout(markdownTimer);
  markdownTimer = null; pendingMarkdown.clear();
}
function scrollTimeline(force = false) { const node = $('timeline'); if (force || node.scrollHeight - node.scrollTop - node.clientHeight < 180) node.scrollTop = node.scrollHeight; }
function executionProcess() {
  let details = state.executionProcess;
  if (!details?.isConnected) details = null;
  if (!details) {
    details = document.createElement('details'); details.className = 'execution-details'; details.open = state.running;
    details.innerHTML = '<summary><span>执行过程</span><small>思考、工具调用与阶段输出</small></summary><div class="execution-content"></div>';
    if (state.turnAnswer?.parentElement === $('timeline')) $('timeline').insertBefore(details, state.turnAnswer);
    else $('timeline').append(details);
    state.executionProcess = details;
  }
  return details.querySelector('.execution-content');
}
function appendProcessNode(node) { executionProcess().append(node); }
function createProcessTurn(kind, label, text = '') { const row = createTurn(kind, label, text); row.remove(); appendProcessNode(row); return row; }
function startUserTurn() {
  if (state.executionProcess) state.executionProcess.open = false;
  state.executionProcess = null; state.turnAnswer = null; state.assistant = null; state.thinking = null;
}
function createAnswer(text = '') {
  if (state.turnAnswer?.isConnected) appendProcessNode(state.turnAnswer);
  state.turnAnswer = createTurn('assistant', 'Forge', text);
  return state.turnAnswer;
}
function foldsIntoExecutionProcess(phase, task = state.task) {
  if (!task) return false;
  // Answer and explore tasks are host-routed through a task record, but their
  // model response is still the user-facing answer.
  if (task.kind === 'answer' || task.kind === 'explore') return false;
  // The implementation response is the user-facing result of a change task;
  // inspection, planning, verification and review stay inside the process fold.
  if (task.kind === 'change') return Boolean(phase && phase !== 'implement' && phase !== 'complete');
  if (task.kind === 'verify') return true;
  // Older persisted tasks may not have kind; their phase still identifies the
  // host workflow and should remain folded except for implementation output.
  return Boolean(phase && phase !== 'implement' && phase !== 'complete');
}
function appendAssistant(text, phase = state.task?.phase) {
  const process = foldsIntoExecutionProcess(phase);
  if (!state.assistant) state.assistant = process ? createProcessTurn('assistant', phase === 'review' ? '模型审阅' : 'Forge · ' + (TASK_LABELS[phase] || '执行'), '') : createAnswer();
  const node = state.assistant.querySelector('.turn-text');
  node.dataset.raw = (node.dataset.raw || '') + text;
  pendingMarkdown.add(node);
  if (markdownTimer === null) markdownTimer = setTimeout(flushStreamedMarkdown, 32);
}
function appendThinking(text) {
  if (!state.thinking) state.thinking = createProcessTurn('thinking', '思考');
  state.thinking.querySelector('.turn-text').textContent += text;
  scrollTimeline();
}
function toolSummary(input) { if (!input || typeof input !== 'object') return ''; return input.command || input.path || input.pattern || input.query || Object.keys(input).slice(0, 2).join(', '); }
function addTool(event, pending = true) {
  const id = event.toolCallId || event.toolName;
  if (state.tools.has(id)) return state.tools.get(id);
  const row = document.createElement('details'); row.className = 'tool-row';
  row.innerHTML = '<summary><span class="tool-name">' + esc(event.toolName || 'tool') + '</span><span class="tool-summary">' + esc(toolSummary(event.args)) + '</span><span class="tool-state">' + (pending ? '运行中' : '已记录') + '</span></summary><pre class="tool-args"></pre><pre class="tool-output"></pre>';
  row.querySelector('.tool-args').textContent = JSON.stringify(event.args ?? {}, null, 2);
  appendProcessNode(row); state.tools.set(id, row); scrollTimeline(); return row;
}
function endTool(event) {
  const row = state.tools.get(event.toolCallId || event.toolName) || addTool(event, false);
  const status = row.querySelector('.tool-state'); status.textContent = event.isError ? '失败' : '完成'; status.className = 'tool-state ' + (event.isError ? 'failed' : 'done');
  row.querySelector('.tool-output').textContent = textContent(event.result?.content) || '(无文本输出)';
  if (event.isError) row.open = true;
}
function updateElapsed() { if (!state.runStartedAt) { $('run-elapsed').textContent = ''; return; } const end = state.running ? Date.now() : state.runFinishedAt || state.runStartedAt; const seconds = Math.max(0, Math.floor((end - state.runStartedAt) / 1000)); $('run-elapsed').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
function renderSessionMeta(data = {}) { const model = data.model || state.model; $('conversation-meta').textContent = model ? (model.providerName || model.provider) + ' · ' + model.name : ''; }
function tokenLabel(value) { return value >= 1_000_000 ? Number((value / 1_000_000).toFixed(1)) + 'M' : value >= 1000 ? Number((value / 1000).toFixed(1)) + 'k' : formatNumber(value); }
function contextPercent(value) { return value > 0 && value < 0.1 ? '<0.1%' : (value < 10 ? Number(value.toFixed(1)) : Math.round(value)) + '%'; }
function contextError(message) {
  if (!message) return '';
  if (/Nothing to compact|session too small/i.test(message)) return '对话内容还较少，暂时无需压缩。';
  if (/Already compacted/i.test(message)) return '当前内容已经压缩，继续对话后可再次压缩。';
  if (/cancelled|aborted/i.test(message)) return '压缩已取消，原有上下文仍然保留。';
  return '压缩失败：' + message;
}
function renderContext() {
  const context = state.context, usage = context?.usage;
  const capacity = usage?.contextWindow || (!state.sessionId ? state.model?.contextWindow : null);
  const known = typeof usage?.tokens === 'number' && Number.isFinite(usage.tokens) && usage.tokens >= 0 && capacity > 0;
  const percent = known && capacity > 0 ? usage.tokens / capacity * 100 : null;
  const count = known ? '≈' + tokenLabel(usage.tokens) : '—';
  const label = state.compacting ? '正在压缩…' : '上下文 ' + count + (capacity ? ' / ' + tokenLabel(capacity) : '') + (percent !== null ? ' · ' + contextPercent(percent) : '');
  ['context-button', 'followup-context-button'].forEach((id) => {
    const button = $(id); button.querySelector('[data-context-label]').textContent = label;
    button.style.setProperty('--context-used', Math.min(100, Math.max(0, percent || 0)) + '%');
    button.dataset.level = percent >= 90 ? 'high' : percent >= 75 ? 'medium' : 'normal';
    button.setAttribute('aria-label', label + '，查看详情');
    button.title = known ? '当前上下文估算 ' + formatNumber(usage.tokens) + ' / ' + formatNumber(capacity) + ' tokens' : '当前用量尚不可用，点击查看详情';
  });
  $('compact-button').textContent = state.compacting ? '压缩中…' : '压缩';
  $('compact-button').setAttribute('aria-busy', String(state.compacting));
  $('compact-button').disabled = !state.sessionId || state.readOnly || state.running || state.compacting || state.compactRequest || state.loadingSession || state.changingConfig || Boolean(state.changingMode) || state.sending || Boolean(state.runControl);
  $('compact-button').title = state.running ? '本轮结束后可压缩上下文' : state.readOnly ? '选择可用模型后才能压缩' : '将较早内容整理为摘要，保留最近对话；会调用当前模型';
  $('cancel-compact-button').classList.toggle('hidden', !state.compacting || state.running);
  $('context-summary').textContent = known ? '已用约 ' + formatNumber(usage.tokens) + ' / ' + formatNumber(capacity) + ' tokens（' + contextPercent(percent) + '）' : capacity ? '上下文容量 ' + formatNumber(capacity) + ' tokens · 当前用量待更新' : '当前上下文用量暂不可用';
  $('context-detail-fill').style.width = Math.min(100, Math.max(0, percent || 0)) + '%';
  $('context-explanation').textContent = !state.sessionId ? '开始对话后显示当前上下文估算。输入草稿尚未计入。' : known ? '用量由运行时根据当前会话上下文估算，在模型回复和工具执行后更新；草稿尚未计入。' : context?.compactions ? '压缩已完成。下一次模型回复后更新用量，当前不显示压缩前的旧数值。' : '当前会话尚无可用估算。继续对话后更新。';
  const stats = context?.stats;
  const rows = [
    ['自动压缩', context?.autoCompaction === true ? '已开启' : context?.autoCompaction === false ? '已关闭' : '随会话加载'],
    ['已压缩', formatNumber(context?.compactions || 0) + ' 次'],
    ['累计输入', stats?.tokens ? formatNumber(stats.tokens.input) + ' tokens' : '—'],
    ['累计输出', stats?.tokens ? formatNumber(stats.tokens.output) + ' tokens' : '—'],
    ['缓存读取 / 写入', stats?.tokens ? formatNumber(stats.tokens.cacheRead) + ' / ' + formatNumber(stats.tokens.cacheWrite) : '—'],
    ['会话费用（目录估算）', typeof stats?.cost === 'number' ? '$' + stats.cost.toFixed(4) : '—']
  ];
  $('context-details').innerHTML = rows.map(([title, value]) => '<div><dt>' + esc(title) + '</dt><dd>' + esc(value) + '</dd></div>').join('');
  $('context-operation-note').textContent = state.compacting ? '正在整理上下文，完成前暂不能发送；可取消手动压缩。' : contextError(context?.error) || '压缩会将较早内容整理成摘要，保留最近对话与历史记录。累计用量与费用不代表当前窗口占用。';
}
function closeContext(restoreFocus = false) {
  const anchor = state.contextAnchor; state.contextAnchor = null; $('context-panel').classList.add('hidden');
  ['context-button', 'followup-context-button'].forEach((id) => $(id).setAttribute('aria-expanded', 'false'));
  if (restoreFocus) anchor?.focus();
}
function openContext(anchor) {
  if (state.contextAnchor === anchor) { closeContext(true); return; }
  closeCommandPicker(); closeModelPicker(); closeModePicker(); closeContext();
  state.contextAnchor = anchor; renderContext(); $('context-panel').classList.remove('hidden');
  anchor.setAttribute('aria-expanded', 'true'); positionPicker($('context-panel'), anchor, 350); $('context-panel').focus();
}
async function compactContext(instructions = '') {
  if (!state.sessionId || state.readOnly || state.running || state.compacting || state.loadingSession || state.changingConfig || Boolean(state.changingMode) || state.sending || Boolean(state.runControl) || state.compactRequest) return false;
  const sessionId = state.sessionId;
  state.compacting = true; state.compactRequest = true; setRunning(state.running);
  try {
    const result = await api('/api/sessions/' + sessionId + '/compact', { method: 'POST', body: JSON.stringify({ instructions: instructions || undefined }) });
    if (sessionId !== state.sessionId) return false;
    if (result.context) state.context = result.context;
    toast('上下文已压缩，历史记录已保留');
    await refreshSessionState(); return true;
  } catch (error) { if (sessionId === state.sessionId) { state.context = { ...state.context, error: error.message, compacting: false }; toast(contextError(error.message), 'error'); } return false; }
  finally { if (sessionId === state.sessionId) { state.compacting = Boolean(state.context?.compacting); state.compactRequest = false; setRunning(state.running); } }
}
function commandDisabled(command) {
  if (['context', 'help'].includes(command.name)) return '';
  if (state.compacting || state.compactRequest) return '上下文正在压缩';
  if (state.loadingSession || state.changingConfig || state.changingMode || state.sending || state.runControl) return '请等待当前操作完成';
  if (command.name === 'model') return '';
  if (state.running && command.name !== 'changes') return '本轮结束后可用';
  if (['compact', 'rename', 'changes'].includes(command.name) && !state.sessionId) return '开始对话后可用';
  if (command.name === 'compact' && state.readOnly) return '请先选择可用模型';
  if (command.source !== 'local' && state.mode !== 'agent') return '需要先切换 Agent 模式';
  if (command.source !== 'local' && state.readOnly) return '请先选择可用模型';
  return '';
}
function allCommands() {
  const names = new Set();
  return [...builtinCommands, ...state.runtimeCommands].filter((command) => {
    if (names.has(command.name)) return false;
    names.add(command.name); return true;
  });
}
function closeCommandPicker() {
  if (state.commandInput) { state.commandInput.setAttribute('aria-expanded', 'false'); state.commandInput.removeAttribute('aria-activedescendant'); }
  state.commandInput = null; state.commandCategory = 'all'; state.commandDiscoveryError = ''; $('command-picker').classList.add('hidden');
  ['commands-button', 'followup-commands-button'].forEach((id) => $(id).setAttribute('aria-expanded', 'false'));
}
function positionCommandPicker() {
  if (!state.commandInput) return;
  const picker = $('command-picker'); positionPicker(picker, state.commandInput.closest('form'), 430);
  picker.style.maxHeight = Math.min(390, parseFloat(picker.style.maxHeight)) + 'px';
}
function renderCommandPicker() {
  const input = state.commandInput; if (!input) return;
  const match = /^\/([^\s/]*)$/.exec(input.value);
  if (!match || input.selectionStart !== input.selectionEnd || input.selectionStart !== input.value.length) { closeCommandPicker(); return; }
  const commands = allCommands(), category = state.commandCategory;
  const sourceLabels = { local: '操作', skill: '技能', template: '模板', extension: '扩展' };
  state.commandItems = filterCommands(commands.filter((command) => category === 'all' || command.source === category), match[1]);
  state.commandIndex = Math.min(Math.max(0, state.commandIndex), Math.max(0, state.commandItems.length - 1));
  let previousSource;
  $('command-options').innerHTML = state.commandItems.map((command, index) => {
    const reason = commandDisabled(command), source = sourceLabels[command.source];
    const heading = category === 'all' && !match[1] && previousSource !== command.source ? '<div class="command-group-title" role="presentation">' + esc(source) + '</div>' : '';
    previousSource = command.source;
    return heading + '<button type="button" role="option" tabindex="-1" id="command-option-' + index + '" data-command-index="' + index + '" data-command-name="' + esc(command.name) + '" data-command-source="' + esc(command.source) + '" aria-selected="' + (index === state.commandIndex) + '" aria-disabled="' + Boolean(reason) + '"><span><span class="command-item-heading"><strong>' + esc(command.title || command.name.replace(/^skill:/, '')) + '</strong><code>/' + esc(command.name) + '</code>' + (command.argumentHint ? '<small>' + esc(command.argumentHint) + '</small>' : '') + '</span><span class="command-description">' + esc(reason || command.description) + '</span></span><span class="command-source">' + esc(command.source === 'local' ? '打开' : source) + '</span></button>';
  }).join('') || '<p class="command-empty">' + esc(state.commandDiscoveryError || (state.loadingSession ? '正在加载项目资源…' : category === 'skill' && state.sessionId ? '当前项目未加载可用技能。点击“管理技能”导入或启用，保存后会自动更新。' : category === 'template' && state.sessionId ? '当前项目未加载提示模板。' : '未找到匹配的' + (sourceLabels[category] || '命令') + '。')) + '</p>';
  $('command-categories').querySelectorAll('[data-command-category]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.commandCategory === category));
    button.classList.toggle('hidden', button.dataset.commandCategory === 'extension' && !commands.some((command) => command.source === 'extension'));
  });
  $('manage-skills').classList.toggle('hidden', category !== 'skill');
  $('manage-skills').disabled = state.running || state.loadingSession || state.compacting || state.compactRequest;
  $('command-picker-note').textContent = state.loadingSession ? '正在加载…' : state.sessionId ? state.commandItems.length + ' 项' : '技能与模板随项目加载';
  $('command-picker-help').textContent = category === 'skill' ? '选择技能补全到输入框，可附加任务后发送' : category === 'template' ? '选择模板补全到输入框，可附加参数后发送' : '↑ ↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭';
  input.setAttribute('aria-controls', 'command-options'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-autocomplete', 'list');
  if (state.commandItems.length) input.setAttribute('aria-activedescendant', 'command-option-' + state.commandIndex); else input.removeAttribute('aria-activedescendant');
  $('command-picker').classList.remove('hidden'); positionCommandPicker();
  $(state.sessionId ? 'followup-commands-button' : 'commands-button').setAttribute('aria-expanded', 'true');
}
function updateCommandPicker(input) {
  if (/^\/[^\s/]*$/.test(input.value) && input.selectionStart === input.value.length) {
    if (state.commandInput !== input) { closeModelPicker(); closeModePicker(); closeContext(); state.commandIndex = 0; state.commandCategory = 'all'; }
    state.commandInput = input; renderCommandPicker();
  } else if (state.commandInput === input) closeCommandPicker();
}
async function selectCommandCategory(category, input = state.commandInput) {
  if (!input || !['all', 'local', 'skill', 'template', 'extension'].includes(category)) return;
  state.commandCategory = category; state.commandDiscoveryError = ''; state.commandIndex = 0;
  input.value = '/'; input.focus(); input.setSelectionRange(1, 1); rememberDraft(); renderCommandPicker();
  if (category === 'all' || category === 'local' || state.sessionId || state.loadingSession) return;
  if (!state.project || !state.model) { state.commandDiscoveryError = '请先选择项目和可用模型，再加载项目资源。'; renderCommandPicker(); return; }
  state.loadingSession = true; setRunning(state.running);
  try {
    await createSession(undefined, '新对话');
    // Closing the menu while discovery is pending must not reopen it.
    if (state.commandInput !== input) return;
    const query = input.value;
    const target = $('followup-prompt'); state.commandInput = target;
    target.value = query; target.focus(); target.setSelectionRange(query.length, query.length); rememberDraft();
  } catch (error) {
    state.commandDiscoveryError = '加载失败：' + error.message;
  } finally { state.loadingSession = false; setRunning(state.running); }
}
function clearCommand(input, original) {
  if (input.value === original) { input.value = ''; if (input.id === 'prompt') saveStored('pforge.draft.new@' + (state.project?.path || ''), null, sessionStorage); else rememberDraft(); renderComposerControl(); }
}
async function executeCommand(input, command, args = '') {
  const reason = commandDisabled(command); if (reason) { toast(reason, 'warning'); return false; }
  const original = input.value; closeCommandPicker();
  const anchor = $(state.sessionId ? 'followup-context-button' : 'context-button');
  let ok = true;
  try {
    switch (command.source === 'local' ? command.name : 'runtime') {
      case 'new': clearCommand(input, original); await newConversation(); return true;
      case 'model': toggleModelPicker($(state.sessionId ? 'followup-model-picker-button' : 'model-picker-button')); break;
      case 'mode': toggleModePicker($(state.sessionId ? 'followup-mode-picker-button' : 'mode-picker-button')); break;
      case 'context': openContext(anchor); break;
      case 'compact': ok = await compactContext(args); break;
      case 'changes': toggleChanges(true); break;
      case 'rename': $('rename-button').click(); break;
      case 'settings': await openSettings(); break;
      case 'mcp': await openSettings('mcp'); break;
      case 'help':
        $('help-commands').innerHTML = builtinCommands.map((item) => '<div><code>/' + esc(item.name) + '</code><span>' + esc(item.description) + '</span></div>').join('');
        $('help-modal').classList.remove('hidden'); $('help-close').focus(); break;
      default: {
        const message = '/' + command.name + (args ? ' ' + args : '');
        ok = state.sessionId ? await sendFollowup(message, true) : await sendPrompt(message, true); break;
      }
    }
  } catch (error) { toast(error.message, 'error'); ok = false; }
  if (ok) clearCommand(input, original);
  return ok;
}
async function handleCommandSubmit(input) {
  if (input.value.trim() === '/') { state.commandInput = input; renderCommandPicker(); return true; }
  const parsed = parseCommand(input.value); if (!parsed) return false;
  // Retain the old spelling as a shortcut to a category, not a peer skill.
  if (parsed.name === 'skills' && !parsed.args) { state.commandInput = input; await selectCommandCategory('skill', input); return true; }
  const command = allCommands().find((item) => item.name === parsed.name);
  if (!command) { toast('没有 /' + parsed.name + ' 命令。输入 /help 查看可用命令。', 'warning'); updateCommandPicker(input); return true; }
  if (command.source === 'local' && parsed.args && command.name !== 'compact') { toast('/' + command.name + ' 不接受参数，请从菜单中选择操作。', 'warning'); return true; }
  await executeCommand(input, command, parsed.args); return true;
}
function commandKeydown(event, input) {
  if (state.commandInput !== input || event.isComposing) return false;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCommandPicker(); return true; }
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); const count = state.commandItems.length; if (count) state.commandIndex = (state.commandIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
    renderCommandPicker(); $('command-option-' + state.commandIndex)?.scrollIntoView?.({ block: 'nearest' }); return true;
  }
  if (event.key === 'Tab' && !event.shiftKey || event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault(); const command = state.commandItems[state.commandIndex];
    if (!command) { if (event.key === 'Enter') void handleCommandSubmit(input); return true; }
    if (commandDisabled(command)) { toast(commandDisabled(command), 'warning'); return true; }
    if (event.key === 'Tab' || command.source !== 'local' && input.value !== '/' + command.name) { input.value = '/' + command.name + ' '; input.setSelectionRange(input.value.length, input.value.length); closeCommandPicker(); rememberDraft(); }
    else void executeCommand(input, command);
    return true;
  }
  return false;
}
function reviewText(text) {
  try {
    const review = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (typeof review.summary !== 'string' || !Array.isArray(review.issues)) throw new Error('Invalid review');
    return review.summary + (review.issues.length ? '\n\n待处理问题：\n' + review.issues.filter((issue) => typeof issue === 'string').map((issue) => '• ' + issue).join('\n') : '\n\n未提出待处理问题。');
  } catch { return '审阅结果需要人工检查。可在任务记录中查看阶段状态。'; }
}
function renderMessage(message, partial = false, phase, task = state.task) {
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = textContent(message.content);
  if (message.role === 'user') {
    startUserTurn();
    const row = createTurn('user', '你', text);
    for (const part of parts) if (part.type === 'image' && /^(image\/(png|jpeg|webp|gif))$/.test(part.mimeType) && typeof part.data === 'string' && part.data.length <= 8_000_000) { const img = document.createElement('img'); img.src = 'data:' + part.mimeType + ';base64,' + part.data; img.alt = '会话附件'; img.className = 'message-image'; row.querySelector('.turn-body').append(img); }
  }
  if (message.role === 'assistant') {
    for (const part of parts) if (part.type === 'thinking' && part.thinking) { const row = createProcessTurn('thinking', '思考', part.thinking); if (partial) state.thinking = row; }
    const process = parts.some((part) => part.type === 'toolCall') || message.stopReason === 'toolUse' || foldsIntoExecutionProcess(phase, task);
    if (text) { const row = process ? createProcessTurn('assistant', phase === 'review' ? '模型审阅' : 'Forge · ' + (TASK_LABELS[phase] || '执行'), phase === 'review' && !partial ? reviewText(text) : text) : createAnswer(text); if (partial) state.assistant = row; }
    for (const part of parts) if (part.type === 'toolCall') addTool({ toolCallId: part.id, toolName: part.name, args: part.arguments }, partial);
    if (message.errorMessage || message.stopReason === 'error') createTurn('status', '模型错误', message.errorMessage || '模型请求失败');
    if (message.stopReason === 'aborted') createTurn('status', '已停止', '本次回答已中止');
  }
  if (message.role === 'toolResult') endTool({ toolCallId: message.toolCallId, toolName: message.toolName, result: message, isError: message.isError });
  if (message.role === 'bashExecution') { const id = 'bash-' + message.timestamp; addTool({ toolCallId: id, toolName: 'shell', args: { command: message.command } }, false); endTool({ toolCallId: id, result: { content: message.output || '' }, isError: message.exitCode !== 0 }); }
  if (['compactionSummary', 'branchSummary'].includes(message.role)) createProcessTurn('thinking', '上下文摘要', message.summary || text);
  if (message.role === 'custom' && message.display !== false) createTurn('status', message.customType || '扩展消息', text);
}
function renderMessages(messages, entries, partialMessage, activeTools = []) {
  cancelStreamedMarkdown();
  const timeline = $('timeline'); const previous = timeline.scrollTop; const nearEnd = timeline.scrollHeight - previous - timeline.clientHeight < 180;
  $('timeline').innerHTML = '';
  state.assistant = null; state.thinking = null; state.executionProcess = null; state.turnAnswer = null;
  state.tools.clear();
  let phase, task;
  if (entries?.length) for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'pforge.task') { task = entry.data?.cleared ? null : entry.data; phase = task?.phase; }
    if (entry.type === 'message') renderMessage(entry.message, false, phase, task || null);
    if (entry.type === 'custom_message' && entry.display) createTurn('status', entry.customType || '扩展消息', textContent(entry.content));
    if (entry.type === 'compaction' || entry.type === 'branch_summary') { const row = createProcessTurn('thinking', '上下文摘要', entry.summary); row.querySelector('summary').textContent = entry.type === 'compaction' ? '上下文已压缩 · 查看摘要' : '分支摘要'; }
  } else (messages || []).forEach((message) => renderMessage(message, false));
  if (partialMessage) renderMessage(partialMessage, true, state.task?.phase);
  for (const event of activeTools) { const row = addTool(event); row.querySelector('.tool-state').textContent = '运行中'; }
  timeline.querySelectorAll(':scope > .execution-details').forEach((process) => { process.open = Boolean(state.running && process === state.executionProcess); });
  timeline.scrollTop = nearEnd ? timeline.scrollHeight : previous;
}
function canChangeProject(path) {
  if (!state.sessionId || !state.project || samePath(state.project.path, path)) return true;
  if (state.running) { toast('当前对话正在运行，请先停止后再切换项目'); return false; }
  toast('当前对话已绑定项目，请新建对话后切换项目');
  return false;
}
async function respondUi(requestId, value, cancelled = false) { if (state.sessionId) await api('/api/sessions/' + state.sessionId + '/ui', { method: 'POST', body: JSON.stringify({ action: 'response', requestId, value, cancelled }) }); }
function closeUiModal() { $('approval-modal').classList.add('hidden'); state.uiRequest = null; if (state.uiQueue.length) showUiRequest(state.uiQueue.shift()); }
function showUiRequest(event) {
  if (event.expiresAt && event.expiresAt < Date.now()) return;
  if (state.uiRequest) { if (state.uiRequest.requestId !== event.requestId && !state.uiQueue.some((item) => item.requestId === event.requestId)) state.uiQueue.push(event); return; }
  state.uiRequest = event;
  $('approval-title').textContent = event.title || '需要确认';
  $('approval-summary').textContent = event.message || (event.method === 'select' ? '请选择一项' : '');
  $('approval-detail').textContent = event.method === 'editor' ? event.prefill || '' : '';
  $('approval-input-wrap').classList.toggle('hidden', !['input', 'editor'].includes(event.method));
  $('approval-input').value = event.prefill || '';
  $('approval-input').placeholder = event.placeholder || '';
  $('approval-options').classList.toggle('hidden', event.method !== 'select');
  $('approval-options').innerHTML = (event.options || []).map((option) => '<button type="button" class="option-button" data-ui-option="' + esc(option) + '">' + esc(option) + '</button>').join('');
  $('allow-button').textContent = event.method === 'confirm' ? '确认' : event.method === 'select' ? '选择' : '提交';
  $('allow-button').disabled = event.method === 'select';
  $('approval-modal').classList.remove('hidden');
  if (['input', 'editor'].includes(event.method)) $('approval-input').focus(); else $('deny-button').focus();
}
function renderVerification(verification) {
  state.verification = verification || null;
  const panel = $('verification-report');
  panel.classList.toggle('hidden', !verification?.report && !verification?.error);
  if (!verification) return;
  panel.classList.toggle('failed', verification.status === 'failed');
  $('verification-summary').textContent = (verification.status === 'passed' ? '验证通过' : verification.status === 'skipped' ? '验证未执行' : '验证失败') + (verification.attempts ? ' · 修复重试 ' + verification.attempts + ' 次' : '') + (verification.checkedAt ? ' · ' + formatTime(verification.checkedAt) : '') + ' · 命令与输出';
  const failures = { timeout: '超时', aborted: '已停止', spawn_error: '启动失败' };
  $('verification-output').textContent = (verification.report?.results || []).map((result) => (result.passed ? 'PASS ' : 'FAIL ') + result.command + ' · ' + (failures[result.failure] || 'exit ' + result.exitCode) + ' · ' + result.durationMs + 'ms\n' + (result.error ? result.error + '\n' : '') + (result.output || '(无输出)')).join('\n\n') || verification.error || '';
}
const TASK_LABELS = { inspect: '调研', plan: '规划', implement: '实现', verify: '验证', review: '审阅', complete: '完成' };
function setWorkflow(value) {
  state.workflow = value === 'planned' ? 'planned' : 'direct';
  ['workflow-select', 'followup-workflow-select'].forEach((id) => { if ($(id)) $(id).value = state.workflow; });
  syncModeControls?.();
}
async function changeWorkflow(value) {
  const workflow = value === 'planned' ? 'planned' : 'direct';
  if (state.compacting || state.compactRequest || state.running || state.loadingSession || state.changingMode || state.changingConfig || state.sending || (workflow === 'planned' && state.mode !== 'agent')) { syncModeControls(); return false; }
  const previous = state.workflow;
  setWorkflow(workflow);
  if (!state.sessionId) return true;
  state.changingConfig = true; setRunning(state.running);
  try {
    const data = await api('/api/sessions/' + state.sessionId + '/workflow', { method: 'POST', body: JSON.stringify({ workflow }) });
    if (data.workflow) setWorkflow(data.workflow);
    return true;
  } catch (error) {
    setWorkflow(previous); toast(error.message, 'error'); return false;
  } finally { state.changingConfig = false; setRunning(state.running); }
}
function renderTask(task) {
  state.task = task || null;
  const showTaskPanel = Boolean(task && !['answer', 'explore'].includes(task.kind));
  $('task-panel').classList.toggle('hidden', !showTaskPanel);
  if (!task) { renderComposerControl(); return; }
  const phases = task.kind === 'verify' ? ['verify', 'complete'] : Object.keys(TASK_LABELS), current = phases.indexOf(task.phase);
  $('task-steps').innerHTML = phases.map((phase, i) => '<li class="' + (i === current ? 'current' : i < current ? 'finished' : '') + '"' + (i === current ? ' aria-current="step"' : '') + '><span>' + (i < current ? '✓' : i + 1) + '</span>' + TASK_LABELS[phase] + '</li>').join('');
  $('task-note').textContent = task.status === 'running' ? '正在' + TASK_LABELS[task.phase] + (task.repairs ? ' · 修复 ' + task.repairs + ' 次' : '') : task.error || (task.status === 'completed' ? task.kind === 'verify' ? '项目验证命令已通过。' : '验证通过，模型审阅完成。' : '等待处理');
  $('task-review').textContent = task.review ? '模型审阅：' + task.review.summary + (task.review.issues?.length ? '\n' + task.review.issues.map((issue) => '• ' + issue).join('\n') : '') : '审阅尚未完成。';
  $('task-phase-history').textContent = (task.phases || []).map((item) => TASK_LABELS[item.phase] + ' · ' + formatTime(item.startedAt) + (item.endedAt ? ' → ' + formatTime(item.endedAt) : '')).join('\n');
  setRunning(state.running);
}
function renderChangeDiff(text, preserveScroll = false) {
  const node = $('changes-diff'), top = preserveScroll ? node.scrollTop : 0, left = preserveScroll ? node.scrollLeft : 0;
  if (node.textContent !== text) node.innerHTML = text.split('\n').map((line) => '<span class="diff-line' + (line.startsWith('+') ? ' diff-add' : line.startsWith('-') ? ' diff-remove' : line.startsWith('@@') ? ' diff-hunk' : '') + '">' + esc(line) + '</span>').join('\n');
  node.scrollTop = top; node.scrollLeft = left;
}
function syncChangesSession() {
  const changes = state.changes;
  if (changes.sessionId === state.sessionId) return;
  changes.sessionId = state.sessionId; changes.files = []; changes.selectedPath = null; changes.fingerprint = null; changes.diffStatus = 'idle';
  ++changes.listRequest; ++changes.diffRequest;
  $('changes-count').textContent = ''; $('changes-files').textContent = '';
  $('changes-files').scrollTop = 0;
  $('changes-note').textContent = '正在读取 Git 状态…';
  $('changes-file-name').textContent = '文件差异'; $('changes-file-name').removeAttribute('title');
  $('changes-preview').setAttribute('aria-busy', 'false'); $('refresh-changes').disabled = false;
  renderChangeDiff('选择文件查看差异。');
}
function syncChangesLayout() {
  const open = state.changes.open, overlay = open && Boolean(changesMedia?.matches), panel = $('changes-panel');
  panel.classList.toggle('hidden', !open); $('workspace-body').classList.toggle('changes-open', open);
  $('toggle-changes').setAttribute('aria-expanded', String(open));
  $('changes-backdrop').classList.toggle('hidden', !overlay);
  if (overlay) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
  else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
  ['chat-pane', 'workspace-header', 'sidebar'].forEach((id) => { $(id).inert = overlay; });
  if (overlay && !panel.contains(document.activeElement) && !state.authRequired && !state.uiRequest) $('changes-close').focus();
}
function toggleChanges(open, restoreFocus = false) {
  open = Boolean(open && state.sessionId);
  if (open) { closeModelPicker(); closeModePicker(); toggleSidebar(false); syncChangesSession(); }
  state.changes.open = open; syncChangesLayout();
  if (open) void loadChanges();
  else if (restoreFocus) $('toggle-changes').focus();
}
function renderChangeFiles(available) {
  const changes = state.changes, node = $('changes-files'), focusedPath = node.contains(document.activeElement) ? document.activeElement.dataset.changePath : null, top = node.scrollTop;
  const html = changes.files.map((file) => {
    const selected = file.path === changes.selectedPath, markers = [file.preexisting && '已有修改', file.observed && '期间变化'].filter(Boolean).join(' · ');
    return '<button type="button" class="change-file' + (selected ? ' selected' : '') + '" data-change-path="' + esc(file.path) + '" aria-pressed="' + selected + '" title="' + esc(file.path) + '"><code>' + esc(file.status.trim()) + '</code><span>' + esc(file.path) + (markers ? '<small>' + markers + '</small>' : '') + '</span></button>';
  }).join('') || '<p class="changes-empty">' + (available ? '工作区没有未提交变更。' : '暂无可展示的 Git 变更。') + '</p>';
  // Keep keyboard focus and file-list position when a fresh snapshot updates the list.
  if (node.innerHTML !== html) {
    node.innerHTML = html;
    if (focusedPath) ([...node.querySelectorAll('[data-change-path]')].find((button) => button.dataset.changePath === focusedPath) || node.querySelector('.selected') || $('changes-close')).focus({ preventScroll: true });
    node.scrollTop = top;
  }
}
async function loadChangeDiff(path, preserveScroll = false) {
  const changes = state.changes, sessionId = state.sessionId;
  if (!sessionId || !changes.files.some((file) => file.path === path)) return;
  const request = ++changes.diffRequest;
  changes.selectedPath = path; changes.fingerprint = changes.files.find((file) => file.path === path).fingerprint; changes.diffStatus = 'loading';
  $('changes-files').querySelectorAll('[data-change-path]').forEach((button) => { const selected = button.dataset.changePath === path; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  $('changes-file-name').textContent = path; $('changes-file-name').title = path; $('changes-preview').setAttribute('aria-busy', 'true');
  if (!preserveScroll) renderChangeDiff('正在读取差异…');
  const current = () => sessionId === state.sessionId && request === changes.diffRequest && path === changes.selectedPath;
  try {
    const data = await api('/api/sessions/' + sessionId + '/changes?path=' + encodeURIComponent(path));
    if (!current()) return;
    renderChangeDiff((data.diff || '此文件没有可预览的文本差异。') + (data.truncated ? '\n\n[差异已截断]' : ''), preserveScroll);
    changes.diffStatus = 'ready';
  } catch (error) { if (current()) { renderChangeDiff('无法读取差异：' + error.message); changes.diffStatus = 'error'; } }
  finally { if (current()) $('changes-preview').setAttribute('aria-busy', 'false'); }
}
async function loadChanges(forceDiff = false) {
  if (!state.sessionId) return;
  syncChangesSession();
  const changes = state.changes, sessionId = state.sessionId, request = ++changes.listRequest;
  const current = () => sessionId === state.sessionId && request === changes.listRequest;
  $('refresh-changes').disabled = true;
  try {
    const data = await api('/api/sessions/' + sessionId + '/changes');
    if (!current()) return;
    changes.files = data.available ? data.files || [] : [];
    $('changes-count').textContent = data.available ? changes.files.length + (data.truncated ? '+' : '') : '';
    $('changes-note').textContent = !data.available ? data.reason || '无法读取 Git 状态。' : (state.task ? '“已有修改”表示任务开始前已存在；“期间变化”仅表示观察到变化，不代表全部由 Agent 产生。' : '当前工作区与暂存区的 Git 变更。') + (data.headChanged ? ' · HEAD 已变化' : '') + (data.truncated ? ' · 文件列表已截断' : '');
    const selected = changes.files.find((file) => file.path === changes.selectedPath) || changes.files[0];
    const sameFile = Boolean(selected && selected.path === changes.selectedPath);
    const refreshDiff = selected && (forceDiff || !sameFile || selected.fingerprint !== changes.fingerprint || !['ready', 'loading'].includes(changes.diffStatus));
    changes.selectedPath = selected?.path || null;
    renderChangeFiles(data.available);
    if (refreshDiff) await loadChangeDiff(selected.path, sameFile);
    else if (!selected) {
      ++changes.diffRequest; changes.fingerprint = null; changes.diffStatus = 'idle';
      $('changes-file-name').textContent = '文件差异'; $('changes-file-name').removeAttribute('title'); $('changes-preview').setAttribute('aria-busy', 'false');
      renderChangeDiff(data.available ? '工作区没有未提交变更。' : '当前项目暂无可展示的 Git 差异。');
    }
  } catch (error) { if (current()) $('changes-note').textContent = '无法读取变更：' + error.message; }
  finally { if (current()) $('refresh-changes').disabled = false; }
}
function draftKey() { return 'pforge.draft.' + (state.sessionPath || state.sessionId || 'new@' + (state.project?.path || '')); }
function rememberDraft() { saveStored(draftKey(), (state.sessionId ? $('followup-prompt') : $('prompt')).value || null, sessionStorage); }
function restoreDraft() {
  const key = draftKey(), raw = sessionStorage.getItem(key);
  if (raw === null) return;
  const value = stored(key, '', sessionStorage);
  (state.sessionId ? $('followup-prompt') : $('prompt')).value = typeof value === 'string' ? value : '';
  renderComposerControl();
}
function renderRunStatus(data = state) {
  const outcome = sessionOutcome(data);
  $('run-status-label').textContent = outcome.label;
  $('run-status-dot').className = 'status-dot ' + outcome.kind;
}
function applySnapshot(data) {
  if (data.id && data.id !== state.sessionId) return;
  state.outcome = data.outcome || 'idle'; state.error = data.error || null;
  state.sessionPath = data.sessionFile || state.sessionPath;
  state.runStartedAt = data.runningSince || null;
  state.runFinishedAt = data.finishedAt || null;
  if (data.context) state.context = data.context;
  else if (data.state?.contextUsage) state.context = { usage: data.state.contextUsage, stats: data.state };
  state.compacting = Boolean(state.context?.compacting);
  if (Array.isArray(data.commands)) state.runtimeCommands = data.commands;
  state.trust = data.trust || state.trust;
  applySessionConfig(data); setRunning(Boolean(data.running));
  renderTask(data.task);
  renderMessages(data.messages, data.entries, data.partialMessage, data.activeTools);
  renderVerification(data.verification); renderSessionMeta(data); renderTrust(); renderRunStatus(data); updateElapsed();
  syncChangesSession();
  if (state.changes.open) void loadChanges();
  $('run-title').textContent = data.title || '对话';
  const pending = data.pendingUiRequests || [];
  if (state.uiRequest && !pending.some((item) => item.requestId === state.uiRequest.requestId)) { state.uiQueue = []; closeUiModal(); }
  state.uiQueue = [];
  pending.forEach(showUiRequest);
  saveStored('pforge.activeSession', { id: state.sessionId, path: state.sessionPath, project: state.project?.path }, sessionStorage);
}
function handleEvent(event) {
  if (event.type === 'pforge_snapshot') { applySnapshot(event.snapshot); return; }
  if (event.type === 'pforge_context') { state.context = event.context; state.compacting = Boolean(event.context?.compacting); setRunning(state.running); return; }
  if (event.type === 'pforge_task') { renderTask(event.task); renderRunStatus(); return; }
  if (event.type === 'message_start' && event.message?.role === 'user') { renderMessage(event.message); return; }
  if (event.type === 'message_update') { const update = event.assistantMessageEvent; if (update && update.type === 'text_delta') appendAssistant(update.delta, state.task?.phase); if (update && update.type === 'thinking_delta') appendThinking(update.delta); return; }
  if (event.type === 'message_start' && event.message?.role === 'assistant') { flushStreamedMarkdown(); state.assistant = null; state.thinking = null; return; }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const original = textContent(event.message.content), reviewing = state.task?.phase === 'review';
    const text = reviewing && original ? reviewText(original) : original;
    const process = (event.message.content || []).some?.((part) => part.type === 'toolCall') || event.message.stopReason === 'toolUse' || foldsIntoExecutionProcess(state.task?.phase);
    if (state.assistant) {
      renderMarkdown(state.assistant.querySelector('.turn-text'), text);
      if (process) { appendProcessNode(state.assistant); if (state.turnAnswer === state.assistant) state.turnAnswer = null; }
    }
    else if (text) {
      state.assistant = process ? createProcessTurn('assistant', reviewing ? '模型审阅' : 'Forge · 执行', text) : createAnswer(text);
    }
    if (state.thinking) state.thinking.querySelector('details').open = false;
    if (event.message.errorMessage) { state.error = event.message.errorMessage; createTurn('status', '模型错误', state.error); }
    return;
  }
  if (event.type === 'tool_execution_start') { addTool(event); return; }
  if (event.type === 'tool_execution_end') { endTool(event); return; }
  if (event.type === 'agent_start') { state.runFinishedAt = null; setRunning(true); state.outcome = 'running'; renderRunStatus(); return; }
  if (event.type === 'agent_settled') { flushStreamedMarkdown(); if (!event.taskRunning) { state.runFinishedAt = Date.now(); state.outcome = event.aborted ? 'aborted' : state.error ? 'failed' : 'completed'; setRunning(false); if (state.executionProcess) state.executionProcess.open = false; } renderRunStatus(); updateElapsed(); loadProjects().catch(() => {}); return; }
  if (event.type === 'pforge_verification') { renderVerification(event.verification); return; }
  if (event.type === 'extension_ui_request') { showUiRequest(event); return; }
  if (event.type === 'extension_ui_closed') { state.uiQueue = state.uiQueue.filter((item) => item.requestId !== event.requestId); if (state.uiRequest?.requestId === event.requestId) { closeUiModal(); if (event.reason === 'timeout') toast('交互已超时，操作已取消', 'warning'); } return; }
  if (event.type === 'extension_editor') { $('followup-prompt').value = event.text || ''; renderComposerControl(); return; }
  if (event.type === 'extension_title') { document.title = (event.title || 'Forge') + ' · Forge'; return; }
  if (event.type === 'extension_widget') { if (event.lines) state.widgets.set(event.key, event.lines.join('\n')); else state.widgets.delete(event.key); $('extension-widgets').textContent = [...state.widgets.values()].join('\n'); return; }
  if (event.type === 'extension_ui_notify') { toast(event.message, event.level); return; }
  if (event.type === 'pforge_mcp_changed') { toast('MCP 配置已更新，空闲会话已重新加载；列表可点击刷新', 'info'); return; }
  if (event.type === 'pforge_status') { $('run-status-label').textContent = event.text || '准备就绪'; return; }
  if (event.type === 'pforge_error') { setRunning(false); state.error = event.error; state.outcome = 'failed'; renderRunStatus(); toast(event.error, 'error'); }
  if (event.type === 'compaction_start') { state.compacting = true; state.context = { ...state.context, error: null }; setRunning(state.running); }
  if (event.type === 'compaction_end') { state.compacting = false; state.context = { ...state.context, error: event.errorMessage, compacting: false }; setRunning(state.running); }
  if (event.type === 'auto_retry_start') $('run-status-label').textContent = '模型请求重试 ' + event.attempt + '/' + event.maxAttempts;
}
function connect(sessionId) {
  if (state.eventSource) state.eventSource.close();
  const controller = new AbortController();
  state.eventSource = { close: () => controller.abort() };
  state.lastEventId = 0;
  void (async () => {
    let retries = 0;
    while (!controller.signal.aborted && state.sessionId === sessionId) {
      try {
        await readEventStream('/api/sessions/' + sessionId + '/events', token, { signal: controller.signal, after: state.lastEventId, onEvent: (message) => {
          const event = JSON.parse(message.data); const id = Number(message.id);
          if (event.type !== 'pforge_snapshot' && Number.isFinite(id) && id <= state.lastEventId) return;
          if (Number.isFinite(id)) state.lastEventId = id;
          retries = 0;
          $('connection-label').innerHTML = '<span class="meta-dot live"></span>本地 Forge Agent 已连接';
          handleEvent(event);
        } });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof StreamError && error.status === 401) { showAuthRequired(); return; }
        if (error instanceof StreamError && error.status === 404) {
          $('connection-label').textContent = '服务已重启 · 正在恢复会话';
          await resumeActiveSession();
          return;
        }
      }
      if (controller.signal.aborted) return;
      $('connection-label').textContent = '连接中断 · 正在重连';
      await new Promise((resolve) => { const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, Math.min(1000 * 2 ** retries++, 10000)); controller.signal.addEventListener('abort', done, { once: true }); });
    }
  })();
}
async function createSession(sessionFile, title, preserveSessionConfig = false, connectEvents = true) {
  if (state.sessionId) rememberDraft();
  if (!state.project) throw new Error('请先选择项目文件夹');
  if (!state.model && !sessionFile) throw new Error('请先在设置里配置可用模型');
  const payload = { project: state.project.path, sessionFile, title };
  if (!sessionFile) payload.mode = state.mode;
  if (!preserveSessionConfig && state.model) { payload.model = state.model.key; payload.thinkingLevel = state.thinkingLevel; }
  if (!sessionFile && state.mode === 'agent') payload.workflow = state.workflow;
  const created = await api('/api/session', { method: 'POST', body: JSON.stringify(payload) });
  state.eventSource?.close(); state.eventSource = null;
  state.sessionId = created.id;
  state.sessionPath = created.sessionFile || sessionFile || null;
  state.pendingModelKey = null; state.pendingThinkingLevel = null;
  setProject({ path: created.project, name: shortPath(created.project) });
  applySnapshot(created); if (connectEvents) connect(created.id); renderProjects();
  restoreDraft();
  showChat();
  return created;
}
async function openSession(path, project) {
  if (state.compacting || state.compactRequest || state.loadingSession || state.running || state.changingConfig || state.changingMode || state.sending) { toast('请等待当前操作完成，或先停止正在运行的会话'); return; }
  closeCommandPicker(); closeContext(); closeModelPicker();
  rememberDraft();
  state.loadingSession = true;
  setRunning(state.running);
  const previousProject = state.project;
  setProject({ path: project, name: shortPath(project) });
  state.expandedProjects.add(project);
  try { await createSession(path, '历史对话', true); toggleSidebar(false); } catch (error) { setProject(previousProject); toast(error.message, 'error'); } finally { state.loadingSession = false; setRunning(state.running); }
}
async function refreshSessionState() {
  if (!state.sessionId) return;
  const data = await api('/api/sessions/' + state.sessionId + '/state');
  applySnapshot(data);
}
async function sendPrompt(prompt, command = false) {
  if (!prompt.trim() || state.compacting || state.compactRequest || state.running || state.loadingSession || state.changingMode || state.changingConfig) return false;
  closeCommandPicker(); closeContext(); closeModelPicker();
  state.loadingSession = true; $('run-button').disabled = true;
  let createdId;
  try {
    const session = await createSession(undefined, prompt.slice(0, 60), false, false);
    createdId = session.id;
    state.runStartedAt = Date.now(); state.runFinishedAt = null; state.error = null; state.outcome = 'running'; renderVerification(null); setRunning(true); renderRunStatus();
    await api('/api/sessions/' + session.id + '/prompt', { method: 'POST', body: JSON.stringify({ message: prompt, workflow: !command && state.mode === 'agent' ? state.workflow : 'direct', ...(command ? { command: true } : {}) }) });
    loadProjects().catch(() => {}); return true;
  } catch (error) { setRunning(false); toast(error.message, 'error'); if (!state.model) openSettings(); return false; } finally { if (createdId && state.sessionId === createdId) connect(createdId); state.loadingSession = false; setRunning(state.running); }
}
async function applyPendingSessionConfig() {
  if (!state.sessionId || state.readOnly) return;
  const modelKey = state.pendingModelKey;
  const thinkingLevel = state.pendingThinkingLevel;
  if (!modelKey && thinkingLevel === null) return;
  if (modelKey && modelKey !== state.activeModelKey && !(await changeModel(modelKey, true, true))) throw new Error('无法应用下一条消息的模型配置');
  if (thinkingLevel !== null && thinkingLevel !== state.activeThinkingLevel && !(await changeThinking(thinkingLevel, true, true))) throw new Error('无法应用下一条消息的推理强度');
  state.pendingModelKey = null; state.pendingThinkingLevel = null;
  state.thinkingLevel = state.activeThinkingLevel; setModel(modelByKey(state.activeModelKey) || state.model);
}
async function sendFollowup(prompt, command = false) {
  if (!prompt.trim() || state.compacting || state.compactRequest || state.running || state.loadingSession || state.changingMode || state.changingConfig || state.sending || state.runControl || state.readOnly || !state.sessionId) return false;
  closeCommandPicker(); closeContext(); closeModelPicker();
  state.sending = true; setRunning(state.running);
  try {
    await applyPendingSessionConfig();
    state.runStartedAt = Date.now(); state.runFinishedAt = null; state.error = null; state.outcome = 'running'; renderVerification(null); setRunning(true); renderRunStatus();
    await api('/api/sessions/' + state.sessionId + '/prompt', { method: 'POST', body: JSON.stringify({ message: prompt, workflow: !command && state.mode === 'agent' ? state.workflow : 'direct', ...(command ? { command: true } : {}) }) });
    return true;
  } catch (error) { setRunning(false); toast(error.message, 'error'); refreshSessionState().catch(() => {}); return false; }
  finally { state.sending = false; setRunning(state.running); }
}
async function stopExecution() {
  if (!state.sessionId || !state.running || state.runControl) return false;
  const sessionId = state.sessionId, restoreFocus = document.activeElement === $('stop-button');
  state.runControl = 'stopping'; setRunning(state.running);
  try {
    await api('/api/sessions/' + sessionId + '/abort', { method: 'POST' });
    // The abort endpoint waits for Pi and verification to settle. Use the snapshot
    // to distinguish a real interruption from a run that finished before the click.
    if (sessionId === state.sessionId) await refreshSessionState();
    return true;
  } catch (error) { toast('停止失败：' + error.message, 'error'); return false; }
  finally { if (sessionId === state.sessionId) { state.runControl = null; setRunning(state.running); if (restoreFocus) (state.running ? $('stop-button') : continuationKind() && !$('followup-prompt').value.trim() ? $('resume-task-button') : $('followup-prompt')).focus({ preventScroll: true }); } }
}
async function resumeExecution() {
  const kind = continuationKind();
  if (!kind || state.compacting || state.compactRequest || state.loadingSession || state.changingMode || state.changingConfig || state.sending || state.runControl) return false;
  closeModelPicker(); closeModePicker();
  const sessionId = state.sessionId;
  state.runControl = 'resuming'; state.sending = true; setRunning(state.running);
  try {
    await applyPendingSessionConfig();
    if (kind === 'task') await api('/api/sessions/' + sessionId + '/resume-task', { method: 'POST', body: '{}' });
    else await api('/api/sessions/' + sessionId + '/prompt', { method: 'POST', body: JSON.stringify({ message: '继续刚才中断的请求。先核对对话记录和已完成的工作，再接着处理尚未完成的部分；不要重复执行已完成的操作。', workflow: 'direct' }) });
    state.runStartedAt = Date.now(); state.runFinishedAt = null; state.error = null; state.outcome = 'running'; renderVerification(null); setRunning(true); renderRunStatus();
    void refreshSessionState().catch(() => {});
    return true;
  } catch (error) { toast('继续失败：' + error.message, 'error'); void refreshSessionState().catch(() => {}); return false; }
  finally { if (sessionId === state.sessionId) { state.runControl = null; state.sending = false; setRunning(state.running); } }
}
async function openFolder(path = state.project && state.project.path) {
  try {
    const data = await api('/api/directories' + (path ? '?path=' + encodeURIComponent(path) : ''));
    state.folderPath = data.path; state.folderParent = data.parent; $('folder-path').textContent = data.path;
    $('folder-list').innerHTML = (data.directories || []).map((dir) => '<button class="folder-row" data-folder="' + esc(dir.path) + '"><span>▱</span><span>' + esc(dir.name) + '</span><span>›</span></button>').join('') || '<div class="empty-sessions">没有子文件夹</div>';
    $('folder-modal').classList.remove('hidden');
  } catch (error) { toast(error.message, 'error'); }
}
function openProjectFolderPicker() {
  if (state.sessionId) { toast('当前对话已绑定项目，请新建对话后切换项目'); return; }
  return openFolder();
}
function providerOptions() {
  const ids = Array.from(new Set(state.providers.map((provider) => provider.id)));
  return ids.map((id) => { const provider = state.providers.find((item) => item.id === id); return '<option value="' + esc(id) + '">' + esc(provider ? provider.name : id) + (provider && provider.auth && provider.auth.configured ? ' · 已配置' : '') + '</option>'; }).join('') || '<option value="">暂无可配置 Provider</option>';
}
function modelCard(model) {
  const abilities = [model.reasoning ? '推理' : '', model.input.includes('image') ? '视觉输入' : '', model.promptCache ? '提示缓存' : ''].filter(Boolean).join(' · ') || '文本对话';
  return '<article class="model-card" data-model-card="' + esc(model.key) + '"><span class="model-card-main"><strong>' + esc(model.name) + '</strong><small>' + esc(model.providerName) + ' · ' + esc(model.id) + '</small></span><span class="model-capabilities">' + esc(abilities) + '</span><span class="model-context">' + (model.contextWindow ? formatNumber(model.contextWindow) + ' tokens' : '—') + '</span><span class="model-availability">可用</span></article>';
}
async function openSettings(tab, editModel) {
  if (state.compacting || state.compactRequest || state.openingSettings || state.running || state.loadingSession || state.changingMode || state.changingConfig || state.sending) return;
  closeCommandPicker(); closeContext(); closeModelPicker();
  if (changesMedia?.matches) toggleChanges(false);
  state.openingSettings = true;
  if (typeof tab === 'string') state.settingsTab = tab;
  state.settingsTab ||= 'provider';
  $('drawer-title').textContent = '设置';
  $('drawer').classList.remove('hidden'); $('drawer-backdrop').classList.remove('hidden'); toggleSidebar(false);
  $('drawer-body').innerHTML = '<p class="settings-note">正在读取本机设置…</p>';
  try {
    state.mcpSettings?.dispose(); state.skillsSettings?.dispose();
    const [config, credentials, settings, mcp] = await Promise.all([api('/api/config' + (state.project ? '?project=' + encodeURIComponent(state.project.path) : '')), api('/api/credentials'), api('/api/settings'), api('/api/mcp' + (state.project ? '?project=' + encodeURIComponent(state.project.path) : ''))]);
    state.providers = settings.providers || [];
    state.models = settings.models || [];
    const models = settings.models || [];
    const credentialRows = (credentials.credentials || []).map((item) => '<div class="credential-row"><span>' + esc(item.provider) + '</span><small>' + esc(item.type) + '</small><button class="text-button" data-remove-provider="' + esc(item.provider) + '">移除</button></div>').join('');
    const currentDefault = models.find((model) => model.key === settings.model);
    $('drawer-body').innerHTML =
      '<nav class="settings-tabs" aria-label="设置分类"><button data-settings-tab="provider">服务</button><button data-settings-tab="model">模型</button><button data-settings-tab="mcp">MCP</button><button data-settings-tab="skills">技能</button><button data-settings-tab="project">项目</button><button data-settings-tab="system">关于</button></nav>' +
      '<div data-settings-panel="model"><section class="settings-block"><div class="settings-heading"><div><h3>可用模型</h3><p>当前使用的模型和推理强度，在聊天框下方选择。</p></div><button class="button quiet small" id="refresh-models">刷新目录</button></div><label>服务筛选<select id="model-provider-filter"><option value="">所有服务</option>' + state.providers.filter((provider) => provider.availableModelCount).map((provider) => '<option value="' + esc(provider.id) + '">' + esc(provider.name) + '</option>').join('') + '</select></label><label>搜索模型<input id="model-search" type="search" placeholder="模型名称、ID 或能力" autocomplete="off"></label><div class="settings-note" id="model-count"></div><div class="model-list" id="model-list"></div><button class="button quiet small hidden" id="more-models">显示更多</button><button class="button quiet small" id="manage-model-services">管理服务与可用模型</button></section></div>' +
      '<div data-settings-panel="provider"><div id="custom-providers"></div><section class="settings-block"><details class="builtin-provider"><summary>内置服务与凭据</summary><div class="provider-form"><p>选择内置服务并保存 Key。OAuth 登录请使用本机 forge-agent 中的 /login。</p><label>Provider<select id="credential-provider">' + providerOptions() + '</select></label><div id="provider-info" class="model-facts"></div><label>API Key<input id="credential-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="保存后不会回显"></label><button class="button primary" id="save-credential">保存凭据</button><div class="credential-list">' + (credentialRows || '<p class="settings-note">暂无已保存的凭据</p>') + '</div></div></details></section><p class="settings-note">配置和凭据保存在本机。已配置凭据表示可以发起调用，实际结果以模型请求为准。</p></div>' +
      '<div data-settings-panel="mcp"><div id="mcp-settings"></div></div>' +
      '<div data-settings-panel="skills"><div id="skills-settings"></div></div>' +
      '<div data-settings-panel="project"><section class="settings-block"><h3>当前项目</h3><code class="settings-path">' + esc(state.project?.path || '未选择项目') + '</code><p>信任后允许加载项目扩展及验证命令。变更信任会卸载当前会话的项目资源，需要重新选择模型继续。</p><div class="trust-setting"><span>' + (state.trust?.trusted ? '项目已信任' : '项目未信任') + '</span><button class="button quiet" id="toggle-trust">' + (state.trust?.trusted ? '撤销信任' : '信任当前项目') + '</button></div></section><section class="settings-block"><h3>自动验证</h3><p>在当前项目的 forge-agent.json 中设置 verify 与 verifyRetries。</p><pre class="settings-code">' + esc(config.verify?.length ? config.verify.map((item) => item.name + ': ' + item.command).join(String.fromCharCode(10)) : '未配置验证命令') + '</pre></section></div>' +
      '<div data-settings-panel="system"><section class="settings-block"><h3>Forge Agent · 本机 Coding Agent</h3><p>Agent 运行、认证、工具、会话、扩展、MCP 与 Skills 由 Pi 提供。</p><div class="config-row"><span>Pi 版本</span><code>' + esc(settings.piVersion) + '</code></div><div class="config-row block"><span>设置文件</span><code>' + esc(settings.settingsPath) + '</code></div><div class="config-row block"><span>启动目录</span><code>' + esc(config.cwd) + '</code></div><p>目录共 ' + settings.allModelCount + ' 个模型，当前已配置认证的模型 ' + models.length + ' 个。</p></section></div>';
    const activateTab = (name) => {
      state.settingsTab = name;
      document.querySelectorAll('[data-settings-panel]').forEach((node) => node.classList.toggle('hidden', node.dataset.settingsPanel !== name));
      document.querySelectorAll('[data-settings-tab]').forEach((button) => { button.classList.toggle('active', button.dataset.settingsTab === name); button.setAttribute('aria-pressed', String(button.dataset.settingsTab === name)); });
    };
    $('drawer-body').querySelectorAll('[data-settings-tab]').forEach((button) => { button.onclick = () => activateTab(button.dataset.settingsTab); });
    activateTab(state.settingsTab);
    const providerSelect = $('model-provider-filter');
    let visibleLimit = 40;
    const renderCatalog = () => {
      const query = $('model-search').value.trim().toLowerCase();
      const filtered = models.filter((model) => (!providerSelect.value || model.provider === providerSelect.value) && (model.name + ' ' + model.id + (model.reasoning ? ' 推理' : '') + (model.input.includes('image') ? ' 视觉' : '')).toLowerCase().includes(query));
      $('model-list').innerHTML = filtered.slice(0, visibleLimit).map(modelCard).join('') || '<div class="settings-note">暂无匹配模型。请先在“连接”中保存对应 Provider 的凭据。</div>';
      $('model-count').textContent = '显示 ' + Math.min(visibleLimit, filtered.length) + ' / ' + filtered.length + ' 个';
      $('more-models').classList.toggle('hidden', filtered.length <= visibleLimit);
    };
    renderCatalog(); providerSelect.onchange = () => { visibleLimit = 40; renderCatalog(); };
    $('manage-model-services').onclick = () => activateTab('provider');
    $('model-search').oninput = () => { visibleLimit = 40; renderCatalog(); };
    $('more-models').onclick = () => { visibleLimit += 40; renderCatalog(); };
    const action = (id, label, work) => { const button = $(id); button.onclick = async () => { setBusy(button, true, label); try { await work(); } catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); } }; };
    action('refresh-models', '刷新中…', async () => { const result = await api('/api/models/refresh', { method: 'POST' }); await loadModels(); await openSettings(); toast(result.errors?.length ? '目录已刷新，' + result.errors.length + ' 个 Provider 返回错误' : '模型目录已刷新', result.errors?.length ? 'warning' : 'info'); });
    const authProvider = $('credential-provider');
    if (currentDefault) authProvider.value = currentDefault.provider;
    const renderProvider = () => { const provider = state.providers.find((item) => item.id === authProvider.value); $('provider-info').innerHTML = provider ? '<span>' + esc(provider.auth?.configured ? '已配置认证' : '待配置') + '</span><span>' + provider.availableModelCount + '/' + provider.modelCount + ' 个可用模型</span>' + (provider.baseUrl ? '<span>' + esc(provider.baseUrl) + '</span>' : '') : ''; };
    authProvider.onchange = renderProvider; renderProvider();
    action('save-credential', '保存中…', async () => { const apiKey = $('credential-key').value.trim(); if (!apiKey) throw new Error('请输入 API Key'); await api('/api/credentials', { method: 'POST', body: JSON.stringify({ provider: authProvider.value, apiKey }) }); $('credential-key').value = ''; await loadModels(); await openSettings(); toast('凭据已保存'); });
    $('drawer-body').querySelectorAll('[data-remove-provider]').forEach((button) => { button.onclick = async () => { setBusy(button, true, '移除中…'); try { await api('/api/credentials?provider=' + encodeURIComponent(button.dataset.removeProvider), { method: 'DELETE' }); await loadModels(); await openSettings(); toast('凭据已移除'); } catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); } }; });
    $('toggle-trust').disabled = state.running || !state.project;
    action('toggle-trust', '更新中…', async () => { if (!state.project) throw new Error('请先选择项目'); const result = await api('/api/projects/trust', { method: 'POST', body: JSON.stringify({ path: state.project.path, trusted: !state.trust?.trusted }) }); state.trust = result.trust; renderTrust(); if (state.sessionId) await refreshSessionState(); await loadProjects(); await openSettings(); });
    await mountCustomProviders($('custom-providers'), { api, esc, setBusy, initialProvider: editModel?.provider, initialModel: editModel?.id, onSaved: async () => { await loadModels(); if (state.sessionId) await refreshSessionState(); await openSettings('provider'); toast('服务已保存，在聊天框下方选择模型与推理强度'); } });
    state.mcpSettings = mountMcp($('mcp-settings'), { api, esc, initial: mcp, projectPath: state.project?.path || config.cwd, runtimeEnabled: true, isVisible: () => !$('drawer').classList.contains('hidden') && state.settingsTab === 'mcp', onChanged: async () => { await loadProjects(); if (state.sessionId) await refreshSessionState(); } });
    state.skillsSettings = mountSkills($('skills-settings'), { api, esc, projectPath: state.project?.path || config.cwd, onChanged: async () => { if (state.sessionId) await refreshSessionState(); } });
  } catch (error) { $('drawer-body').textContent = '读取设置失败：' + error.message; toast(error.message, 'error'); }
  finally { state.openingSettings = false; }
}
function closeSettings() { state.mcpSettings?.dispose(); state.mcpSettings = null; state.skillsSettings?.dispose(); state.skillsSettings = null; $('drawer').classList.add('hidden'); $('drawer-backdrop').classList.add('hidden'); }
function toggleSidebar(open) { if (open && changesMedia?.matches) toggleChanges(false); $('sidebar').classList.toggle('mobile-open', open); $('sidebar-backdrop').classList.toggle('hidden', !open); $('mobile-menu').setAttribute('aria-expanded', String(open)); }
function setBusy(button, busy, label = '处理中…') { if (!button) return; if (busy) { button.dataset.label = button.textContent; button.textContent = label; } else if (button.dataset.label) { button.textContent = button.dataset.label; delete button.dataset.label; } button.disabled = busy; }
const MODES = {
  agent: '根据任务复杂度选择工具和执行步骤。',
  plan: '只读调研并生成实施计划；确认方案后切换 Agent 执行。',
  ask: '只读问答与代码解释，不修改文件、不执行命令。'
};
function modeDescription() {
  if (state.mode === 'agent' && state.workflow === 'planned') return '复杂修改先规划，再实现、验证和审阅；简单问题会直接回答。';
  if (state.mode === 'agent') return '简单问题直接回答；需要修改代码时按任务复杂度执行。';
  return MODES[state.mode];
}
function modeSelectionValue() { return state.mode === 'agent' ? 'agent:' + state.workflow : state.mode; }
function parseModeSelection(value) {
  if (value === 'agent:planned') return { mode: 'agent', workflow: 'planned' };
  if (value === 'agent' || value === 'agent:direct') return { mode: 'agent', workflow: 'direct' };
  return { mode: Object.hasOwn(MODES, value) ? value : 'agent', workflow: state.workflow };
}
function syncModeControls() {
  const selection = modeSelectionValue();
  ['mode-select', 'followup-mode-select'].forEach((id) => { if ($(id)) { $(id).value = selection; $(id).title = modeDescription() + '  Shift+Tab 切换'; } });
  ['mode-description', 'followup-mode-description'].forEach((id) => { if ($(id)) { $(id).textContent = modeDescription(); $(id).classList.toggle('hidden', state.mode === 'agent'); } });
  const planned = state.mode === 'agent' && state.workflow === 'planned';
  ['mode-picker-button', 'followup-mode-picker-button'].forEach((id) => {
    const button = $(id), label = state.mode === 'agent' ? 'Agent' : state.mode === 'plan' ? 'Plan' : 'Ask';
    button.querySelector('[data-mode-label]').textContent = label;
    button.querySelector('[data-workflow-label]').classList.toggle('hidden', !planned);
    button.setAttribute('aria-label', '工作模式：' + label + (state.mode === 'agent' ? planned ? '，规划并执行' : '，自适应（默认）' : ''));
    button.title = modeDescription();
  });
  $('mode-picker').querySelectorAll('[data-choose-mode]').forEach((button) => { const selected = button.dataset.chooseMode === 'agent' ? state.mode === 'agent' : button.dataset.chooseMode === selection; button.setAttribute('aria-pressed', String(selected)); button.querySelector('.mode-check').textContent = selected ? '✓' : ''; });
  $('mode-agent-toggle').title = '执行策略：' + (planned ? '规划并执行' : '自适应（默认）');
  ['workflow-select', 'followup-workflow-select'].forEach((id) => { if ($(id)) { $(id).value = state.workflow; $(id).disabled = state.running || state.mode !== 'agent'; $(id).closest('label').classList.toggle('hidden', true); } });
}
function closeModePicker(restoreFocus = false) {
  const anchor = state.modePickerAnchor;
  state.modePickerAnchor = null; $('mode-picker').classList.add('hidden');
  setAgentStrategiesExpanded(false);
  ['mode-picker-button', 'followup-mode-picker-button'].forEach((id) => $(id).setAttribute('aria-expanded', 'false'));
  if (restoreFocus && anchor && !anchor.disabled) anchor.focus();
}
function setAgentStrategiesExpanded(expanded) {
  $('mode-agent-toggle').setAttribute('aria-expanded', String(expanded));
  $('agent-strategies').classList.toggle('hidden', !expanded);
  if (state.modePickerAnchor) positionPicker($('mode-picker'), state.modePickerAnchor, 264);
}
function toggleModePicker(button) {
  if (state.compacting || state.compactRequest || state.running || state.loadingSession || state.changingMode || state.changingConfig || state.sending) return;
  if (state.modePickerAnchor === button) { closeModePicker(true); return; }
  closeCommandPicker(); closeContext(); closeModelPicker(); closeModePicker(); state.modePickerAnchor = button;
  syncModeControls(); $('mode-picker').classList.remove('hidden'); button.setAttribute('aria-expanded', 'true');
  positionPicker($('mode-picker'), button, 264); $('mode-picker').querySelector('[data-choose-mode="' + state.mode + '"]').focus();
}
function setMode(mode) {
  state.mode = Object.hasOwn(MODES, mode) ? mode : 'agent';
  syncModeControls();
  renderComposerControl();
}
async function changeMode(mode) {
  const previous = state.mode;
  if (state.compacting || state.compactRequest || state.running || state.loadingSession || state.changingMode || state.changingConfig || state.sending || !Object.hasOwn(MODES, mode)) { setMode(previous); return; }
  state.changingMode = true; setRunning(state.running);
  try {
    if (state.sessionId) {
      const data = await api('/api/sessions/' + state.sessionId + '/mode', { method: 'POST', body: JSON.stringify({ mode }) });
      setMode(data.mode); if (data.workflow) setWorkflow(data.workflow); renderRunStatus({ ...state, mode: data.mode });
    } else setMode(mode);
    saveStored('pforge.mode', state.mode);
  } catch (error) { setMode(previous); toast(error.message, 'error'); }
  finally { state.changingMode = false; setRunning(state.running); }
}
async function changeModeSelection(value) {
  const selection = parseModeSelection(value);
  const previousMode = state.mode, previousWorkflow = state.workflow;
  if (state.compacting || state.compactRequest || state.running || state.loadingSession || state.changingMode || state.changingConfig || state.sending) { syncModeControls(); return; }
  if (selection.mode === state.mode) {
    if (selection.mode === 'agent') await changeWorkflow(selection.workflow);
    else syncModeControls();
    return;
  }
  if (selection.mode === 'agent') setWorkflow(selection.workflow);
  await changeMode(selection.mode);
  if (state.mode !== selection.mode) { setWorkflow(previousWorkflow); syncModeControls(); return; }
  if (state.mode === 'agent') await changeWorkflow(selection.workflow);
  else setWorkflow('direct');
  if (previousMode !== state.mode && state.mode === 'agent') syncModeControls();
}
async function changeModel(key, session = Boolean(state.sessionId), applying = false) {
  const model = modelByKey(key);
  if (!model?.available || state.compacting || state.compactRequest || state.loadingSession || state.changingConfig || state.changingMode || (state.sending && !applying)) { renderModelOptions(); return false; }
  if (state.running) {
    state.pendingModelKey = model.key === state.activeModelKey ? null : model.key;
    state.model = model;
    const preferred = model.key === state.activeModelKey ? state.activeThinkingLevel : state.modelThinkingLevels[model.key] ?? state.thinkingLevel;
    state.thinkingLevel = supportedThinking(model, preferred);
    state.pendingThinkingLevel = state.pendingModelKey ? state.thinkingLevel : null;
    setModel(model); return true;
  }
  if (model.key === state.activeModelKey && !state.readOnly) {
    state.pendingModelKey = null; state.pendingThinkingLevel = null; state.thinkingLevel = state.activeThinkingLevel;
    setModel(model); return true;
  }
  state.changingConfig = true; setRunning(state.running); $('model-save-status').textContent = '正在切换模型…';
  try {
    const path = session && state.sessionId ? '/api/sessions/' + state.sessionId + '/model' : '/api/settings';
    const data = await api(path, { method: 'POST', body: JSON.stringify({ model: key }) });
    if (data.snapshot) applySessionConfig(data.snapshot);
    else applySessionConfig({ model, thinkingLevel: data.thinkingLevel || 'off', ...(session && state.sessionId ? { readOnly: false } : {}) });
    state.activeModelKey = model.key; state.pendingModelKey = null;
    if (!applying) state.pendingThinkingLevel = null;
    state.thinkingLevel = supportedThinking(model, state.pendingThinkingLevel ?? state.activeThinkingLevel);
    setModel(model);
    state.modelThinkingLevels = data.modelThinkingLevels || state.modelThinkingLevels;
    renderSessionMeta({ model: state.model }); $('model-save-status').textContent = session && state.sessionId ? '已应用到当前会话' : '已保存，新对话将使用此模型';
    return true;
  } catch (error) { setModel(state.model); $('model-save-status').textContent = '切换失败：' + error.message; toast(error.message, 'error'); return false; }
  finally { state.changingConfig = false; renderModelOptions(); renderThinking(); setRunning(state.running); }
}
async function changeThinking(level, session = Boolean(state.sessionId), applying = false) {
  if (!state.model?.available || !state.model.thinkingLevels?.includes(level) || state.compacting || state.compactRequest || state.loadingSession || state.changingConfig || state.changingMode || (state.sending && !applying)) { renderThinking(); return false; }
  if (state.running || (hasPendingSessionConfig() && !applying)) {
    state.pendingThinkingLevel = !state.pendingModelKey && level === state.activeThinkingLevel ? null : level; state.thinkingLevel = level; setModel(state.model); return true;
  }
  state.changingConfig = true; setRunning(state.running); $('model-save-status').textContent = '正在保存推理强度…';
  try {
    const active = session && state.sessionId;
    const data = await api(active ? '/api/sessions/' + state.sessionId + '/thinking' : '/api/settings', { method: 'POST', body: JSON.stringify(active ? { level, persist: true } : { model: state.model.key, thinkingLevel: level }) });
    applySessionConfig(data.snapshot || { thinkingLevel: data.thinkingLevel || level });
    state.pendingThinkingLevel = null; state.thinkingLevel = state.activeThinkingLevel; setModel(state.model);
    state.modelThinkingLevels = data.modelThinkingLevels || { ...state.modelThinkingLevels, [state.model.key]: state.thinkingLevel };
    $('model-save-status').textContent = '推理强度已保存，切回此模型时继续使用';
    return true;
  } catch (error) { setModel(state.model); $('model-save-status').textContent = '保存失败：' + error.message; toast(error.message, 'error'); return false; }
  finally { state.changingConfig = false; renderThinking(); setRunning(state.running); }
}
async function loadConfig() {
  try { await Promise.all([loadProjects(), loadModels()]); $('connection-label').innerHTML = '<span class="meta-dot live"></span>本地 Forge Agent 已连接'; return true; }
  catch (error) { if (error.status !== 401) $('connection-label').textContent = '无法连接本地服务'; toast(error.message, 'error'); return false; }
}
function resetSessionView() {
  closeCommandPicker(); closeContext();
  state.context = null; state.runtimeCommands = []; state.compacting = false; state.runStartedAt = null; state.runFinishedAt = null;
  cancelStreamedMarkdown();
  rememberDraft(); renderTask(null); toggleChanges(false);
  state.runMode = undefined;
  setWorkflow('direct');
  setMode(stored('pforge.mode', 'agent'));
  state.sessionId = null; state.sessionPath = null; state.readOnly = false; state.outcome = 'idle'; state.error = null; state.lastEventId = 0; state.uiQueue = []; state.widgets.clear(); state.executionProcess = null; state.turnAnswer = null;
  if (state.eventSource) state.eventSource.close(); state.eventSource = null;
  saveStored('pforge.activeSession', null, sessionStorage);
  $('prompt').value = ''; $('followup-prompt').value = ''; $('timeline').innerHTML = ''; $('extension-widgets').textContent = ''; renderVerification(null); closeUiModal(); setRunning(false); renderProjects();
  restoreDraft();
}
async function newConversation() {
  if (state.compacting || state.compactRequest || state.running || state.loadingSession || state.changingConfig || state.changingMode || state.sending) { toast('请等待当前操作完成，或先停止正在运行的会话'); return; }
  closeModelPicker(); closeModePicker();
  resetSessionView(); showStart(); toggleSidebar(false);
  try { await loadModels(); } catch (error) { toast(error.message, 'error'); }
  $('prompt').focus();
}
async function resumeActiveSession() {
  if (state.sessionId) rememberDraft();
  const active = stored('pforge.activeSession', null, sessionStorage);
  if (!active?.project || !active.id) return false;
  setProject({ path: active.project, name: shortPath(active.project) });
  try {
    const data = await api('/api/sessions/' + active.id);
    state.sessionId = data.id; state.sessionPath = data.sessionFile || active.path; applySnapshot(data); restoreDraft(); connect(data.id); showChat(); renderProjects();
    return true;
  } catch (error) {
    if (error.status === 401) return false;
    if (error.status === 404 && active.path) {
      try { await createSession(active.path, '历史对话', true); toast('服务已重启，已恢复历史会话；未自动重发任务'); return true; }
      catch (restoreError) { if (restoreError.status === 401) return false; toast('会话恢复失败：' + restoreError.message, 'error'); }
    } else if (error.status === 404) {
      $('prompt').value = $('followup-prompt').value || $('prompt').value;
      setRunning(false); state.sessionId = null; state.sessionPath = null; showStart();
      toast('上次会话尚未保存。草稿已保留，请重新发送。', 'warning');
      saveStored('pforge.activeSession', null, sessionStorage);
      return false;
    } else toast('暂时无法恢复会话：' + error.message, 'warning');
    $('connection-label').textContent = '会话暂时不可用 · 可从左侧重新打开';
    return false;
  }
}
$('auth-form').addEventListener('submit', (event) => { event.preventDefault(); void recoverAuthorization(); });
window.addEventListener('focus', () => { if (state.authRequired) void recoverAuthorization(true); });
$('auth-modal').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.stopPropagation(); return; }
  if (event.key !== 'Tab') return;
  const inputs = [...$('auth-modal').querySelectorAll('input, button')].filter((node) => !node.disabled);
  const first = inputs[0], last = inputs[inputs.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$('composer').addEventListener('submit', async (event) => {
  event.preventDefault(); if (await handleCommandSubmit($('prompt'))) return; const prompt = $('prompt').value;
  if (await sendPrompt(prompt)) { $('prompt').value = ''; saveStored('pforge.draft.new@' + (state.project?.path || ''), null, sessionStorage); }
  else if (state.sessionId) $('followup-prompt').value = prompt;
});
$('followup-form').addEventListener('submit', async (event) => { event.preventDefault(); if (await handleCommandSubmit($('followup-prompt'))) return; const prompt = $('followup-prompt').value; if (!prompt.trim()) { await resumeExecution(); return; } if (await sendFollowup(prompt)) { $('followup-prompt').value = ''; rememberDraft(); renderComposerControl(); } });
['prompt', 'followup-prompt'].forEach((id) => $(id).addEventListener('input', () => { rememberDraft(); renderComposerControl(); state.commandIndex = 0; updateCommandPicker($(id)); }));
window.addEventListener('pagehide', rememberDraft);
['prompt', 'followup-prompt'].forEach((id) => $(id).addEventListener('keydown', (event) => {
  if (commandKeydown(event, $(id))) return;
  if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) { event.preventDefault(); const modes = Object.keys(MODES); void changeMode(modes[(modes.indexOf(state.mode) + 1) % modes.length]); }
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) { event.preventDefault(); $(id === 'prompt' ? 'composer' : 'followup-form').requestSubmit(); }
}));
setMode(stored('pforge.mode', 'agent'));
setWorkflow(state.workflow);
$('mode-select').addEventListener('change', (event) => changeModeSelection(event.target.value));
$('followup-mode-select').addEventListener('change', (event) => changeModeSelection(event.target.value));
['mode-picker-button', 'followup-mode-picker-button'].forEach((id) => $(id).addEventListener('click', (event) => toggleModePicker(event.currentTarget)));
$('mode-agent-toggle').addEventListener('click', () => setAgentStrategiesExpanded($('mode-agent-toggle').getAttribute('aria-expanded') !== 'true'));
$('mode-picker').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight' && (event.target.closest('[data-choose-mode="agent"]') || event.target.closest('#mode-agent-toggle'))) {
    event.preventDefault(); setAgentStrategiesExpanded(true);
    ($('agent-strategies').querySelector('[aria-pressed="true"]') || $('agent-strategies').querySelector('button')).focus();
  } else if ((event.key === 'ArrowLeft' || event.key === 'Escape') && $('mode-agent-toggle').getAttribute('aria-expanded') === 'true') {
    event.preventDefault(); event.stopPropagation(); setAgentStrategiesExpanded(false); $('mode-agent-toggle').focus();
  }
});
$('mode-picker').addEventListener('click', async (event) => { const option = event.target.closest('[data-choose-mode]'); if (!option) return; closeModePicker(true); await changeModeSelection(option.dataset.chooseMode); });
['workflow-select', 'followup-workflow-select'].forEach((id) => $(id)?.addEventListener('change', (event) => setWorkflow(event.target.value)));
document.querySelectorAll('.suggestion').forEach((button) => button.addEventListener('click', () => { $('prompt').value = button.textContent; $('prompt').focus(); }));
$('model-picker-button').addEventListener('click', (event) => toggleModelPicker(event.currentTarget));
$('followup-model-picker-button').addEventListener('click', (event) => toggleModelPicker(event.currentTarget));
$('chat-model-search').addEventListener('input', renderModelOptions);
$('chat-model-search').addEventListener('keydown', (event) => { if (event.key === 'ArrowDown') { event.preventDefault(); $('chat-model-options').querySelector('input:not(:disabled)')?.focus(); } });
$('chat-model-options').addEventListener('change', (event) => { if (event.target.dataset.chooseModel) void changeModel(event.target.dataset.chooseModel); });
$('thinking-select').addEventListener('change', (event) => changeThinking(event.target.value));
$('manage-chat-models').addEventListener('click', () => openSettings('provider'));
$('configure-thinking').addEventListener('click', () => openSettings('provider', state.model));
document.addEventListener('click', (event) => { if (state.pickerAnchor && !$('model-picker').contains(event.target) && !event.target.closest('.model-picker-button')) closeModelPicker(); });
document.addEventListener('focusin', (event) => { if (state.pickerAnchor && !$('model-picker').contains(event.target) && !event.target.closest('.model-picker-button')) closeModelPicker(); });
document.addEventListener('click', (event) => { if (state.modePickerAnchor && !$('mode-picker').contains(event.target) && !event.target.closest('.mode-picker-button')) closeModePicker(); });
document.addEventListener('focusin', (event) => { if (state.modePickerAnchor && !$('mode-picker').contains(event.target) && !event.target.closest('.mode-picker-button')) closeModePicker(); });
window.addEventListener('resize', positionModelPicker);
document.addEventListener('scroll', positionModelPicker, true);
window.addEventListener('resize', () => positionPicker($('mode-picker'), state.modePickerAnchor, 264));
document.addEventListener('scroll', () => positionPicker($('mode-picker'), state.modePickerAnchor, 264), true);
$('project-selector').addEventListener('click', openProjectFolderPicker);
$('followup-project-selector').addEventListener('click', () => toast('会话已绑定当前项目。可从左侧新建对话后选择其他文件夹。'));
$('add-project-button').addEventListener('click', openProjectFolderPicker);
$('folder-close').addEventListener('click', () => $('folder-modal').classList.add('hidden'));
$('folder-up').addEventListener('click', () => state.folderParent && openFolder(state.folderParent));
$('folder-list').addEventListener('click', (event) => { const button = event.target.closest('[data-folder]'); if (button) openFolder(button.dataset.folder); });
$('folder-use').addEventListener('click', async () => { if (!state.folderPath || !canChangeProject(state.folderPath)) return; setProject({ path: state.folderPath, name: shortPath(state.folderPath) }); await loadTrust(state.folderPath); state.expandedProjects.add(state.folderPath); $('folder-modal').classList.add('hidden'); await loadProjects(); toggleSidebar(false); });
$('settings-button').addEventListener('click', () => openSettings());
$('manage-skills').addEventListener('click', () => openSettings('skills'));
$('setup-model-button').addEventListener('click', () => openSettings('provider'));
$('drawer-close').addEventListener('click', closeSettings);
$('drawer-backdrop').addEventListener('click', closeSettings);
$('project-list').addEventListener('click', (event) => {
  const sessionButton = event.target.closest('[data-session]');
  if (sessionButton) { openSession(sessionButton.dataset.session, sessionButton.closest('[data-project]').dataset.project); return; }
  const projectButton = event.target.closest('[data-project-toggle]');
  if (!projectButton) return;
  const path = projectButton.dataset.projectToggle;
  if (state.expandedProjects.has(path)) state.expandedProjects.delete(path); else state.expandedProjects.add(path);
  saveStored('pforge.expandedProjects', [...state.expandedProjects]);
  if (!state.sessionId) { setProject(state.projects.find((item) => samePath(item.path, path)) || { path, name: shortPath(path) }); loadTrust(path); }
  renderProjects();
});
$('new-chat-button').addEventListener('click', newConversation);
$('brand-button').addEventListener('click', newConversation);
$('stop-button').addEventListener('click', () => void stopExecution());
$('resume-task-button').addEventListener('click', () => void resumeExecution());
$('toggle-changes').addEventListener('click', () => toggleChanges(!state.changes.open));
$('changes-close').addEventListener('click', () => toggleChanges(false, true));
$('changes-backdrop').addEventListener('click', () => toggleChanges(false, true));
$('refresh-changes').addEventListener('click', () => void loadChanges(true));
$('changes-files').addEventListener('click', (event) => { const button = event.target.closest('[data-change-path]'); if (button) void loadChangeDiff(button.dataset.changePath); });
$('changes-panel').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !changesMedia?.matches || !state.changes.open) return;
  const focusable = [...$('changes-panel').querySelectorAll('button:not(:disabled), [tabindex="0"]')], first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
changesMedia?.addEventListener('change', syncChangesLayout);
$('rename-button').addEventListener('click', () => { $('session-name').value = $('run-title').textContent; $('name-modal').classList.remove('hidden'); $('session-name').focus(); $('session-name').select(); });
$('name-cancel').addEventListener('click', () => $('name-modal').classList.add('hidden'));
$('name-form').addEventListener('submit', async (event) => { event.preventDefault(); const name = $('session-name').value.trim(); if (!name || !state.sessionId) return; const button = $('name-save'); setBusy(button, true, '保存中…'); try { await api('/api/sessions/' + state.sessionId + '/name', { method: 'POST', body: JSON.stringify({ name }) }); $('run-title').textContent = name; $('name-modal').classList.add('hidden'); await loadProjects(); } catch (error) { toast(error.message, 'error'); } finally { setBusy(button, false); } });
$('compact-button').addEventListener('click', () => void compactContext());
$('cancel-compact-button').addEventListener('click', async () => { const button = $('cancel-compact-button'); button.disabled = true; try { await api('/api/sessions/' + state.sessionId + '/abort-compact', { method: 'POST' }); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; } });
['commands-button', 'followup-commands-button'].forEach((id) => $(id).addEventListener('click', () => {
  const input = $(id === 'commands-button' ? 'prompt' : 'followup-prompt');
  if (state.commandInput === input) { closeCommandPicker(); input.focus(); return; }
  if (input.value.trim() && !/^\/[^\s/]*$/.test(input.value)) { toast('输入框已有草稿。在新消息开头输入 / 即可使用命令。'); input.focus(); return; }
  input.value = input.value || '/'; input.focus(); input.setSelectionRange(input.value.length, input.value.length); rememberDraft(); updateCommandPicker(input);
}));
$('command-picker').addEventListener('pointerdown', (event) => event.preventDefault());
$('command-categories').addEventListener('click', (event) => {
  const button = event.target.closest('[data-command-category]');
  if (button) void selectCommandCategory(button.dataset.commandCategory);
});
$('command-options').addEventListener('click', (event) => {
  // Do not let the opening click immediately trigger a destination popover's
  // document-level outside-click handler (notably /model and /mode).
  event.stopPropagation();
  const option = event.target.closest('[data-command-index]'); if (!option || !state.commandInput) return;
  const input = state.commandInput, command = state.commandItems[Number(option.dataset.commandIndex)]; if (!command) return;
  if (commandDisabled(command)) { toast(commandDisabled(command), 'warning'); return; }
  if (command.source === 'local') void executeCommand(input, command);
  else { input.value = '/' + command.name + ' '; closeCommandPicker(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); rememberDraft(); }
});
['context-button', 'followup-context-button'].forEach((id) => $(id).addEventListener('click', () => openContext($(id))));
$('context-close').addEventListener('click', () => closeContext(true));
$('help-close').addEventListener('click', () => { $('help-modal').classList.add('hidden'); $(state.sessionId ? 'followup-prompt' : 'prompt').focus(); });
$('help-modal').addEventListener('keydown', (event) => { if (event.key === 'Tab') { event.preventDefault(); $('help-close').focus(); } });
document.addEventListener('pointerdown', (event) => {
  if (state.commandInput && !$('command-picker').contains(event.target) && event.target !== state.commandInput && !event.target.closest('.composer-command-button')) closeCommandPicker();
  if (state.contextAnchor && !$('context-panel').contains(event.target) && !event.target.closest('.context-button')) closeContext();
});
document.addEventListener('focusin', (event) => {
  if (state.commandInput && !$('command-picker').contains(event.target) && event.target !== state.commandInput && !event.target.closest('.composer-command-button')) closeCommandPicker();
  if (state.contextAnchor && !$('context-panel').contains(event.target) && !event.target.closest('.context-button')) closeContext();
});
const positionComposerPopovers = () => { positionCommandPicker(); if (state.contextAnchor) positionPicker($('context-panel'), state.contextAnchor, 350); };
window.addEventListener('resize', positionComposerPopovers);
document.addEventListener('scroll', (event) => { if (!$('command-picker').contains(event.target) && !$('context-panel').contains(event.target)) positionComposerPopovers(); }, true);
async function submitUi(cancelled) {
  const request = state.uiRequest; if (!request) return;
  const value = request.method === 'confirm' ? true : request.method === 'select' ? request.selectedValue : $('approval-input').value;
  if (!cancelled && request.method === 'select' && value === undefined) return;
  const button = $(cancelled ? 'deny-button' : 'allow-button'); setBusy(button, true);
  try { await respondUi(request.requestId, value, cancelled); if (state.uiRequest?.requestId === request.requestId) closeUiModal(); }
  catch (error) { toast(error.message, 'error'); if (error.status === 404 && state.uiRequest?.requestId === request.requestId) closeUiModal(); }
  finally { setBusy(button, false); }
}
$('allow-button').addEventListener('click', () => submitUi(false));
$('deny-button').addEventListener('click', () => submitUi(true));
$('approval-options').addEventListener('click', (event) => { const option = event.target.closest('[data-ui-option]'); if (!option || !state.uiRequest) return; state.uiRequest.selectedValue = option.dataset.uiOption; $('allow-button').disabled = false; [...$('approval-options').children].forEach((item) => item.classList.toggle('selected', item === option)); });
$('history-search-button').addEventListener('click', () => { $('history-search').classList.toggle('hidden'); $('history-query').focus(); });
$('history-search-close').addEventListener('click', () => { $('history-query').value = ''; state.historyQuery = ''; $('history-search').classList.add('hidden'); renderProjects(); });
$('history-query').addEventListener('input', (event) => { state.historyQuery = event.target.value; renderProjects(); });
$('mobile-menu').addEventListener('click', () => toggleSidebar(!$('sidebar').classList.contains('mobile-open')));
$('sidebar-backdrop').addEventListener('click', () => toggleSidebar(false));
document.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; if (state.commandInput) { event.preventDefault(); closeCommandPicker(); return; } if (state.contextAnchor) { event.preventDefault(); closeContext(true); return; } if (!$('help-modal').classList.contains('hidden')) { $('help-close').click(); return; } if (state.modePickerAnchor) { event.preventDefault(); closeModePicker(true); return; } if (state.pickerAnchor) { event.preventDefault(); closeModelPicker(true); return; } if (state.uiRequest) submitUi(true); else if (state.changes.open && ['name-modal', 'folder-modal', 'drawer'].every((id) => $(id).classList.contains('hidden'))) { event.preventDefault(); toggleChanges(false, true); } else { $('name-modal').classList.add('hidden'); $('folder-modal').classList.add('hidden'); closeSettings(); toggleSidebar(false); } });
setRunning(false);
loadConfig().then((connected) => { if (connected) return resumeActiveSession(); });
