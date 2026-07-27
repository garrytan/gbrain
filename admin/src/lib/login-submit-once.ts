type AsyncOperation<Args extends unknown[], Result> = (...args: Args) => Promise<Result>;

export function createLoginSubmitOnce<Args extends unknown[], Result>(
  operation: AsyncOperation<Args, Result>,
): AsyncOperation<Args, Result> {
  let inFlight: Promise<Result> | undefined;

  return (...args: Args) => {
    if (inFlight) return inFlight;

    let request: Promise<Result>;
    try {
      request = Promise.resolve(operation(...args));
    } catch (error) {
      request = Promise.reject(error);
    }

    const tracked = request.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  };
}
