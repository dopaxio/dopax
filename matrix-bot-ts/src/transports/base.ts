export interface TransportMessageOptions {
    threadRootEventId?: string | null;
    replyToEventId?: string | null;
    msgtype?: "m.text" | "m.notice";
}

export interface AgentTransport {
    readonly name: string;
    sendMessage(conversationId: string, body: string, options?: TransportMessageOptions): Promise<string>;
    editMessage(conversationId: string, targetEventId: string, body: string): Promise<string>;
    setTyping?(conversationId: string, isTyping: boolean, timeoutMs: number): Promise<void>;
    getJoinedConversations(): Promise<string[]>;
}
