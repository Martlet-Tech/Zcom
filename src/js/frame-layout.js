/// Frame-based layout assembler.
///
/// A "frame" is a physically continuous byte stream (no idle gap on the wire).
/// The backend tags each data event with `frameEnd`: true = real frame
/// boundary (idle gap), false = continuation of the same frame (forced chunk
/// split). Rendering is progressive: long frames are flushed to the DOM in
/// 256-byte increments without waiting for the frame to end.
export class FrameLayout {
  constructor(chunkSize = 256) {
    this.chunkSize = chunkSize;
    this.open = false;
    this.pending = '';
  }

  push(text, { frameEnd = false, marker = null } = {}) {
    const actions = [];
    if (!this.open) {
      actions.push({ type: 'frame-start', marker });
      this.open = true;
      this.pending = '';
    }
    if (text) this.pending += text;
    if (this.pending.length >= this.chunkSize) {
      actions.push({ type: 'frame-append', text: this.pending });
      this.pending = '';
    }
    if (frameEnd) {
      if (this.pending) {
        actions.push({ type: 'frame-append', text: this.pending });
        this.pending = '';
      }
      actions.push({ type: 'frame-end' });
      this.open = false;
    }
    return actions;
  }

  /// Abandon any open frame without emitting a frame-end (reset only).
  reset() {
    this.open = false;
    this.pending = '';
  }
}
