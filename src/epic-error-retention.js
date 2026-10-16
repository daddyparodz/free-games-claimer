// Independent of action timeouts: diagnostic retention never retries an order.
export const epicErrorKeepOpenSeconds = value => {
  if (value === undefined || value === '') return 600;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 1800) : 600;
};

export const retainEpicFailure = async ({ capture, wait, close, seconds = 600 }) => {
  try {
    await capture().catch(() => {});
    const duration = epicErrorKeepOpenSeconds(seconds);
    if (duration) await wait(duration * 1000);
  } finally {
    await close();
  }
};
