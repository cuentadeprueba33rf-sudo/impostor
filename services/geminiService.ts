
import { GoogleGenAI } from "@google/genai";
import { Difficulty } from "../types";

const getGeminiApiKey = (): string => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY environment variable not set");
  }
  return apiKey;
};

const fallbacks: Record<string, string[]> = {
    'Vida Cotidiana': ['Cepillo de dientes', 'Llaves', 'Tráfico', 'Despertador', 'Supermercado'],
    'Animales': ['Perro', 'Gato', 'Elefante', 'Ornitorrinco'],
    'Random': ['Bitcoin', 'Inteligencia Artificial', 'Agujero Negro']
};

const getFallbackWord = (theme: string, difficulty: Difficulty): string => {
    const list = fallbacks[theme] || fallbacks['Random'];
    return list[Math.floor(Math.random() * list.length)];
};

export const generateWord = async (theme: string, difficulty: Difficulty): Promise<string> => {
  try {
    const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
    
    let prompt = `Actúa como el motor de juego para 'El Impostor'. Genera una palabra secreta.
    Categoría: "${theme}". Dificultad: "${difficulty}".
    Responde ÚNICAMENTE con la palabra. Sin puntos ni comillas.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });
    
    const word = response.text?.trim();
    if (!word || word.length > 50) return getFallbackWord(theme, difficulty);
    return word.replace(/^["']|["']$/g, '');
  } catch (error) {
    console.error("Error Gemini:", error);
    return getFallbackWord(theme, difficulty);
  }
};
