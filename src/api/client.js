export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** Calls the main process. Resolves with data, or throws ApiError with a user-facing message. */
export async function invoke(channel, payload) {
  let result;
  try {
    result = await window.api.invoke(channel, payload);
  } catch (err) {
    throw new ApiError(`Internal error (${channel}): ${err.message}`, 'IPC_FAILED');
  }
  if (!result || !result.ok) {
    const error = (result && result.error) || {};
    throw new ApiError(error.message || 'Unknown error.', error.code || 'UNKNOWN');
  }
  return result.data;
}
