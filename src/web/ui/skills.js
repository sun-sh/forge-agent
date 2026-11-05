export function mountSkills(root, { api, esc, projectPath, onChanged = async () => {} }) {
  let snapshot, disposed = false, operation = false, query = '', scope = 'all', selected = null, sequence = 0;
  const find = (id) => root.querySelector('#' + id);
  const message = (text, error = false) => { const node = find('skills-feedback'); if (node) { node.textContent = text; node.classList.toggle('error', error); } };
  const scoped = (value) => value === 'project' ? '当前项目' : '全局';
  const status = (skill) => !skill.valid ? '格式异常' : !skill.enabled ? '已停用' : !skill.effective ? '同名覆盖' : skill.manualOnly ? '仅手动调用' : '可自动调用';
  root.innerHTML = '<section class="settings-block skills-section"><div class="settings-heading"><div><h3>技能</h3><p>管理 Agent 按需使用的工作流程与专门知识。</p></div><button type="button" class="button quiet small" data-skill-action="refresh">刷新</button></div>' +
    '<div class="skills-toolbar"><label class="sr-only" for="skills-search">搜索技能</label><input id="skills-search" type="search" placeholder="搜索名称、描述或来源" autocomplete="off"><label class="sr-only" for="skills-scope">筛选范围</label><select id="skills-scope"><option value="all">全部范围</option><option value="global">全局</option><option value="project">当前项目</option></select></div>' +
    '<p id="skills-summary" class="skills-summary" role="status">正在读取技能…</p><p id="skills-feedback" class="provider-feedback" role="status" aria-live="polite"></p>' +
    '<div id="skills-list" class="skills-list" aria-busy="true"></div><div id="skill-detail" class="hidden"></div>' +
    '<details class="skills-import" id="skills-import"><summary>添加本机技能</summary><form id="skills-source-form"><p>填写包含 SKILL.md 的目录，或已有的 Markdown 技能文件路径。</p><label>本机路径<input name="path" required spellcheck="false" autocomplete="off" placeholder="例如：C:\\my-skills"></label><label>使用范围<select name="scope"><option value="global">全局 · 所有项目</option><option value="project">仅当前项目</option></select></label><button type="submit" class="button primary small" data-skill-action="import">导入技能</button></form></details>' +
    '<details class="skills-locations"><summary>技能目录与加载诊断</summary><div id="skills-locations"></div><div id="skills-diagnostics"></div></details></section>';

  const renderList = () => {
    if (!snapshot || disposed) return;
    const skills = snapshot.skills || [];
    const filtered = skills.filter((skill) => (scope === 'all' || skill.scope === scope) && [skill.name, skill.description, skill.source, skill.filePath].join(' ').toLowerCase().includes(query));
    find('skills-summary').textContent = skills.filter((skill) => skill.effective).length + ' 个可用 · ' + skills.length + ' 个已发现' + (query || scope !== 'all' ? ' · 筛选 ' + filtered.length + ' 个' : '') + (snapshot.projectTrusted ? '' : ' · 项目技能等待信任');
    find('skills-list').innerHTML = filtered.map((skill) => '<article class="skill-card' + (!skill.enabled ? ' disabled' : '') + '" data-skill-id="' + esc(skill.id) + '"><div class="skill-card-heading"><button type="button" class="skill-title" data-skill-action="detail" aria-expanded="' + (selected === skill.id) + '" aria-controls="skill-detail"><strong>' + esc(skill.name) + '</strong><span>' + scoped(skill.scope) + ' · ' + esc(skill.origin === 'package' ? '资源包' : skill.source === 'auto' ? '自动发现' : '本机导入') + '</span></button><button type="button" class="skill-switch" role="switch" aria-checked="' + skill.enabled + '" aria-label="' + esc((skill.enabled ? '停用' : '启用') + '技能 ' + skill.name) + '" data-skill-action="toggle" ' + (operation || !skill.valid || skill.scope === 'project' && !snapshot.projectTrusted ? 'disabled' : '') + '><span></span></button></div><p>' + esc(skill.description) + '</p><div class="skill-card-footer"><span class="skill-state' + (!skill.effective ? ' muted' : '') + '">' + status(skill) + '</span><button type="button" class="text-button" data-skill-action="detail">查看内容</button></div></article>').join('') || '<div class="skills-empty"><strong>' + (skills.length ? '没有匹配的技能' : '还没有可用技能') + '</strong><p>' + (skills.length ? '试试其他名称或范围。' : '可导入本机已有技能，或放入下方的自动发现目录。') + '</p></div>';
    find('skills-list').setAttribute('aria-busy', 'false');
    const projectOption = root.querySelector('#skills-source-form [value="project"]');
    projectOption.disabled = !snapshot.projectTrusted;
    const directories = [['全局技能', snapshot.paths?.global], ['当前项目', snapshot.paths?.project], ['共享技能', snapshot.paths?.shared]];
    find('skills-locations').innerHTML = directories.filter(([, path]) => path).map(([label, path]) => '<div class="skill-location"><span>' + label + '</span><code>' + esc(path) + '</code></div>').join('') +
      (snapshot.sources?.length ? '<h4>额外导入</h4>' + snapshot.sources.map((source) => '<div class="skill-source" data-skill-source="' + esc(source.id) + '" data-skill-scope="' + source.scope + '"><div><span>' + scoped(source.scope) + '</span><code>' + esc(source.path) + '</code></div><button type="button" class="text-button" data-skill-action="remove-source">移除引用</button></div>').join('') + '<p>移除引用会停止从此路径发现技能，本机文件会保留。自动发现目录中的技能可用上方开关停用。</p>' : '');
    find('skills-diagnostics').innerHTML = (snapshot.diagnostics || []).length ? '<h4>加载诊断</h4>' + snapshot.diagnostics.map((item) => '<div class="skill-diagnostic"><span>' + esc(item.message) + '</span>' + (item.path ? '<code>' + esc(item.path) + '</code>' : '') + '</div>').join('') : '<p>没有加载诊断。</p>';
  };

  const apply = async (next) => {
    if (disposed) return;
    snapshot = next; renderList();
    await onChanged(snapshot);
  };
  const run = async (work) => {
    if (disposed || operation) return;
    operation = true; message(''); root.setAttribute('aria-busy', 'true');
    const controls = [...root.querySelectorAll('button,input,select')], disabled = controls.map((node) => node.disabled);
    controls.forEach((node) => { node.disabled = true; });
    try { await work(); }
    catch (error) { if (!disposed) message(error.message, true); }
    finally {
      controls.forEach((node, index) => { if (node.isConnected) node.disabled = disabled[index]; });
      operation = false;
      if (!disposed) { root.setAttribute('aria-busy', 'false'); renderList(); }
    }
  };
  const mutate = async (action, input, success) => {
    const result = await api('/api/skills/' + action, { method: 'POST', body: JSON.stringify({ project: projectPath, revision: snapshot.revision, ...input }) });
    await apply(result.snapshot);
    if (!disposed) message(success);
  };
  const detail = async (id) => {
    const skill = snapshot?.skills.find((item) => item.id === id); if (!skill) return;
    selected = id; const request = ++sequence;
    const node = find('skill-detail'); node.classList.remove('hidden');
    node.innerHTML = '<div class="settings-heading"><div><h4>' + esc(skill.name) + '</h4><code>' + esc(skill.filePath) + '</code></div><button type="button" class="icon-button small" data-skill-action="close-detail" aria-label="关闭技能内容">×</button></div><p>' + status(skill) + ' · /skill:' + esc(skill.name) + '</p><pre tabindex="0" aria-label="技能内容">正在读取内容…</pre>';
    renderList();
    try {
      const result = await api('/api/skills/content?' + new URLSearchParams({ project: projectPath, id }));
      if (!disposed && request === sequence) node.querySelector('pre').textContent = result.content;
    } catch (error) { if (!disposed && request === sequence) node.querySelector('pre').textContent = '读取失败：' + error.message; }
    if (!disposed && request === sequence) node.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };
  root.oninput = (event) => { if (event.target.id === 'skills-search') { query = event.target.value.trim().toLowerCase(); renderList(); } };
  root.onchange = (event) => { if (event.target.id === 'skills-scope') { scope = event.target.value; renderList(); } };
  root.onclick = (event) => {
    const button = event.target.closest('button[data-skill-action]'); if (!button || operation || disposed) return;
    const action = button.dataset.skillAction;
    if (action === 'refresh') { void run(async () => { if (snapshot) await mutate('refresh', { scope: 'project' }, '技能已刷新，当前项目的空闲会话已更新。'); else await apply(await api('/api/skills?project=' + encodeURIComponent(projectPath))); }); return; }
    if (action === 'close-detail') { selected = null; ++sequence; find('skill-detail').classList.add('hidden'); renderList(); return; }
    const id = button.closest('[data-skill-id]')?.dataset.skillId;
    if (action === 'detail') { void detail(id); return; }
    if (action === 'toggle') { const skill = snapshot.skills.find((item) => item.id === id); void run(() => mutate('toggle', { id, enabled: !skill.enabled, scope: skill.scope }, skill.name + (skill.enabled ? ' 已停用。' : ' 已启用。') + '空闲会话已更新。')); return; }
    if (action === 'remove-source') {
      const source = button.closest('[data-skill-source]');
      void run(() => mutate('remove-source', { id: source.dataset.skillSource, scope: source.dataset.skillScope }, '已移除目录引用，本机文件已保留。')); return;
    }
  };
  root.onsubmit = (event) => {
    if (event.target.id !== 'skills-source-form') return;
    event.preventDefault(); if (!snapshot || operation) return;
    const form = event.target, path = form.elements.path.value.trim(), targetScope = form.elements.scope.value;
    if (!path) return;
    void run(async () => { await mutate('sources', { path, scope: targetScope }, '技能已导入，空闲会话已更新。'); if (!disposed) { form.elements.path.value = ''; find('skills-import').open = false; } });
  };
  void run(async () => { snapshot = await api('/api/skills?project=' + encodeURIComponent(projectPath)); renderList(); });
  return { dispose() { disposed = true; ++sequence; root.onclick = root.oninput = root.onchange = root.onsubmit = null; } };
}
