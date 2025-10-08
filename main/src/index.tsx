/**
 * Alfred Voice Assistant — Gemini Live (TEXT) -> Azure TTS (audio + visemes)
 * Requires:
 *   - npm i @google/genai
 *   - index.html includes the Azure Speech SDK browser bundle (window.SpeechSDK)
 *   - utils.ts exports createBlob(Float32Array): Blob (16kHz PCM)
 *   - visual-mascot.ts defines <gdm-live-audio-visuals-mascot> with setViseme(id:number)
 */

import { GoogleGenAI, Modality, type Session, type LiveServerMessage } from '@google/genai';
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createBlob } from './utils.ts';
import './visual-mascot';

declare global {
  interface Window { SpeechSDK: any }
}

const LIVE_MODELS = [
  'gemini-2.0-flash-live-001',   // safest widely-available Live model
  'gemini-live-2.5-flash-preview'// fallback if your key has preview access
];

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  // ---------- UI state ----------
  @state() private isRecording = false;
  @state() private status = 'Ready';
  @state() private error = '';

  // ---------- Gemini Live ----------
  private ai!: GoogleGenAI;
  private session!: Session;

  // 16 kHz mono input for Live API
  private inputAC = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
  private micStream?: MediaStream;
  private src?: MediaStreamAudioSourceNode;
  private proc?: ScriptProcessorNode;

  // ---------- Azure TTS + Visemes ----------
  @state() private azureKey = '';
  @state() private azureRegion = '';
  @state() private azureVoice = 'en-US-JennyNeural';
  private azureSynth?: any;
  private synthT0 = 0;                 // wall-clock when synthesis starts (for scheduling)
  private mouthResetTimer?: number;

  // ---------- Styles ----------
  static styles = css`
    :host { display:block; width:100%; height:100vh; position:relative; background:#fff; }
    gdm-live-audio-visuals-mascot {
      position:absolute; top:54%; left:50%; transform:translate(-50%,-50%); z-index:5;
      --mouth-top:34%; --mouth-left:50%; --mouth-width:42%;
    }
    .bar {
      position:absolute; top:16px; left:16px; right:16px; z-index:20;
      background:#2f2f2f; color:#fff; border-radius:12px; padding:12px; display:grid; gap:8px;
    }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    input, select, button { font:14px system-ui,sans-serif; padding:8px; border-radius:8px; border:1px solid #ddd; }
    .controls {
      position:absolute; bottom:10vh; left:0; right:0; display:flex; gap:10px; justify-content:center; z-index:10;
    }
    .controls button {
      width:64px; height:64px; border-radius:16px; cursor:pointer; border:1px solid #ddd;
      background:#f3f3f3;
    }
    .status { position:absolute; bottom:4vh; left:0; right:0; text-align:center; color:#333; font:14px system-ui; }
  `;

  constructor() {
    super();
    this.initGemini();
  }

  // ========== Gemini: connect (TEXT output only) ==========
  private async initGemini() {
    const key = (import.meta as any).env?.VITE_GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
    if (!key) {
      this.updateStatus('Add VITE_GEMINI_API_KEY in .env.local or set window.GEMINI_API_KEY.');
      return;
    }

    this.ai = new GoogleGenAI({ apiKey: key });

    let lastErr: any;
    for (const model of LIVE_MODELS) {
      try {
        this.session = await this.ai.live.connect({
          model,
          config: { responseModalities: [Modality.TEXT] },  // TEXT only; Azure handles speech + visemes
          callbacks: {
            onopen: () => this.updateStatus(`✅ Connected (${model}) — click Start to speak`),
            onmessage: (msg: LiveServerMessage) => this.onGeminiMessage(msg),
            onerror: (e: ErrorEvent) => this.updateError('Gemini error: ' + e.message),
            onclose: (e: CloseEvent) => this.updateStatus(`Connection closed: ${e.reason || '—'}`),
          },
        });
        return; // success
      } catch (err) {
        lastErr = err;
      }
    }
    this.updateError('Failed to connect to Gemini Live: ' + (lastErr?.message || lastErr));
  }

  private onGeminiMessage(message: LiveServerMessage) {
    // We only care about TEXT parts (we synthesize with Azure for visemes).
    const parts = (message as any)?.serverContent?.modelTurn?.parts || [];
    for (const p of parts) {
      if (p?.text) this.azureSpeak(p.text);
    }
  }

  // ========== Azure TTS + viseme scheduling ==========
  private ensureAzureSynth() {
    if (this.azureSynth) return this.azureSynth;

    const SDK = window.SpeechSDK;
    if (!SDK) { this.updateError('Azure Speech SDK not loaded'); return; }
    if (!this.azureKey || !this.azureRegion) { this.updateStatus('Enter Azure key & region'); return; }

    const speechConfig = SDK.SpeechConfig.fromSubscription(this.azureKey, this.azureRegion);
    speechConfig.speechSynthesisVoiceName = this.azureVoice;
    const audioConfig = SDK.AudioConfig.fromDefaultSpeakerOutput(); // play to speakers
    this.azureSynth = new SDK.SpeechSynthesizer(speechConfig, audioConfig);

    // mark wallclock when synthesis starts; used to align with speaker playback
    this.azureSynth.synthesisStarted = () => { this.synthT0 = performance.now(); };

    // schedule viseme frames precisely using audioOffset (100ns ticks -> ms)
    this.azureSynth.visemeReceived = (_: any, e: any) => {
      const offsetMs = e.audioOffset / 10000; // ticks->ms
      const eta = Math.max(0, offsetMs - (performance.now() - this.synthT0));
      setTimeout(() => this.mascot?.setViseme?.(e.visemeId), eta);
    };

    this.azureSynth.synthesisCompleted = () => {
      if (this.mouthResetTimer) clearTimeout(this.mouthResetTimer);
      this.mouthResetTimer = window.setTimeout(() => this.mascot?.setViseme?.(0), 120);
    };

    return this.azureSynth;
  }

  private azureSpeak(text: string) {
    const synth = this.ensureAzureSynth();
    if (!synth) return;
    synth.speakTextAsync(
      text,
      () => {},
      (err: any) => {
        console.error(err);
        this.updateError('Azure TTS error: ' + err);
        synth.close();
        this.azureSynth = undefined;
      }
    );
  }

  private get mascot() {
    return this.renderRoot?.querySelector('gdm-live-audio-visuals-mascot') as any;
  }

  // ========== Microphone -> Gemini Live (realtime) ==========
  private async startRecording() {
    if (this.isRecording) return;
    try {
      await this.inputAC.resume();
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.src = this.inputAC.createMediaStreamSource(this.micStream);

      const bufferSize = 256;
      this.proc = this.inputAC.createScriptProcessor(bufferSize, 1, 1);
      this.proc.onaudioprocess = (ev) => {
        if (!this.isRecording) return;
        const pcm = ev.inputBuffer.getChannelData(0);
        // Send raw 16 kHz PCM as Blob — supported by Live API client
        this.session?.sendRealtimeInput?.({ media: createBlob(pcm) });
      };

      this.src.connect(this.proc);
      this.proc.connect(this.inputAC.destination);

      this.isRecording = true;
      this.updateStatus('🎤 Recording — speak now');
    } catch (e: any) {
      console.error(e);
      this.updateError('Mic error: ' + (e?.message || e));
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;

    this.proc?.disconnect(); this.proc = undefined;
    this.src?.disconnect();  this.src = undefined;

    this.micStream?.getTracks().forEach(t => t.stop());
    this.micStream = undefined;

    this.updateStatus('⏸️ Stopped');
  }

  // ========== UI helpers ==========
  private updateStatus(s: string) { this.status = s; this.error = ''; }
  private updateError(s: string) { this.error = s; }

  private resetSession() {
    try { this.session?.close?.(); } catch {}
    this.initGemini();
  }
  private applyAzure() {
    try { this.azureSynth?.close?.(); } catch {}
    this.azureSynth = undefined;
    this.ensureAzureSynth();
  }

  // ========== Render ==========
  render() {
    return html`
      <gdm-live-audio-visuals-mascot></gdm-live-audio-visuals-mascot>

      <div class="bar">
        <div class="row">
          <input placeholder="Azure Speech key" .value=${this.azureKey}
            @input=${(e:any)=>this.azureKey=e.target.value} />
          <input placeholder="Region (e.g. eastus)" .value=${this.azureRegion}
            @input=${(e:any)=>this.azureRegion=e.target.value} />
        </div>
        <div class="row">
          <select .value=${this.azureVoice} @change=${(e:any)=>this.azureVoice=e.target.value}>
            <option>en-US-JennyNeural</option>
            <option>en-US-AriaNeural</option>
            <option>en-GB-RyanNeural</option>
          </select>
          <button @click=${this.applyAzure}>Use Azure voice</button>
        </div>
      </div>

      <div class="controls">
        <button title="Reset" @click=${this.resetSession} ?disabled=${this.isRecording}>⟳</button>
        <button title="Start" @click=${this.startRecording} ?disabled=${this.isRecording}>●</button>
        <button title="Stop"  @click=${this.stopRecording} ?disabled=${!this.isRecording}>■</button>
      </div>

      <div class="status">${this.error || this.status}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio': GdmLiveAudio;
  }
}
