import express from 'express';
import { listarTamanos } from '../../controllers/admin/tamanos_presentacion.js';
const router = express.Router();

router.get("/", listarTamanos);

export default router;

