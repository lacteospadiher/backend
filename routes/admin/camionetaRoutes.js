// routes/camionetas.routes.js

const express = require('express');
const router = express.Router();
const Camionetas = require('../../controllers/admin/camionetaController');

// CRUD
router.get('/', Camionetas.listarCamionetas);
router.post('/', Camionetas.crearCamioneta);
router.put('/:id', Camionetas.editarCamioneta);
router.patch('/eliminar/:id', Camionetas.eliminarCamioneta);

// Vendedor
router.post('/:id/asignar-vendedor', Camionetas.asignarVendedor);
router.patch('/:id/desvincular-vendedor', Camionetas.desvincularVendedor);
router.get('/:id/historial-asignaciones', Camionetas.historialAsignaciones);

// Mantenimientos
router.post('/:id/mantenimientos', Camionetas.agregarMantenimiento);
router.get('/:id/mantenimientos', Camionetas.historialMantenimientos);

// Kilometrajes
router.get('/:id/kilometrajes', Camionetas.historialKilometrajes);

module.exports = router;
