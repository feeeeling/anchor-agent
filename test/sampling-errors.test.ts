import { describe, expect, it } from "vitest";
import { formatSamplingFailure } from "../src/sampling-errors.js";

describe("formatSamplingFailure", () => {
  it("classifies Sampling rejection / denial", () => {
    const message = formatSamplingFailure(
      new Error("User rejected sampling request"),
    );
    expect(message).toMatch(/approve/i);
    expect(message).toMatch(/Sampling/i);
    expect(message).toMatch(/Retry|claim_task/i);
  });

  it("classifies unauthorized Sampling", () => {
    expect(
      formatSamplingFailure(new Error("Sampling unauthorized by host")),
    ).toMatch(/not authorized|Approve/i);
  });

  it("classifies invalid or empty candidate JSON", () => {
    expect(
      formatSamplingFailure(
        new Error("Agent sampling response did not contain a JSON candidate"),
      ),
    ).toMatch(/invalid or empty candidate JSON/i);
    expect(
      formatSamplingFailure(
        new Error("Agent returned an invalid candidate: Expected string"),
      ),
    ).toMatch(/candidate JSON/i);
    expect(
      formatSamplingFailure(
        new Error("Agent sampling response did not contain text"),
      ),
    ).toMatch(/Retry/i);
  });

  it("classifies max tool-call turns", () => {
    expect(
      formatSamplingFailure(
        new Error("Sampling exceeded the maximum tool-call turns"),
      ),
    ).toMatch(/maximum tool-call turns/i);
  });

  it("classifies bridge disconnect / ECONNREFUSED", () => {
    const refused = formatSamplingFailure(
      new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:3847"),
    );
    expect(refused).toMatch(/bridge|extension/i);
    expect(refused).toMatch(/MCP|Retry|claim_task/i);

    expect(
      formatSamplingFailure(
        new Error("Anchor bridge returned 503: extension host gone"),
      ),
    ).toMatch(/bridge/i);
  });

  it("falls back with Retry / manual claim hints", () => {
    const message = formatSamplingFailure(new Error("model timed out"));
    expect(message).toContain("model timed out");
    expect(message).toMatch(/Retry/i);
    expect(message).toMatch(/claim_task/);
  });

  it("accepts non-Error values", () => {
    expect(formatSamplingFailure("ECONNRESET")).toMatch(/bridge|Retry/i);
    expect(formatSamplingFailure(null)).toMatch(/Retry|claim_task/);
  });
});
