
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GameScreen, Player, Role, Difficulty, GameMode, ChatMessage } from './types';
import { generateWord } from './services/geminiService';
import { 
  supabase, 
  createRoom, 
  joinRoom, 
  getPublicRooms,
  addPlayerToRoom, 
  updateRoomStatus, 
  sendMessage,
  rotateTurn 
} from './services/supabaseService';

// --- Tactical Sound Service (Optimized) ---
const soundService = {
  ctx: null as AudioContext | null,
  init() {
    if (!this.ctx) this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  },
  play(type: 'click' | 'swoosh' | 'success') {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    if (type === 'click') {
      osc.frequency.setValueAtTime(800, now);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'swoosh') {
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.2);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
      osc.start(now); osc.stop(now + 0.2);
    }
  }
};

const PlayerAvatar: React.FC<{ player: Player; size?: 'sm' | 'md' | 'lg' }> = ({ player, size = 'md' }) => {
  const sizeClasses = { sm: 'w-10 h-10 text-xs', md: 'w-16 h-16 text-xl', lg: 'w-24 h-24 text-3xl' };
  return (
    <div className={`${sizeClasses[size]} bg-zinc-900 rounded-2xl flex items-center justify-center border border-white/10 shadow-xl overflow-hidden relative group`}>
      <div className="absolute inset-0 bg-gradient-to-br from-red-600/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
      <span className="font-brand font-bold text-white z-10">{player.name?.charAt(0).toUpperCase() || '?'}</span>
    </div>
  );
};

