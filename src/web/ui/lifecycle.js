/** Review surfaces for host-owned filesystem changes; mutations always revalidate on the server. */
export function lifecycleUI({ api, esc, toast, currentSession, running, readOnly, changed }) {
  const requests = new WeakMap();
  const canMutate = (session) => { if (session !== currentSession() || running() || readOnly()) { toast('请在当前会话空闲且可编辑时操作', 'warning'); return false; } return true; };
  const selection = (container) => [...container.querySelectorAll('[data-checkpoint-file]:checked')].map((input) => input.value);
  const filesMarkup = (view) => view.files.map((file) => '<label class="checkpoint-file"><input type="checkbox" data-checkpoint-file value="' + esc(file.path) + '" ' + (file.eligible ? 'checked' : 'disabled') + '><button type="button" data-checkpoint-preview="' + esc(file.path) + '">' + esc(file.path) + '</button><small>' + (file.applied ? view.kind === 'proposal' ? '已应用' : '已撤销' : file.conflict ? '后续修改冲突' : file.operation === 'add' ? '新增' : file.operation === 'delete' ? '删除' : '修改') + '</small></label>').join('');
  function renderReview(container, view, { route, mutate, label, onChange, session, editable = true }) {
    container.innerHTML = '<p class="settings-note">' + esc(view.reason || (view.kind === 'proposal' ? '将所选修改应用到主项目，保留暂存区；应用后请运行验证。' : '恢复所选文件到此次执行前；原有未提交内容会保留。')) + (view.skipped ? ' · ' + view.skipped + ' 个敏感、链接或超限文件未纳入。' : '') + '</p>' + (view.diagnostic ? '<p role="alert">' + esc(view.diagnostic) + '</p>' : '') + '<div class="checkpoint-files">' + (filesMarkup(view) || '<p class="settings-note">没有可处理的文件变更。</p>') + '</div><button type="button" class="button quiet small" data-checkpoint-apply ' + (!view.files.some((file) => file.eligible) || running() || readOnly() ? 'disabled' : '') + '>' + label + '</button><p class="settings-note" data-checkpoint-feedback role="status"></p>';
    container.querySelectorAll('[data-checkpoint-preview]').forEach((button) => { button.onclick = async () => {
      try { const data = await api(route + '&path=' + encodeURIComponent(button.dataset.checkpointPreview)); const pre = container.ownerDocument.createElement('pre'); pre.className = 'checkpoint-diff'; pre.textContent = data.diff; container.querySelector('[data-checkpoint-feedback]').replaceChildren(pre); }
      catch (error) { container.querySelector('[data-checkpoint-feedback]').textContent = error.message; }
    }; });
    const apply = container.querySelector('[data-checkpoint-apply]');
    apply.disabled ||= !editable;
    apply.onclick = async () => {
      if (!editable || !canMutate(session)) return;
      const paths = selection(container);
      if (!paths.length) { toast('请先选择文件', 'warning'); return; }
      if (!container.ownerDocument.defaultView.confirm(label + ' ' + paths.length + ' 个文件？\n' + paths.slice(0, 10).join('\n'))) return;
      apply.disabled = true;
      try { await mutate(paths, view.revision); toast(label + '完成'); await onChange(); await changed(); }
      catch (error) { container.querySelector('[data-checkpoint-feedback]').textContent = error.message; apply.disabled = false; }
    };
  }
  async function loadCheckpoints(container, selectedId) {
    const session = currentSession(); if (!session) return;
    const request = (requests.get(container) || 0) + 1; requests.set(container, request);
    selectedId ||= container.dataset.selectedId;
    try {
      const data = await api('/api/sessions/' + session + '/checkpoints'); if (session !== currentSession() || requests.get(container) !== request) return;
      const views = data.checkpoints || [], view = views.find((item) => item.id === selectedId) || views[0];
      container.dataset.selectedId = view?.id || '';
      container.innerHTML = '<summary>执行检查点' + (views.length ? ' · ' + views.length : '') + '</summary><div class="checkpoint-body"><select aria-label="选择执行检查点">' + views.map((item) => '<option value="' + esc(item.id) + '" ' + (item.id === view?.id ? 'selected' : '') + '>' + esc(new Date(item.createdAt).toLocaleString() + ' · ' + item.label.slice(0, 55)) + '</option>').join('') + '</select><div data-checkpoint-review></div></div>';
      if (!view) { container.querySelector('[data-checkpoint-review]').textContent = '尚无可用检查点。检查点需要可信的 Git 仓库根目录。'; return; }
      container.querySelector('select').onchange = (event) => void loadCheckpoints(container, event.target.value);
      renderReview(container.querySelector('[data-checkpoint-review]'), view, { route: '/api/sessions/' + session + '/checkpoints?id=' + encodeURIComponent(view.id), label: '撤销所选修改',
        mutate: (paths, revision) => api('/api/sessions/' + session + '/checkpoints', { method: 'POST', body: JSON.stringify({ id: view.id, paths, revision }) }), session, onChange: () => loadCheckpoints(container, view.id) });
    } catch (error) { if (session === currentSession() && requests.get(container) === request) container.innerHTML = '<summary>执行检查点</summary><p class="settings-note">' + esc(error.message) + '</p>'; }
  }
  function proposal(container, view, session, childId, onChange, editable = true, removed = false) {
    if (!view) return;
    const document = container.ownerDocument;
    const section = document.createElement('details'); section.className = 'checkpoint-section'; section.open = true;
    const title = document.createElement('summary'); title.textContent = '独立 worktree 的变更'; const review = document.createElement('div'); section.append(title, review); container.prepend(section);
    renderReview(review, view, { route: '/api/sessions/' + session + '/subagents?agent=' + encodeURIComponent(childId), label: '应用所选变更',
      mutate: (paths, revision) => api('/api/sessions/' + session + '/subagents', { method: 'POST', body: JSON.stringify({ action: 'apply', id: childId, paths, revision }) }), session, editable, onChange });
    const discard = document.createElement('button'); discard.className = 'button quiet small'; discard.textContent = removed ? '工作目录已清理' : '清理独立工作目录'; discard.disabled = running() || readOnly() || removed;
    discard.onclick = async () => {
      if (removed || !canMutate(session)) return;
      if (!container.ownerDocument.defaultView.confirm('清理此子任务的独立 worktree？已封存的补丁和会话记录会保留。')) return;
      discard.disabled = true;
      try { await api('/api/sessions/' + session + '/subagents', { method: 'POST', body: JSON.stringify({ action: 'discard', id: childId }) }); toast('独立工作目录已清理'); await onChange(); }
      catch (error) { toast(error.message, 'error'); discard.disabled = false; }
    }; section.append(discard);
  }
  function candidates(container, items, onChange) {
    const session = currentSession();
    const pending = items.filter((item) => item.status === 'pending');
    container.innerHTML = '<div class="settings-heading"><h3>待审阅记忆' + (pending.length ? ' · ' + pending.length : '') + '</h3></div>' + (pending.length ? '' : '<p class="settings-note">模型提出的长期事实和偏好会在这里等待审阅，接受后才注入上下文。</p>') + pending.map((item) => '<article class="memory-candidate"><strong>' + (item.layer === 'project' ? '项目记忆' : '会话记忆') + (item.supersedes ? ' · 提议替换' : ' · 新增') + '</strong><p>' + esc(item.text) + '</p>' + (item.replaces ? '<p class="settings-note">原内容：' + esc(item.replaces) + '</p>' : '') + '<details><summary>来源说明（模型提出）</summary><p>' + esc(item.evidence) + '</p><small>' + esc(item.createdAt) + '</small></details>' + (item.duplicate ? '<p class="settings-note">已存在相同记忆，请拒绝重复候选。</p>' : item.stale ? '<p class="settings-note">记忆已变化，请核对当前内容后再接受。</p>' : '') + '<div class="memory-candidate-actions"><button type="button" class="button quiet small" data-memory-candidate="' + esc(item.id) + '" data-action="reject">拒绝</button><button type="button" class="button quiet small" data-memory-candidate="' + esc(item.id) + '" data-action="accept" ' + (item.duplicate ? 'disabled' : '') + '>接受</button></div></article>').join('');
    container.querySelectorAll('[data-memory-candidate]').forEach((button) => { button.onclick = async () => {
      if (session !== currentSession() || running()) { toast('请在当前会话空闲时审阅记忆', 'warning'); return; }
      const item = items.find((entry) => entry.id === button.dataset.memoryCandidate); button.disabled = true;
      try { await api('/api/memory/candidates', { method: 'POST', body: JSON.stringify({ session, id: item.id, action: button.dataset.action, revision: item.revision }) }); await onChange(); }
      catch (error) { toast(error.message, 'error'); button.disabled = false; }
    }; });
  }
  return { loadCheckpoints, proposal, candidates };
}
