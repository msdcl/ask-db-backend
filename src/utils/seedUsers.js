import bcrypt from 'bcryptjs';
import { database } from '../config/database.js';
import { logger } from './logger.js';

/**
 * Seed initial users for the application
 * Run this script to create default admin and user accounts
 */

const defaultUsers = [
  {
    email: 'admin@example.com',
    password: 'admin123456',
    userType: 'admin',
  },
  {
    email: 'user@example.com',
    password: 'user123456',
    userType: 'user',
  },
];

async function seedUsers() {
  try {
    await database.connect();
    await database.initializeSchema();

    logger.info('Starting user seeding...');

    // Create default organization
    let organizationId;
    const orgResult = await database.query(
      'SELECT id FROM organizations WHERE name = $1',
      ['Default Organization']
    );

    if (orgResult.rows.length > 0) {
      organizationId = orgResult.rows[0].id;
      logger.info('Using existing organization');
    } else {
      const newOrgResult = await database.query(
        'INSERT INTO organizations (name, description) VALUES ($1, $2) RETURNING id',
        ['Default Organization', 'Default organization for initial users']
      );
      organizationId = newOrgResult.rows[0].id;
      logger.info('Created default organization');
    }

    for (const user of defaultUsers) {
      // Check if user already exists
      const existingUser = await database.query(
        'SELECT id FROM users WHERE email = $1',
        [user.email]
      );

      if (existingUser.rows.length > 0) {
        logger.info(`User ${user.email} already exists, skipping...`);
        continue;
      }

      // Hash password
      const passwordHash = await bcrypt.hash(user.password, 12);

      // Insert user with organization
      await database.query(
        'INSERT INTO users (email, password_hash, user_type, organization_id) VALUES ($1, $2, $3, $4)',
        [user.email, passwordHash, user.userType, organizationId]
      );

      logger.info(`Created ${user.userType} user: ${user.email}`);
    }

    logger.info('\nUser seeding completed successfully!');
    logger.info('\nDefault credentials:');
    logger.info('─────────────────────────────────────────');
    logger.info('Admin:');
    logger.info('  Email: admin@example.com');
    logger.info('  Password: admin123456');
    logger.info('');
    logger.info('User:');
    logger.info('  Email: user@example.com');
    logger.info('  Password: user123456');
    logger.info('─────────────────────────────────────────');

    await database.close();
    process.exit(0);
  } catch (error) {
    logger.error('User seeding failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  seedUsers();
}

export { seedUsers };
