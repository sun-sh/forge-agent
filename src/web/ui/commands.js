export const builtinCommands = [
  { name: 'new', title: '新建对话', description: '保留当前历史，开始新的对话', source: 'local' },
  { name: 'model', title: '切换模型', description: '选择模型与推理强度', source: 'local' },
  { name: 'mode', title: '工作模式', description: '选择 Agent、Plan 或 Ask', source: 'local' },
  { name: 'context', title: '上下文用量', description: '查看用量、容量与自动压缩状态', source: 'local' },
  { name: 'compact', title: '压缩上下文', description: '整理较早内容，可附加需要保留的重点', argumentHint: '[保留重点]', source: 'local' },
  { name: 'changes', title: '代码变更', description: '查看右侧文件差异', source: 'local' },
  { name: 'queue', title: '后台排队', description: '将文本任务加入持久化队列；不带参数时打开任务中心', argumentHint: '[任务内容]', source: 'local' },
  { name: 'rename', title: '重命名对话', description: '修改当前对话的名称', source: 'local' },
  { name: 'mcp', title: 'MCP 服务', description: '管理外部工具与连接', source: 'local' },
  { name: 'settings', title: '设置', description: '管理模型服务与项目配置', source: 'local' },
  { name: 'help', title: '命令与快捷键', description: '查看操作说明', source: 'local' }
];

// A leading filesystem path such as /src/app.ts is ordinary text, not a command.
export function parseCommand(text) {
  const match = /^\s*\/([a-zA-Z][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text);
  return match ? { name: match[1], args: (match[2] || '').trim() } : null;
}

export function filterCommands(commands, query = '') {
  const needle = query.toLowerCase().replace(/^\//, '');
  const exact = commands.filter((command) => command.name.toLowerCase() === needle);
  if (exact.length) return exact;
  return commands.filter((command) => (command.name + ' ' + (command.title || '') + ' ' + command.description + ' ' + (command.source === 'skill' ? '技能' : command.source === 'template' ? '模板' : '')).toLowerCase().includes(needle))
    .map((command, index) => ({ command, index }))
    .sort((a, b) => Number(b.command.name.toLowerCase() === needle) - Number(a.command.name.toLowerCase() === needle)
      || Number(b.command.name.toLowerCase().startsWith(needle)) - Number(a.command.name.toLowerCase().startsWith(needle))
      || a.index - b.index)
    .map((item) => item.command);
}
