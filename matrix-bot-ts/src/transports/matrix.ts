import type { MatrixClient } from "matrix-bot-sdk";

import type { AgentTransport, TransportMessageOptions } from "./base.js";

export function getThreadRootEventId(event: Record<string, any>): string | null {
    const relation = event?.content?.["m.relates_to"];
    if (!relation || typeof relation !== "object") return null;
    if (relation["rel_type"] !== "m.thread") return null;
    const rootEventId = relation["event_id"];
    return typeof rootEventId === "string" && rootEventId.trim() ? rootEventId.trim() : null;
}

export function getConversationKey(roomId: string, threadRootEventId?: string | null): string {
    return threadRootEventId ? `${roomId}::thread::${threadRootEventId}` : roomId;
}

export class MatrixTransport implements AgentTransport {
    public readonly name = "matrix";

    public constructor(private readonly client: MatrixClient) {}

    public async sendMessage(
        roomId: string,
        body: string,
        options: TransportMessageOptions = {},
    ): Promise<string> {
        const payload: Record<string, any> = {
            msgtype: options.msgtype ?? "m.text",
            body,
        };

        if (options.threadRootEventId) {
            payload["m.relates_to"] = {
                rel_type: "m.thread",
                event_id: options.threadRootEventId,
                is_falling_back: true,
                ...(options.replyToEventId ? { "m.in_reply_to": { event_id: options.replyToEventId } } : {}),
            };
        }

        return this.client.sendRawEvent(roomId, "m.room.message", payload);
    }

    public async editMessage(roomId: string, targetEventId: string, body: string): Promise<string> {
        return this.client.sendRawEvent(roomId, "m.room.message", {
            msgtype: "m.text",
            body: `* ${body}`,
            "m.new_content": {
                msgtype: "m.text",
                body,
            },
            "m.relates_to": {
                rel_type: "m.replace",
                event_id: targetEventId,
            },
        });
    }

    public async setTyping(roomId: string, isTyping: boolean, timeoutMs: number): Promise<void> {
        await this.client.setTyping(roomId, isTyping, timeoutMs);
    }

    public async getJoinedConversations(): Promise<string[]> {
        return this.client.getJoinedRooms();
    }
}
