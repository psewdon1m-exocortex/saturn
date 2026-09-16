import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";

describe("ApiError", () => {
  it("shows the bounded server explanation to the authenticated operator", () => {
    const error = new ApiError(400, { code: "invalid_request", message: "Release is no longer the current update candidate" });
    expect(error.message).toBe("Release is no longer the current update candidate (HTTP 400)");
    expect(error.code).toBe("invalid_request");
  });

  it("falls back to the status when the response has no safe explanation", () => {
    expect(new ApiError(502, { message: ["not", "a", "string"] }).message).toBe("Gateway request failed with status 502");
  });
});
