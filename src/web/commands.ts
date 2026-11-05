import type { AgentSession } from '@earendil-works/pi-coding-agent';

export interface WebRuntimeCommand {
  name: string;
  description: string;
  source: 'extension' | 'template' | 'skill';
  argumentHint?: string;
}

/** Discovery only. Pi retains command resolution, resource trust and execution. */
export function runtimeCommands(session: AgentSession): WebRuntimeCommand[] {
  const commands: WebRuntimeCommand[] = [];
  const names = new Set<string>();
  const add = (command: WebRuntimeCommand) => {
    if (!/^[a-zA-Z][\w:.-]{0,199}$/.test(command.name) || names.has(command.name)) return;
    names.add(command.name);
    commands.push({ ...command, description: command.description.slice(0, 500) });
  };
  for (const command of session.extensionRunner.getRegisteredCommands()) add({ name: command.invocationName, description: command.description ?? '扩展命令', source: 'extension' });
  if (session.settingsManager.getEnableSkillCommands()) {
    for (const skill of session.resourceLoader.getSkills().skills) add({ name: 'skill:' + skill.name, description: skill.description, source: 'skill' });
  }
  for (const template of session.promptTemplates) add({ name: template.name, description: template.description, source: 'template', argumentHint: template.argumentHint });
  return commands;
}

export function isRuntimeCommand(session: AgentSession, message: string): boolean {
  // Pi dispatches the command name at the first ASCII space, not at any whitespace.
  const name = /^\/([^\s]+)(?: |$)/.exec(message)?.[1];
  return !!name && runtimeCommands(session).some((command) => command.name === name);
}
