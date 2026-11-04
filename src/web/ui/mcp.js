const EXPOSURES = { codemode: 'Codemode · 脚本调用', deferred: 'Deferred · 按需搜索', direct: 'Direct · 直接提供', hidden: 'Hidden · 隐藏工具' };
const STATUS = { connected: '连接成功', failed: '连接失败', 'needs-auth': '需要授权', timeout: '连接超时' };

export function mountMcp(root, { api, esc, initial, projectPath, onChanged = () => {}, runtimeEnabled = false, isVisible = () => true }) {
  let snapshot = initial, scope = 'all', editing = null, operation = false;
  let runtime = { sessions: [] }, disposed = false, liveTimer, authTimer, livePending = false, authJob = initial.authorizations?.find((job) => ['starting', 'waiting'].includes(job.state)), authPopup, openedAuthUrl;
  const browser = root.ownerDocument.defaultView;
  const find = (id) => root.querySelector('#' + id);
  const field = (name) => root.querySelector('[name="' + name + '"]');
  const note = (message, error = false) => {
    const node = find('mcp-feedback');
    if (node) { node.textContent = message; node.classList.toggle('form-error', error); }
  };
  const list = () => {
    editing = null; imported = {};
    const servers = snapshot.servers || [];
    root.innerHTML = '<section class="settings-block mcp-section"><div class="settings-heading"><div><h3>MCP 服务</h3><p>连接外部工具与数据，让 Agent 在项目中使用。</p></div><button type="button" class="button primary small" data-action="add">＋ 添加</button></div>' +
      '<div class="mcp-summary"><label class="sr-only" for="mcp-scope-filter">配置范围</label><select id="mcp-scope-filter"><option value="all">所有范围</option><option value="global">全局</option><option value="project">当前项目</option></select><button type="button" class="button quiet small" data-action="refresh">刷新</button></div><p class="mcp-project">' + esc(projectPath) + '</p>' +
      (!snapshot.projectTrusted ? '<p class="mcp-trust warn">当前项目尚未信任，项目级 MCP 不会加载。可在“项目”设置中管理信任。</p>' : '') +
      (snapshot.errors?.length ? '<div class="mcp-errors">' + snapshot.errors.map((error) => '<div>' + esc(error) + '</div>').join('') + '</div>' : '') +
      '<div id="mcp-auth"></div><div id="mcp-live"></div><p class="provider-feedback" id="mcp-feedback" role="status" aria-live="polite"></p><div class="mcp-list">' +
      servers.filter((server) => scope === 'all' || server.scope === scope).map((server) => {
        const config = server.config, probe = server.probe;
        const label = !server.effective ? server.inactiveReason === 'conflict' ? '命名冲突 · 未加载' : server.scope === 'project' ? '未信任 · 未加载' : '已被项目覆盖' : config.enabled === false ? '已禁用' : '已启用';
        return '<article class="mcp-card" data-server="' + servers.indexOf(server) + '"><div class="mcp-card-head"><div class="mcp-card-title"><span class="mcp-kind">' + (config.type === 'http' ? 'HTTP' : 'STDIO') + '</span><strong>' + esc(server.name) + '</strong><small>' + (server.scope === 'project' ? server.override ? '项目覆盖' : '当前项目' : '全局') + ' · ' + esc((config.exposure || 'codemode').toUpperCase()) + '</small></div><span class="mcp-enabled ' + (config.enabled === false || !server.effective ? 'off' : '') + '">' + label + '</span></div>' +
          '<div class="mcp-card-meta" title="' + esc(config.url || config.command || '') + '">' + esc(config.url || [config.command, ...(config.args || [])].join(' ')) + '</div>' +
          (config.description ? '<p>' + esc(config.description) + '</p>' : '') +
          '<div class="mcp-card-state"><span class="mcp-status ' + (probe?.status === 'connected' ? 'good' : probe ? 'warn' : '') + '">' + (probe ? esc(STATUS[probe.status]) : '尚未测试') + '</span>' + (probe ? '<span>' + probe.tools.length + ' 个工具 · ' + probe.latencyMs + ' ms</span>' : '') + '</div>' +
          (probe?.message ? '<p class="mcp-probe-message">' + esc(probe.message) + '</p>' : '') +
          (probe?.tools.length ? '<details class="mcp-tools"><summary>查看工具（' + probe.tools.length + '）</summary>' + probe.tools.map((tool) => '<div class="mcp-tool-item"><strong>' + esc(tool.name) + '</strong><small>' + esc(tool.description) + '</small></div>').join('') + '</details>' : '') +
          '<div class="mcp-card-actions"><button type="button" class="button quiet small" data-action="test" ' + (!server.effective ? 'disabled' : '') + '>测试连接</button><button type="button" class="button quiet small" data-action="tools">工具设置</button>' +
          (config.type === 'http' && !config.auth && !(config.headers || []).some((row) => row.key.toLowerCase() === 'authorization') ? '<button type="button" class="button quiet small" data-action="login" ' + (!server.effective || config.enabled === false ? 'disabled' : '') + '>登录授权</button><button type="button" class="button quiet small" data-action="logout" ' + (!server.effective || config.enabled === false ? 'disabled' : '') + '>退出授权</button>' : '') +
          '<button type="button" class="button quiet small" data-action="edit">编辑</button><button type="button" class="button quiet small" data-action="toggle">' + (config.enabled === false ? '启用' : '禁用') + '</button><button type="button" class="text-button" data-action="delete">删除</button></div></article>';
      }).join('') + (!servers.some((server) => scope === 'all' || server.scope === scope) ? '<div class="mcp-empty"><strong>添加你的第一个 MCP 服务</strong><p>支持本机 stdio 与 Streamable HTTP。也可以导入其他客户端的 mcpServers JSON。</p></div>' : '') +
      '</div><p class="settings-note">状态来自最近一次独立连接测试，不代表所有会话的实时状态。保存后会自动重新加载空闲会话。</p></section>';
    find('mcp-scope-filter').value = scope;
    renderRuntime(); renderAuth();
  };
  const LIVE_STATUS = { connected: '已连接', connecting: '连接中', starting: '启动中', disabled: '已禁用', disconnected: '已断开', 'needs-auth': '需要授权', failed: '连接失败', closed: '已关闭' };
  const renderRuntime = () => {
    const target = find('mcp-live'); if (!target || !runtimeEnabled) return;
    target.innerHTML = '<details class="mcp-live-panel"><summary>会话连接状态 · ' + runtime.sessions.length + ' 个会话</summary><p>每 3 秒读取当前项目会话的实际状态；独立测试结果显示在服务卡片中。</p>' +
      (!runtime.sessions.length ? '<p>开始会话后，这里会显示它实际加载的 MCP 服务。</p>' : runtime.sessions.map((session) => '<section class="mcp-live-session"><strong>' + esc(session.title) + '</strong><small>' + esc(session.mode.toUpperCase()) + (session.running ? ' · 运行中' : '') + '</small><p>' + (session.checkedAt ? '最近读取 ' + esc(new Date(session.checkedAt).toLocaleTimeString()) : '尚未完成读取') + (session.refreshing ? ' · 更新中' : '') + '</p>' +
        (!session.supported ? '<p>当前会话未加载内置 MCP，或暂时只读。</p>' : !session.servers.length ? '<p>' + (session.refreshing ? '正在读取 Pi 连接状态…' : '此会话未加载 MCP 服务。') + '</p>' : session.servers.map((server) => '<div class="mcp-live-row"><span>' + esc(server.name) + '</span><span class="' + (server.state === 'connected' ? 'good' : 'warn') + '">' + esc(LIVE_STATUS[server.state] || server.state) + (server.state === 'connected' ? ' · ' + server.toolCount + ' 个工具' : '') + '</span>' +
          '<button type="button" class="text-button" data-action="reconnect" data-session-id="' + esc(session.id) + '" data-server-name="' + esc(server.name) + '" ' + (session.running || server.state === 'disabled' ? 'disabled' : '') + '>重连</button></div>').join('')) + '</section>').join('')) + '</details>';
  };
  const pollRuntime = async () => {
    if (disposed || !runtimeEnabled) return;
    browser.clearTimeout(liveTimer);
    if (isVisible() && !livePending && !editing && !operation) {
      livePending = true;
      try { const result = await api('/api/mcp/runtime?project=' + encodeURIComponent(projectPath)); if (!disposed) { runtime = { sessions: result.sessions || [] }; const open = find('mcp-live')?.querySelector('details')?.open; renderRuntime(); if (open) find('mcp-live')?.querySelector('details')?.setAttribute('open', ''); } }
      catch { /* The next poll retries; connection errors are already shown by the app. */ }
      finally { livePending = false; }
    }
    if (!disposed) liveTimer = browser.setTimeout(pollRuntime, 3000);
  };
  const safeAuthUrl = (value) => {
    try { const url = new URL(value); return !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ? url.href : ''; } catch { return ''; }
  };
  const renderAuth = () => {
    const target = find('mcp-auth'); if (!target) return;
    if (!authJob) { target.innerHTML = ''; return; }
    const signature = JSON.stringify([authJob.id, authJob.state, authJob.authorizationUrl, authJob.message]);
    if (target.dataset.signature === signature) return;
    target.dataset.signature = signature;
    const active = ['starting', 'waiting'].includes(authJob.state), url = safeAuthUrl(authJob.authorizationUrl);
    target.innerHTML = '<section class="mcp-auth-panel" aria-live="polite"><strong>' + esc(authJob.name) + ' · ' + (active ? authJob.action === 'logout' ? '正在移除本机授权' : '等待浏览器授权' : authJob.state === 'succeeded' ? '操作完成' : '授权已结束') + '</strong><p>' + esc(authJob.message || (authJob.action === 'logout' ? '正在更新本机凭据与会话。' : '在授权页面批准访问，完成后这里会自动更新。五分钟内有效。')) + '</p>' +
      (url ? '<a class="button quiet small" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">打开授权页面</a>' : '') +
      (active ? authJob.action === 'logout' ? '' : '<button type="button" class="text-button" data-action="cancel-auth">取消授权</button><details><summary>无法自动返回？</summary><label>粘贴浏览器跳转后的完整 URL<input id="mcp-auth-redirect" type="url" autocomplete="off" spellcheck="false"></label><button type="button" class="button quiet small" data-action="auth-redirect">提交回调</button></details>' : '<button type="button" class="text-button" data-action="dismiss-auth">关闭</button>') + '</section>';
  };
  const pollAuth = async () => {
    if (disposed || !authJob || !['starting', 'waiting'].includes(authJob.state)) return;
    browser.clearTimeout(authTimer);
    try {
      authJob = await api('/api/mcp/auth/' + authJob.id);
      if (disposed) return;
      const url = safeAuthUrl(authJob.authorizationUrl);
      if (url && authPopup && !authPopup.closed && openedAuthUrl !== url) { authPopup.location.replace(url); openedAuthUrl = url; }
      // Keep a manually pasted callback intact while polling.
      const draft = find('mcp-auth-redirect')?.value, expanded = find('mcp-auth')?.querySelector('details')?.open;
      renderAuth();
      if (draft && find('mcp-auth-redirect')) find('mcp-auth-redirect').value = draft;
      if (expanded) find('mcp-auth')?.querySelector('details')?.setAttribute('open', '');
      if (!['starting', 'waiting'].includes(authJob.state)) {
        authPopup?.close(); authPopup = null;
        if (authJob.state === 'succeeded') {
          if (editing) { snapshot = await api('/api/mcp?project=' + encodeURIComponent(projectPath)); await onChanged(snapshot); }
          else await refresh();
          note('授权已更新，当前草稿保留；空闲会话正在刷新，运行中的会话在本轮结束后更新。');
        }
        return;
      }
    } catch (error) { note(error.message, true); }
    if (!disposed) authTimer = browser.setTimeout(pollAuth, 1000);
  };
  const exposureOptions = (selected = '') => '<option value="">继承服务 / 匹配规则</option>' + Object.entries(EXPOSURES).map(([value, label]) => '<option value="' + value + '" ' + (selected === value ? 'selected' : '') + '>' + label + '</option>').join('');
  const toolRow = (name, exposure = '', description = '', editable = false) => '<div class="mcp-tool-rule"><div>' + (editable ? '<input data-tool-name value="' + esc(name) + '" aria-label="工具名或匹配规则" placeholder="工具名或 *write*">' : '<strong data-tool-name="' + esc(name) + '">' + esc(name) + '</strong>') + (description ? '<small>' + esc(description) + '</small>' : '') + '</div><select data-tool-exposure aria-label="' + esc(name || '新规则') + ' 的暴露方式">' + exposureOptions(exposure) + '</select></div>';
  const toolsEditor = (server) => {
    editing = server;
    const tools = new Map();
    for (const tool of [...(server.probe?.tools || []), ...runtime.sessions.flatMap((session) => session.tools || []).filter((tool) => tool.server === server.name)]) if (tool.rawName) tools.set(tool.rawName, tool);
    const rules = server.config.toolExposure || {};
    root.innerHTML = '<section class="settings-block"><div class="settings-heading"><h3>' + esc(server.name) + ' · 工具设置</h3><button type="button" class="button quiet small" data-action="cancel">返回</button></div><p class="settings-note">选择工具如何提供给 Agent。隐藏后不能调用；Plan / Ask 仍会阻止所有 MCP 工具。未单独设置时继承服务或匹配规则。</p>' +
      '<form id="mcp-tools-form"><div id="mcp-tool-rules">' + [...tools].map(([name, tool]) => toolRow(name, rules[name] || '', tool.description)).join('') + Object.entries(rules).filter(([name]) => !tools.has(name)).map(([name, value]) => toolRow(name, value)).join('') + '</div>' +
      (!tools.size ? '<p class="settings-note">尚无工具目录。可返回测试连接后再选择，或直接添加工具名 / 通配规则。</p>' : '') + '<button type="button" class="text-button" data-action="add-tool-rule">＋ 添加规则</button><p class="provider-feedback" id="mcp-feedback" role="status"></p><button type="submit" class="button primary" data-action="save-tools">保存工具设置</button></form></section>';
  };
  const input = (name, label, value = '', extra = '') => '<label>' + label + '<input name="' + name + '" value="' + esc(value) + '" ' + extra + '></label>';
  const mapRow = (key = '') => '<div class="mcp-map-row"><input data-key value="' + esc(key) + '" placeholder="名称" aria-label="变量或 Header 名称" autocomplete="off" spellcheck="false" ' + (key ? 'readonly' : '') + '><input data-value type="password" placeholder="' + (key ? '已保存，留空保留' : '填写值或环境变量引用') + '" aria-label="值" autocomplete="new-password" spellcheck="false"><button type="button" class="text-button" data-action="remove-row" aria-label="移除这一行">移除</button></div>';
  const mapEditor = (name, label, rows = []) => '<div class="mcp-map" data-map="' + name + '"><div class="mcp-map-head"><span>' + label + '</span><button type="button" class="text-button" data-action="add-row" data-map-name="' + name + '">＋ 添加</button></div><div data-map-rows>' + rows.map((row) => mapRow(row.key)).join('') + '</div><p>值只保存在本机；已有值留空保留，移除整行后删除。</p></div>';
  const editor = (server = null) => {
    editing = server || {}; imported = {};
    const config = server?.config || {}, override = Boolean(server?.override);
    root.innerHTML = '<section class="settings-block"><div class="settings-heading"><h3>' + (server ? '编辑 MCP 服务' : '添加 MCP 服务') + '</h3><button type="button" class="button quiet small" data-action="cancel">返回</button></div>' +
      '<form id="mcp-form" class="mcp-form" autocomplete="off"><div class="mcp-form-grid"><label>配置范围<select name="scope" ' + (server ? 'disabled' : '') + '><option value="global">全局</option><option value="project">当前项目</option></select></label><label>传输方式<select name="transport" ' + (server ? 'disabled' : '') + '><option value="stdio">本机 STDIO</option><option value="http">Streamable HTTP</option></select></label></div>' +
      input('name', '服务名称', server?.name || '', 'required maxlength="80" pattern="[A-Za-z0-9_-]+" spellcheck="false" ' + (server ? 'readonly' : '')) +
      '<label class="check-label" id="mcp-override-label"><input type="checkbox" name="override" ' + (override ? 'checked disabled' : '') + '>只覆盖同名全局服务的启用状态与工具暴露</label>' +
      '<fieldset data-transport="stdio"><legend class="sr-only">本机 STDIO 配置</legend>' + input('command', '启动命令', config.command || '', 'required placeholder="例如：npx" spellcheck="false"') +
      '<label>命令参数 · 每行一个<textarea name="args" rows="4" spellcheck="false" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;.">' + esc((config.args || []).join('\n')) + '</textarea></label>' +
      input('cwd', '工作目录（可选）', config.cwd || '', 'placeholder="默认使用当前项目" spellcheck="false"') + mapEditor('env', '环境变量', config.env) + '</fieldset>' +
      '<fieldset data-transport="http"><legend class="sr-only">HTTP 配置</legend>' + input('url', '服务 URL', config.url || '', 'required type="url" placeholder="https://example.com/mcp" spellcheck="false"') +
      mapEditor('headers', 'HTTP Headers', config.headers) +
      '<details class="mcp-advanced"><summary>OAuth 与 Provider 认证</summary><p>HTTP 服务无 Authorization Header 时由 Pi 自动探测 OAuth。</p>' +
      input('authProvider', 'Provider 凭据（仅全局）', config.auth?.provider || '', 'placeholder="可选，复用已登录 Provider"') +
      input('clientId', 'OAuth Client ID', config.oauth?.clientId || '') +
      input('clientSecret', 'OAuth Client Secret', '', 'type="password" autocomplete="new-password" placeholder="' + (config.oauth?.clientSecretConfigured ? '已保存，留空保留' : '可选') + '"') +
      (config.oauth?.clientSecretConfigured ? '<label class="check-label"><input type="checkbox" name="removeClientSecret">删除已保存的 Client Secret</label>' : '') +
      input('oauthScope', 'OAuth Scopes', config.oauth?.scope || '') + input('callbackPort', '固定回调端口（可选）', config.oauth?.callbackPort ?? '', 'type="number" min="1" max="65535"') +
      input('callbackUrl', '回调 URL（仅 localhost）', config.oauth?.callbackUrl || '') + input('clientName', 'OAuth Client Name', config.oauth?.clientName || '') +
      '<label>Client 注册方式<select name="clientRegistration"><option value="dcr">DCR · 动态注册</option><option value="cimd">CIMD · Pi 元数据文档</option></select></label>' +
      input('authServerMetadataUrl', '授权服务器 Metadata URL（可选）', config.oauth?.authServerMetadataUrl || '') + '</details></fieldset>' +
      '<div class="mcp-form-grid"><label>工具暴露<select name="exposure">' + Object.entries(EXPOSURES).map(([key, label]) => '<option value="' + key + '">' + label + '</option>').join('') + '</select></label>' +
      input('timeout', '请求超时（秒）', config.timeout ?? '', 'type="number" min="0.01" step="any" placeholder="60"') + '</div>' +
      input('description', '描述（可选）', config.description || '', 'maxlength="1000" placeholder="帮助 Agent 理解服务提供什么"') +
      '<label class="check-label"><input type="checkbox" name="enabled" ' + (config.enabled === false ? '' : 'checked') + '>启用服务</label>' +
      '<details class="mcp-advanced" id="mcp-import"><summary>从 JSON 导入配置</summary><p>支持 mcpServers 对象或单个服务配置；本次只导入选中的一个服务。</p><textarea id="mcp-import-json" rows="5" placeholder=\'{"mcpServers":{"docs":{"url":"https://example.com/mcp"}}}\'></textarea><label>服务<select id="mcp-import-server"></select></label><button type="button" class="button quiet small" data-action="read-import">读取 JSON</button><button type="button" class="button quiet small" data-action="apply-import" disabled>填入表单</button></details>' +
      '<p class="provider-feedback" id="mcp-feedback" role="status" aria-live="polite"></p><div class="mcp-editor-actions"><button type="button" class="button quiet" data-action="test-draft">测试当前配置</button><button type="submit" class="button primary" data-action="save">保存服务</button></div><p class="settings-note">项目级 MCP 需要项目信任。测试与会话加载会启动服务进程；独立测试结束后会关闭连接。修改连接目标时，需要重新填写凭据。</p></form></section>';
    field('scope').value = server?.scope || (scope === 'project' ? 'project' : 'global');
    field('transport').value = config.type || 'stdio';
    field('exposure').value = config.exposure || 'codemode';
    field('clientRegistration').value = config.oauth?.clientRegistration || 'dcr';
    if (server) find('mcp-import').remove();
    updateForm();
  };
  const updateForm = () => {
    const project = field('scope').value === 'project';
    find('mcp-override-label').classList.toggle('hidden', !project);
    if (!project) field('override').checked = false;
    const override = project && field('override').checked;
    root.querySelectorAll('[data-transport]').forEach((group) => { const hidden = override || group.dataset.transport !== field('transport').value; group.classList.toggle('hidden', hidden); group.disabled = hidden; });
    for (const name of ['description', 'timeout']) { field(name).disabled = override; field(name).closest('label').classList.toggle('hidden', override); }
    root.querySelector('[data-action="test-draft"]').disabled = override || (project && !snapshot.projectTrusted);
    field('authProvider').disabled = project;
  };
  const values = () => {
    const config = { enabled: field('enabled').checked, exposure: field('exposure').value };
    if (field('scope').value === 'project' && field('override').checked) return config;
    config.type = field('transport').value;
    const readMap = (name) => [...root.querySelectorAll('[data-map="' + name + '"] .mcp-map-row')].map((row) => ({ key: row.querySelector('[data-key]').value.trim(), value: row.querySelector('[data-value]').value })).filter((row) => row.key || row.value);
    if (config.type === 'stdio') {
      config.command = field('command').value.trim();
      config.args = field('args').value === '' ? [] : field('args').value.split(/\r?\n/);
      config.cwd = field('cwd').value.trim() || null; config.env = readMap('env');
    } else {
      config.url = field('url').value.trim(); config.headers = readMap('headers');
      config.auth = field('scope').value === 'global' && field('authProvider').value.trim() ? { provider: field('authProvider').value.trim() } : null;
      const oauth = {};
      for (const [name, key] of [['clientId', 'clientId'], ['clientSecret', 'clientSecret'], ['oauthScope', 'scope'], ['callbackUrl', 'callbackUrl'], ['clientName', 'clientName'], ['authServerMetadataUrl', 'authServerMetadataUrl']]) {
        const value = name === 'clientSecret' ? field(name).value : field(name).value.trim(); if (value) oauth[key] = value;
      }
      if (field('removeClientSecret')?.checked) oauth.clientSecret = null;
      if (field('callbackPort').value) oauth.callbackPort = Number(field('callbackPort').value);
      if (field('clientRegistration').value === 'cimd') oauth.clientRegistration = 'cimd';
      config.oauth = oauth;
    }
    config.description = field('description').value.trim() || null;
    config.timeout = field('timeout').value ? Number(field('timeout').value) : null;
    return config;
  };
  const refresh = async () => { snapshot = await api('/api/mcp?project=' + encodeURIComponent(projectPath)); await onChanged(snapshot); list(); };
  const payload = () => {
    const override = field('scope').value === 'project' && field('override').checked;
    const config = override ? values() : { ...editing?.extra, ...values() };
    if (config.type === 'stdio') { delete config.url; delete config.headers; delete config.oauth; delete config.auth; }
    if (config.type === 'http') { delete config.command; delete config.args; delete config.cwd; delete config.env; }
    return { project: projectPath, name: field('name').value.trim(), scope: field('scope').value, revision: editing?.revision, config, override };
  };
  const run = async (button, label, work) => {
    if (operation) return;
    operation = true; note('');
    const original = button.textContent;
    const controls = [...root.querySelectorAll('button, input, select, textarea')], disabled = controls.map((node) => node.disabled);
    controls.forEach((node) => { node.disabled = true; }); button.textContent = label;
    try { await work(); } catch (error) { note(error.message, true); }
    finally { controls.forEach((node, index) => { node.disabled = disabled[index]; }); button.textContent = original; operation = false; }
  };
  let imported = {};
  root.onchange = (event) => {
    if (['transport', 'scope', 'override'].includes(event.target.name)) updateForm();
    if (event.target.id === 'mcp-scope-filter') { scope = event.target.value; list(); }
  };
  root.onclick = (event) => {
    const button = event.target.closest('button[data-action]'); if (!button || operation) return;
    const action = button.dataset.action;
    if (action === 'add') { editor(); return; }
    if (action === 'cancel') { list(); return; }
    if (action === 'refresh') { void run(button, '刷新中…', refresh); return; }
    if (action === 'dismiss-auth') { authJob = null; renderAuth(); return; }
    if (action === 'cancel-auth') { void run(button, '取消中…', async () => { await api('/api/mcp/auth/' + authJob.id + '/cancel', { method: 'POST' }); await pollAuth(); }); return; }
    if (action === 'auth-redirect') { const url = find('mcp-auth-redirect').value.trim(); void run(button, '提交中…', async () => { await api('/api/mcp/auth/' + authJob.id + '/redirect', { method: 'POST', body: JSON.stringify({ url }) }); find('mcp-auth-redirect').value = ''; }); return; }
    if (action === 'reconnect') { void run(button, '重连中…', async () => { await api('/api/mcp/sessions/' + encodeURIComponent(button.dataset.sessionId) + '/servers/' + encodeURIComponent(button.dataset.serverName) + '/reconnect', { method: 'POST' }); browser.clearTimeout(liveTimer); await pollRuntime(); }); return; }
    if (action === 'add-tool-rule') { find('mcp-tool-rules').insertAdjacentHTML('beforeend', toolRow('', 'hidden', '', true)); return; }
    if (action === 'add-row') { root.querySelector('[data-map="' + button.dataset.mapName + '"] [data-map-rows]').insertAdjacentHTML('beforeend', mapRow()); return; }
    if (action === 'remove-row') { button.closest('.mcp-map-row').remove(); return; }
    if (action === 'read-import') {
      try {
        const parsed = JSON.parse(find('mcp-import-json').value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        imported = parsed.mcpServers || { imported: parsed };
        if (!imported || typeof imported !== 'object' || Array.isArray(imported) || !Object.keys(imported).length) throw new Error();
        find('mcp-import-server').innerHTML = Object.keys(imported).map((name) => '<option>' + esc(name) + '</option>').join('');
        root.querySelector('[data-action="apply-import"]').disabled = false; note('选择一个服务，再填入表单。');
      } catch { note('JSON 格式无效，请检查 mcpServers 对象。', true); } return;
    }
    if (action === 'apply-import') {
      const name = find('mcp-import-server').value, config = imported[name];
      if (!config || typeof config !== 'object' || Array.isArray(config)) { note('服务配置必须为对象。', true); return; }
      const targetScope = field('scope').value, original = structuredClone(config), safe = structuredClone(config);
      for (const key of ['env', 'headers']) if (safe[key] && !Array.isArray(safe[key])) safe[key] = Object.keys(safe[key]).map((key) => ({ key, configured: true }));
      editor({ name, scope: targetScope, config: { ...safe, type: config.url ? 'http' : 'stdio' } });
      editing = { extra: original };
      field('name').readOnly = false; field('scope').disabled = false; field('transport').disabled = false;
      for (const key of ['env', 'headers']) root.querySelectorAll('[data-map="' + key + '"] .mcp-map-row').forEach((row) => { row.querySelector('[data-value]').value = original[key]?.[row.querySelector('[data-key]').value] || ''; });
      if (original.oauth?.clientSecret) field('clientSecret').value = original.oauth.clientSecret;
      note('配置已填入，保存前可修改。'); return;
    }
    if (action === 'test-draft') {
      if (!find('mcp-form').reportValidity()) return;
      const input = payload();
      void run(button, '测试中…', async () => {
        const result = await api('/api/mcp/servers/' + encodeURIComponent(input.name) + '/test', { method: 'POST', body: JSON.stringify(input) });
        note(STATUS[result.status] + ' · ' + result.tools.length + ' 个工具' + (result.message ? '。' + result.message : '') + '（尚未保存）', result.status !== 'connected');
      }); return;
    }
    const card = button.closest('[data-server]'), server = snapshot.servers[Number(card?.dataset.server)];
    if (!card || !server) return;
    const base = '/api/mcp/servers/' + encodeURIComponent(server.name), item = { project: projectPath, scope: server.scope, revision: server.revision };
    if (action === 'tools') { toolsEditor(server); return; }
    if (action === 'login') {
      try { authPopup = browser.open('about:blank', '_blank'); if (authPopup) authPopup.opener = null; } catch { authPopup = null; }
      openedAuthUrl = undefined;
      void run(button, '准备授权…', async () => { try { authJob = await api(base + '/login', { method: 'POST', body: JSON.stringify(item) }); renderAuth(); browser.clearTimeout(authTimer); await pollAuth(); } catch (error) { authPopup?.close(); authPopup = null; throw error; } }); return;
    }
    if (action === 'logout') { card.querySelector('.mcp-card-actions').innerHTML = '<span>移除此服务的本机 OAuth 授权？</span><button type="button" class="button quiet small" data-action="confirm-logout">移除授权</button><button type="button" class="button quiet small" data-action="cancel-delete">取消</button>'; return; }
    if (action === 'confirm-logout') { void run(button, '移除中…', async () => { authJob = await api(base + '/logout', { method: 'POST', body: JSON.stringify(item) }); list(); browser.clearTimeout(authTimer); await pollAuth(); }); return; }
    if (action === 'edit') { editor(server); return; }
    if (action === 'delete') { card.querySelector('.mcp-card-actions').innerHTML = '<span>删除此配置？</span><button type="button" class="button quiet small" data-action="confirm-delete">删除</button><button type="button" class="button quiet small" data-action="cancel-delete">取消</button>'; return; }
    if (action === 'cancel-delete') { list(); return; }
    if (action === 'confirm-delete') { void run(button, '删除中…', async () => { await api(base + '?' + new URLSearchParams(item), { method: 'DELETE' }); await refresh(); note('配置已删除，空闲会话已重新加载。'); }); return; }
    if (action === 'toggle') { void run(button, '更新中…', async () => { await api(base + '/toggle', { method: 'POST', body: JSON.stringify({ ...item, enabled: server.config.enabled === false }) }); await refresh(); }); return; }
    if (action === 'test') { void run(button, '测试中…', async () => { await api(base + '/test', { method: 'POST', body: JSON.stringify(item) }); await refresh(); }); }
  };
  root.onsubmit = (event) => {
    if (event.target.id === 'mcp-tools-form') {
      event.preventDefault();
      const rules = Object.create(null);
      for (const row of root.querySelectorAll('.mcp-tool-rule')) {
        const name = row.querySelector('[data-tool-name]').dataset.toolName || row.querySelector('[data-tool-name]').value?.trim();
        if (!name || Object.hasOwn(rules, name)) { note('请填写不重复的工具名或匹配规则。', true); return; }
        rules[name] = row.querySelector('[data-tool-exposure]').value || null;
      }
      const server = editing;
      void run(root.querySelector('[data-action="save-tools"]'), '保存中…', async () => { await api('/api/mcp/servers/' + encodeURIComponent(server.name) + '/tools', { method: 'POST', body: JSON.stringify({ project: projectPath, scope: server.scope, revision: server.revision, changes: rules }) }); await refresh(); note('工具设置已保存，空闲会话已更新。'); }); return;
    }
    if (event.target.id !== 'mcp-form') return;
    event.preventDefault();
    if (!find('mcp-form').reportValidity()) return;
    const input = payload();
    void run(root.querySelector('[data-action="save"]'), '保存中…', async () => { await api('/api/mcp/servers', { method: 'POST', body: JSON.stringify(input) }); await refresh(); note('配置已保存，空闲会话已重新加载。'); });
  };
  list();
  if (runtimeEnabled) void pollRuntime();
  if (authJob) void pollAuth();
  return { dispose() { disposed = true; browser.clearTimeout(liveTimer); browser.clearTimeout(authTimer); }, refreshRuntime: pollRuntime };
}
