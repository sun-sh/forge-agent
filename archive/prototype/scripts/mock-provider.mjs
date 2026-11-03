import http from "node:http";
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!req.url?.includes("/chat/completions")) { res.writeHead(404).end(); return; }
  const payload = JSON.parse(body || "{}");
  const tools = payload.tools || [];
  const messages = payload.messages || [];
  const text = JSON.stringify(messages);
  const sawVerificationResult = text.includes("PASS verify") || text.includes("FAIL verify");
  const verificationTool = tools.find((t) => t.function?.name === "run_verification");
  let message;
  if (verificationTool && !sawVerificationResult) {
    message = { role: "assistant", content: null, tool_calls: [{ id: "call_verify_1", type: "function", function: { name: "run_verification", arguments: "{}" } }] };
  } else {
    message = { role: "assistant", content: "Done." };
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write("data: " + JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: message }] }) + "\n\n");
  res.write("data: " + JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + "\n\n");
  res.end("data: [DONE]\n\n");
});
server.listen(4321, "127.0.0.1", () => console.log("ready"));
