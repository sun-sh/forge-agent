export type RiskLevel = "low" | "medium" | "high";
export type CommandPolicyMode = "ask" | "auto" | "deny";

export interface CommandAssessment {
  risk: RiskLevel;
  reason: string;
  requiresApproval: boolean;
  denied: boolean;
  reasons: string[];
}

const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[^\s]*[rf][^\s]*\s+)+/i, "recursive or forced file deletion"],
  [/\b(?:remove-item|del|erase|rmdir)\b/i, "file deletion"],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s*\.|restore\s+\.)/i, "destructive Git operation"],
  [/\bgit\s+push\b.*(?:--force|-f\b)/i, "forced Git push"],
  [/\b(?:format|mkfs|diskpart|shutdown|reboot)\b/i, "system-level destructive operation"],
  [/\bdrop\s+(?:database|table|schema)\b/i, "destructive database operation"],
  [/\btruncate\s+table\b/i, "destructive database operation"],
  [/\bcurl\b[^|;\n]*\|\s*(?:sh|bash|zsh|powershell|pwsh)\b/i, "remote code execution through a pipe"],
  [/\b(?:wget|iwr|invoke-webrequest)\b[^|;\n]*\|\s*(?:sh|bash|zsh|powershell|pwsh)\b/i, "remote code execution through a pipe"],
  [/>\s*(?:\/dev\/sd|\/dev\/nvme|\\\\\.\\PhysicalDrive)/i, "raw disk write"]
];

const NETWORK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)\b/i, "network download"],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|update|upgrade)\b/i, "dependency download"],
  [/\bpip(?:3)?\s+install\b/i, "dependency download"],
  [/\b(?:cargo|go)\s+(?:install|get)\b/i, "dependency download"],
  [/\bgit\s+(?:clone|fetch|pull|push)\b/i, "network Git operation"],
  [/\bssh\b/i, "remote shell"],
  [/\bscp\b|\brsync\b/i, "remote file transfer"]
];

const PRIVILEGE_PATTERNS: Array<[RegExp, string]> = [
  [/\bsudo\b|\brunas\b|\bStart-Process\b.*-Verb\s+RunAs/i, "privilege escalation"],
  [/\bchmod\s+[ugoa]*\+[sx]|\bchown\b/i, "permission or ownership modification"],
  [/\bset-executionpolicy\b|\bnetsh\b|\breg(?:\.exe)?\s+add\b/i, "system configuration modification"],
  [/\b(?:docker|podman|kubectl)\b/i, "container or cluster operation"],
  [/\b(?:aws|gcloud|az)\b/i, "cloud control-plane operation"]
];

const SECRET_EXPOSURE: Array<[RegExp, string]> = [
  [/\b(?:printenv|env|set)\b/i, "environment dumping"],
  [/\b(?:cat|type|get-content)\b.*(?:\.env|credentials|auth\.json|\.pem|id_rsa|id_ed25519)/i, "credential file access"],
  [/\b(?:echo|write-output|printf)\b.*(?:API_KEY|TOKEN|SECRET|PASSWORD)/i, "secret output"]
];

const HIGH_RISK_SUBCOMMANDS = /\b(?:powershell|pwsh|cmd(?:\.exe)?|bash|sh|zsh|python|python3|node)\b\s+(?:-c|-Command|\/c)\b/i;

export function assessCommand(command: string, mode: CommandPolicyMode = "ask", networkPolicy: "ask" | "allow" | "deny" = "ask"): CommandAssessment {
  const reasons: string[] = [];
  let risk: RiskLevel = "low";
  const normalized = command.trim();
  if (!normalized) {
    return { risk: "high", reason: "Empty command", requiresApproval: true, denied: true, reasons: ["empty command"] };
  }
  if (normalized.length > 30_000) {
    return { risk: "high", reason: "Command is too large", requiresApproval: true, denied: true, reasons: ["command exceeds size limit"] };
  }
  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(normalized)) { risk = "high"; reasons.push(reason); }
  }
  for (const [pattern, reason] of PRIVILEGE_PATTERNS) {
    if (pattern.test(normalized)) { risk = "high"; reasons.push(reason); }
  }
  for (const [pattern, reason] of SECRET_EXPOSURE) {
    if (pattern.test(normalized)) { risk = risk === "high" ? "high" : "medium"; reasons.push(reason); }
  }
  for (const [pattern, reason] of NETWORK_PATTERNS) {
    if (pattern.test(normalized)) { risk = risk === "high" ? "high" : "medium"; reasons.push(reason); }
  }
  if (HIGH_RISK_SUBCOMMANDS.test(normalized)) {
    risk = risk === "high" ? "high" : "medium";
    reasons.push("inline code evaluation");
  }
  if (/[|;&]|\$\(|`/.test(normalized)) {
    if (risk === "low") risk = "medium";
    reasons.push("shell composition");
  }
  if (networkPolicy === "deny" && NETWORK_PATTERNS.some(([pattern]) => pattern.test(normalized))) {
    return { risk: "high", reason: "Network access is denied", requiresApproval: false, denied: true, reasons: [...reasons, "network policy denied"] };
  }
  if (risk === "high") {
    return { risk, reason: reasons.join("; "), requiresApproval: true, denied: mode === "deny", reasons };
  }
  if (risk === "medium") {
    return { risk, reason: reasons.join("; "), requiresApproval: mode !== "auto", denied: mode === "deny", reasons };
  }
  return { risk, reason: "routine workspace command", requiresApproval: false, denied: false, reasons };
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_KEY]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]");
}
