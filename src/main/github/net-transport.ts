import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from "electron";
import type { GitHubTransport } from "./client";

// The app's `GitHubTransport`: a `fetch`-shaped function over Electron's `net.request`, for the
// one thing `net.fetch` cannot do — hand a redirect back unfollowed.
//
// **Why not `net.fetch`.** `client.ts` follows redirects itself, against its allowlist, so the
// transport must answer a 3xx as a response with its `location`. Under Electron 43, `net.fetch`
// with `redirect: "manual"` rejects with "Redirect was cancelled" for every redirect — same
// origin or not — and never returns the 3xx (its `net-client-request.ts` cancels a redirect
// nobody follows, and `net.fetch` reports that as a failure). A renamed repository, which GitHub
// answers with a 301 to `/repositories/<id>/…`, read as "GitHub could not be reached".
//
// **What this does instead.** `net.request` with `redirect: "manual"` reports the redirect to a
// listener first, with its status and target; the listener records them, abandons the request
// (never `followRedirect`), and answers with a synthesized `Response(null, { status, location })`.
// `client.ts` decides whether to follow, exactly as before. Everything else a fetch would do is
// mapped over: the method, the headers (the User-Agent included — `net.request` sends the one it
// is given), a string body, and the response streamed as a `ReadableStream` with backpressure.
//
// **What it holds the request to**, the same as `client.ts` asks of any transport:
//
//   - `credentials` and no session cookies: `useSessionCookies: false` with the init's
//     `credentials` (`omit`), so the default session's cookies never ride along.
//   - `cache`: the init's (`no-store`), so Chromium's HTTP cache neither answers for GitHub nor
//     keeps its answers; `client.ts`'s own ETag scheme is the only revalidation, and an
//     `If-None-Match` it sets reaches GitHub and its 304 comes back here as a 304.
//   - the `AbortSignal`: an abort before the answer rejects; after it, the body errors. Either
//     way the request is aborted, which is what releases the connection (`client.ts` aborts every
//     call when it ends, for that reason). Cancelling the body stream aborts it too.
//
// **Verified under Electron 43** (2026-10-03, a scratch Electron main process against a local
// HTTP server and the live API — not part of the suite, which has no Electron): a same-origin
// 301 arrives as a 301 with its `location`, and an off-origin 302 likewise (and is then refused
// by `client.ts`); no `cookie` header is sent with a cookie set on the default session; the
// User-Agent is ours; a `304` to our `If-None-Match` arrives as a 304; aborting mid-body errors the
// stream and the server sees the connection close (after 1 MB of a 200 MB body); an abort before
// the answer rejects; through `client.ts` (its URLs pointed at the local server), a body cut off
// at the cap and a 404 body never read each close their connection at once — before `client.ts`
// aborted every call on its way out, the cap left the socket open, stalled, until quit; and live,
// through `client.ts`, `GET /repos/vuejs/vue-next/pulls/15761` follows GitHub's 301 to
// `/repositories/137078487/pulls/15761` and parses, and asking again revalidates with
// `If-None-Match` and is answered from the kept body on GitHub's 304. A raw server answering
// `x-test: 日本` resolves the call (the value kept as its bytes, `latin1`) with nothing uncaught
// in main — before `guarded` and `responseHeaders`, that header threw out of the response
// listener and the call hung to its timeout. The unit test
// (`net-transport.test.ts`) pins the mapping against a fake `ClientRequest`.

/** `net.request`, or a fake of it. */
export type NetRequest = (options: ClientRequestConstructorOptions) => ClientRequest;

/** At runtime Electron's `IncomingMessage` is a Node `Readable` (its `net-client-request.ts`),
 * though its typings declare only an emitter; these two are what backpressure needs. */
type Pausable = { pause?: () => unknown; resume?: () => unknown };

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** A header value as the byte string a fetch would expose. Electron hands values over decoded as
 * UTF-8, and `Headers` refuses any character above 0xFF — `x-test: 日本` threw inside the response
 * listener, uncaught, and left the call hanging until its timeout. So a value `Headers` will not
 * take is put back into its UTF-8 bytes, one character per byte (what the wire carried). */
