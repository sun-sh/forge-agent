import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { safeMarkdown, textContent, sessionOutcome, verificationLabel } from './render.js';
import { readEventStream, StreamError } from './stream.js';
import { mountCustomProviders } from './providers.js';
import { mountMcp } from './mcp.js';
import { mountSkills } from './skills.js';
import { builtinCommands, filterCommands, parseCommand } from './commands.js';
import { lifecycleUI } from './lifecycle.js';

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
  activeMode: 'agent', activeWorkflow: 'direct', pendingMode: null, pendingWorkflow: null, sessionChoices: new Map(),
  sessionId: null, sessionPath: null, lastUserEntryId: null, assistant: null, tools: new Map(), projects: [], history: [],
  historyFilter: 'active', sessionHistory: { status: 'active', pinned: false }, historyBusy: false, sessionMenu: null, renameTarget: null, forkOrigin: null, forkableEntries: new Set(),
  expandedProjects: new Set(Array.isArray(stored('pforge.expandedProjects', [])) ? stored('pforge.expandedProjects', []) : []),
  folderPath: null, folderParent: null, eventSource: null, runStartedAt: null, runFinishedAt: null,
  elapsedTimer: null, uiRequest: null, uiQueue: [], readOnly: false, lastEventId: 0,
  thinking: null, executionProcess: null, turnAnswer: null, verification: null, outcome: 'idle', error: null, loadingSession: false, historyQuery: '', widgets: new Map(),
  authRequired: false, recoveringAuth: false, changingConfig: false, changingMode: false, openingSettings: false, sending: false, runControl: null, runControlRequest: null, modelThinkingLevels: {}, pickerAnchor: null, modePickerAnchor: null,
  workflow: 'direct', task: null, attachments: [], attachmentReading: false, attachmentGeneration: 0, managedRoot: '', sessionRoot: '', projectRequestId: null, tasks: [], taskScope: 'project', filePickerInput: null,
  context: null, budget: null, compacting: false, compactRequest: false, runtimeCommands: [], commandInput: null, commandIndex: 0, commandItems: [], commandCategory: 'all', commandDiscoveryError: '', contextAnchor: null,
  changes: { open: false, sessionId: null, reviewView: 'changes', files: [], selectedPath: null, fingerprint: null, diffStatus: 'idle', listRequest: 0, diffRequest: 0, projectFiles: [], selectedProjectFile: null, projectFilesRequest: 0, projectFileRequest: 0, terminalBusy: false },
  subagents: [], subagentSession: null, subagentSelected: null, subagentRequest: 0, subagentTimer: null
};
function verificationUnconfigured(verification) {
  return verificationLabel(verification) === '未配置自动验证';
}
function implementationWithoutChecks(task) {
  return task?.status === 'completed' && task.phase === 'complete' && !task.error && task.finalization !== 'failed' && !task.reviewFollowup
    && verificationUnconfigured(task.verification) && (!task.review || task.review.verdict === 'ready' && !task.review.issues?.length && !task.review.acceptance?.some((item) => item.status !== 'met'));
}
const changesMedia = window.matchMedia?.('(max-width: 1180px)');
let projectsRequest = 0, historyRefreshTimer;

const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const lifecycle = lifecycleUI({ api, esc, toast, currentSession: () => state.sessionId, running: () => state.running,
  readOnly: () => state.readOnly || state.mode !== 'agent' || historyReadOnly(), changed: () => loadChanges(true) });
