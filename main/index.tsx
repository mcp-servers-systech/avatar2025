/**
 * Alfred Voice Assistant — Gemini Live (TEXT) -> Azure TTS (audio + visemes)
 * - VAD-first: don't start a turn until speech is detected (~120 ms)
 * - Send mic as 16 kHz PCM Blobs via your createBlob(pcm) utility
 * - Speak ONCE per model turn; fresh Azure push-stream per utterance
 * - Always-on debug panel (top-right) with timestamps & states
 *
 * Requires:
 *   - npm i @google/genai
 *   - index.html loads Azure Speech SDK: <script src="https://aka.ms/csspeech/jsbrowserpackageraw"></script>
 *   - utils.ts exports createBlob(Float32Array): Blob (16 kHz PCM)
 *   - visual-mascot.ts defines <gdm-live-audio-visuals-mascot> with setViseme(id:number)
 */

import { GoogleGenAI, Modality, type Session, type LiveServerMessage } from '@google/genai';
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createBlob } from './utils.ts';
import './visual-mascot';

declare global { interface Window { SpeechSDK: any; GEMINI_API_KEY?: string } }

const LIVE_MODELS = [
  'gemini-live-2.5-flash-preview',
  'gemini-2.0-flash-live-001'   // general availability
];

/* ---------- Tiny WebAudio player for raw 24 kHz PCM (Azure push-out) ---------- */
class PcmaPlayer {
  readonly ctx: AudioContext;
  private playHead = 0;
  private started = false;
  private prebufferSec = 0.12;
  private _basePerfMs = 0;

  constructor(sampleRate = 24000) {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate });
  }
  writePcm16(buf: ArrayBuffer) {
    const i16 = new Int16Array(buf);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;

    const abuf = this.ctx.createBuffer(1, f32.length, this.ctx.sampleRate);
    abuf.copyToChannel(f32, 0, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = abuf;
    src.connect(this.ctx.destination);

    if (!this.started) {
      this.playHead = this.ctx.currentTime + this.prebufferSec;
      this._basePerfMs = performance.now() + this.prebufferSec * 1000;
      this.started = true;
    }
    src.start(this.playHead);
    this.playHead += f32.length / this.ctx.sampleRate;
  }
  get basePerfMs() { return this._basePerfMs; }
  close() { try { this.ctx.close(); } catch {} }
}

