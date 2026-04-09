import db from '../db.js';

export function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication is required' });
  }
  const user = db.prepare('SELECT * FROM users WHERE api_key = ?').get(auth.slice(7));
  if (!user) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token' });
  }
  req.user = user;
  next();
}
