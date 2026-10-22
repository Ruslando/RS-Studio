// Upmix mono to two identical channels before selecting L/R, then play the
// chosen channel through both speakers. Side plays (L - R) / 2 on both.
// Stereo bypasses this selection graph.
export function channelRoute(context, source, destination) {
  const upmix = context.createGain();
  upmix.channelCount = 2; upmix.channelCountMode = 'explicit';
  upmix.channelInterpretation = 'speakers';
  const splitter = context.createChannelSplitter(2), merger = context.createChannelMerger(2);
  const sideGains = [0.5, -0.5].map(value => { const gain = context.createGain(); gain.gain.value = value; return gain; });
  source.connect(upmix);
  let current;
  return channel => {
    channel = ['left', 'right', 'side'].includes(channel) ? channel : 'stereo';
    if (current === channel) return;
    upmix.disconnect(); splitter.disconnect(); merger.disconnect();
    for (const gain of sideGains) gain.disconnect();
    if (channel === 'stereo') upmix.connect(destination);
    else if (channel === 'side') {
      upmix.connect(splitter);
      splitter.connect(sideGains[0], 0); splitter.connect(sideGains[1], 1);
      for (const gain of sideGains) { gain.connect(merger, 0, 0); gain.connect(merger, 0, 1); }
      merger.connect(destination);
    } else {
      upmix.connect(splitter);
      const index = channel === 'left' ? 0 : 1;
      splitter.connect(merger, index, 0); splitter.connect(merger, index, 1);
      merger.connect(destination);
    }
    current = channel;
  };
}
