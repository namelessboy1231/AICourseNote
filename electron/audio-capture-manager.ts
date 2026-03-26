import { BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import path from 'node:path';

type RuntimePhase = 'idle' | 'starting' | 'recording' | 'paused' | 'stopped' | 'error';

export type TranscriptionRuntimeState = {
  sessionId: string | null;
  phase: RuntimePhase;
  chunkCount: number;
  sampleRate: number | null;
  channelCount: number | null;
  lastPeak: number | null;
  lastError: string | null;
  updatedAt: string | null;
};

type CaptureChunkPayload = {
  sessionId: string;
  sequenceNo: number;
  sampleRate: number;
  channelCount: number;
  peak: number;
  samples: number[];
};

export class AudioCaptureManager {
  private captureWindow: BrowserWindow | null = null;
  private initialized = false;
  private runtimeState: TranscriptionRuntimeState = {
    sessionId: null,
    phase: 'idle',
    chunkCount: 0,
    sampleRate: null,
    channelCount: null,
    lastPeak: null,
    lastError: null,
    updatedAt: null
  };

  private chunkListener: ((payload: CaptureChunkPayload) => void) | null = null;

  constructor() {
    ipcMain.on('capture:ready', () => {
      this.updateState({
        phase: this.runtimeState.sessionId ? this.runtimeState.phase : 'idle'
      });
    });

    ipcMain.on('capture:state', (_event, payload: Partial<TranscriptionRuntimeState>) => {
      this.updateState(payload);
    });

    ipcMain.on('capture:error', (_event, payload: { sessionId?: string; message: string }) => {
      this.updateState({
        sessionId: payload.sessionId ?? this.runtimeState.sessionId,
        phase: 'error',
        lastError: payload.message
      });
    });

    ipcMain.on('capture:chunk', (_event, payload: CaptureChunkPayload) => {
      this.updateState({
        sessionId: payload.sessionId,
        phase: 'recording',
        chunkCount: this.runtimeState.chunkCount + 1,
        sampleRate: payload.sampleRate,
        channelCount: payload.channelCount,
        lastPeak: payload.peak,
        lastError: null
      });

      this.chunkListener?.(payload);
    });
  }

  init() {
    if (this.initialized) {
      return;
    }

    session.defaultSession.setDisplayMediaRequestHandler(
      async (_request, callback) => {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 }
        });

        callback({
          video: sources[0],
          audio: 'loopback' as never
        });
      },
      {
        useSystemPicker: false
      }
    );

    this.initialized = true;
  }

  setChunkListener(listener: (payload: CaptureChunkPayload) => void) {
    this.chunkListener = listener;
  }

  getRuntimeState() {
    return this.runtimeState;
  }

  reportError(message: string, sessionId?: string) {
    this.updateState({
      sessionId: sessionId ?? this.runtimeState.sessionId,
      phase: 'error',
      lastError: message
    });
  }

  async start(sessionId: string) {
    const helperWindow = await this.ensureCaptureWindow();

    this.runtimeState = {
      sessionId,
      phase: 'starting',
      chunkCount: 0,
      sampleRate: null,
      channelCount: null,
      lastPeak: null,
      lastError: null,
      updatedAt: new Date().toISOString()
    };

    helperWindow.webContents.send('capture:start', { sessionId });
  }

  async pause(sessionId: string) {
    if (this.runtimeState.sessionId !== sessionId) {
      return;
    }

    const helperWindow = await this.ensureCaptureWindow();
    helperWindow.webContents.send('capture:pause', { sessionId });
  }

  async resume(sessionId: string) {
    if (this.runtimeState.sessionId !== sessionId) {
      return;
    }

    const helperWindow = await this.ensureCaptureWindow();
    helperWindow.webContents.send('capture:resume', { sessionId });
  }

  async stop(sessionId: string) {
    if (this.runtimeState.sessionId !== sessionId) {
      return;
    }

    const helperWindow = await this.ensureCaptureWindow();
    helperWindow.webContents.send('capture:stop', { sessionId });
    this.updateState({
      phase: 'stopped'
    });
  }

  private updateState(next: Partial<TranscriptionRuntimeState>) {
    this.runtimeState = {
      ...this.runtimeState,
      ...next,
      updatedAt: new Date().toISOString()
    };

    if (this.runtimeState.phase === 'stopped' && next.sessionId === null) {
      this.runtimeState.sessionId = null;
    }
  }

  private async ensureCaptureWindow() {
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      return this.captureWindow;
    }

    this.captureWindow = new BrowserWindow({
      show: false,
      width: 320,
      height: 120,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });

    this.captureWindow.on('closed', () => {
      this.captureWindow = null;
      this.runtimeState = {
        sessionId: null,
        phase: 'idle',
        chunkCount: 0,
        sampleRate: null,
        channelCount: null,
        lastPeak: null,
        lastError: null,
        updatedAt: new Date().toISOString()
      };
    });

    await this.captureWindow.loadFile(path.join(__dirname, '../renderer/capture.html'));
    return this.captureWindow;
  }
}