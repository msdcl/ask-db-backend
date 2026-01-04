import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { database } from '../config/database.js';
import {
  AuthenticationError,
  ConflictError,
  ValidationError,
} from '../utils/errors.js';

class AuthService {
  async register(email, password, userType = 'user') {
    if (!email || !password) {
      throw new ValidationError('Email and password are required');
    }

    if (password.length < 6) {
      throw new ValidationError('Password must be at least 6 characters');
    }

    const validUserTypes = ['admin', 'user'];
    if (!validUserTypes.includes(userType)) {
      throw new ValidationError('Invalid user type');
    }

    const existingUser = await database.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      throw new ConflictError('User already exists');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await database.query(
      `INSERT INTO users (email, password_hash, user_type)
       VALUES ($1, $2, $3)
       RETURNING id, email, user_type, created_at`,
      [email.toLowerCase(), passwordHash, userType]
    );

    const user = result.rows[0];

    const { accessToken, refreshToken } = this.generateTokens(user.id);

    await this.saveRefreshToken(user.id, refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        userType: user.user_type,
      },
      accessToken,
      refreshToken,
    };
  }

  async login(email, password) {
    if (!email || !password) {
      throw new ValidationError('Email and password are required');
    }

    const result = await database.query(
      'SELECT id, email, password_hash, user_type, organization_id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      throw new AuthenticationError('Invalid credentials');
    }

    const user = result.rows[0];

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      throw new AuthenticationError('Invalid credentials');
    }

    const { accessToken, refreshToken } = this.generateTokens(user.id);

    await this.saveRefreshToken(user.id, refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        userType: user.user_type,
        organizationId: user.organization_id,
      },
      accessToken,
      refreshToken,
    };
  }

  async refreshAccessToken(refreshToken) {
    if (!refreshToken) {
      throw new AuthenticationError('Refresh token required');
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.jwt.secret);
    } catch (error) {
      throw new AuthenticationError('Invalid refresh token');
    }

    const result = await database.query(
      `SELECT user_id FROM refresh_tokens
       WHERE token = $1 AND expires_at > NOW()`,
      [refreshToken]
    );

    if (result.rows.length === 0) {
      throw new AuthenticationError('Invalid or expired refresh token');
    }

    const { accessToken, refreshToken: newRefreshToken } = this.generateTokens(
      decoded.userId
    );

    await database.query('DELETE FROM refresh_tokens WHERE token = $1', [
      refreshToken,
    ]);

    await this.saveRefreshToken(decoded.userId, newRefreshToken);

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  async logout(refreshToken) {
    if (refreshToken) {
      await database.query('DELETE FROM refresh_tokens WHERE token = $1', [
        refreshToken,
      ]);
    }
  }

  generateTokens(userId) {
    const accessToken = jwt.sign({ userId }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

    const refreshToken = jwt.sign({ userId }, config.jwt.secret, {
      expiresIn: config.jwt.refreshExpiresIn,
    });

    return { accessToken, refreshToken };
  }

  async saveRefreshToken(userId, token) {
    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);

    await database.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, token, expiresAt]
    );
  }

  async cleanupExpiredTokens() {
    await database.query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
  }
}

export const authService = new AuthService();
