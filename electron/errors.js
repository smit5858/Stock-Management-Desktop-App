'use strict';

/** An error whose message is safe and useful to show to the user as-is. */
class AppError extends Error {
  constructor(message, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

module.exports = { AppError };
