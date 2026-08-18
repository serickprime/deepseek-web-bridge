import { describe, expect, it } from "vitest";
import { isPublicPath } from "../../src/server/middleware.js";

describe("isPublicPath", () => {
  it("exempts landing page and health endpoints on GET", () => {
    expect(isPublicPath("GET", "/")).toBe(true);
    expect(isPublicPath("GET", "/health")).toBe(true);
    expect(isPublicPath("GET", "/readyz")).toBe(true);
  });

  it("does not exempt API endpoints", () => {
    expect(isPublicPath("GET", "/v1/models")).toBe(false);
    expect(isPublicPath("GET", "/v1/sessions")).toBe(false);
  });

  it("requires GET method", () => {
    expect(isPublicPath("POST", "/health")).toBe(false);
    expect(isPublicPath("POST", "/")).toBe(false);
  });

  it("ignores query strings", () => {
    expect(isPublicPath("GET", "/health?x=1")).toBe(true);
  });
});
