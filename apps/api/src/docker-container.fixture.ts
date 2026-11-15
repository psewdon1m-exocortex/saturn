import { z } from "zod";
import { requireDefined } from "../../../packages/contracts/src/require-defined.js";

const container = z.object({
  Id: z.string(), Created: z.string(), Image:z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Running: z.boolean(), Paused: z.boolean() }),
  HostConfig: z.object({ NanoCpus: z.number(), Memory: z.number() }),
  NetworkSettings: z.object({ Ports: z.record(z.string(), z.array(z.object({ HostPort: z.string() })).nullable()) }),
});

export function parseFixtureContainer(json: string) {
  return requireDefined(z.array(container).length(1).parse(JSON.parse(json))[0]);
}
