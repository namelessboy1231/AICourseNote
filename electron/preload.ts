import { contextBridge, ipcRenderer } from 'electron';

type Unsubscribe = () => void;

function onChannel<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const captureState: {
  sessionId: string | null;
  stream: MediaStream | null;
  audioContext: AudioContext | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  processorNode: ScriptProcessorNode | null;
  sinkNode: GainNode | null;
  paused: boolean;
  sequenceNo: number;
} = {
  sessionId: null,
  stream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  sinkNode: null,
  paused: false,
  sequenceNo: 0
};

function isCapturePage() {
  return window.location.pathname.endsWith('/capture.html') || window.location.pathname.endsWith('capture.html');
}

async function stopCaptureSession(notifyStopped = true) {
  captureState.processorNode?.disconnect();
  captureState.sourceNode?.disconnect();
  captureState.sinkNode?.disconnect();
  captureState.stream?.getTracks().forEach((track) => track.stop());

  if (captureState.audioContext && captureState.audioContext.state !== 'closed') {
    await captureState.audioContext.close();
  }

  captureState.sessionId = null;
  captureState.stream = null;
  captureState.audioContext = null;
  captureState.sourceNode = null;
  captureState.processorNode = null;
  captureState.sinkNode = null;
  captureState.paused = false;
  captureState.sequenceNo = 0;

  if (notifyStopped) {
    ipcRenderer.send('capture:state', {
      phase: 'stopped'
    });
  }
}

async function startCaptureSession(sessionId: string) {
  await stopCaptureSession(false);
  captureState.sessionId = sessionId;
  captureState.sequenceNo = 0;
  captureState.paused = false;

  ipcRenderer.send('capture:state', {
    sessionId,
    phase: 'starting'
  });

  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: {
      frameRate: 1,
      width: { ideal: 16 },
      height: { ideal: 16 }
    }
  });

  const audioTracks = stream.getAudioTracks();

  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('未获取到系统音频轨道，请确认当前系统存在正在播放的音频输出。');
  }

  stream.getVideoTracks().forEach((track) => track.stop());

  const audioOnlyStream = new MediaStream(audioTracks);
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const sourceNode = audioContext.createMediaStreamSource(audioOnlyStream);
  const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  const sinkNode = audioContext.createGain();
  sinkNode.gain.value = 0;

  processorNode.onaudioprocess = (event) => {
    if (captureState.paused || !captureState.sessionId) {
      return;
    }

    const samples = Array.from(event.inputBuffer.getChannelData(0));
    let peak = 0;

    for (const sample of samples) {
      const absolute = Math.abs(sample);

      if (absolute > peak) {
        peak = absolute;
      }
    }

    captureState.sequenceNo += 1;

    ipcRenderer.send('capture:chunk', {
      sessionId: captureState.sessionId,
      sequenceNo: captureState.sequenceNo,
      sampleRate: event.inputBuffer.sampleRate,
      channelCount: event.inputBuffer.numberOfChannels,
      peak,
      samples
    });
  };

  sourceNode.connect(processorNode);
  processorNode.connect(sinkNode);
  sinkNode.connect(audioContext.destination);

  captureState.stream = audioOnlyStream;
  captureState.audioContext = audioContext;
  captureState.sourceNode = sourceNode;
  captureState.processorNode = processorNode;
  captureState.sinkNode = sinkNode;

  ipcRenderer.send('capture:state', {
    sessionId,
    phase: 'recording'
  });
}