function latin1(value: string): string {
  let bytes = "";
  for (const byte of new TextEncoder().encode(value)) {
    bytes += String.fromCodePoint(byte);
  }
  return bytes;
}

/** The response's headers, built so that no header can fail the response: a value `Headers`
 * refuses is re-encoded (`latin1`), and one it still refuses — or an invalid name — is left out.
 * The client reads a handful of headers (`content-type`, `content-length`, `etag`, the rate-limit
 * ones, `retry-after`, `date`, `location`), all ASCII on GitHub's answers. */
export function responseHeaders(raw: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, one);
      } catch {
        try {
          headers.append(name, latin1(one));
        } catch {
          // Not a header `Headers` can hold at all; nothing here reads it.
        }
      }
    }
  }
  return headers;
}

/** The response body as a web stream, pulled at the reader's pace. */
function bodyStream(message: IncomingMessage, request: ClientRequest): ReadableStream<Uint8Array> {
  const pausable = message as IncomingMessage & Pausable;
  let settled = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        message.on("data", (chunk: Buffer) => {
          if (settled) {
            return;
          }
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          if ((controller.desiredSize ?? 0) <= 0) {
            pausable.pause?.();
          }
        });
        message.on("end", () => {
          if (!settled) {
            settled = true;
            controller.close();
          }
        });
        const failed = (error: Error): void => {
          if (!settled) {
            settled = true;
            controller.error(error);
          }
        };
        message.on("error", failed);
        message.on("aborted", () => failed(new Error("aborted")));
        // An abort of the request mid-body (the call's timeout, or `client.ts` ending the call)
        // ends the stream here too, whether or not the message reports it.
        request.on("abort", () => failed(new Error("aborted")));
      },
      pull() {
        pausable.resume?.();
      },
      cancel() {
        settled = true;
        request.abort();
      },
    },
    { highWaterMark: 8 },
  );
}

export function netTransport(request: NetRequest): GitHubTransport {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? null;
      if (signal?.aborted === true) {
        reject(new Error("aborted"));
        return;
      }
      const req = request({
        url,
        method: init.method ?? "GET",
        redirect: "manual",
        credentials: init.credentials === "include" ? "include" : "omit",
        useSessionCookies: false,
        cache: init.cache === "default" || init.cache === undefined ? "default" : init.cache,
      });
      let answered = false;
      const answer = (response: Response): void => {
        answered = true;
        resolve(response);
      };
      const refuse = (error: unknown): void => {
        req.abort();
        if (!answered) {
          answered = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      /** A listener's body, run so that a throw inside it — a `Response` that will not build —
       * rejects this call and releases the request, instead of escaping into main as an
       * uncaught exception (which `crash.ts` turns into a modal) and leaving the call to hang
       * until its timeout. */
      const guarded =
        <Args extends unknown[]>(listener: (...args: Args) => void) =>
        (...args: Args): void => {
          try {
            listener(...args);
          } catch (error) {
            refuse(error);
          }
        };

      for (const [name, value] of new Headers(init.headers).entries()) {
        req.setHeader(name, value);
      }

      // The redirect, reported before it is followed: answered as a 3xx and abandoned.
      req.on(
        "redirect",
        guarded((status: number, _method: string, location: string) => {
          if (answered) {
            return;
          }
          answer(new Response(null, { status, headers: responseHeaders({ location }) }));
          req.abort();
        }),
      );
      req.on(
        "response",
        guarded((message: IncomingMessage) => {
          if (answered) {
            return;
          }
          const status = message.statusCode;
          answer(
            new Response(NULL_BODY_STATUSES.has(status) ? null : bodyStream(message, req), {
              status,
              headers: responseHeaders(message.headers),
            }),
          );
        }),
      );
      req.on("error", (error: Error) => {
        if (!answered) {
          answered = true;
          reject(error);
        }
      });
      signal?.addEventListener(
        "abort",
        () => {
          req.abort();
          if (!answered) {
            answered = true;
            reject(new Error("aborted"));
          }
        },
        { once: true },
      );

      if (typeof init.body === "string") {
        req.write(init.body);
      }
      req.end();
    });
}
