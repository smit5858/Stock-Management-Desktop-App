'use strict';

/**
 * An error whose message is safe and useful to show to the user as-is.
 * `fields` optionally maps form field names to messages (shown next to inputs).
 */
class AppError extends Error {
  constructor(message, code = 'APP_ERROR', fields = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fields = fields;
  }
}

module.exports = { AppError };
