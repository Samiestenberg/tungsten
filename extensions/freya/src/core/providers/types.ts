export type OnDelta = (text: string) => void;

export interface ModelProvider {
    send(messages: any[], tools: any[], onDelta?: OnDelta): Promise<{ content: any[] }>;
  }