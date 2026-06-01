/*
 * Minimal CD+G decoder + canvas renderer.
 *
 * CD+G is a stream of 24-byte "subcode" packets played at 300 packets/sec,
 * in sync with the companion MP3/audio. Each packet may carry a graphics
 * command that updates a 300x216 indexed-color frame buffer (16 colors,
 * 12-bit RGB). The visible area is 294x204 inside a 6px border.
 *
 * Usage:
 *   const cdg = new CDGPlayer(canvasEl);
 *   await cdg.load(arrayBuffer);
 *   // each animation frame, in sync with audio currentTime:
 *   cdg.render(audio.currentTime);
 */

const CDG_COMMAND = 0x09;
const CDG_MASK = 0x3f;

const I_MEMORY_PRESET = 1;
const I_BORDER_PRESET = 2;
const I_TILE_BLOCK = 6;
const I_SCROLL_PRESET = 20;
const I_SCROLL_COPY = 24;
const I_DEFINE_TRANSPARENT = 28;
const I_LOAD_CLUT_LO = 30;
const I_LOAD_CLUT_HI = 31;
const I_TILE_BLOCK_XOR = 38;

const WIDTH = 300;
const HEIGHT = 216;
const PACKETS_PER_SEC = 300;

class CDGPlayer {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    this.ctx = canvas.getContext("2d");
    this.image = this.ctx.createImageData(WIDTH, HEIGHT);
    this.reset();
  }

  reset() {
    this.packets = [];
    this.pixels = new Uint8Array(WIDTH * HEIGHT); // color indices
    this.clut = new Array(16).fill(0).map(() => [0, 0, 0]);
    this.borderIndex = 0;
    this.transparentIndex = -1;
    this.hOffset = 0;
    this.vOffset = 0;
    this.lastPacket = -1;
  }

  async load(arrayBuffer) {
    this.reset();
    const bytes = new Uint8Array(arrayBuffer);
    const n = Math.floor(bytes.length / 24);
    this.packets = new Array(n);
    for (let i = 0; i < n; i++) {
      this.packets[i] = bytes.subarray(i * 24, i * 24 + 24);
    }
  }

  // Render the frame as of `timeSeconds`. Processes packets forward; on a
  // backward seek it rebuilds from the start.
  render(timeSeconds) {
    if (!this.packets.length) return;
    const target = Math.min(
      this.packets.length - 1,
      Math.floor(timeSeconds * PACKETS_PER_SEC)
    );
    if (target < this.lastPacket) {
      // seeked backwards -> replay from scratch
      const px = this.pixels;
      px.fill(0);
      this.lastPacket = -1;
    }
    for (let i = this.lastPacket + 1; i <= target; i++) {
      this.processPacket(this.packets[i]);
    }
    this.lastPacket = target;
    this.paint();
  }

  processPacket(p) {
    if ((p[0] & CDG_MASK) !== CDG_COMMAND) return;
    const inst = p[1] & CDG_MASK;
    const data = new Uint8Array(16);
    for (let i = 0; i < 16; i++) data[i] = p[4 + i] & CDG_MASK;

    switch (inst) {
      case I_MEMORY_PRESET: return this.memoryPreset(data);
      case I_BORDER_PRESET: return this.borderPreset(data);
      case I_TILE_BLOCK: return this.tileBlock(data, false);
      case I_TILE_BLOCK_XOR: return this.tileBlock(data, true);
      case I_SCROLL_PRESET: return this.scroll(data, false);
      case I_SCROLL_COPY: return this.scroll(data, true);
      case I_DEFINE_TRANSPARENT: return this.defineTransparent(data);
      case I_LOAD_CLUT_LO: return this.loadCLUT(data, 0);
      case I_LOAD_CLUT_HI: return this.loadCLUT(data, 8);
      default: return;
    }
  }

  memoryPreset(data) {
    const color = data[0] & 0x0f;
    // data[1] is "repeat"; safe to always fill.
    this.pixels.fill(color);
  }

  borderPreset(data) {
    const color = data[0] & 0x0f;
    this.borderIndex = color;
    const px = this.pixels;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (x < 6 || x >= WIDTH - 6 || y < 12 || y >= HEIGHT - 12) {
          px[y * WIDTH + x] = color;
        }
      }
    }
  }

  loadCLUT(data, offset) {
    for (let i = 0; i < 8; i++) {
      const hi = data[i * 2];      // 6 bits: 00 r r r r g g
      const lo = data[i * 2 + 1];  // 6 bits: 00 g g b b b b
      const r = (hi & 0x3f) >> 2;
      const g = ((hi & 0x03) << 2) | ((lo & 0x3f) >> 4);
      const b = lo & 0x0f;
      this.clut[offset + i] = [r * 17, g * 17, b * 17]; // scale 0..15 -> 0..255
    }
  }

  defineTransparent(data) {
    this.transparentIndex = data[0] & 0x0f;
  }

  tileBlock(data, xor) {
    const color0 = data[0] & 0x0f;
    const color1 = data[1] & 0x0f;
    const row = (data[2] & 0x1f) * 12;
    const col = (data[3] & 0x3f) * 6;
    const px = this.pixels;
    for (let i = 0; i < 12; i++) {
      const bits = data[4 + i];
      const y = row + i;
      if (y < 0 || y >= HEIGHT) continue;
      for (let j = 0; j < 6; j++) {
        const x = col + j;
        if (x < 0 || x >= WIDTH) continue;
        const on = (bits >> (5 - j)) & 1;
        const idx = y * WIDTH + x;
        if (xor) {
          px[idx] = px[idx] ^ (on ? color1 : color0);
        } else {
          px[idx] = on ? color1 : color0;
        }
      }
    }
  }

  scroll(data, copy) {
    const color = data[0] & 0x0f;
    const hScroll = data[1] & 0x3f;
    const vScroll = data[2] & 0x3f;
    const hCmd = (hScroll & 0x30) >> 4;
    const hOff = hScroll & 0x07;
    const vCmd = (vScroll & 0x30) >> 4;
    const vOff = vScroll & 0x0f;

    this.hOffset = hOff;
    this.vOffset = vOff;

    let dx = 0, dy = 0;
    if (hCmd === 1) dx = 6;
    else if (hCmd === 2) dx = -6;
    if (vCmd === 1) dy = 12;
    else if (vCmd === 2) dy = -12;
    if (dx === 0 && dy === 0) return;

    const src = this.pixels;
    const dst = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        let sx = x - dx;
        let sy = y - dy;
        if (copy) {
          sx = (sx + WIDTH) % WIDTH;
          sy = (sy + HEIGHT) % HEIGHT;
          dst[y * WIDTH + x] = src[sy * WIDTH + sx];
        } else {
          if (sx < 0 || sx >= WIDTH || sy < 0 || sy >= HEIGHT) {
            dst[y * WIDTH + x] = color;
          } else {
            dst[y * WIDTH + x] = src[sy * WIDTH + sx];
          }
        }
      }
    }
    this.pixels = dst;
  }

  paint() {
    const img = this.image.data;
    const px = this.pixels;
    const clut = this.clut;
    for (let i = 0; i < px.length; i++) {
      const c = clut[px[i]] || [0, 0, 0];
      const o = i * 4;
      img[o] = c[0];
      img[o + 1] = c[1];
      img[o + 2] = c[2];
      img[o + 3] = 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}

window.CDGPlayer = CDGPlayer;
