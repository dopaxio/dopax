import { buildConversationKey } from "./keys.js";
import type {
    IncomingConversationEvent,
    ResolvedConversation,
    ConversationRef,
    ProviderSessionBinding,
    RuntimeBinding,
} from "./models.js";
import type {
    AgentRegistryStore,
    EndpointRegistryStore,
    ProviderSessionStore,
    RuntimeBindingStore,
} from "./stores.js";

export interface AgentOrchestratorStores {
    agents: AgentRegistryStore;
    endpoints: EndpointRegistryStore;
    runtimes: RuntimeBindingStore;
    providerSessions: ProviderSessionStore;
}

export class AgentOrchestrator {
    public constructor(private readonly stores: AgentOrchestratorStores) {}

    public async resolveConversation(event: IncomingConversationEvent): Promise<ResolvedConversation> {
        const endpoint = await this.stores.endpoints.getEndpoint(event.endpointId);
        if (!endpoint) {
            throw new Error(`Unknown endpoint: ${event.endpointId}`);
        }

        const agent = await this.stores.agents.getAgent(endpoint.agentId);
        if (!agent) {
            throw new Error(`Unknown agent for endpoint ${event.endpointId}: ${endpoint.agentId}`);
        }

        const conversation: ConversationRef = {
            endpointId: event.endpointId,
            conversationId: event.conversationId,
            kind: event.kind ?? "room",
            threadId: event.threadId ?? null,
        };

        const conversationKey = buildConversationKey(conversation);
        const runtime = await this.stores.runtimes.getRuntimeBinding(conversationKey);
        const providerSession = await this.stores.providerSessions.getProviderSession(conversationKey);

        return {
            agent,
            endpoint,
            conversation,
            runtime,
            providerSession,
        };
    }

    public async bindRuntime(conversation: ConversationRef, runtime: Omit<RuntimeBinding, "conversationKey">): Promise<void> {
        await this.stores.runtimes.saveRuntimeBinding({
            ...runtime,
            conversationKey: buildConversationKey(conversation),
        });
    }

    public async bindProviderSession(
        conversation: ConversationRef,
        providerSession: Omit<ProviderSessionBinding, "conversationKey">,
    ): Promise<void> {
        await this.stores.providerSessions.saveProviderSession({
            ...providerSession,
            conversationKey: buildConversationKey(conversation),
        });
    }
}
