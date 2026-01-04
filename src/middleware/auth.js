import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { AuthenticationError, AuthorizationError } from '../utils/errors.js';
import { database } from '../config/database.js';

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('No token provided');
    }

    const token = authHeader.substring(7);

    const decoded = jwt.verify(token, config.jwt.secret);

    const result = await database.query(
      'SELECT id, email, user_type, organization_id FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      throw new AuthenticationError('User not found');
    }

    req.user = {
      id: result.rows[0].id,
      email: result.rows[0].email,
      userType: result.rows[0].user_type,
      organizationId: result.rows[0].organization_id,
    };
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new AuthenticationError('Invalid token'));
    } else if (error instanceof jwt.TokenExpiredError) {
      next(new AuthenticationError('Token expired'));
    } else {
      next(error);
    }
  }
};

export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AuthenticationError('User not authenticated'));
    }

    if (!allowedRoles.includes(req.user.userType)) {
      return next(
        new AuthorizationError('You do not have permission to access this resource')
      );
    }

    next();
  };
};

export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return next(new AuthenticationError('User not authenticated'));
  }

  if (req.user.userType !== 'admin') {
    return next(
      new AuthorizationError('Admin access required')
    );
  }

  next();
};
