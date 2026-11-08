// Environment for end-to-end tests: a separate database, throwaway secrets, emails to the console.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@localhost:5432/esign_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123456789';
process.env.JWT_MFA_SECRET = 'test-mfa-secret-0123456789abcdef0123456789abcd';
process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.EMAIL_TRANSPORT = 'console';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.API_RATE_LIMIT = '10000';
process.env.TRUST_PROXY = '0';
process.env.JWT_SIGN_SECRET = 'test-sign-secret-0123456789abcdef0123456789abcd';
process.env.STORAGE_DIR = require('node:path').join(require('node:os').tmpdir(), 'esign-test-files');
process.env.CONVERTER = 'soffice';
