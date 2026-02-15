import { describe, expect, it, vi } from "vitest";
import { uploadToOneDrive, uploadToSharePoint } from "./graph-upload.js";

const tokenProvider = {
  getAccessToken: vi.fn(async () => "test-token"),
};

function getHeader(init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(init?.headers);
  return headers.get(name);
}

describe("msteams graph upload", () => {
  it("uses simple OneDrive upload for files up to 4MB", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "item-1", webUrl: "https://example/item-1", name: "a.txt" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const result = await uploadToOneDrive({
      buffer: Buffer.from("hello"),
      filename: "a.txt",
      tokenProvider,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain(
      "/me/drive/root:/OpenClawShared/a.txt:/content",
    );
    expect(result).toEqual({
      id: "item-1",
      webUrl: "https://example/item-1",
      name: "a.txt",
    });
  });

  it("uses upload session for OneDrive files over 4MB", async () => {
    const uploadUrl = "https://upload.example/session";
    const large = Buffer.alloc(16 * 320 * 1024 + 10, 1);

    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("createUploadSession")) {
        return new Response(JSON.stringify({ uploadUrl }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url === uploadUrl &&
        getHeader(init, "Content-Range") === `bytes 0-5242879/${large.length}`
      ) {
        return new Response(JSON.stringify({ nextExpectedRanges: ["5242880-"] }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url === uploadUrl &&
        getHeader(init, "Content-Range") === `bytes 5242880-${large.length - 1}/${large.length}`
      ) {
        return new Response(
          JSON.stringify({ id: "item-2", webUrl: "https://example/item-2", name: "big.bin" }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("unexpected request", { status: 500 });
    });

    const result = await uploadToOneDrive({
      buffer: large,
      filename: "big.bin",
      tokenProvider,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain(
      "/me/drive/root:/OpenClawShared/big.bin:/createUploadSession",
    );
    expect(result).toEqual({
      id: "item-2",
      webUrl: "https://example/item-2",
      name: "big.bin",
    });
  });

  it("uses upload session for SharePoint files over 4MB", async () => {
    const uploadUrl = "https://upload.example/sharepoint-session";
    const large = Buffer.alloc(16 * 320 * 1024 + 2, 7);

    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (
        url.includes("/sites/site-123/drive/root:/OpenClawShared/report.pdf:/createUploadSession")
      ) {
        return new Response(JSON.stringify({ uploadUrl }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url === uploadUrl &&
        getHeader(init, "Content-Range") === `bytes 0-5242879/${large.length}`
      ) {
        return new Response(JSON.stringify({ nextExpectedRanges: ["5242880-"] }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url === uploadUrl &&
        getHeader(init, "Content-Range") === `bytes 5242880-${large.length - 1}/${large.length}`
      ) {
        return new Response(
          JSON.stringify({ id: "item-3", webUrl: "https://example/item-3", name: "report.pdf" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("unexpected request", { status: 500 });
    });

    const result = await uploadToSharePoint({
      buffer: large,
      filename: "report.pdf",
      siteId: "site-123",
      tokenProvider,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain(
      "/sites/site-123/drive/root:/OpenClawShared/report.pdf:/createUploadSession",
    );
    expect(result).toEqual({
      id: "item-3",
      webUrl: "https://example/item-3",
      name: "report.pdf",
    });
  });
});
