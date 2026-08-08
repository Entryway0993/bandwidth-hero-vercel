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

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet.hidePoweredBy());
app.use(helmet.noSniff());
app.use(helmet.ieNoOpen());
app.use(helmet.frameguard({ action: 'deny' }));

if (process.env.LOG === '1') {
  app.use(morgan('tiny'));
}

app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(authenticate, params, proxy);

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
  });
}

export default app;
