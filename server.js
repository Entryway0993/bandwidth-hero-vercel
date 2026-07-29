import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import dotenv from 'dotenv';
import authenticate from './src/authenticate.js';
import params from './src/params.js';
import proxy from './src/proxy.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Security
app.use(helmet.hidePoweredBy());
app.use(helmet.noSniff());
app.use(helmet.ieNoOpen());
app.use(helmet.frameguard({ action: 'deny' }));
app.use(
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  })
);

// Logging
app.use(morgan('combined'));

// Trust proxy
app.enable('trust proxy');

// Public routes (no auth)
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/debug', params, (req, res) => res.json(req.opts));

// Authenticated proxy
app.use(authenticate, params, proxy);

// Start
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
