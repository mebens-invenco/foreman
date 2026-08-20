import { afterEach, describe, expect, test, vi } from "vitest";

import { postSlackDm } from "../slack-dm.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("postSlackDm", () => {
  test("opens a DM and posts link markup without unfurling", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, channel: { id: "D123" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "123.456" }), { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    await expect(
      postSlackDm({
        token: "test-token",
        targetUserId: "U123",
        text: "Review https://example.com or <https://example.com/report|the report>.",
      }),
    ).resolves.toEqual({ channelId: "D123", messageTs: "123.456" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ users: "U123" });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      channel: "D123",
      text: "Review https://example.com or <https://example.com/report|the report>.",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test("surfaces Slack API errors without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    await expect(postSlackDm({ token: "test-token", targetUserId: "U123", text: "hello" })).rejects.toThrow("invalid_auth");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("bounds requests and message length", async () => {
    global.fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    })) as typeof fetch;

    await expect(postSlackDm({ token: "test-token", targetUserId: "U123", text: "hello", timeoutMs: 1 })).rejects.toThrow(/request failed/);
    await expect(postSlackDm({ token: "test-token", targetUserId: "U123", text: "x".repeat(4_001) })).rejects.toThrow(/4,000/);
  });
});
