import { expect, it, vi } from "vitest";
import { resolveKernelOrigin } from "./kernel-discovery.js";

it("resolves each new link from Kernel and rejects malformed or unavailable origins", async () => {
  let host = "first.example.test";
  const fetcher = vi.fn<typeof fetch>((_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-service-token");
    expect(init?.redirect).toBe("error");
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
    expect(JSON.parse(init.body)).toEqual({ keys: ["services.saturn.sni", "services.saturn.port"] });
    return Promise.resolve(Response.json({ schema: "exocortex.register.resolution.v1", values: {
      "services.saturn.sni": { value: host }, "services.saturn.port": { value: "443" },
    } }));
  });
  expect(await resolveKernelOrigin("https://kernel.test", "synthetic-service-token", "saturn", 1000, fetcher)).toBe("https://first.example.test");
  host = "second.example.test";
  expect(await resolveKernelOrigin("https://kernel.test", "synthetic-service-token", "saturn", 1000, fetcher)).toBe("https://second.example.test");
  expect(fetcher).toHaveBeenCalledTimes(2);
  host = "user:password@attacker.test";
  await expect(resolveKernelOrigin("https://kernel.test", "synthetic-service-token", "saturn", 1000, fetcher)).rejects.toThrow();
  await expect(resolveKernelOrigin("http://untrusted.test", "synthetic-service-token", "saturn", 1000, fetcher)).rejects.toThrow();
});
