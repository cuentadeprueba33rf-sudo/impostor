
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const supabaseUrl = 'https://zifqtcvozdakdgujfstl.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppZnF0Y3ZvemRha2RndWpmc3RsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgwOTg3NDAsImV4cCI6MjA4MzY3NDc0MH0.MsvYKqmzLq6QUp3h2Ye0c1jzfw9fNlNZNv4abWzMrgc';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const createRoom = async (code: string) => {
  const { data, error } = await supabase
    .from('rooms')
    .insert([{ code, status: 'ONLINE_LOBBY' }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const joinRoom = async (code: string) => {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('code', code.toUpperCase())
    .single();
  if (error) return null;
  return data;
};

export const getPublicRooms = async () => {
  const { data, error } = await supabase
    .from('rooms')
    .select('*, players(count)')
    .eq('status', 'ONLINE_LOBBY')
    .limit(10);
  if (error) return [];
  return data;
};

export const addPlayerToRoom = async (roomId: string, name: string, photo: string | null, isHost: boolean) => {
  const { data, error } = await supabase
    .from('players')
    .insert([{ room_id: roomId, name, photo, is_host: isHost }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updateRoomStatus = async (roomId: string, status: string, extraData: any = {}) => {
  const { error } = await supabase
    .from('rooms')
    .update({ status, ...extraData })
    .eq('id', roomId);
  if (error) throw error;
};

export const sendMessage = async (roomId: string, playerId: string, playerName: string, text: string) => {
  const { error } = await supabase
    .from('messages')
    .insert([{ room_id: roomId, player_id: playerId, player_name: playerName, text }]);
  if (error) throw error;
};

export const rotateTurn = async (roomId: string, nextIndex: number) => {
  await supabase
    .from('rooms')
    .update({ current_turn_index: nextIndex })
    .eq('id', roomId);
};