export default function App() {
  const [screen, setScreen] = useState<GameScreen>(GameScreen.LOADING);
  const [players, setPlayers] = useState<Player[]>([]);
  const [me, setMe] = useState<Player | null>(null);
  const [room, setRoom] = useState<any>(null);
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [nameInput, setNameInput] = useState(localStorage.getItem('agent_alias') || '');
  const [publicRooms, setPublicRooms] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [loadingProgress, setLoadingProgress] = useState(0);

  const screenRef = useRef(screen);
  useEffect(() => { screenRef.current = screen; }, [screen]);

  // Persistence
  useEffect(() => {
    if (nameInput) localStorage.setItem('agent_alias', nameInput);
  }, [nameInput]);

  const tryReconnect = async () => {
    const savedRoomId = localStorage.getItem('last_room_id');
    const savedPlayerId = localStorage.getItem('last_player_id');
    if (savedRoomId && savedPlayerId) {
      addLog("RECUPERANDO IDENTIDAD...");
      const { data: roomData } = await supabase.from('rooms').select('*').eq('id', savedRoomId).single();
      const { data: playerData } = await supabase.from('players').select('*').eq('id', savedPlayerId).single();
      if (roomData && playerData) {
        setRoom(roomData);
        setMe(playerData as any);
        setTimeout(() => setScreen(roomData.status as any), 1500);
        return true;
      }
    }
    return false;
  };

  const addLog = (msg: string) => {
    setTerminalLogs(prev => [...prev.slice(-3), msg]);
  };

  const fetchPlayers = async (roomId: string) => {
    const { data } = await supabase.from('players').select('*').eq('room_id', roomId).order('created_at', { ascending: true });
    if (data) {
      setPlayers(data as any);
      if (me) {
        const currentMe = data.find(p => p.id === me.id);
        if (currentMe) setMe(currentMe as any);
      }
    }
  };

  const refreshPublicRooms = async () => {
    const rooms = await getPublicRooms();
    setPublicRooms(rooms);
  };

  useEffect(() => {
    if (!room) return;
    fetchPlayers(room.id);
    const roomChannel = supabase
      .channel(`room:${room.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` }, payload => {
        setRoom(payload.new);
        if (payload.new.status !== screenRef.current) changeScreen(payload.new.status as any);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${room.id}` }, () => {
        fetchPlayers(room.id);
      })
      .subscribe();
    return () => { supabase.removeChannel(roomChannel); };
  }, [room?.id]);

  useEffect(() => {
    if (screen === GameScreen.LOADING) {
      const boot = async () => {
        const reconnected = await tryReconnect();
        let p = 0;
        const inv = setInterval(() => {
          p += 1;
          setLoadingProgress(p);
          if (p === 30) addLog("CONECTANDO A LA RED...");
          if (p === 70) addLog("AUTENTICANDO...");
          if (p >= 100) {
            clearInterval(inv);
            if (!reconnected) changeScreen(GameScreen.MODE_SELECTION);
          }
        }, 20);
      };
      boot();
    }
  }, []);

  const changeScreen = (newScreen: GameScreen) => {
    soundService.play('swoosh');
    setIsTransitioning(true);
    setTimeout(() => {
      setScreen(newScreen);
      setIsTransitioning(false);
    }, 400);
  };

  const handleCreateOnline = async () => {
    if (!nameInput.trim()) return alert("Ingresa un Alias");
    setIsLoading(true);
    try {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const newRoom = await createRoom(code);
      const player = await addPlayerToRoom(newRoom.id, nameInput, null, true);
      setRoom(newRoom);
      setMe(player as any);
      localStorage.setItem('last_room_id', newRoom.id);
      localStorage.setItem('last_player_id', player.id);
      changeScreen(GameScreen.ONLINE_LOBBY);
    } catch (e) { alert("Error de conexión"); }
    finally { setIsLoading(false); }
  };

  const handleJoinOnline = async (code: string) => {
    if (!nameInput.trim()) return alert("Alias requerido");
    setIsLoading(true);
    try {
      const targetRoom = await joinRoom(code);
      if (!targetRoom) return alert("Sala no encontrada");
      const player = await addPlayerToRoom(targetRoom.id, nameInput, null, false);
      setRoom(targetRoom);
      setMe(player as any);
      localStorage.setItem('last_room_id', targetRoom.id);
      localStorage.setItem('last_player_id', player.id);
      changeScreen(GameScreen.ONLINE_LOBBY);
    } catch (e) { alert("Error al entrar"); }
    finally { setIsLoading(false); }
  };

  const handleLeave = () => {
    localStorage.removeItem('last_room_id');
    localStorage.removeItem('last_player_id');
    setRoom(null);
    setMe(null);
    changeScreen(GameScreen.MODE_SELECTION);
  };

  const renderContent = () => {
    switch (screen) {
      case GameScreen.LOADING:
        return (
          <div className="flex flex-col items-center justify-center h-full px-12">
            <div className="w-24 h-24 mb-12 relative animate-float">
               <div className="absolute inset-0 border-2 border-red-600 rounded-full animate-ping opacity-20"></div>
               <div className="absolute inset-2 border border-white/20 rounded-full animate-spin"></div>
               <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-4 h-4 bg-red-600 rounded-full shadow-[0_0_20px_#ff0000]"></div>
               </div>
            </div>
            <h1 className="text-5xl font-brand text-white tracking-[0.2em] mb-8">IMPOSTOR</h1>
            <div className="w-full max-w-xs space-y-4">
              <div className="loading-bar-container">
                <div className="loading-bar-fill" style={{ width: `${loadingProgress}%` }}></div>
              </div>
              <div className="flex flex-col items-center gap-1">
                {terminalLogs.map((log, i) => (
                  <span key={i} className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest animate-pulse">{log}</span>
                ))}
              </div>
            </div>
          </div>
        );
      case GameScreen.MODE_SELECTION:
        return (
          <div className="flex flex-col h-full p-8 items-center justify-center">
            <div className="mb-16 text-center">
              <span className="text-red-600 font-bold text-xs tracking-[0.4em] uppercase mb-2 block">Selección de Canal</span>
              <h2 className="text-7xl font-brand text-white italic text-glow">CENTRAL</h2>
            </div>
            <div className="w-full max-w-sm space-y-6">
              <button onClick={() => { refreshPublicRooms(); changeScreen(GameScreen.ONLINE_SETUP); }} className="glass-card w-full p-8 group active:scale-[0.98] transition-all">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-3xl font-brand text-white group-hover:text-red-500 transition-colors">OPERACIÓN ONLINE</h3>
                  <div className="w-2 h-2 rounded-full bg-red-600 animate-pulse"></div>
                </div>
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Servidores públicos • Tiempo Real</p>
              </button>
              <div className="text-center">
                <p className="text-[9px] text-zinc-700 font-bold uppercase tracking-widest">v2.5.0 Modern Protocol</p>
              </div>
            </div>
          </div>
        );
      case GameScreen.ONLINE_SETUP:
        return (
          <div className="flex flex-col h-full p-8 overflow-y-auto scrollbar-hide">
            <button onClick={() => changeScreen(GameScreen.MODE_SELECTION)} className="self-start text-[10px] font-black text-zinc-500 hover:text-white transition-colors mb-12 tracking-widest">VOLVER AL MENÚ</button>
            <div className="max-w-sm mx-auto w-full space-y-10">
              <div className="space-y-4">
                <p className="text-[10px] text-red-600 font-bold uppercase tracking-[0.3em]">Identificación de Agente</p>
                <input type="text" placeholder="TU ALIAS" value={nameInput} onChange={e => setNameInput(e.target.value)} className="w-full bg-transparent border-b border-white/10 py-4 text-4xl font-brand text-white outline-none focus:border-red-600 transition-colors uppercase" />
              </div>

              <div className="grid gap-4">
                <button onClick={handleCreateOnline} className="btn-modern w-full py-5 rounded-2xl text-xl shadow-2xl">CREAR NUEVO NODO</button>
                <div className="flex gap-2">
                  <input type="text" placeholder="CÓDIGO" value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value.toUpperCase())} className="flex-1 bg-white/5 rounded-2xl px-6 font-brand text-xl text-white outline-none border border-white/5 focus:border-white/20" />
                  <button onClick={() => handleJoinOnline(roomCodeInput)} className="bg-white text-black font-bold px-8 py-4 rounded-2xl text-xs tracking-widest hover:bg-zinc-200 transition-colors">ENTRAR</button>
                </div>
              </div>

              <div className="pt-10 border-t border-white/5">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Señales Activas</h3>
                  <button onClick={refreshPublicRooms} className="text-[10px] text-red-600 font-bold hover:underline">REFRESCAR</button>
                </div>
                <div className="space-y-4">
                  {publicRooms.length === 0 && <p className="text-center text-zinc-800 text-xs font-mono py-10">Buscando frecuencias...</p>}
                  {publicRooms.map(r => (
                    <div key={r.id} onClick={() => handleJoinOnline(r.code)} className="glass-card p-6 flex justify-between items-center border border-white/5 hover:border-red-600/30 cursor-pointer transition-all">
                      <div>
                        <p className="font-brand text-white text-2xl tracking-widest">{r.code}</p>
                        <p className="text-[8px] text-zinc-600 font-bold uppercase">Uplink: Estable</p>
                      </div>
                      <div className="text-right">
                        <p className="text-red-600 font-brand text-3xl leading-none">{r.players?.[0]?.count || 0}<span className="text-[10px] text-zinc-700">/8</span></p>
                        <p className="text-[8px] text-zinc-600 font-bold uppercase">Agentes</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      case GameScreen.ONLINE_LOBBY:
        return (
          <div className="flex flex-col h-full">
            <header className="p-8 flex justify-between items-center border-b border-white/5">
              <button onClick={handleLeave} className="text-zinc-600 text-[10px] font-black hover:text-red-500 transition-colors tracking-widest">ABORTAR</button>
              <div className="text-center">
                <p className="text-[8px] text-red-600 font-bold tracking-[0.5em] mb-1">NODO_ACTIVO</p>
                <h2 className="text-4xl font-brand text-white tracking-[0.2em]">{room?.code}</h2>
              </div>
              <div className="w-10 h-10 rounded-xl border border-white/10 flex items-center justify-center font-brand text-xl text-white">{players.length}</div>
            </header>

            <div className="flex-1 p-8 overflow-y-auto scrollbar-hide">
              <p className="text-[10px] text-zinc-600 font-bold uppercase tracking-widest mb-8 text-center italic">Personal encriptado en el canal</p>
              <div className="grid grid-cols-2 gap-6">
                {players.map(p => (
                  <div key={p.id} className="glass-card p-6 flex flex-col items-center gap-4 border-b-2 border-b-transparent hover:border-b-red-600 transition-all">
                    <PlayerAvatar player={p} size="md" />
                    <div className="text-center">
                      <p className="text-sm font-bold text-white uppercase tracking-wider truncate w-24">{p.name}</p>
                      {p.is_host && <p className="text-[7px] text-red-500 font-black uppercase mt-1">Líder de Nodo</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <footer className="p-8">
              {me?.is_host ? (
                <button onClick={() => updateRoomStatus(room.id, 'ONLINE_GAMEPLAY')} disabled={players.length < 3} className="btn-modern w-full py-6 rounded-3xl text-2xl shadow-red-600/20 disabled:opacity-20">INICIAR OPERACIÓN</button>
              ) : (
                <div className="py-6 rounded-3xl border border-white/5 bg-white/5 text-center">
                   <p className="text-xs font-bold text-red-600 animate-pulse tracking-widest uppercase italic">Sincronizando con el líder...</p>
                </div>
              )}
            </footer>
          </div>
        );
      default: return (
        <div className="flex flex-col items-center justify-center h-full">
           <div className="w-8 h-8 border-2 border-red-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      );
    }
  };

  return (
    <main className={`h-full w-full transition-all duration-700 ${isTransitioning ? 'opacity-0 scale-98 blur-md' : 'opacity-100 scale-100 blur-0'}`}>
      {renderContent()}
    </main>
  );
}
