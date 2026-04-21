import type { AgentTransport, TransportMessageOptions } from "./base.js";

export interface DiscordTransportOptions {
    agentToken?: string;
    applicationId?: string;
}

function notImplemented(method: string): never {
    throw new Error(`DiscordTransport.${method} is not implemented yet.`);
}

export class DiscordTransport implements AgentTransport {
    public readonly name = "discord";

    public constructor(public readonly options: DiscordTransportOptions = {}) {}

    public async sendMessage(
        _conversationId: string,
        _body: string,
        _options: TransportMessageOptions = {},
    ): Promise<string> {
        return notImplemented("sendMessage");
    }

    public async editMessage(
        _conversationId: string,
        _targetEventId: string,
        _body: string,
    ): Promise<string> {
        return notImplemented("editMessage");
    }

    public async setTyping(
        _conversationId: string,
        _isTyping: boolean,
        _timeoutMs: number,
    ): Promise<void> {
        return notImplemented("setTyping");
    }

    public async getJoinedConversations(): Promise<string[]> {
        return notImplemented("getJoinedConversations");
    }
}