/* ---------- Component ---------- */
@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  // UI state
  @state() private isRecording = false;
  @state() private status = 'Ready';
  @state() private error = '';

  // Gemini Live
  private ai!: GoogleGenAI;
  private session!: Session;

  // Mic (16 kHz) + VAD
  private ac = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
  private stream?: MediaStream;
  private src?: MediaStreamAudioSourceNode;
  private proc?: ScriptProcessorNode;

  // Manual VAD state
  private vadActive = false;              // whether we've sent activityStart
  private voiceMs = 0;
  private silenceMs = 0;
  private readonly START_THRESH = 0.0045; // speech onset RMS gate
  private readonly START_MIN_MS = 120;    // how long above gate before starting a turn
  private readonly END_SIL_MS = 350;      // silence to end a turn

  // Azure (per-utterance objects)
  @state() private azureKey = '';
  @state() private azureRegion = '';
  @state() private azureVoice = 'en-US-JennyNeural';
  private player?: PcmaPlayer;
  private visemeQueue: Array<{ tMs: number, id: number }> = [];

  // Accumulate model text; speak once when turn ends
  private pendingText = '';
  private tDebounce?: number;

  // Debug panel (always visible)
  @state() private showDebug = true;
  private logs: string[] = [];
  private turn = 0;

  static styles = css`
    :host { display:block; width:100%; height:100vh; position:relative; background:#fff; }

    gdm-live-audio-visuals-mascot {
      position:absolute; top:54%; left:50%; transform:translate(-50%,-50%);
      z-index:5; pointer-events:none;
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
      width:64px; height:64px; border-radius:16px; cursor:pointer; border:1px solid #ddd; background:#f3f3f3;
    }

    .status { position:absolute; bottom:4vh; left:0; right:0; text-align:center; color:#333; font:14px system-ui; }

    /* Debug: big, obvious, fixed to top-right */
    .debug {
      position:fixed; right:16px; top:16px; width:min(42vw,560px); height:64vh; z-index:99;
      background:#0c0c0c; color:#95ff95; border:2px solid #2cf52c; border-radius:12px; padding:10px; overflow:auto;
      font:12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space:pre-wrap;
      box-shadow:0 10px 40px rgba(0,0,0,.4);
    }
    .label { color:#bbb; font-size:12px; align-self:center; }
  `;

  constructor() { super(); this.initGemini(); }

  private log(msg: string, data?: any) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}` + (data ? ` ${JSON.stringify(data)}` : '');
    this.logs.unshift(line);
    if (this.logs.length > 600) this.logs.length = 600;
    // mirror to console
    // eslint-disable-next-line no-console
    console.log('[Alfred]', msg, data ?? '');
    this.requestUpdate();
  }

  /* ---------- Gemini Live (TEXT only, manual activity) ---------- */
  private async initGemini() {
    const key = (import.meta as any).env?.VITE_GEMINI_API_KEY || window.GEMINI_API_KEY;
    if (!key) { this.updateStatus('Add VITE_GEMINI_API_KEY in .env.local or set window.GEMINI_API_KEY.'); return; }

    this.ai = new GoogleGenAI({ apiKey: key });

    let lastErr: any;
    for (const model of LIVE_MODELS) {
      try {
        this.session = await this.ai.live.connect({
          model,
          config: {
            responseModalities: [Modality.TEXT],
            // Force conversational behavior; don't ask to "paste text"
            systemInstruction:
              'You are Alfred. Wait for the user to speak; respond after the user finishes their turn (activityEnd). Be brief and conversational.',
            // We'll send activityStart / activityEnd ourselves
            realtimeInputConfig: { automaticActivityDetection: { disabled: true } }
          },
          callbacks: {
            onopen: () => { this.updateStatus(`✅ Connected (${model}) — click Start to speak`); this.log('Gemini connected', { model }); },
            onmessage: (m: LiveServerMessage) => this.onGeminiMessage(m),
            onerror: (e: ErrorEvent) => this.updateError('Gemini error: ' + e.message),
            onclose: (e: CloseEvent) => this.updateStatus(`Connection closed: ${e.reason || '—'}`),
          },
        });
        return;
      } catch (err) { lastErr = err; }
    }
    this.updateError('Failed to connect to Gemini Live: ' + (lastErr?.message || lastErr));
  }

  private onGeminiMessage(message: LiveServerMessage) {
    const sc: any = (message as any).serverContent;
    if (!sc) return;

    // 1) Accumulate any text parts
    const parts = sc?.modelTurn?.parts || [];
    for (const p of parts) if (p?.text) this.pendingText += p.text;

    // 2) Speak ONCE per turn when server marks completion
    if (sc.generationComplete || sc.turnComplete) {
      const text = this.pendingText.trim(); this.pendingText = '';
      if (text) this.azureSpeak(text);
    } else {
      // Fallback: short debounce if the server doesn't send flags
      if (this.tDebounce) clearTimeout(this.tDebounce);
      this.tDebounce = window.setTimeout(() => {
        const text = this.pendingText.trim(); this.pendingText = '';
        if (text) this.azureSpeak(text);
      }, 160);
    }
  }

  /* ---------- Azure TTS (fresh stream per utterance) + visemes ---------- */
  private azureSpeak(text: string) {
    const SDK = window.SpeechSDK;
    if (!SDK) { this.updateError('Azure Speech SDK not loaded'); return; }
    if (!this.azureKey || !this.azureRegion) { this.updateStatus('Enter Azure key & region'); return; }

    // 1) Config voice; ask for raw 24 kHz PCM (property, not setter)
    const speechConfig = SDK.SpeechConfig.fromSubscription(this.azureKey, this.azureRegion);
    speechConfig.speechSynthesisVoiceName = this.azureVoice;
    if ((SDK as any).SpeechSynthesisOutputFormat?.Raw24Khz16BitMonoPcm !== undefined) {
      (speechConfig as any).speechSynthesisOutputFormat = (SDK as any).SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
    }

    // 2) Fresh player + push stream + synthesizer for THIS utterance
    this.player?.close();
    this.player = new PcmaPlayer(24000);
    this.visemeQueue.length = 0;

    const push = SDK.PushAudioOutputStream.create({
      write: (dataBuffer: ArrayBuffer) => {
        this.player!.writePcm16(dataBuffer);
        // Once playback begins (base time known), flush queued visemes
        if (this.player!.basePerfMs && this.visemeQueue.length) this.flushQueuedVisemes();
        return dataBuffer.byteLength;
      },
      close: () => {}
    });
    const audioConfig = SDK.AudioConfig.fromStreamOutput(push);
    const synth = new SDK.SpeechSynthesizer(speechConfig, audioConfig);

    // 3) Visemes: schedule by audioOffset ticks (100 ns) relative to playback base
    synth.visemeReceived = (_: any, e: any) => {
      const tMs = e.audioOffset / 10000; // ticks -> ms (100 ns ticks)
      const base = this.player!.basePerfMs;
      if (!base) { this.visemeQueue.push({ tMs, id: e.visemeId }); return; }
      const eta = Math.max(0, tMs - (performance.now() - base));
      window.setTimeout(() => this.mascot?.setViseme?.(e.visemeId), eta);
    };
    synth.synthesisCompleted = () => {
      window.setTimeout(() => this.mascot?.setViseme?.(0), 120);
      try { synth.close(); } catch {}
    };

    this.log('Azure speak', { text: text.slice(0, 120) });
    synth.speakTextAsync(
      text,
      () => {},
      (err: any) => { console.error(err); this.updateError('Azure TTS error: ' + err); try { synth.close(); } catch {} }
    );
  }

  private flushQueuedVisemes() {
    const base = this.player!.basePerfMs;
    if (!base) return;
    this.log('Flushing queued visemes', { count: this.visemeQueue.length });
    for (const v of this.visemeQueue) {
      const eta = Math.max(0, v.tMs - (performance.now() - base));
      window.setTimeout(() => this.mascot?.setViseme?.(v.id), eta);
    }
    this.visemeQueue.length = 0;
  }

  private get mascot() {
    return this.renderRoot?.querySelector('gdm-live-audio-visuals-mascot') as any;
  }

  /* ---------- Mic -> Gemini (VAD-first; send Blobs only during a turn) ---------- */
  private async startRecording() {
    if (this.isRecording) return;
    try {
      await this.ac.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: false },
        video: false
      });

      this.src = this.ac.createMediaStreamSource(this.stream);
      const bufferSize = 256; // ~16 ms @16k
      const proc = this.ac.createScriptProcessor(bufferSize, 1, 1);
      this.proc = proc;

      // Reset VAD
      this.vadActive = false;
      this.voiceMs = 0;
      this.silenceMs = 0;
      this.turn++;
      this.log(`TURN #${this.turn} — listening…`);

      proc.onaudioprocess = (ev) => {
        if (!this.isRecording) return;
        const pcm = ev.inputBuffer.getChannelData(0);

        // RMS for VAD
        let sum = 0; for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
        const rms = Math.sqrt(sum / pcm.length);
        const voiced = rms > this.START_THRESH;

        if (!this.vadActive) {
          // Wait for speech onset ~120 ms before starting the turn
          if (voiced) this.voiceMs += (pcm.length / 16000) * 1000; else this.voiceMs = 0;

          if (this.voiceMs >= this.START_MIN_MS) {
            this.session?.sendRealtimeInput?.({ activityStart: {} });
            this.vadActive = true;
            this.log(`TURN #${this.turn} — activityStart sent`);
            // send this current buffer as first chunk
            this.session?.sendRealtimeInput?.({ media: createBlob(pcm) });
          }
          return;
        }

        // In a turn: stream mic as 16 kHz PCM Blob (your util)
        this.session?.sendRealtimeInput?.({ media: createBlob(pcm) });

        // End after ~350 ms of silence
        if (voiced) {
          this.silenceMs = 0;
        } else {
          this.silenceMs += (pcm.length / 16000) * 1000;
          if (this.silenceMs > this.END_SIL_MS) {
            this.session?.sendRealtimeInput?.({ activityEnd: {} });
            this.vadActive = false;
            this.voiceMs = 0;
            this.silenceMs = 0;
            this.log(`TURN #${this.turn} — activityEnd sent`);
          }
        }
      };

      this.src.connect(proc);
      proc.connect(this.ac.destination);

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

    if (this.vadActive) { this.session?.sendRealtimeInput?.({ activityEnd: {} }); this.vadActive = false; }

    this.proc?.disconnect(); this.proc = undefined;
    this.src?.disconnect();  this.src = undefined;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = undefined;

    this.updateStatus('⏸️ Stopped');
  }

  // helpers
  private updateStatus(s: string) { this.status = s; this.error = ''; this.log('STATUS ' + s); }
  private updateError(s: string) { this.error = s; this.log('ERROR ' + s); }
  private resetSession() { try { this.session?.close?.(); } catch {} this.initGemini(); }
  private applyAzure() { /* per-utterance synth now; nothing to pre-create */ }

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

        <!-- Quick voice presets (adds male Arabic + male Tamil) -->
        <div class="row">
          <div class="label">Quick voice presets</div>
          <select @change=${(e:any)=>{ const v=e.target.value; if(v){ this.azureVoice=v; this.requestUpdate(); } }}>
            <option value="">— Select a preset —</option>
            <!-- Tamil -->
            <option value="ta-IN-ValluvarNeural">Tamil (India) — Valluvar (Male)</option>
            <option value="ta-IN-PallaviNeural">Tamil (India) — Pallavi (Female)</option>
            <!-- Arabic (pick the one that matches your content/locale) -->
            <option value="ar-SA-HamedNeural">Arabic (Saudi Arabia) — Hamed (Male)</option>
            <option value="ar-EG-ShakirNeural">Arabic (Egypt) — Shakir (Male)</option>
            <option value="ar-AE-FahedNeural">Arabic (U.A.E.) — Fahed (Male)</option>
            <!-- A couple English male/female for convenience -->
            <option value="en-US-GuyNeural">English (US) — Guy (Male)</option>
            <option value="en-US-JennyNeural">English (US) — Jenny (Female)</option>
          </select>
        </div>

        <!-- Current voice value (you can still select or type any Azure voice name) -->
        <div class="row">
          <select .value=${this.azureVoice} @change=${(e:any)=>this.azureVoice=e.target.value}>
            <option>en-US-JennyNeural</option>
            <option>en-US-AriaNeural</option>
            <option>en-GB-RyanNeural</option>
            <option>en-US-GuyNeural</option>
            <option>ta-IN-ValluvarNeural</option>
            <option>ta-IN-PallaviNeural</option>
            <option>ar-SA-HamedNeural</option>
            <option>ar-EG-ShakirNeural</option>
            <option>ar-AE-FahedNeural</option>
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

      ${this.showDebug ? html`
        <div class="debug">
${this.logs.join('\n')}
        </div>` : null}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'gdm-live-audio': GdmLiveAudio; } }
