// Upmix mono to two identical channels before selecting L/R, then play the
// chosen channel through both speakers. Stereo bypasses this selection graph.
export function channelRoute(context, source, destination) {
  const upmix = context.createGain();
  upmix.channelCount = 2; upmix.channelCountMode = 'explicit';
  upmix.channelInterpretation = 'speakers';
  const splitter = context.createChannelSplitter(2), merger = context.createChannelMerger(2);
  source.connect(upmix);
  let current;
  return channel => {
    channel = ['left', 'right'].includes(channel) ? channel : 'stereo';
    if (current === channel) return;
    upmix.disconnect(); splitter.disconnect(); merger.disconnect();
    if (channel === 'stereo') upmix.connect(destination);
    else {
      upmix.connect(splitter);
      const index = channel === 'left' ? 0 : 1;
      splitter.connect(merger, index, 0); splitter.connect(merger, index, 1);
      merger.connect(destination);
    }
    current = channel;
  };
}
