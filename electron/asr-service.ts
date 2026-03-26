import WebSocket from 'ws';

const DASHSCOPE_REALTIME_DEFAULT_MODEL = 'qwen3-asr-flash-realtime';

type AsrConnectionState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'error';

export type AsrRuntimeState = {
  sessionId: string | null;
  provider: string | null;
  model: string | null;
  connectionState: AsrConnectionState;
  sentChunkCount: number;
  receivedMessageCount: number;
  lastEventType: string | null;
  lastError: string | null;
  lastMessagePreview: string | null;
  updatedAt: string | null;
};

function normalizeDashScopeModel(model: string) {
  const normalizedModel = model.trim();

  if (!normalizedModel || normalizedModel === 'paraformer-realtime-v2') {
    return DASHSCOPE_REALTIME_DEFAULT_MODEL;
  }

  return normalizedModel;
}

type AudioChunkPayload = {
  sessionId: string;
  sequenceNo: number;
  sampleRate: number;
  channelCount: number;
  peak: number;
  samples: number[];
};

type AsrSessionConfig = {
  sessionId: string;
  notebookId: string;
  noteId: string | null;
  language: string;
  provider: string;
  model: string;
  apiKey: string;
};

type ProviderSegment = {
  text: string;
  normalizedText?: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  isFinal: boolean;
  confidence?: number | null;
  rawPayload?: string | null;
  speakerLabel?: string | null;
};

type StreamingAsrProvider = {
  start: (config: AsrSessionConfig) => Promise<void>;
  handleChunk: (chunk: AudioChunkPayload) => Promise<ProviderSegment[]>;
  pause?: () => Promise<void>;
  resume?: () => Promise<void>;
  stop: () => Promise<ProviderSegment[]>;
};

type ActiveSessionContext = {
  config: AsrSessionConfig;
  provider: StreamingAsrProvider;
  segmentSequence: number;
};

type ServiceCallbacks = {
  onSegment: (payload: {
    sessionId: string;
    notebookId: string;
    noteId: string | null;
    sequenceNo: number;
    segment: ProviderSegment;
  }) => Promise<void> | void;
  onError: (payload: { sessionId: string; message: string }) => Promise<void> | void;
};

class MockAsrProvider implements StreamingAsrProvider {
  private chunkCount = 0;

  async start() {}

  async handleChunk(chunk: AudioChunkPayload) {
    this.chunkCount += 1;

    if (this.chunkCount % 12 !== 0) {
      return [];
    }

    const averageAmplitude =
      chunk.samples.reduce((total, sample) => total + Math.abs(sample), 0) / Math.max(chunk.samples.length, 1);
    const blockIndex = Math.floor(this.chunkCount / 12);
    const startMs = (blockIndex - 1) * 3000;
    const endMs = blockIndex * 3000;

    return [
      {
        text: `系统音频片段 ${blockIndex}，当前平均振幅 ${averageAmplitude.toFixed(3)}，峰值 ${chunk.peak.toFixed(3)}。`,
        normalizedText: null,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        isFinal: true,
        confidence: 0.88,
        rawPayload: JSON.stringify({ type: 'mock-asr', averageAmplitude, peak: chunk.peak }),
        speakerLabel: null
      }
    ];
  }

  async stop() {
    return [];
  }
}

class DashScopeRealtimeAsrProvider implements StreamingAsrProvider {
  private ws: WebSocket | null = null;
  private readonly queuedSegments: ProviderSegment[] = [];
  private pendingError: Error | null = null;
  private finished = false;
  private readonly stopWaiters: Array<() => void> = [];
  private lastPartialText = '';
  private currentStartMs = 0;
  private currentEndMs = 0;

  constructor(private readonly onRuntime: (payload: Partial<AsrRuntimeState>) => void) {}

