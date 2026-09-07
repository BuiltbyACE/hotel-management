import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/modules/*/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
