import { ipcMain } from "electron";
import type * as z from "zod";
import type { IpcChannelName, IpcRequest, IpcResponse } from "../shared/ipc";

export type ChannelSchemas<Channel extends IpcChannelName> = {
  request: z.ZodType<IpcRequest<Channel>>;
  response: z.ZodType<IpcResponse<Channel>>;
};

/** The one place IPC payloads are trusted: every request is parsed before the handler
 * runs, and every response is parsed so the wire shape can never drift from
 * the contract the renderer compiled against. */
export function registerIpcHandler<Channel extends IpcChannelName>(
  channel: Channel,
  schemas: ChannelSchemas<Channel>,
  handle: (request: IpcRequest<Channel>) => Promise<IpcResponse<Channel>> | IpcResponse<Channel>,
): void {
  ipcMain.handle(channel, async (_event, rawRequest: unknown) => {
    const request = schemas.request.parse(rawRequest);
    return schemas.response.parse(await handle(request));
  });
}
