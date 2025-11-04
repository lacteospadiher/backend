// routes/pedidos/pedidosRoutes.js
import { Router } from 'express';
import {
  listPedidos,
  getPedidoById,
  createPedido,
  updatePedido,
  deletePedido,
  getTablaPedidos,
  resetListaParaExcel,
  resetListaParaExcelByFecha, // 👈 NUEVO
} from '../../controllers/pedidos/pedidosController.js';

const router = Router();

// Listado / estructura tabla
router.get('/', listPedidos);
router.get('/tabla', getTablaPedidos);

// Resets de lista_para_excel
router.post('/excel/reset', resetListaParaExcel);
router.post('/excel/reset-by-fecha', resetListaParaExcelByFecha); // 👈 NUEVO

// CRUD de pedido
router.get('/:id', getPedidoById);
router.post('/', createPedido);
router.patch('/:id', updatePedido);
router.delete('/:id', deletePedido);

export default router;
