import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from "electron";
import { describe, expect, it } from "vitest";
import { netTransport } from "./net-transport";

// The `net.request` adapter against a fake `ClientRequest` — the mapping only; that Electron's
// real one behaves the way the fake does was verified in an Electron main process
// (`net-transport.ts`'s header records how). The fake is an emitter that records what the
// adapter set and lets the test play the network's part.

type Listener = (...args: never[]) => void;

/** The two halves of Node's emitter the adapter uses, and nothing else: `on`, and `emit` for the
 * test to play the network's part. */
function emitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(name: string, listener: Listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return this;
    },
    emit(name: string, ...args: unknown[]) {
      for (const listener of listeners.get(name) ?? []) {
        (listener as (...values: unknown[]) => void)(...args);
      }
    },
  };
}

type FakeRequest = ReturnType<typeof fakeRequest>;

function fakeRequest(options: ClientRequestConstructorOptions) {
  const request = {
    ...emitter(),
    options,
    headers: {} as Record<string, string>,
    written: [] as string[],
    ended: false,
    aborted: false,
    setHeader(name: string, value: string) {
      request.headers[name] = value;
    },
    write(chunk: string) {
      request.written.push(chunk);
    },
    end() {
      request.ended = true;
    },
    abort() {
      if (!request.aborted) {
        request.aborted = true;
        request.emit("abort");
      }
    },
  };
  return request;
}

function fakeMessage(statusCode: number, headers: Record<string, string | string[]>) {
  const message = {
    ...emitter(),
    statusCode,
    headers,
    paused: false,
    pause() {
      message.paused = true;
    },
    resume() {
      message.paused = false;
    },
  };
  return message;
}

function harness() {
  const requests: FakeRequest[] = [];
  const transport = netTransport((options) => {
    const request = fakeRequest(options);
    requests.push(request);
    return request as unknown as ClientRequest;
  });
  const last = (): FakeRequest => {
    const request = requests.at(-1);
    if (request === undefined) {
      throw new Error("no request made");
    }
    return request;
  };
  return { transport, last };
}

const INIT: RequestInit = {
  method: "GET",
  headers: { "User-Agent": "Reviewer/test", Accept: "application/vnd.github+json" },
  redirect: "manual",
  credentials: "omit",
  cache: "no-store",
};

describe("netTransport", () => {
  it("asks without cookies or Chromium's cache, never following a redirect, with our headers", async () => {
    const { transport, last } = harness();
    const pending = transport("https://api.github.com/x", INIT);
    const request = last();
    expect(request.options).toMatchObject({
      url: "https://api.github.com/x",
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      useSessionCookies: false,
      cache: "no-store",
    });
    expect(request.headers).toMatchObject({ "user-agent": "Reviewer/test" });
    expect(request.ended).toBe(true);
    request.emit("response", fakeMessage(204, {}) as unknown as IncomingMessage);
    expect((await pending).status).toBe(204);
  });

  it("answers a redirect as the 3xx, with its location, and abandons the request", async () => {
    const { transport, last } = harness();
    const pending = transport("https://api.github.com/repos/a/b/pulls/1", INIT);
    last().emit("redirect", 301, "GET", "https://api.github.com/repositories/9/pulls/1", {});
    // The error Electron raises for a redirect nobody followed must not turn it into a failure.
    last().emit("error", new Error("Redirect was cancelled"));
    const response = await pending;
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://api.github.com/repositories/9/pulls/1");
    expect(last().aborted).toBe(true);
  });

  it("streams the body, with every header — repeated ones too", async () => {
    const { transport, last } = harness();
    const pending = transport("https://api.github.com/x", INIT);
    const message = fakeMessage(200, { "content-type": "application/json", vary: ["a", "b"] });
    last().emit("response", message as unknown as IncomingMessage);
    const response = await pending;
    expect(response.headers.get("vary")).toBe("a, b");
    message.emit("data", Buffer.from('{"ok":'));
    message.emit("data", Buffer.from("1}"));
    message.emit("end");
    expect(await response.text()).toBe('{"ok":1}');
  });

  it("writes a POST's body", () => {
    const { transport, last } = harness();
    void transport("https://api.github.com/graphql", { ...INIT, method: "POST", body: "{}" });
    expect(last().options.method).toBe("POST");
    expect(last().written).toEqual(["{}"]);
  });

  it("rejects on a network error, and on an abort before the answer, aborting the request", async () => {
    const offline = harness();
    const failing = offline.transport("https://api.github.com/x", INIT);
    offline.last().emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
    await expect(failing).rejects.toThrow("ERR_INTERNET_DISCONNECTED");

    const { transport, last } = harness();
    const controller = new AbortController();
    const pending = transport("https://api.github.com/x", { ...INIT, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(last().aborted).toBe(true);
  });

  it("errors the body and aborts the request on an abort mid-body", async () => {
    const { transport, last } = harness();
    const controller = new AbortController();
    const pending = transport("https://api.github.com/x", { ...INIT, signal: controller.signal });
    const message = fakeMessage(200, { "content-type": "text/plain" });
    last().emit("response", message as unknown as IncomingMessage);
    const reader = (await pending).body?.getReader();
    message.emit("data", Buffer.from("x"));
    await reader?.read();
    controller.abort();
    expect(last().aborted).toBe(true);
    await expect(reader?.read()).rejects.toThrow("aborted");
  });

  it("aborts the request when the body is cancelled", async () => {
    const { transport, last } = harness();
    const pending = transport("https://api.github.com/x", INIT);
    last().emit("response", fakeMessage(200, {}) as unknown as IncomingMessage);
    await (await pending).body?.cancel();
    expect(last().aborted).toBe(true);
  });

  it("pauses the message when the reader falls behind, and resumes it on demand", async () => {
    const { transport, last } = harness();
    const pending = transport("https://api.github.com/x", INIT);
    const message = fakeMessage(200, {});
    last().emit("response", message as unknown as IncomingMessage);
    const reader = (await pending).body?.getReader();
    for (let chunk = 0; chunk < 20; chunk += 1) {
      message.emit("data", Buffer.from("x"));
    }
    expect(message.paused).toBe(true);
    // Read the queue back under its mark (8 chunks): only then is more asked for.
    for (let chunk = 0; chunk < 13; chunk += 1) {
      await reader?.read();
    }
    expect(message.paused).toBe(false);
  });

  it("keeps a header value outside Latin-1 as its bytes, rather than failing the response", async () => {
    const { transport, last } = harness();
    const pending = transport("https://api.github.com/x", INIT);
    // What Electron hands over for a raw `x-test: 日本` — the value decoded as UTF-8.
    last().emit(
      "response",
      fakeMessage(200, {
        "content-type": "application/json",
        "x-test": "日本",
      }) as unknown as IncomingMessage,
    );
    const response = await pending;
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-test")).toBe("\u00E6\u0097\u00A5\u00E6\u009C\u00AC");
  });

  it("rejects, and lets the request go, when a response cannot be built at all", async () => {
    const { transport, last } = harness();
    const pending = transport("https://api.github.com/x", INIT);
    // Not a status a `Response` accepts: the throw must land on this call, not escape into main.
    last().emit("response", fakeMessage(999, {}) as unknown as IncomingMessage);
    await expect(pending).rejects.toThrow();
    expect(last().aborted).toBe(true);
  });
});
