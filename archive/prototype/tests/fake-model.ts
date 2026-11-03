import type { AssistantPart, ModelAdapter, ModelRequest, ModelResponse, ModelStreamEvent, Usage } from "../src/protocol.js";

export type FakeResponse = ModelResponse | ((request: ModelRequest, call: number) => ModelResponse | Promise<ModelResponse>);

export class FakeModel implements ModelAdapter {
  readonly id = "fake/test-model";
  readonly provider = "fake";
  readonly model = "test-model";
  readonly contextWindow = 32_000;
  readonly maxOutputTokens = 4_096;
  readonly requests: ModelRequest[] = [];
  nextUsage: Usage | undefined;
  private call = 0;
  constructor(private readonly responses: FakeResponse[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.call];
    this.call++;
    if (!response) throw new Error(`FakeModel has no response for request ${this.call}`);
    const resolved = typeof response === "function" ? await response(request, this.call) : response;
    if (this.nextUsage) resolved.usage = this.nextUsage;
    for (const part of resolved.parts) {
      if (part.type === "text") {
        for (const chunk of chunkText(part.text, 4)) yield { type: "text_delta", text: chunk };
      }
    }
    yield { type: "response", response: resolved };
  }
}

function chunkText(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  return chunks;
}

export function assistant(parts: AssistantPart[], stopReason: ModelResponse["stopReason"] = "stop"): ModelResponse {
  return { parts, stopReason };
}