let tasksTimer, tasksRequest = 0;
let timelineRequest = 0, timelineTimer, timelineIdentity = '';
const ICON_PATHS = {
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11H3V7Z"/>',
  folderPlus: '<path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11H3V7Z"/><path d="M12 10v6m-3-3h6"/>',
  paperclip: '<path d="m8 12 6-6a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7-7l8-8m-6 10 8-8a1.5 1.5 0 0 1 2 2l-8 8"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-8.5A8.5 8.5 0 0 1 11.5 4H13a8 8 0 0 1 8 7.5Z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  newChat: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  rename: '<path d="M12 20H4v-4L16 4a2.8 2.8 0 0 1 4 4L8 20m6-14 4 4"/>',
  pin: '<path d="m16 3 5 5-4 1-3 6-2 2-5-5 2-2 6-3 1-4ZM2 22l6-6"/>',
  archive: '<path d="M4 9h16v12H4V9ZM3 3h18v6H3V3Zm6 10h6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  restore: '<path d="M3 10a9 9 0 1 1 1 8M3 4v6h6M12 7v5l3 2"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m0-5h5a7 7 0 0 0 7-4"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  edit: '<path d="M12 20H4a2 2 0 0 1-2-2v-4M15 4l5 5M4 20l4.5-1L21 6.5a2.1 2.1 0 0 0-3-3L5 16.5 4 20Z"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 20h16"/>'
};
function icon(name) { return '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>'; }
document.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); });
const historyReadOnly = () => state.sessionHistory.status !== 'active';
function navigationLocked() { return state.loadingSession || state.changingMode || state.changingConfig || state.sending || state.historyBusy || state.attachmentReading; }
function historyLocked() { return state.running || state.compacting || state.compactRequest || state.loadingSession || state.changingMode || state.changingConfig || state.sending || Boolean(state.runControl) || state.historyBusy; }
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
  const root = $('toast-root');
  root.append(node);
  while (root.childElementCount > 2) root.firstElementChild.remove();
  setTimeout(() => node.remove(), 3600);
}
function shortPath(value) { return String(value || '').replace(/^.*[\\/]/, ''); }
function newRequestId() { return globalThis.crypto?.randomUUID?.() || ('request-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)); }
function samePath(left, right) {
  const normalize = (value) => String(value || '').replace(/[\\/]+$/, '').replaceAll('/', '\\').toLowerCase();
  return normalize(left) === normalize(right);
}
function formatNumber(value) { return typeof value === 'number' ? new Intl.NumberFormat('zh-CN').format(value) : '—'; }
function formatTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function modelByKey(key) { return state.models.find((model) => model.key === key); }
function renderAttachments() {
  const html = state.attachments.map((item, index) => '<span class="attachment-chip">' + (item.type === 'image' ? '<img class="attachment-preview" src="data:' + esc(item.mimeType) + ';base64,' + esc(item.data) + '" alt="图片预览">' : icon('file')) + '<span><strong>' + esc(item.path || item.name || '图片') + '</strong><small>' + (item.type === 'file' ? '项目文件引用' : (item.size < 1000 ? item.size + ' B' : Math.ceil(item.size / 1000) + ' KB') + (item.type === 'image' ? ' · 图片' : ' · 本机文件')) + '</small></span><button type="button" data-remove-attachment="' + index + '" aria-label="移除 ' + esc(item.path || item.name || '附件') + '" title="移除附件"' + (state.attachmentReading ? ' disabled' : '') + '>×</button></span>').join('');
  ['prompt-attachments', 'followup-attachments'].forEach((id) => { if ($(id)) $(id).innerHTML = html; });
  document.querySelectorAll('[data-upload-picker]').forEach((button) => { button.setAttribute('aria-busy', String(state.attachmentReading)); button.title = state.attachmentReading ? '正在读取附件…' : '添加图片或文件'; });
  renderComposerControl();
}
function removeAttachment(index) { state.attachments.splice(index, 1); renderAttachments(); rememberDraft(); }
function addFileAttachment(path) {
  if (state.attachments.length >= 6) { toast('最多只能附加 6 个文件或图片', 'warning'); return; }
  if (!state.attachments.some((item) => item.type === 'file' && item.path === path)) state.attachments.push({ type: 'file', path });
  renderAttachments(); rememberDraft(); closeFilePicker();
}
function closeFilePicker() { $('file-picker').classList.add('hidden'); state.filePickerInput = null; }
async function renderFileOptions(query = '') {
  if (!state.project) { $('file-options').innerHTML = '<p class="settings-note">请先选择项目。</p>'; return; }
  $('file-options').innerHTML = '<p class="settings-note">正在搜索…</p>';
  try {
    const result = await api('/api/files?project=' + encodeURIComponent(state.project.path) + '&q=' + encodeURIComponent(query));
    $('file-options').innerHTML = (result.files || []).map((file) => '<button type="button" class="file-option" data-file-path="' + esc(file.path) + '" role="option"><span>' + esc(file.path) + '</span><small>' + formatNumber(file.size) + ' B</small></button>').join('') || '<p class="settings-note">没有匹配的安全文本文件。</p>';
  } catch (error) { $('file-options').innerHTML = '<p class="settings-note">无法读取项目文件：' + esc(error.message) + '</p>'; }
}
function openFilePicker(inputName) {
  if (!state.project) { toast('请先选择项目文件夹', 'warning'); return; }
  closeModelPicker(); closeModePicker(); closeCommandPicker(); state.filePickerInput = inputName;
  $('file-search').value = ''; $('file-picker').classList.remove('hidden'); void renderFileOptions(); $('file-search').focus();
}
function readAttachment(file, method) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取 ' + file.name)); reader[method](file); });
}
async function addLocalAttachments(files) {
  if (historyLocked() || state.attachmentReading || historyReadOnly()) return;
  const generation = state.attachmentGeneration;
  state.attachmentReading = true; setRunning(state.running); renderAttachments();
  try {
    for (const file of Array.from(files || [])) {
      if (generation !== state.attachmentGeneration) return;
      try {
        if (state.attachments.length >= 6) throw new Error('最多只能附加 6 个文件或图片');
        if (file.size > 2_000_000) throw new Error(file.name + ' 超过 2 MB，请缩小文件后重试');
        if (!file.name || /[\\/\u0000-\u001f]/.test(file.name) || /^(?:\.env(?:\..*)?|auth\.json|credentials?\.json|secrets?\.json|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(file.name) || /\.(?:pem|key|p12|pfx)$/i.test(file.name)) throw new Error('请勿上传凭据文件：' + file.name);
        const image = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type);
        let attachment;
        if (image) {
          const images = state.attachments.filter((item) => item.type === 'image');
          if (images.length >= 4 || images.reduce((sum, item) => sum + (item.size || 0), 0) + file.size > 6_000_000) throw new Error('图片附件最多 4 张，总大小不能超过 6 MB');
          const data = String(await readAttachment(file, 'readAsDataURL')).split(',')[1];
          attachment = { type: 'image', name: file.name, mimeType: file.type, data, size: file.size };
        } else {
          if (file.type?.startsWith('image/') || /\.(?:pdf|docx?|xlsx?|pptx?|zip|exe|dll|bin)$/i.test(file.name)) throw new Error('暂不支持 ' + file.name + '，请上传 UTF-8 文本、代码或 PNG/JPEG/WEBP/GIF 图片');
          const buffer = await readAttachment(file, 'readAsArrayBuffer');
          let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error(file.name + ' 不是 UTF-8 文本文件'); }
          if (text.includes('\0')) throw new Error(file.name + ' 是二进制文件，暂不支持');
          if (state.attachments.filter((item) => item.type === 'upload').reduce((sum, item) => sum + item.size, 0) + file.size > 4_000_000) throw new Error('文本附件总大小不能超过 4 MB');
          attachment = { type: 'upload', name: file.name, text, size: file.size };
        }
        if (state.attachments.reduce((sum, item) => sum + (item.size || 0), 0) + file.size > 8_000_000) throw new Error('附件总大小不能超过 8 MB');
        if (generation === state.attachmentGeneration && !state.attachments.some((item) => item.type === attachment.type && item.name === attachment.name && item.size === attachment.size && (image ? item.data === attachment.data : item.text === attachment.text))) state.attachments.push(attachment);
      } catch (error) { toast(error.message, 'warning'); }
    }
  } finally { state.attachmentReading = false; renderAttachments(); setRunning(state.running); }
}
const TASK_STATUS_LABELS = { running: '运行中', interrupted: '服务重启后中断', aborted: '已停止', failed: '失败', needs_attention: '需要检查', budget_exceeded: '达到执行预算', completed: '已完成' };
function renderTasks() {
  const list = $('tasks-list'); if (!list) return;
  const tasks = state.tasks || [];
  $('tasks-note').textContent = tasks.length ? '共 ' + tasks.length + ' 个' + (state.taskScope === 'project' ? '当前项目' : '跨项目') + '任务，状态独立于当前浏览器标签页保存。' : (state.taskScope === 'project' ? '当前项目还没有持久化任务。' : '还没有持久化任务。') + '执行过修改或验证后会显示在这里。';
  list.innerHTML = tasks.map((task) => {
    const running = task.status === 'running';
    const validationUnconfigured = implementationWithoutChecks(task);
    const retryable = ['interrupted', 'aborted', 'failed', 'needs_attention', 'budget_exceeded'].includes(task.status) && !validationUnconfigured;
    const action = task.status === 'failed' || task.status === 'needs_attention' || task.status === 'budget_exceeded' ? 'recheck' : 'resume';
    const statusLabel = validationUnconfigured ? '已完成 · 未配置自动验证' : TASK_STATUS_LABELS[task.status] || task.status;
    return '<article class="task-card"><button type="button" class="task-card-main" data-open-task="' + esc(task.id) + '"><strong>' + esc(task.prompt || '未命名任务').slice(0, 180) + '</strong><small>' + esc(shortPath(task.project)) + ' · ' + esc(statusLabel) + ' · ' + esc(formatTime(task.updatedAt)) + '</small><span>' + esc(validationUnconfigured ? '文件已写入项目，可打开会话查看交付。' : task.error || (task.phase ? '当前阶段：' + (TASK_LABELS[task.phase] || task.phase) : '')) + '</span></button><div class="task-card-actions">' + (running ? '<button type="button" class="button quiet small" data-task-action="stop" data-task-id="' + esc(task.id) + '">停止</button>' : retryable ? '<button type="button" class="button quiet small" data-task-action="' + action + '" data-task-id="' + esc(task.id) + '">' + (action === 'recheck' ? '重新检查' : '继续') + '</button>' : '') + '</div></article>';
  }).join('') || '<p class="settings-note">暂无任务。</p>';
}
async function loadTasks() {
  const request = ++tasksRequest, project = state.project?.path, scope = state.taskScope;
  try {
    const query = state.taskScope === 'project' && state.project?.path ? '?project=' + encodeURIComponent(state.project.path) : '';
    const [result, queue] = await Promise.all([api('/api/tasks' + query), api('/api/jobs' + query)]);
    if (request !== tasksRequest || project !== state.project?.path || scope !== state.taskScope) return;
    state.tasks = result.tasks || []; renderTasks(); if (result.diagnostic) $('tasks-note').textContent = result.diagnostic;
    $('queue-summary').textContent = queue.scheduler ? '运行 ' + queue.scheduler.running + '/' + queue.scheduler.concurrency + ' · 排队 ' + queue.scheduler.queued + ' · 不同项目并行，同一项目按顺序执行。' : '不同项目并行，同一项目按顺序执行。';
    $('queue-task-submit').disabled = queueSubmitting || !state.sessionId || state.readOnly || state.mode !== 'agent';
    $('queue-target').textContent = state.sessionId ? '当前会话 · ' + (state.project?.name || '项目') + ' · ' + (state.pendingModelKey || state.model?.key || '未选择模型') : '先打开一个 Agent 会话';
    const labels = { queued: '排队中', running: '后台执行中', completed: '已完成', failed: '失败', interrupted: '进程退出后中断', cancelled: '已取消' };
    $('queue-list').innerHTML = (queue.jobs || []).slice().reverse().map((job) => '<article class="task-card"><div class="task-card-main"><strong>' + esc(job.title || '排队任务') + '</strong><small>' + esc(shortPath(job.project)) + ' · ' + esc(labels[job.status]) + ' · ' + esc(job.model) + '</small><span>' + esc(job.error || job.waiting || formatTime(job.createdAt)) + '</span></div><div class="task-card-actions">' + (['queued', 'interrupted', 'running'].includes(job.status) ? '<button type="button" class="button quiet small" data-cancel-job="' + esc(job.id) + '">' + (job.status === 'running' ? '停止' : '取消') + '</button>' : '') + '<button type="button" class="button quiet small" data-open-job="' + esc(job.id) + '">打开会话</button></div></article>').join('') || '<p class="settings-note">可在上方添加任务，或使用 /queue 任务内容。同一会话正在执行时也可以排队。</p>';
    state.jobs = queue.jobs || [];
    if (queue.diagnostic) $('queue-list').textContent = queue.diagnostic;
    $('queue-list').querySelectorAll('[data-open-job]').forEach((button) => {
      const job = state.jobs.find((item) => item.id === button.dataset.openJob);
      if (!['failed', 'interrupted', 'cancelled'].includes(job?.status)) return;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button quiet small'; retry.dataset.retryJob = job.id; retry.textContent = '重新排队'; button.before(retry);
    });
  } catch (error) { if (request === tasksRequest && error.status !== 401) $('tasks-note').textContent = '任务中心暂不可用：' + error.message; }
}
function openTasks() { closeFilePicker(); closeModelPicker(); closeModePicker(); closeCommandPicker(); $('tasks-panel').classList.remove('hidden'); void loadTasks(); clearInterval(tasksTimer); tasksTimer = setInterval(() => void loadTasks(), 3000); $('tasks-close').focus(); }
function closeTasks() { $('tasks-panel').classList.add('hidden'); clearInterval(tasksTimer); ++tasksRequest; }
let queueSubmitting = false;
async function enqueueComposedTask(event) {
  event.preventDefault();
  if (queueSubmitting) return;
  const input = $('queue-task-input'), draft = input.value, message = draft.trim();
  if (!message) { input.focus(); return; }
  const session = state.sessionId;
  if (!session || state.readOnly || state.mode !== 'agent') { toast('先打开一个可写的 Agent 会话', 'error'); return; }
  const payload = { session, message, workflow: state.workflow, model: state.pendingModelKey || state.model?.key, thinkingLevel: state.pendingThinkingLevel ?? state.thinkingLevel };
  if (!payload.model) { toast('先选择一个已配置的模型', 'error'); return; }
  queueSubmitting = true; $('queue-task-submit').disabled = true;
  try {
    await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
    if (session === state.sessionId && input.value === draft) input.value = '';
    toast('已加入队列，使用提交时选择的模型和执行方式');
  } catch (error) { toast(error.message, 'error'); }
  finally { queueSubmitting = false; await loadTasks(); }
}
async function activateTaskSession(id) {
  if (navigationLocked()) return;
  state.loadingSession = true; setRunning(state.running);
  try { const data = await api('/api/sessions/' + id); adoptSessionView(data); restoreDraft(); connect(data.id); showChat(); renderProjects(); closeTasks(); }
  finally { state.loadingSession = false; setRunning(state.running); }
}
async function taskAction(id, action) {
  try {
    const result = await api('/api/tasks/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: '{}' });
    if (result.sessionId) await activateTaskSession(result.sessionId);
    await loadTasks(); toast(action === 'stop' ? '任务已停止' : action === 'recheck' ? '任务已重新检查' : '任务已继续');
  } catch (error) { toast(error.message, 'error'); await loadTasks(); }
}
const composerHeightKey = 'forge.composerHeight.v1';
const savedComposerHeight = stored(composerHeightKey, null);
let composerHeight = Number.isFinite(savedComposerHeight) && savedComposerHeight >= 64 && savedComposerHeight <= 600 ? savedComposerHeight : null;
function resizeComposerInputs() {
  ['prompt', 'followup-prompt'].forEach((id) => {
    const input = $(id), handle = input.form.querySelector('.composer-resize');
    input.style.height = composerHeight === null ? '' : composerHeight + 'px';
    if (!input.clientWidth) return;
    const style = getComputedStyle(input);
    handle.setAttribute('aria-valuemin', Math.round(parseFloat(style.minHeight)));
    handle.setAttribute('aria-valuemax', Math.round(parseFloat(style.maxHeight)));
    handle.setAttribute('aria-valuenow', Math.round(input.getBoundingClientRect().height));
  });
}
function setComposerHeight(input, height) {
  const style = getComputedStyle(input);
  composerHeight = Math.round(Math.max(parseFloat(style.minHeight), Math.min(parseFloat(style.maxHeight), height)));
  resizeComposerInputs();
}
document.querySelectorAll('.composer-resize').forEach((handle) => {
  const input = $(handle.getAttribute('aria-controls'));
  let drag = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.focus({ preventScroll: true });
    drag = { pointer: event.pointerId, y: event.clientY, height: input.getBoundingClientRect().height, previous: composerHeight };
    handle.setPointerCapture(event.pointerId); handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (event) => { if (drag?.pointer === event.pointerId) setComposerHeight(input, drag.height + drag.y - event.clientY); });
  handle.addEventListener('pointerup', (event) => {
    if (drag?.pointer !== event.pointerId) return;
    saveStored(composerHeightKey, composerHeight); drag = null; handle.classList.remove('dragging'); handle.releasePointerCapture(event.pointerId);
  });
  handle.addEventListener('lostpointercapture', () => { if (drag) { composerHeight = drag.previous; drag = null; handle.classList.remove('dragging'); resizeComposerInputs(); } });
  handle.addEventListener('dblclick', () => { composerHeight = null; saveStored(composerHeightKey, null); resizeComposerInputs(); });
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const style = getComputedStyle(input), current = input.getBoundingClientRect().height;
    const height = event.key === 'Home' ? parseFloat(style.minHeight) : event.key === 'End' ? parseFloat(style.maxHeight) : current + (event.key === 'ArrowUp' ? 28 : -28);
    setComposerHeight(input, height); saveStored(composerHeightKey, composerHeight);
  });
});
function showStart() { closeSubagent(); renderSubagents([]); toggleChanges(false); syncChangesSession(); $('toggle-changes').classList.add('hidden'); $('start-state').classList.remove('hidden'); $('conversation-view').classList.add('hidden'); resizeComposerInputs(); }
function showChat() { $('toggle-changes').classList.remove('hidden'); $('start-state').classList.add('hidden'); $('conversation-view').classList.remove('hidden'); resizeComposerInputs(); }
function continuationKind() {
  if (!state.sessionId || state.running || state.readOnly || historyReadOnly()) return null;
  if (state.task) {
    return ['interrupted', 'aborted', 'failed', 'needs_attention', 'budget_exceeded'].includes(state.task.status) && state.mode === 'agent' ? 'task' : null;
  }
  return state.outcome === 'aborted' ? 'conversation' : null;
}
function renderComposerControl() {
  const stopping = state.runControl === 'stopping', resuming = state.runControl === 'resuming';
  const continuation = continuationKind(), draft = Boolean($('followup-prompt').value.trim() || state.attachments.length || state.attachmentReading);
  const compactLocked = state.compacting || state.compactRequest;
  const showStop = state.running || stopping, showResume = !showStop && (resuming || Boolean(continuation && !draft));
  const canEditRetry = !showStop && !state.readOnly && !historyReadOnly() && Boolean(state.lastUserEntryId && state.forkableEntries.has(state.lastUserEntryId)) && (state.outcome === 'failed' || state.outcome === 'aborted' || ['interrupted', 'aborted', 'failed', 'needs_attention', 'budget_exceeded'].includes(state.task?.status));
  $('stop-button').classList.toggle('hidden', !showStop); $('stop-button').disabled = !state.running || state.sending || state.loadingSession || Boolean(state.runControl);
  $('stop-button').setAttribute('aria-busy', String(stopping));
  $('stop-button').setAttribute('aria-label', stopping ? '正在停止当前执行' : '停止当前执行');
  $('resume-task-button').classList.toggle('hidden', !showResume);
  $('resume-task-button').disabled = !continuation || compactLocked || state.loadingSession || state.changingMode || state.changingConfig || state.sending || Boolean(state.runControl);
  $('resume-task-button').setAttribute('aria-busy', String(resuming));
  $('resume-task-button').title = continuation === 'task' ? '重新检查当前进度后继续任务' : '沿用当前上下文继续未完成的请求';
  $('resume-task-label').textContent = resuming ? '继续中…' : '继续';
  $('edit-retry-button').classList.toggle('hidden', !canEditRetry);
  $('edit-retry-button').disabled = historyLocked() || !canEditRetry;
  $('edit-retry-button').setAttribute('aria-busy', String(state.loadingSession && canEditRetry));
  $('followup-send').classList.toggle('hidden', showStop || showResume);
  const status = $('composer-control-status');
  status.textContent = stopping ? '正在停止…' : '';
  status.classList.toggle('hidden', !stopping);
  const interrupted = !showStop && !resuming && state.task && continuationKind() === 'task';
  $('composer-run-note').classList.toggle('hidden', !interrupted);
  if (interrupted) {
    const task = state.task;
    $('composer-run-reason').textContent = task.status === 'budget_exceeded' ? '本段达到执行预算，可继续未完成部分' : task.status === 'aborted' ? '执行已停止，可继续未完成部分' : task.status === 'interrupted' ? '服务退出导致任务中断' : '任务在' + (TASK_LABELS[task.phase] || '执行') + '阶段暂停';
    $('composer-run-detail').textContent = task.error || state.error || '检查当前结果后点击继续，或发送补充信息。';
  }
  resizeComposerInputs();
}
function setRunning(value) {
  state.running = value;
  const locked = value || state.compacting || state.compactRequest || state.loadingSession || Boolean(state.changingMode) || state.changingConfig || state.sending || Boolean(state.runControl) || state.historyBusy;
  const navigationLock = navigationLocked();
  const executionLocked = state.compacting || state.compactRequest || state.loadingSession || Boolean(state.changingMode) || state.changingConfig || state.sending || Boolean(state.runControl);
  $('run-button').disabled = locked || state.attachmentReading;
  $('followup-send').disabled = locked || state.attachmentReading || state.readOnly || historyReadOnly();
  $('new-chat-button').disabled = navigationLock;
  $('conversation-menu-button').disabled = locked;
  $('history-filter').disabled = navigationLock;
  $('restore-conversation').disabled = locked;
  document.querySelectorAll('[data-fork-entry]').forEach((button) => { button.disabled = locked; });
  if (locked) closeSessionMenu();
  $('compact-button').disabled = locked || state.readOnly || !state.sessionId;
  // Model and reasoning changes made during a run are staged for the next prompt.
  $('model-picker-button').disabled = executionLocked;
  $('followup-model-picker-button').disabled = executionLocked;
  $('model-picker').setAttribute('aria-busy', String(state.changingConfig));
  $('chat-model-options').querySelectorAll('input').forEach((input) => { input.disabled = executionLocked; });
  $('thinking-select').disabled = executionLocked || !state.model?.available || (state.model.thinkingLevels || []).length < 2;
  $('manage-chat-models').disabled = locked;
  $('configure-thinking').disabled = locked;
  $('mode-select').disabled = executionLocked;
  $('followup-mode-select').disabled = executionLocked;
  $('mode-picker-button').disabled = executionLocked;
  $('followup-mode-picker-button').disabled = executionLocked;
  if (executionLocked) closeModePicker();
  ['workflow-select', 'followup-workflow-select'].forEach((id) => { if ($(id)) $(id).disabled = executionLocked || state.mode !== 'agent'; });
  ['settings-button', 'project-selector', 'followup-project-selector'].forEach((id) => { if ($(id)) $(id).disabled = locked; });
  ['new-chat-button', 'brand-button', 'history-search-button', 'history-search-close', 'add-project-button'].forEach((id) => { if ($(id)) $(id).disabled = navigationLock; });
  document.querySelectorAll('[data-file-picker], [data-upload-picker]').forEach((button) => { button.disabled = locked || state.attachmentReading || historyReadOnly() || (button.hasAttribute('data-file-picker') && !state.project); });
  $('history-query').disabled = navigationLock;
  $('project-list').inert = navigationLock;
  document.querySelectorAll('[data-project-new]').forEach((button) => { button.disabled = navigationLock; });
  document.querySelectorAll('[data-project-menu]').forEach((button) => { button.disabled = locked; });
  $('drawer-body').inert = locked;
  $('folder-modal').inert = locked;
  if (!value && state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
  if (value && !state.elapsedTimer) state.elapsedTimer = setInterval(updateElapsed, 1000);
  $('followup-prompt').readOnly = historyReadOnly();
  $('followup-prompt').placeholder = historyReadOnly() ? '恢复此会话后继续对话' : state.readOnly ? '选择可用模型后继续此会话；历史记录可正常查看' : '继续告诉 Forge...';
  renderComposerControl();
  renderContext();
  if (state.commandInput) renderCommandPicker();
}
function setProject(project) {
  const changed = !samePath(state.project?.path, project?.path);
  state.project = project ? { ...state.projects.find((item) => samePath(item.path, project.path)), ...project, name: project.name || shortPath(project.path) } : null;
  $('current-project-name').textContent = state.project ? state.project.name : '新对话';
  $('current-project-path').textContent = state.project ? state.project.path : '未选择项目 · 发送时自动创建';
  $('project-selector-label').textContent = state.project ? state.project.name : '自动创建项目';
  $('followup-project-label').textContent = state.project ? state.project.name : '当前项目';
  state.trust = project && project.trust ? project.trust : null;
  renderTrust();
  saveStored('forge.selectedProject.v1', state.project?.path || null);
  $('project-selector').title = state.project?.path || '发送时在 Forge 项目目录自动创建，也可选择已有文件夹';
  document.querySelectorAll('[data-file-picker]').forEach((button) => { button.disabled = !state.project || historyLocked(); });
  if (!state.sessionId && changed) { state.attachmentGeneration++; state.projectRequestId = null; state.attachments = state.attachments.filter((item) => item.type !== 'file'); renderAttachments(); }
  if (state.project) {
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
  if (data.mode) state.activeMode = data.mode;
  if (data.workflow === 'direct' || data.workflow === 'planned') state.activeWorkflow = data.workflow;
  if (data.mode || data.workflow) {
    state.workflow = state.pendingWorkflow ?? state.activeWorkflow;
    setMode(state.pendingMode ?? state.activeMode);
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
  try { const result = await api('/api/projects/trust?path=' + encodeURIComponent(path)); if (samePath(state.project?.path, path)) { state.trust = result.trust; renderTrust(); } } catch (error) { toast(error.message, 'error'); }
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
  $('project-list').innerHTML = Array.from(grouped.values()).filter((project) => {
    const projectText = (project.name + ' ' + project.path).toLowerCase();
    const visibleSessions = project.sessions.filter((session) => (session.status || 'active') === state.historyFilter);
    const matchesQuery = !query || projectText.includes(query) || visibleSessions.some((session) => session.title.toLowerCase().includes(query));
    // Active projects remain available as places to start a new conversation
    // even when they currently have no active history. Archived and trashed
    // views contain only sessions that exist in that lifecycle bucket.
    return matchesQuery && (state.historyFilter === 'active' || visibleSessions.length > 0);
  }).map((project) => {
    const open = Boolean(query) || state.historyFilter !== 'active' || state.expandedProjects.has(project.path);
    const current = state.project && state.project.path === project.path;
    const visible = (project.sessions || []).filter((session) => (session.status || 'active') === state.historyFilter && (!query || (project.name + ' ' + project.path + ' ' + session.title).toLowerCase().includes(query))).sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const sessions = visible.map((session) => {
      const active = state.sessionPath && samePath(state.sessionPath, session.path);
      return '<div class="session-row ' + (active ? 'active' : '') + '"><button type="button" class="session-item ' + (active ? 'active' : '') + '" data-session="' + esc(session.path) + '" ' + (active ? 'aria-current="page" ' : '') + 'title="' + esc(session.title) + '"><span class="session-icon">' + icon(session.fork ? 'branch' : 'chat') + '</span><span class="session-summary"><span class="session-title">' + (session.pinned ? '<span class="session-pin" title="已置顶">' + icon('pin') + '</span>' : '') + esc(session.title || '未命名对话') + '</span><small>' + esc(session.running ? '运行中' : new Date(session.updatedAt).toLocaleDateString() + ' ' + formatTime(session.updatedAt)) + '</small></span></button><button type="button" class="session-more icon-button small" data-session-menu="' + esc(session.path) + '" aria-label="会话操作：' + esc(session.title) + '" title="会话操作" aria-haspopup="menu" aria-controls="session-menu" aria-expanded="false">' + icon('more') + '</button></div>';
    }).join('');
    const projectMenu = '<button type="button" class="project-menu-button icon-button small" data-project-menu="' + esc(project.path) + '" title="项目操作" aria-label="项目操作：' + esc(project.name || shortPath(project.path)) + '" aria-haspopup="menu" aria-controls="session-menu" aria-expanded="false">' + icon('more') + '</button>';
    return '<div class="project-group ' + (open ? 'open ' : '') + (current ? 'current' : '') + '" data-project="' + esc(project.path) + '"><div class="project-row"><button type="button" class="project-toggle" aria-expanded="' + open + '" data-project-toggle="' + esc(project.path) + '" title="' + esc(project.path) + '"><span class="project-chevron">' + icon('chevron') + '</span><span class="project-icon">' + icon('folder') + '</span><span class="project-name">' + esc(project.name || shortPath(project.path)) + '</span><span class="project-count">' + visible.length + '</span></button><button type="button" class="project-new-chat icon-button small" data-project-new="' + esc(project.path) + '" title="在此项目新建会话" aria-label="在 ' + esc(project.name || shortPath(project.path)) + ' 中新建会话">' + icon('newChat') + '</button>' + projectMenu + '</div><div class="session-list">' + (sessions || '<div class="empty-sessions">' + (query ? '没有匹配的会话' : '还没有对话') + '</div>') + '</div></div>';
  }).join('') || '<div class="sidebar-empty">' + (state.historyFilter === 'archived' ? '没有已归档会话' : state.historyFilter === 'trashed' ? '回收站为空' : query ? '没有匹配的项目或会话' : '选择一个文件夹开始') + '</div>';
}
function findHistory(path) { return state.history.flatMap((project) => project.sessions.map((session) => ({ ...session, project: project.path }))).find((session) => samePath(session.path, path)); }
function currentHistory() { return { ...state.sessionHistory, path: state.sessionPath, title: $('run-title').textContent, project: state.project?.path, id: state.sessionId, saved: Boolean(state.sessionPath) }; }
function closeSessionMenu(restoreFocus = false) {
  const menu = state.sessionMenu; state.sessionMenu = null;
  $('session-menu').classList.add('hidden'); menu?.anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus) menu?.anchor.focus();
}
function positionSessionMenu() {
  if (!state.sessionMenu) return;
  const menu = $('session-menu'), rect = state.sessionMenu.anchor.getBoundingClientRect();
  const width = Math.min(208, window.innerWidth - 24);
  menu.style.width = width + 'px';
  menu.style.left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) + 'px';
  menu.style.top = Math.max(12, Math.min(rect.bottom + 5, window.innerHeight - menu.offsetHeight - 12)) + 'px';
}
function openSessionMenu(target, anchor) {
  if (!target || historyLocked()) return;
  if (state.sessionMenu?.anchor === anchor) { closeSessionMenu(true); return; }
  closeSessionMenu(); closeCommandPicker(); closeModelPicker(); closeModePicker(); closeContext();
  state.sessionMenu = { target, anchor }; anchor.setAttribute('aria-expanded', 'true');
  $('session-menu').setAttribute('aria-label', '会话操作');
  const items = [['rename', 'rename', '重命名']];
  if (target.saved !== false) {
    if (target.status !== 'trashed') items.push([target.pinned ? 'unpin' : 'pin', 'pin', target.pinned ? '取消置顶' : '置顶'], [target.status === 'archived' ? 'restore' : 'archive', target.status === 'archived' ? 'restore' : 'archive', target.status === 'archived' ? '恢复会话' : '归档']);
    if (target.status === 'trashed') items.push(['restore', 'restore', '恢复会话']);
    else items.push(['trash', 'trash', '移到回收站']);
  }
  if (target.path) items.push(['export-markdown', 'download', '导出 Markdown'], ['export-json', 'download', '导出 JSON']);
  $('session-menu').innerHTML = items.map(([action, symbol, label]) => '<button type="button" role="menuitem" data-history-action="' + action + '" class="' + (action === 'trash' ? 'danger' : '') + '">' + icon(symbol) + '<span>' + label + '</span></button>').join('');
  $('session-menu').classList.remove('hidden'); positionSessionMenu(); $('session-menu').querySelector('button').focus();
}
function openProjectMenu(path, anchor) {
  if (historyLocked()) return;
  if (state.sessionMenu?.anchor === anchor) { closeSessionMenu(true); return; }
  closeSessionMenu(); closeCommandPicker(); closeModelPicker(); closeModePicker(); closeContext();
  state.sessionMenu = { target: { kind: 'project', path, name: state.projects.find((project) => samePath(project.path, path))?.name || shortPath(path) }, anchor };
  anchor.setAttribute('aria-expanded', 'true');
  const menu = $('session-menu'); menu.setAttribute('aria-label', '项目操作');
  menu.innerHTML = '<button type="button" role="menuitem" class="danger" data-project-action="remove">' + icon('trash') + '<span>移除项目</span></button><div class="project-menu-note">保留本机文件与会话，重新打开文件夹即可恢复。</div>';
  menu.classList.remove('hidden'); positionSessionMenu(); menu.querySelector('button').focus();
}
async function removeProject(target) {
  if (historyLocked() || !target?.path) return;
  state.historyBusy = true; closeSessionMenu(); setRunning(state.running);
  try {
    await api('/api/projects', { method: 'DELETE', body: JSON.stringify({ path: target.path }) });
    ++projectsRequest; // Discard list requests started before removal.
    if (samePath(state.project?.path, target.path)) { resetSessionView(); setProject(null); restoreDraft(); showStart(); }
    state.projects = state.projects.filter((project) => !samePath(project.path, target.path));
    state.history = state.history.filter((project) => !samePath(project.path, target.path));
    for (const path of state.expandedProjects) if (samePath(path, target.path)) state.expandedProjects.delete(path);
    saveStored('pforge.expandedProjects', [...state.expandedProjects]);
    const recent = stored('pforge.recentProjects', []);
    saveStored('pforge.recentProjects', (Array.isArray(recent) ? recent : []).filter((project) => !samePath(project.path, target.path)));
    if (samePath(stored('forge.selectedProject.v1', null), target.path)) saveStored('forge.selectedProject.v1', null);
    if (samePath(stored('pforge.activeSession', null, sessionStorage)?.project, target.path)) saveStored('pforge.activeSession', null, sessionStorage);
    renderProjects(); await loadProjects(); $('new-chat-button').focus();
    toast('已移除 ' + target.name + '，文件与历史会话已保留');
  } catch (error) { toast(error.message, 'error'); }
  finally { state.historyBusy = false; setRunning(state.running); }
}
async function exportSession(target, format) {
  if (historyLocked() || !target?.path) return;
  closeSessionMenu();
  try {
    const response = await fetch('/api/history/export?path=' + encodeURIComponent(target.path) + '&format=' + encodeURIComponent(format), { credentials: 'same-origin', headers: { 'x-pforge-token': token } });
    if (!response.ok) {
      if (response.status === 401) showAuthRequired();
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '导出失败（HTTP ' + response.status + '）');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const fallback = format === 'json' ? 'forge-session.json' : 'forge-session.md';
    const filename = encoded ? decodeURIComponent(encoded.replace(/^"|"$/g, '')) : fallback;
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(format === 'json' ? 'JSON 会话已导出' : 'Markdown 会话已导出');
  } catch (error) { toast(error.message, 'error'); }
}
function openRename(target = currentHistory()) {
  closeSessionMenu();
  if (!target.path && !target.id) return;
  state.renameTarget = target; $('session-name').value = target.title || '';
  $('name-error').textContent = ''; $('name-modal').classList.remove('hidden'); $('session-name').focus(); $('session-name').select();
}
function renderHistoryNotice() {
  const status = state.sessionHistory.status;
  $('history-notice').classList.toggle('hidden', status === 'active');
  $('history-notice-text').textContent = status === 'trashed' ? '此会话在回收站中，历史内容仍保留。' : '此会话已归档。恢复后可以继续对话。';
  $('fork-origin').classList.toggle('hidden', !state.forkOrigin);
  $('fork-origin-label').textContent = state.forkOrigin ? '分支来自 ' + state.forkOrigin.sourceTitle : '';
}
async function mutateHistory(action, target) {
  if (historyLocked()) return;
  state.historyBusy = true; closeSessionMenu(); setRunning(state.running);
  try {
    const result = await api('/api/history', { method: 'POST', body: JSON.stringify({ path: target.path, action }) });
    if (samePath(target.path, state.sessionPath)) { state.sessionHistory = result.history; renderHistoryNotice(); }
    await loadProjects();
    toast(({ pin: '会话已置顶', unpin: '已取消置顶', archive: '会话已归档', unarchive: '会话已移回', trash: '已移到回收站，可随时恢复', restore: '会话已恢复' })[action]);
  } catch (error) { toast(error.message, 'error'); }
  finally { state.historyBusy = false; setRunning(state.running); }
}
function addMessageActions(row, message, entryId) {
  const actions = document.createElement('div'); actions.className = 'message-actions';
  const raw = textContent(message.content);
  if (raw) {
    const copy = document.createElement('button'); copy.type = 'button'; copy.title = '复制消息'; copy.setAttribute('aria-label', '复制消息'); copy.innerHTML = icon('copy');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(raw); toast('消息已复制'); } catch { toast('复制失败，请手动选择消息', 'error'); } };
    actions.append(copy);
  }
  if (entryId && state.forkableEntries.has(entryId)) {
    const fork = document.createElement('button'); fork.type = 'button'; fork.dataset.forkEntry = entryId;
    const edit = message.role === 'user' && (typeof message.content === 'string' || message.content.every((part) => part.type === 'text'));
    fork.title = edit ? '编辑此消息并新建分支' : '从此消息新建分支'; fork.setAttribute('aria-label', fork.title); fork.innerHTML = icon('branch'); fork.disabled = historyLocked();
    actions.append(fork);
  }
  if (actions.childElementCount) row.querySelector('.turn-body').append(actions);
}
async function forkConversation(entryId) {
  if (historyLocked() || !state.sessionId || !state.forkableEntries.has(entryId)) return;
  rememberDraft(); state.loadingSession = true; setRunning(state.running);
  try {
    const result = await api('/api/sessions/' + state.sessionId + '/fork', { method: 'POST', body: JSON.stringify({ entryId }) });
    state.historyFilter = 'active'; $('history-filter').value = 'active';
    await createSession(result.path, '会话分支', true);
    $('followup-prompt').value = result.origin?.kind === 'edit' ? result.draft : '';
    rememberDraft();
    await loadProjects(); toggleSidebar(false); $('followup-prompt').focus(); renderComposerControl();
    toast(result.origin?.kind === 'edit' ? '分支已建立，修改消息后发送' : '分支已建立，可以从这里继续');
  } catch (error) { toast(error.message, 'error'); }
  finally { state.loadingSession = false; setRunning(state.running); }
}
async function loadProjects() {
  const request = ++projectsRequest;
  const result = await Promise.all([api('/api/projects'), api('/api/history')]);
  if (request !== projectsRequest) return;
  const recent = stored('pforge.recentProjects', []);
  state.projects = [...(result[0].projects || [])];
  state.managedRoot = result[0].managedRoot || ''; state.sessionRoot = result[0].sessionRoot || '';
  const removed = result[0].removedPaths || [], isRemoved = (path) => path && removed.some((item) => samePath(item, path));
  const visibleRecent = (Array.isArray(recent) ? recent : []).filter((project) => !isRemoved(project.path));
  if (visibleRecent.length !== (Array.isArray(recent) ? recent.length : 0)) saveStored('pforge.recentProjects', visibleRecent);
  for (const project of visibleRecent) if (typeof project.path === 'string' && !state.projects.some((item) => samePath(item.path, project.path))) state.projects.push(project);
  state.history = result[1].projects || [];
  clearTimeout(historyRefreshTimer);
  if (state.history.some((group) => group.sessions.some((session) => session.running))) historyRefreshTimer = setTimeout(() => { if (!state.authRequired) void loadProjects().catch(() => {}); }, 5000);
  for (const group of state.history) if (!state.projects.some((project) => samePath(project.path, group.path))) state.projects.push({ path: group.path, name: group.name });
  if (isRemoved(state.project?.path) && !state.running) { resetSessionView(); setProject(null); restoreDraft(); showStart(); }
  if (isRemoved(stored('forge.selectedProject.v1', null))) saveStored('forge.selectedProject.v1', null);
  if (isRemoved(stored('pforge.activeSession', null, sessionStorage)?.project)) saveStored('pforge.activeSession', null, sessionStorage);
  const saved = stored('forge.selectedProject.v1', null);
  const savedProject = saved && state.projects.find((project) => project.path === saved);
  if (!state.project) { setProject(savedProject?.available === false ? null : savedProject || (saved && state.history.some((group) => samePath(group.path, saved)) ? { path: saved, name: shortPath(saved) } : null)); if (state.project) state.expandedProjects.add(state.project.path); }
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
function toolSummary(input) { if (!input || typeof input !== 'object') return ''; if (Array.isArray(input.tasks)) return input.tasks.map((task) => task.title).join(' · '); return input.command || input.path || input.url || input.pattern || input.query || Object.keys(input).slice(0, 2).join(', '); }
function addTool(event, pending = true) {
  const id = event.toolCallId || event.toolName;
  if (state.tools.has(id)) return state.tools.get(id);
  const row = document.createElement('details'); row.className = 'tool-row';
  row.innerHTML = '<summary><span class="tool-name">' + esc(event.toolName === 'subagent' ? '委派子任务' : event.toolName || 'tool') + '</span><span class="tool-summary">' + esc(toolSummary(event.args)) + '</span><span class="tool-state">' + (pending ? '运行中' : '已记录') + '</span></summary><pre class="tool-args"></pre><pre class="tool-output"></pre>';
  row.querySelector('.tool-args').textContent = JSON.stringify(event.args ?? {}, null, 2);
  appendProcessNode(row); state.tools.set(id, row); scrollTimeline(); return row;
}
function endTool(event) {
  const row = state.tools.get(event.toolCallId || event.toolName) || addTool(event, false);
  const status = row.querySelector('.tool-state'); status.textContent = event.isError ? '失败' : '完成'; status.className = 'tool-state ' + (event.isError ? 'failed' : 'done');
  const output = textContent(event.result?.content) || '(无文本输出)';
  let summary = output;
  if (event.toolName === 'subagent') try { const data = JSON.parse(output); if (Array.isArray(data.agents)) summary = data.agents.map((agent) => agent.title + ' · ' + (SUBAGENT_STATUS[agent.status] || agent.status) + '\n' + (agent.result || agent.error || '')).join('\n\n'); } catch {}
  row.querySelector('.tool-output').textContent = summary;
  if (event.isError) row.open = true;
}
function durationLabel(milliseconds) { const seconds = Math.max(0, Math.floor(milliseconds / 1000)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
function renderBudget(budget = state.budget) {
  const node = $('task-budget');
  if (!node) return;
  const visible = Boolean(budget && state.task && !['answer', 'explore'].includes(state.task.kind));
  node.classList.toggle('hidden', !visible);
  if (!visible) { node.textContent = ''; return; }
  const limits = { maxDurationMs: 5_400_000, maxModelTurns: 240, maxToolCalls: 500, maxTotalTokens: 0, maxOutputTokens: 300_000, maxCostUsd: 40, ...(budget.limits || {}) }, ended = budget.endedAt ? Date.parse(budget.endedAt) : NaN;
  const started = Date.parse(budget.startedAt), elapsed = Number.isFinite(started) ? (Number.isFinite(ended) ? ended : Date.now()) - started : 0;
  const status = { running: '本段用量', completed: '本段用量', aborted: '本段已停止', exceeded: '达到本段上限' }[budget.status] || '用量';
  $('task-summary-usage').textContent = '回合 ' + formatNumber(budget.modelTurns) + ' · 工具 ' + formatNumber(budget.toolCalls);
  node.dataset.status = budget.status || 'running';
  node.innerHTML = '<span>' + esc(status) + '</span>'
    + '<span>回合 ' + formatNumber(budget.modelTurns) + '/' + formatNumber(limits.maxModelTurns) + '</span>'
    + '<span>工具 ' + formatNumber(budget.toolCalls) + '/' + formatNumber(limits.maxToolCalls) + '</span>'
    + '<span title="累计用量包含重复上下文和缓存读取，不代表当前上下文窗口占用">累计请求 ' + formatNumber(budget.totalTokens) + (limits.maxTotalTokens > 0 ? '/' + formatNumber(limits.maxTotalTokens) : ' · 仅统计') + '</span>'
    + '<span title="生成 token 是硬限制；输入和缓存读取只在累计上限开启时参与累计护栏">生成 ' + formatNumber(budget.usage?.output || 0) + '/' + formatNumber(limits.maxOutputTokens) + '</span>'
    + (budget.usage ? '<span>输入 ' + formatNumber(budget.usage.input) + ' · 输出 ' + formatNumber(budget.usage.output) + ' · 缓存读取 ' + formatNumber(budget.usage.cacheRead) + ' · 缓存写入 ' + formatNumber(budget.usage.cacheWrite) + '</span>' : '')
    + '<span>' + (budget.costIncomplete !== false ? Number(budget.costUsd) > 0 ? '已知 $' + Number(budget.costUsd).toFixed(2) + ' · 部分费用未知' : '费用未知' : '$' + Number(budget.costUsd || 0).toFixed(2)) + '/上限 $' + Number(limits.maxCostUsd || 0).toFixed(2) + '</span>'
    + '<span>耗时 ' + durationLabel(elapsed) + '/' + durationLabel(limits.maxDurationMs || 0) + '</span>';
}
function updateElapsed() { updateSubagentTiming(); if (!state.runStartedAt) { $('run-elapsed').textContent = ''; renderBudget(); return; } const end = state.running ? Date.now() : state.runFinishedAt || state.runStartedAt; const seconds = Math.max(0, Math.floor((end - state.runStartedAt) / 1000)); $('run-elapsed').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); renderBudget(); }
const SUBAGENT_STATUS = { starting: '启动中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' };
function subagentRunning(agent) { return ['starting', 'running'].includes(agent.status); }
function subagentTime(agent) { const seconds = Math.max(0, Math.floor(((agent.endedAt ? Date.parse(agent.endedAt) : Date.now()) - Date.parse(agent.startedAt)) / 1000)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
function updateSubagentTiming() {
  document.querySelectorAll('[data-subagent-time]').forEach((node) => { const agent = state.subagents.find((item) => item.id === node.dataset.subagentTime); if (agent) node.textContent = subagentTime(agent); });
}
function positionSubagents() { if (!$('subagent-menu').classList.contains('hidden')) positionPicker($('subagent-menu'), $('subagents-button'), 360); }
function closeSubagentMenu(focus = false) { $('subagent-menu').classList.add('hidden'); $('subagents-button').setAttribute('aria-expanded', 'false'); if (focus) $('subagents-button').focus(); }
function renderSubagents(agents) {
  state.subagents = Array.isArray(agents) ? agents : [];
  const running = state.subagents.filter(subagentRunning).length, button = $('subagents-button');
  button.classList.toggle('hidden', !state.subagents.length); button.classList.toggle('running', running > 0);
  button.setAttribute('aria-label', '子任务 ' + state.subagents.length + (running ? '，' + running + ' 个运行中' : ''));
  $('subagents-count').textContent = running ? running + ' / ' + state.subagents.length : String(state.subagents.length);
  button.title = '子任务 ' + state.subagents.length + ' · ' + running + ' 个运行中';
  const list = $('subagent-list'), focusId = document.activeElement?.dataset.subagentOpen;
  list.innerHTML = state.subagents.map((agent) => '<button type="button" class="subagent-row" data-subagent-open="' + esc(agent.id) + '"><span class="subagent-dot ' + esc(agent.status) + '" aria-hidden="true"></span><span class="subagent-row-label"><strong>' + esc(agent.title) + '</strong><small>' + (agent.role === 'worker' ? '实现' : agent.role === 'reviewer' ? '审阅' : '探索') + ' · ' + esc(SUBAGENT_STATUS[agent.status] || agent.status) + '</small></span><span class="subagent-row-usage"><span>' + tokenLabel(agent.budget?.totalTokens || 0) + ' tokens</span><span data-subagent-time="' + esc(agent.id) + '">' + subagentTime(agent) + '</span></span><span aria-hidden="true">↗</span></button>').join('');
  if (focusId) [...list.querySelectorAll('[data-subagent-open]')].find((node) => node.dataset.subagentOpen === focusId)?.focus();
  if (!state.subagents.length) { closeSubagentMenu(); closeSubagent(); }
  if (state.subagentSelected) {
    const selected = state.subagents.find((agent) => agent.id === state.subagentSelected);
    if (!selected) closeSubagent();
    else { renderSubagentStatus(selected); if (!subagentRunning(selected)) { clearInterval(state.subagentTimer); state.subagentTimer = null; void loadSubagent(); } }
  }
  positionSubagents();
}
function renderSubagentStatus(agent) {
  $('subagent-heading').textContent = agent.title;
  $('subagent-status').textContent = (SUBAGENT_STATUS[agent.status] || agent.status) + (agent.status === 'completed' ? agent.collectedAt ? ' · 主任务已取回结果' : ' · 等待主任务取回结果' : '');
  $('subagent-meta').textContent = (agent.role === 'worker' ? '实现 · 独立 worktree' : (agent.role === 'reviewer' ? '审阅' : '探索') + ' · 只读') + ' · ' + agent.model + ' · ' + tokenLabel(agent.budget?.totalTokens || 0) + ' tokens';
  $('subagent-activity').textContent = subagentRunning(agent) ? agent.activity || '正在处理子任务…' : agent.error || '结果已返回主 Agent';
  $('subagent-stop').classList.toggle('hidden', !subagentRunning(agent));
}
function syncSubagentLayout() {
  const open = Boolean(state.subagentSelected), overlay = open && Boolean(changesMedia?.matches), panel = $('subagent-panel');
  panel.classList.toggle('hidden', !open); $('workspace-body').classList.toggle('subagent-open', open);
  $('subagent-backdrop').classList.toggle('hidden', !overlay);
  if (overlay) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
  else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
  ['chat-pane', 'workspace-header', 'sidebar'].forEach((id) => { $(id).inert = overlay || Boolean(state.changes.open && changesMedia?.matches); });
}
function closeSubagent(focus = false) {
  state.subagentSelected = null; state.subagentRequest++; clearInterval(state.subagentTimer); state.subagentTimer = null;
  syncSubagentLayout(); if (focus) $('subagents-button').focus();
}
async function openSubagent(id) {
  if (!state.subagents.some((agent) => agent.id === id)) return;
  toggleChanges(false); closeSubagentMenu(); closeModelPicker(); closeModePicker();
  state.subagentSelected = id; syncSubagentLayout(); $('subagent-detail').textContent = '正在读取子会话…'; $('subagent-close').focus();
  renderSubagentStatus(state.subagents.find((agent) => agent.id === id));
  clearInterval(state.subagentTimer);
  state.subagentTimer = setInterval(() => { if (!document.hidden) void loadSubagent(); }, 2000);
  await loadSubagent();
}
async function loadSubagent() {
  const sessionId = state.sessionId, id = state.subagentSelected, request = ++state.subagentRequest;
  if (!sessionId || !id) return;
  try {
    const data = await api('/api/sessions/' + sessionId + '/subagents?agent=' + encodeURIComponent(id));
    if (request !== state.subagentRequest || state.sessionId !== sessionId || state.subagentSelected !== id) return;
    renderSubagentStatus(data.agent);
    const container = $('subagent-detail'), scroll = container.scrollTop, nearEnd = container.scrollHeight - scroll - container.clientHeight < 100;
    const expanded = new Set([...container.querySelectorAll('details[open]')].map((node) => node.dataset.key));
    container.replaceChildren();
    const task = document.createElement('details'); task.className = 'subagent-task'; task.dataset.key = 'task';
    const summary = document.createElement('summary'); summary.textContent = '任务说明'; task.append(summary);
    const prompt = document.createElement('div'); prompt.textContent = data.prompt || ''; task.append(prompt); container.append(task);
    for (const [index, message] of (data.messages || []).entries()) {
      if (message.role === 'user') continue;
      for (const [partIndex, part] of (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || []).entries()) {
        if (part.type === 'text' && message.role === 'assistant') { const row = document.createElement('div'); row.className = 'subagent-response markdown'; renderMarkdown(row, part.text); container.append(row); }
        else {
          const fold = document.createElement('details'); fold.className = 'subagent-process'; fold.dataset.key = index + '-' + partIndex;
          const label = document.createElement('summary'); label.textContent = part.type === 'thinking' ? '思考过程' : part.type === 'toolCall' ? part.name : (message.toolName || '工具') + (message.isError ? ' · 失败' : ' · 输出');
          const text = document.createElement('pre'); text.textContent = part.type === 'toolCall' ? part.arguments : part.text || '';
          fold.append(label, text); container.append(fold);
        }
      }
    }
    if (data.partialText) { const partial = document.createElement('div'); partial.className = 'subagent-response markdown'; renderMarkdown(partial, data.partialText); container.append(partial); }
    if (data.historyError) { const note = document.createElement('p'); note.textContent = data.historyError; container.append(note); }
    lifecycle.proposal(container, data.proposal, sessionId, id, loadSubagent, data.agent?.status === 'completed', Boolean(data.agent?.worktreeRemoved));
    container.querySelectorAll('details').forEach((node) => { node.open = expanded.has(node.dataset.key); });
    container.scrollTop = nearEnd ? container.scrollHeight : scroll;
    if (!subagentRunning(data.agent)) { clearInterval(state.subagentTimer); state.subagentTimer = null; }
  } catch (error) { if (request === state.subagentRequest) $('subagent-detail').textContent = '读取失败：' + error.message; }
}
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
  if (['model', 'mode', 'new'].includes(command.name)) return '';
  if (command.name === 'queue') return !state.sessionId ? '开始对话后可用' : state.mode !== 'agent' || state.readOnly ? '需要可用的 Agent 会话' : '';
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
      case 'queue':
        if (!args.trim()) { openTasks(); break; }
        if (state.attachments.length) { toast('排队暂支持文本任务，请先发送或移除附件', 'warning'); return false; }
        await api('/api/jobs', { method: 'POST', body: JSON.stringify({ session: state.sessionId, message: args, workflow: state.workflow, model: state.pendingModelKey || state.model?.key, thinkingLevel: state.pendingThinkingLevel || state.thinkingLevel }) });
        toast('已加入后台队列'); openTasks(); break;
      case 'rename': openRename(); break;
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
    return review.summary + (review.issues.length ? '\n\n待处理问题：\n' + review.issues.filter((issue) => typeof issue === 'string').map((issue) => '• ' + issue).join('\n') : '\n\n未提出待处理问题。')
      + (Array.isArray(review.notes) && review.notes.length ? '\n\n审阅备注（非阻断）：\n' + review.notes.filter((note) => typeof note === 'string').map((note) => '• ' + note).join('\n') : '');
  } catch { return '审阅结果需要人工检查。可在任务记录中查看阶段状态。'; }
}
function renderMessage(message, partial = false, phase, task = state.task, entryId) {
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = textContent(message.content);
  if (message.role === 'user') {
    startUserTurn();
    const row = createTurn('user', '你', text);
    if (!partial) addMessageActions(row, message, entryId);
    for (const part of parts) if (part.type === 'image' && /^(image\/(png|jpeg|webp|gif))$/.test(part.mimeType) && typeof part.data === 'string' && part.data.length <= 8_000_000) { const img = document.createElement('img'); img.src = 'data:' + part.mimeType + ';base64,' + part.data; img.alt = '会话附件'; img.className = 'message-image'; row.querySelector('.turn-body').append(img); }
  }
  if (message.role === 'assistant') {
    for (const part of parts) if (part.type === 'thinking' && part.thinking) { const row = createProcessTurn('thinking', '思考', part.thinking); if (partial) state.thinking = row; }
    const process = parts.some((part) => part.type === 'toolCall') || message.stopReason === 'toolUse' || foldsIntoExecutionProcess(phase, task);
    if (text) { const row = process ? createProcessTurn('assistant', phase === 'review' ? '模型审阅' : 'Forge · ' + (TASK_LABELS[phase] || '执行'), phase === 'review' && !partial ? reviewText(text) : text) : createAnswer(text); if (partial) state.assistant = row; else if (!process) addMessageActions(row, message, entryId); }
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
    if (entry.type === 'message') renderMessage(entry.message, false, phase, task || null, entry.id);
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
  const protectionIssue = verification?.protection?.status && verification.protection.status !== 'unchanged';
  panel.classList.toggle('hidden', !verification?.report && !verification?.error && !verificationUnconfigured(verification) && !verification?.evidence?.reason && !protectionIssue);
  if (!verification) return;
  panel.classList.toggle('failed', verification.status === 'failed' || verification.evidence?.freshness === 'stale');
  $('verification-summary').textContent = verificationLabel(verification) + (verification.attempts ? ' · 修复重试 ' + verification.attempts + ' 次' : '') + (verification.checkedAt ? ' · ' + formatTime(verification.checkedAt) : '') + ' · 命令与输出';
  const failures = { timeout: '超时', aborted: '已停止', spawn_error: '启动失败' };
  $('verification-output').textContent = [verification.reason, verification.evidence?.reason].filter(Boolean).join('\n\n') + (verification.reason || verification.evidence?.reason ? '\n\n' : '') + ((verification.report?.results || []).map((result) => (result.passed ? 'PASS ' : 'FAIL ') + result.command + ' · ' + (failures[result.failure] || 'exit ' + result.exitCode) + ' · ' + result.durationMs + 'ms\n' + (result.error ? result.error + '\n' : '') + (result.output || '(无输出)')).join('\n\n') || verification.error || '');
}
const TASK_LABELS = { inspect: '调研', plan: '规划', implement: '实现', verify: '验证', review: '审阅', complete: '完成' };
function setWorkflow(value) {
  state.workflow = value === 'planned' ? 'planned' : 'direct';
  ['workflow-select', 'followup-workflow-select'].forEach((id) => { if ($(id)) $(id).value = state.workflow; });
  syncModeControls?.();
}
async function changeWorkflow(value, applying = false) {
  const workflow = value === 'planned' ? 'planned' : 'direct';
  if (state.compacting || state.compactRequest || state.loadingSession || state.changingMode || state.changingConfig || (state.sending && !applying) || (workflow === 'planned' && state.mode !== 'agent')) { syncModeControls(); return false; }
  if (state.running || hasPendingMode() && !applying) { stageModeSelection({ mode: state.mode, workflow }); return true; }
  const previous = state.workflow;
  setWorkflow(workflow);
  if (!state.sessionId) { state.activeWorkflow = workflow; return true; }
  state.changingConfig = true; setRunning(state.running);
  try {
    const data = await api('/api/sessions/' + state.sessionId + '/workflow', { method: 'POST', body: JSON.stringify({ workflow }) });
    state.activeWorkflow = data.workflow || workflow;
    if (!applying) { state.pendingWorkflow = null; setWorkflow(state.activeWorkflow); }
    return true;
  } catch (error) { setWorkflow(previous); toast(error.message, 'error'); return false; }
  finally { state.changingConfig = false; setRunning(state.running); }
}
function renderDelivery(task) {
  const card = $('delivery-card');
  if (!card) return;
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
  const unconfigured = implementationWithoutChecks(task);
  const implementation = task && !['answer', 'explore', 'verify'].includes(task.kind || '')
    && (task.kind === 'change' || artifacts.length || task.changes?.files?.some((file) => file.observed));
  const visible = Boolean(implementation && (artifacts.length || unconfigured || task.status === 'completed' && task.phase === 'complete'));
  card.classList.toggle('hidden', !visible);
  if (!visible) return;
  $('delivery-title').textContent = task.status === 'running' ? '正在生成文件' : task.status === 'completed' && !task.error && sessionOutcome({ task }).kind === 'done' ? (unconfigured ? '交付已生成' : '修改已生成') : '本次文件 · 任务尚未完成';
  $('delivery-artifacts').innerHTML = artifacts.length ? artifacts.map((artifact) => '<button type="button" class="delivery-artifact" data-open-artifact="' + esc(artifact.path) + '" title="打开 ' + esc(artifact.path) + '">' + icon('file') + '<span><strong>' + esc(artifact.path) + '</strong><small>' + (artifact.operation === 'write' ? '写入文件' : '修改文件') + '</small></span><span class="delivery-artifact-open">打开</span></button>').join('') : '<p class="delivery-empty">本次没有捕获到文件路径。可打开右侧“文件”面板浏览项目。</p>';
  $('delivery-validation').textContent = unconfigured ? '自动验证：未配置。下方文件来自本次工具操作，可打开查看；配置 verify 后可以重新检查。' : task.status === 'running' ? '正在等待执行完成。' : verificationLabel(task.verification) + '。检查范围由配置的命令决定，具体命令与输出见执行记录。';
  $('delivery-open-files').disabled = !state.project;
  $('delivery-recheck').classList.toggle('hidden', !unconfigured || !task.id);
  $('delivery-recheck').disabled = !unconfigured || !task.id || state.running || state.loadingSession || state.sending || Boolean(state.runControl);
}
function openArtifactFile(path) {
  if (!state.project) { toast('当前会话没有绑定项目', 'warning'); return; }
  state.changes.selectedProjectFile = path;
  state.changes.reviewView = 'files';
  toggleChanges(true);
  void loadProjectFiles(path);
}
function renderTask(task) {
  const identity = state.sessionId + ':' + (task?.id || ''), changedTask = timelineIdentity !== identity;
  timelineIdentity = identity;
  state.task = task || null;
  if (changedTask || !task) { ++timelineRequest; clearTimeout(timelineTimer); timelineTimer = null; $('execution-timeline').textContent = ''; $('task-phase-history').classList.remove('hidden'); $('task-panel').open = false; $('task-summary-usage').textContent = ''; }
  if (task?.budget) state.budget = task.budget;
  const showTaskPanel = Boolean(task && (!['answer', 'explore'].includes(task.kind) || task.progress?.status === 'warned' || task.progress?.status === 'stalled'));
  $('task-panel').classList.toggle('hidden', !showTaskPanel);
  if (!task) { $('task-plan').textContent = ''; $('task-review').textContent = '本会话尚无执行记录。'; $('task-phase-history').textContent = ''; $('task-summary-phase').textContent = '任务进度'; $('task-summary-note').textContent = ''; renderDelivery(null); renderBudget(null); renderComposerControl(); return; }
  const phases = task.workflow === 'direct' ? (task.kind === 'verify' ? ['verify', 'complete'] : ['implement', 'complete']) : task.kind === 'verify' ? ['verify', 'complete'] : Object.keys(TASK_LABELS), current = phases.indexOf(task.phase);
  const visited = new Set((task.phases || []).map((item) => item.phase));
  $('task-steps').innerHTML = phases.map((phase, i) => '<li class="' + (i === current ? 'current' : i < current ? task.status === 'completed' && phase === 'review' && !visited.has('review') ? 'skipped' : 'finished' : '') + '"' + (i === current ? ' aria-current="step"' : '') + '><span>' + (i < current ? task.status === 'completed' && phase === 'review' && !visited.has('review') ? '—' : '✓' : i + 1) + '</span>' + TASK_LABELS[phase] + '</li>').join('');
  const compactStatus = task.status === 'running' ? (task.workflow === 'direct' ? '自适应执行中' : '正在' + TASK_LABELS[task.phase]) : implementationWithoutChecks(task) ? '已完成 · 未配置自动验证' : TASK_STATUS_LABELS[task.status] || '需要检查';
  $('task-summary-phase').textContent = TASK_LABELS[task.phase] || '任务进度';
  $('task-summary-note').textContent = compactStatus + (task.repairs ? ' · 修复 ' + task.repairs + ' 次' : '');
  $('task-note').textContent = task.status === 'running' ? (task.progress?.status === 'warned' ? task.progress.reason : compactStatus) + (task.repairs ? ' · 修复 ' + task.repairs + ' 次' : '') : task.error || sessionOutcome({ task }).label;
  $('task-review').textContent = task.review ? (task.reviewer?.context === 'independent' ? '独立审阅' : '模型审阅') + (task.review.freshness === 'stale' ? '（已过期）' : task.review.freshness !== 'current' ? '（当前版本未确认）' : '') + '：' + task.review.summary + (task.review.issues?.length ? '\n待处理问题：\n' + task.review.issues.map((issue) => '• ' + issue).join('\n') : '')
    + (task.review.notes?.length ? '\n审阅备注（非阻断）：\n' + task.review.notes.map((note) => '• ' + note).join('\n') : '') : task.workflow === 'direct' || task.kind === 'verify' ? '本次未进行模型审阅。' : implementationWithoutChecks(task) ? '未配置自动验证，本次未启用独立审阅。' : '审阅尚未完成。';
  $('task-phase-history').textContent = (task.phases || []).map((item) => TASK_LABELS[item.phase] + ' · ' + formatTime(item.startedAt) + (item.endedAt ? ' → ' + formatTime(item.endedAt) : '')).join('\n');
  const criteria = task.plan?.acceptance || [];
  $('task-plan').innerHTML = criteria.length ? '<details class="acceptance-plan"><summary>目标与验收 · ' + criteria.length + ' 项</summary><p>' + esc(task.plan.summary) + '</p><ol>' + criteria.map((item) => {
    const finding = task.review?.acceptance?.find((entry) => entry.id === item.id), label = task.review?.freshness !== 'current' && finding ? '当前未确认' : ({ met: '已确认', unmet: '未满足', unconfirmed: '未确认' }[finding?.status] || (implementationWithoutChecks(task) ? '未自动审阅' : '待审阅'));
    return '<li><strong>' + esc(item.id) + ' · ' + esc(label) + '</strong><p>' + esc(item.criterion) + '</p><small>' + esc(finding?.evidence || item.evidence) + '</small></li>';
  }).join('') + '</ol></details>' : '';
  renderDelivery(task);
  scheduleTimeline();
  renderBudget(task.budget || state.budget);
  setRunning(state.running);
}
function scheduleTimeline() {
  if (!timelineTimer && state.changes.open && state.changes.reviewView === 'execution' && $('task-evidence').open) timelineTimer = setTimeout(() => { timelineTimer = null; void loadExecutionTimeline(); }, 350);
}
async function loadExecutionTimeline() {
  const session = state.sessionId, taskId = state.task?.id, request = ++timelineRequest;
  if (!session || !taskId) return;
  const container = $('execution-timeline');
  try {
    const { timeline } = await api('/api/sessions/' + session + '/timeline?task=' + encodeURIComponent(taskId));
    if (request !== timelineRequest || session !== state.sessionId || taskId !== state.task?.id) return;
    if (!timeline?.nodes) { container.textContent = '暂时没有可展示的事件。'; return; }
    const labels = { completed: '已结束', running: '进行中', failed: '失败', interrupted: '已中断', aborted: '已停止', needs_attention: '待处理', budget_exceeded: '超出预算', unconfirmed: '未确认' };
    const meta = (node) => (labels[node.status] || '未确认') + (node.durationMs !== undefined ? ' · ' + (node.timing === 'message_interval' ? '约 ' : '') + (node.durationMs / 1000).toFixed(1) + 's' : '') + (node.tokens !== undefined ? ' · ' + node.tokens.toLocaleString() + ' tokens' : '');
    const parents = new Map(timeline.nodes.map((node) => [node.id, node.parentId]));
    const belongs = (node, phaseId) => { let id = node.parentId; for (let depth = 0; id && depth < 4; depth++) { if (id === phaseId) return true; id = parents.get(id); } return false; };
    const opened = new Set([...container.querySelectorAll('details[open]')].map((node) => node.dataset.phase));
    const nodeLabel = (node) => node.kind === 'model' ? node.label === 'independent reviewer' ? '独立交付审阅' : '模型响应' : node.kind === 'check' ? '验证 · ' + node.label : node.label;
    container.innerHTML = '<p class="settings-note">只读历史。工具时长按消息间隔估算，包含等待；没有结果的调用保持中断或进行中。</p>' + timeline.nodes.filter((node) => node.kind === 'phase').map((phase) => '<details class="execution-phase" data-phase="' + esc(phase.id) + '"' + (opened.has(phase.id) ? ' open' : '') + '><summary><span>' + esc(TASK_LABELS[phase.label] || phase.label) + (phase.attempt > 1 ? ' · 第 ' + phase.attempt + ' 次' : '') + '</span><small>' + esc(meta(phase)) + '</small></summary><ol>' + timeline.nodes.filter((node) => belongs(node, phase.id)).map((node) => '<li class="execution-node ' + esc(node.kind) + '"><span>' + esc(nodeLabel(node)) + '</span><small>' + esc(meta(node)) + '</small></li>').join('') + '</ol></details>').join('') + (timeline.truncated ? '<p class="settings-note">记录超过展示上限，请在会话导出中查看原始事件。</p>' : '');
    $('task-phase-history').classList.add('hidden');
  } catch (error) { if (request === timelineRequest && session === state.sessionId && taskId === state.task?.id) container.textContent = '执行记录暂不可用：' + error.message; }
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
  $('checkpoint-panel').open = false; $('checkpoint-panel').innerHTML = '<summary>执行检查点</summary>'; delete $('checkpoint-panel').dataset.selectedId;
  changes.projectFiles = []; changes.selectedProjectFile = null; ++changes.projectFilesRequest; ++changes.projectFileRequest;
  ++changes.listRequest; ++changes.diffRequest;
  $('changes-count').textContent = ''; $('changes-files').textContent = '';
  $('changes-files').scrollTop = 0;
  $('changes-note').textContent = '正在读取 Git 状态…';
  $('changes-file-name').textContent = '文件差异'; $('changes-file-name').removeAttribute('title');
  $('changes-preview').setAttribute('aria-busy', 'false'); $('refresh-changes').disabled = false;
  $('review-file-list').textContent = ''; $('review-file-content').textContent = '选择文件查看内容。';
  $('review-terminal-output').textContent = '等待执行。'; $('review-terminal-command').value = '';
  renderReviewView();
  renderChangeDiff('选择文件查看差异。');
}
function syncChangesLayout() {
  const open = state.changes.open, overlay = open && Boolean(changesMedia?.matches), panel = $('changes-panel');
  panel.classList.toggle('hidden', !open); $('workspace-body').classList.toggle('changes-open', open);
  $('toggle-changes').setAttribute('aria-expanded', String(open));
  $('changes-backdrop').classList.toggle('hidden', !overlay);
  if (overlay) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
  else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
  ['chat-pane', 'workspace-header', 'sidebar'].forEach((id) => { $(id).inert = overlay || Boolean(state.subagentSelected && changesMedia?.matches); });
  if (overlay && !panel.contains(document.activeElement) && !state.authRequired && !state.uiRequest) $('changes-close').focus();
}
function toggleChanges(open, restoreFocus = false) {
  open = Boolean(open && state.sessionId);
  if (open) closeSubagent();
  if (open) { closeModelPicker(); closeModePicker(); toggleSidebar(false); syncChangesSession(); }
  state.changes.open = open; syncChangesLayout();
  if (open) { renderReviewView(); if (state.changes.reviewView === 'files') void loadProjectFiles(); else if (state.changes.reviewView === 'changes') void loadChanges(); else if (state.changes.reviewView === 'execution') void loadExecutionTimeline(); }
  else if (restoreFocus) $('toggle-changes').focus();
}
function renderReviewView() {
  const view = ['changes', 'files', 'terminal', 'execution'].includes(state.changes.reviewView) ? state.changes.reviewView : 'changes';
  state.changes.reviewView = view;
  document.querySelectorAll('.changes-tabs [data-review-view]').forEach((button) => {
    const selected = button.dataset.reviewView === view;
    button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('[data-review-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.reviewPanel !== view));
}
function setReviewView(view) {
  if (!['changes', 'files', 'terminal', 'execution'].includes(view)) return;
  state.changes.reviewView = view; renderReviewView();
  if (!state.changes.open) return;
  if (view === 'changes') void loadChanges();
  else if (view === 'files') void loadProjectFiles();
  else if (view === 'execution') void loadExecutionTimeline();
  else $('review-terminal-command').focus();
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
    if ($('checkpoint-panel')?.open && !state.running) void lifecycle.loadCheckpoints($('checkpoint-panel'));
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
function renderProjectFiles() {
  const changes = state.changes, node = $('review-file-list');
  const focusedPath = node.contains(document.activeElement) ? document.activeElement.dataset.projectFilePath : null;
  const html = changes.projectFiles.map((file) => {
    const selected = file.path === changes.selectedProjectFile;
    return '<button type="button" class="review-file-option' + (selected ? ' selected' : '') + '" data-project-file-path="' + esc(file.path) + '" role="option" aria-selected="' + selected + '" title="' + esc(file.path) + '"><span>' + esc(file.path) + '</span><small>' + formatNumber(file.size) + ' B</small></button>';
  }).join('') || '<p class="changes-empty">没有匹配的安全文本文件。</p>';
  if (node.innerHTML === html) return;
  node.innerHTML = html;
  if (focusedPath) ([...node.querySelectorAll('[data-project-file-path]')].find((button) => button.dataset.projectFilePath === focusedPath) || node.querySelector('.selected'))?.focus({ preventScroll: true });
}
async function loadProjectFile(path) {
  const changes = state.changes, project = state.project?.path;
  if (!project || !changes.projectFiles.some((file) => file.path === path)) return;
  const request = ++changes.projectFileRequest;
  changes.selectedProjectFile = path; renderProjectFiles(); $('review-file-content').textContent = '正在读取 ' + path + '…';
  const current = () => request === changes.projectFileRequest && project === state.project?.path;
  try {
    const data = await api('/api/files/content?project=' + encodeURIComponent(project) + '&path=' + encodeURIComponent(path));
    if (current()) $('review-file-content').textContent = data.text || '(空文件)';
  } catch (error) { if (current()) $('review-file-content').textContent = '无法读取文件：' + error.message; }
}
async function loadProjectFiles(preferredPath = state.changes.selectedProjectFile) {
  const project = state.project?.path;
  if (!project) { $('review-file-list').innerHTML = '<p class="changes-empty">请先选择项目。</p>'; $('review-file-content').textContent = '选择文件查看内容。'; return; }
  const request = ++state.changes.projectFilesRequest;
  $('refresh-changes').disabled = true; $('review-file-list').innerHTML = '<p class="changes-empty">正在读取项目文件…</p>';
  const current = () => request === state.changes.projectFilesRequest && project === state.project?.path;
  try {
    const query = $('review-file-search').value.trim();
    const data = await api('/api/files?project=' + encodeURIComponent(project) + '&q=' + encodeURIComponent(query));
    if (!current()) return;
    state.changes.projectFiles = data.files || [];
    const selected = state.changes.projectFiles.find((file) => file.path === preferredPath) || state.changes.projectFiles.find((file) => file.path === state.changes.selectedProjectFile) || state.changes.projectFiles[0];
    state.changes.selectedProjectFile = selected?.path || null; renderProjectFiles();
    if (selected) await loadProjectFile(selected.path);
    else $('review-file-content').textContent = '没有匹配的安全文本文件。';
  } catch (error) {
    if (current()) { state.changes.projectFiles = []; state.changes.selectedProjectFile = null; $('review-file-list').innerHTML = '<p class="changes-empty">无法读取项目文件：' + esc(error.message) + '</p>'; $('review-file-content').textContent = '无法读取项目文件。'; }
  } finally { if (current()) $('refresh-changes').disabled = false; }
}
async function runReviewTerminal() {
  if (state.changes.terminalBusy) return;
  const project = state.project?.path, command = $('review-terminal-command').value.trim();
  if (!project) { toast('请先选择项目文件夹', 'warning'); return; }
  if (!command) { toast('请输入要执行的命令', 'warning'); $('review-terminal-command').focus(); return; }
  const button = $('run-review-terminal'); state.changes.terminalBusy = true; button.disabled = true; $('review-terminal-command').disabled = true; $('review-terminal-timeout').disabled = true; $('review-terminal-output').textContent = '正在执行…';
  try {
    const data = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project, command, timeoutMs: Number($('review-terminal-timeout').value) }) });
    const result = data.result || {}, status = data.ok ? '完成' : result.failure === 'timeout' ? '超时' : result.failure === 'aborted' ? '已中止' : '失败';
    const code = result.exitCode == null ? '—' : String(result.exitCode);
    const output = result.combined || '(无输出)';
    $('review-terminal-output').textContent = status + ' · 退出码 ' + code + ' · ' + formatNumber(result.durationMs || 0) + ' ms' + (result.truncated ? ' · 输出已截断' : '') + '\n\n' + output;
  } catch (error) { $('review-terminal-output').textContent = '执行失败：' + error.message; }
  finally { state.changes.terminalBusy = false; button.disabled = false; $('review-terminal-command').disabled = false; $('review-terminal-timeout').disabled = false; }
}
function rememberSessionChoices() {
  if (!state.sessionId) return;
  state.sessionChoices.set(state.sessionPath || state.sessionId, { pendingModelKey: state.pendingModelKey, pendingThinkingLevel: state.pendingThinkingLevel, pendingMode: state.pendingMode, pendingWorkflow: state.pendingWorkflow, attachments: [...state.attachments] });
}
function adoptSessionView(data, preserveCommandPicker = false) {
  rememberDraft();
  state.eventSource?.close(); state.eventSource = null;
  closeSessionMenu(); closeModelPicker(); closeModePicker(); if (!preserveCommandPicker) closeCommandPicker(); closeContext(); closeFilePicker(); state.uiQueue = []; closeUiModal();
  cancelStreamedMarkdown(); state.widgets.clear(); $('extension-widgets').textContent = '';
  state.sessionId = data.id; state.sessionPath = data.sessionFile || null; state.lastEventId = 0;
  state.context = null; state.budget = null; state.runtimeCommands = []; state.runMode = undefined;
  state.sessionHistory = { status: 'active', pinned: false }; state.compacting = false; state.compactRequest = false; state.runControl = null; state.runControlRequest = null;
  state.activeMode = data.mode || 'agent'; state.activeWorkflow = data.workflow || 'direct';
  const choices = state.sessionChoices.get(state.sessionPath || state.sessionId);
  state.pendingModelKey = choices?.pendingModelKey ?? null; state.pendingThinkingLevel = choices?.pendingThinkingLevel ?? null;
  state.pendingMode = choices?.pendingMode ?? null; state.pendingWorkflow = choices?.pendingWorkflow ?? null;
  state.attachments = choices ? [...choices.attachments] : []; state.attachmentGeneration++;
  if (data.project) setProject(state.projects.find((project) => samePath(project.path, data.project)) || { path: data.project, name: shortPath(data.project) });
  applySnapshot(data);
}
function draftKey() { return 'pforge.draft.' + (state.sessionPath || state.sessionId || 'new@' + (state.project?.path || '')); }
function rememberDraft() { rememberSessionChoices(); resizeComposerInputs(); const input = state.sessionId ? $('followup-prompt') : $('prompt'); const files = state.attachments.filter((item) => item.type === 'file').map((item) => ({ type: 'file', path: item.path })); saveStored(draftKey(), input.value || files.length ? files.length ? { text: input.value || '', attachments: files } : input.value : null, sessionStorage); }
function restoreDraft() {
  const key = draftKey();
  const value = stored(key, '', sessionStorage);
  const input = state.sessionId ? $('followup-prompt') : $('prompt');
  input.value = typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : '';
  const choices = state.sessionChoices.get(state.sessionPath || state.sessionId);
  state.attachments = choices ? [...choices.attachments] : Array.isArray(value?.attachments) ? value.attachments.filter((item) => item?.type === 'file' && typeof item.path === 'string').slice(0, 6) : [];
  renderAttachments(); renderComposerControl();
}
function renderRunStatus(data = state) {
  const outcome = sessionOutcome(data);
  $('run-status-label').textContent = outcome.label;
  $('run-status-dot').className = 'status-dot ' + outcome.kind;
}
function applySnapshot(data) {
  if (data.id && data.id !== state.sessionId) return;
  if (state.subagentSession !== state.sessionId) { closeSubagent(); closeSubagentMenu(); state.subagentSession = state.sessionId; }
  renderSubagents(data.subagents || []);
  state.outcome = data.outcome || 'idle'; state.error = data.error || null;
  state.sessionPath = data.sessionFile || state.sessionPath;
  if (data.history) state.sessionHistory = data.history;
  state.lastUserEntryId = data.lastUserEntryId || null;
  state.forkOrigin = data.fork || null;
  state.forkableEntries = new Set(data.forkableEntries || []);
  state.runStartedAt = data.runningSince || null;
  state.runFinishedAt = data.finishedAt || null;
  if (data.context) state.context = data.context;
  if ('budget' in data) state.budget = data.budget || data.task?.budget || null;
  else if (data.task?.budget) state.budget = data.task.budget;
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
  $('run-title').title = $('run-title').textContent;
  renderHistoryNotice();
  const pending = data.pendingUiRequests || [];
  if (state.uiRequest && !pending.some((item) => item.requestId === state.uiRequest.requestId)) { state.uiQueue = []; closeUiModal(); }
  state.uiQueue = [];
  pending.forEach(showUiRequest);
  saveStored('pforge.activeSession', { id: state.sessionId, path: state.sessionPath, project: state.project?.path }, sessionStorage);
}
function handleEvent(event) {
  if (event.type === 'pforge_history_changed') { loadProjects().catch(() => {}); return; }
  if (event.type === 'pforge_snapshot') { applySnapshot(event.snapshot); return; }
  if (event.type === 'forge_subagents') { renderSubagents(event.agents); return; }
  if (event.type === 'pforge_context') { state.context = event.context; state.compacting = Boolean(event.context?.compacting); setRunning(state.running); return; }
  if (event.type === 'pforge_task') { if (event.task?.budget) state.budget = event.task.budget; renderTask(event.task); renderRunStatus(); loadTasks().catch(() => {}); return; }
  if (event.type === 'pforge_budget') { state.budget = event.budget || null; renderBudget(); return; }
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
  if (event.type === 'agent_settled') { flushStreamedMarkdown(); if (!event.taskRunning) { state.runFinishedAt = Date.now(); state.outcome = event.aborted ? 'aborted' : state.error ? 'failed' : 'completed'; setRunning(false); if (state.executionProcess) state.executionProcess.open = false; } renderRunStatus(); updateElapsed(); loadProjects().catch(() => {}); loadTasks().catch(() => {}); return; }
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
          if (controller.signal.aborted || state.sessionId !== sessionId) return;
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
  if (!state.model && !sessionFile) throw new Error('请先在设置里配置可用模型');
  const payload = { ...(state.project ? { project: state.project.path } : {}), sessionFile, title };
  if (!state.project && !sessionFile) { state.projectRequestId ||= newRequestId(); payload.requestId = state.projectRequestId; }
  if (!sessionFile) payload.mode = state.mode;
  if (!preserveSessionConfig && state.model) { payload.model = state.model.key; payload.thinkingLevel = state.thinkingLevel; }
  if (!sessionFile && state.mode === 'agent') payload.workflow = state.workflow;
  const created = await api('/api/session', { method: 'POST', body: JSON.stringify(payload) });
  adoptSessionView({ ...created, sessionFile: created.sessionFile || sessionFile || null }, !state.sessionId && Boolean(state.commandInput));
  if (!state.projects.some((project) => samePath(project.path, created.project))) await loadProjects();
  setProject(state.projects.find((project) => samePath(project.path, created.project)) || { path: created.project, name: shortPath(created.project) });
  if (connectEvents) connect(created.id); renderProjects();
  restoreDraft();
  showChat();
  return created;
}
async function openSession(path, project) {
  if (navigationLocked()) { toast('请等待当前操作完成'); return; }
  closeSessionMenu(); closeCommandPicker(); closeContext(); closeModelPicker();
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
  const sessionId = state.sessionId;
  const data = await api('/api/sessions/' + sessionId + '/state');
  if (sessionId === state.sessionId) applySnapshot(data);
}
async function sendPrompt(prompt, command = false) {
  if ((!prompt.trim() && !state.attachments.length) || state.attachmentReading || state.compacting || state.compactRequest || state.running || state.loadingSession || state.changingMode || state.changingConfig) return false;
  prompt = prompt.trim() ? prompt : '请查看这些附件，并帮助我分析。';
  closeCommandPicker(); closeContext(); closeModelPicker();
  state.loadingSession = true; $('run-button').disabled = true;
  let createdId; const attachments = [...state.attachments];
  try {
    const session = await createSession(undefined, prompt.slice(0, 60), false, false);
    createdId = session.id;
    state.runStartedAt = Date.now(); state.runFinishedAt = null; state.error = null; state.outcome = 'running'; renderVerification(null); setRunning(true); renderRunStatus();
    await api('/api/sessions/' + session.id + '/prompt', { method: 'POST', body: JSON.stringify({ message: prompt, workflow: !command && state.mode === 'agent' ? state.workflow : 'direct', ...(command ? { command: true } : {}), ...(attachments.length ? { attachments } : {}) }) });
    state.attachments = []; renderAttachments();
    loadProjects().catch(() => {}); return true;
  } catch (error) { state.attachments = attachments; renderAttachments(); setRunning(false); toast(error.message, 'error'); if (!state.model) openSettings(); return false; } finally { if (createdId && state.sessionId === createdId) connect(createdId); state.loadingSession = false; setRunning(state.running); }
}
async function applyPendingSessionConfig() {
  if (!state.sessionId || state.readOnly) return;
  const modelKey = state.pendingModelKey;
  const thinkingLevel = state.pendingThinkingLevel, mode = state.pendingMode, workflow = state.pendingWorkflow;
  if (!modelKey && thinkingLevel === null && mode === null && workflow === null) return;
  if (mode !== null && mode !== state.activeMode && !(await changeMode(mode, true))) throw new Error('无法应用下一条消息的工作模式');
  if (workflow !== null && workflow !== state.activeWorkflow && !(await changeWorkflow(workflow, true))) throw new Error('无法应用下一条消息的执行策略');
  if (modelKey && modelKey !== state.activeModelKey && !(await changeModel(modelKey, true, true))) throw new Error('无法应用下一条消息的模型配置');
  if (thinkingLevel !== null && thinkingLevel !== state.activeThinkingLevel && !(await changeThinking(thinkingLevel, true, true))) throw new Error('无法应用下一条消息的推理强度');
  state.pendingModelKey = null; state.pendingThinkingLevel = null; state.pendingMode = null; state.pendingWorkflow = null;
  state.mode = state.activeMode; state.workflow = state.activeWorkflow; syncModeControls();
  state.thinkingLevel = state.activeThinkingLevel; setModel(modelByKey(state.activeModelKey) || state.model);
}
async function sendFollowup(prompt, command = false) {
  if ((!prompt.trim() && !state.attachments.length) || state.attachmentReading || state.compacting || state.compactRequest || state.running || state.loadingSession || state.changingMode || state.changingConfig || state.sending || state.runControl || state.readOnly || historyReadOnly() || !state.sessionId) return false;
  prompt = prompt.trim() ? prompt : '请查看这些附件，并帮助我分析。';
  closeCommandPicker(); closeContext(); closeModelPicker();
  state.sending = true; setRunning(state.running);
  const attachments = [...state.attachments];
  try {
    await applyPendingSessionConfig();
    state.runStartedAt = Date.now(); state.runFinishedAt = null; state.error = null; state.outcome = 'running'; renderVerification(null); setRunning(true); renderRunStatus();
    await api('/api/sessions/' + state.sessionId + '/prompt', { method: 'POST', body: JSON.stringify({ message: prompt, workflow: !command && state.mode === 'agent' ? state.workflow : 'direct', ...(command ? { command: true } : {}), ...(attachments.length ? { attachments } : {}) }) });
    state.attachments = []; renderAttachments();
    void loadProjects().catch(() => {});
    return true;
  } catch (error) { setRunning(false); toast(error.message, 'error'); refreshSessionState().catch(() => {}); return false; }
  finally { state.sending = false; setRunning(state.running); }
}
async function stopExecution() {
  if (!state.sessionId || !state.running || state.runControl) return false;
  const sessionId = state.sessionId, restoreFocus = document.activeElement === $('stop-button'), controlRequest = newRequestId();
  state.runControlRequest = controlRequest; state.runControl = 'stopping'; setRunning(state.running);
  try {
    await api('/api/sessions/' + sessionId + '/abort', { method: 'POST' });
    // The abort endpoint waits for Pi and verification to settle. Use the snapshot
    // to distinguish a real interruption from a run that finished before the click.
    if (sessionId === state.sessionId) await refreshSessionState();
    return true;
  } catch (error) { toast('停止失败：' + error.message, 'error'); return false; }
  finally { if (sessionId === state.sessionId && state.runControlRequest === controlRequest) { state.runControl = null; state.runControlRequest = null; setRunning(state.running); if (restoreFocus) (state.running ? $('stop-button') : continuationKind() && !$('followup-prompt').value.trim() ? $('resume-task-button') : $('followup-prompt')).focus({ preventScroll: true }); } }
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
    $('folder-location').value = data.path;
    $('folder-list').innerHTML = (data.directories || []).map((dir) => '<button class="folder-row" data-folder="' + esc(dir.path) + '"><span>' + icon('folder') + '</span><span>' + esc(dir.name) + '</span><span>›</span></button>').join('') || '<div class="empty-sessions">没有子文件夹</div>';
    $('folder-modal').classList.remove('hidden');
  } catch (error) { toast(error.message, 'error'); }
}
function openProjectFolderPicker() {
  if (state.sessionId) { toast('当前对话已绑定项目，请新建对话后切换项目'); return; }
  $('managed-root-label').textContent = state.managedRoot;
  $('managed-project-name').value = '';
  $('folder-error').textContent = '';
  $('folder-external').classList.add('hidden');
  $('folder-recent').innerHTML = state.projects.filter((project) => project.available !== false).map((project) => '<button type="button" class="recent-project" data-use-project="' + esc(project.path) + '">' + icon('folder') + '<span><strong>' + esc(project.name) + '</strong><small>' + (project.kind === 'managed' ? 'Forge 管理 · ' : '本机文件夹 · ') + esc(project.path) + '</small></span></button>').join('') || '<p class="settings-note">项目会统一出现在这里和左侧列表。</p>';
  $('folder-modal').classList.remove('hidden'); $('managed-project-name').focus();
}
async function chooseProject(project) {
  if (!canChangeProject(project?.path)) return;
  const draft = $('prompt').value;
  const attachments = state.attachments.filter((item) => item.type !== 'file' || samePath(state.project?.path, project?.path));
  rememberDraft(); setProject(project); restoreDraft();
  // Choosing where to send a new message must not discard its text or uploads.
  // Only references to files in the previous project are tied to that directory.
  if (draft || attachments.length) { $('prompt').value = draft; state.attachments = attachments; renderAttachments(); rememberDraft(); }
  if (project) { await loadTrust(project.path); state.expandedProjects.add(project.path); }
  $('folder-modal').classList.add('hidden'); await loadProjects(); toggleSidebar(false); $('prompt').focus();
}
function providerOptions() {
  const ids = Array.from(new Set(state.providers.map((provider) => provider.id)));
  return ids.map((id) => { const provider = state.providers.find((item) => item.id === id); return '<option value="' + esc(id) + '">' + esc(provider ? provider.name : id) + (provider && provider.auth && provider.auth.configured ? ' · 已配置' : '') + '</option>'; }).join('') || '<option value="">暂无可配置 Provider</option>';
}
function modelCard(model) {
  const abilities = [model.reasoning ? '推理' : '', model.input.includes('image') ? '视觉输入' : '', model.promptCache ? '提示缓存' : ''].filter(Boolean).join(' · ') || '文本对话';
  return '<article class="model-card" data-model-card="' + esc(model.key) + '"><span class="model-card-main"><strong>' + esc(model.name) + '</strong><small>' + esc(model.providerName) + ' · ' + esc(model.id) + '</small></span><span class="model-capabilities">' + esc(abilities) + '</span><span class="model-context">' + (model.contextWindow ? formatNumber(model.contextWindow) + ' tokens' : '—') + '</span><span class="model-availability">可用</span></article>';
}
const MEMORY_KIND_LABELS = { fact: '事实', preference: '偏好', decision: '决定', constraint: '约束' };
const MEMORY_LAYER_INFO = {
  global: ['全局记忆', '跨项目复用的个人偏好和长期约束。'],
  project: ['项目记忆', '只注入当前项目，适合记录架构决定、目录约定和项目规则。'],
  session: ['会话记忆', '只跟随当前 Pi 会话树，分支会保留它的上下文。']
};
function memoryKindOptions(selected = 'fact') {
  return Object.entries(MEMORY_KIND_LABELS).map(([value, label]) => '<option value="' + value + '" ' + (value === selected ? 'selected' : '') + '>' + label + '</option>').join('');
}
function memoryItemMarkup(item, editable) {
  const id = typeof item?.id === 'string' && item.id ? item.id : 'memory-' + Math.random().toString(36).slice(2);
  const source = item?.source === 'compaction' ? '来自压缩摘要' : item?.source === 'agent' ? '审阅后接受 · ' + (item.provenance?.evidence || '') : '用户维护';
  return '<div class="memory-item" data-memory-item-id="' + esc(id) + '"><div class="memory-item-head"><label class="memory-enabled"><input type="checkbox" data-memory-enabled ' + (item?.enabled !== false ? 'checked ' : '') + (!editable ? 'disabled ' : '') + '>启用</label><select data-memory-item-kind aria-label="记忆类型" ' + (!editable ? 'disabled ' : '') + '>' + memoryKindOptions(item?.kind || 'fact') + '</select><small>' + esc(source) + '</small><button type="button" data-memory-delete aria-label="删除记忆" title="删除记忆" ' + (!editable ? 'disabled ' : '') + '>×</button></div><textarea data-memory-text rows="2" maxlength="4000" ' + (!editable ? 'disabled ' : '') + '>' + esc(item?.text || '') + '</textarea></div>';
}
function memoryLayerMarkup(layer, documentValue, editable) {
  const info = MEMORY_LAYER_INFO[layer];
  const items = Array.isArray(documentValue?.items) ? documentValue.items : [];
  return '<section class="memory-layer" data-memory-layer="' + layer + '"><div class="memory-layer-heading"><div><h4>' + info[0] + '</h4><p>' + info[1] + '</p></div><span class="memory-count">' + items.length + ' 条</span></div><div class="memory-items" data-memory-items>' + (items.length ? items.map((item) => memoryItemMarkup(item, editable)).join('') : '<p class="memory-empty">还没有记忆，可以在下面添加。</p>') + '</div>' + (editable ? '<div class="memory-add"><select data-memory-new-kind aria-label="新记忆类型">' + memoryKindOptions() + '</select><textarea data-memory-new-text rows="2" maxlength="4000" placeholder="例如：默认使用 pnpm；不要修改 generated/ 目录"></textarea><button type="button" class="button quiet small" data-memory-add>添加</button></div><div class="memory-layer-actions"><span class="memory-dirty hidden" data-memory-dirty>有未保存的修改</span><button type="button" class="button primary small" data-memory-save>保存</button></div>' : '<p class="memory-readonly">当前会话不可编辑；恢复会话或选择可用模型后才能修改会话记忆。</p>') + '</section>';
}
function emptyMemoryDocument(layer, scope = '') { return { version: 1, layer, scope, updatedAt: '', items: [] }; }
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
    const projectQuery = state.project ? '?project=' + encodeURIComponent(state.project.path) : '';
    const memoryQuery = state.project ? '?project=' + encodeURIComponent(state.project.path) + (state.sessionId ? '&session=' + encodeURIComponent(state.sessionId) : '') : '?scope=global';
    const [config, credentials, settings, mcp, memory] = await Promise.all([api('/api/config' + projectQuery), api('/api/credentials'), api('/api/settings'), state.project ? api('/api/mcp' + projectQuery) : Promise.resolve(null), api('/api/memory' + memoryQuery)]);
    if (!state.project) config.verify = [];
    state.providers = settings.providers || [];
    state.models = settings.models || [];
    const models = settings.models || [];
    const budget = settings.budget || { maxDurationMs: 5400000, maxModelTurns: 240, maxToolCalls: 500, maxTotalTokens: 0, maxOutputTokens: 300000, maxCostUsd: 40 };
    const budgetDiagnostic = settings.budgetValid === false ? settings.budgetDiagnostic || '执行预算配置无效，请重新保存。' : '';
    const configWarningMarkup = (config.configWarnings || []).length ? '<p class="settings-note warning">' + config.configWarnings.map((warning) => esc(warning)).join('<br>') + '</p>' : '';
    const credentialRows = (credentials.credentials || []).map((item) => '<div class="credential-row"><span>' + esc(item.provider) + '</span><small>' + esc(item.type) + '</small><button class="text-button" data-remove-provider="' + esc(item.provider) + '">移除</button></div>').join('');
    const currentDefault = models.find((model) => model.key === settings.model);
    $('drawer-body').innerHTML =
      '<nav class="settings-tabs" aria-label="设置分类"><button data-settings-tab="provider">服务</button><button data-settings-tab="model">模型</button><button data-settings-tab="tools">工具</button><button data-settings-tab="memory">记忆</button><button data-settings-tab="mcp">MCP</button><button data-settings-tab="skills">技能</button><button data-settings-tab="project">项目</button><button data-settings-tab="system">关于</button></nav>' +
      '<div data-settings-panel="model"><section class="settings-block"><div class="settings-heading"><div><h3>可用模型</h3><p>当前使用的模型和推理强度，在聊天框下方选择。</p></div><button class="button quiet small" id="refresh-models">刷新目录</button></div><label>服务筛选<select id="model-provider-filter"><option value="">所有服务</option>' + state.providers.filter((provider) => provider.availableModelCount).map((provider) => '<option value="' + esc(provider.id) + '">' + esc(provider.name) + '</option>').join('') + '</select></label><label>搜索模型<input id="model-search" type="search" placeholder="模型名称、ID 或能力" autocomplete="off"></label><div class="settings-note" id="model-count"></div><div class="model-list" id="model-list"></div><button class="button quiet small hidden" id="more-models">显示更多</button><button class="button quiet small" id="manage-model-services">管理服务与可用模型</button></section></div>' +
      '<div data-settings-panel="provider"><div id="custom-providers"></div><section class="settings-block"><details class="builtin-provider"><summary>内置服务与凭据</summary><div class="provider-form"><p>选择内置服务并保存 Key。OAuth 登录请使用本机 forge-agent 中的 /login。</p><label>Provider<select id="credential-provider">' + providerOptions() + '</select></label><div id="provider-info" class="model-facts"></div><label>API Key<input id="credential-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="保存后不会回显"></label><button class="button primary" id="save-credential">保存凭据</button><div class="credential-list">' + (credentialRows || '<p class="settings-note">暂无已保存的凭据</p>') + '</div></div></details></section><p class="settings-note">配置和凭据保存在本机。已配置凭据表示可以发起调用，实际结果以模型请求为准。</p></div>' +
      '<div data-settings-panel="tools"><section class="settings-block"><h3>联网工具</h3><p>网页搜索和网址正文读取默认启用，无需另配 API Key。搜索结果可继续读取来源，并在回复中引用网址。</p><label class="network-toggle"><input id="network-enabled" type="checkbox"' + (settings.network?.enabled !== false ? ' checked' : '') + '>启用网页搜索与读取</label><div class="network-actions"><button type="button" class="button quiet small" id="save-network">保存</button><button type="button" class="button quiet small" id="check-network">测试文档连接</button></div><p class="settings-note" id="network-diagnostic" role="status">' + esc(settings.network?.diagnostic || settings.network?.lastCheck?.message || '尚未检测。可点击测试，实际读取 Three.js 官方文档。') + '</p></section><section class="settings-block"><h3>当前可用能力</h3><dl class="tool-capabilities"><dt>文件与代码</dt><dd>读取、搜索、写入和编辑；Plan / Ask 保持只读。</dd><dt>网页搜索</dt><dd>web_search：返回标题、摘要、来源网址；公共搜索可能限流或出现验证码。</dd><dt>网址正文</dt><dd>web_fetch：读取公共文档和文本网页，展示来源与截断提示。</dd><dt>终端与依赖</dt><dd>Agent 使用 Pi 的终端工具执行命令、安装 npm 等项目依赖；结果以实际输出为准。</dd><dt>浏览器交互</dt><dd>通过设置中的 MCP 连接浏览器服务；网页读取工具不执行页面 JavaScript，也不复用浏览器登录。</dd></dl><p class="settings-note">这些联网开关只控制 Forge 的网页工具，不是网络沙箱。终端、MCP 和扩展仍使用本机权限。</p></section></div>' +
      '<div data-settings-panel="memory"><div id="memory-settings"></div></div>' +
      '<div data-settings-panel="mcp"><div id="mcp-settings"></div></div>' +
      '<div data-settings-panel="skills"><div id="skills-settings"></div></div>' +
      '<div data-settings-panel="project"><section class="settings-block"><h3>当前项目</h3><code class="settings-path">' + esc(state.project?.path || '未选择项目') + '</code><p>信任后允许加载项目扩展及验证命令。变更信任会卸载当前会话的项目资源，需要重新选择模型继续。</p><div class="trust-setting"><span>' + (state.trust?.trusted ? '项目已信任' : '项目未信任') + '</span><button class="button quiet" id="toggle-trust">' + (state.trust?.trusted ? '撤销信任' : '信任当前项目') + '</button></div></section><section class="settings-block"><h3>自动验证</h3><p>在当前项目的 forge-agent.json 中设置 verify、verifyRetries 和 protect。</p>' + configWarningMarkup + '<pre class="settings-code">' + esc(config.verify?.length ? config.verify.map((item) => item.name + ': ' + item.command).join(String.fromCharCode(10)) : '未配置验证命令') + '</pre></section></div>' +
       '<div data-settings-panel="system"><section class="settings-block"><h3>Forge Agent · 本机 Coding Agent</h3><p>Agent 运行、认证、工具、会话、扩展、MCP 与 Skills 由 Pi 提供。</p><div class="config-row"><span>Pi 版本</span><code>' + esc(settings.piVersion) + '</code></div><div class="config-row block"><span>设置文件</span><code>' + esc(settings.settingsPath) + '</code></div><div class="config-row block"><span>启动目录</span><code>' + esc(config.cwd) + '</code></div><p>目录共 ' + settings.allModelCount + ' 个模型，当前已配置认证的模型 ' + models.length + ' 个。</p></section><section class="settings-block" id="execution-budget"><div class="settings-heading"><div><h3>执行预算</h3><p>限制单次 Agent 执行的时长、模型回合、工具调用、生成量和费用。只影响下一次执行，运行中的任务不会被静默改写。</p></div></div>' + (budgetDiagnostic ? '<p class="settings-note warning">' + esc(budgetDiagnostic) + '</p>' : '') + '<div class="budget-presets"><button type="button" class="button quiet small" data-budget-preset="standard">常规任务</button><button type="button" class="button quiet small" data-budget-preset="long">长任务 · 4 小时</button></div><div class="budget-grid"><label>最长时长（分钟）<input id="budget-duration" type="number" min="1" max="1440" value="' + esc(Math.round((budget.maxDurationMs || 3600000) / 60000)) + '"></label><label>模型回合<input id="budget-turns" type="number" min="1" max="1000" value="' + esc(budget.maxModelTurns) + '"></label><label>工具调用<input id="budget-tools" type="number" min="1" max="10000" value="' + esc(budget.maxToolCalls) + '"></label><label>累计请求 token（0=关闭）<input id="budget-tokens" type="number" min="0" max="100000000" step="1000" value="' + esc(budget.maxTotalTokens) + '"></label><label>生成 token<input id="budget-output-tokens" type="number" min="1000" max="10000000" step="1000" value="' + esc(budget.maxOutputTokens || 200000) + '"></label><label>费用上限（美元）<input id="budget-cost" type="number" min="0" max="100000" step="0.01" value="' + esc(budget.maxCostUsd) + '"></label></div><p class="settings-note">默认不因缓存读取量停止任务；生成量、回合、工具、时长和已知费用仍受限。累计请求 token 可设为 0 关闭，启用后包含输入、输出和缓存读取。Provider usage 通常在响应结束时到达，单次响应可能略微超过上限。</p><button class="button primary small" id="save-agent-budget">保存执行预算</button></section></div>';
    const activateTab = (name) => {
      state.settingsTab = name;
      document.querySelectorAll('[data-settings-panel]').forEach((node) => node.classList.toggle('hidden', node.dataset.settingsPanel !== name));
      document.querySelectorAll('[data-settings-tab]').forEach((button) => { button.classList.toggle('active', button.dataset.settingsTab === name); button.setAttribute('aria-pressed', String(button.dataset.settingsTab === name)); });
    };
    $('drawer-body').querySelectorAll('[data-settings-tab]').forEach((button) => { button.onclick = () => activateTab(button.dataset.settingsTab); });
    activateTab(state.settingsTab);
    $('save-network').onclick = async () => {
      const button = $('save-network'); setBusy(button, true, '保存中…');
      try { const enabled = $('network-enabled').checked; await api('/api/settings/network', { method: 'POST', body: JSON.stringify({ enabled }) }); $('network-diagnostic').textContent = enabled ? '联网工具已启用。当前空闲会话已重新加载。' : 'Forge 联网工具已关闭。'; if (state.sessionId) await refreshSessionState(); toast('联网设置已保存'); }
      catch (error) { $('network-diagnostic').textContent = error.message; toast(error.message, 'error'); }
      finally { setBusy(button, false); }
    };
    $('check-network').onclick = async () => {
      const button = $('check-network'); setBusy(button, true, '检测中…');
      $('network-diagnostic').textContent = '正在实际读取公共文档…';
      try { const result = await api('/api/network/check', { method: 'POST', body: '{}' }); $('network-diagnostic').textContent = result.message; toast(result.ok ? '文档连接正常' : '文档连接失败，请查看原因', result.ok ? 'info' : 'warning'); }
      catch (error) { $('network-diagnostic').textContent = error.message; }
      finally { setBusy(button, false); }
    };
    const storageInfo = document.createElement('section'); storageInfo.className = 'settings-block';
    storageInfo.innerHTML = '<h3>项目与会话存储</h3><p>新建对话不预选目录。未选项目就发送时，会在下方创建独立项目；主动打开的本机文件夹在原位置工作。</p><div class="config-row block"><span>Forge 项目目录</span><code>' + esc(state.managedRoot || config.managedProjectsRoot) + '</code></div><div class="config-row block"><span>统一会话目录</span><code>' + esc(state.sessionRoot || config.sessionRoot) + '</code></div>';
    $('drawer-body').querySelector('[data-settings-panel="project"]').prepend(storageInfo);
    document.querySelectorAll('[data-budget-preset]').forEach((button) => button.addEventListener('click', () => {
      const values = button.dataset.budgetPreset === 'long' ? [240, 400, 800, 500000] : [90, 240, 500, 300000];
      ['budget-duration', 'budget-turns', 'budget-tools', 'budget-output-tokens'].forEach((id, index) => { $(id).value = String(values[index]); });
      $('budget-tokens').value = '0';
      toast('已填入预算预设；费用上限保持原值，点击保存后在下一段执行生效');
    }));
    const saveBudget = $('save-agent-budget');
    if (saveBudget) saveBudget.onclick = async () => {
      const value = { maxDurationMs: Number($('budget-duration').value) * 60000, maxModelTurns: Number($('budget-turns').value), maxToolCalls: Number($('budget-tools').value), maxTotalTokens: Number($('budget-tokens').value), maxOutputTokens: Number($('budget-output-tokens').value), maxCostUsd: Number($('budget-cost').value) };
      setBusy(saveBudget, true, '保存中…');
      try { const result = await api('/api/settings/budget', { method: 'POST', body: JSON.stringify({ budget: value }) }); settings.budget = result.budget; toast('执行预算已保存，下一条消息或继续任务时生效'); }
      catch (error) { toast(error.message, 'error'); }
      finally { setBusy(saveBudget, false); }
    };
    const memoryDocuments = {
      global: memory?.global || emptyMemoryDocument('global', 'global'),
      project: memory?.project || emptyMemoryDocument('project', state.project?.path || ''),
      session: memory?.session || emptyMemoryDocument('session', state.sessionId || '')
    };
    const memoryRevisions = { ...memory?.revisions };
    const memoryBudget = Array.isArray(memory?.promptBudget) ? memory.promptBudget : [];
    const recallReasons = { constraint: '约束优先', preference: '偏好优先', relevant: '与当前任务相关', available: '参考记忆' };
    const memoryBudgetMarkup = memoryBudget.length ? '<details class="memory-budget"><summary>当前任务记忆召回：' + memoryBudget.map((item) => esc(item.layer) + ' ' + esc(String(item.includedItems ?? 0)) + '/' + esc(String(item.enabledItems ?? 0)) + ' 条 · ' + esc(String(item.chars)) + '/' + esc(String(item.budget)) + (item.truncated ? '（已截断）' : '')).join(' · ') + '</summary>' + memoryBudget.map((layer) => (layer.selected || []).map((selection) => { const item = memoryDocuments[layer.layer]?.items.find((entry) => entry.id === selection.id); return item ? '<p>' + esc(layer.layer + ' · ' + recallReasons[selection.reason] + (selection.partial ? ' · 部分注入' : '') + '：' + item.text.slice(0, 220)) + '</p>' : ''; }).join('')).join('') + '</details>' : '';
    const sessionMemoryEditable = Boolean(state.sessionId && !state.readOnly && !historyReadOnly());
    const renderMemory = () => {
      const compaction = settings.compaction || { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
      $('memory-settings').innerHTML = '<section class="memory-section"><div class="memory-summary"><strong>三层记忆 + Pi 原生上下文</strong><br>全局记忆跨项目复用，项目记忆按文件夹隔离，会话记忆跟随 Pi 会话树和分支。记忆只作为用户参考资料注入，不会获得工具权限。Pi 负责自动压缩，压缩摘要会保留在会话历史中。' + memoryBudgetMarkup + '</div><section class="settings-block memory-compaction"><div class="settings-heading"><div><h3>自动上下文压缩</h3><p>上下文接近窗口上限时由 Pi 自动整理较早内容；原始历史仍可在会话树中查看。</p></div><label class="switch-label"><input type="checkbox" id="memory-auto-compaction" ' + (compaction.enabled !== false ? 'checked' : '') + '> <span>自动压缩</span></label></div><div class="memory-compaction-facts"><span>预留阈值 <strong>' + formatNumber(compaction.reserveTokens) + '</strong> tokens</span><span>保留最近 <strong>' + formatNumber(compaction.keepRecentTokens) + '</strong> tokens</span><span>本会话已压缩 <strong>' + formatNumber(memory?.compaction?.count || 0) + '</strong> 次</span></div><p class="settings-note">关闭后不会触发新的自动压缩，但仍可以在聊天框下方手动压缩。修改设置需要所有会话空闲。</p></section>' + memoryLayerMarkup('global', memoryDocuments.global, true) + (state.project ? memoryLayerMarkup('project', memoryDocuments.project, true) : '<p class="settings-note">选择项目后可管理项目记忆。</p>') + memoryLayerMarkup('session', memoryDocuments.session, sessionMemoryEditable) + '</section>';
      const candidates = document.createElement('section'); candidates.className = 'settings-block'; candidates.id = 'memory-candidates';
      $('memory-settings').prepend(candidates);
      lifecycle.candidates(candidates, memory?.candidates || [], async () => {
        if ($('memory-settings').querySelector('[data-memory-dirty]:not(.hidden)')) { toast('候选已处理，请先保存下方未保存内容，再重新打开记忆设置'); return; }
        await openSettings('memory');
      });
      const toggle = $('memory-auto-compaction');
      toggle.onchange = async () => {
        toggle.disabled = true;
        try {
          const result = await api('/api/settings/compaction', { method: 'POST', body: JSON.stringify({ enabled: toggle.checked }) });
          settings.compaction = { ...compaction, enabled: result.enabled };
          state.context = { ...state.context, autoCompaction: result.enabled };
          renderContext(); toast(result.enabled ? '自动压缩已开启' : '自动压缩已关闭');
        } catch (error) { toggle.checked = compaction.enabled !== false; toast(error.message, 'error'); }
        finally { toggle.disabled = false; }
      };
      $('memory-settings').querySelectorAll('[data-memory-add]').forEach((button) => {
        button.onclick = () => {
          const layer = button.closest('[data-memory-layer]');
          const text = layer.querySelector('[data-memory-new-text]').value.trim();
          if (!text) { toast('请输入记忆内容', 'warning'); layer.querySelector('[data-memory-new-text]').focus(); return; }
          const kind = layer.querySelector('[data-memory-new-kind]').value;
          const item = { id: 'ui-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), text, kind, source: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), enabled: true };
          const items = layer.querySelector('[data-memory-items]'); items.querySelector('.memory-empty')?.remove(); items.insertAdjacentHTML('beforeend', memoryItemMarkup(item, true));
          layer.querySelector('[data-memory-new-text]').value = ''; layer.querySelector('[data-memory-dirty]').classList.remove('hidden'); layer.querySelector('.memory-count').textContent = items.querySelectorAll('[data-memory-item-id]').length + ' 条';
        };
      });
      $('memory-settings').querySelectorAll('[data-memory-delete]').forEach((button) => { button.onclick = () => { const layer = button.closest('[data-memory-layer]'); button.closest('[data-memory-item-id]').remove(); layer.querySelector('[data-memory-dirty]').classList.remove('hidden'); layer.querySelector('.memory-count').textContent = layer.querySelectorAll('[data-memory-item-id]').length + ' 条'; if (!layer.querySelector('[data-memory-item-id]')) layer.querySelector('[data-memory-items]').innerHTML = '<p class="memory-empty">还没有记忆，可以在下面添加。</p>'; }; });
      $('memory-settings').querySelectorAll('[data-memory-text], [data-memory-enabled], [data-memory-item-kind]').forEach((input) => { input.addEventListener('input', () => input.closest('[data-memory-layer]').querySelector('[data-memory-dirty]').classList.remove('hidden')); input.addEventListener('change', () => input.closest('[data-memory-layer]').querySelector('[data-memory-dirty]').classList.remove('hidden')); });
      $('memory-settings').querySelectorAll('[data-memory-save]').forEach((button) => {
        button.onclick = async () => {
          const layer = button.closest('[data-memory-layer]'); const layerName = layer.dataset.memoryLayer; const items = [...layer.querySelectorAll('[data-memory-item-id]')].map((item) => ({ ...memoryDocuments[layerName].items.find((entry) => entry.id === item.dataset.memoryItemId), id: item.dataset.memoryItemId, text: item.querySelector('[data-memory-text]').value.trim(), kind: item.querySelector('[data-memory-item-kind]').value, enabled: item.querySelector('[data-memory-enabled]').checked }));
          if (items.some((item) => !item.text)) { toast('记忆内容不能为空', 'error'); return; }
          setBusy(button, true, '保存中…');
          try {
            const result = await api('/api/memory', { method: 'POST', body: JSON.stringify({ project: state.project?.path, session: layerName === 'session' ? state.sessionId : undefined, layer: layerName, items, revision: memoryRevisions[layerName] }) });
            memoryRevisions[layerName] = result.revision;
            memoryDocuments[layerName] = result.document; layer.querySelector('[data-memory-dirty]').classList.add('hidden'); toast(MEMORY_LAYER_INFO[layerName][0] + '已保存');
          } catch (error) { toast(error.message, 'error'); }
          finally { setBusy(button, false); }
        };
      });
    };
    renderMemory();
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
    await mountCustomProviders($('custom-providers'), { api, esc, setBusy, initialProvider: editModel?.provider, initialModel: editModel?.id, onSaved: async (kind, diagnostic) => { await loadModels(); if (state.sessionId) await refreshSessionState(); await openSettings('provider'); toast(diagnostic || (kind === 'deleted' ? '服务已删除，相关旧会话已变为只读' : '服务已保存，在聊天框下方选择模型与推理强度'), diagnostic ? 'warning' : 'info'); } });
    if (state.project) {
      state.mcpSettings = mountMcp($('mcp-settings'), { api, esc, initial: mcp, projectPath: state.project.path, runtimeEnabled: true, isVisible: () => !$('drawer').classList.contains('hidden') && state.settingsTab === 'mcp', onChanged: async () => { await loadProjects(); if (state.sessionId) await refreshSessionState(); } });
      state.skillsSettings = mountSkills($('skills-settings'), { api, esc, projectPath: state.project.path, onChanged: async () => { if (state.sessionId) await refreshSessionState(); } });
    } else {
      ['mcp-settings', 'skills-settings'].forEach((id) => { $(id).innerHTML = '<section class="settings-block"><h3>先选择一个项目</h3><p>创建或打开项目后，可管理全局与项目资源，并查看实际加载结果。</p><button type="button" class="button quiet" data-settings-choose-project>选择项目</button></section>'; });
      document.querySelectorAll('[data-settings-choose-project]').forEach((button) => { button.onclick = () => { closeSettings(); openProjectFolderPicker(); }; });
    }
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
  return { mode: Object.hasOwn(MODES, value) ? value : 'agent', workflow: 'direct' };
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
    button.title = modeDescription() + (hasPendingMode() ? ' 下一条消息生效，当前运行权限不变。' : state.running ? ' 运行中可选，下一条消息生效。' : '');
    button.classList.toggle('has-pending-mode', hasPendingMode());
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
  if (state.compacting || state.compactRequest || state.loadingSession || state.changingMode || state.changingConfig || state.sending || state.runControl) return;
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
function hasPendingMode() { return state.pendingMode !== null || state.pendingWorkflow !== null; }
function stageModeSelection(selection) {
  const workflow = selection.mode === 'agent' ? selection.workflow : 'direct';
  state.pendingMode = selection.mode === state.activeMode ? null : selection.mode;
  state.pendingWorkflow = workflow === state.activeWorkflow ? null : workflow;
  state.workflow = workflow; setMode(selection.mode); rememberSessionChoices();
}
async function changeMode(mode, applying = false) {
  const previous = state.mode;
  if (state.compacting || state.compactRequest || state.loadingSession || state.changingMode || state.changingConfig || (state.sending && !applying) || !Object.hasOwn(MODES, mode)) { setMode(previous); return false; }
  if (state.running || hasPendingMode() && !applying) { stageModeSelection({ mode, workflow: mode === 'agent' ? state.workflow : 'direct' }); return true; }
  state.changingMode = true; setRunning(state.running);
  try {
    if (state.sessionId) {
      const data = await api('/api/sessions/' + state.sessionId + '/mode', { method: 'POST', body: JSON.stringify({ mode }) });
      state.activeMode = data.mode; if (data.workflow) state.activeWorkflow = data.workflow;
      if (!applying) { state.pendingMode = null; setMode(data.mode); if (data.workflow) setWorkflow(data.workflow); }
      renderRunStatus({ ...state, mode: data.mode });
    } else { state.activeMode = mode; setMode(mode); }
    saveStored('pforge.mode', mode); return true;
  } catch (error) { setMode(previous); toast(error.message, 'error'); return false; }
  finally { state.changingMode = false; setRunning(state.running); }
}
async function changeModeSelection(value) {
  const selection = parseModeSelection(value);
  const previousMode = state.mode, previousWorkflow = state.workflow;
  if (state.compacting || state.compactRequest || state.loadingSession || state.changingMode || state.changingConfig || state.sending || state.runControl) { syncModeControls(); return; }
  if (state.running || hasPendingMode()) { stageModeSelection(selection); return; }
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
  try { await Promise.all([loadProjects(), loadModels()]); await loadTasks(); $('connection-label').innerHTML = '<span class="meta-dot live"></span>本地 Forge Agent 已连接'; return true; }
  catch (error) { if (error.status !== 401) $('connection-label').textContent = '无法连接本地服务'; toast(error.message, 'error'); return false; }
}
function resetSessionView() {
  closeSessionMenu(); state.sessionHistory = { status: 'active', pinned: false }; state.forkOrigin = null; state.forkableEntries.clear(); renderHistoryNotice();
  closeCommandPicker(); closeContext();
  state.context = null; state.budget = null; state.runtimeCommands = []; state.compacting = false; state.compactRequest = false; state.runControl = null; state.runControlRequest = null; state.runStartedAt = null; state.runFinishedAt = null;
  cancelStreamedMarkdown();
  rememberDraft(); renderTask(null); toggleChanges(false);
  state.runMode = undefined;
  state.pendingModelKey = null; state.pendingThinkingLevel = null; state.pendingMode = null; state.pendingWorkflow = null;
  state.activeMode = stored('pforge.mode', 'agent'); state.activeWorkflow = 'direct';
  setWorkflow('direct');
  setMode(stored('pforge.mode', 'agent'));
  state.sessionId = null; state.sessionPath = null; state.lastUserEntryId = null; state.readOnly = false; state.outcome = 'idle'; state.error = null; state.lastEventId = 0; state.uiQueue = []; state.widgets.clear(); state.executionProcess = null; state.turnAnswer = null; state.attachments = [];
  state.attachmentGeneration++; state.projectRequestId = null;
  if (state.eventSource) state.eventSource.close(); state.eventSource = null;
  saveStored('pforge.activeSession', null, sessionStorage);
  $('prompt').value = ''; $('followup-prompt').value = ''; $('timeline').innerHTML = ''; $('extension-widgets').textContent = ''; renderAttachments(); renderVerification(null); closeUiModal(); setRunning(false); renderProjects();
  restoreDraft();
}
async function newConversation(keepProject = false) {
  if (navigationLocked()) { toast('请等待当前操作完成'); return; }
  closeModelPicker(); closeModePicker();
  resetSessionView(); if (keepProject !== true) { setProject(null); restoreDraft(); renderProjects(); } showStart(); toggleSidebar(false);
  state.loadingSession = true; setRunning(false);
  try { await loadModels(); } catch (error) { toast(error.message, 'error'); }
  finally { state.loadingSession = false; setRunning(state.running); }
  $('prompt').focus();
}
async function resumeActiveSession() {
  if (state.sessionId) rememberDraft();
  const active = stored('pforge.activeSession', null, sessionStorage);
  if (!active?.project || !active.id) return false;
  // A reconnect may start from an already populated composer before the
  // in-memory session has been recovered. Save that draft under its saved
  // session identity before switching away from the old DOM.
  if (!state.sessionId && active.path && $('followup-prompt').value) saveStored('pforge.draft.' + active.path, $('followup-prompt').value, sessionStorage);
  setProject({ path: active.project, name: shortPath(active.project) });
  try {
    const data = await api('/api/sessions/' + active.id);
    adoptSessionView({ ...data, sessionFile: data.sessionFile || active.path }); restoreDraft(); connect(data.id); showChat(); renderProjects();
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
  resizeComposerInputs();
});
$('followup-form').addEventListener('submit', async (event) => { event.preventDefault(); if (await handleCommandSubmit($('followup-prompt'))) return; const prompt = $('followup-prompt').value; if (!prompt.trim() && !state.attachments.length) { await resumeExecution(); return; } if (await sendFollowup(prompt)) { $('followup-prompt').value = ''; rememberDraft(); renderComposerControl(); } });
['prompt', 'followup-prompt'].forEach((id) => $(id).addEventListener('input', () => { rememberDraft(); renderComposerControl(); state.commandIndex = 0; updateCommandPicker($(id)); }));
window.addEventListener('pagehide', rememberDraft);
window.addEventListener('resize', () => resizeComposerInputs());
window.visualViewport?.addEventListener('resize', () => resizeComposerInputs(true));
if (window.ResizeObserver) {
  const composerObserver = new ResizeObserver(() => resizeComposerInputs());
  ['prompt', 'followup-prompt'].forEach((id) => composerObserver.observe($(id)));
}
document.fonts?.ready.then(() => resizeComposerInputs(true));
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
document.querySelectorAll('.suggestion').forEach((button) => button.addEventListener('click', () => { $('prompt').value = button.textContent; rememberDraft(); $('prompt').focus(); }));
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
$('folder-use').addEventListener('click', async () => {
  if (!state.folderPath || !canChangeProject(state.folderPath)) return;
  setBusy($('folder-use'), true, '打开中…'); $('folder-error').textContent = '';
  try { const result = await api('/api/projects', { method: 'POST', body: JSON.stringify({ kind: 'external', path: state.folderPath }) }); await chooseProject(result.project); }
  catch (error) { $('folder-error').textContent = error.message; } finally { setBusy($('folder-use'), false); }
});
$('folder-auto').addEventListener('click', () => void chooseProject(null));
$('folder-browse').addEventListener('click', () => { $('folder-external').classList.remove('hidden'); void openFolder(); });
$('folder-location-form').addEventListener('submit', (event) => { event.preventDefault(); void openFolder($('folder-location').value.trim()); });
$('folder-recent').addEventListener('click', (event) => { const button = event.target.closest('[data-use-project]'); if (button) void chooseProject(state.projects.find((project) => samePath(project.path, button.dataset.useProject))); });
$('managed-project-form').addEventListener('submit', async (event) => {
  event.preventDefault(); setBusy($('create-managed-project'), true, '创建中…'); $('folder-error').textContent = '';
  try { const result = await api('/api/projects', { method: 'POST', body: JSON.stringify({ kind: 'managed', name: $('managed-project-name').value.trim() || '新项目', requestId: newRequestId() }) }); await chooseProject(result.project); }
  catch (error) { $('folder-error').textContent = error.message; } finally { setBusy($('create-managed-project'), false); }
});
$('settings-button').addEventListener('click', () => openSettings());
$('manage-skills').addEventListener('click', () => openSettings('skills'));
$('setup-model-button').addEventListener('click', () => openSettings('provider'));
$('drawer-close').addEventListener('click', closeSettings);
$('drawer-backdrop').addEventListener('click', closeSettings);
$('project-list').addEventListener('click', (event) => {
  const projectMenu = event.target.closest('[data-project-menu]');
  if (projectMenu) { openProjectMenu(projectMenu.dataset.projectMenu, projectMenu); return; }
  const projectNew = event.target.closest('[data-project-new]');
  if (projectNew) {
    const path = projectNew.dataset.projectNew;
    if (navigationLocked()) return;
    const project = state.projects.find((item) => samePath(item.path, path)) || { path, name: shortPath(path) };
    setProject(project); void loadTrust(path); state.expandedProjects.add(path); saveStored('pforge.expandedProjects', [...state.expandedProjects]); void newConversation(true);
    return;
  }
  const more = event.target.closest('[data-session-menu]');
  if (more) { openSessionMenu(findHistory(more.dataset.sessionMenu), more); return; }
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
$('project-list').addEventListener('contextmenu', (event) => {
  const projectRow = event.target.closest('.project-row');
  if (projectRow) { event.preventDefault(); const more = projectRow.querySelector('[data-project-menu]'); openProjectMenu(more.dataset.projectMenu, more); return; }
  const row = event.target.closest('.session-row'); if (!row) return;
  event.preventDefault(); const more = row.querySelector('[data-session-menu]'); openSessionMenu(findHistory(more.dataset.sessionMenu), more);
});
$('history-filter').addEventListener('change', (event) => { closeSessionMenu(); state.historyFilter = event.target.value; renderProjects(); });
$('conversation-menu-button').addEventListener('click', (event) => openSessionMenu(currentHistory(), event.currentTarget));
$('session-menu').addEventListener('click', (event) => {
  if (event.target.closest('[data-project-action="remove"]')) { void removeProject(state.sessionMenu?.target); return; }
  const button = event.target.closest('[data-history-action]'), target = state.sessionMenu?.target;
  if (!button || !target) return;
  if (button.dataset.historyAction === 'rename') openRename(target);
  else if (button.dataset.historyAction === 'export-markdown') void exportSession(target, 'markdown');
  else if (button.dataset.historyAction === 'export-json') void exportSession(target, 'json');
  else void mutateHistory(button.dataset.historyAction, target);
});
$('session-menu').addEventListener('keydown', (event) => {
  const buttons = [...$('session-menu').querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length].focus(); }
  if (event.key === 'Tab') closeSessionMenu();
});
$('restore-conversation').addEventListener('click', () => void mutateHistory('restore', currentHistory()));
$('fork-origin').addEventListener('click', () => { if (state.forkOrigin) void openSession(state.forkOrigin.sourcePath, state.project.path); });
$('timeline').addEventListener('click', (event) => { const button = event.target.closest('[data-fork-entry]'); if (button) void forkConversation(button.dataset.forkEntry); });
$('new-chat-button').addEventListener('click', newConversation);
$('brand-button').addEventListener('click', newConversation);
$('stop-button').addEventListener('click', () => void stopExecution());
$('resume-task-button').addEventListener('click', () => void resumeExecution());
$('edit-retry-button').addEventListener('click', () => { if (state.lastUserEntryId) void forkConversation(state.lastUserEntryId); });
$('toggle-changes').addEventListener('click', () => toggleChanges(!state.changes.open));
$('subagents-button').addEventListener('click', () => {
  const open = $('subagent-menu').classList.contains('hidden');
  $('subagent-menu').classList.toggle('hidden', !open); $('subagents-button').setAttribute('aria-expanded', String(open));
  if (open) { positionSubagents(); $('subagent-list').querySelector('button')?.focus(); }
});
$('subagent-list').addEventListener('click', (event) => { const row = event.target.closest('[data-subagent-open]'); if (row) void openSubagent(row.dataset.subagentOpen); });
$('subagent-menu').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSubagentMenu(true); return; }
  const rows = [...$('subagent-list').querySelectorAll('button')], index = rows.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length]?.focus(); }
});
$('subagent-close').addEventListener('click', () => closeSubagent(true));
$('subagent-backdrop').addEventListener('click', () => closeSubagent(true));
$('subagent-refresh').addEventListener('click', () => { void loadSubagent(); });
$('subagent-stop').addEventListener('click', async () => {
  const sessionId = state.sessionId, id = state.subagentSelected, button = $('subagent-stop'); if (!id) return;
  setBusy(button, true);
  try { const data = await api('/api/sessions/' + sessionId + '/subagents', { method: 'POST', body: JSON.stringify({ action: 'stop', id }) }); if (state.sessionId === sessionId) renderSubagents(data.agents); }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});
