import { describe, expect, it } from "vitest";
import { assessCommand, redactSecrets } from "../src/security/command-policy.js";

describe("command policy", () => {
  it("allows routine test commands", () => {
    const result = assessCommand("npm test", "ask", "ask");
    expect(result.risk).toBe("low");
    expect(result.requiresApproval).toBe(false);
    expect(result.denied).toBe(false);
  });

  it("flags destructive deletion as high risk and requires approval", () => {
    const result = assessCommand("rm -rf node_modules", "ask", "ask");
    expect(result.risk).toBe("high");
    expect(result.requiresApproval).toBe(true);
    expect(result.denied).toBe(false);
  });

  it("denies high-risk commands in deny mode", () => {
    expect(assessCommand("git reset --hard", "deny", "ask").denied).toBe(true);
  });

  it("denies network commands when network policy denies", () => {
    const result = assessCommand("curl https://example.com", "ask", "deny");
    expect(result.denied).toBe(true);
    expect(result.reason).toMatch(/network/i);
  });

  it("allows medium risk automatically in auto mode", () => {
    const result = assessCommand("npm install", "auto", "allow");
    expect(result.risk).toBe("medium");
    expect(result.requiresApproval).toBe(false);
  });

  it("flags shell composition and inline evaluation", () => {
    expect(assessCommand("echo hi && node -c 'x'", "ask", "ask").risk).not.toBe("low");
    expect(assessCommand("powershell -Command Get-ChildItem", "ask", "ask").risk).not.toBe("low");
  });

  it("redacts common secrets", () => {
    const value = "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz Bearer abc.def.ghi";
    const redacted = redactSecrets(value);
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).toContain("[REDACTED");
  });
});
