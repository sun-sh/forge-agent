import { z } from "zod";
import { toJSONSchema } from "zod";
import type { JsonValue } from "../protocol.js";

export function schemaToJson<T>(schema: z.ZodType<T>): Record<string, JsonValue> {
  return toJSONSchema(schema, { target: "draft-07", io: "input" }) as unknown as Record<string, JsonValue>;
}
