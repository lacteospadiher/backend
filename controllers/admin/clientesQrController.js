// controllers/clientesQrController.js
import db from '../../config/db.js';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';

export const qrPng = async (req, res) => {
  try {
    const { id } = req.params;
    const [[cli]] = await db.query(
      `SELECT id, clave, nombre_empresa FROM clientes WHERE id = ? AND eliminado = 0`,
      [id]
    );
    if (!cli) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Payload (estable y futuro-prueba)
    const payload = JSON.stringify({ t: 'cliente', id: cli.id, clave: cli.clave });

    const png = await QRCode.toBuffer(payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 8
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(png);
  } catch (e) {
    console.error('qrPng', e);
    res.status(500).json({ error: 'Error al generar QR' });
  }
};

export const qrLabelPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const [[cli]] = await db.query(
      `SELECT id, clave, nombre_empresa FROM clientes WHERE id = ? AND eliminado = 0`,
      [id]
    );
    if (!cli) return res.status(404).json({ error: 'Cliente no encontrado' });

    const payload = JSON.stringify({ t: 'cliente', id: cli.id, clave: cli.clave });
    const qrBuffer = await QRCode.toBuffer(payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 10
    });

    const doc = new PDFDocument({ size: 'A6', margin: 20 }); // A6 para etiqueta
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=qr_${cli.clave}.pdf`);
    doc.pipe(res);

    // Encabezado
    doc.fontSize(12).fillColor('#000').text(cli.nombre_empresa || 'Negocio sin nombre', { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#555').text(cli.clave, { align: 'center' });
    doc.moveDown(0.5);

    // QR centrado
    const qrSize = 220;
    const x = (doc.page.width - qrSize) / 2;
    const y = doc.y;
    doc.image(qrBuffer, x, y, { fit: [qrSize, qrSize] });

    doc.moveDown(1.2);
    doc.fontSize(8).fillColor('#000').text('Escanéame para identificar el cliente', { align: 'center' });

    doc.end();
  } catch (e) {
    console.error('qrLabelPdf', e);
    res.status(500).json({ error: 'Error al generar etiqueta QR' });
  }
};