$('subagent-panel').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !changesMedia?.matches) return;
  const nodes = [...$('subagent-panel').querySelectorAll('button:not(:disabled),[tabindex="0"]')].filter((node) => !node.classList.contains('hidden'));
  if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
  else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
});
document.addEventListener('pointerdown', (event) => { if (!$('subagent-menu').contains(event.target) && !$('subagents-button').contains(event.target)) closeSubagentMenu(); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('subagent-menu').classList.contains('hidden')) { event.preventDefault(); event.stopImmediatePropagation(); closeSubagentMenu(true); }
  else if (state.subagentSelected && !state.uiRequest && $('drawer').classList.contains('hidden')) { event.preventDefault(); event.stopImmediatePropagation(); closeSubagent(true); }
});
window.addEventListener('resize', positionSubagents);
changesMedia?.addEventListener('change', syncSubagentLayout);
$('changes-close').addEventListener('click', () => toggleChanges(false, true));
$('changes-backdrop').addEventListener('click', () => toggleChanges(false, true));
$('refresh-changes').addEventListener('click', () => {
  if (state.changes.reviewView === 'files') void loadProjectFiles();
  else if (state.changes.reviewView === 'changes') void loadChanges(true);
  else if (state.changes.reviewView === 'execution') void loadExecutionTimeline();
  else toast('终端输出会在执行后更新', 'info');
});
$('changes-tabs').addEventListener('click', (event) => { const button = event.target.closest('[data-review-view]'); if (button) setReviewView(button.dataset.reviewView); });
$('changes-files').addEventListener('click', (event) => { const button = event.target.closest('[data-change-path]'); if (button) void loadChangeDiff(button.dataset.changePath); });
$('review-file-search').addEventListener('input', () => { if (state.changes.open && state.changes.reviewView === 'files') void loadProjectFiles(); });
$('refresh-project-files').addEventListener('click', () => void loadProjectFiles());
$('review-file-list').addEventListener('click', (event) => { const button = event.target.closest('[data-project-file-path]'); if (button) void loadProjectFile(button.dataset.projectFilePath); });
$('review-terminal-form').addEventListener('submit', (event) => { event.preventDefault(); void runReviewTerminal(); });
$('changes-panel').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !changesMedia?.matches || !state.changes.open) return;
  const focusable = [...$('changes-panel').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((node) => !node.closest('.hidden')), first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
changesMedia?.addEventListener('change', syncChangesLayout);
$('name-cancel').addEventListener('click', () => { $('name-modal').classList.add('hidden'); state.renameTarget = null; });
$('name-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const name = $('session-name').value.trim(), target = state.renameTarget;
  if (!name || !target || historyLocked()) return;
  const button = $('name-save'); state.historyBusy = true; setBusy(button, true, '保存中…'); $('name-cancel').disabled = true; setRunning(state.running);
  try {
    const live = target.id === state.sessionId;
    await api(live ? '/api/sessions/' + target.id + '/name' : '/api/history', { method: 'POST', body: JSON.stringify(live ? { name } : { path: target.path, action: 'rename', name }) });
    if (target.path ? samePath(target.path, state.sessionPath) : target.id === state.sessionId) { $('run-title').textContent = name; $('run-title').title = name; }
    $('name-modal').classList.add('hidden'); state.renameTarget = null; await loadProjects();
  } catch (error) { $('name-error').textContent = error.message; }
  finally { state.historyBusy = false; setBusy(button, false); $('name-cancel').disabled = false; setRunning(state.running); }
});
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
  if (state.sessionMenu && !$('session-menu').contains(event.target) && !state.sessionMenu.anchor.contains(event.target)) closeSessionMenu();
  if (state.commandInput && !$('command-picker').contains(event.target) && event.target !== state.commandInput && !event.target.closest('.composer-command-button')) closeCommandPicker();
  if (state.contextAnchor && !$('context-panel').contains(event.target) && !event.target.closest('.context-button')) closeContext();
});
document.addEventListener('focusin', (event) => {
  if (state.commandInput && !$('command-picker').contains(event.target) && event.target !== state.commandInput && !event.target.closest('.composer-command-button')) closeCommandPicker();
  if (state.contextAnchor && !$('context-panel').contains(event.target) && !event.target.closest('.context-button')) closeContext();
});
const positionComposerPopovers = () => { positionCommandPicker(); if (state.contextAnchor) positionPicker($('context-panel'), state.contextAnchor, 350); positionSessionMenu(); };
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
$('tasks-button').addEventListener('click', openTasks);
$('delivery-recheck').addEventListener('click', () => { if (state.task?.id) void taskAction(state.task.id, 'recheck'); });
$('delivery-open-files').addEventListener('click', () => { state.changes.reviewView = 'files'; toggleChanges(true); });
$('delivery-card').addEventListener('click', (event) => { const button = event.target.closest('[data-open-artifact]'); if (button) openArtifactFile(button.dataset.openArtifact); });
$('open-execution').addEventListener('click', () => { state.changes.reviewView = 'execution'; toggleChanges(true); });
$('task-evidence').addEventListener('toggle', () => { if ($('task-evidence').open && state.changes.open && state.changes.reviewView === 'execution') void loadExecutionTimeline(); });
$('tasks-close').addEventListener('click', closeTasks);
$('queue-task-form').addEventListener('submit', enqueueComposedTask);
$('queue-list').addEventListener('click', async (event) => {
  const retry = event.target.closest('[data-retry-job]');
  if (retry) {
    if (!confirm('重新排队会创建一次新执行，并先检查当前项目状态。继续？')) return;
    retry.disabled = true;
    try { await api('/api/jobs/' + encodeURIComponent(retry.dataset.retryJob) + '/retry', { method: 'POST', body: '{}' }); await loadTasks(); }
    catch (error) { toast(error.message, 'error'); retry.disabled = false; } return;
  }
  const cancel = event.target.closest('[data-cancel-job]');
  if (cancel) { try { await api('/api/jobs/' + encodeURIComponent(cancel.dataset.cancelJob) + '/cancel', { method: 'POST', body: '{}' }); await loadTasks(); } catch (error) { toast(error.message, 'error'); } return; }
  const open = event.target.closest('[data-open-job]'), job = state.jobs?.find((item) => item.id === open?.dataset.openJob);
  if (job) { closeTasks(); await openSession(job.sessionFile, job.project); }
});
$('checkpoint-panel').addEventListener('toggle', () => { if ($('checkpoint-panel').open) void lifecycle.loadCheckpoints($('checkpoint-panel')); });
$('tasks-scope').addEventListener('change', (event) => { state.taskScope = event.target.value === 'all' ? 'all' : 'project'; void loadTasks(); });
$('tasks-list').addEventListener('click', async (event) => {
  const action = event.target.closest('[data-task-action]');
  if (action) { await taskAction(action.dataset.taskId, action.dataset.taskAction); return; }
  const open = event.target.closest('[data-open-task]'); const task = state.tasks.find((item) => item.id === open?.dataset.openTask);
  if (!task || navigationLocked()) return;
  state.loadingSession = true; setRunning(state.running);
  try { setProject({ path: task.project, name: shortPath(task.project) }); await createSession(task.sessionFile, '任务会话', true); closeTasks(); toggleSidebar(false); }
  catch (error) { toast(error.message, 'error'); }
  finally { state.loadingSession = false; setRunning(state.running); }
});
$('file-picker-close').addEventListener('click', closeFilePicker);
$('file-options').addEventListener('click', (event) => { const option = event.target.closest('[data-file-path]'); if (option) addFileAttachment(option.dataset.filePath); });
$('file-search').addEventListener('input', () => { void renderFileOptions($('file-search').value); });
document.querySelectorAll('[data-file-picker]').forEach((button) => button.addEventListener('click', () => openFilePicker(button.dataset.filePicker)));
document.querySelectorAll('[data-upload-picker]').forEach((button) => button.addEventListener('click', () => $(button.dataset.uploadPicker + '-upload-input').click()));
['prompt', 'followup'].forEach((name) => {
  $(name + '-upload-input').addEventListener('change', async (event) => { try { await addLocalAttachments(event.target.files); } finally { event.target.value = ''; } });
  const form = $(name === 'prompt' ? 'composer' : 'followup-form');
  let dragDepth = 0;
  form.addEventListener('dragenter', (event) => { if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return; event.preventDefault(); dragDepth++; if (!historyLocked()) form.classList.add('drag-over'); });
  form.addEventListener('dragover', (event) => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = historyLocked() ? 'none' : 'copy'; } });
  form.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; form.classList.remove('drag-over'); } });
  form.addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; form.classList.remove('drag-over'); void addLocalAttachments(event.dataTransfer?.files); });
  $(name === 'prompt' ? 'prompt' : 'followup-prompt').addEventListener('paste', (event) => {
    const images = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
    if (images.length) { event.preventDefault(); void addLocalAttachments(images); }
  });
});
// Keep a file dropped outside the composer from navigating away and losing the draft.
document.addEventListener('dragover', (event) => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
document.addEventListener('drop', (event) => { if (event.dataTransfer?.files?.length) event.preventDefault(); });
document.querySelectorAll('.attachment-tray').forEach((tray) => tray.addEventListener('click', (event) => { const button = event.target.closest('[data-remove-attachment]'); if (button) removeAttachment(Number(button.dataset.removeAttachment)); }));
$('history-search-button').addEventListener('click', () => { $('history-search').classList.toggle('hidden'); $('history-query').focus(); });
$('history-search-close').addEventListener('click', () => { $('history-query').value = ''; state.historyQuery = ''; $('history-search').classList.add('hidden'); renderProjects(); });
$('history-query').addEventListener('input', (event) => { state.historyQuery = event.target.value; renderProjects(); });
$('mobile-menu').addEventListener('click', () => toggleSidebar(!$('sidebar').classList.contains('mobile-open')));
$('sidebar-backdrop').addEventListener('click', () => toggleSidebar(false));
document.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; if (state.sessionMenu) { event.preventDefault(); closeSessionMenu(true); return; } if (!$('name-modal').classList.contains('hidden')) { event.preventDefault(); if (!state.historyBusy) $('name-cancel').click(); return; } if (state.commandInput) { event.preventDefault(); closeCommandPicker(); return; } if (state.contextAnchor) { event.preventDefault(); closeContext(true); return; } if (!$('help-modal').classList.contains('hidden')) { $('help-close').click(); return; } if (state.modePickerAnchor) { event.preventDefault(); closeModePicker(true); return; } if (state.pickerAnchor) { event.preventDefault(); closeModelPicker(true); return; } if (!$('file-picker').classList.contains('hidden')) { event.preventDefault(); closeFilePicker(); return; } if (!$('tasks-panel').classList.contains('hidden')) { event.preventDefault(); closeTasks(); return; } if (state.uiRequest) submitUi(true); else if (state.changes.open && ['name-modal', 'folder-modal', 'drawer'].every((id) => $(id).classList.contains('hidden'))) { event.preventDefault(); toggleChanges(false, true); } else { $('name-modal').classList.add('hidden'); $('folder-modal').classList.add('hidden'); closeSettings(); toggleSidebar(false); } });
setRunning(false);
loadConfig().then((connected) => { if (connected) return resumeActiveSession(); });
