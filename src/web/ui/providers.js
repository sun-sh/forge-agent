// The form keeps unsaved credentials only in its password input, never browser storage.
export async function mountCustomProviders(root, { api, esc, setBusy, onSaved, initialProvider, initialModel }) {
  const document = root.ownerDocument;
  root.innerHTML = '<section class="settings-block"><div class="settings-heading" id="custom-provider-overview"><div><h3>第三方服务</h3><p>连接中转 API、私有部署或本机模型。</p></div><button class="button primary small" id="add-custom-provider">＋ 添加服务</button></div><div id="custom-provider-list" class="provider-list"><p>正在读取…</p></div><div id="custom-provider-editor" class="hidden"></div></section>';
  const find = (id) => root.querySelector('#' + id);
  let providers = [], loadingError = false;
  const renderList = () => {
    find('custom-provider-list').innerHTML = providers.map((provider) => '<div class="custom-provider-row"><div><strong>' + esc(provider.name) + '</strong><small>' + esc(provider.baseUrl || provider.id) + '</small><span>' + provider.models.length + ' 个模型 · ' + (provider.noKey ? '本地免密钥' : provider.authConfigured ? '已配置凭据' : '待配置凭据') + '</span></div><div class="custom-provider-actions"><button class="button quiet small" data-edit-custom="' + esc(provider.id) + '" ' + (provider.editable ? '' : 'disabled title="此高级配置请在 models.json 中管理"') + '>编辑</button><button class="button quiet small danger" data-delete-custom="' + esc(provider.id) + '" ' + (provider.editable ? '' : 'disabled title="此高级配置请在 models.json 中管理"') + '>删除</button></div></div>').join('') || '<div class="provider-empty">添加一个服务，选择它提供的模型，即可开始对话。</div>';
  };
  try { providers = (await api('/api/providers/custom')).providers || []; renderList(); }
  catch (error) { loadingError = true; find('custom-provider-list').textContent = error.message; find('custom-provider-list').classList.add('form-error'); }
  find('add-custom-provider').disabled = loadingError;
  const openEditor = (provider) => {
    let models = (provider?.models || []).map((model) => ({ ...model })), operation = false;
    const editor = find('custom-provider-editor');
    find('custom-provider-list').classList.add('hidden'); find('custom-provider-overview').classList.add('hidden');
    editor.classList.remove('hidden');
    editor.innerHTML = '<form id="custom-provider-form" class="provider-form">' +
      '<div class="settings-heading"><h3>' + (provider ? '编辑服务' : '添加第三方服务') + '</h3><button type="button" class="button quiet small" id="cancel-custom-provider">取消</button></div>' +
      '<label>服务名称<input id="custom-name" required maxlength="200" placeholder="例如：我的中转服务" autocomplete="off"></label>' +
      '<label>接口协议<select id="custom-api"><option value="openai-completions">OpenAI 兼容 · Chat Completions</option><option value="openai-responses">OpenAI 兼容 · Responses</option><option value="anthropic-messages">Anthropic 兼容 · Messages</option></select></label>' +
      '<label>接口地址（Base URL）<input id="custom-url" type="url" required placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"></label><p id="custom-url-help"></p>' +
      '<label>API Key<span class="secret-input"><input id="custom-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="' + (provider?.authConfigured && !provider.noKey ? '已保存，留空保留现有 Key' : '填写服务提供的 API Key') + '"><button type="button" class="button quiet small" id="toggle-custom-key" aria-label="显示 API Key" aria-pressed="false">显示</button></span></label>' +
      '<label class="check-label"><input id="custom-no-key" type="checkbox">无需 API Key（Ollama / LM Studio 等本机服务）</label>' +
      '<details class="provider-advanced"><summary>服务标识</summary><label>服务 ID<input id="custom-id" required pattern="[a-z0-9][a-z0-9_-]*" maxlength="80" autocomplete="off" spellcheck="false" ' + (provider ? 'readonly' : '') + '></label><p>用于区分连接，保存后保持固定。</p></details>' +
      (provider?.advanced ? '<p>此服务的高级请求参数会保留。改用其他地址时，请创建新服务。</p>' : '') +
      '<div class="provider-model-heading"><div><h3>可用模型</h3><p>获取列表后批量勾选，保存后在聊天框下方切换。</p></div><button type="button" class="button quiet small" id="discover-custom-models">获取模型</button></div>' +
      '<div class="hidden" id="custom-model-import"><details class="model-multiselect" id="model-multiselect"><summary aria-label="批量选择可用模型"><span id="model-multiselect-label">选择模型</span><span>⌄</span></summary><div class="multiselect-panel"><label class="sr-only" for="discovered-model-search">搜索服务返回的模型</label><input id="discovered-model-search" type="search" placeholder="搜索模型名称或 ID" autocomplete="off"><div class="multiselect-actions"><button type="button" id="select-filtered-models">全选当前结果</button><button type="button" id="clear-filtered-models">清空当前结果</button><span id="discovered-model-count" aria-live="polite"></span></div><div id="discovered-model-options" class="multiselect-options" role="group" aria-label="可用模型"></div><div class="multiselect-footer"><span id="discovered-selection-count" aria-live="polite"></span><button type="button" class="button primary small" id="apply-discovered-models">确认选择</button></div></div></details></div>' +
      '<div id="custom-model-rows" class="provider-models"></div><button type="button" class="button quiet small" id="add-custom-model">＋ 手动添加模型</button>' +
      '<div class="provider-save-bar"><div class="provider-feedback" id="custom-feedback" role="status" aria-live="polite"></div>' +
      '<label>调用测试<select id="custom-test-profile"><option value="text">流式文本</option><option value="coding">编码兼容：文本、工具调用与结果回传</option></select></label><div class="provider-form-actions"><button type="button" class="button quiet" id="test-custom-provider">测试模型调用</button><button type="submit" class="button primary" id="save-custom-provider">保存服务</button></div><p>测试可能产生少量 API 费用；编码兼容测试最多发送三次请求，不执行项目工具。</p></div></form>';
    find('custom-name').value = provider?.name || '';
    find('custom-id').value = provider?.id || 'custom-' + Math.random().toString(36).slice(2, 10);
    find('custom-api').value = provider?.api || 'openai-completions';
    find('custom-url').value = provider?.baseUrl || '';
    find('custom-no-key').checked = provider?.noKey || false;
    let discovered = [], selected = new Set();
    const feedback = (message, error = false) => { find('custom-feedback').textContent = message; find('custom-feedback').classList.toggle('form-error', error); };
    const renderUrlHelp = () => { const anthropic = find('custom-api').value === 'anthropic-messages'; find('custom-url').placeholder = anthropic ? 'https://api.example.com' : 'https://api.example.com/v1'; find('custom-url-help').textContent = anthropic ? '填写服务根地址，程序会追加 /v1/messages。' : '通常以 /v1 结尾，无需附加 /chat/completions 或 /responses。'; };
    const invalidate = () => { feedback(''); discovered = []; find('custom-model-import').classList.add('hidden'); };
    const toggleKey = () => { const disabled = find('custom-no-key').checked; find('custom-key').disabled = disabled; find('toggle-custom-key').disabled = disabled; if (disabled) find('custom-key').value = ''; invalidate(); };
    const readModels = () => {
      models = [...editor.querySelectorAll('[data-custom-model]')].map((row, index) => {
        const previous = models[index] || {};
        const model = {
          ...previous,
          id: row.querySelector('[data-field="id"]').value.trim(), name: row.querySelector('[data-field="name"]').value.trim(),
          contextWindow: Number(row.querySelector('[data-field="contextWindow"]').value), maxTokens: Number(row.querySelector('[data-field="maxTokens"]').value),
          reasoning: row.querySelector('[data-field="reasoning"]').value === 'true', input: row.querySelector('[data-field="vision"]').checked ? ['text', 'image'] : ['text']
        };
        if (model.reasoning) {
          const map = { ...previous.thinkingLevelMap };
          row.querySelectorAll('[data-effort]').forEach((input) => {
            const level = input.dataset.effort;
            if (!input.checked) map[level] = null;
            else if (typeof map[level] !== 'string') {
              if (level === 'xhigh' || level === 'max') map[level] = level;
              else delete map[level];
            }
          });
          model.thinkingLevelMap = map;
        }
        return model;
      });
      return models;
    };
    const renderModels = () => {
      const levels = { off: '关闭', minimal: '轻量', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };
      find('custom-model-rows').innerHTML = models.map((model, index) => {
        const templates = model.capabilityTemplates || [];
        const efforts = Object.entries(levels).map(([level, label], order) => {
          const mapped = model.thinkingLevelMap?.[level];
          const checked = mapped !== null && (order < 5 || mapped !== undefined);
          return '<label class="check-label"><input type="checkbox" data-effort="' + level + '" ' + (checked ? 'checked' : '') + '>' + label + '</label>';
        }).join('');
        return '<details class="provider-model" data-custom-model="' + index + '" ' + (!model.id || model.id === initialModel ? 'open' : '') + '><summary class="provider-model-title"><strong>' + esc(model.name || model.id || '填写模型 ID') + '</strong><span class="model-capability-badge">' + (model.reasoning ? '推理已启用' : '推理未启用') + '</span><button type="button" class="text-button" data-delete-custom-model="' + index + '" aria-label="移除模型 ' + (index + 1) + '">移除</button></summary><div class="provider-model-fields"><label>模型 ID<input data-field="id" required maxlength="300" spellcheck="false" placeholder="服务中的完整模型 ID" value="' + esc(model.id || '') + '"></label>' +
          (templates.length ? '<label class="capability-template">参考内置模型目录<select data-field="capabilityTemplate"><option value="">选择同名模型的能力模板…</option>' + templates.map((template, templateIndex) => '<option value="' + templateIndex + '">' + esc(template.sourceName) + (template.reasoning ? ' · 支持推理' : ' · 文本模型') + '</option>').join('') + '</select></label><p>按完整模型 ID 和协议匹配。服务可能有差异，导入后可调整。</p>' : '') +
          '<div class="provider-reasoning"><label>推理能力<select data-field="reasoning"><option value="false" ' + (!model.reasoning ? 'selected' : '') + '>未启用</option><option value="true" ' + (model.reasoning ? 'selected' : '') + '>支持推理 · 允许选择强度</option></select></label><fieldset class="provider-efforts ' + (model.reasoning ? '' : 'hidden') + '"><legend>服务支持的推理档位</legend>' + efforts + '</fieldset><p>开启后，聊天框的模型菜单可选择强度。仅勾选服务实际支持的档位。</p></div>' +
          '<details class="provider-advanced"><summary>显示名称与其他能力</summary><label>显示名称<input data-field="name" maxlength="200" placeholder="默认与模型 ID 相同" value="' + esc(model.name || '') + '"></label><div class="provider-model-limits"><label>上下文长度<input data-field="contextWindow" type="number" required min="1" max="100000000" value="' + esc(model.contextWindow ?? 128000) + '"></label><label>最大输出<input data-field="maxTokens" type="number" required min="1" max="100000000" value="' + esc(model.maxTokens ?? 16384) + '"></label></div><label class="check-label"><input data-field="vision" type="checkbox" ' + (model.input?.includes('image') ? 'checked' : '') + '>支持图像输入</label></details></div></details>';
      }).join('');
    };
    const matches = () => {
      const query = find('discovered-model-search').value.trim().toLowerCase();
      return discovered.filter((model) => (model.id + ' ' + (model.name || '')).toLowerCase().includes(query));
    };
    const selectionCount = () => { find('discovered-selection-count').textContent = '已勾选 ' + selected.size + ' 个'; };
    const renderOptions = () => {
      const filtered = matches();
      find('discovered-model-options').innerHTML = filtered.map((model) => '<label class="multiselect-option"><input type="checkbox" data-discovered-id="' + esc(model.id) + '" ' + (selected.has(model.id) ? 'checked' : '') + '><span><strong>' + esc(model.name || model.id) + '</strong><small>' + esc(model.id) + '</small></span></label>').join('') || '<p class="multiselect-empty">没有匹配的模型</p>';
      find('discovered-model-count').textContent = filtered.length + ' / ' + discovered.length;
      find('select-filtered-models').disabled = !filtered.length;
      find('clear-filtered-models').disabled = !filtered.length;
      selectionCount();
    };
    const picker = find('model-multiselect');
    picker.ontoggle = () => {
      if (!picker.open) return;
      readModels(); selected = new Set(models.filter((model) => discovered.some((item) => item.id === model.id)).map((model) => model.id));
      find('discovered-model-search').value = ''; renderOptions(); find('discovered-model-search').focus({ preventScroll: true });
      picker.scrollIntoView?.({ block: 'nearest' });
    };
    picker.onkeydown = (event) => { if (event.key === 'Escape') { event.stopPropagation(); picker.open = false; picker.querySelector('summary').focus(); } };
    editor.addEventListener('click', (event) => { if (picker.open && !picker.contains(event.target)) picker.open = false; });
    find('discovered-model-search').oninput = renderOptions;
    find('discovered-model-options').onchange = (event) => {
      const id = event.target.dataset.discoveredId;
      if (!id) return;
      event.target.checked ? selected.add(id) : selected.delete(id); selectionCount();
    };
    find('select-filtered-models').onclick = () => { matches().forEach((model) => selected.add(model.id)); renderOptions(); };
    find('clear-filtered-models').onclick = () => { matches().forEach((model) => selected.delete(model.id)); renderOptions(); };
    find('apply-discovered-models').onclick = () => {
      readModels();
      const existing = new Map(models.filter((model) => model.id).map((model) => [model.id, model]));
      const discoveredIds = new Set(discovered.map((model) => model.id));
      const manualCount = models.filter((model) => model.id && !discoveredIds.has(model.id)).length;
      if (manualCount + selected.size > 200) { feedback('一个服务最多配置 200 个模型，请减少勾选数量。', true); return; }
      models = models.filter((model) => model.id && (!discoveredIds.has(model.id) || selected.has(model.id)));
      for (const item of discovered) if (selected.has(item.id) && !existing.has(item.id)) models.push({ ...item });
      renderModels(); picker.open = false;
      find('model-multiselect-label').textContent = '已选择 ' + selected.size + ' / ' + discovered.length + ' 个模型';
      feedback('已更新模型列表，保存服务后生效。');
      picker.querySelector('summary').focus();
    };
    const connection = () => ({ id: find('custom-id').value.trim(), name: find('custom-name').value.trim(), api: find('custom-api').value, baseUrl: find('custom-url').value.trim(), apiKey: find('custom-key').value.trim(), noKey: find('custom-no-key').checked, ...(provider ? { revision: provider.revision } : {}) });
    const payload = () => ({ ...connection(), models: readModels().map(({ capabilityTemplates, ...model }) => { if (!model.name) delete model.name; return model; }) });
    const run = async (button, label, work) => {
      if (operation) return;
      operation = true; feedback(''); setBusy(button, true, label);
      const inputs = [...editor.querySelectorAll('input, select, button')];
      const disabled = inputs.map((input) => input.disabled);
      inputs.forEach((input) => { input.disabled = true; });
      try { await work(); } catch (error) { feedback(error.message, true); }
      finally { inputs.forEach((input, index) => { input.disabled = disabled[index]; }); setBusy(button, false); operation = false; }
    };
    const close = () => { editor.innerHTML = ''; editor.classList.add('hidden'); find('custom-provider-list').classList.remove('hidden'); find('custom-provider-overview').classList.remove('hidden'); };
    find('cancel-custom-provider').onclick = close;
    find('custom-api').onchange = () => { renderUrlHelp(); invalidate(); };
    ['custom-url', 'custom-key', 'custom-id'].forEach((id) => { find(id).oninput = invalidate; });
    find('custom-no-key').onchange = toggleKey;
    find('toggle-custom-key').onclick = () => { const show = find('custom-key').type === 'password'; find('custom-key').type = show ? 'text' : 'password'; find('toggle-custom-key').textContent = show ? '隐藏' : '显示'; find('toggle-custom-key').setAttribute('aria-pressed', String(show)); };
    find('add-custom-model').onclick = () => { readModels(); models.push({ id: '' }); renderModels(); find('custom-model-rows').lastElementChild.querySelector('input').focus(); };
    find('custom-model-rows').onclick = (event) => { const button = event.target.closest('[data-delete-custom-model]'); if (button) { event.preventDefault(); readModels(); models.splice(Number(button.dataset.deleteCustomModel), 1); renderModels(); } };
    find('custom-model-rows').onchange = (event) => {
      const row = event.target.closest('[data-custom-model]'); if (!row) return;
      if (event.target.dataset.field === 'reasoning') {
        const enabled = event.target.value === 'true';
        row.querySelector('.provider-efforts').classList.toggle('hidden', !enabled);
        row.querySelector('.model-capability-badge').textContent = enabled ? '推理已启用' : '推理未启用';
      }
      if (event.target.dataset.field === 'capabilityTemplate' && event.target.value !== '') {
        const index = Number(row.dataset.customModel), template = models[index]?.capabilityTemplates?.[Number(event.target.value)];
        if (!template || row.querySelector('[data-field="id"]').value.trim() !== models[index].id) { feedback('模型 ID 已变化，请重新获取模型列表后选择模板。', true); return; }
        readModels();
        models[index] = { ...models[index], reasoning: template.reasoning, thinkingLevelMap: template.thinkingLevelMap, input: template.input, contextWindow: template.contextWindow, maxTokens: template.maxTokens };
        renderModels(); find('custom-model-rows').children[index].open = true;
        feedback('已导入 ' + template.sourceName + ' 的同名模型能力，保存后生效。');
      }
    };
    find('discover-custom-models').onclick = () => run(find('discover-custom-models'), '获取中…', async () => {
      const result = await api('/api/providers/discover', { method: 'POST', body: JSON.stringify(connection()) });
      discovered = result.models || [];
      find('custom-model-import').classList.toggle('hidden', !discovered.length);
      find('model-multiselect-label').textContent = '从 ' + discovered.length + ' 个模型中选择';
      renderOptions();
      feedback('已获取 ' + discovered.length + ' 个模型，可展开批量选择；尚未测试推理。');
    });
    find('test-custom-provider').onclick = () => run(find('test-custom-provider'), '测试中…', async () => {
      const input = payload(); if (!input.models[0]?.id) throw new Error('请先添加模型 ID');
      const result = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ ...input, model: input.models[0], capabilities: find('custom-test-profile').value === 'coding' }) });
      const labels = { 'streaming-text': '流式文本', 'tool-call': '工具调用', 'tool-result': '工具结果回传' };
      feedback((result.codingCompatible === false ? '编码兼容检查未通过' : '调用成功') + ' · ' + result.model + ' · ' + result.latencyMs + ' ms · ' + (result.checks || []).map((check) => (labels[check.name] || check.name) + '：' + (check.status === 'passed' ? '通过' : check.status === 'skipped' ? '未执行' : '失败')).join('；') + '（测试第一个模型，尚未保存）', result.codingCompatible === false);
    });
    find('custom-provider-form').onsubmit = (event) => {
      event.preventDefault();
      // Capture before disabling fields so submission also works for keyboard users.
      const input = payload();
      return run(find('save-custom-provider'), '保存中…', async () => {
        if (!input.models.length) throw new Error('请至少添加一个模型');
        await api('/api/providers/custom', { method: 'POST', body: JSON.stringify(input) });
        find('custom-key').value = '';
        await onSaved();
      });
    };
    if (!models.length) models.push({ id: '' });
    renderModels(); renderUrlHelp(); toggleKey(); find('custom-name').focus();
  };
  find('add-custom-provider').onclick = () => openEditor();
  find('custom-provider-list').onclick = (event) => { const button = event.target.closest('[data-edit-custom]'); const provider = providers.find((item) => item.id === button?.dataset.editCustom); if (provider?.editable) openEditor(provider); };
  find('custom-provider-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-custom]');
    const provider = providers.find((item) => item.id === button?.dataset.deleteCustom);
    if (!provider?.editable || !button) return;
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm('删除“' + provider.name + '”及其本机保存的凭据？已有会话会变为只读。')) return;
    setBusy(button, true, '删除中…');
    try {
      const result = await api('/api/providers/custom/' + encodeURIComponent(provider.id), { method: 'DELETE', body: JSON.stringify({ revision: provider.revision }) });
      await onSaved('deleted', result.diagnostic);
      if (result.diagnostic && root.isConnected) { const feedback = document.createElement('p'); feedback.className = 'form-error'; feedback.setAttribute('role', 'alert'); feedback.textContent = result.diagnostic; root.prepend(feedback); }
    }
    catch (error) { const feedback = find('custom-feedback') || find('custom-provider-list'); feedback.textContent = error.message; feedback.classList.add('form-error'); }
    finally { setBusy(button, false); }
  });
  const initial = providers.find((provider) => provider.id === initialProvider);
  if (initial?.editable) openEditor(initial);
}
