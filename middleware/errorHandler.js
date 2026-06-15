const errorHandler = (err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err);

  if (err.type === 'validation') {
    return res.status(400).json({ error: err.message });
  }

  if (err.code === '23505') {
    // PostgreSQL unique violation
    const field = err.detail?.match(/\((.+?)\)/)?.[1] || 'field';
    return res.status(409).json({ error: `${field} already exists` });
  }

  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referenced record does not exist' });
  }

  res.status(500).json({ error: 'Internal server error' });
};

const notFound = (req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
};

module.exports = { errorHandler, notFound };
