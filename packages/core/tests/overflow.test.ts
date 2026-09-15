import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { describeApiError, detectContextOverflow, formatTokens } from "@harness/core";

/**
 * Provider error intelligence — built from the real OpenRouter failure that
 * killed a live run: a 265113-token request against a 262144-token model,
 * wrapped in OpenRouter's "[Provider] …" tag + nested metadata.raw JSON.
 */

const RAW_PROVIDER_ERROR = JSON.stringify({
  error: {
    message:
      "The request is 265113 tokens long and exceeds this model's context length of 262144 tokens.",
    type: "invalid_request_error",
    param: "",
    code: "context_length_exceeded",
  },
});

function openRouterOverflowError(message?: string): APICallError {
  return new APICallError({
    message:
      message ??
      "[Nex AGI] The request is 265113 tokens long and exceeds this model's context length of 262144 tokens.",
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: { messages: "…90 messages…" },
    statusCode: 400,
    isRetryable: false,
    data: {
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: RAW_PROVIDER_ERROR, provider_name: "Nex AGI" },
      },
      user_id: "user_test",
    },
  });
}

describe("detectContextOverflow", () => {
  it("parses used + limit from the real OpenRouter envelope", () => {
    const overflow = detectContextOverflow(openRouterOverflowError());
    expect(overflow).toEqual({ used: 265113, limit: 262144 });
  });

  it("parses numbers with thousands separators", () => {
    const error = new APICallError({
      message:
        "The request is 1,048,576 tokens long and exceeds this model's context length of 1,000,000 tokens.",
      url: "https://mock.invalid",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    expect(detectContextOverflow(error)).toEqual({ used: 1048576, limit: 1000000 });
  });

  it("parses the limit when the provider only reports it (…context length is N…)", () => {
    const error = new APICallError({
      message: "This model's maximum context length is 8192 tokens.",
      url: "https://mock.invalid",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    expect(detectContextOverflow(error)).toEqual({ used: undefined, limit: 8192 });
  });

  it("finds the numbers inside a JSON-string metadata.raw when the wrapper message is generic", () => {
    const error = new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
      data: {
        error: { message: "Provider returned error", metadata: { raw: RAW_PROVIDER_ERROR } },
      },
    });
    expect(detectContextOverflow(error)).toEqual({ used: 265113, limit: 262144 });
  });

  it("returns undefined for unrelated errors", () => {
    expect(detectContextOverflow(new Error("invalid api key"))).toBeUndefined();
    expect(detectContextOverflow("boom")).toBeUndefined();
    expect(detectContextOverflow(undefined)).toBeUndefined();
  });

  it("returns undefined when the reported request is within the limit", () => {
    const error = new APICallError({
      message:
        "The request is 1000 tokens long and exceeds this model's context length of 262144 tokens. (ok=false)",
      url: "https://mock.invalid",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    // The numbers contradict an overflow — do not recover, fail loudly.
    expect(detectContextOverflow(error)).toBeUndefined();
  });
});

describe("describeApiError", () => {
  it("returns the meaningful provider sentence without JSON noise", () => {
    const text = describeApiError(openRouterOverflowError());
    expect(text).toContain("265113 tokens long");
    expect(text).toContain("context length of 262144 tokens");
    expect(text).not.toContain("metadata");
    expect(text).not.toContain("requestBodyValues");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("unwraps the nested message when the wrapper is generic", () => {
    const error = new APICallError({
      message: "Provider returned error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
      data: {
        error: { message: "Provider returned error", metadata: { raw: RAW_PROVIDER_ERROR } },
      },
    });
    expect(describeApiError(error)).toContain("265113 tokens long");
  });

  it("falls back to the plain error message for non-API errors", () => {
    expect(describeApiError(new Error("socket hang up"))).toBe("socket hang up");
    expect(describeApiError("literal string")).toBe("literal string");
    expect(describeApiError({ weird: true })).toBe('{"weird":true}');
  });

  it("clips absurdly long messages to one line", () => {
    const text = describeApiError(new Error("x".repeat(2000)));
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text.endsWith("...")).toBe(true);
  });
});

describe("formatTokens", () => {
  it("keeps small counts raw", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(9_999)).toBe("9999");
  });

  it("formats large counts as k", () => {
    expect(formatTokens(10_000)).toBe("10k");
    expect(formatTokens(123_963)).toBe("124k");
    expect(formatTokens(262_144)).toBe("262.1k");
    expect(formatTokens(265_113)).toBe("265.1k");
  });
});
