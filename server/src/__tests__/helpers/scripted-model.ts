import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

/**
 * A model that asks for the tool calls a test gives it, one step per model call, and then says what it is told to. What the
 * tests cover is what is ours: what a tool can reach and what it does, not what a model would choose.
 */
export type Step = { tools: Array<{ name: string; args: Record<string, unknown> }> } | { say: string };

export class ScriptedModel extends BaseChatModel {
  seen: BaseMessage[][] = [];
  bound: string[] = [];
  private i = 0;
  constructor(private steps: Step[], params: BaseChatModelParams = {}) { super(params); }
  _llmType() { return 'scripted'; }
  bindTools(tools: Array<{ name: string }>) { this.bound = tools.map(t => t.name); return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)];
    const message = 'say' in step
      ? new AIMessage(step.say)
      : new AIMessage({ content: '', tool_calls: step.tools.map((t, n) => ({ id: `call-${this.i}-${n}`, name: t.name, args: t.args, type: 'tool_call' as const })) });
    return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
  }
}