  async start(config: AsrSessionConfig) {
    if (!config.apiKey.trim()) {
      throw new Error('DashScope API key 为空，请先在“设置”中填写语音转写 API key。');
    }

    const model = normalizeDashScopeModel(config.model);
    const url = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;

    this.onRuntime({
      sessionId: config.sessionId,
      provider: config.provider,
      model,
      connectionState: 'connecting',
      sentChunkCount: 0,
      receivedMessageCount: 0,
      lastEventType: null,
      lastError: null,
      lastMessagePreview: null
    });

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey.trim()}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      const cleanup = () => {
        ws.removeAllListeners('open');
        ws.removeAllListeners('error');
      };

      ws.once('open', () => {
        cleanup();
        this.ws = ws;
        this.onRuntime({
          connectionState: 'open',
          lastError: null,
          lastMessagePreview: 'DashScope WebSocket connected'
        });

        ws.on('message', (message) => {
          this.handleMessage(String(message));
        });

        ws.on('error', (error) => {
          const nextError = error instanceof Error ? error : new Error('DashScope WebSocket 出现未知错误。');
          this.pendingError = nextError;
          this.onRuntime({
            connectionState: 'error',
            lastError: nextError.message
          });
        });

        ws.on('close', () => {
          this.finished = true;
          this.onRuntime({
            connectionState: 'closed'
          });
          this.flushStopWaiters();
        });

        ws.send(
          JSON.stringify({
            event_id: `event_${Date.now()}`,
            type: 'session.update',
            session: {
              modalities: ['text'],
              input_audio_format: 'pcm',
              sample_rate: 16000,
              input_audio_transcription: {
                model,
                language: config.language === 'zh-CN' ? 'zh' : config.language
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0,
                silence_duration_ms: 400
              }
            }
          })
        );

        resolve();
      });

