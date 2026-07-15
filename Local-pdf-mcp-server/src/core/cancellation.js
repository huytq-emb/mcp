export function requestCancelledError(reason = "MCP request cancelled by client") {
  const message = typeof reason === "string" && reason
    ? reason
    : reason instanceof Error && reason.message
      ? reason.message
      : "MCP request cancelled by client";
  const error = new Error(message, reason instanceof Error ? { cause: reason } : undefined);
  error.name = "AbortError";
  error.code = "MCP_REQUEST_CANCELLED";
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw requestCancelledError(signal.reason);
}

export async function awaitWithAbort(value, signal) {
  if (!signal) return value;
  throwIfAborted(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(requestCancelledError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([value, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
