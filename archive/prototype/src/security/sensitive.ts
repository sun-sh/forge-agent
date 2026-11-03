import { basename } from "node:path";

const SENSITIVE_NAMES = new Set([
  ".env", ".env.local", ".env.development", ".env.production", ".env.test",
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".htpasswd",
  "credentials.json", "auth.json", "secrets.json", "id_rsa", "id_ed25519", "id_ecdsa"
]);
const SENSITIVE_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];

export function isSensitiveFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (SENSITIVE_NAMES.has(name)) return true;
  if (SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return /(?:^|[-_.])(?:secret|credential|private[_-]?key|access[_-]?token)s?(?:[-_.]|$)/i.test(name);
}

export function assertNotSensitive(path: string): void {
  if (isSensitiveFile(path)) throw new Error(`Refusing access to a sensitive credential file: ${path}`);
}
