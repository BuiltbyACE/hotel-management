import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import boundaries from 'eslint-plugin-boundaries';

const MODULES = [
  'identity',
  'property',
  'guests',
  'availability',
  'bookings',
  'frontdesk',
  'billing',
  'housekeeping',
  'maintenance',
  'expenses',
  'reporting',
  'audit',
];

// Per-module: no module may import another module's repository or schema.
// The one exception is reporting (the read-across-modules escape hatch), whose
// repository may read other modules' schemas. Reporting never writes.
const moduleMatrixPolicies = MODULES.flatMap((mod) => {
  const others = `!(${mod})`;
  const policies = [
    {
      from: { element: { type: 'module', captured: { moduleName: mod } } },
      disallow: {
        to: {
          element: { type: 'module', captured: { moduleName: others } },
          file: { categories: ['repository', 'schema'] },
        },
      },
    },
  ];
  // reporting's repository is allowed to read across module schemas
  if (mod === 'reporting') {
    policies.push({
      from: {
        element: { type: 'module', captured: { moduleName: 'reporting' } },
        file: { categories: 'repository' },
      },
      allow: {
        to: { element: { type: 'module' }, file: { categories: 'schema' } },
      },
    });
  }
  return policies;
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'node_modules/**',
  ]),

  // ─── HMS Architecture Rules ───────────────────────────────────────────
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      // hms/no-direct-request-json
      // Raw request.json() is banned outside core/api. Use validateBody(req, schema).
      'no-restricted-syntax': [2, {
        selector: "CallExpression[callee.property.name='json'][callee.object.name=/^(req|request)$/]",
        message: 'Use validateBody(req, schema) from @/core/api. Raw request.json() is banned.',
      }],

      // hms/no-raw-db
      // Importing pg or drizzle-orm/node-postgres outside core/db is banned.
      'no-restricted-imports': [2, {
        patterns: [{
          group: ['pg', 'drizzle-orm/node-postgres', '**/core/db/client'],
          message: 'Import withDb/withTx from @/core/db instead. The pool is not exported.',
        }],
      }],
    },
  },

  // core/api is where raw request.json() is wrapped — exempt there
  {
    files: ['src/core/api/**'],
    rules: {
      'no-restricted-syntax': 0,
    },
  },

  // core/db is the ONE place allowed to touch the driver
  {
    files: ['src/core/db/**'],
    rules: {
      'no-restricted-imports': 0,
    },
  },

  // hms/route-handler-max-lines
  // Route handlers MUST be under 80 lines. Business logic goes in service.ts.
  {
    files: ['src/app/api/**/route.ts'],
    rules: {
      'max-lines': [2, { max: 80, skipComments: true, skipBlankLines: true }],
    },
  },

  // hms/no-client-db
  // Components and hooks must never touch the database or other modules' repositories.
  {
    files: ['src/components/**', 'src/hooks/**'],
    rules: {
      'no-restricted-imports': [2, {
        patterns: [
          { group: ['**/core/db/**', '**/core/db'], message: 'No database access from client components.' },
          { group: ['**/modules/*/repository'], message: 'Import from the module service, not its repository.' },
          { group: ['**/modules/*/schema'], message: 'Do not import schema from components.' },
        ],
      }],
    },
  },

  // ─── Module boundaries (eslint-plugin-boundaries) ──────────────────────
  {
    plugins: { boundaries },
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    settings: {
      'boundaries/legacy-warnings': false,
      'boundaries/elements': [
        { type: 'route', pattern: 'src/app/api/**' },
        { type: 'app', pattern: 'src/app/**' },
        { type: 'module', pattern: 'src/modules/*', capture: ['moduleName'] },
        { type: 'core', pattern: 'src/core/*' },
        { type: 'components', pattern: 'src/components/*' },
        { type: 'hooks', pattern: 'src/hooks/*' },
        { type: 'lib', pattern: 'src/lib/*' },
      ],
      'boundaries/files': [
        { category: 'test', pattern: 'src/**/__tests__/*' },
        { category: 'service', pattern: 'src/modules/*/service*' },
        { category: 'repository', pattern: 'src/modules/*/repository*' },
        { category: 'schema', pattern: 'src/modules/*/schema*' },
        { category: 'validation', pattern: 'src/modules/*/validation*' },
        { category: 'events', pattern: 'src/modules/*/events*' },
        { category: 'types', pattern: 'src/modules/*/types*' },
        { category: 'guards', pattern: 'src/modules/*/auth-guard*' },
        // The one file where core is allowed to import module schemas.
        { category: 'schemaBarrel', pattern: 'src/core/db/schema.ts' },
      ],
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      'boundaries/dependencies': [2, {
        default: 'disallow',
        // npm packages and node builtins are allowed everywhere
        policies: [
          { allow: { to: { module: { origin: ['external', 'core'] } } } },

          // lib is pure — only other lib + externals
          {
            from: { element: { type: 'lib' } },
            disallow: { to: { element: { types: { anyOf: ['module', 'components', 'hooks', 'app'] } } } },
          },

          // components may use components, hooks, lib, core (never db), and other surfaces
          {
            from: { element: { type: 'components' } },
            allow: {
              to: { element: { types: { anyOf: ['components', 'hooks', 'lib'] } } },
            },
          },
          {
            from: { element: { type: 'components' } },
            disallow: {
              to: { element: { types: { anyOf: ['module', 'app', 'route'] } } },
            },
          },

          // hooks may use hooks and lib
          {
            from: { element: { type: 'hooks' } },
            allow: { to: { element: { types: { anyOf: ['hooks', 'lib'] } } } },
          },
          {
            from: { element: { type: 'hooks' } },
            disallow: { to: { element: { types: { anyOf: ['module', 'components', 'app', 'route'] } } } },
          },

          // core may import core + externals only (keeps infra free of modules)
          {
            from: { element: { type: 'core' } },
            allow: { to: { element: { type: 'core' } } },
          },
          {
            from: { element: { type: 'core' } },
            disallow: { to: { element: { types: { anyOf: ['module', 'components', 'hooks', 'app', 'route'] } } } },
          },
          // EXCEPTION (last-match-wins): the app-side schema barrel. core/db/schema.ts
          // is the ONE place core aggregates module schemas so drizzle has a typed map.
          {
            from: { element: { type: 'core' }, file: { categories: ['schemaBarrel'] } },
            allow: { to: { element: { type: 'module' }, file: { categories: ['schema'] } } },
          },

          // app pages (server components) may import core, module services, components, hooks, lib.
          // Broad ban first, specific allows after (last-match-wins).
          {
            from: { element: { type: 'app' } },
            disallow: { to: { element: { type: 'module' } } },
          },
          {
            from: { element: { type: 'app' } },
            allow: {
              to: {
                element: { types: { anyOf: ['app', 'core', 'components', 'hooks', 'lib'] } },
              },
            },
          },
          {
            from: { element: { type: 'app' } },
            allow: {
              to: { element: { type: 'module' }, file: { categories: 'service' } },
            },
          },

          // routes may import core, module services, module validation.
          {
            from: { element: { type: 'route' } },
            disallow: { to: { element: { type: 'module' } } },
          },
          {
            from: { element: { type: 'route' } },
            allow: { to: { element: { types: { anyOf: ['core', 'lib'] } } } },
          },
          {
            from: { element: { type: 'route' } },
            allow: {
              to: {
                element: { type: 'module' },
                file: { categories: ['service', 'validation', 'guards'] },
              },
            },
          },

          // Tests living next to a route (src/app/api/**/__tests__) may touch
          // anything — same latitude as module tests.
          {
            from: { element: { type: 'route' }, file: { categories: ['test'] } },
            allow: {
              to: {
                element: { types: { anyOf: ['module', 'app', 'components', 'hooks', 'lib'] } },
              },
            },
          },

          // modules may import core, other module SERVICES, and their own files.
          // Cross-module repository/schema is banned per-module below.
          {
            from: { element: { type: 'module' } },
            allow: { to: { element: { types: { anyOf: ['core', 'components', 'hooks', 'lib'] } } } },
          },
          {
            from: { element: { type: 'module' } },
            allow: {
              to: { element: { type: 'module' }, file: { categories: ['service', 'events', 'guards'] } },
            },
          },

          // Same-module imports are always fine.
          ...MODULES.map((mod) => ({
            from: { element: { type: 'module', captured: { moduleName: mod } } },
            allow: {
              to: { element: { type: 'module', captured: { moduleName: mod } } },
            },
          })),

          // Cross-module repository/schema: per-module ban matrix.
          ...moduleMatrixPolicies,

          // Routes may not import other routes; modules may not create cycles into app.
          {
            from: { element: { type: 'module' } },
            disallow: { to: { element: { types: { anyOf: ['app', 'route'] } } } },
          },
        ],
      },
    ],
  },
},
]);

export default eslintConfig;