      ws.once('error', (error) => {
        cleanup();
        this.onRuntime({
          connectionState: 'error',
          lastError: error instanceof Error ? error.message : 'DashScope 连接失败。'
        });
        reject(error);
      });
    });
  }

  async handleChunk(chunk: AudioChunkPayload) {
    this.throwIfErrored();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return this.drainSegments();
    }

    const pcmBuffer = this.float32ToPcm16(chunk.samples);
    this.currentEndMs += Math.round((chunk.samples.length / Math.max(chunk.sampleRate, 1)) * 1000);
    this.onRuntime({
      sentChunkCount: chunk.sequenceNo
    });

    this.ws.send(
      JSON.stringify({
        event_id: `event_${Date.now()}_${chunk.sequenceNo}`,
        type: 'input_audio_buffer.append',
        audio: pcmBuffer.toString('base64')
      })
    );

    return this.drainSegments();
  }

  async stop() {
    this.throwIfErrored();

    if (!this.ws) {
      return this.drainSegments();
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      this.onRuntime({
        connectionState: 'closing'
      });
      this.ws.send(
        JSON.stringify({
          event_id: `event_${Date.now()}_finish`,
          type: 'session.finish'
        })
      );
    }

    await new Promise<void>((resolve) => {
      if (this.finished || !this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        resolve();
      }, 5000);

      this.stopWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'session finished');
    }

    this.throwIfErrored();
    return this.drainSegments();
  }

  private handleMessage(rawMessage: string) {
    try {
      const payload = JSON.parse(rawMessage) as Record<string, unknown>;
      const type = String(payload.type ?? '');
      const errorMessage = this.extractErrorMessage(payload);
      const partialText = this.extractPartialText(payload);
      const finalText = this.extractFinalText(payload);

      this.onRuntime({
        receivedMessageCount: undefined,
        lastEventType: type || 'unknown',
        lastMessagePreview: rawMessage.slice(0, 240)
      });

      if (errorMessage) {
        this.pendingError = new Error(errorMessage);
        this.onRuntime({
          connectionState: 'error',
          lastError: errorMessage
        });
        return;
      }

      if (
        [
          'conversation.item.input_audio_transcription.text',
          'conversation.item.input_audio_transcription.delta',
          'response.audio_transcript.delta'
        ].includes(type) &&
        partialText
      ) {
        this.lastPartialText = partialText;
        this.queuedSegments.push({
          text: this.lastPartialText,
          normalizedText: null,
          startMs: this.currentStartMs,
          endMs: this.currentEndMs,
          durationMs: Math.max(this.currentEndMs - this.currentStartMs, 0),
          isFinal: false,
          confidence: null,
          rawPayload: rawMessage,
          speakerLabel: null
        });
        return;
      }

      if (
        [
          'conversation.item.input_audio_transcription.completed',
          'conversation.item.input_audio_transcription.done',
          'response.audio_transcript.done'
        ].includes(type)
      ) {
        if (finalText) {
          this.queuedSegments.push({
            text: finalText,
            normalizedText: null,
            startMs: this.currentStartMs,
            endMs: this.currentEndMs,
            durationMs: Math.max(this.currentEndMs - this.currentStartMs, 0),
            isFinal: true,
            confidence: null,
            rawPayload: rawMessage,
            speakerLabel: null
          });
          this.currentStartMs = this.currentEndMs;
          this.lastPartialText = '';
        }
        return;
      }

      if (type === 'session.finished') {
        this.finished = true;
        this.flushStopWaiters();
        this.onRuntime({
          connectionState: 'closed'
        });
      }
    } catch (error) {
      const nextError = error instanceof Error ? error : new Error('DashScope 消息解析失败。');
      this.pendingError = nextError;
      this.onRuntime({
        connectionState: 'error',
        lastError: nextError.message
      });
    }
  }

  private float32ToPcm16(samples: number[]) {
    const buffer = Buffer.alloc(samples.length * 2);

    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
      const int16 = sample < 0 ? sample * 32768 : sample * 32767;
      buffer.writeInt16LE(Math.round(int16), index * 2);
    }

    return buffer;
  }

  private extractPartialText(payload: Record<string, unknown>) {
    return this.extractStringValue(payload, [['text'], ['delta'], ['item', 'content', 0, 'text'], ['item', 'content', 0, 'delta']]);
  }

  private extractFinalText(payload: Record<string, unknown>) {
    return (
      this.extractStringValue(payload, [
        ['transcript'],
        ['text'],
        ['item', 'content', 0, 'transcript'],
        ['item', 'content', 0, 'text']
      ]) || this.lastPartialText
    ).trim();
  }

  private extractErrorMessage(payload: Record<string, unknown>) {
    const directError = this.extractStringValue(payload, [['message'], ['error', 'message'], ['error'], ['detail']]);

    if (String(payload.type ?? '') === 'error' && directError) {
      return directError;
    }

    if (payload.error && directError) {
      return directError;
    }

    return '';
  }

  private extractStringValue(payload: Record<string, unknown>, paths: Array<Array<string | number>>) {
    for (const path of paths) {
      let current: unknown = payload;

      for (const part of path) {
        if (current === null || current === undefined) {
          current = undefined;
          break;
        }

        current = (current as Record<string | number, unknown>)[part];
      }

      if (typeof current === 'string' && current.trim()) {
        return current.trim();
      }
    }

    return '';
  }

  private drainSegments() {
    if (this.queuedSegments.length === 0) {
      return [];
    }

    return this.queuedSegments.splice(0, this.queuedSegments.length);
  }

  private throwIfErrored() {
    if (!this.pendingError) {
      return;
    }

    const error = this.pendingError;
    this.pendingError = null;
    throw error;
  }

  private flushStopWaiters() {
    while (this.stopWaiters.length > 0) {
      this.stopWaiters.shift()?.();
    }
  }
}

class UnsupportedAsrProvider implements StreamingAsrProvider {
  constructor(private readonly provider: string) {}

  async start(config: AsrSessionConfig) {
    if (!config.apiKey.trim()) {
      throw new Error(`当前转写 provider ${this.provider} 还未填写 API key，请先在“设置”中完成配置。`);
    }
  }

  async handleChunk(_chunk: AudioChunkPayload): Promise<ProviderSegment[]> {
    throw new Error(
      `当前转写 provider ${this.provider} 的真实请求逻辑尚未实现。你可以先将 provider 改成 mock-asr 继续联调，或继续让我按你的服务商实现该 provider。`
    );
  }

  async stop() {
    return [];
  }
}