if (isCapturePage()) {
  window.addEventListener('DOMContentLoaded', () => {
    document.body.innerHTML = '<div style="font-family:Segoe UI,Microsoft YaHei UI,sans-serif;padding:16px;color:#44556c;background:#f4f8ff;">AICourseNote audio capture helper</div>';
  });

  ipcRenderer.on('capture:start', (_event, payload: { sessionId: string }) => {
    void startCaptureSession(payload.sessionId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '未知采集错误';
      ipcRenderer.send('capture:error', { sessionId: payload.sessionId, message });
    });
  });

  ipcRenderer.on('capture:pause', async () => {
    captureState.paused = true;
    await captureState.audioContext?.suspend();
    ipcRenderer.send('capture:state', {
      sessionId: captureState.sessionId,
      phase: 'paused'
    });
  });

  ipcRenderer.on('capture:resume', async () => {
    captureState.paused = false;
    await captureState.audioContext?.resume();
    ipcRenderer.send('capture:state', {
      sessionId: captureState.sessionId,
      phase: 'recording'
    });
  });

  ipcRenderer.on('capture:stop', () => {
    void stopCaptureSession(true);
  });

  ipcRenderer.send('capture:ready');
}

const api = {
  getSnapshot: () => ipcRenderer.invoke('notes:getSnapshot'),
  createNotebook: (name: string) => ipcRenderer.invoke('notes:createNotebook', { name }),
  renameNotebook: (notebookId: string, name: string) =>
    ipcRenderer.invoke('notes:renameNotebook', { notebookId, name }),
  deleteNotebook: (notebookId: string) =>
    ipcRenderer.invoke('notes:deleteNotebook', { notebookId }),
  createNote: (notebookId: string) => ipcRenderer.invoke('notes:createNote', { notebookId }),
  updateNote: (noteId: string, title: string, contentHtml: string) =>
    ipcRenderer.invoke('notes:updateNote', { noteId, title, contentHtml }),
  deleteNote: (noteId: string) => ipcRenderer.invoke('notes:deleteNote', { noteId }),
  exportNotePdf: (title: string, contentHtml: string) =>
    ipcRenderer.invoke('notes:exportPdf', { title, contentHtml }),
  saveImage: (dataUrl: string, originalName?: string) =>
    ipcRenderer.invoke('notes:saveImage', { dataUrl, originalName }),
  startTranscription: (payload: {
    notebookId: string;
    noteId?: string | null;
    title?: string;
    language?: string;
    provider?: string;
    model?: string;
  }) => ipcRenderer.invoke('transcription:start', payload),
  pauseTranscription: (sessionId: string) => ipcRenderer.invoke('transcription:pause', { sessionId }),
  resumeTranscription: (sessionId: string) => ipcRenderer.invoke('transcription:resume', { sessionId }),
  stopTranscription: (sessionId: string) => ipcRenderer.invoke('transcription:stop', { sessionId }),
  getTranscriptionRuntimeState: () => ipcRenderer.invoke('transcription:getRuntimeState'),
  onTranscriptionSegment: (listener: (payload: {
    sessionId: string;
    noteId: string | null;
    sequenceNo: number;
    text: string;
    isFinal: boolean;
  }) => void) => onChannel('transcription:segment', listener),
  onTranscriptionError: (listener: (payload: { sessionId: string; message: string }) => void) =>
    onChannel('transcription:error', listener),
  createAiAnalysis: (payload: {
    notebookId: string;
    noteId?: string | null;
    sessionId?: string | null;
    analysisType: 'summary' | 'key-points' | 'outline' | 'review-questions' | 'action-items';
  }) => ipcRenderer.invoke('ai:createJob', payload),
  deleteAiAnalysis: (jobId: string) => ipcRenderer.invoke('ai:deleteJob', { jobId }),
  saveAiAnalysisAsNote: (jobId: string, title?: string) => ipcRenderer.invoke('ai:saveAsNote', { jobId, title }),
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  saveSettings: (payload: {
    asrProvider: string;
    asrModel: string;
    llmProvider: string;
    llmModel: string;
    asrApiKeyInput?: string | null;
    llmApiKeyInput?: string | null;
    clearAsrApiKey?: boolean;
    clearLlmApiKey?: boolean;
  }) => ipcRenderer.invoke('app:saveSettings', payload)
};

contextBridge.exposeInMainWorld('noteApp', api);

export type DesktopApi = typeof api;
