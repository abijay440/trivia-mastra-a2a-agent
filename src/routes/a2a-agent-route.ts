import { registerApiRoute } from '@mastra/core/server';
import { randomUUID } from 'crypto';

// Define minimal types for A2A message parts and messages
type A2APart = {
  kind: 'text' | 'data' | string;
  text?: string;
  data?: unknown;
};

type A2AMessage = {
  role: string;
  parts?: A2APart[];
  messageId?: string;
  taskId?: string;
};

export const a2aAgentRoute = registerApiRoute('/a2a/agent/:agentId', {
  method: 'POST',
  handler: async (c: any) => {
    try {
      const mastra = c.get('mastra');
      const agentId = c.req.param('agentId');

      // Parse JSON-RPC 2.0 request
      const body = await c.req.json();
  const { jsonrpc, id: requestId, method, params } = body as any;

      // Validate JSON-RPC 2.0 format
      if (jsonrpc !== '2.0' || !requestId) {
        return c.json({
          jsonrpc: '2.0',
          id: requestId || null,
          error: {
            code: -32600,
            message: 'Invalid Request: jsonrpc must be "2.0" and id is required'
          }
        }, 400);
      }

      const agent = mastra.getAgent(agentId);
      if (!agent) {
        return c.json({
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: -32602,
            message: `Agent '${agentId}' not found`
          }
        }, 404);
      }

      // Extract messages from params
      const { message, messages, contextId, taskId, metadata } = (params || {}) as {
        message?: A2AMessage;
        messages?: A2AMessage[];
        contextId?: string;
        taskId?: string;
        metadata?: unknown;
      };

      let messagesList: A2AMessage[] = [];
      if (message) {
        messagesList = [message];
      } else if (messages && Array.isArray(messages)) {
        messagesList = messages;
      }

      // Convert A2A messages to Mastra format
      const mastraMessages = messagesList.map((msg) => ({
        role: msg.role,
        content: msg.parts?.map((part) => {
          if (part.kind === 'text') return part.text ?? '';
          if (part.kind === 'data') return JSON.stringify(part.data);
          return '';
        }).join('\n') ?? ''
      }));

      // Execute agent
  // agent.generate may return a complex response; type as any to avoid TS errors here
  const response: any = await agent.generate(mastraMessages);
  const agentText: string = response?.text ?? '';

      // Build artifacts array
  const artifacts: Array<any> = [
        {
          artifactId: randomUUID(),
          name: `${agentId}Response`,
          parts: [{ kind: 'text', text: agentText }]
        }
      ];

      // Add tool results as artifacts
  if (response?.toolResults && Array.isArray(response.toolResults) && response.toolResults.length > 0) {
        artifacts.push({
          artifactId: randomUUID(),
          name: 'ToolResults',
          parts: response.toolResults.map((result: unknown) => ({
              kind: 'data',
              data: result as unknown
            }))
        });
      }

      // Build conversation history
      const history = [
        ...messagesList.map((msg) => ({
          kind: 'message',
          role: msg.role,
          parts: msg.parts ?? [],
          messageId: msg.messageId ?? randomUUID(),
          taskId: msg.taskId ?? taskId ?? randomUUID(),
        })),
        {
          kind: 'message',
          role: 'agent',
          parts: [{ kind: 'text', text: agentText }],
          messageId: randomUUID(),
          taskId: taskId ?? randomUUID(),
        }
      ];

      // Return A2A-compliant response
  return c.json({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          id: taskId || randomUUID(),
          contextId: contextId || randomUUID(),
          status: {
            state: 'completed',
            timestamp: new Date().toISOString(),
            message: {
              messageId: randomUUID(),
              role: 'agent',
              parts: [{ kind: 'text', text: agentText }],
              kind: 'message'
            }
          },
          artifacts,
          history,
          kind: 'task'
        }
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'Internal error',
          data: { details: message }
        }
      }, 500);
    }
  }
});