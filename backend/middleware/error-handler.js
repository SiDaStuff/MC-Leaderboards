// MC Leaderboards - Error Handler Middleware

/**
 * Global error handler middleware
 */
function errorHandler(err, req, res, next) {
  // Don't leak error details in logs in production
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  if (isDevelopment) {
    console.error('[ERROR]', err);
  } else {
    // Log errors server-side in production without exposing to client
    console.error(`[ERROR ${new Date().toISOString()}] ${err.code}: ${err.message}`);
  }

  // Default error
  const status = err.status || err.statusCode || 500;
  const code = err.code || 'SERVER_ERROR';
  
  // Never expose error details in production
  const response = {
    error: true,
    code
  };
  
  if (isDevelopment) {
    response.message = err.message || 'Internal Server Error';
    response.stack = err.stack;
  } else {
    // Generic message in production
    response.message = status === 400 ? 'Invalid request' : 'An error occurred';
  }
  
  res.status(status).json(response);
}

/**
 * 404 Not Found handler
 */
function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: true,
    code: 'NOT_FOUND',
    message: `Route ${req.method} ${req.path} not found`
  });
}

/**
 * Async handler wrapper to catch errors
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler
};

