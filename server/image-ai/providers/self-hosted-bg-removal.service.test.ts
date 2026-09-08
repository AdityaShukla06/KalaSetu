import { describe, it, expect, vi, afterEach } from "vitest";
import { SelfHostedBgRemovalService } from "./self-hosted-bg-removal.service";

describe("SelfHostedBgRemovalService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("posts the image as multipart form data and returns the response bytes", async () => {
    const cutoutBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(cutoutBytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new SelfHostedBgRemovalService("https://bg-removal.onrender.com/", 5000);
    const result = await service.removeBackground(Buffer.from("fake-image"), "image/png");

    expect(Buffer.compare(result, Buffer.from(cutoutBytes))).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bg-removal.onrender.com/remove-background",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("retries once and succeeds if the second attempt works", async () => {
    vi.useFakeTimers();
    const cutoutBytes = new Uint8Array([9, 9, 9]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(cutoutBytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new SelfHostedBgRemovalService("https://bg-removal.onrender.com", 5000);
    const resultPromise = service.removeBackground(Buffer.from("fake-image"), "image/png");

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(Buffer.compare(result, Buffer.from(cutoutBytes))).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a BackgroundRemovalError with reason provider_error after both attempts fail", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));

    const service = new SelfHostedBgRemovalService("https://bg-removal.onrender.com", 5000);
    const resultPromise = service.removeBackground(Buffer.from("fake-image"), "image/png");
    const expectation = expect(resultPromise).rejects.toMatchObject({
      reason: "provider_error",
    });

    await vi.runAllTimersAsync();
    await expectation;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws a timeout error when every attempt is aborted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        const abortError = new Error("aborted");
        abortError.name = "AbortError";
        return Promise.reject(abortError);
      }),
    );

    const service = new SelfHostedBgRemovalService("https://bg-removal.onrender.com", 5000);
    const resultPromise = service.removeBackground(Buffer.from("fake-image"), "image/png");
    const expectation = expect(resultPromise).rejects.toMatchObject({
      reason: "timeout",
    });

    await vi.runAllTimersAsync();
    await expectation;
  });

  it("strips trailing slashes from the base URL before building the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new SelfHostedBgRemovalService("https://bg-removal.onrender.com///", 5000);
    await service.removeBackground(Buffer.from("fake-image"), "image/png");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bg-removal.onrender.com/remove-background",
      expect.anything(),
    );
  });

  it("pings the health route on warmUp", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new SelfHostedBgRemovalService("https://bg-removal.onrender.com", 5000);
    await service.warmUp();

    expect(fetchMock).toHaveBeenCalledWith("https://bg-removal.onrender.com/", expect.anything());
  });
});
