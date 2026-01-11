import { GoogleGenAI } from "@google/genai";
import { Difficulty } from "../types";

const getGeminiApiKey = (): string => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY environment variable not set");
  }
  return apiKey;
};

// Fallbacks organizados por Tema y luego por Dificultad aproximada
const fallbacks: Record<string, string[]> = {
    'Vida Cotidiana': ['Cepillo de dientes', 'Llaves', 'Tráfico', 'Despertador', 'Supermercado', 'Facturas', 'Vecinos', 'Ascensor', 'Café mañanero'],
    'Animales': ['Perro', 'Gato', 'Elefante', 'Ornitorrinco', 'Ajolote', 'Tardígrado', 'León', 'Hormiga', 'Ballena Azul'],
    'Objetos': ['Silla', 'Mesa', 'Lámpara', 'Acelerador de partículas', 'Satélite', 'Microchip', 'Martillo', 'Espejo', 'Caleidoscopio'],
    'Comida': ['Pizza', 'Manzana', 'Pan', 'Caviar', 'Trufa negra', 'Gastronomía molecular', 'Sushi', 'Tacos', 'Estrella Michelin'],
    'Profesiones': ['Doctor', 'Profesor', 'Bombero', 'Criptógrafo', 'Actuario', 'Paleontólogo', 'Ingeniero', 'Abogado', 'Influencer'],
    'Deportes': ['Fútbol', 'Baloncesto', 'Tenis', 'Curling', 'Salto base', 'Ajedrez boxeo', 'Natación', 'Golf', 'Mundial'],
    'Random': ['Unicornio', 'Triángulo de las Bermudas', 'Bitcoin', 'Inteligencia Artificial', 'Agujero Negro', 'Karma', 'Multiverso', 'Teoría de Cuerdas']
};

const getFallbackWord = (theme: string, difficulty: Difficulty): string => {
    // Intentar buscar por tema, si no existe (o es Random), usar lista Random
    const list = fallbacks[theme] || fallbacks['Random'];
    
    // Simulación simple de dificultad basada en longitud/complejidad para fallback offline
    // (En online la IA lo hace mejor)
    if (difficulty === 'Fácil') return list[0] || 'Manzana';
    if (difficulty === 'Difícil') return list[list.length - 1] || 'Física Cuántica';
    
    return list[Math.floor(Math.random() * list.length)];
};

export const generateWord = async (theme: string, difficulty: Difficulty): Promise<string> => {
  try {
    const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
    
    // Prompt estricto con el tema
    let prompt = `Actúa como el motor de juego para 'El Impostor'. Tu objetivo es generar una palabra secreta para los jugadores.
    
    REGLAS OBLIGATORIAS:
    1. La palabra DEBE pertenecer estrictamente a la categoría: "${theme}". (Si el tema es 'Random', puedes elegir cualquier cosa).
    2. El nivel de dificultad seleccionado es: "${difficulty}".
    
    GUÍA DE DIFICULTAD PARA EL TEMA "${theme}":
    `;

    switch (difficulty) {
        case 'Fácil':
            prompt += `- Genera una palabra extremadamente común, tangible y simple. Algo que un niño reconocería inmediatamente dentro de "${theme}".\n- Ejemplo (si fuera Frutas): Manzana, Banana.`;
            break;
        case 'Medio':
            prompt += `- Genera una palabra conocida pero no la más obvia. Puede ser un objeto específico, una acción o un lugar común dentro de "${theme}".\n- Ejemplo (si fuera Frutas): Kiwi, Granada.`;
            break;
        case 'Difícil':
            prompt += `- Genera un concepto complejo, una frase compuesta (tipo "Pool Party"), algo abstracto, técnico o muy específico relacionado con "${theme}". Debe ser un reto describirlo sin ser descubierto.\n- Ejemplo (si fuera Frutas): Denominación de Origen, Fermentación, Fruta del Dragón.`;
            break;
    }

    prompt += `\n\nResponde ÚNICAMENTE con la palabra o frase secreta. Sin explicaciones, sin comillas, sin puntos finales. Solo la palabra.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });
    
    const word = response.text.trim();
    
    // Validación básica
    if (!word || word.length > 50) { 
        console.warn("Respuesta de IA inválida, usando fallback.");
        return getFallbackWord(theme, difficulty);
    }

    // Limpieza extra por si la IA pone comillas
    return word.replace(/^["']|["']$/g, '');

  } catch (error) {
    console.error("Error generating word with Gemini, falling back:", error);
    return getFallbackWord(theme, difficulty);
  }
};