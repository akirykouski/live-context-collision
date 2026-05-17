// AudioWorklet: downsamples mic audio to 16 kHz mono PCM s16le and posts it to
// the main thread, which forwards it to Speechmatics' real-time socket.
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this._targetRate = 16000;
    this._ratio = sampleRate / this._targetRate;
    this._carry = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    const outLength = Math.floor((channel.length - this._carry) / this._ratio);
    if (outLength <= 0) return true;

    const out = new Int16Array(outLength);
    let pos = this._carry;
    for (let i = 0; i < outLength; i++) {
      const s = Math.max(-1, Math.min(1, channel[Math.floor(pos)]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      pos += this._ratio;
    }
    this._carry = pos - channel.length;
    if (this._carry < 0) this._carry = 0;

    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);
