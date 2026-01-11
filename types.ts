
export enum GameScreen {
  LOADING,
  MODE_SELECTION,
  SETUP,
  ONLINE_SETUP,
  ONLINE_LOBBY,
  THEME_SELECTION,
  ROLE_REVEAL_TRANSITION,
  ROLE_REVEAL,
  GAMEPLAY,
  ONLINE_GAMEPLAY,
  VOTING,
  REVEAL,
}

export type GameMode = 'local' | 'online';
export type Role = 'Civil' | 'Impostor';
export type Difficulty = 'Fácil' | 'Medio' | 'Difícil';

export interface Player {
  id: string;
  name: string;
  photo: string | null;
  role: Role;
  votes: number;
  isReady?: boolean;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}
