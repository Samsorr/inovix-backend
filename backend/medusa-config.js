import 'lib/instrument';
import { loadEnv, Modules, defineConfig } from '@medusajs/utils';
import {
  ADMIN_CORS,
  AUTH_CORS,
  BACKEND_URL,
  COOKIE_SECRET,
  DATABASE_URL,
  JWT_SECRET,
  REDIS_URL,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL,
  SHOULD_DISABLE_ADMIN,
  STORE_CORS,
  BROKER_URL,
  BROKER_CLIENT_ID,
  BROKER_HMAC_SECRET,
  RELAY_BASE_URL,
  CF_KV_ACCOUNT_ID,
  CF_KV_NAMESPACE_ID,
  CF_KV_API_TOKEN,
  WORKER_MODE,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET,
  MINIO_PUBLIC_URL,
  MEILISEARCH_HOST,
  MEILISEARCH_ADMIN_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_ALLOWED_CHAT_IDS,
} from 'lib/constants';

loadEnv(process.env.NODE_ENV, process.cwd());

const medusaConfig = {
  projectConfig: {
    databaseUrl: DATABASE_URL,
    databaseLogging: false,
    redisUrl: REDIS_URL,
    workerMode: WORKER_MODE,
    http: {
      adminCors: ADMIN_CORS,
      authCors: AUTH_CORS,
      storeCors: STORE_CORS,
      jwtSecret: JWT_SECRET,
      cookieSecret: COOKIE_SECRET
    },
    build: {
      rollupOptions: {
        external: ["@medusajs/dashboard", "@medusajs/admin-shared"]
      }
    }
  },
  admin: {
    backendUrl: BACKEND_URL,
    disable: SHOULD_DISABLE_ADMIN,
  },
  modules: [
    {
      key: Modules.FILE,
      resolve: '@medusajs/file',
      options: {
        providers: [
          ...(MINIO_ENDPOINT && MINIO_ACCESS_KEY && MINIO_SECRET_KEY ? [{
            resolve: './src/modules/minio-file',
            id: 'minio',
            options: {
              endPoint: MINIO_ENDPOINT,
              accessKey: MINIO_ACCESS_KEY,
              secretKey: MINIO_SECRET_KEY,
              bucket: MINIO_BUCKET, // Optional, default: medusa-media
              publicUrl: MINIO_PUBLIC_URL // Optional, required for R2/S3-compatible providers where public-read host differs from S3 endpoint
            }
          }] : [{
            resolve: '@medusajs/file-local',
            id: 'local',
            options: {
              upload_dir: 'static',
              backend_url: `${BACKEND_URL}/static`
            }
          }])
        ]
      }
    },
    ...(REDIS_URL ? [{
      key: Modules.EVENT_BUS,
      // Subpath form, same reason as locking below: @medusajs/event-bus-redis
      // is NOT a declared dependency here, only a transitive one, so the bare
      // specifier resolves locally by luck (a stray hoisted node_modules) and
      // is one packaging change away from failing Railway's strict pnpm
      // install. dist/modules/event-bus-redis.js is a plain re-export of the
      // same package from inside medusa's own scope, so this is identical at
      // runtime and resolves reliably.
      resolve: '@medusajs/medusa/event-bus-redis',
      options: {
        redisUrl: REDIS_URL
      }
    },
    {
      key: Modules.WORKFLOW_ENGINE,
      resolve: '@medusajs/workflow-engine-redis',
      options: {
        redis: {
          url: REDIS_URL,
        }
      }
    },
    {
      key: Modules.CACHE,
      resolve: '@medusajs/cache-redis',
      options: {
        redisUrl: REDIS_URL
      }
    },
    // Distributed reservation lock. reserveInventoryStep serialises
    // createReservationItems per inventory item through Modules.LOCKING; without
    // this block Medusa falls back to the in-memory provider (a plain Map on a
    // singleton), which only serialises within ONE process. available_quantity is
    // computed in JS with no DB constraint behind it, so a second replica or a
    // server/worker split would let two cart.complete calls for the last unit
    // interleave and oversell. Package names are the subpaths of the declared
    // @medusajs/medusa dependency (the bare @medusajs/locking-redis is only a
    // transitive dep and does not resolve from the app root under strict pnpm);
    // this mirrors MODULE_PACKAGE_NAMES / TEMPORARY_REDIS_MODULE_PACKAGE_NAMES
    // in @medusajs/utils. Without REDIS_URL we deliberately register nothing, so
    // local dev keeps working on the in-memory default.
    {
      key: Modules.LOCKING,
      resolve: '@medusajs/medusa/locking',
      options: {
        providers: [
          {
            resolve: '@medusajs/medusa/locking-redis',
            id: 'locking-redis',
            is_default: true,
            options: {
              redisUrl: REDIS_URL
            }
          }
        ]
      }
    }] : []),
    ...(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL || RESEND_API_KEY && RESEND_FROM_EMAIL ? [{
      key: Modules.NOTIFICATION,
      resolve: '@medusajs/notification',
      options: {
        providers: [
          ...(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL ? [{
            resolve: '@medusajs/notification-sendgrid',
            id: 'sendgrid',
            options: {
              channels: ['email'],
              api_key: SENDGRID_API_KEY,
              from: SENDGRID_FROM_EMAIL,
            }
          }] : []),
          ...(RESEND_API_KEY && RESEND_FROM_EMAIL ? [{
            resolve: './src/modules/email-notifications',
            id: 'resend',
            options: {
              channels: ['email'],
              api_key: RESEND_API_KEY,
              from: RESEND_FROM_EMAIL,
            },
          }] : []),
        ]
      }
    }] : []),
    ...(
      (BROKER_URL && BROKER_CLIENT_ID && BROKER_HMAC_SECRET)
        ? [{
            key: Modules.PAYMENT,
            resolve: '@medusajs/payment',
            options: {
              providers: [
                ...(BROKER_URL && BROKER_CLIENT_ID && BROKER_HMAC_SECRET
                  && CF_KV_ACCOUNT_ID && CF_KV_NAMESPACE_ID && CF_KV_API_TOKEN ? [{
                  resolve: './src/modules/payment-via-broker',
                  id: 'via_broker',
                  options: {
                    brokerUrl: BROKER_URL,
                    clientId: BROKER_CLIENT_ID,
                    hmacSecret: BROKER_HMAC_SECRET,
                    relayBaseUrl: RELAY_BASE_URL,
                    cfKvAccountId: CF_KV_ACCOUNT_ID,
                    cfKvNamespaceId: CF_KV_NAMESPACE_ID,
                    cfKvApiToken: CF_KV_API_TOKEN,
                  },
                }] : []),
              ],
            },
          }]
        : []
    ),
    {
      key: Modules.FULFILLMENT,
      resolve: '@medusajs/medusa/fulfillment',
      options: {
        providers: [
          { resolve: '@medusajs/medusa/fulfillment-manual', id: 'manual' },
          { resolve: './src/modules/dhl-parcel', id: 'dhl-parcel', options: {} },
        ],
      },
    },
    {
      key: 'dhl_parcel_boxes',
      resolve: './src/modules/dhl-parcel-boxes',
    },
    {
      key: 'dhl_parcel_settings',
      resolve: './src/modules/dhl-parcel-settings',
    },
    {
      key: 'telegram_ops',
      resolve: './src/modules/telegram-ops',
      options: {
        botToken: TELEGRAM_BOT_TOKEN,
        webhookSecret: TELEGRAM_WEBHOOK_SECRET,
        allowedChatIds: TELEGRAM_ALLOWED_CHAT_IDS,
      },
    },
  ],
  plugins: [
  ...(MEILISEARCH_HOST && MEILISEARCH_ADMIN_KEY ? [{
      resolve: '@rokmohar/medusa-plugin-meilisearch',
      options: {
        config: {
          host: MEILISEARCH_HOST,
          apiKey: MEILISEARCH_ADMIN_KEY
        },
        settings: {
          products: {
            type: 'products',
            enabled: true,
            fields: ['id', 'title', 'description', 'handle', 'variant_sku', 'thumbnail'],
            indexSettings: {
              searchableAttributes: ['title', 'description', 'variant_sku'],
              displayedAttributes: ['id', 'handle', 'title', 'description', 'variant_sku', 'thumbnail'],
              filterableAttributes: ['id', 'handle'],
            },
            primaryKey: 'id',
          }
        }
      }
    }] : [])
  ]
};

if (process.env.MEDUSA_CONFIG_DEBUG === 'true') {
  console.log(JSON.stringify(medusaConfig, null, 2));
}
export default defineConfig(medusaConfig);
