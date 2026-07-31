import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as z from "zod";
import type { IpcChannelName, IpcRequest, IpcResponse } from "../shared/ipc";
import { IPC_SCHEMAS } from "../shared/ipc-schemas";

/** `IPC_SCHEMAS` as a mapped type over the channel, which is what makes the lookup in
 * `registerIpcHandler` readable to TypeScript: indexing the table's own type by an unresolved
 * generic key yields the union of all 22 rows, whose `parse` answers the union of all 22
 * payloads and relates to nothing. A homomorphic mapped type *does* distribute over a generic
 * key, so `SCHEMAS[channel]` is that channel's pair and each `parse` stays tied to its own
 * direction — parsing the request with the response schema is a compile error rather than a
 * silent swap, and none of it costs an assertion. */
type ChannelSchemas = {
  [Channel in IpcChannelName]: {
    request: z.ZodType<IpcRequest<Channel>>;
    response: z.ZodType<IpcResponse<Channel>>;
  };
};
const SCHEMAS: ChannelSchemas = IPC_SCHEMAS;

/** Both pages the renderer can legitimately be — the Vite dev server's, and the built
 * bundle's `file://` one (see `window.ts`, which loads one or the other).
 *
 * Both, rather than whichever this run chose: `window.ts` picks by `is.dev`, and a registry
 * that disagreed with it about which was in play would reject every channel and take the
 * whole app down. Neither entry loosens anything, because nothing but the page we loaded can
 * reach either URL — the window opens no others. */
function trustedSenderPrefixes(): readonly string[] {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  const bundle = pathToFileURL(join(__dirname, "../renderer/")).href;
  return devUrl === undefined ? [bundle] : [devUrl, bundle];
}

/** The renderer we shipped, in its own top-level frame, and nothing else.
 *
 * Defense in depth, not the defense: `sandbox` + `contextIsolation`, `webviewTag: false`, a
 * deny-all `setWindowOpenHandler`, a `will-navigate` that routes anything off-page to the OS
 * browser, a real CSP, and markdown rendered without raw HTML together mean there is no other
 * frame in the process to invoke from. This is what keeps that true if one of them ever
 * slips — a sub-frame that appears from somewhere gets no IPC. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (frame === null || frame !== event.sender.mainFrame) {
    return false;
  }
  return trustedSenderPrefixes().some((prefix) => frame.url.startsWith(prefix));
}

/** The one place IPC payloads are trusted: the sender is checked before anything is read
 * from it, every request is parsed before the handler runs, and every response is parsed so
 * the wire shape can never drift from the contract the renderer compiled against.
 *
 * The schemas are the channel's own, looked up in `IPC_SCHEMAS` rather than passed in: a
 * registration site has nothing to get wrong, and the pair that validates here is by
 * construction the pair the caller's types were derived from. */
export function registerIpcHandler<Channel extends IpcChannelName>(
  channel: Channel,
  handle: (request: IpcRequest<Channel>) => Promise<IpcResponse<Channel>> | IpcResponse<Channel>,
): void {
  const schemas = SCHEMAS[channel];
  ipcMain.handle(channel, async (event, rawRequest: unknown) => {
    if (!isTrustedSender(event)) {
      // Logged in main as well as rejected: the rejection surfaces in whichever frame made
      // the call, and by definition that is not a frame we want to leave the report with.
      console.error(
        `IPC ${channel} rejected: unexpected sender ${event.senderFrame?.url ?? "<no frame>"}`,
      );
      throw new Error(`IPC ${channel} rejected an untrusted sender`);
    }
    const request = schemas.request.parse(rawRequest);
    return schemas.response.parse(await handle(request));
  });
}
