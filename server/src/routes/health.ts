import { Router } from 'express';
import { createPublicHealthCorsMiddleware } from '../middleware/cors.js';

const router = Router();
const publicHealthCors = createPublicHealthCorsMiddleware();

router.options('/api/health', publicHealthCors);

router.get('/api/health', publicHealthCors, (_req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

export default router;
