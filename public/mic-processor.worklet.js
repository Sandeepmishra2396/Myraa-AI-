/**
 * MYRAA Microphone AudioWorklet Processor
 * Runs on the dedicated audio rendering thread (not the main JS thread).
 * Receives Float32 microphone samples and posts them to the main thread
 * for PCM conversion and WebSocket streaming.
 *
 * Registered as: "myraa-mic-processor"
 */

class MyraaMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048; // ~128ms at 16kHz
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, _outputs, _parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];
      if (this.bufferIndex >= this.bufferSize) {
        const copy = new Float32Array(this.buffer);
        this.port.postMessage({ channelData: copy }, [copy.buffer]);
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
      }
    }

    // Return true to keep the processor alive.
    return true;
  }
}

registerProcessor("myraa-mic-processor", MyraaMicProcessor);
