// routes/admin/clientesQrRoutes.js
import { Router } from 'express';
import db from '../../config/db.js';
import { qrPng, qrLabelPdf } from '../../controllers/admin/clientesQrController.js';

const router = Router();

/**
 * Bloqueo: el cliente PUBLICO no debe tener QR.
 * Responde 404 para evitar etiquetado accidental.
 */
router.use('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });

  try {
    const [[row]] = await db.query('SELECT clave FROM clientes WHERE id = ? LIMIT 1', [id]);
    if (row?.clave === 'PUBLICO') {
      return res.status(404).json({ error: 'no_qr_publico' });
    }
  } catch {
    // si falla el lookup, mejor continuar y que el controlador maneje el error
  }
  next();
});

router.get('/:id/qr.png', qrPng);
router.get('/:id/qr/label', qrLabelPdf);

export default router;
