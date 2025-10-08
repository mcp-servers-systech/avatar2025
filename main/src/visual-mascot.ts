/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('gdm-live-audio-visuals-mascot')
export class GdmLiveAudioVisualsMascot extends LitElement {
  /** These are still here so your existing app can pass the nodes if it wants. */
  @property({ attribute: false }) inputNode?: AudioNode;
  @property({ attribute: false }) outputNode?: AudioNode;

  /** Current Azure viseme id (0–21). */
  @state() private visemeId = 0;

  /** Public API called by the Azure test panel (or anything else). */
  public setViseme(id: number) {
    this.visemeId = id;
    const img = this.renderRoot.querySelector<HTMLImageElement>('#mouth');
    if (!img) return;
    img.src = this.spriteForViseme(id);
  }

  /** Bucket 22 Azure visemes into 4 temporary sprites for this test. */
  private spriteForViseme(id: number): string {
    // Rough groupings; we’ll split these per-ID later with your final art set.
    // Azure returns 22 visemes; 0 is silence; IDs like 7/8 are rounded “O/U”; 21 is P/B/M (closed). :contentReference[oaicite:4]{index=4}
    const closed = '/mouth/closed.png';
    const o      = '/mouth/o.png';
    const narrow = '/mouth/narrow.png';
    const wide   = '/mouth/wide.png';

    const O_IDS       = new Set([7, 8]);
    const WIDE_IDS    = new Set([2, 3, 9, 10, 11]);       // AA/AW/AI-ish
    const CLOSED_IDS  = new Set([0, 21]);                 // silence, P/B/M
    const NARROW_IDS  = new Set([
      1,4,5,6,12,13,14,15,16,17,18,19,20
    ]); // everything else for now

    if (O_IDS.has(id)) return o;
    if (WIDE_IDS.has(id)) return wide;
    if (CLOSED_IDS.has(id)) return closed;
    if (NARROW_IDS.has(id)) return narrow;
    return narrow;
  }

  static styles = css`
    :host {
      display: grid;
      place-items: center;
      width: 100%;
    }
    .wrap {
      position: relative;
      width: min(320px, 60vw);
      user-select: none;
    }
    .mascot {
      width: 100%;
      display: block;
    }
    .mouth {
      position: absolute;
      /* Tune these to position the mouth over Alfred’s face */
      left: var(--mouth-left, 50%);
      top:  var(--mouth-top, 34%);
      width: var(--mouth-width, 42%);
      transform: translate(-50%, -50%);
      pointer-events: none;
    }
    .mouth img {
      width: 100%;
      display: block;
      transition: opacity 60ms linear;
      will-change: opacity;
    }
    .badge {
      position: absolute;
      right: 8px;
      bottom: 8px;
      font: 12px/1.2 system-ui, sans-serif;
      background: rgba(0,0,0,.55);
      color: white;
      padding: 4px 8px;
      border-radius: 999px;
    }
  `;

  render() {
    return html`
      <div class="wrap">
        <img class="mascot" alt="Alfred mascot"
             src="/mascot/Alfred_Mascot.png" />
        <div class="mouth" aria-hidden="true">
          <img id="mouth" src=${this.spriteForViseme(this.visemeId)} />
        </div>
        <div class="badge">viseme: ${this.visemeId}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-visuals-mascot': GdmLiveAudioVisualsMascot;
  }
}
