// routes/admin/clientesCreditosRoutes.js
import { Router } from 'express';
import { creditosCliente, saldoCliente, pagarCredito } from '../../controllers/admin/clientesCreditosController.js';

const router = Router();

router.get('/:clienteId/creditos', creditosCliente);
router.get('/:clienteId/saldo',    saldoCliente);
router.post('/pagos',              pagarCredito); // body: { id_credito, monto, tipo_pago, referencia?, observaciones? }

export default router;
