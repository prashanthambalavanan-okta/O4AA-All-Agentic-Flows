import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, validateConfig } from './config.js';
import oidcRouter, { initOidc } from './auth/oidc.js';
import samlRouter from './auth/saml.js';
import authPatternsRouter from './auth/authPatterns.js';
import askRouter from './routes/ask.js';
import xaaAtlassianRouter from './routes/xaaAtlassian.js';
import schedulerRouter from './routes/scheduler.js';
import { initMcp } from './mcp/inventoryServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  validateConfig();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // SAML IdP-initiated SSO auto-POSTs the assertion to our ACS from okta.com — a
  // cross-site POST. SameSite=Lax would drop the session cookie on that request,
  // so in production (behind Render's HTTPS proxy) use SameSite=None; Secure to
  // keep the session intact. Locally (http) stay on Lax; SAML won't round-trip.
  const secureCookies = process.env.NODE_ENV === 'production';
  if (secureCookies) app.set('trust proxy', 1);
  app.use(
    session({
      name: 'xaa.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: secureCookies ? 'none' : 'lax',
        secure: secureCookies,
      },
    })
  );

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api', oidcRouter);
  app.use('/api', samlRouter);
  app.use('/api', authPatternsRouter);
  app.use('/api', askRouter);
  app.use('/api', xaaAtlassianRouter);
  app.use('/api', schedulerRouter);

  // Serve the built client in production.
  const clientDist = path.resolve(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      if (err) res.status(404).send('Client not built. Run `npm run build` or use `npm run dev`.');
    });
  });

  await initMcp();
  await initOidc();

  app.listen(config.port, () => {
    console.log(`\n🚀 XAA demo server on http://localhost:${config.port}`);
    console.log(`   In dev, open the Vite app on http://localhost:5173\n`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
