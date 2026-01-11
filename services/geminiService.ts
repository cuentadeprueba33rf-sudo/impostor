
import { Difficulty } from "../types";

const WORD_LISTS: Record<string, string[]> = {
  'Animales': [
    'León', 'Tigre', 'Elefante', 'Jirafa', 'Canguro', 
    'Pingüino', 'Delfín', 'Tiburón', 'Águila', 'Búho', 
    'Lobo', 'Oso', 'Mono', 'Cebra', 'Hipopótamo', 
    'Rinoceronte', 'Tortuga', 'Serpiente', 'Camello', 'Panda'
  ],
  'Vida Cotidiana': [
    'Cepillo de dientes', 'Llaves', 'Reloj', 'Celular', 'Laptop', 
    'Mochila', 'Zapatos', 'Espejo', 'Control remoto', 'Lámpara', 
    'Almohada', 'Toalla', 'Sombrilla', 'Billetera', 'Botella de agua', 
    'Audífonos', 'Gafas', 'Peine', 'Jabón', 'Plato'
  ],
  'Comida': [
    'Pizza', 'Hamburguesa', 'Sushi', 'Taco', 'Helado', 
    'Chocolate', 'Manzana', 'Banana', 'Pasta', 'Ensalada', 
    'Sopa', 'Arroz', 'Huevo', 'Queso', 'Pan', 
    'Café', 'Jugo', 'Dona', 'Galleta', 'Filete'
  ],
  'Deportes': [
    'Fútbol', 'Baloncesto', 'Tenis', 'Natación', 'Atletismo', 
    'Ciclismo', 'Boxeo', 'Voleibol', 'Béisbol', 'Golf', 
    'Rugby', 'Karate', 'Surf', 'Esquí', 'Patinaje', 
    'Yoga', 'Gimnasia', 'Remo', 'Escalada', 'Ajedrez'
  ],
  'Random': [
    'Bitcoin', 'Inteligencia Artificial', 'Agujero Negro', 'Satélite', 'Pirámide', 
    'Volcán', 'Tornado', 'Galaxia', 'Submarino', 'Robot', 
    'Astronauta', 'Brújula', 'Microscopio', 'Telescopio', 'ADN', 
    'Molécula', 'Átomo', 'Chip', 'Laser', 'Holograma'
  ]
};

export const generateWord = async (theme: string, _difficulty: Difficulty): Promise<string> => {
  // Obtenemos la lista del tema o usamos Random por defecto
  const list = WORD_LISTS[theme] || WORD_LISTS['Random'];
  
  // Seleccionamos una palabra al azar
  const randomIndex = Math.floor(Math.random() * list.length);
  const word = list[randomIndex];
  
  // Simulamos un pequeño retraso para mantener la sensación de "procesamiento"
  return new Promise((resolve) => {
    setTimeout(() => resolve(word), 500);
  });
};
