import db from '../../config/db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export const loginAdmin = async (req, res) => {
  const { usuario, contrasena } = req.body;

  try {
    const [rows] = await db.execute(`
      SELECT id, usuario, contrasena, rol_id, nombre
      FROM usuarios
      WHERE usuario = ? AND eliminado = 0 AND activo = 1
      LIMIT 1
    `, [usuario]);

    if (rows.length === 0) {
      return res.status(401).json({ msg: 'Credenciales inválidas' });
    }

    const user = rows[0];
    const validPassword = await bcrypt.compare(contrasena, user.contrasena);

    if (!validPassword) {
      return res.status(401).json({ msg: 'Credenciales inválidas' });
    }

    if (![1, 4].includes(user.rol_id)) {
      return res.status(403).json({ msg: 'No tienes permisos de administrador' });
    }

    const token = jwt.sign(
      { id: user.id, rol: user.rol_id },
      process.env.JWT_SECRET,  // <-- aquí debe coincidir con tu .env
      { expiresIn: '8h' }
    );

    res.json({
      token,
      usuario: user.usuario,
      nombre: user.nombre,
      rol: user.rol_id,
      id: user.id
    });

  } catch (error) {
    console.error('Error en loginAdmin:', error);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};
