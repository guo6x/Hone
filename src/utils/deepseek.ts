import { randomUUID } from 'crypto';

export function translateAnthropicToDeepSeek(anthropicBody: any): any {
    const {
        model,
        messages,
        system,
        max_tokens,
        stream,
        tools,
        tool_choice,
        temperature,
        stop_sequences
    } = anthropicBody;

    const deepseekMessages = [];

    // 1. Handle system prompt
    if (system) {
        if (Array.isArray(system)) {
            deepseekMessages.push({
                role: 'system',
                content: system.map((s: any) => s.text || s).join('\n')
            });
        } else {
            deepseekMessages.push({
                role: 'system',
                content: system
            });
        }
    }

    // 2. Handle messages
    for (const msg of messages) {
        const role = msg.role;
        const content = msg.content;

        if (typeof content === 'string') {
            deepseekMessages.push({ role, content });
        } else if (Array.isArray(content)) {
            let reasoningContent = '';
            const openaiContent: any[] = [];
            const toolCalls: any[] = [];
            
            for (const part of content) {
                if (part.type === 'text') {
                    openaiContent.push({ type: 'text', text: part.text });
                } else if (part.type === 'image') {
                    openaiContent.push({
                        type: 'image_url',
                        image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` }
                    });
                } else if (part.type === 'tool_use') {
                    toolCalls.push({
                        id: part.id,
                        type: 'function',
                        function: {
                            name: part.name,
                            arguments: JSON.stringify(part.input)
                        }
                    });
                } else if (part.type === 'tool_result') {
                    deepseekMessages.push({
                        role: 'tool',
                        tool_call_id: part.tool_use_id,
                        content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
                    });
                } else if (part.type === 'thinking') {
                    if (role === 'assistant') {
                        reasoningContent += part.thinking;
                    } else {
                        const thinkingText = `<thought>\n${part.thinking}\n</thought>\n\n`;
                        openaiContent.unshift({ type: 'text', text: thinkingText });
                    }
                }
            }

            if (openaiContent.length > 0 || toolCalls.length > 0 || reasoningContent) {
                const message: any = { role };
                if (reasoningContent) {
                    message.reasoning_content = reasoningContent;
                }
                if (openaiContent.length > 0) {
                    message.content = openaiContent.length === 1 && openaiContent[0].type === 'text' 
                        ? openaiContent[0].text 
                        : openaiContent;
                } else {
                    message.content = ""; 
                }

                if (toolCalls.length > 0) {
                    message.tool_calls = toolCalls;
                    if (message.content === undefined) message.content = "";
                }
                deepseekMessages.push(message);
            }
        }
    }

    // 3. Handle tools
    const deepseekTools = tools?.map((t: any) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema
        }
    }));

    // 4. Handle tool_choice
    let deepseekToolChoice = undefined;
    if (tool_choice) {
        if (tool_choice.type === 'auto') {
            deepseekToolChoice = 'auto';
        } else if (tool_choice.type === 'tool') {
            deepseekToolChoice = { type: 'function', function: { name: tool_choice.name } };
        } else if (tool_choice.type === 'any') {
            deepseekToolChoice = 'required';
        }
    }

    return {
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', // DeepSeek Chat is the new standard
        messages: deepseekMessages,
        max_tokens: max_tokens || 4096,
        stream: stream || false,
        tools: deepseekTools,
        tool_choice: deepseekToolChoice,
        temperature: temperature ?? 1,
        stop: stop_sequences
    };
}

export function translateDeepSeekToAnthropic(deepseekRes: any): any {
    const choice = deepseekRes.choices[0];
    const message = choice.message;

    const content: any[] = [];
    if (message.reasoning_content) {
        content.push({ type: 'thinking', thinking: message.reasoning_content, signature: 'dummy' });
    }
    if (message.content) {
        content.push({ type: 'text', text: message.content });
    }

    if (message.tool_calls) {
        for (const tc of message.tool_calls) {
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments)
            });
        }
    }

    const stopReasonMap: Record<string, string> = {
        'stop': 'end_turn',
        'tool_calls': 'tool_use',
        'length': 'max_tokens',
        'content_filter': 'stop_sequence'
    };

    return {
        id: deepseekRes.id,
        type: 'message',
        role: 'assistant',
        model: deepseekRes.model,
        content,
        stop_reason: stopReasonMap[choice.finish_reason] || choice.finish_reason,
        stop_sequence: null,
        usage: {
            input_tokens: deepseekRes.usage.prompt_tokens,
            output_tokens: deepseekRes.usage.completion_tokens
        }
    };
}

export async function* translateDeepSeekStreamToAnthropic(response: Response): AsyncGenerator<any> {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    const messageId = `msg_${randomUUID()}`;

    // Send message_start
    yield {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    };

    let currentContentIndex = 0;
    let currentBlockType: 'text' | 'thinking' | 'tool_use' | null = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const cleaned = line.trim();
            if (!cleaned || cleaned === 'data: [DONE]') continue;
            if (!cleaned.startsWith('data: ')) continue;

            try {
                const chunk = JSON.parse(cleaned.slice(6));
                const delta = chunk.choices[0].delta;

                // Handle reasoning_content delta (DeepSeek thinking)
                if (delta.reasoning_content) {
                    if (currentBlockType !== 'thinking') {
                        if (currentBlockType !== null) yield { type: 'content_block_stop', index: currentContentIndex++ };
                        yield {
                            type: 'content_block_start',
                            index: currentContentIndex,
                            content_block: { type: 'thinking', thinking: '', signature: 'dummy' }
                        };
                        currentBlockType = 'thinking';
                    }
                    yield {
                        type: 'content_block_delta',
                        index: currentContentIndex,
                        delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
                    };
                }

                // Handle text delta
                if (delta.content) {
                    if (currentBlockType !== 'text') {
                        if (currentBlockType !== null) yield { type: 'content_block_stop', index: currentContentIndex++ };
                        yield {
                            type: 'content_block_start',
                            index: currentContentIndex,
                            content_block: { type: 'text', text: '' }
                        };
                        currentBlockType = 'text';
                    }
                    yield {
                        type: 'content_block_delta',
                        index: currentContentIndex,
                        delta: { type: 'text_delta', text: delta.content }
                    };
                }

                // Handle tool calls delta
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (tc.id) {
                            if (currentBlockType !== null) yield { type: 'content_block_stop', index: currentContentIndex++ };
                            
                            yield {
                                type: 'content_block_start',
                                index: currentContentIndex,
                                content_block: { 
                                    type: 'tool_use', 
                                    id: tc.id, 
                                    name: tc.function.name, 
                                    input: {} 
                                }
                            };
                            currentBlockType = 'tool_use';
                        }
                        
                        if (tc.function?.arguments) {
                            yield {
                                type: 'content_block_delta',
                                index: currentContentIndex,
                                delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                            };
                        }
                    }
                }
            } catch (e) {
                // Ignore parse errors for malformed chunks
            }
        }
    }

    if (currentBlockType !== null) {
        yield { type: 'content_block_stop', index: currentContentIndex };
    }

    // Send message_delta and message_stop
    yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 } // DeepSeek might not provide this in stream easily
    };
    yield { type: 'message_stop' };
}