function createProvider(config: AsrSessionConfig, onRuntime: (payload: Partial<AsrRuntimeState>) => void): StreamingAsrProvider {
  if (config.provider === 'mock-asr') {
    return new MockAsrProvider();
  }

  if (['dashscope-asr', 'dashscope', 'qwen3-asr-flash-realtime'].includes(config.provider)) {
    return new DashScopeRealtimeAsrProvider(onRuntime);
  }

  return new UnsupportedAsrProvider(config.provider);
}

export class AsrTranscriptionService {
  private readonly sessions = new Map<string, ActiveSessionContext>();
  private runtimeState: AsrRuntimeState = {
    sessionId: null,
    provider: null,
    model: null,
    connectionState: 'idle',
    sentChunkCount: 0,
    receivedMessageCount: 0,
    lastEventType: null,
    lastError: null,
    lastMessagePreview: null,
    updatedAt: null
  };

  constructor(private readonly callbacks: ServiceCallbacks) {}

  async startSession(config: AsrSessionConfig) {
    this.updateRuntimeState({
      sessionId: config.sessionId,
      provider: config.provider,
      model: config.model,
      connectionState: 'connecting',
      sentChunkCount: 0,
      receivedMessageCount: 0,
      lastEventType: null,
      lastError: null,
      lastMessagePreview: null
    });

    const provider = createProvider(config, (payload) => {
      const nextReceivedCount =
        payload.lastMessagePreview !== undefined && payload.receivedMessageCount === undefined
          ? this.runtimeState.receivedMessageCount + 1
          : payload.receivedMessageCount;

      this.updateRuntimeState({
        ...payload,
        sessionId: config.sessionId,
        provider: config.provider,
        model: config.model,
        receivedMessageCount: nextReceivedCount ?? this.runtimeState.receivedMessageCount
      });
    });
    await provider.start(config);

    this.sessions.set(config.sessionId, {
      config,
      provider,
      segmentSequence: 0
    });
  }

  async handleAudioChunk(chunk: AudioChunkPayload) {
    const context = this.sessions.get(chunk.sessionId);

    if (!context) {
      return;
    }

    try {
      this.updateRuntimeState({
        sessionId: chunk.sessionId,
        sentChunkCount: chunk.sequenceNo
      });

      const segments = await context.provider.handleChunk(chunk);

      for (const segment of segments) {
        context.segmentSequence += 1;

        await this.callbacks.onSegment({
          sessionId: chunk.sessionId,
          notebookId: context.config.notebookId,
          noteId: context.config.noteId,
          sequenceNo: context.segmentSequence,
          segment
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ASR 处理失败。';
      this.sessions.delete(chunk.sessionId);
      this.updateRuntimeState({
        sessionId: chunk.sessionId,
        connectionState: 'error',
        lastError: message
      });
      await this.callbacks.onError({ sessionId: chunk.sessionId, message });
    }
  }

  async pauseSession(sessionId: string) {
    const context = this.sessions.get(sessionId);
    await context?.provider.pause?.();
  }

  async resumeSession(sessionId: string) {
    const context = this.sessions.get(sessionId);
    await context?.provider.resume?.();
  }

  async stopSession(sessionId: string) {
    const context = this.sessions.get(sessionId);

    if (!context) {
      return;
    }

    try {
      this.updateRuntimeState({
        sessionId,
        connectionState: 'closing'
      });

      const finalSegments = await context.provider.stop();

      for (const segment of finalSegments) {
        context.segmentSequence += 1;

        await this.callbacks.onSegment({
          sessionId,
          notebookId: context.config.notebookId,
          noteId: context.config.noteId,
          sequenceNo: context.segmentSequence,
          segment
        });
      }
    } finally {
      this.sessions.delete(sessionId);
      this.updateRuntimeState({
        sessionId,
        connectionState: 'closed'
      });
    }
  }

  getRuntimeState() {
    return this.runtimeState;
  }

  private updateRuntimeState(next: Partial<AsrRuntimeState>) {
    this.runtimeState = {
      ...this.runtimeState,
      ...next,
      updatedAt: new Date().toISOString()
    };
  }
}

export type { AudioChunkPayload, AsrSessionConfig, ProviderSegment };