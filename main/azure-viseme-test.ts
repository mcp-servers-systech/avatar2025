/**
 * Minimal Azure TTS -> viseme scheduler (browser)
 * Paste your key/region at runtime; do NOT commit secrets.
 */
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

declare global {
  interface Window { SpeechSDK: any }
}

@customElement('azure-viseme-test')
export class AzureVisemeTest extends LitElement {
  static styles = css`
    .panel { display: grid; gap: 8px; margin-top: 16px }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px }
    input, textarea, button, select {
      font: 14px system-ui, sans-serif;
      padding: 8px; border-radius: 8px; border: 1px solid #ddd;
    }
    textarea { min-height: 68px }
    button { cursor: pointer }
  `;

  @state() private speaking = false;
  private synth?: any;

  private get mascot(): any {
    return (this.getRootNode() as Document | ShadowRoot)
      .querySelector('gdm-live-audio-visuals-mascot') as any;
  }

  private speak = async () => {
    const SpeechSDK = window.SpeechSDK;
    if (!SpeechSDK) {
      alert('Azure Speech SDK not loaded');
      return;
    }
    const key    = (this.renderRoot.querySelector('#azKey')    as HTMLInputElement).value.trim();
    const region = (this.renderRoot.querySelector('#azRegion') as HTMLInputElement).value.trim();
    const text   = (this.renderRoot.querySelector('#azText')   as HTMLTextAreaElement).value.trim();
    const voice  = (this.renderRoot.querySelector('#azVoice')  as HTMLSelectElement).value;

    if (!key || !region || !text) {
      alert('Please fill Key, Region, and Text.'); return;
    }

    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(key, region);
    speechConfig.speechSynthesisVoiceName = voice;

    // Play to system speakers (browser only). :contentReference[oaicite:5]{index=5}
    const audioConfig = SpeechSDK.AudioConfig.fromDefaultSpeakerOutput();
    this.synth = new SpeechSDK.SpeechSynthesizer(speechConfig, audioConfig);

    // Align mouth timing to audio using audioOffset ticks (100ns). :contentReference[oaicite:6]{index=6}
    let t0 = 0; // wall clock when audio actually starts flowing
    this.speaking = true;

    this.synth.synthesisStarted = () => { t0 = performance.now(); };

    this.synth.visemeReceived = (_sender: any, e: any) => {
      const offsetMs = e.audioOffset / 10000; // ticks -> ms (100ns)  :contentReference[oaicite:7]{index=7}
      const eta = Math.max(0, t0 ? (offsetMs - (performance.now() - t0)) : 0);
      // Schedule so the viseme lands when the sound reaches speakers.
      setTimeout(() => this.mascot?.setViseme?.(e.visemeId), eta);
    };

    this.synth.synthesisCompleted = () => {
      this.speaking = false;
      this.synth?.close();
      this.synth = undefined;
      // Reset to "closed" after a short beat
      setTimeout(() => this.mascot?.setViseme?.(0), 120);
    };

    this.synth.speakTextAsync(
      text,
      () => {}, // handled in synthesisCompleted
      (err: any) => {
        console.error(err);
        this.speaking = false;
        this.synth?.close();
        this.synth = undefined;
      }
    );
  };

  private stop = () => {
    this.synth?.close?.();
    this.speaking = false;
    this.mascot?.setViseme?.(0);
  };

  render() {
    return html`
      <div class="panel">
        <div class="row">
          <input id="azKey" placeholder="Azure Speech key" />
          <input id="azRegion" placeholder="Region (e.g. eastus)" />
        </div>
        <div class="row">
          <select id="azVoice">
            <option>en-US-JennyNeural</option>
            <option>en-US-AriaNeural</option>
            <option>en-GB-RyanNeural</option>
          </select>
          <div></div>
        </div>
        <textarea id="azText" placeholder="Type something for Alfred to say...">
Hello there! I am Alfred. I will sync my lips to Azure TTS visemes.
        </textarea>
        <div class="row">
          <button @click=${this.speak} ?disabled=${this.speaking}>Speak</button>
          <button @click=${this.stop}  ?disabled=${!this.speaking}>Stop</button>
        </div>
      </div>
    `;
  }
}
