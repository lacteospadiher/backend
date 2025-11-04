// utils/generarToken.js (ESM)
import jwt from 'jsonwebtoken';

const generarToken = (usuario) => {
  return jwt.sign(
    {
      id: usuario.id,
      nombre: usuario.nombre,
      usuario: usuario.usuario,
      rol: usuario.rol
    },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
};

export default generarToken;
